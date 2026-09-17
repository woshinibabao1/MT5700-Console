#!/usr/bin/env node
/*
 * 连接质量卡 + 连接明细三表合并 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-18 改版背景：
 *
 *   ① 「连接状态」卡里原本有三张表：连接诊断 / 地址 / IP 与 DNS。
 *      三者的行都是「项目 → 值」，拆三张只是多两行表头、把同类信息切三刀。
 *      现在合成一张（renderConnDetail），用分组标题行分隔，并去掉两列：
 *        - CID  ：PDP 上下文编号，用户无从干预；
 *        - 来源 ：+CGPADDR 与 ^DHCP? 在本机给的是**同一个地址**，
 *                 标了来源反而让人以为有两份地址。
 *
 *   ② 「空口健康」卡换成「连接质量」卡：
 *        - 去掉 ^FASTDORM?（复述一个用户改不了、也不需要改的模组开关）；
 *        - 保留 ^PDCPDATAINFO? 丢包（唯一真有价值的项）与 +CGSMS? 短信承载域（可就地改）；
 *        - 新增「本次连接均速」（整段平均，与瞬时速率互补）与「信号波动」区间。
 *
 * 解析函数与去重函数**抽出来真跑**，不用正则匹配源码糊弄过去。
 *
 * 运行：node tests/connection-quality-contract.test.js
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

/* ---------- 2. +CGSMS?（短信承载域，仍在新卡里且可就地改） ---------- */

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

/* ---------- 3. 地址汇聚与去重（真机三来源） ---------- */

const CGPADDR_REAL = '+CGPADDR: 1,"10.117.101.195"\r\n'
	+ '+CGPADDR: 5,"36.9.129.90.50.117.112.78.24.213.207.104.52.213.185.122"\r\nOK';

/*
 * buildAddrRows / buildAddrList 靠闭包取页面里的 state（读 state.diag / state.dhcpv4），
 * updatePdcpDelta 读 state.link 并调 airSum，所以把依赖当外层变量注入再取出函数本身。
 */
function makeAddrList(st) {
	return new Function('state',
		extractFn(nsSrc, 'addrKey') + '\n' + extractFn(nsSrc, 'buildAddrList')
		+ '\nreturn buildAddrList;')(st);
}
function makeAddrRows(st) {
	return new Function('state',
		extractFn(nsSrc, 'addrKey') + '\n' + extractFn(nsSrc, 'buildAddrList')
		+ '\n' + extractFn(nsSrc, 'buildAddrRows') + '\nreturn buildAddrRows;')(st);
}
const airSum = new Function(extractFn(nsSrc, 'airSum') + '\nreturn airSum;')();
function makePdcpUpdater(st) {
	return new Function('state', 'airSum',
		extractFn(nsSrc, 'updatePdcpDelta') + '\nreturn updatePdcpDelta;')(st, airSum);
}
const sessionAvgBytes = new Function(
	extractFn(nsSrc, 'sessionAvgBytes') + '\nreturn sessionAvgBytes;')();
function makeRsrpPusher(st) {
	return new Function('state', 'RSRP_SAMPLES_MAX',
		extractFn(nsSrc, 'pushRsrpSample') + '\nreturn pushRsrpSample;')(st, 30);
}

const state = {
	diag: { addrs: Parse.parseCgpaddr(CGPADDR_REAL) },
	dhcpv4: { ipv4Address: '10.117.101.195' },   /* 真机 ^DHCP? 与 CID 1 完全相同 */
	dhcpv6: null                                  /* 真机 ^DHCPV6? 直接 ERROR */
};

const list = makeAddrList(state)();
eq('去重后只剩 2 条（IPv4 与 IPv6）', list.length, 2);
eq('IPv4 排在 IPv6 前', [list[0].family, list[1].family], ['IPv4', 'IPv6']);
eq('IPv4 地址', list[0].address, '10.117.101.195');
eq('IPv6 还原成冒号形式', list[1].address, '2409:815a:3275:704e:18d5:cf68:34d5:b97a');
eq('IPv4 条保留 CID 1（内部排序用）', list[0].cids, [1]);
eq('IPv6 条 CID 5', list[1].cids, [5]);

/* 合并后对外只给「项目 → 值」两列，类型并进项目名 */
const rows = makeAddrRows(state)();
eq('地址行是两列', rows.length === 2 && rows[0].length === 2, true);
eq('IPv4 行 = [IPv4 地址, 值]', rows[0], ['IPv4 地址', '10.117.101.195']);
eq('IPv6 行 = [IPv6 地址, 值]', rows[1], ['IPv6 地址', '2409:815a:3275:704e:18d5:cf68:34d5:b97a']);

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
eq('同地址不同 CID → 1 行', makeAddrList(dupState)().length, 1);
eq('CID 合并保留', makeAddrList(dupState)()[0].cids, [1, 7]);

/* 只有 WAN 侧有地址（PDP 查不到）时也要列出 */
const wanOnly = makeAddrList({ diag: { addrs: [] }, dhcpv4: { ipv4Address: '10.1.1.1' }, dhcpv6: null })();
eq('仅 WAN 来源也出一行', wanOnly.length, 1);
eq('仅 WAN 来源没有 CID', wanOnly[0].cids, []);
eq('全空 → 0 行', makeAddrList({ diag: { addrs: [] }, dhcpv4: null, dhcpv6: null })().length, 0);

/* ---------- 4. 会话均速：整段平均，除数为 0 时不能出 Infinity ---------- */

eq('正常：3600 秒传 900MB → 250000 B/s', sessionAvgBytes(900 * 1000 * 1000, 3600), 250000);
eq('时长为 0 → null（不能出 Infinity）', sessionAvgBytes(12345, 0), null);
eq('时长为负 → null', sessionAvgBytes(12345, -1), null);
eq('流量未取到（null）→ null', sessionAvgBytes(null, 60), null);
eq('时长未取到（undefined）→ null', sessionAvgBytes(100, undefined), null);
eq('0 字节 / 60 秒 = 0（是有效值，不能判成「没数据」）', sessionAvgBytes(0, 60), 0);
eq('负数流量 → null', sessionAvgBytes(-5, 60), null);

/* ---------- 5. 信号波动采样：0 与非法值不能混进区间 ---------- */

let rs = { rsrpSamples: [] };
const push = makeRsrpPusher(rs);
push(-95); push(-92); push(-99);
eq('有效采样全部收下', rs.rsrpSamples, [-95, -92, -99]);
push(0);          /* parse.js 里缺项会给 0 = 未上报 */
push(null); push(undefined); push(NaN); push('abc');
eq('0 / null / NaN / 非数字都不进采样', rs.rsrpSamples, [-95, -92, -99]);
for (let i = 0; i < 40; i++) push(-80 - i);
eq('采样条数封顶 30', rs.rsrpSamples.length, 30);
eq('封顶后保留最近 30 个（最早那个是第 11 次 push）', rs.rsrpSamples[0], -90);

/* ---------- 6. 丢包增量判定：三种「对不上」都不能报成故障 ---------- */

function freshLink() { return { link: { pdcp: [], pdcpPrev: null, delta: null, deltaReset: false } }; }
function step(st, list) { makePdcpUpdater(st)(list); }

/* 首轮：只记基准，不给增量，也不算「重置」 */
let a = freshLink();
step(a, [{ ulDiscardCnt: 100, dlDiscardCnt: 5 }]);
ok('首轮 delta 为 null', a.link.delta === null, JSON.stringify(a.link.delta));
ok('首轮不算「计数器重置」', a.link.deltaReset === false);

/* 第二轮正常增长 */
a.link.pdcpPrev.t -= 30000;   /* 假装过了 30 秒 */
step(a, [{ ulDiscardCnt: 130, dlDiscardCnt: 6 }]);
ok('第二轮算出增量', a.link.delta && a.link.delta.ul === 30 && a.link.delta.dl === 1,
	JSON.stringify(a.link.delta));
ok('增量带时间跨度（秒）', a.link.delta && a.link.delta.sec > 0);
ok('正常增长不算重置', a.link.deltaReset === false);

/* 重拨后计数器归零 → 差值变负，必须识别成重置，不能输出负数 */
a = freshLink();
step(a, [{ ulDiscardCnt: 17333, dlDiscardCnt: 0 }]);
step(a, [{ ulDiscardCnt: 12, dlDiscardCnt: 0 }]);
ok('计数器归零 → deltaReset', a.link.deltaReset === true);
ok('计数器归零 → 不产出负增量', a.link.delta === null, JSON.stringify(a.link.delta));

/* DRB 条数变化（承载重建）→ 合计跳变，同样按重置处理 */
a = freshLink();
step(a, [{ ulDiscardCnt: 10, dlDiscardCnt: 0 }]);
step(a, [{ ulDiscardCnt: 20, dlDiscardCnt: 0 }, { ulDiscardCnt: 3, dlDiscardCnt: 0 }]);
ok('DRB 条数变化 → deltaReset', a.link.deltaReset === true);

/* 命令失败（空数组）时不推进基准，也不误报重置 */
a = freshLink();
step(a, [{ ulDiscardCnt: 10, dlDiscardCnt: 0 }]);
step(a, []);
ok('查询失败不改基准', a.link.pdcpPrev && a.link.pdcpPrev.ul === 10);

/* ---------- 7. 页面接线（源码契约） ---------- */

ok('卡片叫「连接质量」', /Mt5700\.card\('连接质量'/.test(nsSrc));
ok('旧卡片「空口健康」已下线', !/Mt5700\.card\('空口健康'/.test(nsSrc));
ok('卡片挂进右列 duoRight', /duoRight\.appendChild\(qualityCard\)/.test(nsSrc));
ok('旧的一键诊断已删除（renderDiagCard）', !/renderDiagCard/.test(nsSrc));
ok('旧的一键诊断已删除（buildDiagnostics / DIAG_RULES）',
	!/buildDiagnostics/.test(nsSrc) && !/DIAG_RULES/.test(nsSrc));
ok('慢档任务含 loadLinkQuality', /SLOW_TASKS[\s\S]{0,200}loadLinkQuality/.test(nsSrc));
ok('loadLinkQuality 发 ^PDCPDATAINFO?', /loadLinkQuality[\s\S]{0,400}AT\^PDCPDATAINFO\?/.test(nsSrc));
ok('loadLinkQuality 发 +CGSMS?', /loadLinkQuality[\s\S]{0,600}AT\+CGSMS\?/.test(nsSrc));
ok('★ 不再查 ^FASTDORM?（每轮省一次串口往返）', !/AT\^FASTDORM\?/.test(nsSrc));
ok('初始化渲染连接质量卡', /renderQualityCard\(\);/.test(nsSrc));
ok('慢档整轮跑完统一重绘连接质量卡',
	/renderQualityCard\(\);[\s\S]{0,120}return slowRunning/.test(nsSrc));
ok('新卡表头是 检查项 / 值 / 依据与建议',
	/Mt5700\.table\(\['检查项', '值', '依据与建议'\]/.test(nsSrc));

/* 改短信域：走确认 + 下发 AT+CGSMS=2 + 成功后按新值重建 */
ok('改 PS 优先走确认弹窗', /function setCgsmsPs[\s\S]{0,400}Mt5700\.confirm/.test(nsSrc));
ok('下发的命令是 AT+CGSMS=2', /sendCommand\('AT\+CGSMS=2'\)/.test(nsSrc));
ok('成功后按下发值重建（不再多查一次）', /Parse\.parseCgsms\('\+CGSMS: 2'\)/.test(nsSrc));

/* ---------- 8. 三表合并（连接诊断 + 地址 + IP 与 DNS） ---------- */

ok('★ 三张表已合并成一个渲染入口 renderConnDetail', /function renderConnDetail\(\)/.test(nsSrc));
ok('旧的 renderDiag / renderAddr / renderDHCP 已下线',
	!/function renderDiag\(/.test(nsSrc)
	&& !/function renderAddr\(/.test(nsSrc)
	&& !/function renderDHCP\(/.test(nsSrc));
ok('合并表只画一次（项目 → 值）',
	/Mt5700\.table\(\['项目', '值'\], rows, \{ striped: true \}\)/.test(nsSrc));
ok('三个分组标题行齐全',
	/pushGroup\('连接诊断'/.test(nsSrc)
	&& /pushGroup\('地址'/.test(nsSrc)
	&& /pushGroup\('IP 与 DNS'/.test(nsSrc));
ok('★ 地址表不再有 CID 列', !/Mt5700\.table\(\['CID'/.test(nsSrc));
ok('★ 地址表不再有来源列', !/'来源'/.test(nsSrc));
ok('★ 不再有 fromPdp / fromWan 这套来源标记',
	!/fromPdp/.test(nsSrc) && !/fromWan/.test(nsSrc));
ok('空的分组不留标题行', /if \(!list\.length\) return;/.test(nsSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（连接质量解析 / 三表合并去重 / 均速与波动 / 增量判定 / 页面接线）');
