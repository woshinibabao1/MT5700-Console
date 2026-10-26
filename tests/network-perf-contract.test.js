#!/usr/bin/env node
'use strict';

/**
 * 网络状态页 性能与归位契约测试（纯静态，不连设备、不发 AT、不改文件）
 * ---------------------------------------------------------------------------
 * 2026-10-27 用户要求「删断网排查、删速率与流量、把连接状态并进结论卡」之后的
 * 契约口径（本文件随之改写，**要求不放松**）：
 *   A. 动作归位：清零流量从「速率卡头」迁到「常用动作」——删卡前先问
 *      「它头上挂着哪些动作」，否则卡一删按钮就地消失。
 *   B. 性能：1Hz 采样仍受可见性管控（页面隐藏即停、回前台丢基准再补起）；
 *      初始化不重复渲染（P04）；图表那套宽度缓存/ResizeObserver 随卡片一起删除，
 *      不许留半截死代码。
 *   C. 防倒退：速率与流量卡、连接状态卡都不得重新出现（用户口径，别再拆回去）。
 *
 * 全部走「源码级静态断言」：这些是**结构契约**，不是行为，
 * 一旦有人把改动退回去，CI 立刻红，不用等上真机才发现界面变慢或按钮不见了。
 *
 * 用法：node tests/network-perf-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const UI = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

const nsSrc = fs.readFileSync(NS, 'utf8');
const uiSrc = fs.readFileSync(UI, 'utf8');

/* 源码级断言只看代码：注释里会出现反例字面量（例如为了解释 P15 而原样抄了
   那句 4 参 E() 调用），直接对原文跑正则会被自己的注释命中。 */
function stripComments(s) {
	return s.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}
const nsCode = stripComments(nsSrc);
const uiCode = stripComments(uiSrc);

/* ---------- 1. 清零入口归位到「常用动作」（原在速率卡头） ---------- */

ok('★ 清零按钮挂在「常用动作」的按钮行里（rateClear 由 actionRow 承载）',
	/actionBtn\('清零流量', false, function \(\) \{ clearFlowStats\(\); \}\)/.test(nsCode),
	'按钮必须是真回调用，不能是空函数或只有 label');
/* ★ 删卡最典型的坑：动作跟着卡一起消失。这里连「卡头那套」的残留一起钉死，
   避免哪天有人把速率卡搬回来时又长出第二个清零入口。 */
ok('★ 速率卡头那套（rateBar / rateExtra / rateChk）已彻底删除',
	!/rateBar/.test(nsCode) && !/rateExtra/.test(nsCode) && !/rateChk/.test(nsCode));
ok('★ 连接工具里不再 append 清零块',
	!/toolsBody\.appendChild\(buildFlowClearBlock\(\)\)/.test(nsCode));
ok('★ buildFlowClearBlock 已整体删除（不留孤儿）',
	!/buildFlowClearBlock/.test(nsCode));
ok('清零仍走二次确认（不可逆操作）',
	/function clearFlowStats[\s\S]{0,300}Mt5700\.confirm/.test(nsCode));
ok('清零仍下发 AT^DSFLOWCLR（手册 16.11）',
	/sendCommand\('AT\^DSFLOWCLR'\)/.test(nsCode));
/* 迁走后按钮旁边不再有块内说明文字，title 是唯一的「这会断网吗」提示。 */
ok('★ 清零按钮给出影响说明（迁走后没有块内文字可看）',
	/Mt5700\.confirm\('清零流量统计？[\s\S]{0,200}不会断网/.test(nsCode));

/* ---------- 2. P15 E() 静默丢参：全仓不得再有 4 参调用 ---------- */

/**
 * 扫描源码里所有 `E(...)` 调用，返回顶层参数个数 ≥ 4 的位置。
 * 容忍换行与嵌套括号；只匹配顶层逗号。
 */
/**
 * 扫描源码里所有 `E(...)` 调用，返回顶层参数个数 ≥ 4 的位置。
 * 容忍换行与嵌套括号；只按顶层逗号切分。
 *
 * ★ 自检：本函数曾有致命 bug —— 用了不存在的 `m.end`（`RegExp.exec` 的返回
 *   只有 `index`，没有 `end`），于是 `start` 算出 NaN，扫描器**恒返回空数组**，
 *   断言变成永真。是审查阶段抓出来的（假守卫比没守卫更危险：它会让人以为
 *   已经防住了）。因此这里附带一条针对扫描器自身的断言，见下方第 2 节。
 */
function findMultiArgECalls(src) {
	const out = [];
	const lines = src.split('\n');
	for (let ln = 0; ln < lines.length; ln++) {
		const line = lines[ln];
		for (let i = 0; i >= 0; ) {
			const m = /\bE\(/.exec(line.slice(i));
			if (!m) break;
			const start = i + m.index + m[0].length;
			let depth = 1, k = start, instr = null;
			while (k < line.length && depth > 0) {
				const c = line[k];
				if (instr) { if (c === instr) instr = null; }
				else if (c === '"' || c === "'" || c === '`') instr = c;
				else if (c === '(') depth++;
				else if (c === ')') depth--;
				k++;
			}
			if (depth !== 0) { i = start; continue; }   /* 跨行调用：本行不成对，跳过 */
			const inner = line.slice(start, k - 1);
			let d = 0, q = 0, cur = '', parts = [], s2 = null;
			while (q < inner.length) {
				const c = inner[q];
				if (s2) { if (c === s2) s2 = null; cur += c; }
				else if (c === '"' || c === "'" || c === '`') { s2 = c; cur += c; }
				else if (c === '(' || c === '[' || c === '{') { d++; cur += c; }
				else if (c === ')' || c === ']' || c === '}') { d--; cur += c; }
				else if (c === ',' && d === 0) { parts.push(cur.trim()); cur = ''; }
				else cur += c;
				q++;
			}
			if (cur.trim()) parts.push(cur.trim());
			if (parts.length >= 4) out.push({ line: ln + 1, argc: parts.length, text: line.trim().slice(0, 110) });
			i = k;
		}
	}
	return out;
}

/* 扫描范围必须是**全仓前端**，不能只扫改动到的那两个文件 ——
   esim.js 里就踩中过一次（「处理待发回执」按钮被吃掉），只扫两个文件根本抓不到。 */
function collectJs(dir, acc) {
	fs.readdirSync(dir).forEach(function (name) {
		const p = path.join(dir, name);
		if (fs.statSync(p).isDirectory()) collectJs(p, acc);
		else if (name.endsWith('.js')) acc.push(p);
	});
	return acc;
}
const JS_FILES = collectJs(path.join(ROOT, 'htdocs', 'luci-static', 'resources'), []);
ok('能列出前端 js 文件', JS_FILES.length > 5, String(JS_FILES.length));

const badAll = [];
JS_FILES.forEach(function (p) {
	findMultiArgECalls(stripComments(fs.readFileSync(p, 'utf8'))).forEach(function (hit) {
		badAll.push(path.relative(ROOT, p) + ':' + hit.line + ' (argc=' + hit.argc + ') ' + hit.text);
	});
});
ok('★ 全仓前端没有 4 参及以上的 E() 调用（第 4 参会被引擎静默丢弃）',
	badAll.length === 0, badAll.slice(0, 3).join(' | '));

/* ★★ 扫描器自检：假守卫比没守卫更危险 —— 它让人以为已经防住了。
   喂一段已知的坏例，扫描器必须报出来。 */
ok('★ 扫描器自检：能识别出 4 参的坏例（否则整条守卫是永真的）',
	findMultiArgECalls("x.appendChild(E('div', {}, a, b));").length === 1);
ok('★ 扫描器自检：3 参的正常调用不算违规',
	findMultiArgECalls("x.appendChild(E('div', {}, a));").length === 0);
ok('★ 扫描器自检：字符串里的逗号不会被误切成多个参数',
	findMultiArgECalls("E('p', {}, 'a, b, c');").length === 0);

/* 「实时监测」开关随速率卡删除（2026-10-27）：它唯一的作用是停掉每秒采样，
   而 KPI 的下行/上行与趋势线都要吃这份采样 —— 开关留着就是骗人。
   这条由 connection-tools-contract 的「开关已删除」断言把守，此处不再重复。 */

/* ---------- 3. P03 1Hz 速率采样纳入可见性管控 ---------- */

const visFn = (nsCode.match(/var onVisibility = function \(\) \{[\s\S]*?\n\t\t\};/) || [''])[0];
ok('能定位 onVisibility', visFn.length > 0);
ok('★ 页面隐藏时一并停掉 1Hz 的 rateTimer（它是唯一不受 resetTimers 管辖的定时器）',
	/document\.hidden[\s\S]{0,300}clearInterval\(rateTimer\)/.test(visFn));
ok('★ 回到前台重开速率采样前先丢弃旧基准 rateSample',
	/rateSample = null;[\s\S]{0,200}setInterval\(sampleRate, 1000\)/.test(visFn));
ok('★ 后台标签页打开时不启动 1Hz 采样（否则用户还没看到页面就在刷 RPC）',
	/if \(!document\.hidden\) \{ rateTimer = setInterval\(sampleRate, 1000\);/.test(nsCode));
ok('★ 回到前台补起采样（onVisibility 的 visible 分支，且不重复叠加定时器）',
	/if \(!rateTimer\) \{[\s\S]{0,300}setInterval\(sampleRate, 1000\)/.test(nsCode));
ok('_dispose 里清 rateTimer（防反复进出叠加定时器）',
	/_dispose[\s\S]{0,600}clearInterval\(rateTimer\)/.test(nsCode));

/* ---------- 4. P04 初始化不重复渲染 ---------- */

/* 锚点改用「初始化段」这个稳定标记：原锚点是 renderConn();（该函数已随连接状态卡删除）。
   块尾仍是 self._dispose 定义之前。 */
const initEnd = nsCode.indexOf('self._dispose');
/* 取「结论区先画一次空态」后面那段连续调用作为初始化块：锚点是 renderSignal()，
   它在整个文件里只出现在初始化与快档回调两处，用 lastIndexOf 取靠近 _dispose 的那次。 */
const initStart = nsCode.lastIndexOf('renderSignal();', initEnd);
const initBlock = (initStart >= 0 && initEnd > initStart) ? nsCode.slice(initStart, initEnd) : '';
ok('能定位初始化段', initBlock.length > 0);
const detailCalls = (initBlock.match(/renderConnDetail\(\)/g) || []).length;
ok('★ 初始化段只渲染一次连接明细（原先连着调了两次）',
	detailCalls === 1, '实测 ' + detailCalls + ' 次');
const verdictCalls = (initBlock.match(/renderVerdict\(\)/g) || []).length;
ok('★ 初始化段只渲染一次结论卡（chips + 明细表不重复重建）',
	verdictCalls === 1, '实测 ' + verdictCalls + ' 次');
ok('DNS 配置到位后仍会重绘一次（自定义 DNS 要显示出来）',
	/loadDnsConfig\(\)\.then\(renderConnDetail\)/.test(nsCode));

/* ---------- 5. P05' 确定性失败的命令不重试 ---------- */

ok('★ AT^DHCPV6? 显式 attempts:1（实测它是 23 条只读命令里唯一恒定失败的一条）',
	/sendCommand\('AT\^DHCPV6\?', \{ attempts: 1 \}\)/.test(nsCode));
ok('其余常规读数没有被顺手降重试（错误恢复能力不能被削弱）',
	(nsCode.split('attempts: 1').length - 1) === 1,
	'attempts:1 出现 ' + (nsCode.split('attempts: 1').length - 1) + ' 次');

/* ---------- 6. 图表整套随卡片删除（P06 的宽度缓存 / ResizeObserver 一并作废） ---------- */

/* 这些断言是「反过来钉」：迁移完成后最容易留下的坏味道就是半截死代码 ——
   没人调用的 renderChart、从没被 observe 的 ResizeObserver、永远走不到的分支。
   它们不报错、不占页面，但会让人以为「曲线还在，只是没显示」，改起来反复试。
   所以要求是：一个都不许剩。 */
ok('★ renderChart 已彻底删除（含函数定义与全部调用）',
	!/renderChart/.test(nsCode));
ok('★ 图表宽度缓存与 ResizeObserver 已删除（无 chartWidth / chartRO / onResize）',
	!/chartWidth/.test(nsCode) && !/chartRO/.test(nsCode) && !/new ResizeObserver/.test(nsCode));
ok('★ 不再有 .mt5700-chart 容器（页面里没有第二处图表宿主）',
	!/'mt5700-chart'|"mt5700-chart"/.test(nsCode));
/* 但采样本身不能跟着删：KPI 的下行/上行与趋势线都吃 state.rtDown / rtUp。 */
ok('★ 采样仍在（renderSpeed 把 rtDown/rtUp 推给 KPI，趋势线靠它）',
	/function renderSpeed\(\)/.test(nsCode)
	&& /sparkDown\.set\(/.test(nsCode) && /sparkUp\.set\(/.test(nsCode));
ok('★ 不可见时不采样（切后台瞬间在飞的那次也要挡）',
	/function sampleRate\(\) \{[\s\S]{0,200}if \(document\.hidden\) return/.test(nsCode));

/* ---------- 7. P07 曲线 tooltip 的 rect 缓存 ---------- */

ok('★ mousemove 不再无条件读 rect（改成用缓存）',
	!/mousemove[\s\S]{0,300}var rect = wrap\.getBoundingClientRect\(\)/.test(uiCode)
	&& /var rect = hoverRect;/.test(uiCode));
ok('★ rect 在 mouseenter 量一次、mouseleave 丢弃',
	/mouseenter'[\s\S]{0,200}hoverRect = wrap\.getBoundingClientRect\(\)/.test(uiCode)
	&& /mouseleave'[\s\S]{0,200}hoverRect = null/.test(uiCode));
ok('★ 缓存为空时有兜底（元素在光标下被重建时不会拿不到 rect）',
	/if \(!hoverRect\) hoverRect = wrap\.getBoundingClientRect\(\);/.test(uiCode));

/* ---------- 8. P10 清零后取数失败也要重绘 ---------- */

ok('★ 清零后重取流量失败时，把 state.flow 置空再重绘（不能留旧数字）',
	/getFlow\(\)\.then\(renderFlow, function \(\) \{\s*state\.flow = \{\};/.test(nsCode));
/* 峰值（peakDown/peakUp）唯一的显示点是速率卡的流量明细，卡删后它变成
   「没人读还在累加」的死字段 —— 一并删除。留着的话清零后还得同步归零，
   是纯粹为不存在的东西维护一致性。 */
ok('★ 峰值字段已删除（无人显示就不该继续累加）',
	!/state\.peakDown/.test(nsCode) && !/state\.peakUp/.test(nsCode));
/* 流量明细那 8 项随卡片删除，formatFlow/durText/flowText 一起走了。
   留下的是 KPI「本月流量」：取不到时必须写「—」，不能写 0（0 与「没读到」
   是两件事），也不能让 undefined 走进 formatFlow 算出 NaN。 */
ok('★ KPI 流量取不到时显示「—」而不是 0 / NaN',
	/var totB = \(f\.totalRxFlow == null && f\.totalTxFlow == null\) \? null/.test(nsCode)
	&& /if \(totB == null\) \{\s*kpiFlow\.set\('—', '', ''\);/.test(nsCode));

/* ---------- 9. 防倒退：用户口径，两张卡都不许重新出现 ---------- */

/* 2026-10-26 删信号质量卡、2026-10-27 删速率与流量卡与连接状态卡 ——
   依据是「同一页里同一件事只排一次」，不是口味。回来的话整页又会变成
   同一个数字出现在三处，所以这里取反钉死。 */
ok('★ 「速率与流量」卡片不得重新出现（当前速率在 KPI，累计在 KPI 副标）',
	!/Mt5700\.card\('速率与流量'/.test(nsCode));
ok('★ 「连接状态」卡片不得重新出现（已并入结论卡）',
	!/Mt5700\.card\('连接状态'/.test(nsCode));
ok('★ 「信号质量」卡片不得重新出现（2026-10-26 已删）',
	!/Mt5700\.card\('信号质量'/.test(nsCode));
/* 断网排查仍在，但**不占页面区块**：卡片节点照建、默认收起。
   ★ 2026-09-19 v2.3.15：排查不进页面自动跑，只有用户点按钮才跑
   （自动跑会占住独占的 AT 通道十几秒，和页面轮询、手动 AT 抢通道）。 */
ok('「断网排查」卡片节点仍在（默认收起的抽屉，能力不许丢）',
	/Mt5700\.card\('断网排查', '三层体检 · 一键定位'\)/.test(nsCode));
ok('★ 排查不进页面自动跑（只在用户点「连接自检」时才走）',
	!/runDiagnosis\(\)\.catch/.test(nsCode) && !/readAdcPins/.test(nsCode));
ok('明细折叠状态不进 state.tools.diag（无 t.expanded，无向导式「展开步骤」）',
	!/t\.expanded/.test(nsCode) && !/展开步骤/.test(nsCode));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('网络状态页 性能与归位契约测试全部通过');
