#!/usr/bin/env node
/*
 * UCI 子进程调用的统一口径。
 *
 * 为什么值得单独立一条守卫：`uci` 会争用 `/var/lock/uci`，commit 还要写 flash。
 * 任何一处**不带超时**的 uci 调用挂住，都会让那条 RPC 的 handle_connection 任务
 * 永远停在 `.output().await` 上 —— 而同一连接上后续所有请求（含前端每 1.5s 一次的
 * events 轮询）会全部堵在它后面，表现为「点了保存之后这个页面再也不刷新」。
 * 派生出的第二条要求是 `kill_on_drop(true)`：超时只是 drop 掉 future，并不会杀掉
 * 子进程；那个 uci 可能稍后才拿到锁、并把 staging 真的提交下去，于是出现
 * 「接口报超时、配置却被改了」的不一致。
 *
 * 这条约定在 `uci_run` 的注释里写得很清楚，但 2026-09-28 之前
 * `revert_schedule_uci`（它在 write_schedule_uci 的每条失败分支上被调用）是
 * 直接 `Command::new("uci")…output().await` 的 —— 同一问题的另一半。
 * 本测试把「所有 uci 调用都走 uci_run」钉死。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCHED = path.join(ROOT, 'src', 'rust', 'src', 'schedconfig.rs');
const RUST_SRC = path.join(ROOT, 'src', 'rust', 'src');

let pass = 0;
let fail = 0;
function ok(name, cond, hint) {
	if (cond) {
		pass++;
		console.log('  ok  ' + name);
	} else {
		fail++;
		console.log('  ✗ ' + name + (hint ? '  → ' + hint : ''));
	}
}
function read(p) {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch (e) {
		return '';
	}
}
function stripComments(s) {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

console.log('== UCI 子进程调用的统一口径 ==');

const raw = read(SCHED);
const src = stripComments(raw);
ok('schedconfig.rs 可读', raw.length > 0, '读不到 ' + SCHED);

/* ① 唯一的 uci 调用点必须是 uci_run —— 其余函数只能通过它 */
const spawns = src.match(/Command::new\(\s*"uci"\s*\)/g) || [];
ok('全文件只有一处 Command::new("uci")', spawns.length === 1,
	'实际 ' + spawns.length + ' 处；散落的裸调用会绕过超时与 kill_on_drop');

/* ② uci_run 必须同时带超时与 kill_on_drop */
const uciRun = (() => {
	const i = src.indexOf('async fn uci_run');
	if (i < 0) return '';
	const j = src.indexOf('\n}\n', i);
	return j < 0 ? src.slice(i) : src.slice(i, j);
})();
ok('能定位到 uci_run', uciRun.length > 0);
ok('uci_run 走超时', /timeout\(\s*UCI_TIMEOUT/.test(uciRun),
	'没有超时的 uci 会把整条 RPC 连接堵死');
ok('uci_run 设了 kill_on_drop(true)', /kill_on_drop\(\s*true\s*\)/.test(uciRun),
	'否则超时后子进程仍可能拿到锁并把 staging 提交下去（接口报超时、配置却被改）');

/* ③ revert 必须复用 uci_run（它出现在每条失败分支上） */
const revert = (() => {
	const i = src.indexOf('async fn revert_schedule_uci');
	if (i < 0) return '';
	const j = src.indexOf('\n}\n', i);
	return j < 0 ? src.slice(i) : src.slice(i, j);
})();
ok('能定位到 revert_schedule_uci', revert.length > 0);
ok('revert 复用 uci_run', /uci_run\(/.test(revert),
	'revert 与 set/commit 走同一条路径，否则它会在"uci 已经出过问题"之后挂住整条连接');
ok('revert 不再直接起 uci 进程', !/Command::new\(\s*"uci"\s*\)/.test(revert));

/* ④ write_schedule_uci 的每条失败分支都必须 revert（保持既有约定） */
const writer = (() => {
	const i = src.indexOf('pub async fn write_schedule_uci');
	if (i < 0) return '';
	const j = src.indexOf('\n}\n', i);
	return j < 0 ? src.slice(i) : src.slice(i, j);
})();
const returns = (writer.match(/return Err\(/g) || []).length;
const reverts = (writer.match(/revert_schedule_uci\(\)\.await/g) || []).length;
ok('write_schedule_uci 的每条失败分支都 revert', returns > 0 && reverts >= returns,
	'失败不 revert 会把残缺 staging 挂着，被之后任意一次 uci commit 连带落盘');

/* ⑤ 全仓只允许这两处 uci 子进程调用 —— 而且两处都必须同时带超时与 kill_on_drop。
 *
 * config.rs 的那一处是 uci_values()（只读的 uci show），它比 schedconfig 更底层，
 * 所以不能反过来复用 uci_run（会成环）。允许它存在，但**同等要求**这两个保护：
 * 超时缺失会堵死整条 RPC 连接；kill_on_drop 缺失则超时后子进程仍持有 /var/lock/uci。
 */
const ALLOWED = { 'config.rs': 1, 'schedconfig.rs': 1 };
const offenders = [];
for (const f of fs.readdirSync(RUST_SRC).filter((n) => n.endsWith('.rs'))) {
	const t = stripComments(read(path.join(RUST_SRC, f)));
	const n = (t.match(/Command::new\(\s*"uci"\s*\)/g) || []).length;
	if (n !== (ALLOWED[f] || 0)) offenders.push(f + '=' + n);
}
ok('只有 config.rs 与 schedconfig.rs 各调一次 uci', offenders.length === 0,
	'违规文件：' + offenders.join(', ') + '（新增调用点必须走 uci_run，或同样带上这两重保护）');

for (const [f, sig] of [
	['config.rs', 'pub async fn uci_values'],
	['schedconfig.rs', 'async fn uci_run'],
]) {
	const t = stripComments(read(path.join(RUST_SRC, f)));
	const i = t.indexOf(sig);
	const j = i < 0 ? -1 : t.indexOf('\n}\n', i);
	const body = i < 0 ? '' : j < 0 ? t.slice(i) : t.slice(i, j);
	ok(f + ' 的 uci 调用带超时', body.length > 0 && /timeout\(/.test(body),
		'没有超时的 uci 会把这条 RPC 连接的后续请求全部堵死');
	ok(f + ' 的 uci 调用带 kill_on_drop(true)', /kill_on_drop\(\s*true\s*\)/.test(body),
		'否则超时后子进程仍持有 /var/lock/uci，之后每次 uci 调用都要排队等它');
}

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
