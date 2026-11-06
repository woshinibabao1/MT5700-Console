#!/usr/bin/env node
'use strict';

/**
 * 邻区扫描契约测试
 *
 * 钉住两个「看起来像 bug、其实是数据源边界」的问题，以及一个真实的丢数据 bug。
 *
 *   ① **邻区「带宽」列已按产品决策移除**
 *      邻区带宽本来只能由 ^HFREQINFO 的**当前工作载波**推出来——^MONNC 与
 *      ^NRSSBID 都不报它（3GPP 上 UE 压根不读邻区 SIB1，frequencyInfoDL 才带
 *      bandwidth），落到工作载波之外的异频邻区（本机 n28 / n79）永远是「—」。
 *      信息量低，却要为它多发一条 AT（且 RRC null 态还会 ERROR），故整列连同
 *      推断函数与数据源一并删除，避免留下「只为一个不再显示的列服务」的死代码。
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

/* ---------- A. 邻区「带宽」列已移除 ---------- */

/*
 * 带宽列按产品决策移除。这里的断言不是走过场，而是防止它在别处复活：
 * ① 邻区带宽本来就只能由 ^HFREQINFO 的工作载波「推」出来，对异频邻区永远
 *    是「—」，信息量低；② 为它多发一条 AT（RRC null 态还会 ERROR）不划算。
 * 因此不仅删了显示，也删掉了为它服务的数据源与推断函数——否则会留下
 * 「有一条查询只为一个不再显示的列服务」的死代码。
 */
const loadNeighbors = extractFunction(settingsJs, 'loadNeighbors()');
ok('邻区表头不再有「带宽」列',
	!/\['制式',\s*'频段',\s*'ARFCN',\s*'SCS',\s*'带宽'/.test(settingsJs),
	'「带宽」列又回来了');
ok('表头保留 SCS 且与 PCI 相邻（删除未留下空列）',
	/\['制式',\s*'频段',\s*'ARFCN',\s*'SCS',\s*'PCI',/.test(settingsJs));
ok('邻区行不再输出带宽值', !/neighborBandwidth\(/.test(settingsJs));
ok('带宽推断函数已删除（不留死代码）',
	!/function neighborBandwidth\(/.test(settingsJs));
ok('邻区专用的 fmtBw 已删除',
	!/function fmtBw\(khz\)/.test(settingsJs),
	'fmtBw 若仍存在却无人调用，就是死代码（注意：载波表用的是 network_status.js 里另一份）');
ok('不再为带宽拉取 ^HFREQINFO（省一条 AT 往返）',
	!/AT\^HFREQINFO\?/.test(loadNeighbors),
	'邻区已不显示带宽，仍查 ^HFREQINFO 是纯浪费');
ok('hfreqCarriers 状态变量已删除', !/hfreqCarriers/.test(settingsJs));
ok('失败提示里不再提 ^HFREQINFO', !/HFREQINFO/.test(settingsJs));

/* 扫描只剩三个数据源：MONNC / NRSSBID / MONSC */
ok('邻区三个数据源齐全',
	/AT\^MONNC/.test(loadNeighbors) && /AT\^NRSSBID\?/.test(loadNeighbors) &&
	/AT\^MONSC/.test(loadNeighbors));
ok('数据源数量恰好为 3（多一个就是给废弃列服务）',
	(loadNeighbors.match(/cmd: 'AT/g) || []).length === 3,
	'实际 ' + (loadNeighbors.match(/cmd: 'AT/g) || []).length + ' 个');
ok('三个数据源仍各自兜错（少一个都不能整表空白）',
	/\.catch\(function \(\) \{ neighFailures\[job\.key\] = true; \}\)/.test(loadNeighbors));

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

/* ---------- A4. 未测量的占位行 ----------
 *
 * ★★ 2026-11-06 口径反转（用户原话：「邻区和 ssb 不允许隐藏要全部显示」）：
 *   原实现把「模组只报了邻区关系、RSRP/RSRQ/SINR 全是手册无效值」的行**吞掉**，
 *   只在表尾写一句「另有 N 个小区…故未列出——这不是界面丢数据」，后来还补了
 *   SCS/RSRQ 两段推导说明。用户看到的第一反应是「你丢了这么多小区」——
 *   而那句解释只证明了「不是 bug」，没有把行给回来。
 *
 *   而且吞掉它们是真的丢功能：**锁定只需要 ARFCN + PCI，根本不需要测量值**。
 *   现在全部列出、按强度排在末尾，信号三列显示「—」、强度列显示「未测量」，
 *   整行弱化（.mt5700-row-unmeasured）。
 *
 *   下面同时钉住正反两面：既要「用 merged 全量渲染」，也要「没有分流丢弃」。
 *   只写正向的话，将来把分流加回来但改个变量名，断言照样绿。
 */
ok('★ 邻区表用 merged 全量渲染，不分流丢弃未测量行',
	/merged\.length \+ ' 个，按信号强度排序）'/.test(settingsJs) &&
	/var rows = merged\.map\(/.test(settingsJs),
	'渲染源不是 merged —— 又按测量值分流了');
ok('★ 不再有「按三列信号分流 + 只留测过的」旧写法',
	!/unmeasured\+\+/.test(settingsJs) && !/shown\.push\(c\)/.test(settingsJs),
	'仍存在 unmeasured++ / shown.push(c) 分流');
ok('★ 未测量行在强度列明确标注（不是留白让人以为丢数据）',
	/E\('span', \{ 'class': 'mt5700-hint' \}, '未测量'\)/.test(settingsJs));
ok('★ 未测量行整行弱化（否则与真数据行长得一样）',
	/'mt5700-row-unmeasured'/.test(settingsJs) && /rowClass/.test(settingsJs),
	'传了 rowClass 却没人消费 = 样式永远不生效');
/* ★ 剥注释再判：注释里**必须**保留被删文案的原文（否则下一个人不知道
 *   删的是什么、为什么删），只有字符串字面量里出现才算回流。 */
const NO_COMMENT = settingsJs
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/(^|[^:])\/\/.*$/gm, '$1');
ok('★ 被吞行的旧说明彻底删除（不是改成更短的说法）',
	!/故未列出/.test(NO_COMMENT) && !/这不是界面丢数据/.test(NO_COMMENT));

/* ---------- A5. rowClass 必须真的落到 <tr> 上 ----------
 *
 * 「参数传过去了」≠「消费方认」。2026-11-06 真踩：给 Mt5700.table 传了
 * options.rowClass，而组件**根本没读过这个字段** —— 表格照样渲染，只是没有
 * 任何一行被弱化。静态断言 `/rowClass/.test(src)` 全绿，界面却毫无变化；
 * 这正是红线 85「后端正确 ≠ 页面拿到」的同型问题（那一层是传输，这层是渲染）。
 *
 * 所以这里用最小 DOM stub **真跑一次** table()，直接查生成的 <tr> 类名。
 */
const MTJS = path.join(RES, 'at-webserver/mt5700.js');
const mtSrc = fs.readFileSync(MTJS, 'utf8').replace(/'require [^']*';/g, '');

function makeEl(tag) {
	const el = {
		tagName: tag, nodeType: 1, children: [], className: '', textContent: '',
		style: {}, _attrs: {},
		classList: {
			add: function (c) { el.className = (el.className + ' ' + c).trim(); },
			contains: function (c) { return el.className.split(/\s+/).indexOf(c) >= 0; }
		},
		appendChild: function (c) { el.children.push(c); return c; },
		setAttribute: function (k, v) { el._attrs[k] = v; },
		addEventListener: function () {}
	};
	return el;
}

function loadMt(src) {
	const ctx = {
		console: console,
		document: {
			querySelectorAll: function () { return []; },
			head: { appendChild: function () {} },
			createElement: makeEl,
			createTextNode: function (t) { return { nodeType: 3, textContent: t }; }
		},
		window: undefined,
		L: {
			Class: { extend: function (x) { return x; } },
			rpc: { declare: function () { return function () { return Promise.resolve({}); }; } },
			uci: { load: function () { return Promise.resolve(); } }
		}
	};
	vm.createContext(ctx);
	return vm.runInContext('(function(){\n' + src + '\nreturn Mt5700;\n})()', ctx);
}

function rowClasses(Mt) {
	const wrap = Mt.table(['a', 'b'], [['1', '2'], ['3', '4']], {
		rowClass: function (i) { return i === 1 ? 'mt5700-row-unmeasured' : ''; }
	});
	const tbody = wrap.children[0].children.filter(function (c) { return c.tagName === 'tbody'; })[0];
	return tbody.children.map(function (tr) { return tr.className; });
}

const cls = rowClasses(loadMt(mtSrc));
ok('★★ table 的 rowClass 真的落到 <tr> 上（不是只把参数传过去）',
	cls[0] === '' && cls[1] === 'mt5700-row-unmeasured',
	'实际类名：' + JSON.stringify(cls));

/* 反向自证：整块删掉后，上面那条必须判否 —— 否则它只是在查「字符串在不在」 */
const RC_MARK = "if (typeof options.rowClass === 'function') {";
const rcStart = mtSrc.indexOf(RC_MARK);
const rcTail = mtSrc.indexOf('if (extra) tr.className = extra;');
ok('自证：能在源码里定位到 rowClass 分支（否则下面的反向用例是空转）',
	rcStart >= 0 && rcTail > rcStart);
const rcEnd = mtSrc.indexOf('}', rcTail) + 1;
const mtNoRowClass = mtSrc.slice(0, rcStart) + mtSrc.slice(rcEnd);
const clsBad = rowClasses(loadMt(mtNoRowClass));
ok('★ 反向：删掉 rowClass 分支后必须判否',
	clsBad[1] !== 'mt5700-row-unmeasured',
	'删了分支仍然带类名 —— 说明上面那条断言根本没在查这段代码');

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
/* ★ 2026-11-06：原断言「向用户说明 RSRQ 的来源与关联方式」（要求页面出现
 *   「已按 ARFCN+PCI 关联回填」）随用户口径「类似的解说太多」一并反转 ——
 *   RSRQ 从哪条命令回填是**实现细节**，用户要做的是看数值、必要时锁定，
 *   不是读数据血缘。现改为**禁止**这类血缘说明回到界面（红线 87）。
 *   数据本身仍然回填（见上面 if (row.rsrq == null) 那条），只是不解释。 */
ok('★ 界面不再解释 RSRQ 的数据血缘',
	!/已按 ARFCN\+PCI 关联回填/.test(settingsJs) && !/RSRQ 由 \^/.test(settingsJs),
	'血缘说明回流到界面了');

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

/*
 * ^HFREQINFO 解析仍要保留——网络状态页「载波与聚合」的载波表在用它
 * （显示下行/上行带宽）。这里钉住的是解析本身，不是邻区带宽推断。
 */
ok('^HFREQINFO 解析出 2 个载波', carriers.length === 2, '实际 ' + carriers.length);
ok('主载波带宽 60000 kHz（60 MHz）', carriers[0] && carriers[0].dlBwKHz === 60000);
ok('辅载波带宽 100000 kHz（100 MHz）', carriers[1] && carriers[1].dlBwKHz === 100000);

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
 * ★ 2026-11-06：原因照写，但只写用户能行动的那一层 ——「邻区测量只覆盖最强 4 个
 *   小区」。原文案带命令名（^NRSSBID）、「前 4 强邻区都不在辅载波频带内」的推导
 *   和「不是刷新失败」的自辩，属于开发视角。结论不变，句子从 3 句压到 1 句。
 */
ok('辅载波匹配不到邻区时给出解释，而不是留一片空白',
	/辅载波信号为空：邻区测量只覆盖最强的 4 个小区/.test(statusJs));
ok('★ 该解释不再向用户暴露命令名与自辩口吻',
	!/前 4 强邻区都不在辅载波频带内/.test(statusJs) && !/不是刷新失败/.test(statusJs));

/* ---------- 汇总 ---------- */

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('邻区扫描契约测试全部通过');
