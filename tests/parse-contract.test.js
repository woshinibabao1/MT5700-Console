#!/usr/bin/env node
/*
 * 解析契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 用途：把「AT 应答 → 解析结果」的约定固定下来，防止再出现字段错位/进制读错这类回归。
 * 用例里的应答串全部是**真机实测抓下来的原文**（MT5700M-CN / V200R001C20B025）。
 *
 * 运行：node tests/parse-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const PARSE_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const RPC_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const src = fs.readFileSync(PARSE_JS, 'utf8');
const m = src.match(/var Parse = \((function[\s\S]*?\n\})\)\(\);/);
if (!m) {
	console.error('无法从 parse.js 中提取解析模块');
	process.exit(1);
}
/* eslint-disable no-eval */
const Parse = eval('(' + m[1] + ')')();

/*
 * ^MONSC 的解析在 rpc.js（模块私有函数，前端经 AtWs.parseMONSC 使用），
 * 这里按名字把函数源码抠出来，与它依赖的辅助函数一起求值，单独覆盖。
 */
const rpcSrc = fs.readFileSync(RPC_JS, 'utf8');
function grabFn(name) {
	const i = rpcSrc.indexOf('function ' + name + '(');
	if (i < 0) return '';
	/* 从函数头开始做花括号配对，取完整函数体 */
	let depth = 0, started = false;
	for (let j = i; j < rpcSrc.length; j++) {
		const c = rpcSrc[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return rpcSrc.slice(i, j + 1); }
	}
	return '';
}
const MONSC_SANDBOX = [
	'extractATData', 'calculateSignalPercent', 'convertRsrp', 'convertRsrq', 'convertSinr', 'parseMONSC'
].map(grabFn).join('\n');
if (!MONSC_SANDBOX || MONSC_SANDBOX.indexOf('parseMONSC') < 0) {
	console.error('无法从 rpc.js 提取 parseMONSC');
	process.exit(1);
}
const parseMONSC = eval('(function(){' + MONSC_SANDBOX + '\nreturn parseMONSC;})()');

let pass = 0;
const fails = [];
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* ---------- 1. ^MONSC：字段序随 RAT 不同，PCI/TAC 是十六进制 ---------- */
const MONSC_NR = '^MONSC: NR,460,00,524910,1,C027F5065,114,14225C,-73,-9,24';
const nr = parseMONSC(MONSC_NR);
eq('MONSC(NR) PCI 按十六进制', nr.pci, 276);          // 0x114
eq('MONSC(NR) ARFCN 归位 channel', nr.channel, '524910');
eq('MONSC(NR) TAC 在 lac 字段', nr.lac, '14225C');
eq('MONSC(NR) SCS', nr.scs, 1);
eq('MONSC(NR) Cell_ID', nr.cid, 'C027F5065');
eq('MONSC(NR) RSRP/RSRQ/SINR 直读', [nr.rsrp, nr.rsrq, nr.sinr], [-73, -9, 24]);

const MONSC_LTE = '^MONSC: LTE,460,00,1650,0C027F5065,58,14225C,-98,-14,-65';
const lte = parseMONSC(MONSC_LTE);
eq('MONSC(LTE) 无 SCS 字段，PCI 十六进制', [lte.pci, lte.scs, lte.channel], [88, null, '1650']);
eq('MONSC(LTE) RSSI', lte.rssi, -65);

/* ---------- 2. ^NRSSBID：服务小区 + 波束 + 邻区 ---------- */
const SSBID = '^NRSSBID: 524910,0000000c027f5065,276,-73,23,-1,' +
	'4,-69,3,-72,2,-75,1,-77,5,-85,0,-87,6,-89,7,-83,' +
	'4,' +
	'85,524910,-79,-2,7,-90,3,-77,2,-83,5,-98,' +
	'85,504990,-84,8,4,-92,2,-86,3,-83,7,-99,' +
	'276,504990,-85,6,4,-85,0,-89,3,-88,6,-100,' +
	'86,524910,-87,0,7,-87,6,-90,5,-91,255,32767';
const ssb = Parse.parseNrssbid(SSBID);
eq('NRSSBID 服务小区', [ssb.serving.pci, ssb.serving.arfcn, ssb.serving.rsrp, ssb.serving.sinr],
	[276, 524910, -73, 23]);
eq('NRSSBID 服务波束数（无效值丢弃）', ssb.serving.beams.length, 8);
eq('NRSSBID 邻区数', ssb.neighbors.length, 4);
eq('NRSSBID 邻区1', [ssb.neighbors[0].pci, ssb.neighbors[0].arfcn, ssb.neighbors[0].rsrp], [85, 524910, -79]);
eq('NRSSBID 邻区波束（4 束）', ssb.neighbors[0].beams.length, 4);
eq('NRSSBID.ARFCN→MHz', Number(Parse.nrArfcnToMHz(504990).toFixed(2)), 2524.95);

/* ---------- 3. ^MONNC：PCI 十六进制、无效码转 null ---------- */
const MONNC = '^MONNC: NR,524910,86,-89,-13,-1\n' +
	'^MONNC: NR,524910,277,-157,-44,-24\n' +
	'^MONNC: NR,152650,57,-81,-9,7\n' +
	'^MONNC: LTE,1650,58,-98,-14';
const monnc = Parse.parseMonncAll(MONNC);
eq('MONNC 条数', monnc.length, 4);
eq('MONNC PCI 十六进制', monnc[0].pci, 134);                     // 0x86
eq('MONNC 有效信号保留', [monnc[0].rsrp, monnc[0].rsrq, monnc[0].sinr], [-89, -13, -1]);
eq('MONNC 无效码 -157/-44/-24 转 null',
	[monnc[1].rsrp, monnc[1].rsrq, monnc[1].sinr], [null, null, null]);
eq('MONNC 频段反推', [monnc[0].band, monnc[2].band, monnc[3].band], [41, 28, 3]);

/* ---------- 4. 注册/连接状态 ---------- */
eq('CEREG 已注册', Parse.parseRegStat('+CEREG: 2,1', '+CEREG').statText, '已注册');
eq('CIREG IMS 已注册', Parse.parseCireg('+CIREG: 1,1').text, '已注册');
eq('RRCSTAT 连接态', [Parse.parseRrcstat('^RRCSTAT: 0,1').rrcText,
	Parse.parseRrcstat('^RRCSTAT: 1,0,99').campText], ['连接态', '未驻留']);

/* ---------- 5. SYSCFGEX 解码（含 32 位位运算陷阱） ---------- */
eq('接入次序 080302', Parse.decodeAcqOrder('080302'), 'NR → LTE → WCDMA');
eq('频段位图包含 WCDMA VIII 900（第 49 位，不能用 & 判）',
	Parse.decodeBandMask('2000000680380').indexOf('WCDMA VIII (900)') >= 0, true);
eq('LTE 频段位图', Parse.decodeLteBandMask('1E200000095'),
	'B1, B3, B5, B8, B34, B38, B39, B40, B41');

/* ---------- 5b. SYSCFGEX 回读解析：尾部 \r\nOK 不得混入字段 ----------
 * 真机应答最后一段没有逗号收尾，早期用 ([^,]*) 抓取会把 "\r\nOK" 一起吞进来；
 * 而「漫游设置」页会把回读值原样拼回 AT 命令，带换行会把命令行截断成两条。
 */
const SYSCFGEX_REAL = '^SYSCFGEX: "080302",2000000680380,1,2,1E200000095\r\nOK';
const sys = Parse.parseSysCfg(SYSCFGEX_REAL);
eq('SYSCFGEX 解析非空', !!sys, true);
eq('SYSCFGEX 接入次序', sys.acqorder, '080302');
eq('SYSCFGEX GSM/WCDMA 频段位图', sys.band, '2000000680380');
eq('SYSCFGEX 漫游 / 服务域为数字', [sys.roam, sys.srvdomain], [1, 2]);
eq('SYSCFGEX LTE 频段位图不带 \\r\\nOK', sys.lteband, '1E200000095');
eq('SYSCFGEX 无应答时返回 null', Parse.parseSysCfg('OK'), null);

const rebuilt = Parse.buildSysCfgCommand(sys);
eq('回读后拼回的命令不含换行', /[\r\n]/.test(rebuilt), false);
eq('回读后拼回的命令逐字段与原值一致', rebuilt,
	'AT^SYSCFGEX="080302",2000000680380,1,2,1E200000095,,');

/* ---------- 6. COPS / VERSION ---------- */
const cops = Parse.parseCops('+COPS: 0,0,"CHINA MOBILE",12');
eq('COPS 自动选网', [cops.modeText, cops.oper, cops.actText], ['自动选网', 'CHINA MOBILE', 'NR（5G）']);
const ver = Parse.parseVersion('^VERSION:BDT:Jan 28 2026, 18:42:02\n' +
	'^VERSION:EXTS:1.2.5.0(SP1C02)\n^VERSION:EXTH:MT5700M Ver.A\n' +
	'^VERSION:ROMSIZE:4Gbit\n^VERSION:RDV:RELEASE\nOK');
eq('VERSION 关键项', [ver.EXTS, ver.EXTH, ver.ROMSIZE, ver.RDV],
	['1.2.5.0(SP1C02)', 'MT5700M Ver.A', '4Gbit', 'RELEASE']);

/* ---------- 7. 已删除的功能不得复活（需先真机验证再重新引入） ---------- */
eq('USSD 解析已随功能移除', typeof Parse.parseUssd, 'undefined');
eq('USSD 组包已随功能移除', typeof Parse.buildUssdCommand, 'undefined');

/* ---------- 8. ^CGPADDR：真机把 IPv6 写成「16 段十进制点分」 ----------
 * 真机原文（2026-09-13 实测，cid=5）：
 *   +CGPADDR: 5,"36.9.129.90.51.117.63.92.24.212.187.187.170.233.248.14"
 * 这 16 个数是 IPv6 的 16 个字节的十进制写法，必须还原成 a:b:c:... 形式，
 * 否则界面会把这串数字原样显示给用户。
 */
const CGPADDR_REAL = '+CGPADDR: 1,"10.1.42.244"\r\n' +
	'+CGPADDR: 5,"36.9.129.90.51.117.63.92.24.212.187.187.170.233.248.14"\r\nOK';
const addrs = Parse.parseCgpaddr(CGPADDR_REAL);
eq('CGPADDR 条数', addrs.length, 2);
eq('CGPADDR cid=1 是 IPv4', [addrs[0].cid, addrs[0].address, addrs[0].family], [1, '10.1.42.244', 'IPv4']);
eq('CGPADDR cid=5 的 16 段十进制还原为 IPv6',
	[addrs[1].address, addrs[1].family], ['2409:815a:3375:3f5c:18d4:bbbb:aae9:f80e', 'IPv6']);
eq('CGPADDR 全零+末位 1 还原为 ::1', Parse.parseCgpaddr('+CGPADDR: 5,"0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1"')[0].address, '::1');
eq('CGPADDR 已是冒号形式的原样保留',
	Parse.parseCgpaddr('+CGPADDR: 3,"2409:815b:32e5:affd:18d4:b851:d701:dc4f"')[0].address,
	'2409:815b:32e5:affd:18d4:b851:d701:dc4f');

/* ---------- 9. ^NRRCCAPQRY 语法（手册 §13.26 / 真机实测） ----------
 * 只有 AT^NRRCCAPQRY=<mode> 形式；? 形式恒 ERROR。
 * 界面读的是 mode 2(VoNR) / 3(NR CA) / 5(DSS)。
 */
eq('NRRCCAPQRY=3 解析 NR CA', Parse.parseNrrcCapQry('^NRRCCAPQRY: 3,1,0,0,0,0,0,0,0,0,0,0', 3), 1);
eq('NRRCCAPQRY=2 解析 VoNR', Parse.parseNrrcCapQry('^NRRCCAPQRY: 2,1,0,0,0,0,0,0,0,0,0,0', 2), 1);
eq('NRRCCAPQRY=5 解析 DSS', Parse.parseNrrcCapQry('^NRRCCAPQRY: 5,1,0,0,0,0,0,0,0,0,0,0', 5), 1);

/* ---------- 10. +CMGL 状态位 <stat>（鼎桥手册 9.8 / 真机实测） ----------
 * 0=收到的未读短信，1=已读，2=存储的未发送，3=存储的已发送。
 * PDU 模式形如 `+CMGL: 1,0,,81`，文本模式形如 `+CMGL: 1,"REC UNREAD",...`。
 *
 * 重要前提：本模组的 +CMGL 与 +CMGR 在读取后都会把「未读」置为「已读」
 * （手册 9.8 / 9.10 明文），所以 unread=true 只会出现在「尚未被任何读取
 * 操作碰过」的短信上——这正是它需要被解析出来、而不是被丢掉的理由。
 */
const CMGL_PDU = '0891683108901705F16410A101968448007069740008629011221024233C0500035202025C0F7A0B5E8F62168005661F5DF4514B00410050005067E5770B548C4F7F752860A87684597D793C300262D265368BF756DE590D0052';
const cmglRead = Parse.parseCMGL('+CMGL: 1,1,,81\r\n' + CMGL_PDU + '\r\nOK');
const cmglUnread = Parse.parseCMGL('+CMGL: 1,0,,81\r\n' + CMGL_PDU + '\r\nOK');
eq('CMGL PDU 模式解析出 1 条（真机原文）', cmglRead.length, 1);
eq('CMGL PDU 索引不因新增状态位而错位', cmglRead[0] && cmglRead[0].index, 1);
eq('CMGL PDU stat=1（已读）unread=false', cmglRead[0] && cmglRead[0].unread, false);
eq('CMGL PDU stat=0（未读）unread=true', cmglUnread[0] && cmglUnread[0].unread, true);

const TXT_TAIL = ',"+8613800138000",,"25/09/10,10:30:00+32"\r\n你好\r\nOK';
const txtRead = Parse.parseCMGL('+CMGL: 1,"REC READ"' + TXT_TAIL);
const txtUnread = Parse.parseCMGL('+CMGL: 1,"REC UNREAD"' + TXT_TAIL);
eq('CMGL 文本模式 REC READ → unread=false', txtRead[0] && txtRead[0].unread, false);
eq('CMGL 文本模式 REC UNREAD → unread=true', txtUnread[0] && txtUnread[0].unread, true);
/* 文本模式第二字段以引号开头，不该被「数字状态位」正则命中而串味 */
eq('CMGL 文本模式不误判为 sent（type 仍 received）', txtRead[0] && txtRead[0].type, 'received');

/* 拿不到状态位时保守：宁可不标未读，也不能把已读的误标成未读 */
const cmglNoStat = Parse.parseCMGL('+CMGL: 1\r\n' + CMGL_PDU + '\r\nOK');
eq('CMGL 缺状态位时不标未读（保守）', cmglNoStat[0] && cmglNoStat[0].unread, false);

/* ---------- 汇总 ---------- */
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('parse.js 契约测试全部通过');
