#!/usr/bin/env node
'use strict';
/* 跑全部 node 测试，汇总通过/失败。用法：node tests/run-all.js */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir)
	.filter((f) => /^[^.].*\.test\.js$/.test(f))
	.sort();

let bad = 0;
const rows = [];
for (const f of files) {
	const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
	const out = ((r.stdout || '') + (r.stderr || '')).trim();
	const m = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/);
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
