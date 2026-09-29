#!/usr/bin/env node
'use strict';

/*
 * 工具输出编码契约：会打印 ✓ / ✗ 的 tools/*.py 必须先给 stdout/stderr 设 UTF-8
 * ---------------------------------------------------------------------------
 * 起因（2026-09-30 实测复现）：
 *   Windows 控制台默认 GBK，而本仓多个 python 工具要打印 ✓ / ✗。Python 遇到
 *   无法用 GBK 编码的字符会抛 UnicodeEncodeError，**中断整个检查**并以 rc=1 退出：
 *
 *       $ python tools/audit-at-reads.py
 *       UnicodeEncodeError: 'gbk' codec can't encode character '\u2713' …
 *
 *   rc=1 在这些工具的语义里是「检查发现问题」，于是编码崩溃会被**误读成真实告警**
 *   （audit-at-reads 看起来像「AT 读写分类有问题」，find-private-ids 看起来像
 *   「发现未登记的真机标识」）—— 这正是最坏的一类失败：噪声盖住真问题。
 *
 *   tools/verify-guards.py 早在 2026-09-28 就踩过同一坑（其 1900-1910 行有完整记录）
 *   并加了兜底，但当时**只修了那一处**；audit-at-reads / find-orphans /
 *   find-private-ids 三个文件一直没修。
 *
 * 判据：任何出现 ✓(U+2713) 或 ✗(U+2717) 字面量的 tools/*.py，必须同时出现
 *   reconfigure( —— 即照 verify-guards.py 的写法把两个流强制成 UTF-8 并容错。
 * 反向自检：判据必须真的覆盖到 verify-guards.py（它带兜底），否则说明判据恒绿无效。
 *
 * 用法：node tests/tool-gbk-encoding-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'tools');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

const pyFiles = fs.readdirSync(TOOLS).filter(function (n) { return /\.py$/.test(n); });

/* 打印 ✓/✗ 的文件 → 必须有编码兜底；未打印的不受本契约约束（GBK 能表示中文与 → ★） */
const printers = [];
const offenders = [];
pyFiles.forEach(function (name) {
	const src = fs.readFileSync(path.join(TOOLS, name), 'utf8');
	const printsMarks = /[\u2713\u2717]/.test(src);
	const guarded = /reconfigure\(/.test(src);
	if (printsMarks) {
		printers.push({ name: name, guarded: guarded });
		if (!guarded) offenders.push(name);
	}
});

ok('扫到了 tools/ 下的 python 工具（否则本测试等于没跑）', pyFiles.length >= 5,
	'只扫到 ' + pyFiles.length + ' 个');

ok('确实存在打印 ✓/✗ 的工具（否则本判据不适用、等于恒绿）', printers.length > 0,
	'一个都没扫到');

/* 反向自检：判据要能认出「带兜底的样本」，否则可能是正则写错导致全都不匹配 */
ok('★ 反向自检：判据覆盖到 verify-guards.py 且识别出它的兜底（它 2026-09-28 就修过）',
	printers.some(function (p) { return p.name === 'verify-guards.py' && p.guarded; }),
	JSON.stringify(printers));

ok('所有打印 ✓/✗ 的 tools/*.py 都做了 UTF-8 输出兜底（GBK 控制台不再中断流程）',
	offenders.length === 0,
	offenders.join('、') + '　修法：仿 tools/verify-guards.py:1906-1910，在 __main__ 里对 ' +
	'sys.stdout / sys.stderr 调 reconfigure(encoding="utf-8", errors="replace")');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('工具输出编码契约测试通过（' + printers.length + ' 个打印 ✓/✗ 的工具都已兜底）');
