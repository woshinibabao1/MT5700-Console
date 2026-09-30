#!/usr/bin/env node
'use strict';

/*
 * AT 日志脱敏契约：会写进日志的 AT 命令必须经 logger::redact_at_for_log()
 * ---------------------------------------------------------------------------
 * 为什么要有（2026-09-30 全局同类排查结果）：
 *   本服务的日志会进**内存环形缓冲（1200 条，可经 logs RPC 取回）**，也会打到 stderr/syslog。
 *   而 AT 命令里带着排障不需要、泄露后果明确的内容：
 *     · `AT+CPIN=`/`AT+CPWD=`/`AT+CLCK=` → PIN / PUK
 *     · `AT+CSIM=`/`AT+CGLA=` → 完整 APDU（可读出 ICCID / EID）
 *     · `AT^PHYNUM=IMEI,…` → IMEI 写入
 *     · `AT^SETAUTODIAL=`/`AT+CGDCONT=` → APN 的用户名与口令
 *     · `AT+CSCA=` → 短信中心号
 *   排查时**定位到命令名就够了**。排查前，四处日志都在原样打印整条命令（含失败路径）。
 *
 * 判据（**只认代码形态，不认注释** —— 本仓 find-orphans 自证清单里就有「C 注释不算使用」）：
 *   ① logger.rs 必须定义 redact_at_for_log，且敏感名单至少覆盖 CPIN / CSIM / CGLA / SETAUTODIAL / PHYNUM；
 *   ② rpcserver.rs 的两处（收到命令 / 命令失败）必须经它；
 *   ③ atclient.rs 的两处自动拨号日志必须经它；
 *   ④ 反向：不得再出现"直接打印 command.trim() / cmd"的写法。
 * 反向自检：判据要能分辨脱敏与未脱敏两种写法（否则整条测试恒绿）。
 *
 * 用法：node tests/at-log-redaction-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'rust', 'src');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

const logger = fs.readFileSync(path.join(SRC, 'logger.rs'), 'utf8');
const rpc = fs.readFileSync(path.join(SRC, 'rpcserver.rs'), 'utf8');
const atc = fs.readFileSync(path.join(SRC, 'atclient.rs'), 'utf8');

/* ① 统一出口存在，且名单里有真正敏感的那几个 */
ok('① logger.rs 定义了 pub fn redact_at_for_log',
	/pub fn redact_at_for_log\(/.test(logger),
	'没找到脱敏函数 —— 下游会把整条命令原样写进日志');
const mustHave = ['AT+CPIN', 'AT+CSIM', 'AT+CGLA', 'AT^SETAUTODIAL', 'AT^PHYNUM'];
const missing = mustHave.filter(function (c) { return logger.indexOf('"' + c + '"') < 0; });
ok('① 敏感名单覆盖 PIN/APDU/拨号口令/IMEI', missing.length === 0,
	'名单里缺：' + missing.join('、'));

/* ②③ 四个调用点必须经统一出口 */
const NEED = [
	['rpcserver.rs「收到 AT 命令」', rpc, /log_debug!\("收到 AT 命令: \{\}", crate::logger::redact_at_for_log\(/],
	['rpcserver.rs「AT 命令失败」', rpc, /log_debug!\("AT 命令失败: \{\} -> \{\}", crate::logger::redact_at_for_log\(/],
	['atclient.rs「已…自动拨号」', atc, /log_info!\(\s*"已\{\}自动拨号（\{\}）",[\s\S]{0,160}?redact_at_for_log\(/],
	['atclient.rs「自动拨号设置失败」', atc, /log_warn!\("自动拨号设置失败: \{\}（命令 \{\}）", e, crate::logger::redact_at_for_log\(/],
];
NEED.forEach(function (row) {
	ok('②③ ' + row[0] + ' 经 redact_at_for_log', row[2].test(row[1]),
		'该处仍在直接打印命令 —— 敏感参数会留在环形缓冲里');
});

/* ④ 反向：不得再出现"直接打印整条命令"的**具体旧写法**。
 *    刻意写成"逐条列旧形态"而不是宽泛正则 —— 宽泛正则会把注释里提到的示例也算命中
 *    （本仓 find-orphans 自证清单里的「C 注释不算使用」就是这个坑）。 */
const OLD_FORMS = [
	['rpcserver.rs', rpc, 'log_debug!("收到 AT 命令: {}", command.trim());'],
	['rpcserver.rs', rpc, 'log_debug!("AT 命令失败: {} -> {}", command.trim(), e);'],
	['rpcserver.rs', rpc, 'log_warn!("拒绝含控制字符的 AT 命令: {:?}", cmd);'],
	['atclient.rs', atc, '"写入 AT 命令超时({}s)，模组可能卡在数据输入态: {}",\n                        WRITE_TIMEOUT.as_secs(),\n                        command.trim()'],
	['atclient.rs', atc, 'return Err(format!("模组未返回内容: {}", command.trim()));'],
];
const back = OLD_FORMS.filter(function (row) { return row[1].indexOf(row[2]) >= 0; });
ok('④ 不再有"直接打印整条命令"的旧写法', back.length === 0,
	back.map(function (r) { return r[0]; }).join('、') + ' 仍在原样打印命令');

/* ⑤ 额外：atclient 的超时错误文案（msg）也必须脱敏 —— 它会经 rpcserver 的
 *    "AT 命令失败"日志再打一遍，不脱敏就等于绕过那处的脱敏。 */
ok('⑤ atclient 超时文案里的命令已脱敏（否则会绕过 rpcserver 的脱敏）',
	/let msg = format!\([\s\S]{0,400}?redact_at_for_log\(command\)/.test(atc),
	'msg 里仍在用 command.trim() —— 它会随"AT 命令失败"日志再泄露一次');

/* ---- 反向自检（含一条**已知局限**，如实写明）----
 * 判据是"逐条列具体旧形态"的字面匹配，不做注释剥离。因此：
 *   · 能准确辨认旧写法（改回去必判红）；
 *   · **局限**：注释里若原样抄了某个旧写法，也会被判违规。
 *     这是刻意取舍 —— 宁可要求注释里别照抄旧代码，也不放宽到可能漏判
 *     （宽泛正则会因为 `[^)]*` 之类的写法把注释与真实代码混在一起判，那才是真的不可靠）。 */
ok('★ 反向自检：能辨认"未脱敏"的旧写法',
	'// 历史写法 log_debug!("收到 AT 命令: {}", command.trim());'.indexOf(OLD_FORMS[0][2]) >= 0);
ok('★ 反向自检：不会把"已脱敏"的写法误判为旧写法',
	'log_debug!("收到 AT 命令: {}", crate::logger::redact_at_for_log(command));'
		.indexOf(OLD_FORMS[0][2]) < 0);
ok('★ 反向自检（已知局限）：注释里原样照抄旧写法同样会被判违规 —— 刻意保守，注释请写"旧写法见 git 历史"',
	'// log_debug!("收到 AT 命令: {}", command.trim());'.indexOf(OLD_FORMS[0][2]) >= 0);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('AT 日志脱敏契约通过（四处日志均经统一出口）');
