//! 短信存储满的兜底清理。
//!
//! 模组存储写满后会拒绝新短信（回 `+CMS ERROR: 322` / 上报 `^SMMEMFULL`），
//! 网络侧会重发几次，但空间不腾出来就一直收不到 —— 兜底就是「腾地方」。
//!
//! 策略：**按短信中心时间从旧到新删除**，一次最多删 `MAX_DELETE_PER_ROUND` 条、
//! 且降到 `TARGET_USAGE` 以下即停 —— 目的是腾出「够用的」空间，
//! 而不是为了收一条把整个收件箱清空。
//!
//! 两条硬约束：
//! 1. **不改动模组当前的短信格式**。只有 PDU 模式（`AT+CMGF=0`）能解出短信中心
//!    时间；文本模式下宁可跳过清理并记日志，也不临时切格式 —— 切换是全局设置，
//!    清理期间若前端正在发短信，命令会被按错的模式解析。
//! 2. **每条删除都查应答**。`AT+CMGD` 被拒（ERROR）不算删除成功，
//!    否则会把「删除条数」报错，用户以为腾出空间了其实一条没删。

use crate::atclient::{AtClient, AtResponse};
use crate::log_info;
use crate::log_warn;
use crate::pdu::decode_incoming_pdu;
use std::time::Duration;
use tokio::sync::watch;

/// 一轮清理最多删除的条数。
const MAX_DELETE_PER_ROUND: usize = 5;
/// 清理到占用率低于这个值就停手。
const TARGET_USAGE: f64 = 0.9;
/// 列短信/删短信的超时。COMMAND_TIMEOUT 只有 2s，存满时列几十条不够用。
const SMS_TIMEOUT: Duration = Duration::from_secs(10);

/// 从 `+CPMS: "SM",<used>,<total>,...` 取用量。
pub fn parse_cpms_usage(resp: &AtResponse) -> Option<(u32, u32)> {
    for line in &resp.lines {
        let t = line.trim();
        if !t.starts_with("+CPMS") {
            continue;
        }
        let body = match t.find(':') {
            Some(i) => &t[i + 1..],
            None => continue,
        };
        // 形如  "SM",5,50,"SM",5,50,"SM",5,50
        let fields: Vec<&str> = body
            .split(',')
            .map(|s| s.trim().trim_matches('"'))
            .collect();
        if fields.len() >= 3 {
            let used = fields[1].parse::<u32>().ok()?;
            let total = fields[2].parse::<u32>().ok()?;
            return Some((used, total));
        }
    }
    None
}

/// 从 `+CMGL` 应答里取出 `(存储索引, 短信中心时间戳, 是否已读)`。
///
/// 只认 PDU 模式：`+CMGL: <idx>,...` 的下一行是 PDU 串，解码后才能拿到
/// 短信中心时间（SCTS）。解不出时间的不进列表 —— 宁可不删，也不能按
/// 存储索引大小猜「谁最旧」（存储位置会被复用，索引小不代表时间早）。
///
/// `已读` 取自 `+CMGL` 的第二个字段 `<stat>`（`1` = REC READ）。调用方据此
/// 先删已读、后删未读：存储写满时本就不得不腾地方，但没有理由先动用户
/// 还没看过的短信。
pub fn parse_cmgl_entries(resp: &AtResponse) -> Vec<(u32, i64, bool)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < resp.lines.len() {
        let line = resp.lines[i].trim();
        if !line.starts_with("+CMGL") {
            i += 1;
            continue;
        }
        let fields: Vec<&str> = line
            .find(':')
            .map(|p| line[p + 1..].split(',').map(|s| s.trim()).collect())
            .unwrap_or_default();
        let idx = fields.first().and_then(|s| s.parse::<u32>().ok());
        // <stat>: 0=未读 1=已读 2=草稿 3=已发。只有「已读」才允许被优先清理；
        // 未读、草稿、已发一律按未读对待，绝不优先删。
        let read = fields.get(1).and_then(|s| s.parse::<u32>().ok()) == Some(1);
        let pdu = resp.lines[i + 1].trim();
        i += 2;
        let idx = match idx {
            Some(v) => v,
            None => continue,
        };
        if let Ok(sms) = decode_incoming_pdu(pdu) {
            out.push((idx, sms.date.timestamp(), read));
        }
    }
    out
}

/// 是否处于 PDU 模式（`+CMGF: 0`）。
fn is_pdu_mode(resp: &AtResponse) -> bool {
    resp.lines
        .iter()
        .any(|l| l.trim().replace(' ', "").starts_with("+CMGF:0"))
}

/// 按时间从旧到新删除短信，返回**实际删除成功**的条数。
pub async fn clean_oldest(client: &AtClient, ctx: &watch::Receiver<bool>) -> usize {
    let usage = match client
        .send_command(ctx, "AT+CPMS?", SMS_TIMEOUT, None)
        .await
    {
        Ok(r) => parse_cpms_usage(&r),
        Err(e) => {
            log_warn!("短信自动清理：查询存储用量失败: {}", e);
            return 0;
        }
    };
    let (used, total) = match usage {
        Some(v) => v,
        None => {
            log_warn!("短信自动清理：无法解析存储用量（+CPMS?），跳过");
            return 0;
        }
    };
    if total == 0 || used < total {
        log_info!("短信自动清理：存储仍有余量（{}/{}），无需清理", used, total);
        return 0;
    }

    match client
        .send_command(ctx, "AT+CMGF?", SMS_TIMEOUT, None)
        .await
    {
        Ok(r) => {
            if !is_pdu_mode(&r) {
                log_warn!(
                    "短信自动清理：模组当前非 PDU 模式，无法按短信中心时间排序，跳过（不改变模组格式）"
                );
                return 0;
            }
        }
        Err(e) => {
            log_warn!("短信自动清理：查询短信格式失败: {}", e);
            return 0;
        }
    }

    let resp = match client
        .send_command(ctx, "AT+CMGL=4", SMS_TIMEOUT, None)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log_warn!("短信自动清理：读取短信列表失败: {}", e);
            return 0;
        }
    };

    let mut entries = parse_cmgl_entries(&resp);
    if entries.is_empty() {
        log_warn!("短信自动清理：列表为空或取不到时间，跳过（不会盲删）");
        return 0;
    }
    /*
     * 排序键：已读的排在最前，同为已读/未读的再按时间从旧到新。
     *
     * 存储写满时模组会拒绝新短信，必须腾地方；但「腾」的对象应该先是看过的。
     * 只有已读全删完还不够时，才会轮到未读 —— 那时删未读也比收不到新短信好。
     */
    entries.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));

    let target = ((total as f64) * TARGET_USAGE).floor() as u32;
    let need = used.saturating_sub(target).max(1) as usize;
    let n = need.min(MAX_DELETE_PER_ROUND).min(entries.len());

    let mut deleted = 0usize;
    for (idx, _, read) in entries.into_iter().take(n) {
        if !read {
            log_warn!("短信自动清理：已读短信已删完仍不够，将删除未读短信 {}", idx);
        }
        match client
            .send_command(ctx, &format!("AT+CMGD={idx}"), SMS_TIMEOUT, None)
            .await
        {
            Ok(r) if r.ok() => deleted += 1,
            Ok(r) => log_warn!("短信自动清理：删除 {} 被模组拒绝: {}", idx, r.text()),
            Err(e) => log_warn!("短信自动清理：删除 {} 失败: {}", idx, e),
        }
    }

    if deleted > 0 {
        log_info!(
            "短信自动清理：已删除最旧的 {} 条（清理前占用 {}/{}）",
            deleted,
            used,
            total
        );
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atclient::AtResponse;

    fn resp(lines: &[&str]) -> AtResponse {
        AtResponse {
            lines: lines.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn 解析存储用量() {
        let r = resp(&["+CPMS: \"SM\",5,50,\"SM\",5,50,\"SM\",5,50", "OK"]);
        assert_eq!(parse_cpms_usage(&r), Some((5, 50)));
        // 存满
        let r2 = resp(&["+CPMS: \"SM\",50,50,\"ME\",50,50", "OK"]);
        assert_eq!(parse_cpms_usage(&r2), Some((50, 50)));
        // 无应答
        assert_eq!(parse_cpms_usage(&resp(&["OK"])), None);
    }

    #[test]
    fn 索引小不代表时间早_只认解出的时间() {
        // 两条都不是合法 PDU → 一条都不该被删
        let r = resp(&["+CMGL: 1,1,,10", "ZZZZ", "+CMGL: 2,1,,10", "YYYY", "OK"]);
        assert!(parse_cmgl_entries(&r).is_empty());
    }

    #[test]
    fn pdu模式判定() {
        assert!(is_pdu_mode(&resp(&["+CMGF: 0", "OK"])));
        assert!(!is_pdu_mode(&resp(&["+CMGF: 1", "OK"])));
        assert!(!is_pdu_mode(&resp(&["ERROR"])));
    }
}
