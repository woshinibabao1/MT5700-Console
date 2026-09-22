#!/usr/bin/env node
'use strict';

/*
 * 单一真源契约：**同一件事在全仓只允许有一处实现**
 * ---------------------------------------------------------------------------
 * 起因（本轮全量审查实况）：
 *
 *   1. 信号百分比有两套量程 —— rpc.js 用 -110~-70、mt5700.js 用 -120~-70，
 *      同一个 RSRP 在「运行状态」与「网络设置」显示两个百分比；
 *      更糟的是 mt5700.js 给百分比定的分级阈值（75/50/25）是按 **rpc.js 那套**
 *      量程推出来的，与它自己文件里的公式对不上。
 *   2. 「哪些 AT 危险」散在各页面 —— 短信设置页翻一下开关就下发
 *      AT+CFUN=0（断 5G）与 AT+CMGD=1,4（清空全部短信），全程无确认；
 *      而终端页对同样的命令也不设防。
 *   3. 「剥引号/转数字」的小工具在同一个文件里写了三份，且契约不一致
 *      （有一份缺字段返回 0，把「没读到」伪装成「读到了 CS 域」）。
 *   4. RPC 出站帧没有字节预算（入站有），事件总线 500 条一次全回会撑爆 8192。
 *
 * 这些都不是「代码写错了」，而是**同一件事有了两个家**，改一处另一处不动。
 * 本文件把「只有一个家」这件事变成可执行的断言。
 *
 * ★ 每条断言都要能**判红**——文件末尾有反向自检，恒绿的守卫等于没有守卫。
 *
 * 用法：node tests/single-source-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ATW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver');
const VIEW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const RUST = path.join(ROOT, 'src', 'rust', 'src', 'rpcserver.rs');

function read(p) {
	return fs.readFileSync(p, 'utf8');
}
function count(src, re) {
	const m = src.match(re);
	return m ? m.length : 0;
}

/*
 * 数「规则出现几次」时必须先去掉注释：注释里举的例子（AT+CFUN=? 之类）
 * 会被算进去，于是断言要么恒绿要么莫名其妙地红。
 */
function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

const parse = read(path.join(ATW, 'parse.js'));
const rpc = read(path.join(ATW, 'rpc.js'));
const m5700 = read(path.join(ATW, 'mt5700.js'));
const term = read(path.join(VIEW, 'terminal.js'));
const smsSet = read(path.join(VIEW, 'sms_settings.js'));
const rust = read(RUST);

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* ==========================================================================
 * 1. 信号百分比 / 等级：只准在 parse.js 算一次
 * ========================================================================== */

ok('parse.js 定义 api.signalPercent（百分比真源）', /api\.signalPercent = function/.test(parse));
ok('parse.js 定义 api.signalLevel（RSRP 分级真源）', /api\.signalLevel = function/.test(parse));
ok('parse.js 定义 api.percentLevel（百分比分级真源）', /api\.percentLevel = function/.test(parse));

ok('rpc.js 的 calculateSignalPercent 转调 Parse.signalPercent',
	/function calculateSignalPercent[\s\S]{0,200}Parse\.signalPercent\(/.test(rpc),
	'rpc.js 又开始自己算百分比了 —— 两个页面会显示两个值');
ok('mt5700.js 的 api.signalPercent 转调 Parse.signalPercent',
	/api\.signalPercent = function \(rsrp\)[\s\S]{0,120}Parse\.signalPercent\(/.test(m5700),
	'mt5700.js 又开始自己算百分比了');

/* 量程算式本身不许再出现在别处（只匹配算式，不匹配注释里提到的数字） */
ok('rpc.js 不再自带 -110 量程算式',
	!/rsrp\s*-\s*\(\s*-110\s*\)/.test(rpc),
	'rpc.js 里又出现了 (rsrp - (-110)) 量程，与 parse.js 的 -120~-70 打架');
ok('mt5700.js 不再自带 -120 量程算式',
	!/2 \* \(Number\(rsrp\) \+ 120\)/.test(m5700),
	'mt5700.js 里又出现了 2*(rsrp+120)，与 parse.js 的公式分家');
ok('mt5700.js 的百分比分级不再写死 75/50/25',
	!/\? 'exc' : v >= 50 \? 'good' : v >= 25 \? 'fair'/.test(m5700),
	'75/50/25 是按已废弃的 -110~-70 量程算的，与现公式差一档');

/* ==========================================================================
 * 2. 危险 AT：判定只在 parse.js，页面只准消费
 * ========================================================================== */

ok('parse.js 定义 api.atDangerHint', /api\.atDangerHint = function/.test(parse));
ok('parse.js 有 AT_DANGER 表', /var AT_DANGER = \[/.test(parse));

/* 定位断言：每条危险规则恰好一处，防止「抄一遍照样全绿」（计数前先剥注释） */
const parseCode = stripComments(parse);
[['CFUN 重启', /AT\\\+CFUN\\s\*=\\s\*1\\s\*,\\s\*1/],
	['CFUN 关射频', /AT\\\+CFUN\\s\*=\\s\*0/],
	['CMGD 全删', /AT\\\+CMGD\\s\*=\\s\*\[\^,\]\*,\\s\*4/],
	['RESET', /AT\\\^RESET/], ['恢复出厂', /AT\\s\*&\\s\*F/], ['FOTA', /FOTA/]].forEach(function (row) {
	const n = count(parseCode, new RegExp(row[1].source, 'g'));
	ok('AT_DANGER 表里有「' + row[0] + '」且恰好一处', n === 1, '实际 ' + n + ' 处');
});
/* CFUN 三条规则（重启 / 关射频 / 其它改射频）合计 3 条，多一条说明抄重了 */
ok('AT_DANGER 里 CFUN 相关规则恰好 3 条',
	count(parseCode, /AT\\\+CFUN/g) === 3,
	'实际 ' + count(parseCode, /AT\\\+CFUN/g) + ' 条');

ok('终端页在发送前查 Parse.atDangerHint', /Parse\.atDangerHint\(/.test(term),
	'终端又没有危险指令提示了 —— AT+CFUN=0 会直接把 5G 断掉');
ok('短信设置页在执行开关前查 Parse.atDangerHint', /Parse\.atDangerHint\(/.test(smsSet),
	'短信开关又会不经确认就发 AT+CFUN=0 与 AT+CMGD=1,4（清空全部短信）');

/* ==========================================================================
 * 3. 取值小工具：parse.js 一份，别处不再各写一份
 * ========================================================================== */

/*
 * 定位断言：恰好定义一处。
 *
 * ★ 只看 `function name(` 是不够的 —— 抄一份时更常见的写法是
 *   `var numOrNull = function (v) {...}`，只匹配声明式会让守卫对这个形态恒绿
 *   （本轮变异验证实测到）。两种写法都要算进去。
 */
[['unquote', 'unquote'], ['numOrNull', 'numOrNull'], ['hexOrNull', 'hexOrNull']].forEach(function (row) {
	const re = new RegExp('(?:function\\s+' + row[1] + '\\s*\\(|var\\s+' + row[1] + '\\s*=\\s*function)', 'g');
	const n = count(parse, re);
	ok('parse.js 里「' + row[0] + '」恰好定义一处', n === 1,
		'实际 ' + n + ' 处 —— 多份实现迟早契约不一致');
});

ok('parseRejInfo 不再把「读不到」归 0',
	!/return isFinite\(n\) \? n : 0/.test(parse),
	'缺字段又归 0 了：0 在域/制式表里都是合法取值，会把「没上报」显示成「CS 域」');

/* ==========================================================================
 * 4. RPC 出站帧预算（入站有上限，出站原来没有）
 * ========================================================================== */

ok('rpcserver.rs 定义 EVENT_FRAME_BUDGET', /const EVENT_FRAME_BUDGET: usize/.test(rust));
ok('EventBus::since 带 budget 参数', /fn since\(&self, since: u64, budget: usize\)/.test(rust),
	'since 又没有字节预算了 —— 500 条事件一次全回会撑爆 8192 单帧');
ok('events 调用点传入 EVENT_FRAME_BUDGET', /\.since\(since, EVENT_FRAME_BUDGET\)/.test(rust));

/* ==========================================================================
 * 5. 反向自检：上面每条正则型断言都必须能判红（恒绿的守卫等于没有守卫）
 * ========================================================================== */

const badRpc = 'function calculateSignalPercent(rsrp) {\n'
	+ '\tvar ratio = (rsrp - (-110)) / ((-70) - (-110));\n'
	+ '\treturn Math.round(ratio * 100) + "%";\n}';
ok('★ 反向自检：rpc.js 自带的 -110 量程会被判红',
	/rsrp\s*-\s*\(\s*-110\s*\)/.test(badRpc));

const badTerm = 'AtWs.client.sendCommand(command).then(function (res) { render(res); });';
ok('★ 反向自检：终端不查 atDangerHint 会被判红', !/Parse\.atDangerHint\(/.test(badTerm));

const badRej = 'var num = function (v) { var n = Number(unquote(v)); return isFinite(n) ? n : 0; };';
ok('★ 反向自检：缺字段归 0 会被判红', /return isFinite\(n\) \? n : 0/.test(badRej));

const badRust = 'fn since(&self, since: u64) -> (u64, Vec<serde_json::Value>) {';
ok('★ 反向自检：since 不带 budget 会被判红',
	!/fn since\(&self, since: u64, budget: usize\)/.test(badRust));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
