#!/usr/bin/env node
/*
 * UI / 样式 / mock 契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 用途：把「JS 用的类名 ↔ CSS 定义」「mock 应答 ↔ 真机实测」这两类曾经出过问题的约定固定下来。
 * 全部依据都是 2026-09-13 的真机实测与真实浏览器 DOM 采集，不是想当然。
 *
 * 运行：node tests/ui-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');
const MT5700 = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js');
const STATUS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const MOCK = path.join(ROOT, 'tests', 'mock-modem', 'mock-modem.js');

const css = fs.readFileSync(CSSP, 'utf8');
const mt5700 = fs.readFileSync(MT5700, 'utf8');
const statusJs = fs.readFileSync(STATUS, 'utf8');
const mock = fs.readFileSync(MOCK, 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}
function hasClass(name) {
	return new RegExp('\\.' + name.replace(/[-]/g, '\\-') + '(?![a-z0-9-])').test(css);
}

/* ---------- 1. 动态拼接的类名必须在 CSS 里有对应定义 ----------
 * mt5700.js：'mt5700-btn mt5700-btn-' + variant / 'mt5700-badge mt5700-badge-' + variant
 *            'mt5700-toast mt5700-toast-' + type
 * 缺一条就会出现「徽章/按钮没有配色」——2026-09-13 实测 .mt5700-badge-primary 就是缺的。
 */
const BTN_VARIANTS = ['secondary', 'primary', 'success', 'danger', 'ghost'];
const BADGE_VARIANTS = ['neutral', 'primary', 'success', 'warning', 'danger', 'info'];
const TOAST_VARIANTS = ['success', 'error', 'info', 'warning'];

for (const v of BTN_VARIANTS) ok('CSS 定义了 .mt5700-btn-' + v, hasClass('mt5700-btn-' + v));
for (const v of BADGE_VARIANTS) ok('CSS 定义了 .mt5700-badge-' + v, hasClass('mt5700-badge-' + v));
for (const v of TOAST_VARIANTS) ok('CSS 定义了 .mt5700-toast-' + v, hasClass('mt5700-toast-' + v));

/* 基础类也要在 */
for (const c of ['mt5700-btn', 'mt5700-badge', 'mt5700-toast', 'mt5700-badge-dot']) {
	ok('CSS 定义了 .' + c, hasClass(c));
}

/* ---------- 2. JS 实际挂上的类名必须在 CSS 里存在 ----------
 * 短信删除按钮：JS 挂的是 .mt5700-sms-del，CSS 曾写作 .at-sms-del → 样式从未生效。
 */
const SMS_CENTER = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');
const smsJs = fs.readFileSync(SMS_CENTER, 'utf8');
ok('sms_center.js 挂 .mt5700-sms-del', smsJs.indexOf('mt5700-sms-del') >= 0);
ok('CSS 定义了 .mt5700-sms-del', hasClass('mt5700-sms-del'));
ok('CSS 不再残留无主的 .at-sms-del 选择器', !/^\.at-sms-del\s*\{/m.test(css));

/* ---------- 3. 前端不得再发真机恒失败的命令 ----------
 * AT^TXPOWER?：手册 §13.23 仅 GUL 有效，本机 NR SA 实测 0/3 恒 ERROR。
 * 曾经「注释说已删除、调用还在」，这里钉死。
 */
const FE = path.join(ROOT, 'htdocs', 'luci-static', 'resources');
const feFiles = [];
(function walk(dir) {
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		if (fs.statSync(p).isDirectory()) walk(p);
		else if (f.endsWith('.js')) feFiles.push(p);
	}
})(FE);
const txpower = feFiles.filter((p) => /sendCommand\('AT\^TXPOWER\?'\)|'(AT\^TXPOWER\?)'/.test(fs.readFileSync(p, 'utf8')));
ok('前端不再发送 AT^TXPOWER?', txpower.length === 0,
	'仍在发送: ' + txpower.map((p) => path.relative(ROOT, p)).join(', '));

/* ---------- 4. mock 必须与真机一致 ----------
 * 真机不支持的形式：必须回 ERROR（否则测试会在假世界里通过）
 */
const MOCK_MUST_FAIL = ['AT+CSQ?', 'AT^MONSC?', 'AT^CPMS?', 'AT^CASCELLINFO?', 'AT^TXPOWER?',
	'AT^CONNECT?', 'AT+CLCK?', 'AT+CPWD?', 'AT^SYSINFO?', 'AT^NRRCCAPQRY?', 'AT^NDISSTATQRY'];
for (const c of MOCK_MUST_FAIL) {
	const re = new RegExp("if \\(c === '" + c.replace(/[\^+?]/g, (m) => '\\' + m) + "'\\) return 'ERROR'");
	ok('mock 对 ' + c + ' 返回 ERROR（与真机一致）', re.test(mock));
}
/* 真机能用的形式：必须有分支应答 */
const MOCK_MUST_WORK = ['AT^MONSC', 'AT+CSQ', 'AT^NRRCCAPQRY=3', 'AT^NRRCCAPQRY=2', 'AT^NRRCCAPQRY=5', 'AT^NWTIME?'];
for (const c of MOCK_MUST_WORK) {
	ok('mock 能应答 ' + c, mock.indexOf("'" + c + "'") >= 0);
}
/* SYSCFGEX 必须是真格式（第一段带引号），否则「漫游设置」卡解析不到 */
ok('mock 的 ^SYSCFGEX 应答是真格式（首段带引号）',
	/\^SYSCFGEX:\s*"\d{4,}"/.test(mock),
	'mock 里的 ^SYSCFGEX 应答没有带引号的 acqorder 字段');

/* ---------- 5. ^NWTIME（网络时间）已整条移除，不得复活 ----------
 * 手册 §13.8.5 与真机实测：网络未下发 EMM/GMM/MM information 时模组固定输出占位符 90/01/06，
 * 本机正是如此，界面只能显示假日期（曾显示成 2090-01-06）。相关字段、查询与解析函数一并删除。
 */
ok('network_status.js 不再查询 AT^NWTIME?', statusJs.indexOf("sendCommand('AT^NWTIME?')") < 0);
ok('network_status.js 不再有 parseNetTime', statusJs.indexOf('parseNetTime') < 0);
ok('network_status.js 不再有网络时间字段', statusJs.indexOf('网络时间') < 0 || /已整条移除/.test(statusJs));
const TERMINAL = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'terminal.js');
ok('终端快捷命令里也没有网络时间',
	fs.readFileSync(TERMINAL, 'utf8').indexOf('AT^NWTIME?') < 0);

/* 各路传感器温度必须落在「SIM 与设备」卡的那张表里（用户明确要求归位到这里） */
ok('温度行由 SIM 与设备卡渲染（温度 · 前缀）', statusJs.indexOf("'温度 · '") >= 0);
ok('不再有独立的温度磁贴容器 tempGrid', statusJs.indexOf('tempGrid') < 0);

/* ---------- 6. AT 通道必须经 rpcd → ucode → Rust，前端不得直连串口 ----------
 * 既定链路（rpc.js 头部注释 & L.rpc.declare）：
 *   LuCI JS → L.rpc.declare({object:'mt5700', method:'at'}) → rpcd → ucode 代理
 *   （/usr/share/rpcd/ucode/mt5700.uc）→ Rust 常驻服务（127.0.0.1:port，TCP newline-JSON）→ 串口。
 * 串口的唯一持有者是 Rust 服务；前端只允许经上面这条链路发 AT。
 */
const RPC_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const rpcJs = fs.readFileSync(RPC_JS, 'utf8');
ok('rpc.js 通过 L.rpc.declare 使用 rpcd 对象 mt5700',
	/L\.rpc\.declare\(\{[\s\S]{0,120}?object:\s*'mt5700'/.test(rpcJs));
ok("rpc.js 声明了 mt5700.at 方法（AT 的唯一出口）",
	/object:\s*'mt5700'\s*,\s*\n?\s*method:\s*'at'/.test(rpcJs));

/* 前端任何文件都不得直接打开/读取串口设备 */
for (const p of feFiles) {
	const t = fs.readFileSync(p, 'utf8');
	const rel = path.relative(ROOT, p);
	ok('不出现 Web Serial（' + rel + '）', !/navigator\.serial/.test(t));
	ok('不调用 microcom（' + rel + '）', !/\bmicrocom\b/.test(t));
	ok('不建 WebSocket（' + rel + '）', !/new\s+WebSocket/.test(t));
	/* /dev/tty* 只允许出现在 UI 文案或取值比较里（让用户选 Rust 该开哪个口），
	   一旦出现在发送调用里就是越权。 */
	for (const mm of t.matchAll(/\/dev\/tty[A-Za-z0-9]+/g)) {
		const line = t.slice(0, mm.index).split('\n').pop();
		const inSend = /sendCommand\(|sendCmd\(|fetch\(|XMLHttpRequest|WebSocket|\.open\(/.test(line);
		ok('串口路径只作 UI 文案（' + rel + '）', !inSend, line.trim().slice(0, 90));
	}
	/* AT 字面量不得出现在任何自带传输的调用里 */
	for (const mm of t.matchAll(/['"]AT[\^+A-Z0-9_?][\w\^+=,"\-]*['"]/g)) {
		const line = t.slice(0, mm.index).split('\n').pop();
		const direct = /fetch\(|XMLHttpRequest|WebSocket|\.open\(/.test(line);
		ok('AT 不自行绕过发送封装（' + rel + '）', !direct, line.trim().slice(0, 90));
	}
}

/* ---------- 汇总 ---------- */
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('UI / 样式 / mock 契约测试全部通过');
