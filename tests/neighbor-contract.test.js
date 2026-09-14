#!/usr/bin/env node
'use strict';

/**
 * 邻区扫描契约测试
 *
 * 钉住两个「看起来像 bug、其实是数据源边界」的问题，以及一个真实的丢数据 bug。
 *
 *   ① **邻区带宽只能推，不能查**
 *      ^MONNC 与 ^NRSSBID 都不报邻区带宽：3GPP 上 UE 压根不读邻区 SIB1
 *      （frequencyInfoDL 才带 bandwidth），本模组 238 条命令也没有任何一条暴露它。
 *      唯一可靠来源是 ^HFREQINFO 的**当前工作载波** —— 若邻区 SSB 频点落在该载波
 *      下行频带内，它与该载波同频同带宽，可以如实标注；落在工作载波之外的异频
 *      邻区（本机 n28 / n79）必须显示「—」，**绝不能猜一个数填上去**。
 *
 *   ② **SSB 邻区不带 RSRQ**
 *      手册 13.28 的邻区字段只有 <NB_PCI>,<NB_ARFCN>,<NB_RSRP>,<NB_SINR> + 波束，
 *      **没有 RSRQ**。旧代码在 SSB 行硬编码 `rsrq: null`，表现为整列「—」。
 *      实测本机 4 个 SSB 邻区全部能按 (ARFCN, PCI) 在 ^MONNC 里找到同一小区
 *      （MONNC 的 PCI 是十六进制、NRSSBID 是十进制，解析后数值一致），
 *      因此 RSRQ 从 MONNC 关联回填。
 *
 *   ③ **旧代码把 SSB 邻区连波束一起丢了**
 *      旧逻辑 `if (seen[k]) return;` 命中就整条丢弃。实测 4 个 SSB 邻区**全部**
 *      被丢弃，波束数据（SSB 独有、别处拿不到）也随之消失。改后命中即合并：
 *      不重复成行，但把波束挂上去，并补齐 MONNC 缺测的 RSRP/SINR。
 *
 * 用法：node tests/neighbor-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs/luci-static/resources');
const SETTINGS_JS = path.join(RES, 'view/at-webserver/network_settings.js');

const settingsJs = fs.readFileSync(SETTINGS_JS, 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

function extractFunction(src, signature) {
	const start = src.indexOf('function ' + signature);
	if (start < 0) return '';
	let depth = 0;
	for (let i = src.indexOf('{', start); i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	return '';
}

/* 在 vm 里加载 LuCI 风格的类文件（'require baseclass' + L.Class.extend），返回内部对象 */
function loadLuciModule(relPath, returnExpr) {
	let src = fs.readFileSync(path.join(RES, 'at-webserver', relPath), 'utf8');
	src = src.replace(/^\s*'require [^']*';\s*$/gm, '');
	const ctx = {
		console,
		L: {
			Class: { extend: (x) => x },
			rpc: { declare: () => function () { return Promise.resolve({}); } },
			uci: { load: () => Promise.resolve() }
		},
		window: undefined
	};
	vm.createContext(ctx);
	return vm.runInContext('(function(){\n' + src + '\nreturn ' + returnExpr + ';\n})()', ctx);
}

/* ---------- A. 邻区带宽列 ---------- */

const bwFn = extractFunction(settingsJs, 'neighborBandwidth(rat, arfcn)');
ok('存在 neighborBandwidth 函数', bwFn.length > 0);
ok('邻区表已加入「带宽」列',
	/\['制式',\s*'频段',\s*'ARFCN',\s*'SCS',\s*'带宽'/.test(settingsJs), '表头缺少「SCS/带宽」');
ok('邻区行确实输出带宽值', /fmtBw\(neighborBandwidth\(c\.rat, c\.arfcn\)\)/.test(settingsJs));
ok('存在 fmtBw 格式化（kHz → MHz）', /function fmtBw\(khz\)/.test(settingsJs));
ok('fmtBw 对空值返回占位符「—」', /if \(khz == null\) return '—';/.test(settingsJs));

ok('带宽按「频点落在载波下行频带内」判定', /Math\.abs\(mhz - c\.dlFreqMHz\) <= c\.dlBwKHz \/ 2000/.test(bwFn),
	'半宽判定式不对（dlBwKHz/2 换算 MHz 应为 /2000）');
ok('非 NR（LTE）不套用 NR 载波表', /if \(rat !== 'NR'/.test(bwFn));
ok('载波为空时直接返回 null', /!hfreqCarriers\.length\) return null/.test(bwFn));
ok('匹配不到时返回 null 而不是猜一个数', /return null;\s*\}\s*$/.test(bwFn.replace(/\s+$/, '')),
	'末条分支必须 return null');
ok('只认 NR 载波（跳过 LTE 行）', /c\.sysMode !== 'NR'/.test(bwFn));

const loadNeighbors = extractFunction(settingsJs, 'loadNeighbors()');
ok('扫描时会拉取 ^HFREQINFO?（带宽的唯一来源）', /AT\^HFREQINFO\?/.test(loadNeighbors));
ok('^HFREQINFO 失败时降级为空数组，不拖垮邻区',
	/hfreqCarriers = \(res && res\.success && res\.data\)/.test(loadNeighbors) &&
	/: \[\]/.test(loadNeighbors), '未做失败降级');

/* ---------- A2. SCS（子载波间隔）列 ---------- */

const scsFn = extractFunction(settingsJs, 'neighborScs(rat, arfcn)');
ok('存在 neighborScs 函数', scsFn.length > 0);
ok('邻区行输出 SCS 值', /fmtScs\(neighborScs\(c\.rat, c\.arfcn\)\)/.test(settingsJs));
ok('LTE 不套用 NR 的 SCS 规则', /if \(rat !== 'NR'\) return null;/.test(scsFn));
ok('同频邻区复用 ^MONSC 实测值（按 channel 比对）',
	/servingCell\.channel != null/.test(scsFn) && /measured: true/.test(scsFn),
	'必须用 parseMONSC 的 channel 字段（不是 arfcn）');
ok('异频邻区按频段推断并标注 measured:false',
	/Parse\.getDefaultScsType\(band\)/.test(scsFn) && /measured: false/.test(scsFn));
ok('未知频段返回 null 而不是编一个值', /if \(band == null\) return null;/.test(scsFn));
ok('推断值带「*」标记以便与实测区分', /label \+ ' \*'/.test(settingsJs));
ok('扫描时会拉取 ^MONSC（实测 SCS 的唯一来源）', /AT\^MONSC/.test(loadNeighbors));
ok('锁频时优先用实测 SCS 而非按频段猜',
	/var scsInfo = neighborScs\(cell\.rat, cell\.arfcn\);/.test(settingsJs) &&
	/scsInfo \? scsInfo\.scs : Parse\.getDefaultScsType\(band\)/.test(settingsJs));

/* ---------- A3. 取数链：任一命令失败不得毁掉整表 ---------- */

ok('取数改为逐项兜错（不是链尾单个 catch）',
	/neighFailures\[job\.key\] = true/.test(settingsJs),
	'仍是串行 + 链尾单 catch，一条命令失败整表空白');
ok('失败标记有对应的人话说明', /names = \{ MONNC:/.test(settingsJs));
ok('渲染不依赖取数成功（失败也 renderNeighbors）',
	/renderNeighbors\(\);/.test(settingsJs.slice(settingsJs.indexOf('function loadNeighbors'))),
	'renderNeighbors 未在兜底后调用');

/* ---------- A4. 未测量的占位行 ---------- */

ok('三列信号全空的填充行不再占版面',
	/c\.rsrp == null && c\.rsrq == null && c\.sinr == null\) unmeasured\+\+/.test(settingsJs));
ok('被折叠的行有明确说明（避免被读成界面丢数据）',
	/个小区模组只上报了邻区关系、未给出测量值/.test(settingsJs));

/* ---------- B. SSB 邻区 RSRQ 回填与波束保留 ---------- */

ok('不再用「命中就整条丢弃」的旧去重写法', !/if \(seen\[k\]\) return;/.test(settingsJs),
	'仍存在 if (seen[k]) return;，SSB 邻区会被连同波束一起丢掉');

/*
 * 命中分支必须「先合并、再跳出」：旧写法命中就 return，看似去重，实际把 SSB
 * 独有的波束一起丢了。跳出迭代的 return 本身是合法的（不落进未命中分支），
 * 因此判据是合并动作必须排在第一个 return 之前。
 */
const hitBranch = (function () {
	const start = settingsJs.indexOf('if (byCell[k]) {');
	const end = settingsJs.indexOf('byCell[k] = n;', start);
	return start >= 0 && end > start ? settingsJs.slice(start, end) : '';
})();
ok('能定位到 SSB 命中分支', hitBranch.length > 0);
const mergeAt = hitBranch.indexOf('merged.forEach(');
const returnAt = hitBranch.indexOf('return;');
ok('命中分支先合并再跳出（合并动作排在第一个 return 之前）',
	mergeAt >= 0 && (returnAt < 0 || mergeAt < returnAt),
	'合并排在 return 之后，SSB 邻区会被整条丢弃');
ok('建立了 MONNC 索引用于关联', /var byCell = \{\}/.test(settingsJs) && /byCell\[k\] = c;/.test(settingsJs));
ok('SSB 命中同一小区时把波束挂到已有行上', /row\.beams = n\.beams;/.test(settingsJs));
ok('SSB 可补齐 MONNC 缺测的 RSRP', /if \(row\.rsrp == null\) row\.rsrp = n\.rsrp;/.test(settingsJs));
ok('SSB 可补齐 MONNC 缺测的 SINR', /if \(row\.sinr == null\) row\.sinr = n\.sinr;/.test(settingsJs));
ok('合并行标注来源，避免误以为是纯 MONNC 数据', /row\.src = 'MONNC\+SSB';/.test(settingsJs));
ok('SSB 独有的邻区仍然单独成行', /src: 'SSB', beams: n\.beams/.test(settingsJs));
ok('制式列对 SSB 独有行保留（SSB）后缀', /c\.src === 'SSB' \? '（SSB）' : ''/.test(settingsJs));
ok('向用户说明 RSRQ 的来源与关联方式',
	/已按 ARFCN\+PCI 关联回填/.test(settingsJs), '缺少 RSRQ 来源说明');

/* ---------- C. 真机样本：解析层事实 ---------- */

const Parse = loadLuciModule('parse.js', 'Parse');
const AtWs = loadLuciModule('rpc.js', '{ parseHFREQINFO: parseHFREQINFO }');

/* 本机 2026-09-15 实采：^MONNC 14 行 / ^NRSSBID 4 邻区 / ^HFREQINFO 双载波 */
const MONNC = [
	'^MONNC: NR,524910,56,-84,-12,0',
	'^MONNC: NR,524910,115,-157,-44,-24',
	'^MONNC: NR,524910,55,-77,-10,4',
	'^MONNC: NR,524910,17F,-157,-44,-24',
	'^MONNC: NR,723360,41,-124,-13,0',
	'^MONNC: NR,152650,39,-81,-10,7',
	'^MONNC: NR,152650,3A,-87,-11,10',
	'^MONNC: NR,152650,164,-157,-44,-24'
].join('\r\n');

const NRSSBID = '^NRSSBID: 524910,0000000c027f5065,276,-76,17,-1,3,-71,4,-77,2,-77,1,-83,5,-84,0,-80,6,-93,7,-89,4,'
	+ '85,524910,-77,4,7,-84,0,-89,2,-76,3,-76,'
	+ '57,152650,-81,7,1,-81,255,32767,255,32767,255,32767,'
	+ '86,524910,-84,0,7,-84,6,-96,5,-92,1,-98,'
	+ '58,152650,-87,10,2,-87,255,32767,255,32767,255,32767';

const HFREQ = '^HFREQINFO: 0,7,41,528960,2644800,60000,528960,2644800,60000,41,513000,2565000,100000,0,0,1400';

const monnc = Parse.parseMonncAll(MONNC);
const ssb = Parse.parseNrssbid(NRSSBID);
const carriers = AtWs.parseHFREQINFO(HFREQ);

ok('^MONNC 解析出预期条数', monnc.length === 8, '实际 ' + monnc.length);
ok('^MONNC 的 PCI 按十六进制解析（0x56 → 86）',
	monnc.some((c) => c.arfcn === 524910 && c.pci === 86), '0x56 未解析为 86');
ok('^MONNC 的 PCI 十六进制带字母也正确（0x3A → 58）',
	monnc.some((c) => c.arfcn === 152650 && c.pci === 58), '0x3A 未解析为 58');
ok('^MONNC 无效值（-157/-44）被判为无测量',
	monnc.filter((c) => c.pci === 277).every((c) => c.rsrp === null && c.rsrq === null),
	'无效值没有被置空');

ok('^NRSSBID 解析出 4 个邻区', ssb && ssb.neighbors.length === 4,
	ssb ? '实际 ' + ssb.neighbors.length : '解析失败');
ok('^NRSSBID 邻区确实不带 RSRQ（手册 13.28 无此字段）',
	ssb.neighbors.every((n) => n.rsrq === undefined), '固件若新增 RSRQ，解析层需要同步');
ok('^NRSSBID 邻区带波束数据', ssb.neighbors.every((n) => Array.isArray(n.beams) && n.beams.length > 0));

/* 关键事实：MONNC 的十六进制 PCI 与 NRSSBID 的十进制 PCI 数值一致，才能按 (ARFCN,PCI) 关联 */
const idx = {};
monnc.forEach((c) => { idx[c.rat + '|' + c.arfcn + '|' + c.pci] = c; });
let hit = 0;
const filled = [];
ssb.neighbors.forEach((n) => {
	const m = idx['NR|' + n.arfcn + '|' + n.pci];
	if (m) { hit++; filled.push({ pci: n.pci, rsrq: m.rsrq }); }
});
ok('4 个 SSB 邻区全部能在 ^MONNC 里找到同一小区（RSRQ 回填可行）',
	hit === 4, '实际命中 ' + hit + '/4');
ok('回填得到的 RSRQ 都是有效值', filled.every((f) => f.rsrq != null),
	JSON.stringify(filled));

ok('^HFREQINFO 解析出 2 个载波', carriers.length === 2, '实际 ' + carriers.length);
ok('主载波带宽 60000 kHz（60 MHz）', carriers[0] && carriers[0].dlBwKHz === 60000);
ok('辅载波带宽 100000 kHz（100 MHz）', carriers[1] && carriers[1].dlBwKHz === 100000);

/* 带宽推断：复刻 network_settings.js 的判定式，校验真机样本结论 */
function bwOf(rat, arfcn) {
	if (rat !== 'NR' || !carriers.length) return null;
	const mhz = Parse.nrArfcnToMHz(arfcn);
	if (mhz == null) return null;
	for (const c of carriers) {
		if (c.sysMode !== 'NR' || !c.dlBwKHz || c.dlFreqMHz == null) continue;
		if (Math.abs(mhz - c.dlFreqMHz) <= c.dlBwKHz / 2000) return c.dlBwKHz;
	}
	return null;
}

ok('同载波邻区 524910（2624.55 MHz 落在 CC0 内）→ 60 MHz',
	bwOf('NR', 524910) === 60000, '实际 ' + bwOf('NR', 524910));
ok('异频邻区 152650（n28）不在任何工作载波内 → null（不编造）',
	bwOf('NR', 152650) === null, '实际 ' + bwOf('NR', 152650));
ok('异频邻区 723360（n79）不在任何工作载波内 → null（不编造）',
	bwOf('NR', 723360) === null, '实际 ' + bwOf('NR', 723360));
ok('LTE 邻区不套用 NR 载波表 → null', bwOf('LTE', 1850) === null);

/* ---------- D. 辅载波刷新链路（网络状态页「载波与聚合」） ---------- */

const statusJs = fs.readFileSync(path.join(RES, 'view/at-webserver/network_status.js'), 'utf8');

/*
 * ① 慢档链过去是 `chain.then(a).then(b)…` 末尾挂**一个** catch：任何一步 reject，
 *    后面全部静默跳过（含 loadSecondary），界面毫无提示 —— 正是「辅载波一直不刷新」
 *    的根因。改为每环节各自兜错后，单点失败只丢那一项。
 */
ok('慢档任务收敛为显式数组 SLOW_TASKS', /var SLOW_TASKS = \[/.test(statusJs));
ok('辅载波任务排在慢档首位（不再等前面 8 个任务串行走完）',
	/var SLOW_TASKS = \[loadSecondary,/.test(statusJs),
	'loadSecondary 不在首位，首屏要空等一轮才出辅载波读数');
ok('慢档每个环节各自兜错，而非链尾单个 catch',
	/\.then\(fn\)\s*\n?\s*\.catch\(function \(err\) \{ slowFailures/.test(statusJs),
	'未做逐步兜错，单点失败会静默跳过后续任务');
/* 快档只有一个任务，链尾 catch 无妨；这里只针对慢档（多任务串联） */
const refreshSlowFn = extractFunction(statusJs, 'refreshSlow()');
ok('能定位到 refreshSlow 函数', refreshSlowFn.length > 0);
ok('慢档链不再用链尾 catch 一把兜',
	!/chain\.catch\(/.test(refreshSlowFn), '慢档仍是链尾单个 catch，单点失败会跳过后续任务');
ok('保留失败留痕 slowFailures，避免退化成看不见的静默问题',
	/var slowFailures = \{\};/.test(statusJs));
ok('辅载波拉取成功后抹掉失败留痕', /delete slowFailures\.loadSecondary;/.test(statusJs));

/* ② 辅载波的 RSRQ 同样来自 MONNC 关联 */
ok('网络状态页也有 monncRsrq 回填函数', /function monncRsrq\(nb\)/.test(statusJs));
ok('辅载波不再把 RSRQ 硬编码为 null',
	/rsrq: monncRsrq\(nb\)/.test(statusJs) && !/rsrq: null, sinr: nb\.sinr/.test(statusJs),
	'仍在写 rsrq: null');
ok('辅载波数据拉取时会查 ^MONNC（RSRQ 来源）',
	/sendCommand\('AT\^MONNC'\)/.test(statusJs));
ok('state 提供 monnc 字段', /monnc: \[\],/.test(statusJs));
ok('monncRsrq 按 ARFCN+PCI 精确匹配（不对不上就用别的小区顶替）',
	/c\.arfcn === nb\.arfcn && c\.pci === nb\.pci/.test(statusJs));
ok('monncRsrq 只认 NR 邻区', /c\.rat === 'NR'/.test(statusJs));

/*
 * ③ ^NRSSBID 只报「按波束能量排序的前 4 个」小区，辅载波上的小区常常排不进去
 *    （本机 9 次采样只有 1 次命中）。整行空白容易被误读成「没刷新」，必须写清原因。
 */
ok('辅载波匹配不到邻区时给出解释，而不是留一片空白',
	/前 4 强邻区都不在辅载波频带内/.test(statusJs));
ok('文案明确说明这是命令局限而非刷新失败',
	/不是刷新失败/.test(statusJs));

/* ---------- 汇总 ---------- */

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('邻区扫描契约测试全部通过');
