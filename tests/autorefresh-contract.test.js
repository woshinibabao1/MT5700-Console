#!/usr/bin/env node
/*
 * 自动刷新（Ui.autoRefresh）契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景一：用户要求「网络状态 - 信号质量」的自动刷新**支持自定义间隔**。
 *   原先只有 3/5/10/15/30/60 六个固定档位，想要 20 秒、120 秒都做不到。
 *
 * 背景二：间隔值会直接当 setInterval 的毫秒基数用（network_status.js 的
 *   resetTimers）。落到 0 或负数时，浏览器按 HTML 标准把它钳到 4ms，
 *   「自动刷新」就变成每 4 毫秒打一次串口 —— AT 通道独占，等于把自己打死。
 *   所以自定义间隔**必须钳制**，这是本测试最要紧的一条。
 *
 * 背景三：setInterval() 原来只改内部变量、不通知调用方，定时器根本不会重建。
 *   network_settings.js 的 `neighAr.setInterval(15)` 因此一直是「界面显示
 *   15 秒、实际一次都不跑」。故断言 setInterval/setEnabled 必须回调。
 *
 * 运行：node tests/autorefresh-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'ui.js');
const STATUS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');

const ui = fs.readFileSync(UI, 'utf8');
const statusJs = fs.readFileSync(STATUS, 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}

/* ---------- 1. 自定义入口必须存在 ---------- */

ok('定义了自定义选项的取值', /AR_CUSTOM_VALUE\s*=\s*'custom'/.test(ui));
ok('下拉里有「自定义…」这一项', ui.indexOf('自定义…') >= 0);
ok('自定义用 number 输入框（不是自由文本）', /custom\.type\s*=\s*'number'/.test(ui));
ok('自定义输入框默认隐藏', /custom\.style\.display\s*=\s*'none'/.test(ui));

/* ---------- 2. 间隔必须钳制 ---------- */

const minM = ui.match(/AR_MIN_SEC\s*=\s*(\d+)/);
const maxM = ui.match(/AR_MAX_SEC\s*=\s*(\d+)/);
ok('AR_MIN_SEC 存在且 >= 1（0/负数会被浏览器钳成 4ms）', !!minM && Number(minM[1]) >= 1,
	minM ? '实测 ' + minM[1] : '未找到 AR_MIN_SEC');
ok('AR_MAX_SEC 存在且不超过 86400', !!maxM && Number(maxM[1]) <= 86400,
	maxM ? '实测 ' + maxM[1] : '未找到 AR_MAX_SEC');

/* 把 clampRefreshSec 从源码里抽出来跑真值（与 parse-contract 同一手法），
   这样常量与函数任何一侧被改坏，这里都会红。 */
const clampM = ui.match(/function clampRefreshSec\s*\([^)]*\)\s*\{[\s\S]*?\n\t\}/);
ok('clampRefreshSec 可抽取', !!clampM);
let clamp = null;
if (minM && maxM && clampM) {
	try {
		// eslint-disable-next-line no-eval
		clamp = eval('var AR_MIN_SEC=' + minM[1] + ', AR_MAX_SEC=' + maxM[1] + ';('
			+ clampM[0].replace('function clampRefreshSec', 'function') + ')');
	} catch (e) {
		fails.push('clampRefreshSec 无法 eval: ' + e.message);
	}
}
const MIN = minM ? Number(minM[1]) : -1;
const MAX = maxM ? Number(maxM[1]) : -1;

if (clamp) {
	ok('0 秒 → 钳到下限（否则 setInterval 变 4ms 打爆串口）', clamp(0) === MIN,
		'实测 clamp(0)=' + clamp(0));
	ok('负数 → 钳到下限', clamp(-5) === MIN, '实测 clamp(-5)=' + clamp(-5));
	ok('1 秒 → 钳到下限', clamp(1) === MIN, '实测 clamp(1)=' + clamp(1));
	ok('非数字 → null（不猜值、不改界面）', clamp('abc') === null, '实测 ' + clamp('abc'));
	ok('空串 → null', clamp('') === null, '实测 ' + clamp(''));
	ok('undefined → null', clamp(undefined) === null, '实测 ' + clamp(undefined));
	ok('超长 → 钳到上限', clamp(999999) === MAX, '实测 clamp(999999)=' + clamp(999999));
	ok('合法值原样通过（15 → 15）', clamp(15) === 15, '实测 ' + clamp(15));
	ok('字符串数字也能解析（"20" → 20）', clamp('20') === 20, '实测 ' + clamp('20'));
	ok('下限值本身不被改写', clamp(MIN) === MIN);
	ok('上限值本身不被改写', clamp(MAX) === MAX);
}

/* ---------- 3. setInterval / setEnabled 必须通知调用方 ---------- */

const fnM = ui.match(/api\.autoRefresh = function \(onChange\) \{[\s\S]*?\n\t\};/);
ok('api.autoRefresh 可整体抽取', !!fnM);
const fnSrc = fnM ? fnM[0] : '';

ok('setInterval() 必须触发 onChange（否则定时器不重建）',
	/setInterval:\s*function[\s\S]{0,400}?emit\(\)/.test(fnSrc));
ok('setEnabled() 必须触发 onChange',
	/setEnabled:\s*function[\s\S]{0,300}?emit\(\)/.test(fnSrc));
ok('setInterval() 必须先过 clampRefreshSec 再赋值',
	/setInterval:\s*function[\s\S]{0,300}?clampRefreshSec/.test(fnSrc));
ok('非法间隔必须拒绝而不是照单全收',
	/setInterval:\s*function[\s\S]{0,300}?v == null/.test(fnSrc)
	|| /setInterval:\s*function[\s\S]{0,300}?v === null/.test(fnSrc));

/* ---------- 4. 既有 API 不能被改坏 ---------- */

ok('仍提供 getInterval()', /getInterval:\s*function/.test(fnSrc));
ok('仍提供 isEnabled()', /isEnabled:\s*function/.test(fnSrc));
ok('仍返回 el', /el:\s*wrap/.test(fnSrc));
ok('预设档位仍含 3/5/10/15/30/60',
	/\[3,\s*5,\s*10,\s*15,\s*30,\s*60\]/.test(fnSrc));
ok('network_status.js 仍用 ar.getInterval() 重建定时器',
	statusJs.indexOf('ar.getInterval()') >= 0);
ok('network_status.js 仍用 ar.isEnabled()',
	statusJs.indexOf('ar.isEnabled()') >= 0);

/* ---------- 结果 ---------- */

console.log('自动刷新契约测试：' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
