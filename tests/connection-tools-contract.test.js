#!/usr/bin/env node
/*
 * 连接工具卡 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-18：「连接质量」整卡换成「连接工具」，六项功能
 *   ADC 管脚电压 / 诊断快照导出 / 网络拒绝原因 / 流量统计清零 /
 *   服务状态监听 / 连通性自检。
 *
 * 本测试覆盖：
 *   ① 解析层  parseAdcValue / parseSrvst / srvStatusText / parseRejInfo
 *   ② 自检    checkSteps() 六步判据（用手册格式的应答真跑）
 *   ③ 快照    buildSnapshotText() 真跑，重点钉「默认不写设备标识」
 *   ④ 安全三件套（2.2.1 事故防回退的源码级契约）★ 最重要
 *   ⑤ 沿用    PDCP / CGSMS 解析、地址去重、三表合并（这些不随换卡而失效）
 *
 * 运行：node tests/connection-tools-contract.test.js
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

/* ---------- 1. ^ADCREADEX（手册 11.5，单位 mV） ---------- */

eq('真机 ^ADCREADEX: 1799', Parse.parseAdcValue('^ADCREADEX: 1799\r\nOK'), 1799);
eq('手册举例 1099', Parse.parseAdcValue('^ADCREADEX: 1099'), 1099);
eq('负数也能取', Parse.parseAdcValue('^ADCREADEX: -12'), -12);
eq('ERROR 应答 → null', Parse.parseAdcValue('ERROR'), null);
eq('空串 → null', Parse.parseAdcValue(''), null);
eq('null 输入不炸', Parse.parseAdcValue(null), null);
eq('非数字 → null', Parse.parseAdcValue('^ADCREADEX: abc'), null);

/* ---------- 2. ^SRVST（手册 13.7 五个取值） ---------- */

eq('^SRVST: 0 → 无服务', Parse.parseSrvst('^SRVST: 0').status, 0);
eq('^SRVST: 0 文案', Parse.parseSrvst('^SRVST: 0').text, '无服务');
eq('^SRVST: 1 → 限制服务', Parse.parseSrvst('^SRVST: 1').text, '限制服务');
eq('^SRVST: 2 → 服务有效', Parse.parseSrvst('^SRVST: 2').text, '服务有效');
eq('^SRVST: 3 → 区域服务限制', Parse.parseSrvst('^SRVST: 3').text, '区域服务限制');
eq('^SRVST: 4 → 省电或休眠', Parse.parseSrvst('^SRVST: 4').text, '省电或休眠');
eq('全角冒号也收（手册正文用全角）', Parse.parseSrvst('^SRVST：2').status, 2);
eq('未收录的取值有兜底文案', Parse.parseSrvst('^SRVST: 9').text, '未知状态（#9）');
eq('不匹配的文本 → null', Parse.parseSrvst('OK'), null);
eq('srvStatusText(null) 不炸', Parse.srvStatusText(null), '未知');

/* ---------- 3. ^REJINFO（手册 13.14） ---------- */

const REJ = Parse.parseRejInfo('^REJINFO: "46000",0,7,6,0,7,"1422","05","0C027F50"');
ok('REJINFO 解析成功', REJ !== null, String(REJ));
eq('PLMN', REJ.plmn, '46000');
eq('原因值 7', REJ.cause, 7);
eq('原因值 7 有中文文案', typeof REJ.causeText === 'string' && REJ.causeText.length > 0, true);
eq('域 / 制式 / 类型都有文案', [typeof REJ.domainText, typeof REJ.ratText, typeof REJ.rejectTypeText],
	['string', 'string', 'string']);
eq('小区 ID 带上', REJ.cellId, '0C027F50');
eq('字段不足 6 个 → null', Parse.parseRejInfo('^REJINFO: "46000",0,7'), null);
eq('不匹配 → null', Parse.parseRejInfo('OK'), null);
ok('未知原因值有兜底文案', /未知原因/.test(Parse.rejectCauseText(99999)), Parse.rejectCauseText(99999));

/* ---------- 4. 连通性自检六步判据 ---------- */

const AtWsStub = {
	extractATDataMultiline: function (data, prefix) {
		return String(data).split(/\r?\n/)
			.map(function (l) { return l.trim(); })
			.filter(function (l) { return l.indexOf(prefix + ':') === 0; })
			.map(function (l) { return l.slice(prefix.length + 1).trim(); });
	},
	extractATData: function (data, prefix) {
		const re = new RegExp('\\' + prefix.split('').join('\\').replace(/\\\\/g, '\\')
			.replace(/^\^/, '\\^').replace(/^\+/, '\\+') + '\\s*:\\s*([^\\r\\n]*)');
		return null;
	},
	hexToIP: function (h) {
		const s = String(h == null ? '' : h).trim();
		if (!/^[0-9a-fA-F]{8}$/.test(s)) return s;
		const out = [];
		for (let i = 0; i < 8; i += 2) out.push(parseInt(s.substr(i, 2), 16));
		return out.join('.');
	}
};
/* extractATData 单独实现（上面那个正则拼法太绕） */
AtWsStub.extractATData = function (data, prefix) {
	const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const m = String(data).match(new RegExp(esc + ':\\s*([^\\r\\n]*)'));
	return m ? m[1].trim() : '';
};

const steps = new Function('Parse', 'AtWs',
	extractFn(nsSrc, 'checkSteps') + '\nreturn checkSteps;')(Parse, AtWsStub)();

eq('自检共 6 步', steps.length, 6);
eq('六步命令依次是 CPIN→C5GREG→CGACT→NDISSTATQRY→CGPADDR→DHCP',
	steps.map(function (s) { return s.cmd; }),
	['AT+CPIN?', 'AT+C5GREG?', 'AT+CGACT?', 'AT^NDISSTATQRY?', 'AT+CGPADDR', 'AT^DHCP?']);

function judge(name, data) {
	const st = steps.filter(function (s) { return s.name === name; })[0];
	return st.judge(data);
}

eq('CPIN READY → ok', judge('SIM 就绪', '+CPIN: READY\r\nOK').level, 'ok');
eq('CPIN SIM PIN → bad', judge('SIM 就绪', '+CPIN: SIM PIN\r\nOK').level, 'bad');
eq('CPIN 取不到 → bad 且文案说明卡没插好',
	judge('SIM 就绪', 'ERROR').level, 'bad');

eq('C5GREG stat=1 → ok', judge('网络注册', '+C5GREG: 1,1,"46000","14225C"\r\nOK').level, 'ok');
eq('C5GREG stat=5（漫游）→ ok', judge('网络注册', '+C5GREG: 1,5,"46000"\r\nOK').level, 'ok');
eq('C5GREG stat=3（被拒）→ bad', judge('网络注册', '+C5GREG: 1,3\r\nOK').level, 'bad');
ok('C5GREG 被拒时指路「网络拒绝原因」',
	/网络拒绝原因/.test(judge('网络注册', '+C5GREG: 1,3\r\nOK').text));
eq('C5GREG stat=0（未注册）→ warn，不是 bad',
	judge('网络注册', '+C5GREG: 1,0\r\nOK').level, 'warn');

eq('CGACT 有激活 → ok', judge('PDP 上下文激活', '+CGACT: 1,1\r\n+CGACT: 5,1\r\nOK').level, 'ok');
ok('CGACT ok 时列出 CID', /CID 1/.test(judge('PDP 上下文激活', '+CGACT: 1,1\r\nOK').text));
eq('CGACT 全 0 → bad', judge('PDP 上下文激活', '+CGACT: 1,0\r\n+CGACT: 5,0\r\nOK').level, 'bad');

eq('NDIS stat=1 → ok', judge('拨号连接', '^NDISSTATQRY: 1,1\r\nOK').level, 'ok');
eq('NDIS stat=0 → bad', judge('拨号连接', '^NDISSTATQRY: 1,0\r\nOK').level, 'bad');
eq('NDIS 无应答 → bad（不是 warn）', judge('拨号连接', 'ERROR').level, 'bad');

eq('CGPADDR 有地址 → ok',
	judge('拿到 IP 地址', '+CGPADDR: 1,"10.117.101.195"\r\nOK').level, 'ok');
eq('CGPADDR 空地址 → bad',
	judge('拿到 IP 地址', '+CGPADDR: 1,""\r\nOK').level, 'bad');

eq('DHCP 网关正常 → ok',
	judge('网关与 DNS', '^DHCP: 0A0A0A01,FFFFFF00,0A0A0A01,0A0A0A01,08080808,01010101\r\nOK').level, 'ok');
ok('DHCP ok 时给出网关 10.10.10.1',
	/10\.10\.10\.1/.test(judge('网关与 DNS',
		'^DHCP: 0A0A0A01,FFFFFF00,0A0A0A01,0A0A0A01,08080808,01010101\r\nOK').text));
eq('DHCP 取不到 → warn（不影响上网，不能判故障）',
	judge('网关与 DNS', 'ERROR').level, 'warn');

/* ---------- 5. 诊断快照：默认绝不能带设备标识 ---------- */

function makeSnapshotText(st, dev) {
	return new Function('state', 'devState', 'Parse', 'AtWs', 'systemModeLabel', 'splitSpeedUI',
		extractFn(nsSrc, 'buildSnapshotText') + '\nreturn buildSnapshotText;')(
		st, dev, Parse,
		{
			formatDuration: function (s) { return s + ' 秒'; },
			formatFlow: function (b) { return b + ' B'; }
		},
		function (m) { return m || '5G-NR'; },
		function (v, u) { return { value: String(v), unit: u === 'kbps' ? 'Mbps' : 'B/s' }; }
	);
}

const snapState = {
	cell: { rsrp: -78, rsrq: -10, sinr: 22, pci: 123, channel: '504990', sysMode: 'NR' },
	carriers: [{ index: 0, sysMode: 'NR', band: 78, dlFcn: 504990, dlBwKHz: 100000, pci: 123 }],
	diag: { endc: { established: false, available: true, plmnAvailable: true, restricted: false },
		rrc: { rrcText: '连接态' }, addrs: [{ cid: 1, address: '10.117.101.195', family: 'IPv4' }] },
	flow: { lastDsTime: 3600, lastRxFlow: 1000, lastTxFlow: 500, totalRxFlow: 2000, totalTxFlow: 800 },
	temps: { sub6GPA: 412, ap1: 0, modem1: 390 },
	dhcpv4: { gateway: '10.117.101.196', primaryDNS: '1.1.1.1', secondaryDNS: '8.8.8.8' },
	operator: '中国移动', networkStatus: '已注册', apn: 'cmnet', activeCid: 1,
	ambrDown: 3000000, ambrUp: 200000
};
const devState = {
	sim: 11, pin: 'READY', phone: '', model: 'MT5700M-CN', fw: '1.0.0',
	imei: '864640060359112', imsi: '460009711127691', iccid: '8986001234567890123'
};

const snapDefault = makeSnapshotText(snapState, devState)(false);
const snapWithIds = makeSnapshotText(snapState, devState)(true);

ok('快照含标题', /MT5700 诊断快照/.test(snapDefault));
ok('快照含 [ 连接 ] 段', /\[ 连接 \]/.test(snapDefault));
ok('快照含信号', /RSRP：-78 dBm/.test(snapDefault));
ok('快照含载波', /\[ 载波 \]/.test(snapDefault));
ok('快照含地址', /10\.117\.101\.195/.test(snapDefault));
ok('快照含流量', /\[ 流量 \]/.test(snapDefault));
ok('★ 默认不含 IMEI', snapDefault.indexOf('864640060359112') < 0);
ok('★ 默认不含 IMSI', snapDefault.indexOf('460009711127691') < 0);
ok('★ 默认不含 ICCID', snapDefault.indexOf('8986001234567890123') < 0);
ok('默认给出「已隐藏」说明', /设备标识已按选项隐藏/.test(snapDefault));
ok('勾选后含 IMEI', snapWithIds.indexOf('864640060359112') >= 0);
ok('勾选后含 IMSI', snapWithIds.indexOf('460009711127691') >= 0);
ok('勾选后提醒自行删除', /公开发帖前请自行删除/.test(snapWithIds));
ok('设备还没取到时也不炸', makeSnapshotText(snapState, null)(false).indexOf('MT5700 诊断快照') === 0);

/* ---------- 6. ★★ 安全三件套（2.2.1 事故防回退） ---------- */

ok('卡片已改名为「连接工具」', /Mt5700\.card\('连接工具'/.test(nsSrc));
ok('旧卡「连接质量」已下线', !/Mt5700\.card\('连接质量'/.test(nsSrc));

ok('★ 初始化里不自动开启任何监听',
	!/renderTools[\s\S]{0,80}startSrvListen/.test(nsSrc)
	&& !/^\s*startSrvListen\(\);/m.test(nsSrc));
ok('★ 服务状态监听只能手动触发（按钮绑定 startSrvListen）',
	/startSrvListen\(\); else startSrvListen\(\);/.test(nsSrc)
	|| /if \(t\.listening\) stopSrvListen\(\); else startSrvListen\(\);/.test(nsSrc));

ok('★ 有到点强制关闭的定时器（SRV_LISTEN_MS）',
	/var SRV_LISTEN_MS = \d+/.test(nsSrc)
	&& /setTimeout\(function \(\) \{ srvTimer = null; stopSrvListen\(\); \}, SRV_LISTEN_MS\)/.test(nsSrc));
ok('★ 关闭命令是 AT^SRVST=0', /sendCommand\('AT\^SRVST=0'\)/.test(nsSrc));
ok('★ 关闭失败必须置 offFailed（不能静默）', /t\.offFailed = true;/.test(nsSrc));
ok('★ offFailed 时判 warn 并给重试入口',
	/mt5700-diag-summary is-warn/.test(nsSrc)
	&& /dangerButton\('重试关掉周期上报', sendSrvOff\)/.test(nsSrc));
ok('★ 有代次守卫 srvGen（迟到的开启响应不许翻回已开）',
	/var srvGen = 0;/.test(nsSrc) && /if \(gen !== srvGen\) return;/.test(nsSrc)
	&& /srvGen\+\+/.test(nsSrc));
ok('★ 页面销毁时也尝试关掉上报',
	/_dispose[\s\S]{0,1200}AT\^SRVST=0/.test(nsSrc));
ok('★ 不再下发 PDCP 周期上报开关（2.2.1 元凶）',
	!/sendCommand\('AT\^PDCPDATAINFO=/.test(nsSrc));

ok('拒绝原因只订阅、不下发写命令',
	!/sendCommand\('AT\^?REJINFO/.test(nsSrc)
	&& /function toggleRejListen\(\)/.test(nsSrc));
ok('两个监听共用一个订阅回调（不会重复 subscribe）',
	/function ensureToolHandler\(\)[\s\S]{0,200}if \(toolHandler\) return;/.test(nsSrc));
ok('两个都关掉才 unsubscribe',
	/function dropToolHandler\(\)[\s\S]{0,300}rej\.listening \|\| state\.tools\.srv\.listening/.test(nsSrc));

ok('流量清零走确认弹窗', /function clearFlowStats[\s\S]{0,300}Mt5700\.confirm/.test(nsSrc));
ok('流量清零下发 AT^DSFLOWCLR', /sendCommand\('AT\^DSFLOWCLR'\)/.test(nsSrc));
ok('清零后立刻重取流量并重绘', /getFlow\(\)\.then\(renderFlow\)/.test(nsSrc));
ok('ADC 用 AT^ADCREADEX=', /sendCommand\('AT\^ADCREADEX=' \+ id\)/.test(nsSrc));
ok('ADC 管脚数量不写死（逐个试、失败即停）',
	/var ADC_PIN_IDS = \[/.test(nsSrc) && /if \(v == null\) \{ stopped = true; return; \}/.test(nsSrc));

/* ---------- 7. 沿用：PDCP / CGSMS 解析（解析器仍在 parse.js） ---------- */

const PDCP_REAL = '^PDCPDATAINFO: 2,6,500,0,0,0,0,0,0,0,0,0,17333,0,574750503,558267589\r\n'
	+ '^PDCPDATAINFO: 11,5,65535,0,0,0,0,0,0,0,0,0,0,0,45072,45072\r\nOK';
const pdcp = Parse.parsePdcpDataInfo(PDCP_REAL);
eq('PDCP 解析出 2 个 DRB', pdcp.length, 2);
eq('DRB1 上行丢包 17333', pdcp[0].ulDiscardCnt, 17333);
eq('DRB2 丢弃定时器 65535 → null（未配置）', pdcp[1].discardTimerLen, null);
eq('手册没写的第 15/16 字段不进结果',
	Object.keys(pdcp[0]).indexOf('ulPdcpRate') < 0
	&& Object.keys(pdcp[0]).indexOf('avgDelay') < 0, true);

eq('CGSMS 真机默认 3', Parse.parseCgsms('+CGSMS: 3').service, 3);
eq('CGSMS 3 → 优先 CS', [Parse.parseCgsms('+CGSMS: 3').preferCs, Parse.parseCgsms('+CGSMS: 3').preferPs], [true, false]);
eq('CGSMS 无匹配 → null', Parse.parseCgsms('ERROR'), null);

/* 地址汇聚与去重（真机三来源） */
const CGPADDR_REAL = '+CGPADDR: 1,"10.117.101.195"\r\n'
	+ '+CGPADDR: 5,"36.9.129.90.50.117.112.78.24.213.207.104.52.213.185.122"\r\nOK';
function makeAddrList(st) {
	return new Function('state',
		extractFn(nsSrc, 'addrKey') + '\n' + extractFn(nsSrc, 'buildAddrList')
		+ '\nreturn buildAddrList;')(st);
}
const addrState = {
	diag: { addrs: Parse.parseCgpaddr(CGPADDR_REAL) },
	dhcpv4: { ipv4Address: '10.117.101.195' },
	dhcpv6: null
};
const addrList = makeAddrList(addrState)();
eq('去重后只剩 2 条（IPv4 与 IPv6）', addrList.length, 2);
eq('IPv4 排在 IPv6 前', [addrList[0].family, addrList[1].family], ['IPv4', 'IPv6']);
eq('IPv6 还原成冒号形式', addrList[1].address, '2409:815a:3275:704e:18d5:cf68:34d5:b97a');
eq('同地址不同 CID → 1 行',
	makeAddrList({
		diag: { addrs: [{ cid: 1, address: '10.0.0.2', family: 'IPv4' }, { cid: 7, address: '10.0.0.2', family: 'IPv4' }] },
		dhcpv4: null, dhcpv6: null
	})().length, 1);
eq('全空 → 0 行', makeAddrList({ diag: { addrs: [] }, dhcpv4: null, dhcpv6: null })().length, 0);

/* ---------- 8. 沿用：三表合并（连接诊断 + 地址 + IP 与 DNS） ---------- */

ok('三张表已合并成一个渲染入口 renderConnDetail', /function renderConnDetail\(\)/.test(nsSrc));
ok('旧的 renderDiag / renderAddr / renderDHCP 已下线',
	!/function renderDiag\(/.test(nsSrc)
	&& !/function renderAddr\(/.test(nsSrc)
	&& !/function renderDHCP\(/.test(nsSrc));
ok('三个分组标题行齐全',
	/pushGroup\('连接诊断'/.test(nsSrc)
	&& /pushGroup\('地址'/.test(nsSrc)
	&& /pushGroup\('IP 与 DNS'/.test(nsSrc));
ok('地址表不再有 CID 列', !/Mt5700\.table\(\['CID'/.test(nsSrc));
ok('地址表不再有来源列', !/'来源'/.test(nsSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（连接工具：解析 / 自检判据 / 快照脱敏 / 安全三件套 / 沿用契约）');
