//! AT 客户端：维护到模组的唯一连接。
//!
//! 与 Go 实现完全一致的语义：
//! - 只有一个任务读取通道，命令应答与主动上报在同一处解复用；
//! - 命令串行执行（100ms 最小间隔），2 秒超时，最多保留 2048 行；
//! - 空闲期收到的数据视为主动上报（raw_data 推给前端）；
//! - 有命令等待时，只把「绝不可能是查询结果」的行（^REJINFO/+CUSD 等）截出来；
//! - `abcd` 打断绕过命令锁直接写入（供扫频使用）。

use crate::{log_info, log_warn};
use crate::config::AtConfig;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex, Notify};

const COMMAND_GAP: Duration = Duration::from_millis(100);
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
/// 等待命令锁的独立预算。
///
/// 背景（AT 终端「只有 ATI 有回复」的根因）：
/// 服务启动/重连时会先跑 `init_modem()` 的一串初始化和自动拨号对齐命令，
/// 这些命令全程持有 `cmd_mu`。此前 `send_command_inner` 的超时是从进入函数
/// 就开始计时的，于是用户的终端命令会把整个预算消耗在「排队等锁」上，
/// 2 秒一到就返回「模组无响应」——而模组其实什么都没收到。
/// 表现为：服务刚起或刚重连的那段时间，除最先发的一条外全都没有回复。
///
/// 修复思路：把「排队（等锁 + 命令间隔）」与「等应答」拆成两段独立预算。
/// 排队最多等 QUEUE_WAIT_TIMEOUT；真正写入模组之后，再按 timeout 等应答。
/// 这样排队慢不会再吃掉应答时间，用户看到的是真实结果而不是假超时。
pub const QUEUE_WAIT_TIMEOUT: Duration = Duration::from_secs(8);
const READ_BUF_SIZE: usize = 4096;
const MAX_RESPONSE_LINES: usize = 2048;
const MAX_RESIDUAL_BYTES: usize = 64 * 1024;
/// 读到 0 字节时的让步间隔（详见 read_loop 内注释）。
const ZERO_READ_BACKOFF: Duration = Duration::from_millis(50);
/// 连续 0 字节读达到该次数才判定链路断开（50ms × 20 ≈ 1s）。
const ZERO_READ_RETRY_LIMIT: u32 = 20;

#[derive(Debug, Clone)]
pub struct AtResponse {
    pub lines: Vec<String>,
}

impl AtResponse {
    pub fn text(&self) -> String {
        self.lines.join("\r\n")
    }
    pub fn ok(&self) -> bool {
        self.lines.iter().any(|l| l == "OK")
    }
    pub fn has_error(&self) -> bool {
        self.text().to_uppercase().contains("ERROR")
    }
    pub fn contains(&self, sub: &str) -> bool {
        self.text().contains(sub)
    }
}

/// 从 `AT^SETAUTODIAL?` 的应答里取出「自动拨号是否开启」。
///
/// 手册回显形如 `^SETAUTODIAL: 1,1,"IP","cmnet",...`，第一个字段即开关；
/// 部分固件只回 `^SETAUTODIAL: 1`。解析失败返回 None（调用方据此决定是否直接下发）。
fn parse_autodial_enable(text: &str) -> Option<bool> {
    for line in text.replace('\r', "").lines() {
        let line = line.trim();
        if !line.starts_with("^SETAUTODIAL:") {
            continue;
        }
        let payload = line[line.find(':')? + 1..].trim();
        let first = payload.split(',').next()?.trim().trim_matches('"');
        if first.is_empty() {
            return None;
        }
        return match first {
            "0" => Some(false),
            "1" => Some(true),
            _ => None,
        };
    }
    None
}

/// 一条模组主动上报。broadcast 为真表示需要作为 raw_data 推给前端。
#[derive(Debug)]
pub struct Unsolicited {
    pub line: String,
    pub broadcast: bool,
}

/// 一条正在等待应答的命令。
pub struct PendingCmd {
    pub echo: String,
    pub lines: Vec<String>,
    pub done: Arc<Notify>,
    /// 非空时每收到一行应答就回调一次（^CELLSCAN 边扫边显示用）。
    pub stream: Option<Box<dyn Fn(String) + Send + Sync>>,
}

#[allow(dead_code)] // describe 保留给诊断输出
pub struct Connection {
    writer: Arc<Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>>,
    describe: String,
}

pub struct AtClient {
    cfg: AtConfig,

    conn: Arc<Mutex<Option<Connection>>>,
    /// 连接标志（原子，供 Scheduler 等异步任务安全读取，替代阻塞式取锁）。
    connected_flag: Arc<AtomicBool>,
    urc_tx: mpsc::Sender<Unsolicited>,

    cmd_mu: Arc<Mutex<()>>,
    long_cmd: Arc<AtomicI32>,
    long_cmd_end: Arc<AtomicI64>,
    last_cmd_at: Arc<Mutex<Instant>>,

    pending: Arc<Mutex<Option<PendingCmd>>>,

    /// 是否启用 SIM 卡状态自愈（UCI `sim_heal_enable`，默认开）。
    sim_heal_enable: bool,
    /// 「本次开机只允许执行一次」的守卫（tmpfs 标记文件 + 进程内原子标志）。
    sim_heal_guard: crate::simheal::BootGuard,
}

impl AtClient {
    pub fn new(cfg: AtConfig, urc_tx: mpsc::Sender<Unsolicited>) -> Arc<Self> {
        Self::build(cfg, urc_tx, crate::simheal::marker_path())
    }

    /// 测试专用：注入独立的标记文件路径，避免动到真机上的 `/tmp/mt5700-simheal.done`。
    #[cfg(test)]
    pub fn new_with_marker(
        cfg: AtConfig,
        urc_tx: mpsc::Sender<Unsolicited>,
        marker: std::path::PathBuf,
    ) -> Arc<Self> {
        Self::build(cfg, urc_tx, marker)
    }

    fn build(
        cfg: AtConfig,
        urc_tx: mpsc::Sender<Unsolicited>,
        sim_heal_marker: std::path::PathBuf,
    ) -> Arc<Self> {
        let sim_heal_enable = cfg.sim_heal_enable;
        Arc::new(AtClient {
            cfg,
            conn: Arc::new(Mutex::new(None)),
            connected_flag: Arc::new(AtomicBool::new(false)),
            urc_tx,
            cmd_mu: Arc::new(Mutex::new(())),
            long_cmd: Arc::new(AtomicI32::new(0)),
            long_cmd_end: Arc::new(AtomicI64::new(0)),
            last_cmd_at: Arc::new(Mutex::new(Instant::now())),
            pending: Arc::new(Mutex::new(None)),
            sim_heal_enable,
            sim_heal_guard: crate::simheal::BootGuard::new(sim_heal_marker),
        })
    }

    pub fn connection_type(&self) -> &str {
        &self.cfg.type_
    }

    pub fn connected(&self) -> bool {
        // 纯原子读取：绝不能在这里取锁阻塞（Scheduler 在异步循环中调用）。
        self.connected_flag.load(Ordering::Relaxed)
    }

    /// 连接、重连与读循环，直到 ctx 结束。
    pub async fn run(self: Arc<Self>, ctx: tokio::sync::watch::Receiver<bool>) {
        let mut backoff = Duration::from_secs(5);
        let max_backoff = Duration::from_secs(60);

        while !*ctx.borrow() {
            let tp = match crate::transport::open_transport(&self.cfg).await {
                Ok(tp) => tp,
                Err(e) => {
                    log_warn!("连接模组失败，{} 后重试: {}", humandur(backoff), e);
                    if !sleep_ctx(&ctx, backoff).await {
                        return;
                    }
                    if backoff < max_backoff {
                        backoff += Duration::from_secs(5);
                    }
                    continue;
                }
            };

            log_info!("已连接到 {}", tp.describe());
            backoff = Duration::from_secs(5);

            let describe = tp.describe();
            let parts = tp.into_parts();
            let (reader, writer) = (parts.reader, parts.writer);
            let conn = Connection {
                writer: Arc::new(Mutex::new(writer)),
                describe,
            };
            *self.conn.lock().await = Some(conn);
            self.connected_flag.store(true, Ordering::Relaxed);

            // 初始化命令要在读循环起来之后发，否则等不到应答。
            let read_ctx = ctx.clone();
            let init_ctx = ctx.clone();
            let read_done = {
                let client = self.clone();
                tokio::spawn(async move { client.read_loop(&read_ctx, reader).await })
            };
            let init = {
                let client = self.clone();
                tokio::spawn(async move { client.init_modem(&init_ctx).await })
            };

            let mut ctx_c = ctx.clone();
            tokio::select! {
                r = read_done => {
                    if let Err(e) = r {
                        log_warn!("模组连接中断: {}", e);
                    }
                }
                _ = ctx_c.changed() => {}
            }
            let _ = init.await;
            self.teardown().await;

            if !*ctx.borrow() && !sleep_ctx(&ctx, Duration::from_secs(2)).await {
                return;
            }
        }
    }

    async fn teardown(&self) {
        self.connected_flag.store(false, Ordering::Relaxed);
        let mut guard = self.conn.lock().await;
        guard.take(); // drop transport → 读循环退出
        drop(guard);

        // 让等待中的命令立刻失败，而不是干等超时。
        let pending = self.pending.lock().await.take();
        if let Some(p) = pending {
            p.done.notify_one();
        }
    }

    async fn init_modem(self: Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) {
        // 手册 3.14：置 2 后错误返回描述字符串，界面上能显示具体原因。
        if let Err(e) = self.send_command(ctx, "AT+CMEE=2", COMMAND_TIMEOUT, None).await {
            log_warn!("开启详细错误码失败: {}", e);
        }
        // 短信走 PDU 模式并开启新短信主动上报，来电开启号码显示。
        // 与 Go 一致：查询失败或不含目标值时都要 SET，避免模组刚连上超时导致模式未启用。
        match self.send_command(ctx, "AT+CNMI?", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.contains("+CNMI: 2,1,0,2,0") => {}
            _ => {
                if let Err(e) = self.send_command(ctx, "AT+CNMI=2,1,0,2,0", COMMAND_TIMEOUT, None).await {
                    log_warn!("设置短信上报模式失败: {}", e);
                }
            }
        }
        match self.send_command(ctx, "AT+CMGF?", COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.contains("+CMGF: 0") => {}
            _ => {
                if let Err(e) = self.send_command(ctx, "AT+CMGF=0", COMMAND_TIMEOUT, None).await {
                    log_warn!("设置短信 PDU 模式失败: {}", e);
                }
            }
        }
        if let Err(e) = self.send_command(ctx, "AT+CLIP=1", COMMAND_TIMEOUT, None).await {
            log_warn!("开启来电号码显示失败: {}", e);
        }

        // SIM 卡状态自愈：SETMODE=4 且卡状态非 12 时，用 HVSST 成对推一次。
        // 放在拨号对齐**之前**：万一推卡让模组重读 SIM，随后的拨号对齐才是在最终状态下做的。
        self.ensure_sim_ready(ctx).await;

        // 自动拨号默认开启（UCI autodial_enable 默认 1）。
        // 放在最后：前面的设置类命令失败不应阻止拨号，否则设备会一直没有 IP。
        self.ensure_autodial(ctx).await;
    }

    /// 确保自动拨号处于期望状态。
    ///
    /// 「模块显示在线但接口拿不到 IP」的根因链：
    ///   模组已注册网络（AT 通、有信号）→ 但 ^SETAUTODIAL 未开启 →
    ///   模组不向 USB 网口下发 DHCP → eth2 一直是 NO-CARRIER/DHCP 无应答 →
    ///   netifd 的 MT5700M 接口没有 IP → 无法联网。
    /// 因此每次连上模组后都要对齐一次自动拨号状态。
    ///
    /// 幂等：先查询，已是目标值则不重复下发（避免每次重连都打断已建立的 PDP 上下文）。
    async fn ensure_autodial(self: &Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) {
        let desired = self.cfg.autodial_enable;
        let mode = self.cfg.autodial_mode.clamp(1, 2);

        // 1) 查询当前状态；查询失败也继续尝试下发，避免模组刚连上超时导致不拨号。
        let current = match self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => parse_autodial_enable(&resp.text()),
            Err(e) => {
                log_warn!("查询自动拨号状态失败，将直接下发设置: {}", e);
                None
            }
        };

        if current == Some(desired) {
            log_info!("自动拨号已处于期望状态（enable={}），不重复下发", desired as i32);
            return;
        }

        // 2) 下发。开启时带上拨号方式；关闭时不带参数（与手册及前端 dial.js 一致）。
        let cmd = if desired {
            format!("AT^SETAUTODIAL=1,{}", mode)
        } else {
            "AT^SETAUTODIAL=0".to_string()
        };
        match self.send_command(ctx, &cmd, COMMAND_TIMEOUT, None).await {
            Ok(resp) if resp.ok() => {
                log_info!("已{}自动拨号（{}）", if desired { "开启" } else { "关闭" }, cmd);
            }
            Ok(resp) => {
                log_warn!("自动拨号设置未返回 OK: {}", resp.text());
            }
            Err(e) => {
                log_warn!("自动拨号设置失败: {}（命令 {}）", e, cmd);
            }
        }

        // 3) 复核，便于日志里直接看出是否真的生效。
        if let Ok(resp) = self.send_command(ctx, "AT^SETAUTODIAL?", COMMAND_TIMEOUT, None).await {
            match parse_autodial_enable(&resp.text()) {
                Some(v) if v == desired => log_info!("自动拨号状态复核通过"),
                Some(v) => log_warn!("自动拨号状态复核不一致：期望 {}，实际 {}", desired as i32, v as i32),
                None => log_warn!("自动拨号状态复核无法解析: {}", resp.text()),
            }
        }
    }


    /// SIM 卡状态自愈：把长期停在 11 的卡用 `HVSST` 成对推一把。
    ///
    /// 触发条件（全部经本客户端的 `send_command` 读取，**不经任何 shell**）：
    ///   `AT^SETMODE?` = 4（USB 网口模式）且 `AT^SIMSQ?` 的 `<sim_status>` 不是 12。
    ///
    /// 三条硬约束：
    ///   1. **一切 AT 都走 Rust** —— `send_command` 是 `/dev/ttyUSB1` 的唯一持有者，
    ///      这里不开第二条通道、不用 microcom、不落 shell。
    ///   2. **每次开机最多执行一次** —— 条件检查每次连上都做（纯只读，代价可忽略），
    ///      但真正下发 `HVSST` 之前必须先向 [`crate::simheal::BootGuard`] 取走
    ///      「本次开机唯一一次」的机会；取不到就跳过。于是模组反复重连、
    ///      procd 反复拉起服务，`HVSST` 也只会被推一次。
    ///   3. **配对必须闭合** —— `AT^HVSST=1,0` 之后一定要把 `AT^HVSST=1,1` 发出去，
    ///      否则 SIM 检测会一直停在关闭状态。所以中间的等待刻意不响应 ctx 取消。
    async fn ensure_sim_ready(self: &Arc<Self>, ctx: &tokio::sync::watch::Receiver<bool>) {
        use crate::simheal;

        if !self.sim_heal_enable {
            return; // 未启用：一条命令都不发
        }

        // ① 只认 USB 网口模式（4），其它模式下推 HVSST 会打断正在建立的拨号。
        let setmode = match self.send_command(ctx, "AT^SETMODE?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => simheal::parse_setmode(&resp.text()),
            Err(e) => {
                log_warn!("SIM 自愈：查询 AT^SETMODE? 失败（{}），本次跳过", e);
                return;
            }
        };
        match setmode {
            Some(m) if m == simheal::EXPECTED_SETMODE => {}
            Some(m) => {
                log_info!(
                    "SIM 自愈：连接模式为 {}（非 {}），跳过",
                    m,
                    simheal::EXPECTED_SETMODE
                );
                return;
            }
            None => {
                log_warn!("SIM 自愈：无法解析 AT^SETMODE? 应答，跳过");
                return;
            }
        }

        // ② 读卡状态。只有 12 才算「完全就绪」。
        let status = match self.send_command(ctx, "AT^SIMSQ?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => simheal::parse_simsq_status(&resp.text()),
            Err(e) => {
                log_warn!("SIM 自愈：查询 AT^SIMSQ? 失败（{}），本次跳过", e);
                return;
            }
        };
        let Some(status) = status else {
            log_warn!("SIM 自愈：无法解析 AT^SIMSQ? 应答，跳过");
            return;
        };

        if status == simheal::SIM_STATUS_READY {
            log_info!("SIM 自愈：卡状态已是 12（完全就绪），无需处理");
            return;
        }
        // 卡不在位（0）/ 已失效（98）/ 已移除（99）：推 HVSST 毫无意义，
        // 不能在卡根本没插的情况下白耗掉本次开机的唯一一次机会。
        if matches!(status, 0 | 98 | 99) {
            log_warn!(
                "SIM 自愈：卡状态 {} 属于「不在位 / 已失效 / 已移除」，跳过",
                status
            );
            return;
        }

        // ③ 到这里才取走机会 —— 前面任何一次提前返回都不消耗它。
        //    这样即使开机瞬间模组还没就绪（SIMSQ 读不出来），后面的重连仍有机会补上。
        if !self.sim_heal_guard.claim() {
            log_info!(
                "SIM 自愈：本次开机已执行过，跳过（当前卡状态 {}）",
                status
            );
            return;
        }

        log_warn!(
            "SIM 自愈：卡状态 {}（非 12），执行一次 HVSST 推卡 —— 本卡长期停在 11 属已知现象",
            status
        );

        // ④ 成对下发。第一发无论成功与否都要把第二发打完，配对不能半途而废。
        //
        // 这两发**刻意不响应 ctx 取消**：`send_command_inner` 在「等命令锁」与
        // 「命令间隔」两处都会因 `ctx.changed()` 直接 `return Err` —— 那时字节
        // 还没写进串口，配对就真的断在半路了（第三处取消点在写入之后，模组已经
        // 收到，不算缺口）。服务正在关闭时宁可多等一个 `COMMAND_TIMEOUT`，
        // 也不能把卡留在 `HVSST=0`（SIM 检测关闭）的状态上。
        //
        // ⚠️ `_pair_tx` 必须活到配对结束：sender 一旦被 drop，`changed()` 会立刻
        // 返回 Err，而 `send_command_inner` 的 `select!` 对 Ok/Err 一视同仁 ——
        // 提前 drop 会把「永不取消」反转成「立刻取消」。
        let (_pair_tx, pair_ctx) = simheal::pair_context();

        match self
            .send_command(&pair_ctx, "AT^HVSST=1,0", COMMAND_TIMEOUT, None)
            .await
        {
            Ok(resp) if resp.ok() => log_info!("SIM 自愈：AT^HVSST=1,0 已确认"),
            Ok(resp) => log_warn!("SIM 自愈：AT^HVSST=1,0 未返回 OK：{}", resp.text()),
            Err(e) => log_warn!("SIM 自愈：AT^HVSST=1,0 未收到应答（{}），仍继续闭合配对", e),
        }

        // 这里**不**用 ctx 感知的 sleep：配对必须闭合，宁可多等 3 秒，
        // 也不能因为服务正在关闭就把卡留在 HVSST=0（SIM 检测关闭）的状态上。
        tokio::time::sleep(simheal::HVSST_PAIR_WAIT).await;

        match self
            .send_command(&pair_ctx, "AT^HVSST=1,1", COMMAND_TIMEOUT, None)
            .await
        {
            Ok(resp) if resp.ok() => log_info!("SIM 自愈：AT^HVSST=1,1 已确认，配对闭合"),
            Ok(resp) => log_warn!("SIM 自愈：AT^HVSST=1,1 未返回 OK：{}", resp.text()),
            Err(e) => log_warn!("SIM 自愈：AT^HVSST=1,1 未收到应答：{}", e),
        }

        // ⑤ 复核一次，只写日志。机会已经用掉，不论结果本次开机都不再重试。
        match self.send_command(ctx, "AT^SIMSQ?", COMMAND_TIMEOUT, None).await {
            Ok(resp) => match simheal::parse_simsq_status(&resp.text()) {
                Some(v) if v == simheal::SIM_STATUS_READY => {
                    log_info!("SIM 自愈：推卡后卡状态已到 12（完全就绪）")
                }
                Some(v) => log_warn!(
                    "SIM 自愈：推卡后卡状态仍为 {}（本卡长期如此属预期，本次开机不再重试）",
                    v
                ),
                None => log_warn!("SIM 自愈：推卡后无法解析 AT^SIMSQ? 应答"),
            },
            Err(e) => log_warn!("SIM 自愈：推卡后复核 AT^SIMSQ? 失败：{}", e),
        }
    }

    /// 串行发送一条 AT 命令并等待结束码。
    pub async fn send_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.send_command_inner(ctx, command, timeout, stream).await
    }

    /// 扫频一类长命令：可指定超时，并通过 stream 实时拿到每一行应答。
    pub async fn send_long_command(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        self.long_cmd.fetch_add(1, Ordering::SeqCst);
        let result = self.send_command_inner(ctx, command, timeout, stream).await;
        self.long_cmd_end.store(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as i64,
            Ordering::SeqCst,
        );
        self.long_cmd.fetch_sub(1, Ordering::SeqCst);
        result
    }

    pub fn long_command_active(&self) -> bool {
        self.long_cmd.load(Ordering::SeqCst) > 0
    }

    pub fn long_command_ended_at(&self) -> Option<Instant> {
        let ns = self.long_cmd_end.load(Ordering::SeqCst);
        if ns == 0 {
            return None;
        }
        let now_ns = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos() as i64;
        if now_ns < ns {
            // 时钟回拨：视为刚结束
            return Some(Instant::now());
        }
        let delta = (now_ns - ns) as u64;
        Instant::now().checked_sub(Duration::from_nanos(delta))
    }

    /// 绕过命令锁直接向模组写入原始字符串（打断扫频用）。
    pub async fn interrupt(&self, payload: &str) -> Result<(), String> {
        let writer = {
            let guard = self.conn.lock().await;
            match &*guard {
                Some(c) => c.writer.clone(),
                None => return Err("AT 通道未连接".into()),
            }
        };

        let has_pending = self.pending.lock().await.is_some();
        if !has_pending {
            return Err("当前没有可打断的命令".into());
        }

        let mut payload = payload.to_string();
        if !payload.ends_with('\r') {
            payload.push('\r');
        }
        let mut w = writer.lock().await;
        w.write_all(payload.as_bytes()).await.map_err(|e| {
            log_warn!("写入打断字符串失败: {}", e);
            e.to_string()
        })?;
        Ok(())
    }

    /// 向模组写入 ESC(0x1B)，取消当前的数据输入态。
    ///
    /// 用途：`AT+CMGS` / `AT+CMGW` 会让模组进入「等待 PDU 数据」的状态。若这段数据
    /// 没有被模组接受（例如模组迟迟不返回 `+CMGS:` / `OK`），该状态会一直挂住串口
    /// —— 此时**任何** AT 命令都会被模组当成 PDU 数据吞掉，表现为「发一次短信后
    /// 整个界面全部超时、页面加载不出来」。
    ///
    /// 与 [`interrupt`] 的区别：这里不要求存在待应答命令（超时后 pending 已被清空），
    /// 属于「事后清场」，因此绕过命令锁与 pending 检查直接写入。
    pub async fn cancel_data_entry(&self) -> Result<(), String> {
        let writer = {
            let guard = self.conn.lock().await;
            match &*guard {
                Some(c) => c.writer.clone(),
                None => return Err("AT 通道未连接".into()),
            }
        };
        let mut w = writer.lock().await;
        w.write_all(&[0x1b]).await.map_err(|e| {
            log_warn!("写入 ESC 取消失败: {}", e);
            e.to_string()
        })?;
        Ok(())
    }

    async fn send_command_inner(
        &self,
        ctx: &tokio::sync::watch::Receiver<bool>,
        command: &str,
        timeout: Duration,
        stream: Option<Box<dyn Fn(String) + Send + Sync>>,
    ) -> Result<AtResponse, String> {
        // 第一段预算：排队（等命令锁 + 最小命令间隔）。
        // 这段不计入应答超时，否则初始化/重连期间用户的命令会被误判为「模组无响应」。
        let _cmd_guard = {
            let mut ctx_c = ctx.clone();
            tokio::select! {
                g = self.cmd_mu.lock() => g,
                _ = tokio::time::sleep(QUEUE_WAIT_TIMEOUT) => {
                    return Err(format!(
                        "等待空闲通道超时（{}s）：模组正忙或正在重连，请稍后重试",
                        QUEUE_WAIT_TIMEOUT.as_secs()
                    ));
                }
                _ = ctx_c.changed() => return Err("上下文取消".into()),
            }
        };

        // 两条命令之间最小间隔。
        {
            let last = self.last_cmd_at.lock().await;
            let gap = COMMAND_GAP.saturating_sub(last.elapsed());
            if !gap.is_zero() {
                let mut ctx_c = ctx.clone();
                tokio::select! {
                    _ = tokio::time::sleep(gap) => {}
                    _ = ctx_c.changed() => return Err("上下文取消".into()),
                }
            }
        }

        let conn = {
            let guard = self.conn.lock().await;
            match &*guard {
                Some(c) => c.writer.clone(),
                None => return Err("AT 通道未连接".into()),
            }
        };

        let mut cmd = command.to_string();
        if !cmd.ends_with('\r') {
            cmd.push('\r');
        }

        let done = Arc::new(Notify::new());
        let pending = PendingCmd {
            echo: cmd.trim().to_string(),
            lines: Vec::new(),
            done: done.clone(),
            stream,
        };
        *self.pending.lock().await = Some(pending);

        // 先创建 notified 再写入，避免应答先到而错过通知。
        let notified = done.notified();
        {
            let mut w = conn.lock().await;
            if let Err(e) = w.write_all(cmd.as_bytes()).await {
                log_warn!("写入 AT 命令失败: {}", e);
                self.pending.lock().await.take();
                return Err(e.to_string());
            }
        }
        *self.last_cmd_at.lock().await = Instant::now();

        let mut ctx_c = ctx.clone();
        let mut answered = true;
        tokio::select! {
            _ = notified => {}
            _ = tokio::time::sleep(timeout) => { answered = false; }
            _ = ctx_c.changed() => {
                self.pending.lock().await.take();
                return Err("上下文取消".into());
            }
        }

        let pending = self.pending.lock().await.take();
        let lines = pending.map(|p| p.lines).unwrap_or_default();

        if !lines.is_empty() {
            return Ok(AtResponse { lines });
        }
        if answered {
            // 收到过结束码但没攒到任何内容（例如模组只回一个空结束码）。
            Err(format!("模组未返回内容: {}", command.trim()))
        } else {
            Err(format!(
                "模组无响应（已等待 {}ms）: {}",
                timeout.as_millis(),
                command.trim()
            ))
        }
    }

    /// 唯一读取模组的地方。阻塞在 tokio netpoller 上，空闲时不占 CPU。
    async fn read_loop(
        self: Arc<Self>,
        ctx: &tokio::sync::watch::Receiver<bool>,
        mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>,
    ) -> Result<(), String> {
        let mut buf = vec![0u8; READ_BUF_SIZE];
        let mut residual: Vec<u8> = Vec::new();
        let mut zero_reads: u32 = 0;

        loop {
            let mut ctx_c = ctx.clone();
            let n = tokio::select! {
                r = reader.read(&mut buf) => match r {
                    Ok(n) => n,
                    Err(e) => return Err(e.to_string()),
                },
                _ = ctx_c.changed() => return Ok(()),
            };

            if n == 0 {
                // 不能立刻当 EOF：串口在 VMIN=0/VTIME=0 下「暂无数据」时 read 返回 0
                // 而不是 EAGAIN，直接退出会让读循环刚连上就结束，此后所有 AT 命令都
                // 超时（实机表现为「模组无响应」+ 每十几秒反复重连）。
                zero_reads += 1;
                if zero_reads >= ZERO_READ_RETRY_LIMIT {
                    return Ok(()); // 持续为 0：判定链路已断开，交给上层重连
                }
                let mut ctx_c = ctx.clone();
                tokio::select! {
                    _ = tokio::time::sleep(ZERO_READ_BACKOFF) => {}
                    _ = ctx_c.changed() => return Ok(()),
                }
                continue;
            }
            zero_reads = 0;

            residual.extend_from_slice(&buf[..n]);
            residual = self.consume(residual).await;
        }
    }

    /// 从缓冲里切出完整行并派发，返回尚未成行的剩余字节。
    async fn consume(&self, mut data: Vec<u8>) -> Vec<u8> {
        loop {
            let nl = data.iter().position(|&b| b == b'\n');
            match nl {
                Some(i) => {
                    let line = String::from_utf8_lossy(&data[..i]).trim().to_string();
                    data.drain(..=i);
                    self.handle_line(line).await;
                }
                None => break,
            }
        }

        // AT+CMGS 的输入提示符 "> " 后面没有换行，单独识别成一次应答结束。
        if data.iter().all(|b| b.is_ascii_whitespace() || *b == b'>') && data.contains(&b'>') {
            let mut pending = self.pending.lock().await;
            if let Some(p) = pending.as_mut() {
                p.lines.push(">".into());
            }
            if let Some(p) = pending.as_ref() {
                p.done.notify_one();
            }
            return Vec::new();
        }

        if data.len() > MAX_RESIDUAL_BYTES {
            log_warn!("丢弃 {} 字节无法成行的数据", data.len());
            return Vec::new();
        }
        data
    }

    async fn handle_line(&self, line: String) {
        if line.is_empty() {
            return;
        }

        let (has_pending, is_excl, is_passthrough) = {
            let mut pending = self.pending.lock().await;
            if let Some(p) = pending.as_mut() {
                if line != p.echo && p.lines.len() < MAX_RESPONSE_LINES {
                    p.lines.push(line.clone());
                    // 流式回调（扫频用）。Broadcast 走 try_send 不阻塞，锁内调用安全。
                    if let Some(cb) = p.stream.as_ref() {
                        cb(line.clone());
                    }
                }
                if is_terminator(&line) {
                    p.done.notify_one();
                }
                (true, is_exclusive_urc(&line), is_passthrough_urc(&line))
            } else {
                (false, false, false)
            }
        };

        if !has_pending {
            // 空闲期收到的任何数据都视为主动上报：交给处理器，并按原样推给前端。
            // 与 Go 实现一致（Go handleLine: p == nil 时 broadcast: true）。
            self.emit(Unsolicited { line, broadcast: true }).await;
            return;
        }

        // 有命令等待时，只把「绝不可能是查询结果」的行交给处理器。
        // 比如 ^HCSQ: 既是主动上报也是 AT^HCSQ? 的应答，不能在这里截走，
        // 否则前端的信号显示会拿不到数据。
        if is_excl {
            self.emit(Unsolicited { line, broadcast: is_passthrough }).await;
        }
    }

    async fn emit(&self, u: Unsolicited) {
        // 队列满时丢弃而非阻塞：唯一读循环绝不能被 URC 背压卡住
        match self.urc_tx.try_send(u) {
            Ok(()) | Err(mpsc::error::TrySendError::Closed(_)) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                log_warn!("URC 队列已满，丢弃一条主动上报");
            }
        }
    }
}

pub fn is_terminator(line: &str) -> bool {
    match line {
        "OK" | "ERROR" | "ABORTED" => return true,
        _ => {}
    }
    line.starts_with("+CMS ERROR:") || line.starts_with("+CME ERROR:")
}

/// 只匹配不可能出现在查询应答里的主动上报。
pub fn is_exclusive_urc(line: &str) -> bool {
    match line {
        "RING" | "IRING" | "^IRING" | "NO CARRIER" => return true,
        _ => {}
    }
    if line.starts_with("+CMTI:")
        || line.starts_with("^CEND:")
        || line.starts_with("^SMMEMFULL")
        || line.contains("MEMORY FULL")
        || line.contains("CMS ERROR: 322")
    {
        return true;
    }
    // 带引号的 +CLIP: 是来电上报；AT+CLIP? 的应答形如 "+CLIP: 1,1"，不会命中。
    if line.starts_with("+CLIP:") && line.contains('"') {
        return true;
    }
    is_passthrough_urc(line)
}

/// 没有结构化推送、必须原样转给前端的主动上报。
pub fn is_passthrough_urc(line: &str) -> bool {
    if line.starts_with("^REJINFO") {
        return true;
    }
    line.starts_with("+CUSD:") && line.contains(',')
}

async fn sleep_ctx(ctx: &tokio::sync::watch::Receiver<bool>, d: Duration) -> bool {
    let mut ctx_c = ctx.clone();
    tokio::select! {
        _ = tokio::time::sleep(d) => true,
        _ = ctx_c.changed() => false,
    }
}

pub fn humandur(d: Duration) -> String {
    format!("{}s", d.as_secs())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, ReadBuf};

    /// 模拟「暂无数据时 read 返回 0 字节」的串口：先给若干次 0，再给出数据。
    struct ZeroThenData {
        zeros: u32,
        data: Vec<u8>,
    }

    impl AsyncRead for ZeroThenData {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.zeros > 0 {
                self.zeros -= 1;
                return Poll::Ready(Ok(())); // 0 字节 = 暂无数据（非 EOF）
            }
            let n = self.data.len().min(buf.remaining());
            let chunk: Vec<u8> = self.data.drain(..n).collect();
            buf.put_slice(&chunk);
            Poll::Ready(Ok(()))
        }
    }

    /// 回归：0 字节读不能被当成 EOF，读循环必须继续并派发后续数据。
    #[tokio::test]
    async fn read_loop_survives_zero_reads() {
        let (tx, mut rx) = mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

        let reader = ZeroThenData {
            zeros: 3,
            data: b"^HCSQ: 1,2,3,4\r\nOK\r\n".to_vec(),
        };
        let c = client.clone();
        let handle = tokio::spawn(async move { c.read_loop(&ctx, Box::new(reader)).await });

        let urc = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("0 字节读之后读循环不应退出")
            .expect("应收到主动上报");
        assert_eq!(urc.line, "^HCSQ: 1,2,3,4");
        assert!(urc.broadcast);
        handle.abort();
    }

    /* ---------- 自动拨号状态解析（对应「接口拿不到 IP」修复） ---------- */

    #[test]
    fn parse_autodial_enable_reads_first_field() {
        // 实测回显：带拨号方式的完整形态
        assert_eq!(
            parse_autodial_enable("^SETAUTODIAL: 1,1,\"IP\",\"cmnet\",\"\",\"\",0\r\nOK"),
            Some(true)
        );
        assert_eq!(
            parse_autodial_enable("^SETAUTODIAL: 0,1,\"IP\",\"cmnet\"\r\nOK"),
            Some(false)
        );
    }

    #[test]
    fn parse_autodial_enable_handles_short_and_padded_forms() {
        // 部分固件只回一个字段
        assert_eq!(parse_autodial_enable("^SETAUTODIAL: 1\r\nOK"), Some(true));
        // 前导空白 / 单引号风格
        assert_eq!(parse_autodial_enable("  ^SETAUTODIAL:  0  \r\nOK"), Some(false));
    }

    #[test]
    fn parse_autodial_enable_rejects_non_boolean_and_missing() {
        // 非 0/1 视为不可判定，调用方据此改为直接下发命令
        assert_eq!(parse_autodial_enable("^SETAUTODIAL: \r\nOK"), None);
        assert_eq!(parse_autodial_enable("^SETAUTODIAL: abc\r\nOK"), None);
        assert_eq!(parse_autodial_enable("OK\r\nERROR"), None);
        assert_eq!(parse_autodial_enable(""), None);
    }

    #[test]
    fn parse_autodial_enable_picks_the_setautodial_line() {
        // 应答里混有其它行时，只认 ^SETAUTODIAL
        let mixed = "^HCSQ: \"NR\",72,201,30\r\n^SETAUTODIAL: 1,2\r\nOK";
        assert_eq!(parse_autodial_enable(mixed), Some(true));
    }

    /* ---------- 排队超时与应答超时分离（对应「终端只有 ATI 有回复」修复） ---------- */

    /// 回归：等命令锁的时间不能吃掉应答预算。
    ///
    /// 构造：先占用 `cmd_mu` 一小段时间模拟「初始化序列正在发命令」，
    /// 随后释放。此时后一条命令若仍按「进入函数即计时」的老逻辑，
    /// 扣除排队后留给模组的应答窗口会不足；修复后排队走独立预算，
    /// 命令应在拿到锁之后正常写入并收到应答。
    #[tokio::test]
    async fn queue_wait_does_not_consume_response_budget() {
        use tokio::io::AsyncWriteExt as _;

        let (tx, _rx) = mpsc::channel::<Unsolicited>(16);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

        // 用一个双端管道冒充模组：读到的命令一律回 "OK"。
        let (host_side, device_side) = tokio::io::duplex(256);
        let (dev_rd, mut dev_wr) = tokio::io::split(device_side);
        let (host_rd, host_wr) = tokio::io::split(host_side);

        {
            let mut guard = client.conn.lock().await;
            *guard = Some(Connection {
                writer: Arc::new(Mutex::new(Box::new(host_wr))),
                describe: "test".into(),
            });
        }
        client.connected_flag.store(true, Ordering::Relaxed);

        // 模组侧：读到一行就回 OK。
        let dev = tokio::spawn(async move {
            let mut rd = dev_rd;
            let mut buf = [0u8; 256];
            loop {
                match rd.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = dev_wr.write_all(b"OK\r\n").await;
                        let _ = n;
                    }
                    Err(_) => break,
                }
            }
        });

        // 读循环负责把模组回的数据派发给 pending。
        let c = client.clone();
        let ctx_r = ctx.clone();
        let reader_handle = tokio::spawn(async move {
            c.read_loop(&ctx_r, Box::new(host_rd)).await
        });

        // 先抢住命令锁 600ms，模拟初始化序列占用通道。
        let holder = {
            let mu = client.cmd_mu.clone();
            tokio::spawn(async move {
                let _g = mu.lock().await;
                tokio::time::sleep(Duration::from_millis(600)).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 排队 600ms 后才拿到锁；应答本身很快，应成功而不是报「模组无响应」。
        let res = client
            .send_command(&ctx, "AT+CGMM", COMMAND_TIMEOUT, None)
            .await;
        assert!(
            res.is_ok(),
            "排队不应导致假超时，实际: {:?}",
            res.err()
        );
        assert!(res.unwrap().ok());

        holder.await.unwrap();
        reader_handle.abort();
        dev.abort();
    }

    /// 回归：排队超过独立预算时，返回可辨识的排队超时提示，而不是「模组无响应」。
    #[tokio::test]
    async fn queue_wait_timeout_reports_queue_error() {
        let (tx, _rx) = mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

        // 永久占住命令锁（模拟通道被长时间占用/卡死）。
        let mu = client.cmd_mu.clone();
        let holder = tokio::spawn(async move {
            let _g = mu.lock().await;
            tokio::time::sleep(Duration::from_secs(60)).await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        // 用一个短的排队预算做验证（直接调内部函数无法改常量，故这里改为
        // 断言错误文案包含「等待空闲通道」这一排队特征，而非「模组无响应」）。
        let err = tokio::time::timeout(
            QUEUE_WAIT_TIMEOUT + Duration::from_secs(2),
            client.send_command(&ctx, "AT+CGMM", COMMAND_TIMEOUT, None),
        )
        .await
        .expect("排队超时应按时返回")
        .expect_err("锁被占满时应失败");

        assert!(
            err.contains("等待空闲通道"),
            "应给出排队超时提示，实际: {err}"
        );
        assert!(
            !err.contains("模组无响应"),
            "不应把排队问题误报成模组无响应，实际: {err}"
        );

        holder.abort();
    }

    /* ---------- SIM 卡状态自愈（每次开机只跑一次 / AT 全走 Rust 客户端） ---------- */

    /// 假模组 + 已接线完成的 `AtClient`。
    ///
    /// 与生产路径的唯一差别是注入了一个临时标记文件，避免动到真机上的
    /// `/tmp/mt5700-simheal.done`。
    struct SimHealHarness {
        client: Arc<AtClient>,
        sent: Arc<Mutex<Vec<String>>>,
        ctx: tokio::sync::watch::Receiver<bool>,
        _ctx_tx: tokio::sync::watch::Sender<bool>,
        _reader: tokio::task::JoinHandle<()>,
        _device: tokio::task::JoinHandle<()>,
    }

    impl SimHealHarness {
        async fn sent_cmds(&self) -> Vec<String> {
            self.sent.lock().await.clone()
        }
    }

    fn count_cmd(cmds: &[String], cmd: &str) -> usize {
        cmds.iter().filter(|c| c.as_str() == cmd).count()
    }

    /// 按命令文本作答的假模组；返回「已接线」的客户端与该模组收到的命令列表。
    async fn sim_heal_harness(
        marker: std::path::PathBuf,
        enable: bool,
        responder: impl Fn(&str) -> String + Send + 'static,
    ) -> SimHealHarness {
        let mut at = crate::config::default_config().at;
        at.sim_heal_enable = enable;
        let (urc_tx, _urc_rx) = mpsc::channel::<Unsolicited>(64);
        let client = AtClient::new_with_marker(at, urc_tx, marker);
        let (ctx_tx, ctx) = tokio::sync::watch::channel(false);

        let (host_side, device_side) = tokio::io::duplex(1024);
        let (dev_rd, mut dev_wr) = tokio::io::split(device_side);
        let (host_rd, host_wr) = tokio::io::split(host_side);

        {
            let mut guard = client.conn.lock().await;
            *guard = Some(Connection {
                writer: Arc::new(Mutex::new(Box::new(host_wr))),
                describe: "fake-modem".into(),
            });
        }
        client.connected_flag.store(true, Ordering::Relaxed);

        let sent = Arc::new(Mutex::new(Vec::new()));
        let sent_dev = sent.clone();
        let device = tokio::spawn(async move {
            let mut rd = dev_rd;
            let mut buf = [0u8; 512];
            let mut acc: Vec<u8> = Vec::new();
            loop {
                match rd.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        acc.extend_from_slice(&buf[..n]);
                        while let Some(i) = acc.iter().position(|&b| b == b'\r' || b == b'\n') {
                            let line = String::from_utf8_lossy(&acc[..i]).trim().to_string();
                            acc.drain(..=i);
                            if line.is_empty() {
                                continue;
                            }
                            sent_dev.lock().await.push(line.clone());
                            let reply = responder(&line);
                            if !reply.is_empty() {
                                let _ = dev_wr.write_all(reply.as_bytes()).await;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let c = client.clone();
        let ctx_r = ctx.clone();
        let reader = tokio::spawn(async move { c.read_loop(&ctx_r, Box::new(host_rd)).await });

        SimHealHarness {
            client,
            sent,
            ctx,
            _ctx_tx: ctx_tx,
            _reader: reader,
            _device: device,
        }
    }

    /// 本卡真机形态：SETMODE=4、SIMSQ=1,11。
    fn sim_heal_reply(cmd: &str) -> String {
        match cmd {
            "AT^SETMODE?" => "4\r\nOK\r\n".to_string(),
            "AT^SIMSQ?" => "^SIMSQ: 1,11\r\nOK\r\n".to_string(),
            _ => "OK\r\n".to_string(),
        }
    }

    /// ★ 核心约束：每次开机 HVSST 只会被推一次，重连多少次都不例外。
    #[tokio::test]
    async fn sim_heal_pushes_hvsst_exactly_once_per_boot() {
        let marker = crate::simheal::temp_marker("atc-once");
        let h = sim_heal_harness(marker.clone(), true, sim_heal_reply).await;

        h.client.ensure_sim_ready(&h.ctx).await;
        let first = h.sent_cmds().await;
        assert_eq!(
            count_cmd(&first, "AT^HVSST=1,0"),
            1,
            "首次应推一次 HVSST=1,0，实际 {first:?}"
        );
        assert_eq!(
            count_cmd(&first, "AT^HVSST=1,1"),
            1,
            "配对必须闭合，实际 {first:?}"
        );

        // 再跑两次，模拟模组重连 / 服务被 procd 重新拉起后的初始化
        h.client.ensure_sim_ready(&h.ctx).await;
        h.client.ensure_sim_ready(&h.ctx).await;
        let all = h.sent_cmds().await;
        assert_eq!(
            count_cmd(&all, "AT^HVSST=1,0"),
            1,
            "每次开机只能推一次，实际 {all:?}"
        );
        assert_eq!(
            count_cmd(&all, "AT^HVSST=1,1"),
            1,
            "每次开机只能推一次，实际 {all:?}"
        );

        let _ = std::fs::remove_file(&marker);
    }

    /// ★ 配对用的上下文能真正替代调用方的 `ctx` 完成一次往返 —— 这是
    ///   「配对必须闭合」的前提（它不响应取消，见 `simheal::pair_context`）。
    #[tokio::test]
    async fn pair_context_drives_a_normal_round_trip() {
        let marker = crate::simheal::temp_marker("atc-pair-ctx");
        let h = sim_heal_harness(marker.clone(), true, sim_heal_reply).await;

        let (_keep_tx, pair_ctx) = crate::simheal::pair_context();
        let resp = h
            .client
            .send_command(&pair_ctx, "AT^HVSST=1,0", COMMAND_TIMEOUT, None)
            .await
            .expect("配对上下文不该被取消");
        assert!(resp.ok(), "假模组应回 OK，实际 {:?}", resp.lines);
        assert_eq!(
            count_cmd(&h.sent_cmds().await, "AT^HVSST=1,0"),
            1,
            "配对上下文必须把命令写进串口"
        );

        let _ = std::fs::remove_file(&marker);
    }

    /// 卡已经是 12 时不推，而且**不能**消耗掉本次开机唯一的一次机会。
    #[tokio::test]
    async fn sim_heal_skips_when_ready_and_keeps_the_single_shot() {
        use std::sync::atomic::{AtomicU8, Ordering as O};

        let phase = Arc::new(AtomicU8::new(0));
        let p = phase.clone();
        let marker = crate::simheal::temp_marker("atc-ready");
        let h = sim_heal_harness(marker.clone(), true, move |cmd: &str| match cmd {
            "AT^SETMODE?" => "4\r\nOK\r\n".to_string(),
            "AT^SIMSQ?" if p.load(O::SeqCst) == 0 => "^SIMSQ: 0,12\r\nOK\r\n".to_string(),
            "AT^SIMSQ?" => "^SIMSQ: 1,11\r\nOK\r\n".to_string(),
            _ => "OK\r\n".to_string(),
        })
        .await;

        h.client.ensure_sim_ready(&h.ctx).await;
        let a = h.sent_cmds().await;
        assert_eq!(count_cmd(&a, "AT^HVSST=1,0"), 0, "卡已就绪不该推，实际 {a:?}");

        // 之后卡掉回 11：机会还在，必须能推一次
        p.store(1, O::SeqCst);
        h.client.ensure_sim_ready(&h.ctx).await;
        let b = h.sent_cmds().await;
        assert_eq!(
            count_cmd(&b, "AT^HVSST=1,0"),
            1,
            "「卡已就绪」不该消耗唯一一次机会，实际 {b:?}"
        );

        let _ = std::fs::remove_file(&marker);
    }

    /// 非 USB 网口模式（SETMODE≠4）不推，机会同样保留。
    #[tokio::test]
    async fn sim_heal_skips_when_not_usb_mode() {
        use std::sync::atomic::{AtomicU8, Ordering as O};

        let phase = Arc::new(AtomicU8::new(0));
        let p = phase.clone();
        let marker = crate::simheal::temp_marker("atc-mode");
        let h = sim_heal_harness(marker.clone(), true, move |cmd: &str| match cmd {
            "AT^SETMODE?" if p.load(O::SeqCst) == 0 => "1\r\nOK\r\n".to_string(),
            "AT^SETMODE?" => "4\r\nOK\r\n".to_string(),
            "AT^SIMSQ?" => "^SIMSQ: 1,11\r\nOK\r\n".to_string(),
            _ => "OK\r\n".to_string(),
        })
        .await;

        h.client.ensure_sim_ready(&h.ctx).await;
        let a = h.sent_cmds().await;
        assert_eq!(
            count_cmd(&a, "AT^HVSST=1,0"),
            0,
            "SETMODE=1 时不该推 HVSST，实际 {a:?}"
        );

        p.store(1, O::SeqCst);
        h.client.ensure_sim_ready(&h.ctx).await;
        let b = h.sent_cmds().await;
        assert_eq!(
            count_cmd(&b, "AT^HVSST=1,0"),
            1,
            "模式不符不该消耗唯一一次机会，实际 {b:?}"
        );

        let _ = std::fs::remove_file(&marker);
    }

    /// 卡不在位 / 已失效（0 / 98 / 99）时推 HVSST 毫无意义，机会要保留。
    #[tokio::test]
    async fn sim_heal_skips_dead_sim_and_keeps_the_single_shot() {
        use std::sync::atomic::{AtomicU8, Ordering as O};

        for dead in [0_u8, 98, 99] {
            let phase = Arc::new(AtomicU8::new(dead));
            let p = phase.clone();
            let marker = crate::simheal::temp_marker("atc-dead");
            let h = sim_heal_harness(marker.clone(), true, move |cmd: &str| match cmd {
                "AT^SETMODE?" => "4\r\nOK\r\n".to_string(),
                "AT^SIMSQ?" if p.load(O::SeqCst) != 11 => {
                    format!("^SIMSQ: 0,{}\r\nOK\r\n", p.load(O::SeqCst))
                }
                "AT^SIMSQ?" => "^SIMSQ: 1,11\r\nOK\r\n".to_string(),
                _ => "OK\r\n".to_string(),
            })
            .await;

            h.client.ensure_sim_ready(&h.ctx).await;
            let a = h.sent_cmds().await;
            assert_eq!(
                count_cmd(&a, "AT^HVSST=1,0"),
                0,
                "卡状态 {} 时不该推 HVSST，实际 {a:?}",
                dead
            );

            // 卡恢复到 11 → 机会仍在
            p.store(11, O::SeqCst);
            h.client.ensure_sim_ready(&h.ctx).await;
            let b = h.sent_cmds().await;
            assert_eq!(
                count_cmd(&b, "AT^HVSST=1,0"),
                1,
                "卡状态 {} 时不该消耗唯一一次机会，实际 {b:?}",
                dead
            );

            let _ = std::fs::remove_file(&marker);
        }
    }

    /// `AT^HVSST=1,0` 回 ERROR 时，`=1,1` 也必须补上 —— 否则 SIM 检测会一直关着。
    #[tokio::test]
    async fn sim_heal_always_closes_the_hvsst_pair() {
        let marker = crate::simheal::temp_marker("atc-pair");
        let h = sim_heal_harness(marker.clone(), true, |cmd: &str| match cmd {
            "AT^SETMODE?" => "4\r\nOK\r\n".to_string(),
            "AT^SIMSQ?" => "^SIMSQ: 1,11\r\nOK\r\n".to_string(),
            "AT^HVSST=1,0" => "ERROR\r\n".to_string(),
            _ => "OK\r\n".to_string(),
        })
        .await;

        h.client.ensure_sim_ready(&h.ctx).await;
        let cmds = h.sent_cmds().await;
        assert_eq!(count_cmd(&cmds, "AT^HVSST=1,0"), 1, "实际 {cmds:?}");
        assert_eq!(
            count_cmd(&cmds, "AT^HVSST=1,1"),
            1,
            "=1,0 回 ERROR 也必须补上 =1,1，否则 SIM 检测会一直处于关闭状态，实际 {cmds:?}"
        );

        let _ = std::fs::remove_file(&marker);
    }

    /// 关闭开关后连状态查询都不做 —— 一条命令都不发。
    #[tokio::test]
    async fn sim_heal_disabled_sends_nothing() {
        let marker = crate::simheal::temp_marker("atc-off");
        let h = sim_heal_harness(marker.clone(), false, sim_heal_reply).await;

        h.client.ensure_sim_ready(&h.ctx).await;
        let cmds = h.sent_cmds().await;
        assert!(cmds.is_empty(), "未启用时不该发任何命令，实际 {cmds:?}");

        let _ = std::fs::remove_file(&marker);
    }
}
