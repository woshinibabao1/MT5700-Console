#!/usr/bin/env node
/*
 * 频点换算契约：`Parse.arfcnToBand` 与 `Parse.nrArfcnToMHz`。
 *
 * 为什么需要它：`arfcnToBand` 被 `network_settings.js` 三处调用（锁频/邻区/小区列表都要
 * 显示频段号），但**此前没有任何测试覆盖它** —— 也就是说"频段显示对不对"一直无人把关。
 *
 * 其中最容易错的一处是 **n77 与 n78 重叠**（3GPP 既成事实）：
 *   n77 = 3300–4200 MHz → ARFCN 620000–680000
 *   n78 = 3300–3800 MHz → ARFCN 620000–653333（n78 ⊂ n77）
 * 单凭 ARFCN 无法区分，只能取舍。本测试把取舍**钉死**：优先 n78（中国/欧洲 3.5 GHz 主力）。
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
	};
	try {
		vm.createContext(sandbox);
		Parse = new (vm.runInNewContext('(function(){' + src + '})()', sandbox))();
	} catch (e) {
		Parse = null;
	}
})();

console.log('== 频点换算（ARFCN → 频段 / MHz）==');
ok('Parse.arfcnToBand 可用', Parse !== null && typeof Parse.arfcnToBand === 'function');
ok('Parse.nrArfcnToMHz 可用', Parse !== null && typeof Parse.nrArfcnToMHz === 'function');
if (!Parse) {
	console.log('\nFAILED 无法加载 parse.js');
	process.exit(1);
}

/* NR：重叠区的取舍 */
ok('n78 重叠区判成 n78（不是 n77）', Parse.arfcnToBand('NR', 630000) === 78,
	'实际 ' + Parse.arfcnToBand('NR', 630000) + ' —— n78 是中国/欧洲 3.5GHz 主力，必须优先');
ok('n78 下边界 620000 判成 n78', Parse.arfcnToBand('NR', 620000) === 78);
ok('n78 上边界 653333 判成 n78', Parse.arfcnToBand('NR', 653333) === 78);
ok('n77 独有区间 670000 判成 n77', Parse.arfcnToBand('NR', 670000) === 77);
ok('n79 判成 n79', Parse.arfcnToBand('NR', 700000) === 79);
ok('n41 判成 n41', Parse.arfcnToBand('NR', 520000) === 41);
ok('n28 判成 n28', Parse.arfcnToBand('NR', 155000) === 28);
ok('表外判 null（不猜）', Parse.arfcnToBand('NR', 100000) === null);
ok('非数字判 null', Parse.arfcnToBand('NR', 'abc') === null);

/* LTE */
ok('LTE band 1', Parse.arfcnToBand('LTE', 300) === 1);
ok('LTE band 41 上边界 41589', Parse.arfcnToBand('LTE', 41589) === 41);
ok('LTE 表外判 null', Parse.arfcnToBand('LTE', 100000) === null);

/* NR-ARFCN → MHz（3GPP TS 38.104 全局栅格） */
ok('nrArfcnToMHz：620000 → 3300 MHz', Parse.nrArfcnToMHz(620000) === 3300);
ok('nrArfcnToMHz：600000 → 3000 MHz（两段衔接点）', Parse.nrArfcnToMHz(600000) === 3000);
ok('nrArfcnToMHz：599999 略小于 3000（5kHz 步进段）',
	Math.abs(Parse.nrArfcnToMHz(599999) - 2999.995) < 1e-6,
	'实际 ' + Parse.nrArfcnToMHz(599999));
ok('nrArfcnToMHz：680000 → 4200 MHz', Parse.nrArfcnToMHz(680000) === 4200);
ok('nrArfcnToMHz：非正数/非数字判 null',
	Parse.nrArfcnToMHz(0) === null && Parse.nrArfcnToMHz(-1) === null && Parse.nrArfcnToMHz('x') === null);

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
