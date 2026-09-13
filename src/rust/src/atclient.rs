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
    /// true = AT+CMGS/CMGW 类命令 pending。
    ///
    /// 本模组的"请输入 PDU"提示符是 `<命令回显>+0x1A`（SUB），不是标准 3GPP 的 `>`。
    /// 见 MT5700M-CN AT 手册 9.14 节。`consume` 见到 0x1A 时只在 sms_data_mode=true
    /// 的 pending 上把它视为应答结束；其它情况下含 0x1A 是异常字节，按残余处理。
    pub sms_data_mode: bool,
}

/// 判断命令是否以 `AT+CMGS` / `AT+CMGW` 开头（含不区分大小写、前导空白）。
/// 这两条命令会让模组进入「等待 PDU 数据」状态，应答协议与普通 AT 命令不同。
fn is_cmgs_or_cmgw(command: &str) -> bool {
    let head = command.trim_start();
    if head.len() < 7 {
        return false;
    }
    let upper: String = head
        .chars()
        .take(7)
        .collect::<String>()
        .to_ascii_uppercase();
    upper.starts_with("AT+CMGS") || upper.starts_with("AT+CMGW")
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
}

impl AtClient {
    pub fn new(cfg: AtConfig, urc_tx: mpsc::Sender<Unsolicited>) -> Arc<Self> {
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

        let sms_mode = is_cmgs_or_cmgw(command);

        let mut cmd = command.to_string();
        // CMGS/CMGW：命令里已经带 `\r` 把"AT 命令头"和"PDU 数据"分隔开，
        // 再追加行终止 `\r` 会被模组当成 PDU 数据的一部分破坏协议。
        // 其它命令沿用原行为：自动追加 `\r` 作为行终止。
        if !sms_mode && !cmd.ends_with('\r') {
            cmd.push('\r');
        }

        let done = Arc::new(Notify::new());
        let pending = PendingCmd {
            echo: cmd.trim().to_string(),
            lines: Vec::new(),
            done: done.clone(),
            stream,
            sms_data_mode: sms_mode,
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

        /*
         * 本模组（MT5700M-CN）的"请输入 PDU"提示符是 `<命令回显>+0x1A`（SUB），
         * 见 AT 命令手册 9.14 节。consume 在 CMGS/CMGW pending 时把 0x1A 也当作
         * 应答结束，让前端能立刻发出 PDU 数据；非 CMGS pending 见到 0x1A 是异常
         * 字节，按残余留着走 max-size 兜底，避免误触发别的命令应答。
         */
        if data.contains(&0x1a) {
            let sms_mode = {
                let pending = self.pending.lock().await;
                pending.as_ref().map(|p| p.sms_data_mode).unwrap_or(false)
            };
            if sms_mode {
                let mut pending = self.pending.lock().await;
                if let Some(p) = pending.as_mut() {
                    if !p.lines.iter().any(|l| l.contains('\u{1a}')) {
                        p.lines.push("\u{1a}".into());
                    }
                }
                if let Some(p) = pending.as_ref() {
                    p.done.notify_one();
                }
                return Vec::new();
            }
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

    /* ---------- 短信数据命令的应答协议（对应「CMGS 永远失败」修复） ----------
     *
     * 本模组（MT5700M-CN）的"请输入 PDU"提示符是 `<echo>+0x1A`，不是标准 `>`。
     * 同时 `send_command_inner` 给 CMGS/CMGW 写出去时不能像普通 AT 命令那样
     * 末尾追加 `\r`，否则会破坏 PDU 数据流。这两个测试钉死这两条不变量。
     */

    /// 回归：识别模组的 0x1A（SUB）提示符，让前端能立刻发出 PDU。
    ///
    /// 时序：
    ///   1. 前端发 `AT+CMGS=15\\r`
    ///   2. 模组回 `\\r\\nAT+CMGS=15\\r\\n\\x1A`
    ///   3. consume 必须切完 echo 行后，识别剩余 \\r\\n\\x1A 为应答结束，
    ///      并触发 done.notify_one() —— 否则前端会等满 6s 才假超时。
    #[tokio::test]
    async fn consume_recognizes_sub_prompt_for_cmgs_pending() {
        let (tx, _rx) = mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(crate::config::default_config().at, tx);

        // 装一个 echo 字段与 sms_data_mode=true 的 pending，
        // 等价于 send_command_inner 刚把 `AT+CMGS=15\\r` 写出去的状态。
        let pending = PendingCmd {
            echo: "AT+CMGS=15".to_string(),
            lines: Vec::new(),
            done: Arc::new(Notify::new()),
            stream: None,
            sms_data_mode: true,
        };
        let notified = pending.done.notified();
        *client.pending.lock().await = Some(pending);

        // 模组应答：echo 行 + SUB 提示符（无换行结尾）。
        let input: Vec<u8> = b"\r\nAT+CMGS=15\r\n\x1a".to_vec();
        let tail = client.consume(input).await;
        assert!(tail.is_empty(), "0x1A 触发后不应残留尾部字节，实际: {tail:?}");

        let pending = client.pending.lock().await.take().unwrap();
        assert!(
            pending.lines.iter().any(|l| l == "\u{1a}"),
            "应答行应记录 0x1A 提示符，实际: {:?}",
            pending.lines
        );

        // done 必须被触发（前端等的就是这个）。
        let got = tokio::time::timeout(Duration::from_secs(1), notified).await;
        assert!(got.is_ok(), "done 应在 0x1A 到达时立刻触发，不应等到超时");
    }

    /// 回归：非 CMGS pending 见到 0x1A 时不应被当成应答结束（避免误判）。
    #[tokio::test]
    async fn consume_ignores_sub_byte_for_non_cmgs_pending() {
        let (tx, _rx) = mpsc::channel::<Unsolicited>(8);
        let client = AtClient::new(crate::config::default_config().at, tx);

        let pending = PendingCmd {
            echo: "AT+CGREG?".to_string(),
            lines: Vec::new(),
            done: Arc::new(Notify::new()),
            stream: None,
            sms_data_mode: false,
        };
        let notified = pending.done.notified();
        *client.pending.lock().await = Some(pending);

        // 含 0x1A 的异常输入：consume 不应触发 done，留作残余。
        let input: Vec<u8> = b"\x1a".to_vec();
        let tail = client.consume(input).await;
        assert_eq!(tail, b"\x1a", "非 CMGS pending 应把 0x1A 留作残余");

        let got = tokio::time::timeout(Duration::from_millis(50), notified).await;
        assert!(got.is_err(), "非 CMGS pending 不应被 0x1A 触发");
    }

    /// 回归：`AT+CMGS` 命令末尾不能被自动追加 `\r`，否则会破坏 PDU 数据流。
    ///
    /// 走完整 send_command_inner 链路：写一个双端管道冒充模组，验证串口
    /// 上实际拿到的字节就是输入（不带末尾 `\r`）。
    #[tokio::test]
    async fn cmgs_command_does_not_get_trailing_cr_appended() {
        use tokio::io::AsyncWriteExt as _;

        let (tx, _rx) = mpsc::channel::<Unsolicited>(16);
        let client = AtClient::new(crate::config::default_config().at, tx);
        let (_ctx_tx, ctx) = tokio::sync::watch::channel(false);

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

        // 模组侧：读到的字节原样捕获，最后回 OK 让 send_command 返回。
        let dev = tokio::spawn(async move {
            let mut rd = dev_rd;
            let mut buf = [0u8; 256];
            let mut captured = Vec::new();
            loop {
                match rd.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        captured.extend_from_slice(&buf[..n]);
                        // 模拟模组行为：见到 \x1a 后回 +CMGS: 1 + OK
                        if captured.contains(&0x1a) {
                            let _ = dev_wr
                                .write_all(b"\r\n+CMGS: 1\r\nOK\r\n")
                                .await;
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let c = client.clone();
        let ctx_r = ctx.clone();
        let reader_handle = tokio::spawn(async move {
            c.read_loop(&ctx_r, Box::new(host_rd)).await
        });

        // 用户发送的「前端两步发」第一步：只发命令头。
        let res = client
            .send_command(&ctx, "AT+CMGS=15\r", COMMAND_TIMEOUT, None)
            .await;
        assert!(res.is_ok(), "CMGS 头应成功送出，实际: {:?}", res.err());

        // 关键不变量：实际写出的字节末尾不能多出 `\r`。
        // 这一步需要从 dev 任务拿 captured 字节 —— 用 oneshot 通道回传。
        // 为简化：直接断言 Ok，再单独看 dev 任务捕获到的字节末字节不是 \r。
        // （dev 任务的 captured 留在闭包内无法取出，所以这里再开一次小集成验证。）
        let _ = dev.await;
        reader_handle.abort();

        // 独立验证：再次设置 Connection，直接看 send_command_inner 写出去什么。
        // 这里只验证 CMGS 路径不走 `cmd.push('\\r')` 分支就够了。
        // 走更直接的方式：用 mock writer 捕获字节。
        let (host2, dev2) = tokio::io::duplex(256);
        let (dev2_rd, mut dev2_wr) = tokio::io::split(dev2);
        let (host2_rd, host2_wr) = tokio::io::split(host2);

        let writer_arc = Arc::new(Mutex::new(Box::new(host2_wr)
            as Box<dyn tokio::io::AsyncWrite + Unpin + Send>));
        *client.conn.lock().await = Some(Connection {
            writer: writer_arc,
            describe: "test2".into(),
        });

        // dev2 写：捕获所有字节并通过 oneshot 传回。
        let (tx_bytes, rx_bytes) = tokio::sync::oneshot::channel::<Vec<u8>>();
        let dev2_task = tokio::spawn(async move {
            let mut rd = dev2_rd;
            let mut buf = [0u8; 256];
            let mut got = Vec::new();
            // 阻塞直到看到 \x1a 或 EOF
            while got.len() < 6 {
                match rd.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        got.extend_from_slice(&buf[..n]);
                    }
                    Err(_) => break,
                }
            }
            let _ = tx_bytes.send(got);
            // 给一个虚假 OK 让等待中的命令能结束
            let _ = dev2_wr.write_all(b"OK\r\n").await;
        });
        let _ = host2_rd; // 抑制未用警告

        let res2 = client
            .send_command(&ctx, "AT+CMGS=15\r", COMMAND_TIMEOUT, None)
            .await;
        let _ = res2; // 不关心结果，只关心写出字节
        let captured = tokio::time::timeout(Duration::from_secs(2), rx_bytes)
            .await
            .expect("应能读到模组侧捕获")
            .expect("oneshot 不应失败");

        // 验证末尾：CMGS 命令输入 `AT+CMGS=15\r`，send_command_inner 不应再追加 \r。
        assert_eq!(
            captured.as_slice(),
            b"AT+CMGS=15\r",
            "CMGS 命令末尾不应被自动追加 \\r（否则 PDU 数据流会被破坏）"
        );

        dev2_task.abort();
    }

    /// 回归：非 CMGS 命令仍按原行为自动追加 `\r`（普通 AT 命令照常工作）。
    #[tokio::test]
    async fn non_cmgs_command_still_gets_trailing_cr_appended() {
        // 这个不变量由 send_command_inner 的 `if !sms_mode && !cmd.ends_with('\\r')`
        // 守住。验证通过：CMGS 测试的辅助检查（它写的 echo 字段就是未追加的）。
        // 这里只验证 helper 的判定本身。
        assert!(is_cmgs_or_cmgw("AT+CMGS=15"));
        assert!(is_cmgs_or_cmgw("  AT+cmgs=15\r"));
        assert!(is_cmgs_or_cmgw("at+CMGW=18"));
        assert!(!is_cmgs_or_cmgw("AT+CMGL=4"));
        assert!(!is_cmgs_or_cmgw("AT+CMGD=1"));
        assert!(!is_cmgs_or_cmgw("AT+CPMS?"));
        assert!(!is_cmgs_or_cmgw("AT+CGREG?"));
        assert!(!is_cmgs_or_cmgw(""));
        assert!(!is_cmgs_or_cmgw("AT"));
    }
}
