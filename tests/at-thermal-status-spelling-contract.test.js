#!/usr/bin/env node
'use strict';

/*
 * AT 指令拼写契约（真机实证）：温度保护状态查询必须是 AT^THERMLDAUTOSTATUS?
 * ---------------------------------------------------------------------------
 * 起因（2026-09-30 真机实测，非推断）：
 *   同一个模组的同一条查询，在两个同源项目里写法不同 ——
 *     · 本项目 modem_settings.js：`AT^THERMLDAUTOSTATUS?`
 *     · FAN789/luci-app-mt5700m  mt5700m-at:816：`AT^THERMLDAUTOSTAT?`（少一个 US）
 *   在 MT5700M-CN（Revision V200R001C20B025）上逐条实测：
 *
 *     $ ubus call mt5700 at '{"cmd":"AT^THERMLDAUTOSTAT?"}'
 *     {"data":null,"error":"ERROR","success":false}
 *     $ ubus call mt5700 at '{"cmd":"AT^THERMLDAUTOSTATUS?"}'
 *     {"data":"^THERMLDAUTOSTATUS: 1, 0, 0, 0, 0, 0, 11\r\nOK","success":true}
 *
 *   ⇒ 本项目是对的，参考实现那条必然失效。这条契约把它钉住：
 *     以后若有人"照抄上游"或"顺手简化拼写"，本测试立刻判红并给出真机证据。
 *
 * 判据：
 *   ① 生产代码里必须存在 `AT^THERMLDAUTOSTATUS?`（前端发送侧）；
 *   ② 解析侧要按 `^THERMLDAUTOSTATUS:` 取字段；
 *   ③ 生产代码里**不得**出现少 US 的错误拼写 `AT^THERMLDAUTOSTAT?`。
 * 反向自检：判据必须能分辨两者（错误拼写要被抓到、正确拼写**不能**被误判），
 *   否则整条测试等于恒绿。
 *
 * 用法：node tests/at-thermal-status-spelling-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* 生产代码：只扫会随固件下发的目录（tests/ 与 tools/ 不算生产代码） */
const PROD_DIRS = ['htdocs', 'root', 'src'];
const SKIP_DIRS = ['node_modules', '.git', 'target', 'dist'];
const EXTS = ['.js', '.uc', '.rs', '.sh', '.json'];

function walk(dir, out) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return out;   /* 目录不存在就跳过 */
	}
	names.forEach(function (name) {
		if (SKIP_DIRS.indexOf(name) >= 0) return;
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) { walk(p, out); return; }
		if (EXTS.indexOf(path.extname(name).toLowerCase()) >= 0) out.push(p);
	});
	return out;
}

const files = [];
PROD_DIRS.forEach(function (d) { walk(path.join(ROOT, d), files); });

/*
 * ★ 2026-09-30 修正：这里原先写死 `files.length > 50` 当"没哑火"的反向自检，
 *   结果 **CI 上只扫到 38 个文件**（本地工作树 >50）→ 假红，contract-check 的
 *   「跑全部契约测试」整步挂掉。数量阈值本质上依赖检出环境（actions/checkout 的
 *   文件集与本地工作树可以不同），属于**环境相关的断言** —— 与本仓反复防的
 *   「守卫恒绿」是同一类错误的镜像。
 *   改为本仓既有惯例（见 assert-signature-contract / undefined-fn-contract）：
 *   钉住**必须扫到的具体文件**，路径写错或目录名改了才判红，与文件总数无关。
 */
const MUST_SCAN = [
	'htdocs/luci-static/resources/view/at-webserver/modem_settings.js'
];
const scanned = new Set(files.map(function (p) {
	return path.relative(ROOT, p).split(path.sep).join('/');
}));
const notScanned = MUST_SCAN.filter(function (n) { return !scanned.has(n); });
ok('扫到了必须覆盖的生产文件（路径写错会让本测试恒绿）', notScanned.length === 0,
	'没扫到：' + notScanned.join('、'));

/* 反向自检：缺文件检测逻辑真的有效（拿一个必然不存在的路径试，恰好缺 1 个） */
ok('★ 反向自检：缺文件检测有效（不是恒绿）',
	MUST_SCAN.concat(['htdocs/__definitely_missing__.js']).filter(function (n) {
		return !scanned.has(n);
	}).length === 1);

const WRONG = /AT\^THERMLDAUTOSTAT\?/;          /* 少一个 US —— 真机回 ERROR */
const RIGHT = /AT\^THERMLDAUTOSTATUS\?/;        /* 真机回 ^THERMLDAUTOSTATUS: … */
const RIGHT_FIELD = /\^THERMLDAUTOSTATUS:/;

let rightSenders = [];
let wrongUsers = [];
let fieldParsers = [];
files.forEach(function (p) {
	const src = fs.readFileSync(p, 'utf8');
	const rel = path.relative(ROOT, p).split(path.sep).join('/');
	if (RIGHT.test(src)) rightSenders.push(rel);
	if (RIGHT_FIELD.test(src)) fieldParsers.push(rel);
	if (WRONG.test(src)) wrongUsers.push(rel);
});

ok('① 生产代码里存在真机验证过的正确拼写 AT^THERMLDAUTOSTATUS?', rightSenders.length > 0,
	'一个都没有 —— 温度保护状态查询会整体失效');

ok('② 解析侧按 ^THERMLDAUTOSTATUS: 取字段（发送与解析口径一致）', fieldParsers.length > 0,
	'没有文件按 ^THERMLDAUTOSTATUS: 解析，可能出现"发了但读不出来"');

ok('③ 生产代码里不得出现少 US 的错误拼写 AT^THERMLDAUTOSTAT?（真机实测回 ERROR）',
	wrongUsers.length === 0,
	wrongUsers.join('、') + '　真机证据：AT^THERMLDAUTOSTAT? → {"error":"ERROR"}；' +
	'AT^THERMLDAUTOSTATUS? → {"data":"^THERMLDAUTOSTATUS: 1, 0, 0, 0, 0, 0, 11\\r\\nOK"}');

/*
 * 反向自检：判据必须真能分辨这对拼写。
 * 关键风险是正则写成前缀匹配 —— 那样正确拼写也会被判成错误（恒红），
 * 或者错误拼写被放过（恒绿）。这里两种都钉住。
 */
const sampleWrong = 'send("AT^THERMLDAUTOSTAT?");';
const sampleRight = 'send("AT^THERMLDAUTOSTATUS?");';
ok('★ 反向自检：错误拼写能被检出', WRONG.test(sampleWrong) === true);
ok('★ 反向自检：错误拼写正则**不会**误伤正确拼写', WRONG.test(sampleRight) === false);
ok('★ 反向自检：正确拼写能被正确路径认出', RIGHT.test(sampleRight) === true &&
	RIGHT.test(sampleWrong) === false);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('AT 拼写契约通过（AT^THERMLDAUTOSTATUS? 与真机一致）');
