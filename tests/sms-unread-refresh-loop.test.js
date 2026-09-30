#!/usr/bin/env node
'use strict';

/*
 * 短信"已读刷新后又变未读"——诊断回路（diagnosing-bugs Phase 1/5）
 * ===========================================================================
 * 真机探针（2026-09-30，设备 192.168.10.1，带 [DEBUG-7f3a] 的线上文件）抓到的调用栈：
 *
 *   push num=10086 watching=false sel=-
 *   markUnread 10086 inList=false stack= at newSmsHandler (:1236) | at ATClient.emitPush(…)
 *   markUnread 10086 inList=true  stack= at buildContacts  (:637)
 *   build num=10086 unreadN=1 inList=true msgs=5 -> count=1
 *
 *   同时设备审计：+CPMS 仍是 35/50、AT+CMGL=0 为空 ⇒ **模组侧没有未读，也没有新短信**
 *   ⇒ 每次页面加载都会**重放旧的 +CMTI 推送**，把那条旧消息标成 unread=true，
 *     再由 buildContacts 算成"未读" → 徽章复现。
 *
 * 本回路把 sms_center.js 里真正决定未读的代码**抽出来跑**（同一份源码文本，不另写模型）：
 *   · unreadNumbers 初始化 IIFE / markUnread / clearUnread / isUnread / saveUnread
 *   · buildContacts 里那句 c.unreadCount = … 表达式
 *   · 推送路径里真实的两行（msg.unread = !watching / if (!watching) markUnread(msg.number)）
 *   · 未读判定函数 isMsgUnread（水位线修复后才有；旧版没有 → 回退为 m.unread）
 *
 * 两个场景：
 *   场景一（名单语义）：列表刷新 → 推送 → 读到 → 刷新，断言不再未读
 *   场景二（真机机制）：**重放一条旧推送** → 重建，断言"用户早已读过的那条"不得变未读  ← 本次判红点
 *
 * 用法：node tests/sms-unread-refresh-loop.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SMS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');
const KEY = 'mt5700_sms_unread_numbers';
const READ_UPTO_KEY = 'mt5700_sms_read_upto';

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name);
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}
function extractVarIife(s, name) {
	const marker = 'var ' + name + ' = (function () {';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到 ' + name + ' 初始化');
	let depth = 0, begun = false;
	for (let i = s.indexOf('{', start); i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1) + ')();'; }
	}
	throw new Error(name + ' 初始化括号未配平');
}
function extractCountExpr(s) {
	const re = /c\.unreadCount\s*=\s*([^;]+);/g;
	let m, found = null;
	while ((m = re.exec(s)) !== null) { if (/unreadN/.test(m[1])) found = m[1]; }
	if (!found) throw new Error('找不到 unreadCount 计算式');
	return found;
}
/* 推送路径里真实的两行（真机栈指向 newSmsHandler） */
function extractPushLines(s) {
	const a = 'msg.unread = !watching;';
	const b = 'if (!watching) markUnread(msg.number);';
	if (s.indexOf(a) < 0) throw new Error('推送路径里找不到 `' + a + '`（改名了？）');
	return a + '\n' + (s.indexOf(b) >= 0 ? b : '');
}
function extractClearOnRender(s) {
	const m = extractFn(s, 'renderConversation').match(/clearUnread\(state\.selectedContact\)/);
	return m ? m[0] : null;
}

/* 极简时间解析：'26/09/30,19:53:50' → **Date**（与解析真契约一致：调用处是 .getTime()） */
function parseMessageTime(t) {
	const m = String(t || '').match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
	if (!m) return null;
	return new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/*
 * ★ 夹具时间必须**相对当前时刻推导**，不能写死字面量（2026-09-30 CI 上摔过）：
 *   写死 '26/09/30,19:53:50' 时，本地（CST/UTC+8）解析成"过去"，而 CI 在 **UTC** 下
 *   同一字符串按本地解析就成了"未来"（CI 13:42Z < 19:53Z），水位线比较随之判成未读
 *   → 只有依赖"消息时间早于水位线"的那条断言判红，本地却全绿。
 *   用 now 的偏移量就与时区无关。
 */
function fmtLocal(t) {
	const p = n => String(n).padStart(2, '0');
	return p(t.getFullYear() % 100) + '/' + p(t.getMonth() + 1) + '/' + p(t.getDate()) + ','
		+ p(t.getHours()) + ':' + p(t.getMinutes()) + ':' + p(t.getSeconds());
}
const NOW = Date.now();
const T_OLD = fmtLocal(new Date(NOW - 2 * 3600e3));   // 2 小时前：用户早已读过
const T_NEW = fmtLocal(new Date(NOW + 60e3));         // 后于"读"的时刻：真·新到

/* 夹具自守：T_OLD 必须真的早于现在，否则本回路会变成时区相关的假绿/假红 */
if (!(parseMessageTime(T_OLD).getTime() < NOW)) {
	console.log('  ✗ 夹具时间异常：T_OLD 不在过去（时区/时钟问题），本回路不可信');
	process.exit(1);
}

function makePage(src, store) {
	const localStorage = {
		getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
		setItem: (k, v) => { store[k] = String(v); }
	};
	const normalizeNumber = n => String(n == null ? '' : n).replace(/[^\d]/g, '');
	const Parse = { parseMessageTime: parseMessageTime };
	const state = { contacts: [], selectedContact: null };
	/* 水位线相关（修复后源码里才有；旧版没有则整体回退） */
	let readUptoOf = () => 0, markReadUpto = () => {};
	let hasWatermark = false;
	try {
		const wm = new Function('localStorage', 'normalizeNumber', 'Parse', 'Date',
			'var READ_UPTO_KEY = ' + JSON.stringify(READ_UPTO_KEY) + ';' +
			extractVarIife(src, 'readUptoMap') + '\n' +
			extractFn(src, 'readUptoOf') + '\n' + extractFn(src, 'markReadUpto') + '\n' +
			'return { readUptoOf: readUptoOf, markReadUpto: markReadUpto };')(localStorage, normalizeNumber, Parse, Date);
		readUptoOf = wm.readUptoOf; markReadUpto = wm.markReadUpto; hasWatermark = true;
	} catch (e) { /* 旧版无水位线 */ }
	const code = [
		'return (function () {',
		'  var UNREAD_KEY = ' + JSON.stringify(KEY) + ';',
		'  ' + extractVarIife(src, 'unreadNumbers'),
		'  ' + extractFn(src, 'saveUnread'),
		'  ' + extractFn(src, 'markUnread'),
		'  ' + extractFn(src, 'clearUnread'),
		'  ' + extractFn(src, 'isUnread'),
		'  return { markUnread: markUnread, clearUnread: clearUnread, isUnread: isUnread,',
		'           list: function () { return unreadNumbers.slice(); } };',
		'})();'
	].join('\n');
	const api = new Function('localStorage', 'normalizeNumber', 'state', 'markReadUpto', 'Date',
		code.replace('saveUnread();\n\t\t\t/*', 'saveUnread(); markReadUpto(num); /*'))(
		localStorage, normalizeNumber, state, markReadUpto, Date);
	/* 未读判定：优先用源码里的 isMsgUnread（水位线语义），旧版回退为 m.unread */
	let isMsgUnread;
	try {
		isMsgUnread = new Function('readUptoOf', 'Parse', extractFn(src, 'isMsgUnread') + '\nreturn isMsgUnread;')(readUptoOf, Parse);
	} catch (e) {
		isMsgUnread = function (c, m) { return !!(m && m.unread); };
	}
	const countExpr = extractCountExpr(src);
	const countOf = new Function('unreadN', 'c', 'isUnread', 'return (' + countExpr + ');');
	return {
		api: api, state: state, hasWatermark: hasWatermark,
		countOf: function (number, messages) {
			const c = { number: number, messages: messages };
			let unreadN = 0;
			for (let i = 0; i < messages.length; i++) if (isMsgUnread(c, messages[i])) unreadN++;
			return countOf(unreadN, c, api.isUnread);
		},
		clearOnRender: extractClearOnRender(src),
		readWhileWatching: function (number) {
			if (!this.clearOnRender) return false;
			this.state.selectedContact = number;
			new Function('state', 'clearUnread', 'return ' + this.clearOnRender + ';')(this.state, api.clearUnread);
			return true;
		}
	};
}

const src = fs.readFileSync(SMS, 'utf8');

/* ---------------- 场景一：名单语义 ---------------- */
function scenario(src) {
	const store = {};
	let page = makePage(src, store);
	const msgs = [{ unread: false, content: '【订购成功提醒】…', time: T_OLD }];
	const step1 = page.countOf('10086', msgs);
	page.api.markUnread('10086');
	const step2 = page.countOf('10086', msgs.concat([{ unread: true, content: '新短信', time: T_NEW }]));
	page.readWhileWatching('10086');
	const step3 = page.countOf('10086', msgs);
	page = makePage(src, store);
	const step4 = page.countOf('10086', msgs);
	return { step1, step2, step3, step4, stored: store[KEY] || '[]' };
}

/* ---------------- 场景二：重放旧推送（真机探针确认的机制）---------------- */
function scenarioReplayPush(src) {
	const store = {};
	let page = makePage(src, store);
	const msgs = [
		{ unread: false, content: '较早的一条', time: T_OLD },
		{ unread: false, content: '【订购成功提醒】…', time: T_OLD }
	];
	/* 用户打开会话把这条读了 */
	page.readWhileWatching('10086');
	page.api.clearUnread('10086');
	/* 刷新页面：重放一条【旧】推送（时间 19:53:50，用户早已读过） */
	page = makePage(src, store);
	const pushed = { number: '10086', content: '【订购成功提醒】…', time: T_OLD, unread: false };
	const watching = false;
	new Function('msg', 'watching', 'markUnread', extractPushLines(src))(pushed, watching, page.api.markUnread);
	return page.countOf('10086', msgs.concat([pushed]));
}

const r = scenario(src);
const replay = scenarioReplayPush(src);

ok('① 列表刷新（模组全是已读）不应显示未读', r.step1 === 0, '实际 ' + r.step1);
ok('② 新短信推送到达必须显示未读（真未读不能被吞）', r.step2 === 1, '实际 ' + r.step2);
ok('③ 会话处于显示状态时读到它 → 未读清零', r.step3 === 0, '实际 ' + r.step3);
ok('★ ④ 刷新页面后不得再显示未读', r.step4 === 0, '刷新后仍未读 ' + r.step4 + '，localStorage=' + r.stored);
ok('会话显示时必须存在清未读的调用', extractClearOnRender(src) !== null, 'renderConversation 里没有 clearUnread');
ok('★ ⑤ 重放【旧的】推送不得把用户早已读过的那条标成未读（真机机制，探针确认）',
	replay === 0, '重放旧推送后 count=' + replay + '（真机实测就是这里变成 1）');

/* ---------------- 红能力自检：旧写法必须复现同一症状 ---------------- */
const OLD_SRC = src
	.replace(/c\.unreadCount\s*=\s*unreadN\s*\|\|\s*\(\(c\.messages\.length\s*===\s*0\s*&&\s*isUnread\(c\.number\)\)\s*\?\s*1\s*:\s*0\);/,
		'c.unreadCount = unreadN || (isUnread(c.number) ? 1 : 0);')
	.replace(/if \(state\.selectedContact\) clearUnread\(state\.selectedContact\);/, '/* 旧版：会话显示时不清未读 */');
ok('★ 红能力自检：把会话即已读改回旧写法 → 场景一必须复现"刷新后仍未读"',
	scenario(OLD_SRC).step4 === 1, '旧写法 step4=' + scenario(OLD_SRC).step4);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
console.log('  场景一: ①列表=' + r.step1 + ' ②推送=' + r.step2 + ' ③读到=' + r.step3 + ' ④刷新后=' + r.step4
	+ '  存储=' + r.stored);
console.log('  场景二: 重放旧推送后 count=' + replay + '（水位线修复后应为 0）  水位线函数存在=' + makePage(src, {}).hasWatermark);
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('短信未读刷新回路通过（含重放旧推送场景）');
