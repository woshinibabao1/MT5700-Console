//! LuCI RPC 服务：TCP newline-JSON（127.0.0.1:8765），由 rpcd ucode 插件（mt5700.uc）代理转发。
//! 替代原 WebSocket 传输层；核心业务逻辑（伪命令/扫频/命令分发/事件总线）全部保留。
//!
//! 协议（每行一个 JSON 对象）：
//!   请求: {"id":1,"method":"at","params":{"cmd":"AT+CSQ","auth_key":"..."}}
//!   请求: {"id":2,"method":"events","params":{"since":12,"auth_key":"..."}}
//!   应答: {"id":1,"result":{"success":true,"data":"..."}}
//!   应答: {"id":2,"result":{"seq":18,"events":[{"type":"raw_data","data":"..."}]}}
//!   错误: {"id":1,"error":{"code":-1,"message":"..."}}
//!
//! 事件不主动推送：前端通过 events(since) 拉取增量（LuCI RPC 为请求-响应模型）。

use crate::{log_debug, log_error, log_info, log_warn};
use crate::atclient::AtClient;
use crate::schedconfig::{SCHED_QUERY_COMMAND, SCHED_RESPONSE_PREFIX, SCHED_SET_PREFIX, SchedConfigDto, dto_to_schedule, schedule_to_dto, write_schedule_uci};
use crate::schedule::Scheduler;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::io::AsyncRead;
use tokio::net::TcpStream;
use tokio::sync::Mutex as AsyncMutex;

const RPC_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// RPC 请求行长度上限（防异常长行撑爆内存；Go 版 WebSocket 是 64KB 读限）。
const MAX_RPC_LINE: usize = 8192;
/// 超长请求行的排空上限。
///
/// 只限制「单行最多读多少」是不够的：超长之后还要把该行剩余部分排掉才能继续分帧，
/// 而这个排空若没有上限，对端只要持续发不含换行的字节流就能让服务把整条流读进内存
/// （路由器上直接 OOM）。超过本上限就停止排空并交由上层断开连接。
const MAX_RPC_DRAIN: usize = 64 * 1024;
/// `events` 应答的单帧字节预算。
///
/// 入站有 MAX_RPC_LINE 限流，出站原先没有：总线最多 500 条事件，一次全回轻松
/// 几十 KB，对端按行读只会拿到被截断的半个 JSON。留出 id/result 包装与中文转义
/// 的余量，取 6 KB；多出来的下一轮再拉（seq 会停在实际回到的位置，不会跳过）。
const EVENT_FRAME_BUDGET: usize = 6 * 1024;
const CELLSCAN_ABORT_TOKEN: &str = "abcd";
const DEFAULT_SCAN_TIMEOUT: Duration = Duration::from_secs(180);

/// 单条短信等待模组确认的上限。超时即判定失败并补发 ESC 清场。
///
/// 串口同一时刻只能跑一条命令，所以「不卡死」的做法不是无限等待，而是：
/// ① 把发送放到独立 tokio 任务里，RPC 立刻返回「已受理」，让 Web 前端不阻塞；
/// ② 给这次等待一个硬上限（本常量）；
/// ③ 等待期间其余命令**快速失败**（见 run_command），不再排长队；
/// ④ 失败后补发 ESC 清掉模组的数据输入态，并进入冷却期，避免反复卡顿。
const SMS_JOB_TIMEOUT: Duration = Duration::from_secs(6);

/// 短信发送任务查询命令（前端轮询结果用）。
const SMS_JOB_QUERY: &str = "AT+SMSJOB?";

/// 发送失败后的冷却时长：此期间再点发送直接返回失败原因，不再占用通道。
const SMS_BLOCK_COOLDOWN: Duration = Duration::from_secs(60);

/// 短信发送任务状态（跨连接共享）。
#[derive(Default)]
struct SmsState {
    running: bool,
    seq: u64,
    ok: Option<bool>,
    message: Option<String>,
    blocked_until: Option<std::time::Instant>,
    block_reason: Option<String>,
}

/// 短信数据命令（`AT+CMGS` / `AT+CMGW`）的应答预算（后台任务内使用）。
const SMS_SEND_TIMEOUT: Duration = SMS_JOB_TIMEOUT;

/// 发给前端的命令应答。字段名与原实现严格一致。
#[derive(Serialize)]
pub struct AtCommandResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 扫频推给前端的事件 data。state 取值 running/done/aborted/error。
#[derive(Serialize)]
#[allow(dead_code)] // 扫频推送结构保留（后续断点续扫扩展）
pub struct ScanPush {
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines: Option<Vec<String>>,
    pub count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct ScanState {
    pub running: bool,
    pub aborted: bool,
    pub lines: Vec<String>,
}

/// 事件总线：替代原 WebSocket Hub 的"广播给所有客户端"。
/// 所有推送（raw_data/new_sms/incoming_call/pdcp_data/memory_full/cellscan/urc_data）
/// 按序入队并分配单调递增 seq；前端轮询 events(since) 拉取增量。
#[derive(Clone)]
pub struct Hub {
    bus: Arc<EventBus>,
}

pub struct EventBus {
    seq: AtomicU64,
    events: Mutex<VecDeque<(u64, serde_json::Value)>>,
    max: usize,
}

impl EventBus {
    fn new(max: usize) -> EventBus {
        EventBus { seq: AtomicU64::new(0), events: Mutex::new(VecDeque::new()), max }
    }

    fn push(&self, value: serde_json::Value) {
        // ★ 取号必须在持有队列锁之后。
        // 原写法先 fetch_add 再加锁，于是存在这样的窗口：号已分配、事件尚未入队，
        // 而此时 since() 读到这个新 seq 却看不到对应事件，前端据此把游标推进到该
        // seq —— 那条事件（新短信 / 来电）就永久拉不到了。
        // 与 since() 的「加锁 → 读号 → 读队列」在同一把锁下互斥后，中间态不可见。
        let mut q = self.events.lock().unwrap_or_else(|e| e.into_inner());
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        q.push_back((seq, value));
        while q.len() > self.max {
            q.pop_front();
        }
    }

    /// 返回 (本次实际回到的 seq, 自 since 之后的事件列表)。
    ///
    /// ★ budget 是单帧字节预算。RPC 是 newline-JSON，协议声明单帧 ≤ 8192 字节
    ///   （MAX_RPC_LINE，入站侧已经按它限流），但**出站侧原先没有上限**：
    ///   总线最多存 500 条，一次全回很容易几十 KB，对端按行读拿到的是被截断的
    ///   半个 JSON —— 表现为 ucode 侧「events 方法整体失败」，比少拿几条难查得多。
    ///
    /// ★ 裁剪时回传的是**本次真正回到的 seq**，不是最新 seq：若报了最新 seq，
    ///   前端会把游标推过去，被裁掉的那些事件就永久拉不到了。
    fn since(&self, since: u64, budget: usize) -> (u64, Vec<serde_json::Value>) {
        let q = self.events.lock().unwrap_or_else(|e| e.into_inner());
        let mut out: Vec<serde_json::Value> = Vec::new();
        let mut bytes = 0usize;
        let mut last = since;
        let mut truncated = false;
        for (s, v) in q.iter() {
            if *s <= since {
                continue;
            }
            // 单条就超预算时也放行第一条，否则大事件会被永远卡住
            let size = serde_json::to_string(v).map(|t| t.len() + 1).unwrap_or(64);
            if bytes + size > budget && !out.is_empty() {
                truncated = true;
                break;
            }
            bytes += size;
            out.push(v.clone());
            last = *s;
        }
        if truncated {
            log_warn!(
                "事件帧超出 {} 字节预算，本次回 {} 条，剩余等下一轮（seq 已停在 {}）",
                budget, out.len(), last
            );
        }
        (last, out)
    }
}

impl Hub {
    pub fn new() -> Hub {
        Hub { bus: Arc::new(EventBus::new(500)) }
    }

    /// 完整推送对象入队（调用方传入 {type,data}）。
    pub fn broadcast(&self, msg: &serde_json::Value) {
        self.bus.push(msg.clone());
    }

    pub fn broadcast_json(&self, type_: &str, data: serde_json::Value) {
        self.bus.push(serde_json::json!({ "type": type_, "data": data }));
    }
}

/// RPC 请求（每行一个 JSON）。
#[derive(Deserialize)]
struct RpcRequest {
    id: serde_json::Value,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

pub struct RpcServer {
    client: Arc<AtClient>,
    auth_key: String,
    sched: Arc<Scheduler>,
    hub: Hub,
    scan: Arc<AsyncMutex<ScanState>>,
    scan_timeout: Duration,
    ctx: tokio::sync::watch::Receiver<bool>,
    /// 短信后台发送任务状态：发送在独立任务里跑，主命令队列不被占用。
    sms: Arc<AsyncMutex<SmsState>>,
}

impl RpcServer {
    pub fn new(
        client: Arc<AtClient>,
        auth_key: String,
        sched: Arc<Scheduler>,
        ctx: tokio::sync::watch::Receiver<bool>,
    ) -> RpcServer {
        RpcServer {
            client,
            auth_key,
            sched,
            hub: Hub::new(),
            scan: Arc::new(AsyncMutex::new(ScanState { running: false, aborted: false, lines: Vec::new() })),
            scan_timeout: DEFAULT_SCAN_TIMEOUT,
            ctx,
            sms: Arc::new(AsyncMutex::new(SmsState::default())),
        }
    }

    pub fn hub(&self) -> Hub {
        self.hub.clone()
    }

    fn shallow_clone(&self) -> RpcServer {
        RpcServer {
            client: self.client.clone(),
            auth_key: self.auth_key.clone(),
            sched: self.sched.clone(),
            hub: self.hub.clone(),
            scan: self.scan.clone(),
            scan_timeout: self.scan_timeout,
            ctx: self.ctx.clone(),
            sms: self.sms.clone(),
        }
    }

    pub fn set_scan_timeout(&mut self, d: Duration) {
        if !d.is_zero() {
            self.scan_timeout = d;
        }
    }

    /// 绑定并服务 RPC，直到 ctx 结束。
    /// bind 默认 127.0.0.1；websocket_allow_wan=1 或 websocket_bind=0.0.0.0 时对外监听。
    pub async fn serve(&self, port: u16, bind: &str) -> Result<(), String> {
        let listener = tokio::net::TcpListener::bind((bind, port))
            .await
            .map_err(|e| format!("监听 RPC 端口 {bind}:{port} 失败: {e}"))?;
        log_info!("LuCI RPC 监听 {bind}:{port}");

        let mut ctx_c = self.ctx.clone();
        loop {
            tokio::select! {
                _ = ctx_c.changed() => return Ok(()),
                accepted = listener.accept() => {
                    let (stream, addr) = match accepted {
                        Ok(v) => v,
                        Err(e) => {
                            log_warn!("接受连接失败: {}", e);
                            continue;
                        }
                    };
                    let conn_server = self.shallow_clone();
                    tokio::spawn(async move {
                        if let Err(e) = conn_server.handle_connection(stream).await {
                            log_debug!("RPC 连接结束: {} ({})", addr, e);
                        }
                    });
                }
            }
        }
    }

    async fn handle_connection(&self, stream: TcpStream) -> Result<(), String> {
        let (read_half, mut write_half) = tokio::io::split(stream);
        let mut reader = BufReader::new(read_half);
        let mut ctx_c = self.ctx.clone();
        loop {
            let line = tokio::select! {
                _ = ctx_c.changed() => break,
                r = tokio::time::timeout(RPC_READ_TIMEOUT, read_line_limited(&mut reader, MAX_RPC_LINE)) => {
                    match r {
                        Ok(Ok(Some(line))) => line,
                        Ok(Ok(None)) => break,
                        _ => break,
                    }
                }
            };
            if line.1 {
                log_warn!("RPC 请求行过长 ({} bytes)，断开连接", line.0.len());
                break;
            }
            let line = line.0;
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let resp = self.handle_request(line).await;
            let payload = match serde_json::to_string(&resp) {
                Ok(p) => p,
                Err(e) => {
                    log_error!("序列化 RPC 应答失败: {}", e);
                    continue;
                }
            };
            // 写失败/超时必须断开：write_all 被超时打断时可能已经写出去半包，
            // 继续复用这条连接会让半包与下一条应答粘在一起，破坏 newline-JSON 分帧。
            let written = tokio::time::timeout(
                Duration::from_secs(5),
                write_half.write_all(format!("{payload}\n").as_bytes()),
            )
            .await;
            match written {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    log_warn!("写 RPC 应答失败，断开连接: {}", e);
                    break;
                }
                Err(_) => {
                    log_warn!("写 RPC 应答超时(5s)，断开连接");
                    break;
                }
            }
            if let Err(e) = write_half.flush().await {
                log_warn!("刷新 RPC 应答失败，断开连接: {}", e);
                break;
            }
        }
        Ok(())
    }

    async fn handle_request(&self, line: &str) -> serde_json::Value {
        let req: RpcRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                return serde_json::json!({ "id": null, "error": { "code": -32700, "message": format!("无效的 RPC 请求: {e}") } });
            }
        };
        let id = req.id;

        // 认证：配置了密钥时，每个请求必须携带匹配的 auth_key（rpcd ucode 代理从 UCI 读取并附加；
        // 页面登录态由 LuCI/rpcd 会话保证，密钥保持原配置语义兼容）。
        let key = req.params.get("auth_key").and_then(|v| v.as_str()).unwrap_or("");
        if !self.auth_key.is_empty() && key != self.auth_key {
            log_warn!("RPC 请求被拒绝: 密钥错误 (method={})", req.method);
            return serde_json::json!({ "id": id, "error": { "code": -32001, "message": "认证失败" } });
        }

        match req.method.as_str() {
            "at" => {
                let cmd = req.params.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
                if cmd.is_empty() {
                    return serde_json::json!({ "id": id, "error": { "code": -32602, "message": "缺少参数 cmd" } });
                }
                // ★ AT 以 CR 作为命令行结束符。若 cmd 串内还含有 CR/LF/NUL，
                // 一次请求就等价于下发多条指令（JSON 里 \r\n 是合法转义），
                // 例如 "AT+CSQ\r\nAT+CFUN=0"。项目在 cmti_capture 与
                // normalize_syscfgex 都防过这个，主命令通道此前漏了。
                // 短信用的「字面 \r」是两个字符(0x5C 0x72)，不受此过滤影响。
                if cmd.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
                    log_warn!("拒绝含控制字符的 AT 命令: {:?}", cmd);
                    return serde_json::json!({ "id": id, "error": { "code": -32602, "message": "cmd 不允许包含换行或控制字符" } });
                }
                let resp = self.run_command(cmd).await;
                serde_json::json!({ "id": id, "result": {
                    "success": resp.success,
                    "data": resp.data,
                    "error": resp.error,
                } })
            }
            "events" => {
                let since = req.params.get("since").and_then(|v| v.as_u64()).unwrap_or(0);
                let (seq, events) = self.hub.bus.since(since, EVENT_FRAME_BUDGET);
                serde_json::json!({ "id": id, "result": { "seq": seq, "events": events } })
            }
            // 后端运行日志（含被当前级别挡掉的部分）：拨号对齐、串口探测、URC 分发、
            // 接口拉起协作等过程都在这里 —— 这些是本服务 eprintln 的输出，
            // 实测并不会进 syslog，只能在内存缓冲里取（LuCI「运行日志 → 模组拨号」）。
            "logs" => {
                let since = req.params.get("since").and_then(|v| v.as_u64()).unwrap_or(0);
                let limit = req
                    .params
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(300)
                    .min(1200) as usize;
                let (seq, entries) = crate::logger::snapshot(since, limit);
                serde_json::json!({ "id": id, "result": { "seq": seq, "entries": entries } })
            }
            _ => serde_json::json!({ "id": id, "error": { "code": -32601, "message": format!("未知方法: {}", req.method) } }),
        }
    }

    /// 把前端发来的字符串当作 AT 命令执行并整理成应答。
    pub async fn run_command(&self, command: &str) -> AtCommandResponse {
        log_debug!("收到 AT 命令: {}", command.trim());

        // AT+CONNECT? 不是真的 AT 命令，用来让前端知道当前走网络还是串口。
        if command.trim() == "AT+CONNECT?" {
            let kind = if self.client.connection_type() == "SERIAL" { "1" } else { "0" };
            return ok_response(&format!("+CONNECT: {kind}\r\nOK"));
        }

        // AT+SCHED? / AT+SCHED= 同样不是真命令，用来读写定时锁频配置。
        if let Some(resp) = self.handle_schedule_command(command).await {
            return resp;
        }

        /*
         * 短信走独立通道：
         *  - `AT+SMSJOB?` 返回后台任务状态（前端轮询）
         *  - `AT+CMGS` / `AT+CMGW` 立刻受理，真正的发送在独立 tokio 任务里跑
         * 这样即使模组迟迟不确认，也不会占着主命令队列把整个界面拖死。
         */
        if let Some(resp) = self.handle_sms_job_command(command).await {
            return resp;
        }

        // 短信发送进行中：其余命令立即失败返回，不再排队等待。
        // 否则每个查询都要等满排队预算，一页十几个查询叠加起来就是「界面加载不出来」。
        if self.sms.lock().await.running {
            return err_response("模组正在发送短信，请稍候再试");
        }

        // 扫频要跑几分钟，单独走异步通路。
        if let Some(resp) = self.handle_cell_scan_command(command).await {
            return resp;
        }

        if self.scan_in_progress().await {
            return err_response("正在扫频，模组暂时无法响应其它命令，请先取消扫频");
        }

        let command = normalize_syscfgex(command);

        /*
         * 应答预算按命令类型分档（2026-09-20：eSIM 下载到一半被掐断）。
         *
         * APDU 透传类（AT+CSIM / AT+CGLA / 逻辑通道管理）的耗时由**卡片**决定，
         * 模组只是搬运工 —— 卡做密钥运算或非易失写入时，单条跳到秒级是常态，
         * 套用普通命令的 2 秒预算就会在下载中途报「模组无响应」。
         * 详见 atclient::DEFAULT_APDU_TIMEOUT 的注释。
         *
         * 外层 = 排队预算 + 应答预算 + 余量，两者必须同步放大，
         * 否则外层会先于 atclient 放弃，把一场正常的慢应答掐成「命令执行超时」。
         */
        let answer = if crate::atclient::is_apdu_command(&command) {
            crate::atclient::apdu_timeout()
        } else {
            crate::atclient::COMMAND_TIMEOUT
        };
        let result = tokio::time::timeout(
            crate::atclient::QUEUE_WAIT_TIMEOUT + answer + Duration::from_secs(3),
            self.client.send_command(&self.ctx, &command, answer, None),
        )
        .await;

        match result {
            Ok(Ok(resp)) => {
                let text = resp.text();
                if resp.has_error() {
                    return AtCommandResponse { success: false, data: None, error: Some(text) };
                }
                AtCommandResponse { success: true, data: Some(text), error: None }
            }
            Ok(Err(e)) => {
                log_debug!("AT 命令失败: {} -> {}", command.trim(), e);
                AtCommandResponse { success: false, data: None, error: Some(e) }
            }
            Err(_) => AtCommandResponse { success: false, data: None, error: Some("命令执行超时".into()) },
        }
    }

    /// 短信专用通道。
    ///
    /// - `AT+SMSJOB?`：返回后台发送任务状态，供前端轮询。
    /// - `AT+CMGS` / `AT+CMGW`：立刻受理并转入独立 tokio 任务，RPC 不阻塞。
    ///   任务内等待模组确认有时间上限；失败会补发 ESC 清掉模组的「等待 PDU」态，
    ///   并进入冷却期——冷却期内再发送直接返回失败原因，不再占用通道。
    async fn handle_sms_job_command(&self, command: &str) -> Option<AtCommandResponse> {
        let trimmed = command.trim();

        if trimmed.eq_ignore_ascii_case(SMS_JOB_QUERY) {
            let st = self.sms.lock().await;
            let payload = serde_json::json!({
                "running": st.running,
                "seq": st.seq,
                "ok": st.ok,
                "message": st.message,
            });
            return Some(AtCommandResponse {
                success: true,
                data: Some(payload.to_string()),
                error: None,
            });
        }

        if !is_sms_data_command(command) {
            return None;
        }

        let mut st = self.sms.lock().await;
        if st.running {
            return Some(AtCommandResponse {
                success: false,
                data: None,
                error: Some("上一条短信仍在发送中，请稍候".into()),
            });
        }
        if let Some(until) = st.blocked_until {
            let now = std::time::Instant::now();
            if now < until {
                let left = (until - now).as_secs() + 1;
                let reason = st
                    .block_reason
                    .clone()
                    .unwrap_or_else(|| "模组未确认提交".into());
                return Some(AtCommandResponse {
                    success: false,
                    data: None,
                    error: Some(format!("短信通道暂不可用：{reason}（{left} 秒后自动重试）")),
                });
            }
            st.blocked_until = None;
            st.block_reason = None;
        }

        st.running = true;
        st.seq += 1;
        st.ok = None;
        st.message = None;
        drop(st);

        let client = self.client.clone();
        let ctx = self.ctx.clone();
        let state = self.sms.clone();
        let cmd = trimmed.to_string();

        tokio::spawn(async move {
            let result = tokio::time::timeout(
                crate::atclient::QUEUE_WAIT_TIMEOUT + SMS_SEND_TIMEOUT + Duration::from_secs(2),
                client.send_command(&ctx, &cmd, SMS_SEND_TIMEOUT, None),
            )
            .await;

            let (ok, message) = match result {
                Ok(Ok(resp)) => {
                    let text = resp.text();
                    let flat = text.replace(|c| c == '\r' || c == '\n', " ");
                    if resp.has_error() {
                        (false, format!("模组返回错误：{}", flat.trim()))
                    } else if resp.contains("+CMGS:") || resp.ok() {
                        (true, String::from("短信已提交"))
                    } else {
                        (false, format!("模组未确认短信提交：{}", flat.trim()))
                    }
                }
                Ok(Err(e)) => (false, e),
                Err(_) => (false, String::from("等待模组确认超时")),
            };

            if !ok {
                // 模组可能仍停在「等待 PDU 数据」态：必须清掉，否则整条 AT 通道被卡死
                if let Err(e) = client.cancel_data_entry().await {
                    log_warn!("取消数据输入态失败: {}", e);
                }
                log_warn!("短信发送失败: {}", message);
            }

            let mut st = state.lock().await;
            st.running = false;
            st.ok = Some(ok);
            st.message = Some(message.clone());
            if ok {
                st.blocked_until = None;
                st.block_reason = None;
            } else {
                st.blocked_until = Some(std::time::Instant::now() + SMS_BLOCK_COOLDOWN);
                st.block_reason = Some(message);
            }
        });

        Some(AtCommandResponse {
            success: true,
            data: Some(String::from("SMS_ACCEPTED")),
            error: None,
        })
    }

    async fn handle_schedule_command(&self, command: &str) -> Option<AtCommandResponse> {
        let trimmed = command.trim();

        if trimmed == SCHED_QUERY_COMMAND {
            let mut dto = schedule_to_dto(&self.sched.config().await);
            dto.status = Some(self.sched.status().await);
            let payload = match serde_json::to_string(&dto) {
                Ok(p) => p,
                Err(e) => return Some(err_response(&format!("序列化定时锁频配置失败: {e}"))),
            };
            return Some(AtCommandResponse {
                success: true,
                data: Some(format!("{SCHED_RESPONSE_PREFIX}{payload}\r\nOK")),
                error: None,
            });
        }

        if let Some(rest) = trimmed.strip_prefix(SCHED_SET_PREFIX) {
            let dto: SchedConfigDto = match serde_json::from_str(rest.trim()) {
                Ok(d) => d,
                Err(e) => return Some(err_response(&format!("定时锁频配置不是有效的 JSON: {e}"))),
            };
            if let Err(e) = dto.validate() {
                return Some(err_response(&e));
            }
            if let Err(e) = write_schedule_uci(&dto).await {
                return Some(err_response(&e));
            }
            self.sched.set_config(dto_to_schedule(&dto)).await;
            log_info!(
                "定时锁频配置已由 WebUI 更新: 启用={} 夜间={} 日间={}",
                dto.enabled,
                dto.night.enabled,
                dto.day.enabled
            );
            return Some(AtCommandResponse {
                success: true,
                data: Some(format!("{SCHED_RESPONSE_PREFIX}OK\r\nOK")),
                error: None,
            });
        }

        None
    }

    // ============= 小区扫频 =============

    fn is_cell_scan(command: &str) -> bool {
        command.trim().to_uppercase().starts_with("AT^CELLSCAN")
    }

    fn is_cell_scan_abort(command: &str) -> bool {
        command.trim().eq_ignore_ascii_case("AT^CELLSCAN=ABORT")
    }

    fn is_cell_scan_state(command: &str) -> bool {
        command.trim().eq_ignore_ascii_case("AT^CELLSCAN=STATE")
    }

    async fn handle_cell_scan_command(&self, command: &str) -> Option<AtCommandResponse> {
        if Self::is_cell_scan_state(command) {
            return Some(self.cell_scan_state().await);
        }
        if Self::is_cell_scan_abort(command) {
            return Some(self.abort_cell_scan().await);
        }
        if Self::is_cell_scan(command) {
            return Some(self.start_cell_scan(command).await);
        }
        None
    }

    async fn cell_scan_state(&self) -> AtCommandResponse {
        let scan = self.scan.lock().await;
        let (running, count) = (scan.running, scan.lines.len());
        drop(scan);
        if !running {
            return ok_response("^CELLSCAN: IDLE\r\nOK");
        }
        ok_response(&format!("^CELLSCAN: RUNNING,{count}\r\nOK"))
    }

    async fn start_cell_scan(&self, command: &str) -> AtCommandResponse {
        let mut scan = self.scan.lock().await;
        if scan.running {
            return err_response("扫频正在进行中，请先取消");
        }
        scan.running = true;
        scan.aborted = false;
        scan.lines.clear();
        drop(scan);

        // 后台异步执行扫频，让 RPC 读循环空出来接收打断命令。
        let client = self.client.clone();
        let hub = self.hub.clone();
        let scan_state = self.scan.clone();
        let timeout = if self.scan_timeout > Duration::ZERO { self.scan_timeout } else { DEFAULT_SCAN_TIMEOUT };
        let ctx = self.ctx.clone();
        let command = command.trim().to_string();
        tokio::spawn(async move {
            run_cell_scan(client, hub, scan_state, ctx, command, timeout).await;
        });

        // 立刻应答，让前端的命令队列不被这条几分钟的命令堵住。
        ok_response("^CELLSCAN: STARTED\r\nOK")
    }

    async fn scan_in_progress(&self) -> bool {
        self.scan.lock().await.running
    }

    async fn abort_cell_scan(&self) -> AtCommandResponse {
        // 全程持锁：扫频若在"判断还在跑"和"写打断字符串"之间正好结束，
        // abcd 就会插进下一条命令的数据流里。
        let mut scan = self.scan.lock().await;
        if !scan.running {
            return err_response("当前没有正在进行的扫频");
        }
        match self.client.interrupt(CELLSCAN_ABORT_TOKEN).await {
            Ok(()) => {
                scan.aborted = true;
                log_info!("已下发扫频打断字符串");
                ok_response("OK")
            }
            Err(e) => err_response(&format!("打断扫频失败: {e}")),
        }
    }
}

async fn run_cell_scan(
    client: Arc<AtClient>,
    hub: Hub,
    scan_state: Arc<AsyncMutex<ScanState>>,
    ctx: tokio::sync::watch::Receiver<bool>,
    command: String,
    timeout: Duration,
) {
    log_info!("开始扫频: {} (超时 {}s)", command, timeout.as_secs());

    let scan_state_stream = scan_state.clone();
    let hub_stream = hub.clone();
    let result = tokio::time::timeout(
        timeout + Duration::from_secs(10),
        client.send_long_command(
            &ctx,
            &command,
            timeout,
            Some(Box::new(move |line: String| {
                let line = line.trim().to_string();
                if !line.starts_with("^CELLSCAN:") {
                    return;
                }
                // 同步闭包内不能 await，也不能 blocking_lock（会在运行时 panic）。
                // 用 try_lock：拿不到锁就跳过本次推送，下一条 ^CELLSCAN 行会再触发。
                let Ok(mut scan) = scan_state_stream.try_lock() else {
                    return;
                };
                scan.lines.push(line.clone());
                let count = scan.lines.len();
                drop(scan);
                hub_stream.broadcast_json(
                    "cellscan",
                    serde_json::json!({ "state": "running", "cell": line, "count": count }),
                );
            })),
        ),
    )
    .await;

    // running 必须无条件复位：万一出了意外还留着 true，
    // 之后所有 AT 命令都会被"正在扫频"挡住，只能重启服务才能恢复。
    // run_cell_scan 本身是异步任务，直接用 async lock（禁止 blocking_lock）。
    let mut scan = scan_state.lock().await;
    let lines = scan.lines.clone();
    let aborted = scan.aborted;
    scan.running = false;
    scan.aborted = false;
    scan.lines.clear();
    drop(scan);

    let count = lines.len();
    match result {
        Ok(Ok(resp)) if !resp.has_error() => {
            let state = if aborted { "aborted" } else { "done" };
            log_info!("扫频结束({}): 共 {} 个小区", state, count);
            hub.broadcast_json("cellscan", serde_json::json!({ "state": state, "lines": lines, "count": count }));
        }
        Ok(Ok(resp)) => {
            log_warn!("扫频被模组拒绝: {}", resp.text());
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": resp.text(), "lines": lines, "count": count }),
            );
        }
        Ok(Err(e)) => {
            log_warn!("扫频失败: {}", e);
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": e, "lines": lines, "count": count }),
            );
        }
        Err(_) => {
            log_warn!("扫频超时");
            hub.broadcast_json(
                "cellscan",
                serde_json::json!({ "state": "error", "error": "扫频超时", "lines": lines, "count": count }),
            );
        }
    }
}

pub fn ok_response(data: &str) -> AtCommandResponse {
    AtCommandResponse { success: true, data: Some(data.to_string()), error: None }
}

pub fn err_response(msg: &str) -> AtCommandResponse {
    AtCommandResponse { success: false, data: None, error: Some(msg.to_string()) }
}

/// 修补前端发来的 AT^SYSCFGEX：把频段参数重新加上引号，并补齐末尾两个空参数。
/// 判断是否为「短信数据命令」：`AT+CMGS` / `AT+CMGW`。
///
/// 这两条命令在 PDU 模式下需要先把 PDU 数据交给模组，再由模组提交到网络侧，
/// 应答耗时远大于普通命令，必须单独给足超时预算。
/// 同时兼容两步下发：第二步只发一串十六进制 PDU 数据（不带 `AT` 前缀）。
fn is_sms_data_command(command: &str) -> bool {
    let head = command.trim_start();
    if let Some(prefix) = head.get(..7) {
        let upper = prefix.to_ascii_uppercase();
        if upper == "AT+CMGS" || upper == "AT+CMGW" {
            return true;
        }
    }
    // 两步下发的第二步：整行都是十六进制字符（可能以 0x1A 结束后跟换行）。
    let payload = head
        .trim_end_matches(|c| c == '\r' || c == '\n' || c == '\u{1a}')
        .trim();
    !payload.is_empty()
        && payload.len() >= 20
        && payload.bytes().all(|b| b.is_ascii_hexdigit())
}

fn normalize_syscfgex(command: &str) -> String {
    // 大小写不敏感：is_cell_scan 同样按大写判定，小写 at^syscfgex 不该绕过规范化。
    if !command.to_uppercase().starts_with("AT^SYSCFGEX") {
        return command.to_string();
    }
    let mut cleaned = command.replace('\r', "").replace('\n', "");
    // 只剥掉末尾的 OK —— 原先的 replace("OK", "") 是全局删除，会把参数里
    // 合法出现的 "OK" 一并抹掉，命令因此被改写。
    let trimmed = cleaned.trim_end();
    if trimmed.to_uppercase().ends_with("OK") {
        // "OK" 是两个 ASCII 字节，此处切片一定落在字符边界上。
        cleaned = trimmed[..trimmed.len() - 2].to_string();
    }
    if cleaned.contains(",\"\",\"\"") {
        let parts: Vec<&str> = cleaned.split(',').collect();
        if parts.len() >= 5 {
            let bands = parts[4].trim_matches('"');
            let head = parts[..4].join(",");
            return format!("{head},\"{bands}\",\"\",\"\"");
        }
    }
    cleaned
}

/// 按行读取，单行最多 max 字节。超限时标记 overlong 并排空该行剩余数据。
/// 返回 None 表示 EOF；Some((line, overlong)) 表示读到一行。
async fn read_line_limited<R>(reader: &mut BufReader<R>, max: usize) -> std::io::Result<Option<(String, bool)>>
where
    R: AsyncRead + Unpin,
{
    let mut raw: Vec<u8> = Vec::new();
    {
        let mut limited = (&mut *reader).take(max as u64);
        let n = limited.read_until(b'\n', &mut raw).await?;
        if n == 0 && raw.is_empty() {
            return Ok(None);
        }
    }
    let mut overlong = false;
    if raw.last() != Some(&b'\n') {
        // take 用尽仍未见换行：本行超长，排空剩余
        if raw.len() >= max {
            overlong = true;
            let mut drain = Vec::new();
            let mut limited = (&mut *reader).take(MAX_RPC_DRAIN as u64);
            let _ = limited.read_until(b'\n', &mut drain).await;
        }
    } else {
        raw.pop();
        if raw.last() == Some(&b'\r') {
            raw.pop();
        }
    }
    Ok(Some((String::from_utf8_lossy(&raw).into_owned(), overlong)))
}
