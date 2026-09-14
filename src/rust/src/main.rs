//! at-webserver —— MT5700M 5G 模组 AT 服务（Rust 实现）。
//!
//! 完整业务逻辑迁移：
//! - AT 客户端（网络/串口/自动探测）
//! - LuCI RPC 服务（rpcd ucode 代理 → TCP newline-JSON，替代原 WebSocket 传输层）
//! - 定时锁频调度、小区扫频、短信/来电/信号通知、企业微信推送

mod atclient;
mod config;
mod logger;
mod notify;
mod pdu;
mod rpcserver;
mod schedconfig;
mod schedule;
mod simheal;
// 串口模块仅 Linux 可用（termios/AsyncFd），非 Linux 平台条件编译掉，
// 便于在其它宿主上构建与跑单元测试。
#[cfg(target_os = "linux")]
mod serial_linux;
#[cfg(target_os = "linux")]
mod serialdetect;
mod transport;
mod urc;

use crate::config::Config;
use crate::notify::Notifier;
use crate::rpcserver::RpcServer;
use crate::schedule::Scheduler;
use crate::urc::{Broadcaster, Dispatcher};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// 构建时通过 -ldflags 注入版本（与 Go 一致的 CLI 行为）。
const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 让 chrono 拿得到正确的本地时区。
///
/// chrono 判定本地时区依次尝试：TZ 环境变量 → 把 /etc/localtime 当 TZif 读 →
/// iana-time-zone 取时区名、再去 /usr/share/zoneinfo 读同名文件。OpenWrt 上后
/// 两条经常是断的（/etc/localtime 可能是指向不存在的 /tmp/localtime 的断链，
/// zoneinfo 目录也可能压根没有），此时 chrono 静默回落 UTC —— 于是日志、短信
/// 时间、定时锁频会整个慢一个时区，而 busybox 的 `date` 反而是对的，因为它读
/// OpenWrt 特有的 /etc/TZ（内容是 POSIX TZ 字符串，如 `CST-8`）。
///
/// 这里在还没有任何其它线程时用 libc::setenv 把同一个值补上（stdlib 的
/// `set_var` 有多线程下的安全争议，故直接走 libc）。
///
/// 两点注意：
/// - 已经设过 TZ 就不动，尊重调用方（init 脚本会注入）；
/// - 空串绝不能设 —— chrono 把空的 TZ 解释为 UTC，那比不设更糟（不设至少还会
///   去试 /etc/localtime）。
#[cfg(unix)]
fn ensure_local_timezone() {
    if std::env::var("TZ").map(|v| !v.is_empty()).unwrap_or(false) {
        return;
    }
    let Ok(raw) = std::fs::read_to_string("/etc/TZ") else {
        return;
    };
    let tz = raw.trim();
    if tz.is_empty() {
        return;
    }
    if let Ok(c_tz) = std::ffi::CString::new(tz) {
        // 只 setenv 就够了：chrono 是读 TZ 后自己按 POSIX 规则解析的，
        // 不走 libc 的 localtime，所以不必（libc 里也没有可移植的）tzset。
        unsafe {
            libc::setenv(b"TZ\0".as_ptr() as *const libc::c_char, c_tz.as_ptr(), 1);
        }
    }
}

// 非 Unix 没有 setenv/tzset，也没有 /etc/TZ；这类平台只用于跑单元测试，直接空实现。
#[cfg(not(unix))]
fn ensure_local_timezone() {}

/// 当前生效的本地时区偏移，形如 `UTC+08:00`。启动时打一条，核对服务与系统的
/// 时区是否一致 —— 两者不一致时，日志里的时间会和 logd 打的时间戳明显对不上。
fn tz_desc() -> String {
    format!("UTC{}", chrono::Local::now().format("%:z"))
}

fn main() {
    // 必须早于 tokio runtime 的创建：runtime 会 spawn worker 线程，
    // 而修改进程环境不该与别的线程并发进行。此时还只有主线程。
    ensure_local_timezone();
    async_main();
}

#[tokio::main]
async fn async_main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "-version" || a == "--version") {
        println!("at-webserver {} (rustc {})", VERSION, rustc_version());
        return;
    }
    let verbose = args.iter().any(|a| a == "-verbose" || a == "--verbose");

    crate::logger::set_level(crate::logger::Level::Info);
    if verbose {
        crate::logger::set_level(crate::logger::Level::Debug);
    }

    if let Err(e) = run(verbose).await {
        log_error!("服务退出: {}", e);
        std::process::exit(1);
    }
}

fn rustc_version() -> &'static str {
    option_env!("RUSTC_VERSION").unwrap_or("stable")
}

async fn run(verbose: bool) -> Result<(), String> {
    log_info!("at-webserver {} 启动中 (pid {})", VERSION, std::process::id());
    log_info!(
        "本地时区：{}（TZ={}）",
        tz_desc(),
        std::env::var("TZ").unwrap_or_else(|_| "未设置".to_string())
    );

    let cfg = config::load_config().await;
    if !cfg.enabled {
        log_warn!("服务在配置中被禁用，退出");
        return Ok(());
    }
    log_config(&cfg);

    // 关闭信号：SIGINT / SIGTERM 触发优雅退出。
    let (ctx_tx, ctx_rx) = watch::channel(false);

    // AT 客户端 + 主动上报通道。
    let (urc_tx, urc_rx) = tokio::sync::mpsc::channel(256);
    let client = atclient::AtClient::new(cfg.at.clone(), urc_tx);

    let (notifier, notif_rx) = Notifier::new(cfg.notification.clone());
    let notifier = Arc::new(notifier);
    let scheduler = Scheduler::new(cfg.schedule.clone(), client.clone(), notifier.clone(), ctx_rx.clone());
    let mut rpc = RpcServer::new(client.clone(), cfg.websocket.auth_key.clone(), scheduler.clone(), ctx_rx.clone());
    rpc.set_scan_timeout(cfg.websocket.scan_timeout);
    let rpc = Arc::new(rpc);

    // 上报分发：Broadcast 走事件总线，前端轮询 events(since) 拉取。
    let hub = rpc.hub();
    let broadcaster: Broadcaster = Arc::new(move |v: serde_json::Value| hub.broadcast(&v));

    log_info!("启动完成，LuCI RPC 127.0.0.1:{}（经 rpcd/ucode 代理，不对外暴露）", cfg.websocket.port);
    if !verbose {
        // 稳态只留警告和错误，避免刷满 procd 日志。
        crate::logger::set_level(crate::logger::Level::Warn);
    }

    // 后台任务
    let client_task = tokio::spawn({
        let client = client.clone();
        let ctx = ctx_rx.clone();
        async move { client.run(ctx).await }
    });
    let notify_task = tokio::spawn({
        let notifier = notifier.clone();
        let ctx = ctx_rx.clone();
        async move { notifier.run(notif_rx, ctx).await }
    });
    let dispatch_task = tokio::spawn({
        let mut dispatcher = Dispatcher::new(client.clone(), notifier.clone(), broadcaster, ctx_rx.clone());
        async move { dispatcher.run(urc_rx).await }
    });
    let sched_task = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.run().await }
    });
    let serve_task = tokio::spawn({
        let rpc = rpc.clone();
        let port = cfg.websocket.port;
        let bind = cfg.websocket.bind.clone();
        async move { rpc.serve(port, &bind).await }
    });

    // 等待退出信号或服务异常。
    let mut serve_handle = serve_task;
    let serve_result = tokio::select! {
        _ = shutdown_signal() => None,
        r = &mut serve_handle => Some(r),
    };

    // 触发优雅关闭。
    let _ = ctx_tx.send(true);

    if let Some(Ok(Err(e))) = serve_result {
        log_error!("LuCI RPC 服务异常退出: {}", e);
    }

    // 给后台任务一点时间优雅收尾。
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        let _ = client_task.await;
        let _ = notify_task.await;
        let _ = dispatch_task.await;
        let _ = sched_task.await;
        let _ = serve_handle.await;
    })
    .await;

    crate::logger::set_level(crate::logger::Level::Info);
    log_info!("服务已停止");
    Ok(())
}

#[cfg(unix)]
async fn shutdown_signal() {
    // 注册失败不 panic：SIGTERM 收不到时 procd 最终会 SIGKILL，
    // 但注册失败就 panic 会让服务在启动阶段直接 abort，连 Ctrl-C 都顾不上。
    match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(mut sigterm) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = sigterm.recv() => {}
            }
        }
        Err(e) => {
            log_warn!("注册 SIGTERM 失败，仅响应 Ctrl-C: {}", e);
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn log_config(cfg: &Config) {
    if cfg.at.type_ == "SERIAL" {
        if cfg.at.serial.port == config::AUTO_SERIAL_PORT {
            log_info!("AT 通道: 串口自动探测 @ {}", cfg.at.serial.baudrate);
        } else {
            log_info!("AT 通道: 串口 {} @ {}", cfg.at.serial.port, cfg.at.serial.baudrate);
        }
    } else {
        log_info!("AT 通道: 网络 {}:{}", cfg.at.network.host, cfg.at.network.port);
    }

    log_info!(
        "LuCI RPC: {}:{}，密钥: {}",
        cfg.websocket.bind,
        cfg.websocket.port,
        if cfg.websocket.auth_key.is_empty() { "未设置" } else { "已设置" }
    );
    if cfg.websocket.bind_downgraded {
        log_warn!(
            "配置要求 RPC 对外监听，但未设置 websocket_auth_key —— 已回退到 {} 仅本机可访问。\
             确实需要无认证对外监听时，设置 websocket_allow_insecure=1 后重启本服务",
            cfg.websocket.bind
        );
    } else if !crate::config::is_loopback(&cfg.websocket.bind) {
        log_warn!(
            "RPC 对外监听 {}:{} —— 请确保防火墙已限制访问，并设置 websocket_auth_key",
            cfg.websocket.bind,
            cfg.websocket.port
        );
    }

    log_info!(
        "推送开关: 短信={} 来电={} 存储满={} 信号={}",
        on_off(cfg.notification.types.sms),
        on_off(cfg.notification.types.call),
        on_off(cfg.notification.types.memory_full),
        on_off(cfg.notification.types.signal)
    );
    log_info!("定时锁频: {}", if cfg.schedule.enabled { "启用" } else { "禁用" });
}

fn on_off(b: bool) -> &'static str {
    if b { "开" } else { "关" }
}
