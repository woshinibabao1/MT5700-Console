#!/usr/bin/env node
/*
 * 跨端 PDU 一致性契约（前端一侧）。
 *
 * 为什么需要它：`parse.js` 与 `pdu.rs` 各有一份 PDU 解码实现，而**各自的测试只守
 * 自己那一侧** —— `tests/sms-pdu.test.js`（92 项）用的是后端样本当输入来验证前端，
 * 所以"两端各自改对、口径却分叉"它一律不会变红。
 *
 * 2026-09-28 的人工核对已查出四处这类漂移：
 *   · unpackSeptets 的「填充位造字」（Rust 修了、前端漏改）
 *   · dcs_encoding 的 0xC/0xE/0xF 组（前端修了、后端漏改）
 *   · decodeAddress 的 BCD 半字节与 TON=1 的 '+'（两头各缺一半）
 *   · decodeTimestamp 的日期进位（前端 Date 进位 vs 后端 chrono 回落）
 *
 * 本测试与 Rust 侧 `pdu.rs` 的 `pdu_共享样本两端一致` **读同一份 fixture**
 * （tests/fixtures/pdu-samples.json），因此任一端分叉都会有一侧判红。
 * 新增样本请改 fixture，两侧自动生效。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures', 'pdu-samples.json');
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
function read(p) {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch (e) {
		return '';
	}
}

console.log('== 跨端 PDU 一致性（前端 parse.js ↔ 共享 fixture）==');

/* 加载 Parse（与其它测试同法） */
let Parse = null;
(function () {
	let src = read(PARSE_JS).replace(/^\s*'require baseclass';\s*$/m, '');
	if (!src) return;
	const sandbox = {
		console, Math, Object, Array, String, Number, Boolean, JSON, Date, RegExp, Error,
		parseInt, parseFloat, isNaN, isFinite, undefined,
		L: { Class: { extend: function (p) { const F = function () {}; Object.assign(F.prototype, p); return F; } } },
		baseclass: function () {},
	};
	try {
		vm.createContext(sandbox);
		const Cls = vm.runInNewContext('(function(){' + src + '})()', sandbox);
		Parse = new Cls();
	} catch (e) {
		Parse = null;
	}
})();

ok('parse.js 里的 Parse 可用', Parse !== null && typeof Parse.decodeIncomingPdu === 'function');

let fix = null;
try {
	fix = JSON.parse(read(FIX));
} catch (e) {
	fix = null;
}
ok('共享 fixture 可读且是合法 JSON', fix !== null && Array.isArray(fix.samples) && fix.samples.length > 0,
	'读不到 ' + FIX + ' —— 后端 pdu.rs 的同名测试也依赖它');

if (Parse && fix && Array.isArray(fix.samples)) {
	fix.samples.forEach(function (s, i) {
		const tag = '样本[' + i + '] ' + (s.name || '(无名)');
		let got = null;
		try {
			got = Parse.decodeIncomingPdu(String(s.hex || ''));
		} catch (e) {
			ok(tag + ' 解码不抛异常', false, String(e && e.message));
			return;
		}
		ok(tag + ' 解码成功', got !== null && typeof got === 'object');
		if (!got) return;

		ok(tag + ' 发送方一致', got.sender === s.sender,
			'期望 ' + JSON.stringify(s.sender) + '，实际 ' + JSON.stringify(got.sender));

		if (typeof s.content === 'string') {
			ok(tag + ' 正文完全一致', got.content === s.content,
				'期望 ' + JSON.stringify(s.content) + '，实际 ' + JSON.stringify(got.content));
		}
		if (typeof s.contentPrefix === 'string') {
			ok(tag + ' 正文以期望前缀开头', typeof got.content === 'string' && got.content.indexOf(s.contentPrefix) === 0,
				'期望以 ' + JSON.stringify(s.contentPrefix) + ' 开头，实际 ' + JSON.stringify(String(got.content).slice(0, 24)));
		}
		if (s.partial) {
			const p = got.partial || {};
			ok(tag + ' 分段信息一致',
				p.reference === s.partial.reference &&
				p.parts_count === s.partial.parts_count &&
				p.part_number === s.partial.part_number,
				'期望 ' + JSON.stringify(s.partial) + '，实际 ' + JSON.stringify(p));
		}
	});
}

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
