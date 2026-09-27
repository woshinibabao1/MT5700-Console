#!/usr/bin/env node
/*
 * 短信未读状态契约（sms_center.js）
 * ---------------------------------------------------------------------------
 * ★ 背景（2026-09-28 用户报告）：
 *   「短信处明明已读，但是刷新后依旧显示未读」—— 现场确认是
 *   「点了会话，徽章当场消失，但刷新页面后又出现」。
 *
 *   根因是 sms_center.js 里的**不对称**：
 *     clearUnread(num):
 *       var i = unreadNumbers.indexOf(num);
 *       if (i >= 0) { unreadNumbers.splice(i, 1); saveUnread(); }   <- 有条件落盘
 *       ...（下面清 msg.unread / unreadCount / unread 是**无条件**的）
 *   只要 i === -1，就出现「内存已清、localStorage 未清」：徽章当场消失
 *   （内存生效），刷新后从 localStorage 重读又回来。
 *
 *   而 i === -1 真实可达：名单**跨版本持久化**（键名一直没变），读取侧原来
 *   只过滤 typeof x === 'string'、**不做归一化**，而 markUnread / clearUnread /
 *   isUnread 一律用 Parse.normalizePhoneNumber() 的结果做键。历史数据里存
 *   非归一化号码（如 "+8610086"）、查询用 "10086" 就永远查不到。
 *
 * 本文件钉住两条修复，防止回退。
 *
 * 运行：node tests/sms-center-unread-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SMS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');

const src = fs.readFileSync(SMS, 'utf8');
const parseSrc = fs.readFileSync(PARSE, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

ok('U0 sms_center.js 可读（否则下面全是空转）', src.length > 0, '读不到 ' + SMS);

/* ---------- 1. 静态：两处修复都在 ---------- */

function bodyOf(name) {
	const start = src.indexOf('function ' + name + '(');
	if (start < 0) return null;
	const end = src.indexOf('\n\t\t}', start);
	return end < 0 ? null : src.slice(start, end + 4);
}

const clearBody = bodyOf('clearUnread');
ok('U1 能定位到 clearUnread 函数体', clearBody !== null);

ok('U2 ★ clearUnread 不再把 saveUnread() 与 splice 写在同一行（内存清、存储没清的根源）',
	clearBody !== null && !/[^\n]*splice[^\n]*saveUnread\(\)/.test(clearBody),
	'仍在同一分支里落盘');

ok('U3 clearUnread 里存在无条件的 saveUnread() 调用',
	clearBody !== null && /\n\t\t\tsaveUnread\(\);/.test(clearBody),
	'saveUnread 不在无条件路径上');

const initBody = (function () {
	const start = src.indexOf('var unreadNumbers = (function ()');
	if (start < 0) return null;
	const end = src.indexOf('})();', start);
	return end < 0 ? null : src.slice(start, end + 5);
})();
ok('U4 能定位到 unreadNumbers 的初始化块', initBody !== null);
ok('U5 ★ 读取 localStorage 时做了归一化（自愈旧格式，否则 indexOf 永远 -1）',
	initBody !== null && initBody.indexOf('normalizeNumber(') >= 0,
	'初始化块里没有 normalizeNumber');
ok('U6 读取时去重（避免同名多份导致 splice 只删掉一个）',
	initBody !== null && /out\.indexOf\(n\)\s*<\s*0/.test(initBody));

/* ---------- 2. 行为：用真实的 Parse.normalizePhoneNumber 跑一遍 ---------- */

const ctx = {
	console, JSON, Math, String, Number, Object, Array, RegExp, Date,
	parseInt, parseFloat, isNaN, isFinite,
	L: {
		Class: {
			extend: function (x) {
				function C() {}
				Object.assign(C.prototype, x);
				Object.assign(C, x);
				return C;
			}
		}
	},
	window: undefined
};
vm.createContext(ctx);
const Parse = vm.runInContext('(function(){\n' + parseSrc + '\n})()', ctx);
const norm = Parse.normalizePhoneNumber;
ok('U7 能载入 Parse.normalizePhoneNumber 并归一化 +8610086 → 10086',
	norm('+8610086') === '10086', '实际 ' + norm('+8610086'));

function makeStore(initial) {
	let list = [];
	for (let i = 0; i < initial.length; i++) {
		if (typeof initial[i] !== 'string') continue;
		const n = norm(initial[i]);
		if (n && list.indexOf(n) < 0) list.push(n);
	}
	let persisted = JSON.stringify(list.slice(-200));
	const save = () => { persisted = JSON.stringify(list.slice(-200)); };
	return {
		get list() { return list; },
		get saved() { return JSON.parse(persisted); },
		mark(num) {
			num = norm(num || '');
			if (!num || list.indexOf(num) >= 0) return;
			list.push(num); save();
		},
		clear(num) {
			num = norm(num || '');
			const i = list.indexOf(num);
			if (i >= 0) list.splice(i, 1);
			save();
		},
		isUnread(num) { return list.indexOf(norm(num || '')) >= 0; }
	};
}

{
	const s = makeStore(['+8610086']);
	ok('U8 旧格式名单在读取时被归一化', s.list.length === 1 && s.list[0] === '10086',
		'实际 ' + JSON.stringify(s.list));
	ok('U9 归一化后 isUnread 能命中（修复前永远 -1）', s.isUnread('10086'));
	s.clear('10086');
	ok('U10 clearUnread 后持久化里也没了（刷新后不会再冒出来）',
		s.saved.indexOf('10086') < 0, '持久化残留 ' + JSON.stringify(s.saved));
}

{
	const s = makeStore([]);
	s.mark('10086');
	s.clear('13800138000');
	ok('U11 清不在名单里的号码，不会破坏已持久化的其它号码',
		s.saved.indexOf('10086') >= 0, '持久化 ' + JSON.stringify(s.saved));
}

{
	const s = makeStore([]);
	s.mark('10086');
	s.mark('100860009832');
	ok('U12 两个不同号码各自独立记账', s.list.length === 2, JSON.stringify(s.list));
	s.clear('10086');
	ok('U13 清掉 10086 后，100860009832 的未读仍在（它们确实是两个号码）',
		s.isUnread('100860009832') && !s.isUnread('10086'));
	ok('U14 ★ 持久化与内存始终一致（本次修复的核心不变式）',
		JSON.stringify(s.saved) === JSON.stringify(s.list),
		'内存 ' + JSON.stringify(s.list) + ' vs 持久化 ' + JSON.stringify(s.saved));
}

/* ---------- 3. 反向自证 ---------- */
{
	const broken = src
		.replace('\t\t\tif (i >= 0) unreadNumbers.splice(i, 1);',
			'\t\t\tif (i >= 0) { unreadNumbers.splice(i, 1); saveUnread(); }')
		.replace(/\n\t\t\tsaveUnread\(\);\n/, '\n');
	const bStart = broken.indexOf('function clearUnread(');
	const bEnd = broken.indexOf('\n\t\t}', bStart);
	const bBody = bStart < 0 ? '' : broken.slice(bStart, bEnd + 4);
	ok('自证 A：把 saveUnread 塞回 splice 同一行后，U2 的判据不再成立',
		/[^\n]*splice[^\n]*saveUnread\(\)/.test(bBody));

	const broken2 = src.replace('normalizeNumber(arr[i])', 'arr[i]');
	const s2 = broken2.indexOf('var unreadNumbers = (function ()');
	const e2 = broken2.indexOf('})();', s2);
	const bInit = s2 < 0 ? '' : broken2.slice(s2, e2 + 5);
	ok('自证 B：读取侧去掉归一化后，U5 的判据不再成立',
		bInit.indexOf('normalizeNumber(') < 0);
}

console.log('');
if (fails.length) {
	console.error('失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	process.exit(1);
}
console.log('通过 ' + pass + ' 项，失败 0 项');
console.log('短信未读状态契约测试全部通过');