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

/* ---------- 2b. 短信条数口径（v1.0.2 起）----------
 * SIM 槽位数 ≠ 逻辑消息数（长短信每个分片各占 1 个槽位）。
 * 只显示 used/total 会被误读成「短信丢了」，必须补注逻辑消息数。
 */
ok('sms_center.js 计数函数 countReceivedMessages() 存在',
	/function countReceivedMessages\(\)/.test(smsJs));
ok('该计数只统计接收类（已发缓存不占槽位）',
	/msgs\[j\]\.type === 'received'/.test(smsJs));
ok('存储行两值不等时补注「N 条消息」', /条消息'/.test(smsJs));
ok('存储行 CPMS 未返回时显示占位符「存储：—」',
	/storageEl\.textContent = '存储：—'/.test(smsJs));
ok('存储行不再无条件拼接 used / total',
	/if \(!state\.storage\.total\) \{ storageEl\.textContent = '存储：—'; return; \}/.test(smsJs));
ok('buildContacts() 末尾同步刷存储行（合并后消息数才确定）',
	/renderConversation\(\);\s*\n\s*renderStorage\(\);/.test(smsJs));
ok('长短信气泡凡合并过都标注段数（不再只在缺片时提示）',
	/m\.partsCount != null && m\.partsCount > 1/.test(smsJs));
ok('长短信缺片时追加「部分缺失」', /segLabel \+= '（部分缺失）'/.test(smsJs));
ok('单条删除提示区分长短信分片数',
	/已删除该长短信的全部 ' \+ storedIndices\.length \+ ' 个分片'/.test(smsJs));
ok('批量删除统计槽位数 slotCount', /slotCount\+\+/.test(smsJs));
ok('批量删除提示带分片数', /共 ' \+ slotCount \+ ' 个分片/.test(smsJs));

/* ---------- 2c. 看门狗默认开启 + AT/shell 混排（v1.0.1）----------
 * 默认值散落在 5 处，任何一处留 0 都会导致「装了却不开」。
 */
const WD = path.join(ROOT, 'root', 'usr', 'share', 'mt5700', 'watchdog.sh');
const UCI_CONF = path.join(ROOT, 'root', 'etc', 'config', 'at-webserver');
const UCI_DEF = path.join(ROOT, 'root', 'etc', 'uci-defaults', 'at-webserver');
const SERVICE_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'service.js');
const wd = fs.readFileSync(WD, 'utf8');
const uciConf = fs.readFileSync(UCI_CONF, 'utf8');
const uciDef = fs.readFileSync(UCI_DEF, 'utf8');
const serviceJs = fs.readFileSync(SERVICE_JS, 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

ok('config/at-webserver: watch_enabled 默认 1',
	/option watch_enabled '1'/.test(uciConf));
ok('uci-defaults: 升级补齐 watch_enabled=1', /watch_enabled=1/.test(uciDef));
ok('watchdog.sh: W_ENABLED 初值 1', /^W_ENABLED=1$/m.test(wd));
ok('watchdog.sh: config_get_bool 缺键兜底为 1',
	/config_get_bool W_ENABLED config watch_enabled 1/.test(wd));
ok('service.js: 回填默认 watch_enabled 为 1',
	/get\('watch_enabled', '1'\)/.test(serviceJs));
ok('README: 配置表写「默认开启」', /watch_enabled` \| `1`/.test(readme));
ok('README 不再说 watch_enabled 默认不开', !/watch_enabled` \| `0`/.test(readme));

ok('watchdog.sh 有 is_at_cmd 分流函数', /is_at_cmd\(\) \{/.test(wd));
ok('watchdog.sh 分流大小写不敏感（AT+/AT^/at+/at^）',
	/\[Aa\]\[Tt\]\[\+\^\]\*\) return 0/.test(wd));
ok('watchdog.sh: 非 AT 行走 /bin/sh -c', /\/bin\/sh -c "\$line"/.test(wd));
ok('watchdog.sh: shell 行有 timeout 保护', /timeout 30 \/bin\/sh -c/.test(wd));
ok('watchdog.sh: 单条失败不中断后续（continue 而非 break）',
	!/is_at_cmd "\$line"; then[\s\S]{0,120}break/.test(wd));
ok('watchdog.sh 日志区分 AT / SH', /（AT）/.test(wd) && /（SH）/.test(wd));
ok('service.js 说明复位命令支持 shell', /本机 shell 命令/.test(serviceJs));

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

/* ---------- 7. 看门狗默认「救命命令」必须是重拉接口，五处默认值一致 ----------
 * 本机实测：模组 USB 重枚举后 DHCP 租约失效导致「路由器在、模组在、就是没网」，
 * ifdown → sleep 2 → ifup 重拉 MT5700M 就能拿到新地址。
 * 默认刻意不写 AT+CFUN=1,1：协议栈复位会让 eth2 数据面挂死，只能当用户兜底中的兜底。
 * 默认值分散在 UCI 默认配置、uci-defaults、watchdog.sh 兜底、service.js 回填、README 五处，
 * 漏改一处就会出现「界面显示的和实际执行的不一致」。
 */
const DEFAULT_RESET_CMDS = 'ifdown MT5700M\\nsleep 2\\nifup MT5700M';
const MODEM_SETTINGS_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'modem_settings.js');
const modemSettingsJs = fs.readFileSync(MODEM_SETTINGS_JS, 'utf8');

// 常量里是 UCI 的字面形态（反斜杠+n），放进 RegExp 前必须把反斜杠再转义一次，
// 否则 `\n` 会被当成「匹配换行符」，永远匹配不到加了引号的 UCI 值。
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

ok('config: 默认复位命令为重拉接口',
	new RegExp("option watch_reset_cmds '" + escapeRe(DEFAULT_RESET_CMDS) + "'").test(uciConf));
ok('config: 注释说明默认不用 AT+CFUN=1,1', /Default \*\*不\*\* 用 AT\+CFUN=1,1|默认 \*\*不\*\* 用 AT\+CFUN=1,1/.test(uciConf));
ok('uci-defaults: 补齐同样的默认值',
	new RegExp("watch_reset_cmds='" + escapeRe(DEFAULT_RESET_CMDS) + "'").test(uciDef));
ok('uci-defaults: 该值加了引号（含空格不能被词分割）',
	/watch_reset_cmds='/.test(uciDef));
ok('watchdog.sh 兜底同样是重拉接口',
	new RegExp("config_get W_RESET_CMDS config watch_reset_cmds '" + escapeRe(DEFAULT_RESET_CMDS) + "'").test(wd));
ok('service.js: 回填默认值一致',
	new RegExp("WATCH_RESET_CMDS_DEFAULT = '" + escapeRe(DEFAULT_RESET_CMDS) + "'").test(serviceJs));
ok('service.js: 读取默认值用的是同一个常量',
	/get\('watch_reset_cmds', WATCH_RESET_CMDS_DEFAULT\)/.test(serviceJs));
ok('README: 配置表写明默认三行',
	readme.indexOf('ifdown MT5700M') >= 0 && readme.indexOf('ifup MT5700M') >= 0);
ok('README: 默认不再是 AT+CFUN=1,1', !/watch_reset_cmds` \| `AT\+CFUN=1,1`/.test(readme));
/* 三行命令里写死了接口名 MT5700M，必须与 watch_iface 的默认值保持一致，
   否则用户改了接口却救不回来 */
ok('默认救命命令的接口与 watch_iface 默认值一致',
	/option watch_iface 'MT5700M'/.test(uciConf) && /watch_iface=MT5700M/.test(uciDef));

/* ---------- 8. SIM / PIN 状态码：全项目只能有一份解释 ----------
 * 参照 WTModem 的 mt5700m.sh::chkSimExt / sim_pin_chk（akury/immortalwrt-mt798x，
 * package/other/luci-app-WTModem）：^SIMSQ 的 <sim_status> 里 **只有 12** 打印
 * 「SIM 卡正常工作」，1「已插卡」只是物理到位、卡文件还没初始化完。
 *
 * 本项目此前把这份码表抄了三遍，且互相打架：
 *   · 同一个 2 号状态，一处叫「PIN 锁定」、一处叫「卡被 PIN/PUK 锁定」；
 *   · 「已插卡(1)」在 mt5700.js 判为正常，在 network_status.js 判为警告 —— 判定相反；
 *   · modem_settings.js 还把 11 的文案写 12 的语义。
 * 另外 modem_settings.js 有一处 `if (!ready) 显示 READY`，把最该报警的
 * SIM PIN / SIM PUK 状态盖成了「READY」。
 */
const PARSE_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const MODEM_SETTINGS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'modem_settings.js');
const parseJs = fs.readFileSync(PARSE_JS, 'utf8');
const modemJs = fs.readFileSync(MODEM_SETTINGS, 'utf8');

ok('parse.js 持有唯一的 SIM 状态主码表', /var SIM_STATUS = \{/.test(parseJs));
ok('parse.js 持有唯一的 PIN 状态主码表', /var CPIN_STATUS = \{/.test(parseJs));
ok('parse.js 导出 parseSimsq', /api\.parseSimsq = function/.test(parseJs));
ok('parse.js 导出 parseCpin', /api\.parseCpin = function/.test(parseJs));
ok('只有 12 判定为健康（WTModem 口径一致）',
	/12:\s*\{[^}]*healthy: true/.test(parseJs) && !/11:\s*\{[^}]*healthy: true/.test(parseJs));

/* 其它文件不得再出现第二份 SIM / PIN 码表 —— 分处各写一份，
   手册一改就会出现「同一个 2 号状态在两个页面两种说法」。
   用「只属于 SIM 码表的文案」当探针，比按数字键扫更准：
   （按行首数字扫会误伤 dial.js 的 USB 模式表 0~6、upgrade.js 的 FOTA 状态表 11~31） */
const SIM_ONLY_LABELS = ['未插卡', '卡失效', 'SIMLOCK 锁定', '等待输入 PUK（PIN 已锁死）',
	'卡不在位', 'SIM 卡正常工作', '短信与电话可接入'];
for (const label of SIM_ONLY_LABELS) {
	const holders = feFiles.filter((p) => fs.readFileSync(p, 'utf8').indexOf(label) >= 0);
	ok('「' + label + '」只存在于 parse.js',
		holders.length === 1 && holders[0] === PARSE_JS,
		holders.map((p) => path.relative(ROOT, p)).join(', ') || '零处');
}
/* 旧的三份码表变量名不许回来 */
for (const p of feFiles) {
	if (p === PARSE_JS) continue;
	const t = fs.readFileSync(p, 'utf8');
	const rel = path.relative(ROOT, p);
	ok('不自带 SIM/PIN 码映射（' + rel + '）',
		!/SIM_TEXT\s*=\s*\{|SIM_STATE\s*=\s*\{|CPIN_STATUS\s*=\s*\{|SIM_STATUS\s*=\s*\{/.test(t));
}

/* 三份旧码表必须已删除，且都改为读 Parse */
ok('mt5700.js 不再自带 SIM_TEXT 码表', mt5700.indexOf('SIM_TEXT = {') < 0);
ok('mt5700.js 改读 Parse.parseSimsq', /Parse\.parseSimsq/.test(mt5700));
ok('mt5700.js 的健康判定来自 sq.healthy', /is-warn', !sq\.healthy/.test(mt5700));
ok('network_status.js 不再自带 SIM_STATE 码表', statusJs.indexOf('SIM_STATE = {') < 0);
ok('network_status.js 改读 Parse.parseSimsq', /Parse\.parseSimsq/.test(statusJs));
ok('network_status.js 改读 Parse.parseCpin', /Parse\.parseCpin/.test(statusJs));

/* PIN 反转 bug 的两处痕迹都不许回来 */
ok('modem_settings.js 不再有「非 READY 却显示 READY」的反转逻辑',
	!/if \(!ready\)/.test(modemJs) && !/function fetchPinStatus[\s\S]{0,400}if \(!ready\)/.test(modemJs));
ok('modem_settings.js 的 +CPIN 不再用会截断 "SIM PUK" 的 \\w+ 正则',
	!/CPIN:\\s\*\(\\w\+\)/.test(modemJs));
ok('modem_settings.js 改读 Parse.parseCpin', /Parse\.parseCpin/.test(modemJs));
/* PIN 解锁后 ^SIMSQ 要从 2 走到 12，必须一并重读（WTModem 也是 chkSimExt → sim_pin_chk 串行） */
ok('modem_settings.js PIN 操作后同时刷新 SIM 状态',
	/fetchPinStatus\(\);[\s\S]{0,120}fetchSimSqStatus\(\);/.test(modemJs));

/* ---------- 汇总 ---------- */
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('UI / 样式 / mock 契约测试全部通过');
