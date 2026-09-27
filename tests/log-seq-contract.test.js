#!/usr/bin/env node
/*
 * 日志环形缓冲的 seq 契约 —— 与 rpcserver 的 EventBus 是**同一条约定**。
 *
 * 为什么单独守它：这套约定已经被踩过一次，事故记录在 rpcserver.rs 的
 * `EventBus::push` 注释里 ——
 *   「先 fetch_add 再加锁，于是存在这样的窗口：号已分配、事件尚未入队，
 *     而此时 since() 读到这个新 seq 却看不到对应事件，前端据此把游标推进到
 *     该 seq —— 那条事件（新短信 / 来电）就永久拉不到了。」
 * 当时只修了事件总线，logger.rs 的同款写法留了下来（2026-09-28 发现并修正）。
 * 两个不变量缺一不可：
 *   ① **取号在队列锁之内**：否则那个窗口照样存在；
 *   ② **回传「本次实际回到的 seq」而不是当前最新 seq**：snapshot 会 drain 掉
 *      最旧的若干条，报最新 seq 就等于让被裁掉的日志永久不可见。
 *
 * 判据全部落在**剥离注释后的源码**上（注释里正当地提到了这些标识符）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOGGER = path.join(ROOT, 'src', 'rust', 'src', 'logger.rs');
const RPC = path.join(ROOT, 'src', 'rust', 'src', 'rpcserver.rs');

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
/* 去掉块注释与（行首或空白后的）行注释。本文件断言的正是"注释之外的真实写法"，
 * 而注释里会正当地提到这些标识符（例如 rpcserver.rs 那段事故说明）。 */
function stripComments(s) {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|\s)\/\/[^\n]*/g, '$1');
}
/* 取一个顶层函数的函数体：从签名到下一个顶格 `}`。 */
function fnBody(src, sig) {
	const i = src.indexOf(sig);
	if (i < 0) return '';
	const j = src.indexOf('\n}\n', i);
	return j < 0 ? src.slice(i) : src.slice(i, j);
}

console.log('== 日志 seq 契约（与 EventBus 同一条约定）==');

const logRaw = read(LOGGER);
const LOG = stripComments(logRaw);
const RPC_SRC = read(RPC);

ok('logger.rs 可读', logRaw.length > 0, '读不到 ' + LOGGER);

/* ① 取号在锁内 —— buffer_push 里 LOGS.lock() 必须先于 LOG_SEQ.fetch_add */
const pushBody = fnBody(LOG, 'fn buffer_push');
ok('能定位到 buffer_push', pushBody.length > 0, '函数被改名或删除了？');
const lockAt = pushBody.indexOf('LOGS.lock()');
const bumpAt = pushBody.indexOf('LOG_SEQ.fetch_add');
ok('buffer_push 在锁内取号', lockAt >= 0 && bumpAt > lockAt,
	'取号必须先取到队列锁（否则"号已分配、记录未入队"的窗口会让该条日志永久拉不到）');
ok('取号之后立即入队（同一个锁作用域内）',
	lockAt >= 0 && bumpAt > lockAt && pushBody.indexOf('push_back') > bumpAt,
	'入队必须与取号在同一把锁内完成');

/* ② emit 不得再自己取号（取号只允许出现在 buffer_push 里） */
const emitBody = fnBody(LOG, 'pub fn emit');
ok('能定位到 emit', emitBody.length > 0);
ok('emit 不自己取号（取号只在 buffer_push 内）', !/LOG_SEQ\s*\.\s*fetch_add/.test(emitBody),
	'两处取号就会重新引入那个窗口，且 seq 与入队顺序可能不一致');
const occurrences = (LOG.match(/LOG_SEQ\s*\.\s*fetch_add/g) || []).length;
ok('全文件只有一处 LOG_SEQ.fetch_add', occurrences === 1,
	'实际 ' + occurrences + ' 处；取号必须唯一，否则 seq 顺序与入队顺序不再一致');

/* ③ snapshot 回传"本次实际回到的 seq"，而不是当前最新 seq */
const snapBody = fnBody(LOG, 'pub fn snapshot');
ok('能定位到 snapshot', snapBody.length > 0);
ok('snapshot 不再读全局最新 seq', !/LOG_SEQ\s*\.\s*load/.test(snapBody),
	'报最新 seq 会让被 drain 掉的那些日志永久拉不到');
ok('snapshot 回传实际回到的 seq', /out\s*\.\s*last\s*\(\s*\)[\s\S]{0,80}unwrap_or\s*\(\s*since\s*\)/.test(snapBody),
	'应为 out.last().map(...).unwrap_or(since)：无记录时表示"游标没动"');
ok('snapshot 在锁内读取队列', /LOGS\.lock\(\)/.test(snapBody), 'snapshot 必须与 buffer_push 用同一把锁');

/* ④ 参照物仍在：EventBus::push 的那条约定不能被反向"对齐"掉 */
ok('EventBus::push 仍在锁内取号（本契约的参照物）',
	/lock\(\)[\s\S]{0,200}seq\s*\.\s*fetch_add/.test(RPC_SRC),
	'rpcserver.rs 的 EventBus::push 是这条约定的源头，它若被改回锁外取号，两边一起坏');
ok('EventBus::since 仍回传本次实际回到的 seq（参照物）',
	/let mut last = since/.test(RPC_SRC) && /\(last,\s*out\)/.test(RPC_SRC),
	'EventBus::since 的 last 语义是 logger::snapshot 对齐的目标');

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
