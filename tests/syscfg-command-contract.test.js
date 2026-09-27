#!/usr/bin/env node
/*
 * ^SYSCFGEX 命令构造契约：`Parse.buildSysCfgCommand`。
 *
 * 为什么需要它：这个函数把 `acqorder` / `band` / `lteband` **直接拼进 AT 命令**，
 * 而它们的值来自**模组回读** —— `parseSysCfg` 里 `band` 取自 `([^,]*)`、
 * `lteband` 取自 `([^,\r\n]*)`，**两者都允许含引号**。一个 `"` 就能闭合
 * `<acqorder>` 的字符串参数、把后面的内容改写成新参数。
 * 2.3.84 加了清洗（只剥 `" \r \n`，**不碰逗号分号** —— 因为 `<acqorder>` 语法里
 * 逗号是否带分隔含义无法从手册确证），但当时**只有临时验证**。本文件把它固定下来。
 *
 * 两条守卫方向：
 *   ① **正常值必须逐字符保持原样** —— 清洗不能改变合法输入（否则就是负优化）；
 *   ② **含引号 / 回车的输入必须被剥掉** —— 引号负责"逃出定界符"、回车负责"分帧"。
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

console.log('== ^SYSCFGEX 命令构造（Parse.buildSysCfgCommand）==');
ok('Parse.buildSysCfgCommand 可用', Parse !== null && typeof Parse.buildSysCfgCommand === 'function');
if (!Parse) {
	console.log('\nFAILED 无法加载 parse.js');
	process.exit(1);
}

const j = (s) => JSON.stringify(s);

/* ---------- ① 正常值必须逐字符保持原样（清洗不得改变合法输入） ---------- */
const NORMAL = { acqorder: '080302', band: '3FFFFFFF', roam: '1', srvdomain: '2', lteband: '1E200000095' };
const EXPECT = 'AT^SYSCFGEX="080302",3FFFFFFF,1,2,1E200000095,,';
ok('正常值输出与已知字符串逐字符一致', Parse.buildSysCfgCommand(NORMAL) === EXPECT,
	j(Parse.buildSysCfgCommand(NORMAL)));

/* ---------- ② 引号必须被剥（否则能闭合字符串参数、改写命令结构） ---------- */
const evilOrder = Parse.buildSysCfgCommand({ acqorder: '080302",1,1,1,1', band: 'AA"BB', roam: '1', srvdomain: '2', lteband: 'CC"DD' });
ok('★ <acqorder> 里的引号被剥', evilOrder.indexOf('080302,1,1,1,1') > 0 && evilOrder.indexOf('""') < 0, j(evilOrder));
ok('★ <band> / <lteband> 里的引号被剥', evilOrder.indexOf('AABB') > 0 && evilOrder.indexOf('CCDD') > 0, j(evilOrder));
/* 关键：整个命令的引号必须**恰好一对**（只有 <acqorder> 被引号包裹）——
 * 多出一个就说明注入的引号逃出去了。 */
ok('★ 全命令的引号恰好为一对（只有 <acqorder> 那对；多一个就是注入了）',
	(Parse.buildSysCfgCommand({ acqorder: 'a"b', band: 'c"d', roam: '1', srvdomain: '2', lteband: 'e"f' }).match(/"/g) || []).length === 2,
	j(Parse.buildSysCfgCommand({ acqorder: 'a"b', band: 'c"d', roam: '1', srvdomain: '2', lteband: 'e"f' })));

/* ---------- ③ 回车/换行必须被剥（否则能分帧成第二条命令） ---------- */
const evilNl = Parse.buildSysCfgCommand({ acqorder: '080302\r\nAT^RESET', band: '3FFFFFFF', roam: '1', srvdomain: '2', lteband: 'X\nY' });
ok('★ 回车被剥（无法分帧）', evilNl.indexOf('\r') < 0, j(evilNl));
ok('★ 换行被剥（无法分帧）', evilNl.indexOf('\n') < 0, j(evilNl));
ok('★ 剥掉换行后命令仍是单行', evilNl.split('\n').length === 1, j(evilNl));

/* ---------- ④ roam / srvdomain 走数字兜底（非法值不得原样拼入） ---------- */
const badNums = Parse.buildSysCfgCommand({ acqorder: '080302', band: '3FFFFFFF', roam: 'abc', srvdomain: 'x,9', lteband: '1E200000095' });
ok('roam 非法值 → 默认 1', badNums.indexOf(',1,') > 0, j(badNums));
ok('srvdomain 非法值 → 默认 2（且逗号未被带进命令）', badNums.indexOf(',2,') > 0 && badNums.indexOf('x,9') < 0, j(badNums));

/* ---------- ⑤ 边界：空配置 / 缺字段不得抛异常 ---------- */
ok('空配置不抛异常且给出合法骨架',
	Parse.buildSysCfgCommand({}) === 'AT^SYSCFGEX="",,1,2,,,',
	j(Parse.buildSysCfgCommand({})));
ok('传 null 不抛异常', (function () {
	try { return typeof Parse.buildSysCfgCommand(null) === 'string'; } catch (e) { return false; }
})());
ok('缺 acqorder / lteband 时为空串（不是 undefined 字面量）',
	Parse.buildSysCfgCommand({ roam: '1', srvdomain: '2' }).indexOf('undefined') < 0,
	j(Parse.buildSysCfgCommand({ roam: '1', srvdomain: '2' })));

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
