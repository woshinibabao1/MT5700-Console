/**
 * 一键诊断契约测试
 * ---------------------------------------------------------------------------
 * 背景：
 *   状态页右列「SIM 与设备」下方长期空着 400px+，用户先后否掉了温度柱图、
 *   短信中心号、延迟探测面板等 5 个方案，理由是「要更有价值的信息」。
 *   最终定为「一键诊断」：把本页已有的读数翻译成结论与归因。
 *
 * 本测试钉住四条最容易在后续维护中被破坏的性质：
 *   1) **零新增串口查询** —— 诊断的价值建立在不额外占串口上。若在
 *      buildDiagnostics 里加一条 AT 命令，页面轮询密度会上升，与本项目
 *      「状态页要控制轮询」的既有约束冲突。
 *   2) **缺失数据整项跳过，绝不拿 0 冒充实测值** —— 速率项若用 0 参与计算，
 *      会凭空算出「速率达成 0%」并据此报故障，等于制造假警报。
 *   3) 刷新时机齐全 —— 慢档跑完、监测开关切换、峰值刷新后都要重算。
 *   4) 版式与样式在位 —— 右列堆叠容器与诊断配色（CSS 指纹另由
 *      css-cachebust-contract.test.js 把关）。
 *
 * 运行：node tests/diagnostics-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');
const CSSP = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.css');

const js = fs.readFileSync(JSP, 'utf8');
const css = fs.readFileSync(CSSP, 'utf8');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}

/* 括号平衡法提取函数体：顶层 return 无法直接 eval，只能按大括号配平切出来 */
function extractFn(src, name) {
	const marker = 'function ' + name + '(';
	const start = src.indexOf(marker);
	if (start < 0) return '';
	let depth = 0, begun = false;
	for (let i = start; i < src.length; i++) {
		const ch = src[i];
		if (ch === '{') { depth++; begun = true; }
		else if (ch === '}') {
			depth--;
			if (begun && depth === 0) return src.slice(start, i + 1);
		}
	}
	return '';
}

/* ---------- 1. 卡片存在且挂在右列 ---------- */
ok('创建了「一键诊断」卡片', /Mt5700\.card\(\s*'一键诊断'/.test(js));
ok('右列用 .mt5700-stack 纵向堆叠', /'class':\s*'mt5700-stack'/.test(js));

const stackBlock = (js.match(/var duoRight = E\('div', \{ 'class': 'mt5700-stack' \}\);[\s\S]{0,220}/) || [])[0] || '';
ok('堆叠容器里先放 SIM 与设备、再放一键诊断',
	/duoRight\.appendChild\(devCard\)/.test(stackBlock) &&
	/duoRight\.appendChild\(diagCard\)/.test(stackBlock),
	'实际片段：' + stackBlock);
ok('duoRight 与 connCard 一起进 .mt5700-cards 双列区',
	/duo\.appendChild\(connCard\)/.test(js) && /duo\.appendChild\(duoRight\)/.test(js));

/* ---------- 2. 零新增串口查询（核心约束） ---------- */
const buildSrc = extractFn(js, 'buildDiagnostics');
ok('存在 buildDiagnostics 函数', !!buildSrc);

/*
 * 注释里会提到来源命令名（如「AT+C5GREG? 的 statText」），那是给人看的说明，
 * 不是下发动作。查「有没有真的去查串口」必须**先剥掉注释**再判，
 * 否则说明文字里出现一个 AT 命令名就会误报。
 */
function stripComments(s) {
	return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const buildCode = stripComments(buildSrc);

ok('buildDiagnostics 内不下发任何 AT 命令（诊断必须零新增查询）',
	!/sendCommand/.test(buildCode) && !/AtWs\.(netRate|client)/.test(buildCode),
	'buildDiagnostics 里出现了串口/网络调用');
ok('buildDiagnostics 代码里不出现 AT 命令字面量（注释里的命令名不算）',
	!/AT[\^\+]/.test(buildCode),
	'出现了 AT 命令字面量');

const diagAll = stripComments(extractFn(js, 'buildDiagnostics') +
	extractFn(js, 'renderDiag') + extractFn(js, 'diagSummary'));
ok('renderDiag / diagSummary 同样不碰串口',
	!/sendCommand/.test(diagAll) && !/AT[\^\+]/.test(diagAll));

/* ---------- 3. 缺失数据整项跳过，不用 0 冒充 ---------- */
ok('速率项要求签约值 > 0 才参与判定（0 会被当真值算出 0%）',
	/ambr\s*>\s*0/.test(buildSrc), 'buildDiagnostics 片段：' + buildSrc.slice(0, 800));
ok('速率项要求实测峰值 > 0 才参与判定',
	/peak\s*>\s*0/.test(buildSrc));
ok('提供 diagNum 把非数字读成 null（而非 0）',
	/function diagNum\(/.test(js) && /isFinite/.test(extractFn(js, 'diagNum')));
ok('数值型读数缺失时整项跳过，不塞占位行',
	/sinr\s*!==\s*null/.test(buildSrc) && /rsrp\s*!==\s*null/.test(buildSrc));

/* ---------- 4. 阈值集中、结论可解释 ---------- */
ok('阈值集中在 DIAG_RULES', /var DIAG_RULES = \{/.test(js));
['rsrpGood', 'rsrpFair', 'sinrGood', 'sinrFair', 'puschGood', 'puschFair',
	'tempWarn', 'tempBad', 'rateGood', 'rateFair'
].forEach(function (k) {
	ok('DIAG_RULES 含 ' + k, new RegExp('\\b' + k + ':').test(js));
});

/* ---------- 5. 八项检查齐全 ---------- */
['速率达成', '信号质量', '发射功率', '信号强度', '网络注册', '载波聚合', '模块温度', 'SIM 状态'
].forEach(function (item) {
	ok('诊断项「' + item + '」在位', new RegExp("item:\\s*'" + item + "'").test(buildSrc));
});

/* ---------- 6. 排序与总评 ---------- */
ok('按严重程度排序（bad → warn → ok）',
	/order = \{ bad: 0, warn: 1, ok: 2 \}/.test(js));
ok('总评按最严重一项定级', /function diagOverall\(/.test(js) && /bad \? 'bad' : \(warn \? 'warn' : 'ok'\)/.test(js));
ok('总体结论给归因而不复述各项', /function diagSummary\(/.test(js) &&
	/基站侧拥塞或套餐限速/.test(extractFn(js, 'diagSummary')));

/* ---------- 7. 刷新时机齐全 ---------- */
ok('慢档整轮跑完后刷新诊断', /slowRunning = chain\.then\(function \(\) \{[\s\S]{0,240}renderDiag\(\)/.test(js));
ok('实时监测开关切换后刷新诊断（峰值归零要跟着变）',
	extractFn(js, 'setRateEnabled').indexOf('renderDiag()') !== -1);
ok('峰值采样后刷新诊断', extractFn(js, 'sampleRate').indexOf('renderDiag()') !== -1);
ok('采样刷新做了节流（不 1Hz 重建表格）', /diagSampleTick\s*%\s*5/.test(js));

/* ---------- 8. 样式在位 ---------- */
ok('CSS 有 .mt5700-stack 纵向堆叠', /\.mt5700-stack\s*\{/.test(css));
ok('CSS 有诊断总体结论块', /\.mt5700-diag-summary\s*\{/.test(css));
ok('CSS 有结论列配色（ok / warn / bad 三档）',
	/\.mt5700-diag-verdict\.is-ok/.test(css) &&
	/\.mt5700-diag-verdict\.is-warn/.test(css) &&
	/\.mt5700-diag-verdict\.is-bad/.test(css));

if (fails.length) {
	console.error('FAIL  ' + fails.length + ' 项未通过：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('\n通过 ' + pass + ' 项');
	process.exit(1);
}
console.log('PASS  ' + pass + ' diagnostics-contract.test.js');
