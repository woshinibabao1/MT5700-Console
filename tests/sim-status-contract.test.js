#!/usr/bin/env node
'use strict';

/**
 * SIM 状态文案 + 「AT 只走 Rust」 + 「SIM 自愈已删除」契约测试
 *
 * 三个主题，都是「改一处漏一处就会埋雷」的东西，所以钉成静态守卫：
 *
 *   ① **SIM 码表只有一份**（在 parse.js）。
 *      mt5700.js（顶部状态芯片）与 network_status.js（SIM 徽章）只准消费
 *      Parse.simShort() / Parse.simIsWarn()，不许再各抄一份。
 *   ② **11（已初始化）不算告警**。
 *      本卡长期停在 ^SIMSQ: 1,11，实测短信收发正常；手册那句「11 时短信与电话
 *      未接入」照抄进界面会误导用户（v1.1.0 之前的文案正是这么写的）。
 *   ③ **SIM 卡状态自愈已删除，不许再回来**。
 *      真机证据：推完 HVSST 卡状态仍是 11（无效）；11 下短信本来就正常（无收益）；
 *      HVSST 是模拟 SIM 热插拔，会让模组重读 SIM（有掉网风险）。
 *
 * 本机没有 cargo/rustc，Rust 的行为测试在 CI 上跑；这里只做静态守卫。
 *
 * 用法：node tests/sim-status-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARSE_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/parse.js');
const M5700_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/mt5700.js');
const NETSTATUS_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/network_status.js');
const SERVICE_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/service.js');
const MODEM_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/modem_settings.js');
const RUST_SRC = path.join(ROOT, 'src/rust/src');
const UCI_CFG = path.join(ROOT, 'root/etc/config/at-webserver');
const UCI_DEF = path.join(ROOT, 'root/etc/uci-defaults/at-webserver');
const WD_SH = path.join(ROOT, 'root/usr/share/mt5700/watchdog.sh');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
	if (cond) {
		pass++;
		console.log('  ok   ' + name);
	} else {
		fail++;
		console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
	}
}

function read(p) {
	return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** 剥掉块注释与整行 `//` 注释，避免被源码里解释历史写法的注释误伤。 */
function stripComments(text) {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !/^\s*\/\//.test(l))
		.join('\n');
}

/** 剥掉 shell 的整行 `#` 注释。 */
function stripHashComments(text) {
	return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

const parseJs = read(PARSE_JS);
const parseCode = stripComments(parseJs);
const m5700Code = stripComments(read(M5700_JS));
const netCode = stripComments(read(NETSTATUS_JS));
const svc = read(SERVICE_JS);

/* ---------------------------------------------------------------------------
 * 1. SIM 码表唯一真源
 * ------------------------------------------------------------------------- */

console.log('== 1. SIM 码表只有一份（parse.js） ==');

ok('parse.js 有完整码表 SIM_STATUS', /var SIM_STATUS = \{/.test(parseCode));
ok('parse.js 有短标签表 SIM_STATUS_SHORT（徽章 / 状态芯片用）',
	/var SIM_STATUS_SHORT = \{/.test(parseCode));
ok('parse.js 有告警判定表 SIM_STATUS_WARN', /var SIM_STATUS_WARN = \{/.test(parseCode));
ok('parse.js 暴露 simShort / simIsWarn / simDetail 三个消费入口',
	/api\.simShort = function/.test(parseCode) &&
	/api\.simIsWarn = function/.test(parseCode) &&
	/api\.simDetail = function/.test(parseCode));

ok('mt5700.js 不再自带 SIM 码表', !/SIM_TEXT\s*=\s*\{/.test(m5700Code),
	'码表抄一份在 mt5700.js，改文案时必漏改');
ok('network_status.js 不再自带 SIM 码表', !/SIM_STATE\s*=\s*\{/.test(netCode),
	'码表抄一份在 network_status.js，改文案时必漏改');
ok('mt5700.js 消费 Parse.simShort', /Parse\.simShort\(/.test(m5700Code));
ok('mt5700.js 消费 Parse.simIsWarn', /Parse\.simIsWarn\(/.test(m5700Code));
ok('network_status.js 消费 Parse.simShort', /Parse\.simShort\(/.test(netCode));
ok('network_status.js 消费 Parse.simIsWarn', /Parse\.simIsWarn\(/.test(netCode));

/* ---------------------------------------------------------------------------
 * 2. 11（已初始化）不算告警
 * ------------------------------------------------------------------------- */

console.log('== 2. 11（已初始化）不算告警 ==');

/** 把码表从源码里抠出来求值 —— 比「源码里写了 11: false」这种字符串匹配硬得多。 */
function extractTable(name) {
	const m = parseCode.match(new RegExp('var ' + name + ' = \\{([\\s\\S]*?)\\};'));
	if (!m) return null;
	// eslint-disable-next-line no-new-func
	return Function('return {' + m[1] + '}')();
}

const warnTable = extractTable('SIM_STATUS_WARN');
const shortTable = extractTable('SIM_STATUS_SHORT');

ok('能取出 SIM_STATUS_WARN 表', warnTable !== null);
if (warnTable) {
	ok('11 不告警（本卡常态，短信实测正常）', warnTable[11] === false, '实际 ' + warnTable[11]);
	ok('12 不告警', warnTable[12] === false, '实际 ' + warnTable[12]);
	ok('1（已插卡）不告警（只是过渡态）', warnTable[1] === false, '实际 ' + warnTable[1]);
	ok('0（未插卡）要告警', warnTable[0] === true);
	ok('98（卡失效）要告警', warnTable[98] === true);
	ok('99（已移除）要告警', warnTable[99] === true);
}

ok('能取出 SIM_STATUS_SHORT 表', shortTable !== null);
if (shortTable) {
	ok('11 的短标签不出现「未就绪」（与实际不符）',
		shortTable[11].indexOf('未就绪') < 0, shortTable[11]);
	ok('11 的短标签不出现「未接入」（与实际不符）',
		shortTable[11].indexOf('未接入') < 0, shortTable[11]);
	ok('12 的短标签仍是「短信与电话可接入」',
		shortTable[12].indexOf('短信与电话可接入') >= 0, shortTable[12]);
}

ok('parse.js 详细文案里 11 交代了「实测短信正常」',
	/11: '[^']*实测 11 下短信收发正常/.test(parseCode),
	'只写手册口径会误导：手册说 11 时短信与电话未接入，但本机实测正常');
ok('网络状态页不再出现「短信可能发不出去」这类吓人提示',
	read(NETSTATUS_JS).indexOf('短信可能发不出去') < 0);

/* ---------------------------------------------------------------------------
 * 3. SIM 文案统一
 * ------------------------------------------------------------------------- */

console.log('== 3. SIM 文案统一（不写「电话本」） ==');

for (const [label, p] of [
	['parse.js', PARSE_JS], ['mt5700.js', M5700_JS],
	['network_status.js', NETSTATUS_JS], ['service.js', SERVICE_JS], ['modem_settings.js', MODEM_JS]
]) {
	ok(label + ' 不出现「电话本」', read(p).indexOf('电话本') < 0,
		'用户拍板：界面文案统一写「短信与电话」');
}

/* ---------------------------------------------------------------------------
 * 4. 一切 AT 都走 Rust：shell 不许碰串口
 * ------------------------------------------------------------------------- */

console.log('== 4. 一切 AT 指令都走 Rust ==');

const shellFiles = [
	['watchdog.sh', WD_SH],
	['hotplug 续约脚本', path.join(ROOT, 'root/etc/hotplug.d/net/99-mt5700-renew')],
	['init.d 脚本', path.join(ROOT, 'root/etc/init.d/mt5700-watchdog')]
];
for (const [label, p] of shellFiles) {
	const t = read(p);
	if (!t) continue;
	const code = stripHashComments(t);
	ok(label + ' 不直接用 microcom 碰串口', !/microcom/.test(code));
	ok(label + ' 不直接用 stty 碰串口', !/\bstty\b/.test(code));
	ok(label + ' 不下发 SIM 自愈用的 HVSST',
		!/AT\^HVSST\s*=/.test(code),
		'HVSST 现在只由「模组设置 → SIM 槽位切换」手动下发，自动化脚本不许碰（会让模组重读 SIM）');
}
ok('前端不出现 microcom / navigator.serial',
	!/microcom|navigator\.serial/.test(svc));

/* ---------------------------------------------------------------------------
 * 5. SIM 自愈已删除的回归守卫
 * ------------------------------------------------------------------------- */

console.log('== 5. SIM 卡状态自愈已删除 ==');

const rustFiles = fs.existsSync(RUST_SRC)
	? fs.readdirSync(RUST_SRC).filter((f) => f.endsWith('.rs'))
	: [];

ok('不存在 src/rust/src/simheal.rs', !fs.existsSync(path.join(RUST_SRC, 'simheal.rs')));
for (const f of rustFiles) {
	const t = stripComments(read(path.join(RUST_SRC, f)));
	ok('Rust 源码 ' + f + ' 里没有 simheal / sim_heal', !/simheal|sim_heal/.test(t));
	ok('Rust 源码 ' + f + ' 里没有自动下发的 HVSST', !/AT\^HVSST/.test(t),
		'自愈（开机自动推 HVSST）已在 v1.1.0 删除：无效、无收益、有掉网风险');
}
ok('UCI 随包配置里没有 sim_heal_enable', !/sim_heal_enable/.test(read(UCI_CFG)));
ok('uci-defaults 里没有 sim_heal_enable', !/sim_heal_enable/.test(read(UCI_DEF)));
ok('服务配置页没有「SIM 卡状态自愈」卡片', !/SIM 卡状态自愈/.test(svc));
ok('服务配置页不再读写 sim_heal_enable', !/sim_heal_enable/.test(svc));

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
process.exit(1);
