#!/usr/bin/env node
/*
 * 注册态解析契约：`Parse.parseRegStat`。
 *
 * 为什么需要它：这个函数把调用方给的 `prefix` **拼进正则**，而它是**导出的**
 * （`api.parseRegStat`），调用方可传任意字符串。旧写法是
 *     new RegExp('\\' + prefix + ':\\s*([^\\r\\n]*)')
 * —— 只给 prefix 的**第一个**字符加了反斜杠，其余位置的 `.` `*` `(` `[`
 * 仍是正则元字符，匹配范围会悄悄变宽（传 '+C.REG' 会连 '+CXREG' 一起命中）。
 * 2.3.84 改成全量转义，但当时**只有临时验证**。本文件把它固定下来。
 *
 * 两条守卫方向：
 *   ① **既有的三个调用方（字面常量）行为必须不变** —— `+CREG` / `+C5GREG` / `+CEREG`
 *      转义前后结果相同，否则就是负优化；
 *   ② **元字符 prefix 不得放宽匹配范围** —— 这是修复本身的判据。
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

console.log('== 注册态解析（Parse.parseRegStat）==');
ok('Parse.parseRegStat 可用', Parse !== null && typeof Parse.parseRegStat === 'function');
if (!Parse) {
	console.log('\nFAILED 无法加载 parse.js');
	process.exit(1);
}
const j = (x) => JSON.stringify(x);

/* ---------- ① 既有三个调用方的行为（转义前后必须一致） ---------- */
const creg = Parse.parseRegStat('+CREG: 0,1', '+CREG');
ok("'+CREG' 解析出 stat=1", creg && creg.stat === 1, j(creg));
ok("'+CREG' 表内值给出中文文案", creg && creg.statText === '已注册', j(creg));

const c5g = Parse.parseRegStat('+C5GREG: 2,5', '+C5GREG');
ok("'+C5GREG' 解析出 stat=5（已注册漫游）", c5g && c5g.stat === 5 && c5g.statText === '已注册（漫游）', j(c5g));

const cereg = Parse.parseRegStat('+CEREG: 2,1,"1234","AB",7', '+CEREG');
ok("'+CEREG' 带引号字段也能解析出 stat=1", cereg && cereg.stat === 1, j(cereg));

ok('表外 stat 原样显示编号', (function () {
	const r = Parse.parseRegStat('+CREG: 0,99', '+CREG');
	return r && r.stat === 99 && r.statText === '状态 99';
})(), j(Parse.parseRegStat('+CREG: 0,99', '+CREG')));

/* ---------- ② ★ 元字符 prefix 不得放宽匹配范围 ---------- */
ok("★ 元字符 prefix '+C.REG' 不得误匹配 '+CXREG'",
	Parse.parseRegStat('+CXREG: 2,1', '+C.REG') === null,
	j(Parse.parseRegStat('+CXREG: 2,1', '+C.REG')) + ' —— 旧的 \'\\\\\'+prefix 只转义首字符，这里会误命中');

ok("★ 元字符 prefix '+C.REG' 仍能匹配它自己",
	(function () { const r = Parse.parseRegStat('+C.REG: 2,1', '+C.REG'); return r && r.stat === 1; })(),
	j(Parse.parseRegStat('+C.REG: 2,1', '+C.REG')));

/* 逐个元字符：都不能把后面的字面量当通配符 */
const META = ['.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '^', '$'];
META.forEach(function (m) {
	const p = '+C' + m + 'REG';
	/* prefix 里含元字符时，对「把该元字符换成一个别的字符」的输入**不应**命中 */
	const other = '+C' + 'X' + 'REG';
	const hit = Parse.parseRegStat(other + ': 2,1', p);
	ok("元字符 '" + m + "' 不得被当通配符", hit === null,
		'parseRegStat(' + j(other) + ', ' + j(p) + ') = ' + j(hit));
});

/* ---------- ③ 边界：不抛异常 ---------- */
ok('无匹配 → null', Parse.parseRegStat('OK', '+CREG') === null);
ok('传 null / undefined 不抛异常且返回 null',
	Parse.parseRegStat(null, '+CREG') === null && Parse.parseRegStat(undefined, '+CREG') === null);
/*
 * prefix 为 null / 空串时只要求「不抛异常」。
 *
 * **不断言返回 null**：esc 为空串时正则退化成 `:\s*([^\r\n]*)`，它会匹配**任意含冒号的行**
 * （例如 '+CREG: 0,1' 仍能解出 stat=1）。这是"调用方不该传空 prefix"的隐含前提，
 * 现有三个调用方传的都是字面常量，所以不影响生产；但把它写清楚，免得后来人以为
 * 传空会安全地返回 null。加断言只会把错误预期固化。
 */
ok('prefix 为 null / 空串不抛异常', (function () {
	try {
		Parse.parseRegStat('+CREG: 0,1', null);
		Parse.parseRegStat('+CREG: 0,1', '');
		return true;
	} catch (e) {
		return false;
	}
})(), '抛异常了');
ok('stat 非数字 → null', Parse.parseRegStat('+CREG: 0,x', '+CREG') === null);

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
