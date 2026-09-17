/**
 * 一键诊断 — 场景回归测试（真跑逻辑，不是静态断言）
 * ---------------------------------------------------------------------------
 * 与 diagnostics-contract.test.js 的分工：
 *   那个文件钉「代码长什么样」（零新增查询、阈值在位、刷新时机）；
 *   本文件钉「跑出来对不对」——把 buildDiagnostics / diagOverall / diagSummary
 *   从 network_status.js 里按括号平衡抽出来，注入 mock 依赖后喂真实数据实跑。
 *
 * 为什么要真跑：静态断言看不出逻辑错误。2026-09-17 首次实跑就抓出两个
 * 静态检查全绿时看不出来的问题：
 *   ① 只有 warn 项（单载波未聚合）时总评显示「一般」，正文却写「各项指标正常」；
 *   ② 网络注册那行拼成「5GC 已注册 5GC」（AT+C5GREG? 的 statText 自带 5GC 字样）。
 *
 * 依赖：通过函数名定位，若 network_status.js 里这些函数改名，本测试会直接报错
 * 提示 —— 这是有意的，改名后请同步这里的 extractFn 调用。
 *
 * 全程本地执行，不下发任何命令、不连真机。
 *
 * 运行：node tests/diagnostics-scenarios.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources',
	'view', 'at-webserver', 'network_status.js');
const src = fs.readFileSync(JS, 'utf8');

/* 输出先收着，只有失败时才打印 —— 8 个场景的全量清单会把 run-all 的输出冲垮 */
const log = [];
function say(s) { log.push(s); }

function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（是否改过名？请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

const rulesSrc = (src.match(/var DIAG_RULES = \{[\s\S]*?\};/) || [])[0];
if (!rulesSrc) throw new Error('找不到 DIAG_RULES');

const code = [
	rulesSrc,
	extractFn(src, 'diagNum'),
	extractFn(src, 'diagSpeed'),
	extractFn(src, 'splitSpeedUI'),
	extractFn(src, 'buildDiagnostics'),
	extractFn(src, 'diagOverall'),
	extractFn(src, 'diagSummary')
].join('\n');

const factory = new Function('state', 'Parse', 'devState',
	code + '\nreturn { buildDiagnostics: buildDiagnostics, diagOverall: diagOverall, diagSummary: diagSummary };');

/* 与 parse.js 的 simShort / simIsWarn 同语义的最小替身：1 = 已就绪 */
const Parse = {
	simShort: function (v) { return v === 1 ? '已就绪' : '异常#' + v; },
	simIsWarn: function (v) { return v !== 1; }
};

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; say('  ✓ ' + label); return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
	say('  ✗ ' + label + (extra ? '  → ' + extra : ''));
}

function run(label, state, devState) {
	const api = factory(state, Parse, devState);
	const items = api.buildDiagnostics();
	const ov = api.diagOverall(items);
	const summary = api.diagSummary(items);
	const order = { bad: 0, warn: 1, ok: 2 };
	const sorted = items.slice().sort(function (a, b) { return order[a.level] - order[b.level]; });

	say('===== ' + label + ' =====');
	say('  总评: ' + ov.level + ' (bad=' + ov.bad + ' warn=' + ov.warn + ' total=' + ov.total + ')');
	sorted.forEach(function (it) {
		say('   [' + it.level.toUpperCase().padEnd(4) + '] ' + it.item + ' → ' + it.verdict + ' | ' + it.detail);
	});
	say('  结论: ' + summary);
	say('');
	return { items: items, ov: ov, summary: summary, sorted: sorted };
}

function pick(r, item) {
	for (let i = 0; i < r.items.length; i++) if (r.items[i].item === item) return r.items[i];
	return null;
}

/* 基线：一项读数都没有 */
function base() {
	return {
		cell: {}, carriers: [], nrssbid: null, monnc: [],
		diag: {}, temps: {}, ambrDown: 0, ambrUp: 0,
		rtDown: 0, rtUp: 0, peakDown: 0, peakUp: 0
	};
}
/* 全绿基线：RSRP -78 / SINR 22 / PUSCH 10 / 双载波 / 42℃ / 签约 1Gbps / 峰值 838Mbps ≈ 84% */
function healthy() {
	const s = base();
	s.cell = { rsrp: -78, rsrq: -10, sinr: 22 };
	s.diag = {
		reg: { statText: '已注册 5GC', act: 'NR' },
		creg: { statText: '已注册' },
		cireg: { text: '已注册', info: true },
		nrTx: [{ pusch: 10, freq: 745000 }]
	};
	s.carriers = [{}, {}];
	s.temps = { modem1: 40, modem2: 42, tcxo: 38 };
	s.ambrDown = 1000000;                  /* 1 Gbps */
	s.peakDown = 100 * 1024 * 1024;        /* ≈ 838 Mbps */
	return s;
}

/* ---------- 1. 空数据：不许凭空报警 ---------- */
let r = run('空数据（页面刚打开）', base(), null);
ok('不产生任何诊断项', r.items.length === 0, '实际 ' + r.items.length + ' 项');
ok('无数据时总评为 ok（没读数 ≠ 有故障）', r.ov.level === 'ok');

/* ---------- 2. 全绿 ---------- */
r = run('全绿', healthy(), { sim: 1, pin: 'READY' });
ok('8 项齐全', r.items.length === 8, '实际 ' + r.items.length);
ok('总评 ok', r.ov.level === 'ok');
ok('速率达成判为正常', pick(r, '速率达成').level === 'ok');
ok('结论说未发现异常', /未发现需要处理/.test(r.summary));
ok('网络注册不重复 5GC 前缀（曾显示「5GC 已注册 5GC」）',
	!/5GC 已注册 5GC/.test(pick(r, '网络注册').detail), pick(r, '网络注册').detail);

/* ---------- 3. 信号好但速率低（本次真机画像） ---------- */
let s3 = healthy();
s3.peakDown = 22.9 * 1024 * 1024;   /* ≈ 183 Mbps → 18% */
r = run('速率短板（真机画像）', s3, { sim: 1, pin: 'READY' });
ok('速率达成判为偏低', pick(r, '速率达成').level === 'bad');
ok('最严重的项排最前', r.sorted[0].item === '速率达成', '实际首位：' + r.sorted[0].item);
ok('归因指向基站/套餐而非设备', /基站侧拥塞或套餐限速/.test(r.summary), r.summary);

/* ---------- 4. 信号差 + 速率低：归因应让位给信号 ---------- */
let s4 = healthy();
s4.peakDown = 22.9 * 1024 * 1024;
s4.cell = { rsrp: -108, rsrq: -16, sinr: 2 };
r = run('信号短板', s4, { sim: 1, pin: 'READY' });
ok('信号强度判为偏差', pick(r, '信号强度').level === 'bad');
ok('归因优先指向信号', /信号强度是主要短板/.test(r.summary), r.summary);

/* ---------- 5. 关掉实时监测：缺峰值不能算成 0% ---------- */
let s5 = healthy();
s5.peakDown = 0;
r = run('无峰值（未开实时监测）', s5, { sim: 1, pin: 'READY' });
ok('速率项整项跳过（0 会被算成 0% 而凭空报故障）', pick(r, '速率达成') === null);
ok('其余 7 项照常产出', r.items.length === 7, '实际 ' + r.items.length + ' 项');
ok('总评仍为 ok', r.ov.level === 'ok');

/* ---------- 6. SIM 异常优先级最高 ---------- */
r = run('SIM 异常', healthy(), { sim: 0, pin: '' });
ok('SIM 状态判为异常', pick(r, 'SIM 状态').level === 'bad');
ok('归因优先指向 SIM', /SIM 未就绪/.test(r.summary), r.summary);

/* ---------- 7. 过热 ---------- */
let s7 = healthy();
s7.temps = { modem2: 78, tcxo: 70 };
r = run('模块过热', s7, { sim: 1, pin: 'READY' });
ok('温度判为过高', pick(r, '模块温度').level === 'bad');
ok('归因优先指向散热', /过热保护/.test(r.summary), r.summary);

/* ---------- 8. 只有 warn 项时，结论不能说「正常」 ---------- */
let s8 = healthy();
s8.carriers = [{}];
r = run('单载波（唯一 warn 项）', s8, { sim: 1, pin: 'READY' });
ok('载波聚合判为未启用', pick(r, '载波聚合').verdict === '未启用');
ok('总评为 warn', r.ov.level === 'warn');
ok('结论与总评一致，不再自相矛盾地说「各项指标正常」',
	!/各项指标正常/.test(r.summary), r.summary);
ok('结论点出了具体是哪一项', /载波聚合/.test(r.summary), r.summary);

if (fails.length) {
	log.forEach(function (l) { console.error(l); });
	console.error('FAIL  ' + fails.length + ' 项未通过：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('\n通过 ' + pass + ' 项');
	process.exit(1);
}
console.log('PASS  ' + pass + ' diagnostics-scenarios.test.js');
