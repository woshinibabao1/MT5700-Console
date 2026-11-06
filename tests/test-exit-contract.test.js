#!/usr/bin/env node
/*
 * 测试自身的「出口」契约 —— 每个测试文件失败时都必须让退出码非 0
 * ---------------------------------------------------------------------------
 * 2026-11-06 事故：
 *   sms-reachability-contract.test.js 在一次重写后，结尾变成
 *       console.log('通过 ' + pass + ' 项，失败 0 项');
 *       console.log('短信承载域 / CS 域解析契约测试全部通过');
 *   既不打印 fails，也没有 process.exit —— 于是**任何断言失败都只让
 *   「通过 16 项」掉成「通过 15 项」，退出码恒为 0**。
 *   run-all.js 判定成败只看退出码（这是对的），所以它报 PASS；
 *   CI 里真正把这件事捅出来的是 verify-guards 的 [15] 号变异
 *   「CS 域判定丢掉 stat=5」——变异后判红 0 处，报「变异被放过」。
 *
 *   换句话说：那条守卫从重写当日起就是死的，而且是靠另一套机制
 *   （变异验证）间接发现的。**测试自己恒绿，比没有测试更危险**：
 *   它会让「改坏了」看起来像「改对了」（红线 18）。
 *
 * 本文件把这条要求变成机器可查的一条契约：
 *   ① 每个被 run-all 收集的测试文件，必须存在**参数不是裸 0** 的
 *      `process.exit(...)` 调用 —— 也就是至少要有一条通往非零退出码的路。
 *   ② 反向自证：拿假源码验证判定器真的会判否，否则本文件也是空转。
 *
 * 边界（刻意不做的事）：
 *   · 静态检查看不出 `process.exit(x)` 里 x 到底是不是恒 0 —— 那是停机问题。
 *     这里只保证「存在非零出口」，语义正确性仍由 verify-guards 的变异验证兜。
 *   · **不检查「失败 0 项」字面量**。起初加过这条，实测全仓 8 个文件命中，
 *     逐个看下来全是正确写法：`if (fails.length) { …; process.exit(1); }`
 *     之后紧接成功行 `console.log('… 失败 0 项')` —— 那行只在没失败时执行，
 *     恰好是对的。写死字面量本身无害，**缺少非零出口**才是致命的，而那已经
 *     被 ① 覆盖。启发式只会逼着人改写法去迎合检查，不会多抓到一个 bug。
 *
 * 运行：node tests/test-exit-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TESTS = __dirname;

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}

/*
 * 收集规则必须与 tests/run-all.js 保持一致 —— 那边改了命名规则（早先只扫
 * 当前目录、只认 .test.js，漏掉了 mock-modem/parse-extra-test.js），这里
 * 若不同步，漏掉的正是「没被跑到」的那些，检查看着全绿却没有覆盖。
 * 上面那次事故就是靠这条规则把 e2e-test.js（要连 mock 服务端）排除在外。
 */
function collect(d, out) {
	for (const name of fs.readdirSync(d)) {
		const p = path.join(d, name);
		if (fs.statSync(p).isDirectory()) collect(p, out);
		else if (/^[^.].*(-test|\.test)\.js$/.test(name) && name !== 'e2e-test.js') out.push(p);
	}
	return out;
}

/* 剥掉注释再判 —— 否则「说明里提到 process.exit(1)」会被当成真代码。
 * 实测踩过：把 sms-reachability 的收尾改回恒绿后本检查仍报绿，因为文件头
 * 的事故说明里写着「也不 process.exit(1)」，正则命中了那句注释。
 * `(^|[^:])` 是为了放过字符串里的 http:// —— 那不是注释。 */
function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/* 判定：源码里是否存在一条「不是裸 0」的退出路径（只在真代码里找）。 */
function hasRedPath(src) {
	const calls = stripComments(src).match(/process\.exit\s*\([^)]*\)/g) || [];
	return calls.some(function (c) {
		const arg = c.replace(/^process\.exit\s*\(/, '').replace(/\)$/, '').trim();
		return arg !== '0';
	});
}

/* ---------- ① 反向自证：判定器本身必须先被证明不是恒真 ---------- */

ok('自证 A：只有 console.log 的源码判否（本次事故的最小复现）',
	hasRedPath("console.log('全部通过');") === false,
	'没有退出路径却判真，说明判定器恒真');

ok('自证 B：process.exit(0) 判否（有 exit 不等于有出口）',
	hasRedPath('process.exit(0);') === false,
	'裸 0 也判真，说明只看「有没有 process.exit」');

ok('自证 C：process.exit(fail ? 1 : 0) 判真（全仓主流写法）',
	hasRedPath('process.exit(fail ? 1 : 0);') === true);

ok('自证 D：process.exit(bad === 0 ? 0 : 1) 判真（比较式写法）',
	hasRedPath('process.exit(bad === 0 ? 0 : 1);') === true);

ok('自证 E：批处理写法 fails.length 也算判真',
	hasRedPath('if (fails.length) { process.exit(1); }') === true);

ok('自证 F：只在注释里提到 process.exit(1) 的源码必须判否（实测踩过的坑）',
	hasRedPath('/* 这里本该有 process.exit(1)，但被删了 */\nconsole.log("全部通过");') === false,
	'注释被当成代码 —— 说明里写一句就骗过了检查');

ok('自证 G：注释里的 // process.exit(1) 同样不算',
	hasRedPath('// process.exit(1)\nprocess.exit(0);') === false);

/* ---------- ② 逐个文件核 ---------- */

const files = collect(TESTS, []).sort();
ok('收集到测试文件（规则与 run-all.js 一致）', files.length > 50,
	'只找到 ' + files.length + ' 个，收集规则可能已经和 run-all.js 走散');

const noExit = [];
for (const abs of files) {
	const rel = path.relative(ROOT, abs).split(path.sep).join('/');
	if (!hasRedPath(fs.readFileSync(abs, 'utf8'))) noExit.push(rel);
}

ok('每个测试文件都有一条非零退出路径',
	noExit.length === 0,
	noExit.length + ' 个文件失败时退出码仍是 0（断言失败被静默吞掉）：' + noExit.join(', '));

/* ---------- 汇总 ---------- */
if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（' + files.length + ' 个测试文件均具备非零退出路径 / 判定器反向自证）');
process.exit(0);
