#!/usr/bin/env node
'use strict';

/**
 * AT 只读缓存契约测试
 *
 * 串口是独占资源，缓存写错的代价是「界面显示陈旧值」——这类问题不会报错，
 * 只会在某个时刻给出错误读数，最难排查。这里钉住四件事：
 *
 *   ① **分档判据是物理属性，不是采样**
 *      早期曾想用「连查两次是否相同」自动分档，结果 ^MONSC（服务小区信号）
 *      被判成恒定值——它 3 秒内恰好没变，实际上随时会变。故分档表是手工
 *      维护的白名单，且只收「读的对象本身不会变 / 只在用户操作后变」的命令。
 *
 *   ② **^SYSINFOEX 不在状态档**
 *      它报系统模式与服务域，会在 5G↔4G 重选时自行变化，不属于「用户操作
 *      后才变」。混进 15 秒档就会让网络模式显示滞后。
 *
 *   ③ **失败结果绝不缓存**
 *      本模组存在偶发单次 ERROR（实测 AT^SYSINFOEX? 两次里有一次 ERROR）。
 *      一旦把失败缓存起来，一次偶发就变成「持续显示失败」——比多等一次
 *      往返的代价大得多。
 *
 *   ④ **写命令执行成功后必须让状态类缓存失效**
 *      改完 PIN 还显示旧状态、切完飞行模式还显示原状态，都是这里漏了。
 *      物理标识类（IMEI/IMSI…）不受影响，不该被连带清掉。
 *
 * 用法：node tests/at-cache-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs/luci-static/resources');
const RPC_JS = path.join(RES, 'at-webserver/rpc.js');

const rpcSrc = fs.readFileSync(RPC_JS, 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

/* ---------- 载入 rpc.js ---------- */

function loadRpc() {
	/*
	 * rpc.js 是 LuCI 模块体，末尾自带 `return AtWsClass;`——若在外面套一层
	 * 函数再追加自己的 return，文件自己的 return 会先执行。故先摘掉那一行。
	 */
	const src = rpcSrc
		.replace(/^\s*'require [^']*';\s*$/gm, '')
		.replace(/\n\s*return AtWsClass;\s*$/, '\n');
	const ctx = {
		console,
		Promise,
		setTimeout,
		clearTimeout,
		Date,
		JSON,
		L: {
			Class: { extend: (x) => x },
			rpc: {
				declare: () => function () {
					return Promise.resolve({ success: true, data: 'OK' });
				}
			},
			uci: { load: () => Promise.resolve() },
			env: {}
		},
		window: undefined
	};
	vm.createContext(ctx);
	return vm.runInContext(
		'(function(){\n' + src +
		'\nreturn { ATClient: ATClient, cacheTtlFor: cacheTtlFor,' +
		' normalizeCommand: normalizeCommand,' +
		' IDENTIFIER_COMMANDS: IDENTIFIER_COMMANDS,' +
		' STATE_COMMANDS: STATE_COMMANDS,' +
		' CACHE_TTL_IDENTIFIER: CACHE_TTL_IDENTIFIER,' +
		' CACHE_TTL_STATE: CACHE_TTL_STATE,' +
		' READ_CACHE_TTL: READ_CACHE_TTL,' +
		' isRetryableRead: isRetryableRead };\n})()',
		ctx
	);
}

const R = loadRpc();
const { ATClient, cacheTtlFor, normalizeCommand, isRetryableRead } = R;

/* ---------- A. 分档表本身 ---------- */

ok('存在物理标识档与状态档两档常量',
	R.CACHE_TTL_IDENTIFIER > 0 && R.CACHE_TTL_STATE > 0);
ok('标识档（10 分钟）> 状态档（15 秒）> 默认档（2.5 秒）',
	R.CACHE_TTL_IDENTIFIER > R.CACHE_TTL_STATE &&
	R.CACHE_TTL_STATE > R.READ_CACHE_TTL,
	R.CACHE_TTL_IDENTIFIER + ' / ' + R.CACHE_TTL_STATE + ' / ' + R.READ_CACHE_TTL);
ok('标识档上限不超过 10 分钟（换卡后要能自愈）',
	R.CACHE_TTL_IDENTIFIER === 10 * 60 * 1000, '实际 ' + R.CACHE_TTL_IDENTIFIER);
ok('状态档短于慢档刷新周期 30 秒', R.CACHE_TTL_STATE < 30000,
	'实际 ' + R.CACHE_TTL_STATE);

/* 标识档：读的是烧死在硬件/卡上的东西 */
[['AT+CGSN', 'IMEI'], ['AT+CIMI', 'IMSI'], ['AT^ICCID?', 'ICCID'],
['AT+CGMM', '型号'], ['AT+CGMR', '固件版本'], ['AT^PHYNUM?', 'IMEI/MAC/SVN'],
['AT^VERSION?', '组件版本'], ['ATI', '厂商标识']].forEach(function (p) {
	ok('标识档包含 ' + p[0] + '（' + p[1] + '）',
		cacheTtlFor(p[0]) === R.CACHE_TTL_IDENTIFIER,
		'实际 TTL ' + cacheTtlFor(p[0]));
});

/* 状态档：只在用户操作后变 */
['AT+CPIN?', 'AT^SIMSQ?', 'AT+CFUN?', 'AT+CLCK?', 'AT+CGDCONT?', 'AT+CSCA?']
	.forEach(function (c) {
		ok('状态档包含 ' + c, cacheTtlFor(c) === R.CACHE_TTL_STATE,
			'实际 TTL ' + cacheTtlFor(c));
	});

/*
 * 反向断言：这些是连续量或会自行变化的量，绝不能进长档。
 * 漏一个进来，界面就会显示过时的读数而不报错。
 */
[['AT^HCSQ?', '信号强度，连续量'],
['AT^DSFLOWQRY', '流量，连续量'],
['AT^CHIPTEMP?', '温度，连续量'],
['AT^MONSC', '服务小区，随时变'],
['AT^MONNC', '邻区，随时变'],
['AT^NRSSBID?', 'SSB 邻区，随时变'],
['AT^SYSINFOEX?', '系统模式，5G↔4G 重选时自行变化'],
['AT+CSQ', '信号，连续量'],
['AT+CGPADDR', 'IP，重拨后变'],
['AT+COPS?', '运营商，漫游时变'],
['AT^RRCSTAT?', 'RRC 状态，随时变']
].forEach(function (p) {
	ok(p[0] + ' 不进长档（' + p[1] + '）',
		cacheTtlFor(p[0]) === R.READ_CACHE_TTL,
		'实际 TTL ' + cacheTtlFor(p[0]));
});

ok('分档表里没有重复命令',
	R.IDENTIFIER_COMMANDS.length === new Set(R.IDENTIFIER_COMMANDS).size &&
	R.STATE_COMMANDS.length === new Set(R.STATE_COMMANDS).size);
ok('两档之间没有交集',
	R.IDENTIFIER_COMMANDS.every(function (c) {
		return R.STATE_COMMANDS.indexOf(c) < 0;
	}));

/* ---------- B. 命令归一化 ---------- */

ok('归一化统一大写', normalizeCommand('at+cgsn') === 'AT+CGSN');
ok('归一化去掉首尾空格', normalizeCommand('  AT+CGSN  ') === 'AT+CGSN');
ok('归一化压缩内部空格', normalizeCommand('AT^ NRSSBID ?') === 'AT^NRSSBID?');
ok('归一化对 null 安全', normalizeCommand(null) === '');
ok('大小写不同视为同一条命令',
	cacheTtlFor('at+cgsn') === cacheTtlFor('AT+CGSN'));

/* ---------- C. 读写行为 ---------- */

/* 只放缓存相关的原型方法，connect/poll 等需要真实 RPC，这里不碰 */
function newClient() {
	const c = Object.create(ATClient.prototype);
	c._readCache = null;
	c.commandQueue = Promise.resolve();
	c.connected = true;
	c.commandTimeout = 14000;
	return c;
}

const c1 = newClient();
c1._cachePut('AT+CGSN', { success: true, data: '864640060359112' });
ok('写入后可命中', c1._cacheGet('AT+CGSN') !== null);
ok('命中返回原值',
	c1._cacheGet('AT+CGSN') && c1._cacheGet('AT+CGSN').data === '864640060359112');
ok('大小写不同也能命中', c1._cacheGet('at+cgsn') !== null);

/* 失败不缓存 */
const c2 = newClient();
c2._cachePut('AT+CPIN?', { success: false, error: '命令执行失败' });
ok('失败结果不写入缓存', c2._cacheGet('AT+CPIN?') === null);
c2._cachePut('AT+CPIN?', null);
ok('null 结果不写入缓存', c2._cacheGet('AT+CPIN?') === null);

/* 过期 */
const c3 = newClient();
c3._cachePut('AT^HCSQ?', { success: true, data: 'NR' });
ok('默认档写入后立即可命中', c3._cacheGet('AT^HCSQ?') !== null);
const stale = Object.create(ATClient.prototype);
stale._readCache = { 'AT^HCSQ?': { t: Date.now() - R.READ_CACHE_TTL - 1, value: { success: true, data: 'NR' }, hits: 0 } };
ok('默认档超时应失效', stale._cacheGet('AT^HCSQ?') === null);

const staleId = Object.create(ATClient.prototype);
staleId._readCache = { 'AT+CGSN': { t: Date.now() - 60 * 1000, value: { success: true, data: 'x' }, hits: 0 } };
ok('标识档 1 分钟后仍在（IMEI 不该被重查）', staleId._cacheGet('AT+CGSN') !== null);
const veryOld = Object.create(ATClient.prototype);
veryOld._readCache = { 'AT+CGSN': { t: Date.now() - R.CACHE_TTL_IDENTIFIER - 1, value: { success: true, data: 'x' }, hits: 0 } };
ok('标识档超过 10 分钟也失效（换卡后能自愈）', veryOld._cacheGet('AT+CGSN') === null);

/* ---------- D. 写命令使状态缓存失效 ---------- */

const c4 = newClient();
c4._cachePut('AT+CPIN?', { success: true, data: 'READY' });
c4._cachePut('AT+CGSN', { success: true, data: '864640060359112' });
c4._cachePut('AT^HCSQ?', { success: true, data: 'NR' });
c4._dropStateCache();
ok('写命令后状态类缓存被清掉', c4._cacheGet('AT+CPIN?') === null);
ok('写命令后物理标识不受影响（IMEI 不该被连带清掉）',
	c4._cacheGet('AT+CGSN') !== null);
ok('写命令不影响连续量缓存的既有条目（由 TTL 管）',
	c4._cacheGet('AT^HCSQ?') !== null);

/*
 * 只取 sendCommand 函数体本身。
 *
 * 上一版用 `split('ATClient.prototype.sendCommand')[1]`，取的是首次出现之后的
 * **整个文件剩余部分** —— 只要下文任何一处（甚至注释里）出现 _dropStateCache()
 * 就算通过，等于没断言。
 */
const sendCmdBody = (rpcSrc.match(/ATClient\.prototype\.sendCommand = function[\s\S]*?\n};/) || [''])[0];
ok('能定位到 sendCommand 函数体', sendCmdBody.length > 0);
ok('sendCommand 在写分支调用 _dropStateCache', /_dropStateCache\(\)/.test(sendCmdBody));

/* ---------- E. 缓存只用于只读命令 ---------- */

ok('写命令不可缓存（isRetryableRead false）',
	isRetryableRead('AT+CFUN=0') === false &&
	isRetryableRead('AT+CPIN=1234') === false &&
	isRetryableRead('AT^SYSCFGEX=08,1,1,3,') === false);
ok('终端危险命令不可缓存', isRetryableRead('AT^RESET') === false);
ok('查询命令可缓存',
	isRetryableRead('AT+CPIN?') === true &&
	isRetryableRead('AT^MONSC') === true &&
	isRetryableRead('AT^DSFLOWQRY') === true);
/*
 * 不带 '?' 的标识类命令也必须可缓存。
 *
 * 这里钉的是一个真实踩过的坑：AT+CGSN / AT+CIMI / AT+CGMM / AT+CGMR（IMEI/IMSI/
 * 型号/固件）只登记在分档缓存名单里、没进 isRetryableRead 的白名单，于是它们
 * cacheable=false —— 既拿不到 10 分钟缓存，还会走 sendCommand 的**写命令分支**，
 * 每查一次 IMEI 就把状态类缓存全清一遍。两份名单现在已由 isRetryableRead 统一引用，
 * 这条断言防止它们再次漂移。
 */
ok('不带 ? 的标识类命令也可缓存（IMEI/IMSI/型号/固件）',
	isRetryableRead('AT+CGSN') === true &&
	isRetryableRead('AT+CIMI') === true &&
	isRetryableRead('AT+CGMM') === true &&
	isRetryableRead('AT+CGMR') === true,
	'这几条曾漏在名单外，导致查一次 IMEI 就清一次状态缓存');
ok('sendCommand 以 isRetryableRead 决定缓存与否',
	/var cacheable = !opt\.fresh && isRetryableRead\(command\);/.test(rpcSrc));
ok('fresh 选项可强制绕过缓存', /opt\.fresh/.test(rpcSrc));

/* ---------- F. 容量上限（防止无限增长） ---------- */

const c5 = newClient();
for (let i = 0; i < 200; i++) {
	c5._cachePut('AT+CMDX' + i + '?', { success: true, data: String(i) });
}
ok('缓存条目不超过上限 64',
	c5.cacheStats().entries <= 64, '实际 ' + c5.cacheStats().entries);

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.error('失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	process.exit(1);
}
console.log('通过 ' + pass + ' 项，失败 0 项');
console.log('AT 只读缓存契约测试全部通过');
