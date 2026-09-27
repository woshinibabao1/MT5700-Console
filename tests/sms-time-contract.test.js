#!/usr/bin/env node
/*
 * 短信时间契约：`Parse.parseMessageTime` 与 `Parse.formatPDUTime`。
 *
 * 为什么需要它：`parseMessageTime` 原先直接 `new Date(y, m-1, d, …)` 构造，
 * 而 **JS 的 Date 会自动进位**（`26/02/31` → `2026-03-03`）。2.3.78 修
 * `decodeTimestamp`（PDU 的 SCTS 解析）时漏了这一处，2.3.86 才补上 ——
 * 但那次只做了**临时验证**、没留下持久守卫，本文件把它补上。
 *
 * 触发路径真实：本函数会解析**用户导入文件**里的 `time` 字段
 * （`sms_settings.js` 的「导入记录」只校验 `typeof m.time === 'string'`，
 * **不校验日期合法性**），畸形日期会被渲染成一个看似合理的错误日期 ——
 * 比显示"读不到"更容易误导。
 *
 * 另一条守卫方向：`formatPDUTime` 与 `parseMessageTime` 是**一对反函数**
 * （前者产 `YY/MM/DD,HH:MM:SS`，后者解它），必须能往返。
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

console.log('== 短信时间契约 ==');
ok('Parse.parseMessageTime / formatPDUTime 可用',
	Parse !== null && typeof Parse.parseMessageTime === 'function' && typeof Parse.formatPDUTime === 'function');
if (!Parse) {
	console.log('\nFAILED 无法加载 parse.js');
	process.exit(1);
}

const fmt = function (d) {
	return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
		' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') +
		':' + String(d.getSeconds()).padStart(2, '0');
};
/*
 * 「回落到当前时间」的判据。
 *
 * ★ 2026-09-28 改：原来只比对**年月日**（isToday），而「不回落」的情况也可能满足它 ——
 *   只要运行当天恰好等于用例里的日期（如 `26/09/28` 在 2026-09-28 跑）。
 *   实测：`12:60:00` 那条在 +0800 下误判为通过、在 CI 的 UTC 下判红，来回摇摆。
 *   现在要求「确实是刚刚」（与 now 相差 < 5 秒），既能容忍跨秒抖动，又能真正区分
 *   「回落」与「返回了那个进位后的畸形时间」。
 */
function isNow(d) {
	return Math.abs(d.getTime() - Date.now()) < 5000;
}

/* ---------- 合法日期：必须逐字保留 ---------- */
ok('合法 26/09/28,12:34:56 原样保留',
	fmt(Parse.parseMessageTime('26/09/28,12:34:56')) === '2026-09-28 12:34:56',
	fmt(Parse.parseMessageTime('26/09/28,12:34:56')));

/* ---------- ★ 核心：不存在的日期不得静默进位 ---------- */
const feb31 = Parse.parseMessageTime('26/02/31,12:00:00');
ok('★ 26/02/31 必须回落（不得进位成 2026-03-03）', isNow(feb31),
	'实际 ' + fmt(feb31) + ' —— 进位后是"看起来完全正常"的错误日期，比读不到更误导');

ok('26/04/31（4 月无 31 日）回落', isNow(Parse.parseMessageTime('26/04/31,00:00:00')),
	fmt(Parse.parseMessageTime('26/04/31,00:00:00')));

ok('26/13/01（月越界）回落', isNow(Parse.parseMessageTime('26/13/01,00:00:00')));
ok('26/00/10（月为 0）回落', isNow(Parse.parseMessageTime('26/00/10,00:00:00')));

/* ---------- 闰年边界：这是"回读校验"最容易做错的地方 ---------- */
ok('24/02/29 保留（2024 是闰年）',
	fmt(Parse.parseMessageTime('24/02/29,08:00:00')) === '2024-02-29 08:00:00',
	fmt(Parse.parseMessageTime('24/02/29,08:00:00')));
ok('23/02/29 回落（2023 不是闰年）', isNow(Parse.parseMessageTime('23/02/29,08:00:00')),
	fmt(Parse.parseMessageTime('23/02/29,08:00:00')));
ok('00/02/29 保留（2000 是闰年，能被 400 整除）',
	fmt(Parse.parseMessageTime('00/02/29,08:00:00')) === '2000-02-29 08:00:00');

/* ---------- 时分秒越界 ---------- */
ok('24:00:00 回落', isNow(Parse.parseMessageTime('26/09/28,24:00:00')));
ok('12:60:00 回落', isNow(Parse.parseMessageTime('26/09/28,12:60:00')));

/* ---------- 与 formatPDUTime 的往返（一对反函数） ---------- */
const d = new Date(2026, 8, 28, 12, 34, 56); /* 2026-09-28 12:34:56 */
const s = Parse.formatPDUTime(d);
ok('formatPDUTime 产出 YY/MM/DD,HH:MM:SS 形态', /^\d{2}\/\d{2}\/\d{2},\d{2}:\d{2}:\d{2}$/.test(s), s);
ok('formatPDUTime → parseMessageTime 往返一致',
	Parse.parseMessageTime(s).getTime() === d.getTime(),
	s + ' → ' + fmt(Parse.parseMessageTime(s)));

const d2 = new Date(2024, 1, 29, 0, 0, 1); /* 闰日 */
ok('闰日往返一致', Parse.parseMessageTime(Parse.formatPDUTime(d2)).getTime() === d2.getTime(),
	Parse.formatPDUTime(d2));

/* ---------- 边界输入：不抛异常 ---------- */
ok('null / 空串 → 当前时间（不抛）',
	isNow(Parse.parseMessageTime(null)) && isNow(Parse.parseMessageTime('')));
ok('无法识别的串 → 当前时间（不抛）', isNow(Parse.parseMessageTime('这不是时间')));
ok('ISO 串仍走 Date 兜底', Parse.parseMessageTime('2026-09-28T12:34:56').getFullYear() === 2026);

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
