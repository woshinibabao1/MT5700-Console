#!/usr/bin/env node
'use strict';
/* 跑全部 node 测试，汇总通过/失败。用法：node tests/run-all.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;

/*
 * 递归收集，且同时认 `*.test.js` 与 `*-test.js` 两种命名。
 *
 * 早先只扫当前目录、只认 `.test.js`，于是 tests/mock-modem/parse-extra-test.js
 * 一直没被跑到 —— 而它是仓里少数**跑真实行为**（而非正则匹配源码文本）的测试
 * （REJINFO / SIMSQ 共 19 项）。它自述曾长期「0 项通过却静默挂着」，
 * 不在 run-all 里就再没人发现。
 *
 * e2e-test.js 要连本机 mock 服务端（net.connect 127.0.0.1），不是自包含的，
 * 由 tests/mock-modem/run-e2e.sh 单独跑，这里排除。
 */
function collect(d, out) {
	for (const name of fs.readdirSync(d)) {
		const p = path.join(d, name);
		if (fs.statSync(p).isDirectory()) collect(p, out);
		else if (/^[^.].*(-test|\.test)\.js$/.test(name) && name !== 'e2e-test.js') out.push(p);
	}
	return out;
}

const files = collect(dir, [])
	.map((p) => path.relative(dir, p).split(path.sep).join('/'))
	.sort();
/* 语法冒烟不是 *-test.js，但必须每次都跑：它抓的是白屏级语法错误 */
files.push('syntax-check.js');

let bad = 0;
const rows = [];
for (const f of files) {
	const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
	const out = ((r.stdout || '') + (r.stderr || '')).trim();
	/* 各家输出格式不一：`通过 N 项，失败 M 项` / `N/M 通过` / `N 个…错误 0 个`，
	   都认一遍，取不到就显示 `-`（不影响成败判定，成败只看退出码）。 */
	const m = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/)
		|| out.match(/(\d+)\/(\d+)\s*通过/)
		|| out.match(/语法错误\s*(\d+)\s*个/);
	const okRun = r.status === 0;
	if (!okRun) bad++;
	rows.push({
		file: f,
		status: okRun ? 'PASS' : 'FAIL',
		count: m ? m[1] : '-',
		tail: okRun ? '' : out.split('\n').slice(-12).join('\n')
	});
}
for (const r of rows) {
	console.log(r.status.padEnd(5), String(r.count).padStart(4), r.file);
	if (r.tail) console.log(r.tail.replace(/^/gm, '      ') + '\n');
}
console.log('\n' + (bad ? bad + ' 个测试文件失败' : '全部测试文件通过'));
process.exit(bad ? 1 : 0);
