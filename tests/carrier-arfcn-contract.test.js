#!/usr/bin/env node
/*
 * 载波 ARFCN 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 固定「每个载波行显示的 ARFCN 必须是该载波的 SSB 频点」这条约定。
 *
 * 背景（两次真实报障）：
 *   1) 主载波曾直接显示 ^HFREQINFO 的 <dl_fcn>，那是**载波中心**不是服务小区频点，
 *      与手机工程软件对不上（本机 528960 vs 524910）；
 *   2) 修好主载波后，辅载波仍在用 <dl_fcn>（513000），同样对不上手机（504990）。
 *
 * 取值规则落在 network_status.js 的 ssbFcn(c) 里（renderCarriers 的闭包内，
 * DOM 环境才跑得起来），这里按 parse-contract 的办法把函数源码抠出来，
 * 连同它依赖的 nrssbidMatch 一起求值，用真机原文验证。
 *
 * 用例数据全部是 2026-09-16 真机只读抓取（MT5700M-CN，n41 双载波聚合）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');

const nsSrc = fs.readFileSync(NS, 'utf8');
const pSrc = fs.readFileSync(PARSE, 'utf8');
const rSrc = fs.readFileSync(RPC, 'utf8');

const Parse = eval('(' + pSrc.match(/var Parse = \((function[\s\S]*?\n\})\)\(\);/)[1] + ')')();

function grab(name, src) {
	const i = src.indexOf('function ' + name + '(');
	if (i < 0) throw new Error('源码里找不到函数 ' + name);
	let depth = 0, started = false;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
	}
	throw new Error('函数体括号不配对：' + name);
}

const parseHFREQINFO = eval('(function(){' +
	rSrc.match(/var HFREQ_SYS_MODE = \{[^}]*\};/)[0] + '\n' +
	['extractATData', 'extractATDataMultiline', 'parseHFREQINFO'].map((n) => grab(n, rSrc)).join('\n') +
	'\nreturn parseHFREQINFO;})()');

const parseMONSC = eval('(function(){' + ['extractATData', 'calculateSignalPercent', 'convertRsrp',
	'convertRsrq', 'convertSinr', 'parseMONSC'].map((n) => grab(n, rSrc)).join('\n') +
	'\nreturn parseMONSC;})()');

/*
 * 组装 ssbFcn 的闭包：它需要 c0（^MONSC 主小区）、state.nrssbid、Parse、nrssbidMatch。
 * 每次调用都重新构造，方便逐场景切换输入。
 */
function makeSsbFcn(cellChannel, nrssbid) {
	const scope = 'var c0 = ' + JSON.stringify({ channel: cellChannel }) + ';\n' +
		'var state = ' + JSON.stringify({ nrssbid: nrssbid }) + ';\n' +
		'var Parse = __Parse;\n' +
		grab('nrssbidMatch', nsSrc) + '\n' +
		grab('ssbFcn', nsSrc) + '\n' +
		'return ssbFcn;';
	return new Function('__Parse', scope)(Parse);
}

let pass = 0;
const fails = [];
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* ---------- 真机原文（2026-09-16 13:2x，n41 双载波聚合，只读抓取） ---------- */
const HFREQ_CA = '^HFREQINFO: 0,7,41,528960,2644800,60000,528960,2644800,60000,' +
	'41,513000,2565000,100000,0,0,1400';
const MONSC_CA = '^MONSC: NR,460,00,524910,1,C027F5065,114,14225C,-74,-9,17';
const SSBID_CA = '^NRSSBID: 524910,0000000c027f5065,276,-74,17,-1,' +
	'3,-68,4,-77,2,-74,5,-82,1,-81,0,-82,6,-90,7,-90,' +
	'4,' +
	'276,504990,-80,19,4,-78,0,-84,3,-88,2,-90,' +
	'85,524910,-82,0,7,-90,6,-100,2,-90,3,-82,' +
	'85,504990,-87,1,3,-87,2,-92,4,-93,7,-99,' +
	'86,524910,-89,1,7,-89,6,-97,0,-96,255,32767';

const ccList = parseHFREQINFO(HFREQ_CA);
const ccCell = parseMONSC(MONSC_CA);
const ccSsb = Parse.parseNrssbid(SSBID_CA);

eq('双载波：^HFREQINFO 解析出 2 个载波', ccList.length, 2);
eq('双载波：第 1 载波中心 528960 / 2644.8 MHz / 60 MHz',
	[ccList[0].dlFcn, ccList[0].dlFreqMHz, ccList[0].dlBwKHz], [528960, 2644.8, 60000]);
eq('双载波：第 2 载波中心 513000 / 2565 MHz / 100 MHz（仅下行）',
	[ccList[1].dlFcn, ccList[1].dlFreqMHz, ccList[1].dlBwKHz, ccList[1].downlinkOnly],
	[513000, 2565, 100000, true]);
eq('双载波：^MONSC 服务小区频点 524910', ccCell.channel, '524910');

const caF = makeSsbFcn(ccCell.channel, ccSsb);
eq('★ 主载波 ARFCN 取 ^MONSC 服务小区 524910（不是载波中心 528960）',
	caF(ccList[0]), { fcn: 524910, from: 'cell' });
eq('★ 辅载波 ARFCN 取 ^NRSSBID 配对到的 SSB 504990（不是载波中心 513000）',
	caF(ccList[1]), { fcn: 504990, from: 'ssbid' });

/* ---------- 单载波（2026-09-16 00:0x 抓取）：SSB 落在 100 MHz 载波内 ---------- */
const HFREQ_1 = '^HFREQINFO: 0,7,41,513000,2565000,100000,513000,2565000,100000';
const MONSC_1 = '^MONSC: NR,460,00,504990,1,C027F5001,114,14225C,-77,-10,10';
const cc1 = parseHFREQINFO(HFREQ_1);
eq('单载波：解析出 1 个载波', cc1.length, 1);
eq('★ 单载波 ARFCN 取 ^MONSC 服务小区 504990',
	makeSsbFcn(parseMONSC(MONSC_1).channel, null)(cc1[0]), { fcn: 504990, from: 'cell' });

/* ---------- 测不到 SSB 时必须退回载波中心，并如实标记来源 ---------- */
eq('无 ^MONSC / 无 ^NRSSBID 时退回 <dl_fcn> 且 from=center',
	makeSsbFcn(null, null)(ccList[1]), { fcn: 513000, from: 'center' });

/* ^NRSSBID 只报前 4 强邻区，辅载波上的小区常排不进去（本机 9 次采样命中 1 次） */
const SSBID_OTHER = '^NRSSBID: 524910,0000000c027f5065,276,-74,17,-1,' +
	'3,-68,4,-77,2,-74,5,-82,1,-81,0,-82,6,-90,7,-90,' +
	'2,' +
	'85,524910,-82,0,7,-90,6,-100,2,-90,3,-82,' +
	'86,524910,-89,1,7,-89,6,-97,0,-96,255,32767';
eq('邻区都不在辅载波带内时退回载波中心（from=center，提示行据此提醒）',
	makeSsbFcn('524910', Parse.parseNrssbid(SSBID_OTHER))(ccList[1]), { fcn: 513000, from: 'center' });

/* ---------- LTE：<channel> 是 EARFCN，不能按 NR 全局栅格换算，一律不参与匹配 ---------- */
const HFREQ_LTE = '^HFREQINFO: 0,6,3,1650,18400,20000,1650,18400,20000';
const lteList = parseHFREQINFO(HFREQ_LTE);
eq('LTE：解析出 1 个载波且 sysMode=LTE', [lteList.length, lteList[0].sysMode], [1, 'LTE']);
eq('★ LTE 行直接用 <dl_fcn>（EARFCN 无偏移表，绝不拿 NR 的 /200 换算去匹配）',
	makeSsbFcn('1650', ccSsb)(lteList[0]), { fcn: 1650, from: 'center' });

/* ---------- 源码结构守卫：防止 ssbFcn 被删、或被内层同名函数遮蔽 ----------
 * 上次出过「renderCarriers 内残留同名 freqCell 遮蔽外层实现 → 频点恒「—」」，
 * 静态断言挡不住运行期遮蔽，但至少能挡住重复定义这一种。 */
const defines = nsSrc.match(/function ssbFcn\(/g) || [];
eq('ssbFcn 在 network_status.js 里只定义一次（防遮蔽）', defines.length, 1);
eq('渲染处确实调用了 ssbFcn(c)', /var f = ssbFcn\(c\);/.test(nsSrc), true);
eq('不再有「主载波行硬取 c0.channel」的旧写法', /i === 0 && c0\.channel/.test(nsSrc), false);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('载波 ARFCN 契约测试全部通过');
