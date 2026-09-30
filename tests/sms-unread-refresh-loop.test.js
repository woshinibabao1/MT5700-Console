#!/usr/bin/env node
'use strict';

/*
 * 短信"已读又变回未读"——诊断回路（diagnosing-bugs Phase 1/5）
 * ===========================================================================
 * 用户症状（设备 192.168.10.1，真机复现）：
 *   10086 的短信已经读过，**刷新短信页后又显示未读**。
 *
 * 本文件把 sms_center.js 里真正决定"未读"的那几段代码**抽出来跑**（不是重写一份模型），
 * 按用户的操作序列驱动：
 *     ① 列表刷新（模组侧全是 stat=1，即已读）
 *     ② 新短信推送到达 → markUnread(号码)
 *     ③ 用户读到它（会话正处于显示状态）
 *     ④ **刷新页面**（用同一份 localStorage 重新初始化模块）
 *   断言 ④ 之后不能再显示未读。
 *
 * 缝隙说明（为什么这是"正确缝隙"）：抽的是**同一份源码文本**里的
 * `unreadNumbers` 初始化、markUnread/clearUnread/isUnread、以及 buildContacts 里
 * 那句 `c.unreadCount = …` 表达式与 renderConversation 里的清理调用 ——
 * 改源码即改被测对象，不存在"测试与实现各写一份"的假信心。
 *
 * 红能力自检：文件末尾用**旧写法**（宽回退 + 会话显示时不清未读）跑同一序列，
 * 必须复现"刷新后仍未读" —— 判红不了就说明这条回路是空的。
 *
 * 用法：node tests/sms-unread-refresh-loop.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SMS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');
const KEY = 'mt5700_sms_unread_numbers';

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* 与仓库既有测试同一实现：按大括号配平抽取函数 */
function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（改名了？请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

/* 抽 `var unreadNumbers = (function () {…})();` 这段 IIFE */
function extractUnreadInit(s) {
	const marker = 'var unreadNumbers = (function () {';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到 unreadNumbers 初始化（改名了？请同步本测试）');
	let depth = 0, begun = false;
	for (let i = s.indexOf('{', start); i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1) + ')();'; }
	}
	throw new Error('unreadNumbers 初始化括号未配平');
}

/* 抽 buildContacts 里那句未读数表达式（取含 unreadN 的那一条，避开 clearUnread 里的 = 0） */
function extractCountExpr(s) {
	const re = /c\.unreadCount\s*=\s*([^;]+);/g;
	let m, found = null;
	while ((m = re.exec(s)) !== null) { if (/unreadN/.test(m[1])) found = m[1]; }
	if (!found) throw new Error('找不到 unreadCount 计算式（改名了？请同步本测试）');
	return found;
}

/* 会话显示时是否会清未读：返回该调用文本或 null */
function extractClearOnRender(s) {
	const body = extractFn(s, 'renderConversation');
	const m = body.match(/clearUnread\(state\.selectedContact\)/);
	return m ? m[0] : null;
}

/* 用给定源码 + 给定的 localStorage 内容，造一个"页面实例" */
function makePage(src, store) {
	const localStorage = {
		getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
		setItem: (k, v) => { store[k] = String(v); }
	};
	/* 号码归一化：真实现来自 Parse.normalizePhoneNumber；这里用等价的保守实现（纯数字） */
	const normalizeNumber = n => String(n == null ? '' : n).replace(/[^\d]/g, '');
	const unreadInit = extractUnreadInit(src);
	const code = [
		'return (function () {',
		'  var UNREAD_KEY = ' + JSON.stringify(KEY) + ';',
		'  ' + unreadInit,
		'  ' + extractFn(src, 'saveUnread'),
		'  ' + extractFn(src, 'markUnread'),
		'  ' + extractFn(src, 'clearUnread'),
		'  ' + extractFn(src, 'isUnread'),
		'  return { markUnread: markUnread, clearUnread: clearUnread, isUnread: isUnread,',
		'           list: function () { return unreadNumbers.slice(); } };',
		'})();'
	].join('\n');
	/* clearUnread 里会遍历 state.contacts；回路里给一个可注入的 state */
	const state = { contacts: [] };
	const api = new Function('localStorage', 'normalizeNumber', 'state', code)(localStorage, normalizeNumber, state);
	const countExpr = extractCountExpr(src);
	const countOf = new Function('unreadN', 'c', 'isUnread', 'return (' + countExpr + ');');
	return {
		api: api,
		state: state,
		/* ④ 刷新后重建某个会话的未读数（= buildContacts 里那句表达式的真实求值） */
		countOf: function (number, messages) {
			const unreadN = messages.filter(m => m.unread).length;
			const c = { number: number, messages: messages };
			return countOf(unreadN, c, api.isUnread);
		},
		clearOnRender: extractClearOnRender(src),
		/* ③ 用户在"会话正处于显示状态"下读到它：执行 renderConversation 里的那行清理 */
		readWhileWatching: function (number) {
			if (!this.clearOnRender) return false;   // 旧版没有这行 → 什么也不清
			this.state.selectedContact = number;
			new Function('state', 'clearUnread', 'return ' + this.clearOnRender + ';')(this.state, api.clearUnread);
			return true;
		}
	};
}

/* ---------------- 场景：用户报障的完整序列 ---------------- */
function scenario(src) {
	const store = {};
	/* ① 列表刷新：模组侧全是已读（stat=1）→ 会话里没有未读消息 */
	let page = makePage(src, store);
	const msgs = [{ unread: false, content: '【订购成功提醒】…', time: '26/09/30,19:53:50' }];
	const step1 = page.countOf('10086', msgs);
	/* ② 新短信推送到达（CMTI）→ 按号码标未读 */
	page.api.markUnread('10086');
	const step2 = page.countOf('10086', msgs.concat([{ unread: true, content: '新短信', time: '26/09/30,20:38:20' }]));
	/* ③ 用户读到它（会话正处于显示状态） */
	const cleared = page.readWhileWatching('10086');
	const step3 = page.countOf('10086', msgs.map(m => ({ unread: false, content: m.content, time: m.time })));
	/* ④ 刷新页面：同一份 localStorage，重新初始化模块 */
	page = makePage(src, store);
	const step4 = page.countOf('10086', msgs);
	return { step1, step2, step3, step4, cleared: cleared, stored: store[KEY] || '[]' };
}

const src = fs.readFileSync(SMS, 'utf8');
const r = scenario(src);

ok('① 列表刷新（模组全是已读）不应显示未读', r.step1 === 0, '实际 ' + r.step1);
ok('② 新短信推送到达必须显示未读（真未读不能被吞）', r.step2 === 1, '实际 ' + r.step2);
ok('③ 会话处于显示状态时读到它 → 未读清零', r.step3 === 0, '实际 ' + r.step3);
ok('★ ④ 刷新页面后不得再显示未读（用户报障的这一步）', r.step4 === 0,
	'刷新后仍是未读 ' + r.step4 + '，localStorage=' + r.stored);
ok('会话显示时必须存在清未读的调用（否则自动打开的会话读了也不算已读）',
	r.cleared === true, 'renderConversation 里没有 clearUnread(state.selectedContact)');

/* ---------------- 红能力自检：旧写法必须复现同一症状 ---------------- */
const OLD_SRC = src
	.replace(/c\.unreadCount\s*=\s*unreadN\s*\|\|\s*\(\(c\.messages\.length\s*===\s*0\s*&&\s*isUnread\(c\.number\)\)\s*\?\s*1\s*:\s*0\);/,
		'c.unreadCount = unreadN || (isUnread(c.number) ? 1 : 0);')
	.replace(/if \(state\.selectedContact\) clearUnread\(state\.selectedContact\);/, '/* 旧版：会话显示时不清未读 */');
ok('★ 红能力自检：把两处改回旧写法后，本回路必须复现"刷新后仍未读"',
	scenario(OLD_SRC).step4 === 1,
	'旧写法下 step4=' + scenario(OLD_SRC).step4 + '（若为 0，说明这条回路抓不到该 bug）');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
console.log('  序列: ①列表=' + r.step1 + ' ②推送=' + r.step2 + ' ③读到=' + r.step3 + ' ④刷新后=' + r.step4
	+ '  存储=' + r.stored);
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('短信未读刷新回路通过（刷新后不再变回未读）');
