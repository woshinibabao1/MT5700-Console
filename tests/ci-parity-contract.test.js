#!/usr/bin/env node
'use strict';

/*
 * CI 一致性契约：`.github/workflows/build-openwrt.yml` 的 contract-check 步骤集
 * 必须与 `tools/ci-local.sh` 里用 `# CI-STEP:` 标记的本地步骤**双向一致**。
 * ---------------------------------------------------------------------------
 * 起因（2026-09-30 的真实事故）：
 *   本地一直只用 tools/run-tests-inproc.js 验证（沙箱禁止 spawn 抓管道），而 CI 跑的是
 *   tests/run-all.js，后者还会追加一条 `tests/syntax-check.js`。这一步本地从未跑过，
 *   于是"本地全绿 / CI 红"能同时成立 —— 本次就是这样把 CI 弄红的（详见 CHANGELOG 113）。
 *
 *   tools/ci-local.sh 把 CI 的步骤集固化成本地一条命令；本测试守住这条固化不会漂移：
 *     ① CI 新增了契约步骤，而 ci-local.sh 没跟 → 判红（本地验证会漏跑新步骤）；
 *     ② ci-local.sh 里留了 CI 已删掉的步骤 → 判红（本地跑的是幽灵步骤，白耗时且误导）。
 *
 * 为什么用 `# CI-STEP: <原命令>` 标记而不是解析 shell：
 *   解析 shell 的分支/函数需要写一个 shell 解析器（本仓不引入新依赖）；
 *   标记是显式的、可被本测试与读者同时核对，且**不依赖文件数量或行号**。
 *
 * 用法：node tests/ci-parity-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, '.github', 'workflows', 'build-openwrt.yml');
const LOCAL = path.join(ROOT, 'tools', 'ci-local.sh');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* 从 workflow 里切出 contract-check 这个 job 的文本块（按缩进：下一个同级 job 之前） */
function jobBlock(src, jobName) {
	const lines = src.split('\n');
	const startRe = new RegExp('^ {2}' + jobName + ':\\s*$');
	const start = lines.findIndex(function (l) { return startRe.test(l); });
	if (start < 0) return null;
	const out = [];
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i];
		if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(l)) break;   /* 下一个同级 job */
		out.push(l);
	}
	return out.join('\n');
}

/* 取该 job 里所有单行 `run: <cmd>`（本仓该 job 的步骤都是单行） */
function runCmds(block) {
	const cmds = [];
	block.split('\n').forEach(function (l) {
		const m = l.match(/^\s*-?\s*run:\s*(\S.*)$/);
		if (m) cmds.push(m[1].trim());
	});
	return cmds;
}

const wfSrc = fs.readFileSync(WF, 'utf8');
const localSrc = fs.readFileSync(LOCAL, 'utf8');

const block = jobBlock(wfSrc, 'contract-check');
ok('能从 workflow 里取到 contract-check 这个 job（否则本测试等于没跑）', block !== null);

const ciCmds = block ? runCmds(block) : [];
ok('contract-check 里解析出了 run: 命令（解析器没哑火）', ciCmds.length >= 4,
	'只解析到 ' + ciCmds.length + ' 条：' + JSON.stringify(ciCmds));

/* ci-local.sh 里的标记 */
const marks = [];
localSrc.split('\n').forEach(function (l) {
	const m = l.match(/^\s*#\s*CI-STEP:\s*(\S.*)$/);
	if (m) marks.push(m[1].trim());
});
ok('ci-local.sh 里解析出了 CI-STEP 标记（解析器没哑火）', marks.length >= 4,
	'只解析到 ' + marks.length + ' 条');

/* ① CI 有、本地没跟 → 本地会漏跑 */
const missingLocal = ciCmds.filter(function (c) { return marks.indexOf(c) < 0; });
ok('① CI 的每条契约步骤在 tools/ci-local.sh 里都有对应标记（否则本地会漏跑新步骤）',
	missingLocal.length === 0,
	missingLocal.join(' | ') + '　修法：在 ci-local.sh 对应位置补 `# CI-STEP: <原命令>` 并加执行');

/* ② 本地有、CI 已删 → 本地在跑幽灵步骤 */
const staleLocal = marks.filter(function (m) { return ciCmds.indexOf(m) < 0; });
ok('② ci-local.sh 的每条 CI-STEP 标记都对应 CI 里真实存在的步骤（否则是幽灵步骤）',
	staleLocal.length === 0,
	staleLocal.join(' | ') + '　修法：删掉该标记与其执行块，或同步 CI');

/*
 * 反向自检：双向比对逻辑必须真能判出差异（纯内存，不依赖文件内容）
 */
const a = ['node tests/run-all.js', 'python3 tools/x.py'];
const b = ['node tests/run-all.js'];
ok('★ 反向自检：能检出「CI 有而本地没有」',
	a.filter(function (x) { return b.indexOf(x) < 0; }).length === 1);
ok('★ 反向自检：能检出「本地有而 CI 没有」',
	b.filter(function (x) { return a.indexOf(x) < 0; }).length === 0 &&
	['ghost'].filter(function (x) { return a.indexOf(x) < 0; }).length === 1);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('CI 一致性契约通过（' + ciCmds.length + ' 条 CI 契约步骤与 tools/ci-local.sh 双向对齐）');
