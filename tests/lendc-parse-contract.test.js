#!/usr/bin/env node
/*
 * ^LENDC 解析契约：`Parse.parseLendc`。
 *
 * 为什么需要它：手册 11.7.1 的 ^LENDC 有**两种字段数不同**的应答 ——
 *     AT^LENDC?  查询 → <enable>,<endc_available>,<endc_plmn_available>,
 *                        <endc_restricted>,<nr_pscell>            （5 段）
 *     URC 主动上报    → <endc_available>,<endc_plmn_available>,
 *                        <endc_restricted>,<nr_pscell>            （4 段）
 * 所以"段数 ≥ 5 就跳过 <enable>"这一步本身是对的。
 *
 * **但它此前是靠「把每段转成 Number 之后再数长度」来判段数的** —— 而 `Number('')`
 * 是 **0** 而不是 `NaN`，于是**未上报的字段被当成数值 0**：
 *     `^LENDC: 0,1,1,,1`（<endc_restricted> 为空）
 *   → 旧实现判出 `restricted === true`，把「没上报」读成了一个**确定结论**。
 * 这与本项目在 parseRejInfo / parseCsDomain 里立的规矩相反（解析不出来应当 → null，
 * 不许按乐观值补齐）。
 *
 * 真机实测（2026-09-28，192.168.10.1，MT5700M-CN）：
 *     AT^LENDC?  → "^LENDC: 1,0,0,0,0"      （确证查询应答是 5 段）
 *     AT^LENDC=? → "^LENDC: (0,1)"
 * 注意：真机这两条样本**新旧实现结果相同** —— 本测试守的是"未上报字段"那条路径，
 * 它当前未被真机触发（字段都非空），属于防回归而非修复已发生的故障。
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
		/* parseCHIPTEMP 依赖它；本文件用不到，但加载模块时必须存在 */
		AtWs: { parseTemperature: function (v) { return Number(v); } },
	};
	try {
		vm.createContext(sandbox);
		Parse = new (vm.runInNewContext('(function(){' + src + '})()', sandbox))();
	} catch (e) {
		Parse = null;
	}
})();

console.log('== ^LENDC 解析（Parse.parseLendc）==');
ok('Parse.parseLendc 可用', Parse !== null && typeof Parse.parseLendc === 'function');
if (!Parse) {
	console.log('\nFAILED 无法加载 parse.js');
	process.exit(1);
}

const j = (x) => JSON.stringify(x);

/* ---------- 真机样本：查询应答 5 段，第一段 <enable> 必须被跳过 ---------- */
const real = Parse.parseLendc('^LENDC: 1,0,0,0,0\r\nOK');
ok('真机样本 5 段：跳过 <enable>（available=false，不是 true）',
	real && real.available === false,
	'real=' + j(real) + ' —— 若为 true 说明把 <enable>=1 当成了 <endc_available>');
ok('真机样本：plmnAvailable=false', real && real.plmnAvailable === false, j(real));
ok('真机样本：restricted=true（<endc_restricted>=0）', real && real.restricted === true, j(real));
ok('真机样本：established=false（<nr_pscell>=0）', real && real.established === false, j(real));

/* ---------- URC 形态：4 段，不跳过 ---------- */
const urc = Parse.parseLendc('^LENDC: 1,1,0,1');
ok('URC 4 段：不跳过（available=true）', urc && urc.available === true, j(urc));
ok('URC 4 段：plmnAvailable=true', urc && urc.plmnAvailable === true, j(urc));
ok('URC 4 段：established=true', urc && urc.established === true, j(urc));

/* ---------- ★ 核心：未上报字段不得被当成 0 ---------- */
const blankMid = Parse.parseLendc('^LENDC: 0,1,1,,1');
ok('★ <endc_restricted> 为空时 restricted 必须为 false（不得把「未上报」读成 0）',
	blankMid && blankMid.restricted === false,
	'blankMid=' + j(blankMid) + ' —— 旧实现此处为 true，因为 Number("") === 0');
ok('★ 同一条里其余字段仍要正确（available/plmnAvailable/established 均 true）',
	blankMid && blankMid.available === true && blankMid.plmnAvailable === true && blankMid.established === true,
	j(blankMid));

const blankHead = Parse.parseLendc('^LENDC: 0,,1,0,1');
ok('★ <endc_available> 为空时 available 必须为 false（同样不得当 0 后判为「是」）',
	blankHead && blankHead.available === false, j(blankHead));

const blankTail = Parse.parseLendc('^LENDC: 0,1,1,0,');
ok('尾字段为空时不影响前面（established=false）', blankTail && blankTail.established === false, j(blankTail));

/* ---------- 边界 ---------- */
ok('无匹配 → null', Parse.parseLendc('OK') === null && Parse.parseLendc('') === null);
ok('传 null / undefined 不抛异常且返回 null',
	Parse.parseLendc(null) === null && Parse.parseLendc(undefined) === null);
ok('字段不足 4 段 → null', Parse.parseLendc('^LENDC: 1,0,0') === null);
ok('全为 1 的 5 段：跳过 <enable> 后四项都为 true',
	(function () { const r = Parse.parseLendc('^LENDC: 1,1,1,1,1'); return r.available === true && r.plmnAvailable === true && r.established === true && r.restricted === false; })(),
	'<endc_restricted>=1 表示 not restricted，故 restricted 应为 false');

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
