#!/usr/bin/env node
'use strict';

/**
 * PIN 锁状态（+CLCK）解析契约测试
 *
 * 守的是 modem_settings.js 里 `AT+CLCK="SC",2` 应答的解析，两个历史坑：
 *
 *   ① 应答不带 facility 时解不出
 *      部分固件直接回 `+CLCK: 0`，里面**没有逗号**；旧正则 /,(\d+)/ 匹配不到，
 *      PIN 锁状态恒为 null（徽章显示「PIN 状态未知」）。
 *
 *   ② 带命令回显时被回显行抢走
 *      串口开了回显的话应答形如 `AT+CLCK="SC",2\r\n+CLCK: 1`，
 *      旧正则第一个命中的是**回显行里的 `,2`**（那是查询参数 2=query），
 *      于是开关状态恒被读成「未启用」—— 界面上 PIN 锁永远显示未启用，
 *      用户点了「启用」之后再点还是「启用」，**永远关不掉**。
 *
 * 只读：不下发任何 AT，只用真实源码里的正则跑静态样本。
 * 用法：node tests/clck-parse-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/modem_settings.js');
const msSrc = fs.readFileSync(MS, 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

/* 取出源码里真实使用的那个正则字面量（不复制粘贴，避免测试与实现各写一份） */
const mLit = msSrc.match(/atText\(res\)\.match\((\/\+CLCK[^\n]*?\/)\)/)
	|| msSrc.match(/\.match\((\/\(\^\|\[\\r\\n\]\)\[ \\t\]\*\\\+CLCK[^\n]*?\/)\)/);
ok('能定位 +CLCK 解析正则', !!mLit, '源码里找不到 +CLCK 解析，测试失效');

let re = null;
if (mLit) {
	try {
		re = eval(mLit[1]); // eslint-disable-line no-eval
	} catch (e) {
		fails.push('正则字面量无法求值 —— ' + e.message);
	}
}
ok('正则字面量可求值', !!re);

function parse(text) {
	if (!re) return null;
	const m = text.match(re);
	if (!m) return 'NO_MATCH';
	/* 兼容两种写法：只有一个捕获组（旧）或「行锚定 + facility」（新取最后一组） */
	return m[m.length - 1];
}

/* ---------- A. 三种真实应答都要解对 ---------- */

ok('标准形式 +CLCK: "SC",0 → 未启用', parse('+CLCK: "SC",0\r\n\r\nOK') === '0',
	'实际 ' + parse('+CLCK: "SC",0\r\n\r\nOK'));
ok('标准形式 +CLCK: "SC",1 → 已启用', parse('+CLCK: "SC",1\r\n\r\nOK') === '1',
	'实际 ' + parse('+CLCK: "SC",1\r\n\r\nOK'));
ok('无 facility：+CLCK: 0（旧正则解不出的那种）', parse('+CLCK: 0\r\n\r\nOK') === '0',
	'实际 ' + parse('+CLCK: 0\r\n\r\nOK'));
ok('无 facility：+CLCK: 1', parse('+CLCK: 1\r\n\r\nOK') === '1',
	'实际 ' + parse('+CLCK: 1\r\n\r\nOK'));

/* ---------- B. 带命令回显时不能被回显行抢走（历史故障主因） ---------- */

ok('★ 带回显时读到的是应答值 1，不是查询参数 2',
	parse('AT+CLCK="SC",2\r\n+CLCK: 1\r\n\r\nOK') === '1',
	'实际 ' + parse('AT+CLCK="SC",2\r\n+CLCK: 1\r\n\r\nOK') + '（读到 2 说明又撞上回显行了）');
ok('★ 带回显且应答为 0 时读到 0（否则 PIN 锁永远关不掉）',
	parse('AT+CLCK="SC",2\r\n+CLCK: 0\r\n\r\nOK') === '0',
	'实际 ' + parse('AT+CLCK="SC",2\r\n+CLCK: 0\r\n\r\nOK'));

/* ---------- C. 异常输入 ---------- */

ok('无效应答不误判（返回 NO_MATCH）', parse('ERROR\r\n') === 'NO_MATCH',
	'实际 ' + parse('ERROR\r\n'));
ok('空应答不误判', parse('') === 'NO_MATCH');

/* ---------- D. 静态约束 ---------- */

ok('★ 不再使用裸 /,(\\d+)/（它既解不出 +CLCK: 0，又会被回显行抢走）',
	!/match\(\/,\(\\d\+\)\/\)/.test(msSrc));
ok('★ 解析正则做行锚定（否则回显行里的 +CLCK= 也会命中）',
	/\(\^\|\[\\r\\n\]\)/.test(mLit ? mLit[1] : ''), mLit ? mLit[1] : '');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('PIN 锁状态解析契约测试全部通过');
