#!/usr/bin/env node
/*
 * `+CMGL` 应答解析契约：`Parse.parseCMGL`。
 *
 * 为什么需要它：这是**短信列表页的数据来源**，而它此前没有任何解析覆盖
 * （`sms-pdu.test.js` 测的是编解码，不是这条解析链）。它要同时处理三种输入形态：
 *   ① `AT+CMGL=4` 的原始应答（PDU 块）；
 *   ② 后端 RPC 包装过的 `{"success":true,"data":"…"}`；
 *   ③ 文本模式（CMGF=1）的已解码行。
 *
 * 其中 **PDU 行的识别用的是启发式**：`/^[0-9A-Fa-f]{20,}$/`（≥20 个十六进制字符）。
 * 依据是最短的 DELIVER PDU 也有 21 字节 = 42 字符，远高于门槛；而 `+CMGL` 头行含
 * 空格与逗号、不会被命中。本文件把这个边界钉死。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PARSE_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');

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

let Parse = null;
(function () {
	let src = '';
	try {
		src = fs.readFileSync(PARSE_JS, 'utf8').replace(/^\s*'require baseclass';\s*$/m, '');
	} catch (e) {
		return;
	}
	const sandbox = {
		console, Math, Object, Array, String, Number, Boolean, JSON, Date, RegExp, Error,
		parseInt, parseFloat, isNaN, isFinite, undefined,
		L: { Class: { extend: function (p) { const F = function () {}; Object.assign(F.prototype, p); return F; } } },
		baseclass: function () {},
		AtWs: { parseTemperature: function (v) { return Number(v); } },
	};
	try {
		vm.createContext(sandbox);
		Parse = new (vm.runInNewContext('(function(){' + src + '})()', sandbox))();
	} catch (e) {
		Parse = null;
	}
})();

console.log('== +CMGL 应答解析（Parse.parseCMGL）==');
ok('Parse.parseCMGL 可用', Parse !== null && typeof Parse.parseCMGL === 'function');
if (!Parse) {
	console.log('\nFAILED 无法加载 parse.js');
	process.exit(1);
}
const j = (x) => JSON.stringify(x);

/* 用一个真实形态的 PDU（UCS2「测试」，与 fixture 同源） */
const PDU = '00040B913108108300F0000852805221000023046D4B8BD5';

/* ---------- ① 原始应答：PDU 块 ---------- */
const raw = '+CMGL: 0,0,,24\r\n' + PDU + '\r\n+CMGL: 1,1,,24\r\n' + PDU + '\r\nOK';
const list = Parse.parseCMGL(raw);
ok('原始 PDU 应答解出 2 条', Array.isArray(list) && list.length === 2, j(list && list.length));
if (Array.isArray(list) && list.length === 2) {
	ok('第 1 条 index=0 且 unread=true（stat=0）', list[0].index === 0 && list[0].unread === true, j(list[0]));
	ok('第 2 条 index=1 且 unread=false（stat=1）', list[1].index === 1 && list[1].unread === false, j(list[1]));
	ok('正文解出「测试」', list[0].content === '测试', j(list[0].content));
	/*
	 * ★ 这里**不带**前导 '+' —— 别误以为前缀丢了。
	 *   parseCMGL 对发送方走的是 `normalizePhoneNumber`，而它**按设计会剥掉开头的 '+'**
	 *   （用于号码比对与未读记录的主键，见 sms_center.js 的说明）。
	 *   "TON=1 解出 +86138…" 是 decodeIncomingPdu 那一层的事，这里已经过了一层归一化。
	 */
	ok('发送方经 normalizePhoneNumber（按设计剥掉前导 +）', list[0].number === '13800138000', j(list[0].number));
	ok('类型标为 received', list[0].type === 'received', j(list[0].type));
}

/* ---------- ② 后端 RPC 的 JSON 包装形态 ---------- */
const wrapped = JSON.stringify({ success: true, data: raw });
const list2 = Parse.parseCMGL(wrapped);
ok('JSON 包装形态同样解出 2 条', Array.isArray(list2) && list2.length === 2, j(list2 && list2.length));

/* ---------- ③ PDU 行启发式的边界 ---------- */
ok('★ 少于 20 个十六进制字符的行不被当 PDU',
	Parse.parseCMGL('+CMGL: 0,0,,24\r\n0123456789ABCDEF\r\nOK').length === 0,
	j(Parse.parseCMGL('+CMGL: 0,0,,24\r\n0123456789ABCDEF\r\nOK').length));
ok('★ 含非十六进制字符的行不被当 PDU（如错误文本）',
	Parse.parseCMGL('+CMGL: 0,0,,24\r\n' + 'ZZZZZZZZZZZZZZZZZZZZZZ' + '\r\nOK').length === 0);
/*
 * ★ 不设「恰好 20 个十六进制字符」的边界断言 —— 那个门槛与"能解出短信"是两件事：
 *   20 个 '0' 会被 `/^[0-9A-Fa-f]{20,}$/` 认作 PDU 行，但 `decodeIncomingPdu`
 *   会因字段不足返回 null，最终**不产生条目**（两种机制叠加，单独断言门槛没有意义）。
 *   而**最短的合法 DELIVER PDU 是 42 个字符**（21 字节），远高于门槛 20 ——
 *   所以这个门槛在实践中不会误伤任何真实 PDU。
 */
ok('只有 +CMGL 头、没有 PDU 行时不产生条目',
	Parse.parseCMGL('+CMGL: 0,0,,24\r\nOK').length === 0);

/* ---------- ④ 边界输入 ---------- */
ok('空串 → 空数组', Array.isArray(Parse.parseCMGL('')) && Parse.parseCMGL('').length === 0);
ok('纯 OK → 空数组', Parse.parseCMGL('OK').length === 0);
ok('传 null / undefined 不抛异常', (function () {
	try { return Array.isArray(Parse.parseCMGL(null)) && Array.isArray(Parse.parseCMGL(undefined)); } catch (e) { return false; }
})());
ok('非法 JSON 串不抛异常（退化为按原文解析）', (function () {
	try { Parse.parseCMGL('{not json'); return true; } catch (e) { return false; }
})());

/* ---------- ⑤ 文本模式（CMGF=1）行仍可解析 ---------- */
const textForm = '+CMGL: 0,"REC READ","+8613800138000",,"26/09/28,12:34:56"\r\nhello\r\nOK';
const t = Parse.parseCMGL(textForm);
ok('文本模式行解出 1 条（type=received）', Array.isArray(t) && t.length === 1 && t[0].type === 'received', j(t));
ok('文本模式的已读态为 unread=false（READ 无 UNREAD）', t.length === 1 && t[0].unread === false, j(t[0]));

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
