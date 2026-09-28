#!/usr/bin/env node
'use strict';
/* 跑全部 node 测试，汇总通过/失败。用法：node tests/run-all.js
 *
 * 退出码约定：
 *   0 = 全部通过
 *   1 = 有测试文件失败
 *   2 = **测试无法执行**（进程根本起不来）—— 与「断言失败」严格区分
 *
 * 为什么必须区分 0/1 与 2：
 * 早先用 `spawnSync` 逐个起子进程，某些环境（受限沙箱 / EBUSY）下 spawnSync
 * 直接失败、status=null，于是**每一个**文件都被算成 FAIL —— 看起来是
 * 「75 个测试全挂」，实际一行源码都没执行。这种假失败会让人误判项目状态，
 * 比不跑更危险。现在：
 *   1) 子进程改用异步 spawn（该环境下可用），spawnSync 仅作兜底；
 *   2) 拿不到退出码时按「无法执行」处理，单独计数并显式打印原因。
 */
const { spawn, spawnSync } = require('child_process');
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

/* 异步 spawn 跑单个文件；返回 { status, out, spawnError }。
   status === null 表示进程没起来（与「跑完但退出码非 0」区分开）。 */
function runFile(abs) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (v) => {
			if (!settled) {
				settled = true;
				resolve(v);
			}
		};
		let child;
		try {
			child = spawn(process.execPath, [abs], { stdio: ['ignore', 'pipe', 'pipe'] });
		} catch (e) {
			finish({ status: null, out: '', spawnError: e && e.message });
			return;
		}
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('error', (e) => finish({ status: null, out, spawnError: e && e.message }));
		child.on('close', (code) => finish({ status: code, out, spawnError: null }));
	});
}

/* 兜底：异步 spawn 不可用时尝试 spawnSync。 */
function runFileSync(abs) {
	const r = spawnSync(process.execPath, [abs], { encoding: 'utf8' });
	if (r.error) return { status: null, out: '', spawnError: r.error.message };
	return { status: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim(), spawnError: null };
}

(async () => {
	let bad = 0;
	let unrun = 0;
	const rows = [];

	for (const f of files) {
		const abs = path.join(dir, f);
		let r = await runFile(abs);
		if (r.status === null && !r.out) {
			/* 异步也起不来，退回同步再试一次（有的环境反过来） */
			const s = runFileSync(abs);
			if (s.status !== null) r = s;
		}
		const out = (r.out || '').trim();

		/* 各家输出格式不一：`通过 N 项，失败 M 项` / `N/M 通过` / `N 个…错误 0 个`，
		   都认一遍，取不到就显示 `-`（不影响成败判定，成败只看退出码）。 */
		const m = out.match(/通过\s*(\d+)\s*项，失败\s*(\d+)\s*项/)
			|| out.match(/(\d+)\/(\d+)\s*通过/)
			|| out.match(/语法错误\s*(\d+)\s*个/);

		let status;
		if (r.status === null) {
			status = 'NORUN';
			unrun++;
		} else if (r.status === 0) {
			status = 'PASS';
		} else {
			status = 'FAIL';
			bad++;
		}
		rows.push({
			file: f,
			status,
			count: m ? m[1] : '-',
			tail: status === 'PASS' ? '' : out.split('\n').slice(-12).join('\n'),
			spawnError: r.spawnError
		});
	}

	for (const r of rows) {
		console.log(r.status.padEnd(6), String(r.count).padStart(4), r.file);
		if (r.status === 'NORUN' && r.spawnError) {
			console.log('      无法启动测试进程：' + r.spawnError.replace(/\s+/g, ' ').slice(0, 160));
			console.log('      （这是「没跑」而不是「没通过」，结果不可信）');
		} else if (r.tail) {
			console.log(r.tail.replace(/^/gm, '      ') + '\n');
		}
	}

	const parts = [];
	if (bad) parts.push(bad + ' 个测试文件失败');
	if (unrun) parts.push(unrun + ' 个文件无法执行');
	console.log('\n' + (parts.length ? parts.join('，') : '全部测试文件通过'));

	if (bad) process.exit(1);
	if (unrun) process.exit(2);
	process.exit(0);
})();
