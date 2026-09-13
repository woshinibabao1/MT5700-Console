//! SIM 卡状态自愈：把长期停在 11 的卡推回 12。
//!
//! 背景（能力来自 WTModem 的 `mt5700m.sh`，此处按用户要求重新实现为纯 Rust）：
//!   模组处于 USB 网口模式（`AT^SETMODE?` = 4）时，若 `AT^SIMSQ?` 的 `<sim_status>`
//!   不是 12（本卡实测长期停在 `1,11` = 可接入网络、短信与电话未接入），
//!   按 `AT^HVSST=1,0` → 等待 3 秒 → `AT^HVSST=1,1` 的顺序推一把。
//!
//! 三条硬约束（用户拍板）：
//!
//! ① **一切 AT 指令都走 Rust**。本模块只负责「判定 + 守卫」，不含任何 AT 收发，
//!    也不碰串口。真正的命令下发全部交给 [`crate::atclient::AtClient::send_command`]
//!    —— 它是 `/dev/ttyUSB1` 的唯一持有者。**不允许**为了这个功能写 shell、
//!   用 `microcom`、或另开一条串口通道。
//! ② **每次开机最多执行一次**，见 [`BootGuard`]。
//! ③ `HVSST` 是**成对**操作：`=1,0` 之后必须闭合回 `=1,1`，
//!    否则 SIM 检测会一直停在关闭状态上。配对的两发必须用 [`pair_context`]
//!    取得的「永不取消」上下文下发（调用方见 `atclient::AtClient::ensure_sim_ready`）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::sync::watch;

use crate::{log_info, log_warn};

/// `AT^HVSST=1,0` 与 `AT^HVSST=1,1` 之间等待多久。
///
/// 与 WTModem 的 `mt5700m.sh` 保持一致（`sleep 3`）：太短卡来不及重读，
/// 太长会明显拖慢开机时的初始化序列。
pub const HVSST_PAIR_WAIT: Duration = Duration::from_secs(3);

/// 专供 `HVSST` 配对使用的「永不取消」上下文。
///
/// 为什么需要它：`AtClient::send_command_inner` 在「等命令锁」与「命令间隔」
/// 两处都会因 `ctx.changed()` 直接 `return Err("上下文取消")` —— 那时命令字节
/// **还没写进串口**，配对就真的断在半路了。服务正在关闭时宁可多等一个
/// `COMMAND_TIMEOUT`，也不能把卡留在 `HVSST=0`（SIM 检测关闭）的状态上。
///
/// ⚠️ 返回的 `Sender` **必须与 `Receiver` 一起保活**，直到配对结束：
/// `watch::Receiver::changed()` 在 sender 被 drop 后会**立刻**返回 `Err(RecvError)`，
/// 而 `send_command_inner` 的 `select!` 对 `Ok`/`Err` 一视同仁 —— 提前 drop 会把
/// 「永不取消」直接反转成「立刻取消」。把两者绑在同一个元组里返回，就是为了让
/// 调用方没法只取其一；两条语义由单测
/// `pair_context_never_cancels_while_sender_is_alive` 与
/// `dropping_the_pair_sender_inverts_the_semantics` 钉死。
pub fn pair_context() -> (watch::Sender<bool>, watch::Receiver<bool>) {
    watch::channel(false)
}

/// 期望的连接模式：4 = USB 网口模式。
/// 非该模式不做自愈 —— 别的形态（如转网口模式）下推 HVSST 会打断正在建立的拨号。
pub const EXPECTED_SETMODE: i64 = 4;

/// `<sim_status>` 里「完全就绪」的值（短信与电话可接入）。
pub const SIM_STATUS_READY: i64 = 12;

/// 「本次开机已经执行过自愈」的标记文件路径。
///
/// 放在 tmpfs 上（OpenWrt 的 `/tmp` 就是 tmpfs），语义正好是「每次开机一次」：
///   * 服务重启 → 文件还在   → 仍然算「本次开机已用掉」，不会重跑；
///   * 设备重启 → tmpfs 清空 → 重新允许执行一次。
///
/// 用 `/tmp` 而不是内存标志，正是为了挡住「服务被 procd 拉起重连后自愈又跑一遍」。
pub fn marker_path() -> PathBuf {
    PathBuf::from("/tmp/mt5700-simheal.done")
}

/// 解析 `AT^SETMODE?` 的连接模式。
///
/// 真机回的是**裸值**（`4\r\nOK`，见 `tests/mock-modem/real-samples.txt`），
/// 部分固件会回 `^SETMODE: 4`，两种都认。
/// 解析不出来返回 `None` —— 调用方据此**不做**自愈（宁可不动，也不能瞎动）。
pub fn parse_setmode(text: &str) -> Option<i64> {
    for raw in text.replace('\r', "\n").lines() {
        let line = raw.trim();
        if line.is_empty() || line == "OK" || line == "ERROR" {
            continue;
        }
        if let Some(rest) = line.strip_prefix("^SETMODE:") {
            if let Some(v) = leading_int(rest) {
                return Some(v);
            }
            continue;
        }
        // 裸值形态：整行就是一个数字。
        // 只认「整行恰好是单个数字」，避免把主动上报里的数字误当成模式。
        if line.len() == 1 && line.as_bytes()[0].is_ascii_digit() {
            return line.parse::<i64>().ok();
        }
    }
    None
}

/// 解析 `AT^SIMSQ?` 的 `<sim_status>`（第二个字段）。
///
/// 手册 6.6 的应答形如 `^SIMSQ: <mode>,<sim_status>`，实测 `^SIMSQ: 1,11`。
pub fn parse_simsq_status(text: &str) -> Option<i64> {
    for raw in text.replace('\r', "\n").lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("^SIMSQ:") {
            let mut fields = rest.split(',');
            fields.next()?; // <mode>，这里不用
            return leading_int(fields.next()?);
        }
    }
    None
}

/// 取逗号分隔字段里的第一个整数，顺带容忍引号与空白。
fn leading_int(s: &str) -> Option<i64> {
    let head = s.split(',').next()?.trim().trim_matches('"').trim();
    head.parse::<i64>().ok()
}

/// 「每次开机只允许执行一次」的守卫。
///
/// 两层保险：
///   1. 进程内 `AtomicBool` —— 同一进程内绝不会重复；
///   2. 标记文件（`create_new` / `O_EXCL` 原子创建）—— **跨进程**也只有一个赢家，
///      于是服务被 procd 重启、模组反复重连都不会让自愈跑第二遍。
pub struct BootGuard {
    path: PathBuf,
    used: AtomicBool,
}

impl BootGuard {
    pub fn new(path: PathBuf) -> Self {
        BootGuard {
            path,
            used: AtomicBool::new(false),
        }
    }

    /// 取走本次开机的唯一一次机会。
    ///
    /// * `true`  —— 拿到了，调用方可以执行自愈动作；
    /// * `false` —— 本次开机已经用过（本进程用过，或标记文件已存在）。
    ///
    /// 唯一例外：标记文件所在文件系统不允许创建（只读 / 权限不足）时，
    /// 退化为「仅进程内一次」并打警告 —— 宁可少一次自愈，
    /// 也不能因为守卫失效而让每次重连都推一遍 HVSST。
    pub fn claim(&self) -> bool {
        if self.used.swap(true, Ordering::SeqCst) {
            return false;
        }
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.path)
        {
            Ok(_) => {
                log_info!(
                    "SIM 自愈：已登记本次开机的唯一一次执行机会（{}）",
                    self.path.display()
                );
                true
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(e) => {
                log_warn!(
                    "SIM 自愈：无法创建标记文件 {}（{}），本次仅在本进程内保证只执行一次",
                    self.path.display(),
                    e
                );
                true
            }
        }
    }
}

/// 测试用：造一个互不冲突的临时标记文件路径，并确保它不存在。
#[cfg(test)]
pub fn temp_marker(tag: &str) -> PathBuf {
    use std::sync::atomic::AtomicUsize;
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let p = std::env::temp_dir().join(format!(
        "mt5700-simheal-test-{}-{}-{}",
        std::process::id(),
        tag,
        n
    ));
    let _ = std::fs::remove_file(&p);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------- AT^SETMODE? ---------- */

    #[test]
    fn parse_setmode_reads_bare_value_from_real_device() {
        // 真机实测形态：4\r\nOK
        assert_eq!(parse_setmode("4\r\nOK"), Some(4));
        assert_eq!(parse_setmode("1\r\nOK"), Some(1));
        // 只有结束码
        assert_eq!(parse_setmode("OK"), None);
    }

    #[test]
    fn parse_setmode_also_accepts_prefixed_form() {
        assert_eq!(parse_setmode("^SETMODE: 4\r\nOK"), Some(4));
        assert_eq!(parse_setmode("  ^SETMODE:  2  \r\nOK"), Some(2));
    }

    #[test]
    fn parse_setmode_rejects_garbage() {
        assert_eq!(parse_setmode(""), None);
        assert_eq!(parse_setmode("ERROR"), None);
        // 多位数不是模式值 —— 不能把主动上报里的数字当模式
        assert_eq!(parse_setmode("^HCSQ: 12\r\nOK"), None);
        assert_eq!(parse_setmode("42\r\nOK"), None);
    }

    /* ---------- AT^SIMSQ? ---------- */

    #[test]
    fn parse_simsq_status_reads_second_field() {
        assert_eq!(parse_simsq_status("^SIMSQ: 1,11\r\nOK"), Some(11));
        assert_eq!(parse_simsq_status("^SIMSQ: 0,12\r\nOK"), Some(12));
        assert_eq!(parse_simsq_status("^SIMSQ: 0,98\r\nOK"), Some(98));
        // 无空格形态
        assert_eq!(parse_simsq_status("^SIMSQ:1,10\r\nOK"), Some(10));
        // 混着别的行
        assert_eq!(
            parse_simsq_status("^HCSQ: \"NR\",72\r\n^SIMSQ: 1,11\r\nOK"),
            Some(11)
        );
    }

    #[test]
    fn parse_simsq_status_rejects_incomplete() {
        assert_eq!(parse_simsq_status("OK"), None);
        assert_eq!(parse_simsq_status("^SIMSQ: 1"), None);
        assert_eq!(parse_simsq_status(""), None);
    }

    /* ---------- 每次开机一次的守卫 ---------- */

    #[test]
    fn boot_guard_allows_exactly_one_claim() {
        let p = temp_marker("once");
        let g = BootGuard::new(p.clone());
        assert!(g.claim(), "第一次必须拿到");
        assert!(!g.claim(), "同一守卫第二次必须拿不到");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn boot_guard_is_shared_across_process_lifetime() {
        // 模拟「服务被重启」：同一标记文件、全新的守卫对象。
        // 只要没重启设备，标记文件还在，就不允许再跑一次。
        let p = temp_marker("restart");
        assert!(BootGuard::new(p.clone()).claim());
        assert!(
            !BootGuard::new(p.clone()).claim(),
            "服务重启后不能重跑（这正是用 tmpfs 标记文件而不是内存标志的原因）"
        );
        // 模拟「设备重启」：tmpfs 被清空，标记文件消失 → 重新允许一次
        std::fs::remove_file(&p).unwrap();
        assert!(BootGuard::new(p.clone()).claim(), "开机后应重新允许一次");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn boot_guard_paths_are_independent() {
        let a = temp_marker("a");
        let b = temp_marker("b");
        assert!(BootGuard::new(a.clone()).claim());
        assert!(BootGuard::new(b.clone()).claim());
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
    }

    /* ---------- HVSST 配对用的「永不取消」上下文 ---------- */

    #[tokio::test]
    async fn pair_context_never_cancels_while_sender_is_alive() {
        let (_keep_tx, pair_ctx) = pair_context();
        let mut rx = pair_ctx.clone();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), rx.changed())
                .await
                .is_err(),
            "sender 保活时，配对上下文不该报告任何「变化」—— 否则配对会被 ctx 取消打断"
        );
    }

    #[tokio::test]
    async fn dropping_the_pair_sender_inverts_the_semantics() {
        // 固化那个隐蔽的坑：sender 一旦被 drop，changed() 立刻返回 Err，而
        // send_command_inner 的 select! 对 Ok/Err 一视同仁 —— 于是「永不取消」
        // 会反转成「立刻取消」。这就是 `_pair_tx` 必须保活到配对结束的原因。
        let (tx, pair_ctx) = pair_context();
        drop(tx);
        let mut rx = pair_ctx.clone();
        assert!(
            tokio::time::timeout(Duration::from_millis(200), rx.changed())
                .await
                .is_ok(),
            "sender 被 drop 后 changed() 必须立刻返回 —— 这正是不能提前 drop 的原因"
        );
    }
}
