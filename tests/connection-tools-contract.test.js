#!/usr/bin/env node
/*
 * 连接工具卡 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-18：「连接质量」整卡换成「连接工具」。
 *   初版六项，同日按用户要求调整为四项：
 *     ADC 管脚电压（进页面自动读）/ 诊断快照导出 / 流量统计清零 / 连通性自检。
 *   · 「网络拒绝原因」→ 迁到「网络设置 → 网络拒绝」卡（本测试第 9 节守卫）
 *   · 「服务状态监听」→ 整块下线（^SRVST 解析器一并删除，本测试第 6 节守卫）
 *
 * 本测试覆盖：
 *   ① 解析层  parseAdcValue / parseRejInfo
 *   ② 自检    checkSteps() 六步判据（用手册格式的应答真跑）
 *   ③ 快照    buildSnapshotText() 真跑，重点钉「默认不写设备标识」
 *   ④ ★ 不占通道底线（2.2.1 事故防回退的源码级契约）最重要
 *   ⑤ 沿用    PDCP / CGSMS 解析、地址去重、三表合并（这些不随换卡而失效）
 *   ⑥ 网络设置页「网络拒绝」卡契约（迁移后的归宿）
 *
 * 运行：node tests/connection-tools-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PARSE_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const NS_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
/* 「网络拒绝原因」迁移后的归宿页 */
const SET_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_settings.js');
/* ADC 读数胶囊的样式（竖向堆叠那次事故就出在这里，故一并守卫） */
const CSS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');

const parseSrc = fs.readFileSync(PARSE_JS, 'utf8');
const nsSrc = fs.readFileSync(NS_JS, 'utf8');
const setSrc = fs.readFileSync(SET_JS, 'utf8');
const cssSrc = fs.readFileSync(CSS, 'utf8');

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

/* ---------- 2. ^REJINFO（手册 13.14，解析器留在 parse.js，UI 在 network_settings.js） ---------- */

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
ok('C5GREG 被拒时指路「网络设置 → 网络拒绝」',
	/网络设置 → 网络拒绝/.test(judge('网络注册', '+C5GREG: 1,3\r\nOK').text));
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

/* ---------- 6. ★★ 不占通道底线（2.2.1 事故防回退） ---------- */

ok('卡片已改名为「连接工具」', /Mt5700\.card\('连接工具'/.test(nsSrc));
ok('旧卡「连接质量」已下线', !/Mt5700\.card\('连接质量'/.test(nsSrc));

ok('★ 不再下发 PDCP 周期上报开关（2.2.1 元凶）',
	!/sendCommand\('AT\^PDCPDATAINFO=/.test(nsSrc));
ok('★ 服务状态监听已整块下线（不再下发 AT^SRVST 命令）',
	!/sendCommand\('AT\^SRVST/.test(nsSrc)
	&& !/buildSrvBlock|startSrvListen|stopSrvListen|sendSrvOff/.test(nsSrc)
	&& !/tools\.srv/.test(nsSrc));
ok('★ ^SRVST 解析器已一并删除（不留死代码）',
	!/api\.parseSrvst/.test(parseSrc) && !/api\.srvStatusText/.test(parseSrc));
ok('★ 网络状态页不再有「网络拒绝原因」（已迁去网络设置）',
	!/buildRejBlock|toggleRejListen|tools\.rej/.test(nsSrc));
ok('★ 本卡没有任何周期上报开关（无 SRV_LISTEN_MS / 无订阅回调）',
	!/SRV_LISTEN_MS/.test(nsSrc) && !/toolHandler/.test(nsSrc)
	&& !/AtWs\.client\.subscribe/.test(nsSrc));
ok('★ 自检那步指路到「网络设置 → 网络拒绝」',
	/网络设置 → 网络拒绝/.test(nsSrc));

ok('流量清零走确认弹窗', /function clearFlowStats[\s\S]{0,300}Mt5700\.confirm/.test(nsSrc));
ok('流量清零下发 AT^DSFLOWCLR', /sendCommand\('AT\^DSFLOWCLR'\)/.test(nsSrc));
ok('清零后立刻重取流量并重绘', /getFlow\(\)\.then\(renderFlow\)/.test(nsSrc));
ok('ADC 用 AT^ADCREADEX=', /sendCommand\('AT\^ADCREADEX=' \+ id\)/.test(nsSrc));
ok('ADC 管脚数量不写死（逐个试、失败即停）',
	/var ADC_PIN_IDS = \[/.test(nsSrc) && /if \(v == null\) \{ stopped = true; return; \}/.test(nsSrc));
ok('★ ADC 进页面自动读一次（连上就调 readAdcPins，不用先点按钮）',
	/refreshAll\(\);[\s\S]{0,300}readAdcPins\(\);/.test(nsSrc));
ok('ADC 有结果后按钮变「重新读取」',
	/t\.rows\.length \? '重新读取' : '读取'/.test(nsSrc));
ok('★ ADC 结果一行铺开（不再用「管脚/电平」表格，省掉表头 + N 行）',
	/mt5700-readouts/.test(nsSrc)
	&& !/Mt5700\.table\(\['管脚', '电平'\]/.test(nsSrc));
/* 2026-09-18 真机反馈：一排读数被挤成竖向堆叠。根因是容器 .mt5700-grow
   （flex:1 1 240px）在窄栏里被压到内容宽度以下，再撞上 .mt5700-mono 的
   word-break:break-all，「ADC0 1799」就地断行。这三行是防回退的钉子。 */
ok('★ ADC 胶囊不许被压扁（flex:0 0 auto + nowrap）',
	/\.mt5700-readout \{[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;/.test(cssSrc));
ok('★ ADC 读数容器允许整块换行而不是压扁子项（min-width:0）',
	/\.mt5700-readouts \{[\s\S]*?flex-wrap: wrap;[\s\S]*?min-width: 0;/.test(cssSrc));
ok('★ ADC 不再复用 .mt5700-grow（正是它把一排压成了竖排）',
	!/mt5700-inline mt5700-grow/.test(nsSrc));

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

/* ---------- 9. 网络设置页「网络拒绝」卡（^REJINFO 迁移后的归宿） ---------- */

ok('网络设置页有「网络拒绝」卡', /Mt5700\.card\('网络拒绝'/.test(setSrc));
ok('★ 只订阅 URC，不下发任何 ^REJINFO 命令（手册无读/设置命令）',
	!/sendCommand\('AT\^?REJINFO/.test(setSrc)
	&& /AtWs\.client\.subscribe\(rejectHandler\)/.test(setSrc)
	&& /resp\.data\.type === 'REJINFO'/.test(setSrc));
ok('★ 离线时也要 unsubscribe（否则反复进出叠加订阅）',
	/_dispose[\s\S]{0,300}AtWs\.client\.unsubscribe\(rejectHandler\)/.test(setSrc));
ok('没上报时给出「尚无网络拒绝上报」并说明「没被拒绝就不会推」',
	/Mt5700\.empty\('尚无网络拒绝上报'\)/.test(setSrc)
	&& /没被拒绝就不会推/.test(setSrc));
ok('有上报时铺成表格（时间/PLMN/域/制式/拒绝类型/原因）',
	/Mt5700\.table\(\['项目', '值'\], rows, \{ striped: true \}\)/.test(setSrc)
	&& /\['拒绝类型', r\.rejectTypeText\]/.test(setSrc)
	&& /\['原因', E\('b'/.test(setSrc));
ok('给出常见原因值的解读（#7/#8/#11/#12/#15）',
	/#7\/#8 多为核心网未开通 5G/.test(setSrc));
ok('指回本页的排查手段（邻区扫描 / 锁频设置）',
	/邻区扫描/.test(setSrc) && /锁频设置/.test(setSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（连接工具：解析 / 自检判据 / 快照脱敏 / 不占通道底线 / 网络拒绝归位 / 沿用契约）');
