#!/usr/bin/env node
/*
 * 空口健康卡 + 地址汇聚去重 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 背景（2026-09-18 真机实测 + 手册 5.36 / 13.15 / 7.7 双查证）：
 *
 *   ① AT^PDCPDATAINFO? 真机返回**比手册多 2 个字段**（手册只列 14 个）：
 *        ^PDCPDATAINFO: 2,6,500,0,0,0,0,0,0,0,0,0,17333,0,574750503,558267589
 *        ^PDCPDATAINFO: 11,5,65535,0,0,0,0,0,0,0,0,0,0,0,45072,45072
 *      末尾两个大数手册无记载（疑似累计字节），**不解读、不显示**。
 *      另外第二条 DRB 的 discardTimerLen 报 65535 = 未配置，要当 null。
 *
 *   ② AT+CGPADDR（PDP CID 1 IPv4）与 AT^DHCP?（运营商下发的 IPv4）在本机是同一个
 *      地址 10.117.101.195 —— 以前分两处显示，现在必须合并成一行（去重）。
 *
 * 这里把解析函数与去重函数**抽出来真跑**，不用正则匹配源码糊弄过去。
 *
 * 运行：node tests/air-health-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PARSE_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const NS_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');

const parseSrc = fs.readFileSync(PARSE_JS, 'utf8');
const nsSrc = fs.readFileSync(NS_JS, 'utf8');

const pm = parseSrc.match(/var Parse = \((function[\s\S]*?)\)\(\);/);
if (!pm) { console.error('无法从 parse.js 提取模块'); process.exit(1); }
/* eslint-disable no-eval */
const Parse = eval('(' + pm[1] + ')')();

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* 按括号配对从 network_status.js 里抠出整个函数 */
function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

/* ---------- 1. ^PDCPDATAINFO?：16 字段真机原文，只认前 14 个 ---------- */

const PDCP_REAL = '^PDCPDATAINFO: 2,6,500,0,0,0,0,0,0,0,0,0,17333,0,574750503,558267589\r\n'
	+ '^PDCPDATAINFO: 11,5,65535,0,0,0,0,0,0,0,0,0,0,0,45072,45072\r\nOK';

const pdcp = Parse.parsePdcpDataInfo(PDCP_REAL);
eq('PDCP 解析出 2 个 DRB', pdcp.length, 2);
eq('DRB1 id / PDU 会话', [pdcp[0].id, pdcp[0].pduSessionId], [2, 6]);
eq('DRB1 丢弃定时器 500ms', pdcp[0].discardTimerLen, 500);
eq('DRB1 上行丢包 17333', pdcp[0].ulDiscardCnt, 17333);
eq('DRB1 下行丢包 0', pdcp[0].dlDiscardCnt, 0);
eq('DRB2 丢弃定时器 65535 → null（未配置）', pdcp[1].discardTimerLen, null);
eq('DRB2 id / PDU 会话', [pdcp[1].id, pdcp[1].pduSessionId], [11, 5]);
eq('DRB2 上下行丢包都是 0', [pdcp[1].ulDiscardCnt, pdcp[1].dlDiscardCnt], [0, 0]);

/* 手册没写的第 15/16 字段绝不能出现在结果里（没有依据就不解读） */
const KEYS = Object.keys(pdcp[0]).sort();
ok('未公开字段不进结果（ulPdcpRate / dlPdcpRate / avgDelay / maxDelay 都不解析）',
	KEYS.indexOf('ulPdcpRate') < 0 && KEYS.indexOf('dlPdcpRate') < 0
	&& KEYS.indexOf('avgDelay') < 0 && KEYS.indexOf('maxDelay') < 0, KEYS.join(','));
ok('丢包计数在结果里', KEYS.indexOf('ulDiscardCnt') >= 0 && KEYS.indexOf('dlDiscardCnt') >= 0);

eq('字段不足 14 的行整行忽略', Parse.parsePdcpDataInfo('^PDCPDATAINFO: 1,2,3\r\nOK').length, 0);
eq('没有该命令的应答 → 空数组', Parse.parsePdcpDataInfo('OK'), []);
eq('ERROR 应答 → 空数组', Parse.parsePdcpDataInfo('ERROR'), []);
eq('null 输入不炸', Parse.parsePdcpDataInfo(null), []);

/* ---------- 2. ^FASTDORM? ---------- */

const fd = Parse.parseFastdorm('^FASTDORM: 1,5\r\nOK');
eq('FASTDORM type=1', fd.type, 1);
eq('FASTDORM timer=5 秒', fd.timer, 5);
eq('FASTDORM type 1 → 已启用休眠', fd.enabled, true);
ok('FASTDORM type 1 文案', fd.typeText === '只允许 Fast Dormancy', fd.typeText);
eq('FASTDORM type 0 → 不休眠', Parse.parseFastdorm('^FASTDORM: 0,5').enabled, false);
eq('FASTDORM 只回 type 时 timer 为 null', Parse.parseFastdorm('^FASTDORM: 3').timer, null);
eq('FASTDORM 无匹配 → null', Parse.parseFastdorm('ERROR'), null);

/* ---------- 3. +CGSMS? ---------- */

const cgsms = Parse.parseCgsms('+CGSMS: 3\r\nOK');
eq('CGSMS 真机默认 3', cgsms.service, 3);
eq('CGSMS 3 → 优先 CS', [cgsms.preferCs, cgsms.preferPs], [true, false]);
ok('CGSMS 3 文案', cgsms.text === '优先 CS 域', cgsms.text);
eq('CGSMS 2 → 优先 PS', [Parse.parseCgsms('+CGSMS: 2').preferPs, Parse.parseCgsms('+CGSMS: 2').preferCs], [true, false]);
eq('CGSMS 0 / 2 都算 PS 优先（手册：0、2 优先 PS）',
	[Parse.parseCgsms('+CGSMS: 0').preferPs, Parse.parseCgsms('+CGSMS: 2').preferPs], [true, true]);
eq('CGSMS 1 / 3 都算 CS 优先',
	[Parse.parseCgsms('+CGSMS: 1').preferCs, Parse.parseCgsms('+CGSMS: 3').preferCs], [true, true]);
eq('CGSMS 无匹配 → null', Parse.parseCgsms('ERROR'), null);
ok('CGSMS 未知取值有兜底文案', /取值 9/.test(String(Parse.parseCgsms('+CGSMS: 9').text)));

/* ---------- 4. 地址汇聚与去重（真机三来源） ---------- */

const CGPADDR_REAL = '+CGPADDR: 1,"10.117.101.195"\r\n'
	+ '+CGPADDR: 5,"36.9.129.90.50.117.112.78.24.213.207.104.52.213.185.122"\r\nOK';

/*
 * buildAddrRows / updatePdcpDelta 都靠闭包取页面里的 state（前者读 state.diag / state.dhcpv4，
 * 后者读 state.air 并调 airSum），所以把依赖当外层变量注入，再取出函数本身。
 */
function makeAddrRows(st) {
	return new Function('state',
		extractFn(nsSrc, 'buildAddrRows') + '\n' + extractFn(nsSrc, 'addrKey') + '\nreturn buildAddrRows;')(st);
}
const airSum = new Function(extractFn(nsSrc, 'airSum') + '\nreturn airSum;')();
function makePdcpUpdater(st) {
	return new Function('state', 'airSum',
		extractFn(nsSrc, 'updatePdcpDelta') + '\nreturn updatePdcpDelta;')(st, airSum);
}

const state = {
	diag: { addrs: Parse.parseCgpaddr(CGPADDR_REAL) },
	dhcpv4: { ipv4Address: '10.117.101.195' },   /* 真机 ^DHCP? 与 CID 1 完全相同 */
	dhcpv6: null                                  /* 真机 ^DHCPV6? 直接 ERROR */
};

const rows = makeAddrRows(state)();
eq('去重后只剩 2 行（IPv4 与 IPv6）', rows.length, 2);
eq('IPv4 排在 IPv6 前', [rows[0].family, rows[1].family], ['IPv4', 'IPv6']);
eq('IPv4 地址', rows[0].address, '10.117.101.195');
eq('IPv6 还原成冒号形式', rows[1].address, '2409:815a:3275:704e:18d5:cf68:34d5:b97a');
eq('IPv4 行同时来自 PDP 与 WAN（去重合并）', [rows[0].fromPdp, rows[0].fromWan], [true, true]);
eq('IPv4 行保留 CID 1', rows[0].cids, [1]);
eq('IPv6 行 CID 5 且只有 PDP 来源', [rows[1].cids, rows[1].fromPdp, rows[1].fromWan], [[5], true, false]);

/* 完全相同的地址即便 CID 不同也只留一行（同一地址被两个 CID 报出来） */
const dupState = {
	diag: {
		addrs: [
			{ cid: 1, address: '10.0.0.2', family: 'IPv4' },
			{ cid: 7, address: '10.0.0.2', family: 'IPv4' }
		]
	},
	dhcpv4: null, dhcpv6: null
};
const dupRows = makeAddrRows(dupState)();
eq('同地址不同 CID → 1 行', dupRows.length, 1);
eq('CID 合并显示', dupRows[0].cids, [1, 7]);

/* 只有 WAN 侧有地址（PDP 查不到）时也要列出，CID 列给 — */
const wanOnly = makeAddrRows({ diag: { addrs: [] }, dhcpv4: { ipv4Address: '10.1.1.1' }, dhcpv6: null })();
eq('仅 WAN 来源也出一行', wanOnly.length, 1);
eq('仅 WAN 来源没有 CID', wanOnly[0].cids, []);
eq('全空 → 0 行', makeAddrRows({ diag: { addrs: [] }, dhcpv4: null, dhcpv6: null })().length, 0);

/* ---------- 5. 丢包增量判定：三种「对不上」都不能报成故障 ---------- */

function freshAir() { return { air: { pdcp: [], pdcpPrev: null, delta: null, deltaReset: false } }; }
function step(st, list) { makePdcpUpdater(st)(list); }

/* 首轮：只记基准，不给增量，也不算「重置」 */
let a = freshAir();
step(a, [{ ulDiscardCnt: 100, dlDiscardCnt: 5 }]);
ok('首轮 delta 为 null', a.air.delta === null, JSON.stringify(a.air.delta));
ok('首轮不算「计数器重置」', a.air.deltaReset === false);

/* 第二轮正常增长 */
a.air.pdcpPrev.t -= 30000;   /* 假装过了 30 秒 */
step(a, [{ ulDiscardCnt: 130, dlDiscardCnt: 6 }]);
ok('第二轮算出增量', a.air.delta && a.air.delta.ul === 30 && a.air.delta.dl === 1,
	JSON.stringify(a.air.delta));
ok('增量带时间跨度（秒）', a.air.delta && a.air.delta.sec > 0);
ok('正常增长不算重置', a.air.deltaReset === false);

/* 重拨后计数器归零 → 差值变负，必须识别成重置，不能输出负数 */
a = freshAir();
step(a, [{ ulDiscardCnt: 17333, dlDiscardCnt: 0 }]);
step(a, [{ ulDiscardCnt: 12, dlDiscardCnt: 0 }]);
ok('计数器归零 → deltaReset', a.air.deltaReset === true);
ok('计数器归零 → 不产出负增量', a.air.delta === null, JSON.stringify(a.air.delta));

/* DRB 条数变化（承载重建）→ 合计跳变，同样按重置处理 */
a = freshAir();
step(a, [{ ulDiscardCnt: 10, dlDiscardCnt: 0 }]);
step(a, [{ ulDiscardCnt: 20, dlDiscardCnt: 0 }, { ulDiscardCnt: 3, dlDiscardCnt: 0 }]);
ok('DRB 条数变化 → deltaReset', a.air.deltaReset === true);

/* 命令失败（空数组）时不推进基准，也不误报重置 */
a = freshAir();
step(a, [{ ulDiscardCnt: 10, dlDiscardCnt: 0 }]);
step(a, []);
ok('查询失败不改基准', a.air.pdcpPrev && a.air.pdcpPrev.ul === 10);

/* ---------- 6. 页面接线（源码契约） ---------- */

ok('卡片叫「空口健康」', /Mt5700\.card\('空口健康'/.test(nsSrc));
ok('卡片挂进右列 duoRight', /duoRight\.appendChild\(airCard\)/.test(nsSrc));
ok('旧的一键诊断已删除（renderDiagCard）', !/renderDiagCard/.test(nsSrc));
ok('旧的一键诊断已删除（buildDiagnostics / DIAG_RULES）',
	!/buildDiagnostics/.test(nsSrc) && !/DIAG_RULES/.test(nsSrc));
ok('慢档任务含 loadAirHealth', /SLOW_TASKS[\s\S]{0,200}loadAirHealth/.test(nsSrc));
ok('loadAirHealth 发 ^PDCPDATAINFO?', /loadAirHealth[\s\S]{0,400}AT\^PDCPDATAINFO\?/.test(nsSrc));
ok('loadAirHealth 发 ^FASTDORM?', /loadAirHealth[\s\S]{0,600}AT\^FASTDORM\?/.test(nsSrc));
ok('loadAirHealth 发 +CGSMS?', /loadAirHealth[\s\S]{0,800}AT\+CGSMS\?/.test(nsSrc));
ok('初始化渲染空口卡', /renderAirCard\(\);/.test(nsSrc));
ok('慢档整轮跑完统一重绘空口卡',
	/renderAirCard\(\);[\s\S]{0,120}return slowRunning/.test(nsSrc));

/* 改短信域：走确认 + 下发 AT+CGSMS=2 + 成功后按新值重建 */
ok('改 PS 优先走确认弹窗', /function setCgsmsPs[\s\S]{0,400}Mt5700\.confirm/.test(nsSrc));
ok('下发的命令是 AT+CGSMS=2', /sendCommand\('AT\+CGSMS=2'\)/.test(nsSrc));
ok('成功后按下发值重建（不再多查一次）', /Parse\.parseCgsms\('\+CGSMS: 2'\)/.test(nsSrc));

/* 地址去重接线 */
ok('renderDiag 末尾带出地址表', extractFn(nsSrc, 'renderDiag').indexOf('renderAddr()') >= 0);
ok('DHCP 刷新后重绘地址表', /renderDHCP\(\);\s*\n\s*renderAddr\(\);/.test(nsSrc));
ok('IP 表不再重复显示 IPv4 地址', !/rows\.push\(\['IPv4 地址'/.test(nsSrc));
ok('IP 表不再重复显示 IPv6 地址', !/rows\.push\(\['IPv6 地址'/.test(nsSrc));
ok('地址表列名是 CID / 类型 / 地址 / 来源',
	/Mt5700\.table\(\['CID', '类型', '地址', '来源'\]/.test(nsSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（空口健康解析 / 地址去重 / 增量判定 / 页面接线）');
