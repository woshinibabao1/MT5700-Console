#!/usr/bin/env node
'use strict';
/*
 * 跑全部 node 测试并汇总通过/失败。用法：node tools/run-tests-inproc.js
 *
 * ★ 为什么不用 tests/run-all.js：run-all 用 spawnSync 起子进程，本机沙箱环境下
 *   子进程一律起不来（r.status === null，全部报 SPAWN-FAIL），46/46 假失败。
 *   这里改为**同进程 require**：逐个 clear cache → 复位 exitCode → require，
 *   覆盖率与 run-all 完全一致，且不受子进程限制。
 *   副作用是把 process.exit 临时换成抛异常，避免某个用例直接结束整个 runner。
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');

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
files.push('syntax-check.js');

const realExit = process.exit;
let bad = 0;
const failed = [];

for (const f of files) {
	const abs = path.join(dir, f);
	for (const k of Object.keys(require.cache)) delete require.cache[k];
	process.exitCode = 0;
	process.exit = function (code) { throw { __exit__: code === undefined ? 0 : code }; };
	let rc = 0;
	try {
		require(abs);
		rc = process.exitCode || 0;
	} catch (e) {
		if (e && typeof e === 'object' && '__exit__' in e) rc = e.__exit__;
		else { rc = 1; }
	}
	process.exit = realExit;
	if (rc !== 0) {
		bad++;
		failed.push(f + ' (rc=' + rc + ')');
		console.log('FAIL  ' + f + '  rc=' + rc);
	}
}

process.exitCode = 0;
if (bad === 0) console.log('ALL PASS（' + files.length + ' 个测试文件）');
else console.log(bad + ' / ' + files.length + ' 个测试文件失败：\n  ' + failed.join('\n  '));
