#!/usr/bin/env node
/*
 * 模组升级（FOTA）状态轮询的节奏契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景：升级页曾用固定 setInterval(…, 1000) 查 AT^FOTASTATE?。
 *   · FOTA 下载动辄几十分钟 → 上千条查询灌进独占串口；
 *   · setInterval 不等前一条应答，模组响应一慢命令就堆积，
 *     把短信、信号刷新、看门狗下发一起拖住。
 * 现在改成「递归 setTimeout + in-flight 守卫 + 按阶段分档 + 无变化退避」。
 *
 * 这里把节奏算法从源码里抽出来直接跑，验证退避序列真的按设计收敛，
 * 而不只是「代码里写了 POLL_FAST 这几个常量」。
 *
 * 运行：node tests/upgrade-poll.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'upgrade.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}
function eq(label, actual, expected) {
	ok(label + '（实际 ' + actual + '，期望 ' + expected + '）', actual === expected);
}

/* ---------- 1. 结构：不能再有固定周期的 setInterval ---------- */

// 只检查真正的代码：文件头的块注释里会提到「早期版本是 setInterval」这种历史说明，
// 不能让它把断言带偏。行内 // 注释保留（里面不会出现被检查的关键字）。
const code = src.replace(/\/\*[\s\S]*?\*\//g, '');

ok('不再使用 setInterval 做状态轮询', code.indexOf('setInterval') < 0,
	'固定周期轮询会不等应答就发下一条，模组一慢就堆积命令');
ok('用 clearTimeout 收尾（与递归 setTimeout 配套）', code.indexOf('clearTimeout(timer)') >= 0);
ok('有 in-flight 守卫 pollBusy', /var\s+pollBusy\s*=\s*false/.test(code) && /if\s*\(pollBusy\)/.test(code),
	'同一时刻只允许一条查询在飞');
ok('重复点击「开始升级」会被挡住', /if\s*\(pollKeep\s*\|\|\s*pollBusy\)/.test(code));

/* ---------- 1b. 只降频、不放弃：轮询本身不能因「等太久」而停 ---------- */
// 卡住只允许提示一次（POLL_STALL_WARN），不允许到点撒手 —— 没等到成功或失败就得继续。
ok('有卡住提醒 POLL_STALL_WARN', /var\s+POLL_STALL_WARN\s*=/.test(code));
ok('不存在总时限式的停止常量', code.indexOf('POLL_DEADLINE') < 0,
	'总时限会把「还在下载」误报成失败，必须在没等成功/失败前继续等');
{
	const pollOnce = extractFn('pollOnce');
	ok('pollOnce 自身不会放弃轮询', pollOnce.indexOf('stopTimer') < 0,
		'超时/卡住只该提示，不该停 —— 终态只能由 tick 判定');
	ok('卡住提醒用的是提示而非错误', pollOnce.indexOf('Mt5700.info') >= 0
		&& pollOnce.indexOf('继续等待中') >= 0);
}

/* ---------- 2. 取出常量与 nextDelay 函数体，真跑一遍 ---------- */

function constOf(name) {
	const m = src.match(new RegExp('var\\s+' + name + '\\s*=\\s*([^;]+);'));
	if (!m) throw new Error('源码里找不到常量 ' + name);
	// eslint-disable-next-line no-new-func
	return Function('return (' + m[1] + ')')();
}

/**
 * 从源码里按花括号配对截取一个具名函数。
 * 不用「从起点到下一个 }」那种脆弱写法 —— 函数体里有 switch/for 会提前截断。
 */
function extractFn(name) {
	const start = src.indexOf('function ' + name + '(');
	if (start < 0) throw new Error('源码里找不到函数 ' + name);
	let i = src.indexOf('{', start);
	let depth = 0;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	throw new Error('函数 ' + name + ' 的花括号没有配对');
}

const POLL_FAST = constOf('POLL_FAST');
const POLL_DOWNLOAD = constOf('POLL_DOWNLOAD');
const POLL_MAX = constOf('POLL_MAX');
const POLL_BACKOFF_AFTER = constOf('POLL_BACKOFF_AFTER');

/* 常量之间的大小关系本身就是设计意图，先钉住 */
ok('下载档比快档慢', POLL_DOWNLOAD > POLL_FAST);
ok('封顶不超过 10 秒（终态最多晚这么久被发现）', POLL_MAX <= 10000, '实际 ' + POLL_MAX);
ok('快档是 1 秒级', POLL_FAST >= 500 && POLL_FAST <= 1500, '实际 ' + POLL_FAST);
ok('下载档是 3 秒级', POLL_DOWNLOAD >= 2000 && POLL_DOWNLOAD <= 5000, '实际 ' + POLL_DOWNLOAD);

/* 造一个带状态的 nextDelay：lastState / sameCount 必须在调用之间保活 */
function makeScheduler() {
	/* eslint-disable no-new-func */
	return new Function(
		'POLL_FAST', 'POLL_DOWNLOAD', 'POLL_MAX', 'POLL_BACKOFF_AFTER',
		'var lastState = -1, sameCount = 0;' +
		'return ' + extractFn('nextDelay') + ';'
	)(POLL_FAST, POLL_DOWNLOAD, POLL_MAX, POLL_BACKOFF_AFTER);
	/* eslint-enable no-new-func */
}

/* ---------- 3. 退避序列 ---------- */

// 11 = 正在查询新版本：属于「状态切换快」的档位
{
	const nd = makeScheduler();
	eq('查询新版本：第 1 次间隔', nd(11), POLL_FAST);
	eq('查询新版本：状态未变第 2 次', nd(11), POLL_FAST);
	eq('查询新版本：状态未变第 3 次', nd(11), POLL_FAST);
	eq('查询新版本：连续 ' + POLL_BACKOFF_AFTER + ' 次后翻倍', nd(11), POLL_FAST * 2);
}

// 退避必须收敛到封顶，不能无限翻倍
{
	const nd = makeScheduler();
	let last = 0;
	for (let i = 0; i < 200; i++) last = nd(11);
	eq('查询新版本：长时间不变收敛到 POLL_MAX', last, POLL_MAX);
}

// 30 = 下载中：起点就是 3s
{
	const nd = makeScheduler();
	eq('下载中：第 1 次间隔', nd(30), POLL_DOWNLOAD);
	let last = 0;
	for (let i = 0; i < 200; i++) last = nd(30);
	eq('下载中：长时间不变收敛到 POLL_MAX', last, POLL_MAX);
}

// 状态一变必须回到该档位的起点 —— 关键跳变不能被退避拖慢
{
	const nd = makeScheduler();
	for (let i = 0; i < 50; i++) nd(30);      // 先退避到下载档封顶
	eq('下载中 → 下载完成：立刻回到快档', nd(40), POLL_FAST);
	for (let i = 0; i < 50; i++) nd(40);      // 停在「下载完成」也会退避
	eq('下载完成 → 升级中：状态一变又回到快档', nd(50), POLL_FAST);
}

/* ---------- 4. 量化收益：同样时长下命令条数必须显著下降 ---------- */

/**
 * 模拟一次 FOTA：查询 5s → 下载 30 分钟 → 下载完成 → 升级 60s。
 * 返回该过程中「状态查询」的次数。
 */
function countQueries(useNew) {
	const nd = makeScheduler();
	let queries = 0;
	// 阶段：[状态, 持续毫秒]
	const phases = [[11, 5 * 1000], [30, 30 * 60 * 1000], [40, 1000], [50, 60 * 1000]];
	for (const [state, dur] of phases) {
		let t = 0;
		while (t < dur) {
			queries++;
			t += useNew ? nd(state) : 1000;   // 旧实现：固定 1000ms
		}
	}
	return queries;
}

const oldCount = countQueries(false);
const newCount = countQueries(true);
ok('30 分钟下载场景下，新节奏的查询条数降到旧实现的 1/3 以下',
	newCount * 3 < oldCount,
	'旧 ' + oldCount + ' 条 → 新 ' + newCount + ' 条');
ok('新节奏在半小时量级的升级里控制在千条以内', newCount < 1000, '实际 ' + newCount + ' 条');
// 下载中还要查进度：每轮 2 条（FOTASTATE + FOTADLQ），仍应远低于旧实现
ok('算上进度查询后仍优于旧实现', newCount * 2 < oldCount,
	'旧 ' + oldCount + ' 条 → 新 ' + (newCount * 2) + ' 条');

/* ---------- 5. 终态判定：必须能同时报出成功和失败 ----------
 * 依据《MT5700M-CN FOTA 升级指南》5 章与《AT 命令手册》15.4 / 15.5。
 * 手册 15.4：AT^FWUP 之后「若升级失败，输出 ^FOTASTATE: 70」——
 * 70 才是升级失败的终态；50 只是「升级指令设置成功」。
 * 早期实现在 40（下载完成）就 stopTimer，于是 70 永远看不到，失败会被当成成功。
 */

const tickSrc = extractFn('tick');

/** 截取 tick 里某个 case 分支的源码块（到下一个 case 为止） */
function caseBlock(label) {
	const head = 'case ' + label + ':';
	const start = tickSrc.indexOf(head);
	if (start < 0) return null;
	const rest = tickSrc.slice(start + head.length);
	const m = rest.match(/\n[\t ]*case /);
	return m ? tickSrc.slice(start, start + head.length + m.index) : tickSrc.slice(start);
}

// 模组明确上报的失败类终态，都必须停轮询并给出结论
for (const st of [13, 14, 20, 70]) {
	const blk = caseBlock(st);
	ok('状态 ' + st + ' 有独立分支', blk !== null);
	ok('状态 ' + st + ' 被判为终态（停止轮询）', blk !== null && blk.indexOf('stopTimer()') >= 0,
		'不停止就会一直等下去，用户永远看不到失败');
}

// 40 / 50 都不是终态，不能停
for (const st of [40, 50]) {
	const blk = caseBlock(st);
	ok('状态 ' + st + ' 有独立分支', blk !== null);
	ok('状态 ' + st + ' 不停止轮询（' + st + ' 不是升级结果）', blk !== null && blk.indexOf('stopTimer()') < 0,
		st === 40
			? '发完 AT^FWUP 就停，就永远看不到 70（升级失败）'
			: '50 只是升级指令设置成功，升级本身还没完');
}

// 静默回落：11 查询中 → 10 空闲，既不上报 13/14 也不进 30
{
	const blk = caseBlock(10);
	ok('状态 10 有独立分支', blk !== null);
	ok('状态 10：见过查询却没进下载 → 判终态',
		blk !== null && blk.indexOf('sawQuery') >= 0 && blk.indexOf('stopTimer()') >= 0,
		'下发 OEMDL 后静默回到 IDLE 很常见（多半是服务器没有新版本），不判就是无限等待');
	ok('状态 10：连查询都没进去也有超时兜底',
		blk !== null && blk.indexOf('QUERY_START_TIMEOUT') >= 0);
	ok('状态 10：走过下载回到 IDLE 时走版本复核',
		blk !== null && blk.indexOf('sawDownload') >= 0 && blk.indexOf('finishByIdle') >= 0);
}

// 成功要靠版本复核，不能「发出去就算完」
{
	const fin = extractFn('finishByIdle');
	ok('有版本复核函数 finishByIdle', fin.length > 0);
	ok('复核用 AT+CGMR 取当前版本', fin.indexOf('AT+CGMR') >= 0);
	ok('复核拿升级前版本 baseVersion 做对比',
		fin.indexOf('baseVersion') >= 0 && /now\s*!==\s*baseVersion/.test(fin),
		'FOTA 指南 4.2：升级完毕后通过查询版本变化判断是否升级成功');
	ok('版本没变时报「未确认成功」而不是报成功', /未变化|复核/.test(fin));
}

// 31 续传必须节流，不能每轮都发
{
	const blk = caseBlock(31);
	ok('状态 31 的续传做了节流', blk !== null && blk.indexOf('RESUME_MIN_GAP') >= 0,
		'每轮都发 AT^FOTADL=1 又成了高频命令');
}

// 状态文案要覆盖手册里的 10 与 70
{
	const textFn = extractFn('fotaStateText');
	ok('状态文案覆盖 10（空闲）', /10:\s*'空闲/.test(textFn));
	ok('状态文案覆盖 70（升级失败）', /70:\s*'升级失败/.test(textFn));
}

// 手册【规范】：^FOTAOEMDL 只能在 IDLE(10) 下发
{
	const startFn = extractFn('start');
	ok('下发 ^FOTAOEMDL 前先查状态', /queryState\(\)/.test(startFn));
	ok('非空闲状态 10 时拒绝下发', /st\s*!==\s*10/.test(startFn) && /AT\^FOTADL=0/.test(startFn),
		'FOTA 指南 5 章：^FOTAOEMDL 需在 ^FOTASTATE:10 时下发；卡住时先 AT^FOTADL=0 复位');
}

/* ---------- 结果 ---------- */

if (fails.length) {
	console.error('失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('通过 ' + pass + ' 项');
	process.exit(1);
}
console.log('通过 ' + pass + ' 项，模组升级轮询节奏契约全部满足');
console.log('  （30 分钟 FOTA：旧 ' + oldCount + ' 条查询 → 新 ' + newCount + ' 条，含进度查询 ' + newCount * 2 + ' 条）');
