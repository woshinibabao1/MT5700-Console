/*
 * 静态断言：读命令必须带 { fresh: true }（P01 升级版本复核 / P09 短信作业轮询）
 * ----------------------------------------------------------------------------
 * 共同病因：这些命令会命中前端的读缓存，而「缓存期」恰好盖住它们自己的刷新意图 ——
 *   · AT+CGMR 在 IDENTIFIER 档（TTL 10 分钟），写命令只清 STATE 档，
 *     于是 FOTA 期间的「版本复核」会读到升级前的版本，界面给出错误的成功/失败结论（P01）
 *   · AT+SMSJOB? 的轮询间隔 350ms < 读缓存 2500ms，连续 7 拍拿到同一个对象（P09）
 *
 * 判据：源码里不允许再出现「不带第二参」的裸调用。
 * 每条都有反向验证：旧文本（裸调用）必须被同一检查判红。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const VIEW = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; }
	else { fails.push(detail ? name + ' :: ' + detail : name); }
}

function esc(s) { return s.replace(/[.+*?^${}()|[\]\\]/g, '\\$&'); }

/* 同一检查函数：给定源码，判断该命令是否还有「裸调用」（不带 { fresh: true }） */
function hasBareCall(src, cmd) {
	return new RegExp("sendCommand\\(\\s*'" + esc(cmd) + "'\\s*\\)").test(src);
}
function hasFreshCall(src, cmd) {
	return new RegExp("sendCommand\\(\\s*'" + esc(cmd) + "'\\s*,\\s*\\{\\s*fresh\\s*:\\s*true\\s*\\}\\s*\\)").test(src);
}

/* ---------------- P01：升级页的 AT+CGMR ---------------- */
const upgrade = fs.readFileSync(path.join(VIEW, 'upgrade.js'), 'utf8');
ok('P01 升级页不再有裸 AT+CGMR 调用',
	!hasBareCall(upgrade, 'AT+CGMR'),
	'存在未带 fresh 的 AT+CGMR —— FOTA 版本复核会读到旧版本');
ok('P01 升级页两处版本查询都带 fresh（fetchVersion 与 finishByIdle）',
	(upgrade.match(/sendCommand\(\s*'AT\+CGMR'\s*,\s*\{\s*fresh\s*:\s*true\s*\}\s*\)/g) || []).length >= 2,
	'带 fresh 的 AT+CGMR 少于 2 处');
ok('P01 反向：旧文本（裸 AT+CGMR）被同一检查判为不通过',
	hasBareCall("AtWs.client.sendCommand('AT+CGMR').then(function (res) {", 'AT+CGMR'),
	'旧文本竟被判为通过，检查函数无效');

/* ---------------- P09：短信作业轮询的 AT+SMSJOB? ---------------- */
const sms = fs.readFileSync(path.join(VIEW, 'sms_center.js'), 'utf8');
ok('P09 短信页不再有裸 AT+SMSJOB? 调用',
	!hasBareCall(sms, 'AT+SMSJOB?'),
	'存在未带 fresh 的 AT+SMSJOB? —— 350ms 轮询被 2500ms 缓存稀释');
ok('P09 短信作业轮询带 fresh',
	hasFreshCall(sms, 'AT+SMSJOB?'),
	'AT+SMSJOB? 未带 { fresh: true }');
ok('P09 反向：旧文本（裸 AT+SMSJOB?）被同一检查判为不通过',
	hasBareCall("AtWs.client.sendCommand('AT+SMSJOB?').then(function (res) {", 'AT+SMSJOB?'),
	'旧文本竟被判为通过，检查函数无效');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
process.exit(0);
