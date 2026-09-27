#!/usr/bin/env node
/*
 * LuCI core 兼容垫片（compat.js / AtCompat）契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * ★ 为什么必须有这个文件（2026-09-28）：
 *   覆盖率盘点发现 **compat.js 是 7 个前端共享模块里唯一"被 0 个测试提到"的**
 *   —— 它此前完全没有守卫。而它是个**全局兜底**：补 `String.prototype.format`。
 *
 *   它失效的后果不是"某个功能坏了"，而是**整个插件不可用**：
 *     luci.js 的 bootstrap 用 `'%s/%s.js%s'.format(...)` 拼 require 的 URL
 *     （luci.js 的 require()），而 `this.require('ui')` 在 DOMContentLoaded 之前
 *     就执行。在部分 LuCI master 构建里 format 的定义被拆掉/摇树优化后，
 *     这一步抛 `TypeError: "%s/%s.js%s".format is not a function`；
 *     异常被 `Promise.all(...).catch(this.error)` 吞掉 → `setupDOM()` 永不执行
 *     → **所有视图的 load()/render() 都不运行** → 页面只剩 HTML 骨架，
 *     表现为「页面能打开但功能全不可用」。
 *
 *   compat.js 自己的注释里也写着 `api.format` 是「便于自检」，但自检一直没写。
 *   本文件就是那份自检。
 *
 * 运行：node tests/compat-shim-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const COMPAT = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'compat.js');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');

const src = fs.readFileSync(COMPAT, 'utf8');
const rpcSrc = fs.readFileSync(RPC, 'utf8');

let n = 0, bad = 0;
function ok(name, cond, extra) {
	n++;
	if (cond) { console.log('  ✓ ' + name); }
	else { bad++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function eq(name, got, want) {
	// ★ 写成 `name + ''` 而不是裸 `name`：本仓的 assert-signature-contract
	//   用 /^[\w$.[\]]+\s*\+\s*['"`]/ 判「第一个参数是不是名称」，裸变量不算名称，
	//   会被判成「断言名会变成表达式」而报警。（这正是它自己的注释里说的那个盲区：
	//   包装函数里的 ok(name, ...) 是合法的，但静态判据只认字面量拼接。）
	ok(name + '', got === want, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want));
}

/*
 * 载入 compat.js。它是 LuCI 模块格式（最外层直接 `return AtCompatClass;`），
 * 直接 runInContext 会因顶格 return 报语法错误，所以包一层函数。
 *
 * ★ 每次都用一个**干净的 context**：模块顶层会写 `String.prototype.format`，
 *   复用 context 会让第二组断言测到上一组装好的实现，"仅当未定义时才安装"
 *   那条就永远为真（空转）。
 */
/*
 * L.Class.extend 的替身：必须返回**真正的构造函数**。
 *   compat.js 末尾是 `window.AtCompat = new AtCompatClass();`，而 `new` 一个
 *   普通对象会抛 `TypeError: AtCompatClass is not a constructor`（本文件首版踩过，
 *   而且那个异常发生在**模块求值**阶段 —— 正是垫片要防的那种"整个模块挂掉"）。
 */
function makeClass(props) {
	function C() { }
	Object.assign(C.prototype, props);
	Object.assign(C, props);
	return C;
}

function load(withWindow) {

	/*
	 * ★ 只注入 console / L / window，**不注入 String、Object、JSON 等内置对象**。
	 *   踩过的坑：显式把主 context 的 `String` 传进来，会让 vm context 的全局
	 *   `String` 指向主 context 那一个 —— 于是所有 context **共享同一个
	 *   `String.prototype`**：第一个 load() 装上 format 之后，后面每个 load()
	 *   的 `install()` 都会认为"上游已经实现"，返回 false，
	 *   「模块求值即安装」这条断言随即变成空转。
	 *   让每个 context 用自己的内置对象，才能测到真实的首次安装路径。
	 */
	const ctx = {
		console,
		L: { Class: { extend: makeClass } }
	};
	// window 存在与否是 compat.js 里显式判断的两条路径（:95），两条都要能载入
	ctx.window = withWindow ? {} : undefined;
	vm.createContext(ctx);
	const mod = vm.runInContext('(function(){\n' + src + '\n})()', ctx);
	return { mod, ctx, win: ctx.window };
}

console.log('compat.js 契约测试');

/* ---------- 0. 前置：文件可读（否则下面全是空转） ---------- */
ok('E0 compat.js 可读（否则下面 E1~E9 全是空转）', src.length > 0, '读不到 ' + COMPAT);
ok('E0b 最外层确实是 LuCI 模块格式（有顶格 return）', /^return AtCompatClass;/m.test(src));

/* ---------- 1. 安装行为 ---------- */
{
	const { mod, ctx, win } = load(true);
	ok('E1 模块求值即安装（api.installed 为 true）', mod.installed === true, String(mod.installed));
	ok('E1b 安装后 String.prototype.format 是函数',
		vm.runInContext('typeof String.prototype.format', ctx) === 'function');
	eq('E1c available() 报告已可用', mod.available(), true);
	/*
	 * ★ window 存在时要把实例挂上去（compat.js:95-97）。这条不只是格式检查：
	 *   真实浏览器里 window 必然存在，而 `new AtCompatClass()` 一旦
	 *   AtCompatClass 不是构造函数就会**让整个模块求值抛异常** ——
	 *   模块求值发生在 rpc.js 的 require 链上，抛出去就是垫片没装上、页面全废。
	 */
	ok('E1d window 存在时把实例挂到 window.AtCompat', !!(win && win.AtCompat),
		'window.AtCompat = ' + (win && win.AtCompat));
	// 另一条路径：window 不存在时也必须能求值（compat.js:95 显式判断过）
	{
		var r = load(false);
		ok('E1e window 不存在时模块仍能求值且垫片照装',
			r.mod.installed === true && r.win === undefined);
	}
}

/* ---------- 2. 语义：%s / %d / %j / %% ---------- */
{
	const { mod } = load(true);
	eq('E2 %s 替换字符串', mod.format('%s/%s.js', 'a', 'b'), 'a/b.js');
	eq('E2b %d 替换整数', mod.format('n=%d', 42), 'n=42');
	eq('E2c %d 对数字字符串也取整', mod.format('n=%d', '42.9'), 'n=42');
	eq('E2d %j 做 JSON 序列化', mod.format('j=%j', { a: 1 }), 'j={"a":1}');
	eq('E2e %% 转义为字面 %', mod.format('100%%'), '100%');
	eq('E2f %% 不消耗参数', mod.format('%%s=%s', 'x'), '%s=x');
}

/* ---------- 3. 边界：参数不足 / 多余 / 空值 / %d 非数字 ---------- */
{
	const { mod } = load(true);
	eq('E3 参数不足时保留占位符（不抛）', mod.format('%s-%s', 'only'), 'only-%s');
	eq('E3b 参数多余时追加到末尾（luci 惯例）',
		mod.format('a=%s', 'x', 'y', 'z'), 'a=x y z');
	eq('E3c null 与 undefined 都渲染成空串',
		mod.format('[%s][%s]', null, undefined), '[][]');
	eq('E3d %d 收到非数字时回落到原值文本（不变成 NaN）',
		mod.format('n=%d', 'abc'), 'n=abc');
	eq('E3e %j 遇到循环引用不抛（回落 String(v)）', (function () {
		const o = {}; o.self = o;
		let r;
		try { r = mod.format('%j', o); } catch (e) { return 'THREW'; }
		return typeof r === 'string' && r.indexOf('%j') < 0 ? 'ok' : 'bad:' + r;
	})(), 'ok');
	eq('E3f 无占位符时原样返回', mod.format('plain text'), 'plain text');
}

/* ---------- 4. 不覆盖上游实现（这条是"垫片"的底线） ---------- */
{
	const { mod, ctx, win } = load(true);
	// 先装一个上游实现，再调 install()，必须返回 false 且不动它
	const sentinel = vm.runInContext(
		'(function(){ String.prototype.format = function(){ return "UPSTREAM"; };' +
		' return AtCompatInstall(); })()'
			.replace('AtCompatInstall()', 'AtCompat.install()'),
		Object.assign(ctx, { AtCompat: mod })
	);
	eq('E4 已有上游实现时 install() 返回 false（不覆盖）', sentinel, false);
	eq('E4b 上游实现原样保留',
		vm.runInContext('"x".format()', ctx), 'UPSTREAM');
}

/* ---------- 5. 接入方式：必须是所有视图的共同依赖最先 require ---------- */
/*
 * compat.js 的生效前提是**时序**：它的顶层副作用必须早于 luci.js 的
 * require('ui')。rpc.js 是所有视图的共同依赖，所以它承担这个职责。
 * 有人把这行 require 挪走/删掉，页面就又会变成"能打开但功能全不可用"。
 */
ok('E5 rpc.js require 了 compat（否则垫片不生效）', /require\s+at-webserver\/compat/.test(rpcSrc));
{
	const mCompat = rpcSrc.search(/require\s+at-webserver\/compat/);
	const firstOther = rpcSrc.search(/require\s+at-webserver\/(?!compat)/);
	ok('E5b compat 是 rpc.js 里最早的 at-webserver require（时序是它的生效前提）',
		mCompat >= 0 && (firstOther < 0 || mCompat < firstOther),
		'compat@' + mCompat + ' firstOther@' + firstOther);
}

/* ---------- 6. 反向自证：这套断言真的能判红 ---------- */
/*
 * ★ 不写这几条，"E1~E5 全绿"可能只是因为断言本身写错了（空转）。
 *   做法：把源码按已知缺陷形态改一处，断言必须**不再成立**。
 */
{
	// 自证 A：把 %% 分支去掉 → E2e 必须失败
	const broken = src.replace("if (m === '%%') return '%';", '');
	const ctx = { console, L: { Class: { extend: makeClass } }, window: {} };
	vm.createContext(ctx);
	const mod = vm.runInContext('(function(){\n' + broken + '\n})()', ctx);
	ok('自证 A：去掉 %% 分支后，E2e 的期望值不再成立',
		mod.format('100%%') !== '100%', '改坏了却仍返回 100%？');

	// 自证 B：把"参数不足保留占位符"改成空串 → E3 必须失败
	const b2 = src.replace('if (index >= args.length) return m;', 'if (index >= args.length) return "";');
	const ctx2 = { console, L: { Class: { extend: makeClass } }, window: {} };
	vm.createContext(ctx2);
	const mod2 = vm.runInContext('(function(){\n' + b2 + '\n})()', ctx2);
	ok('自证 B：参数不足改成返回空串后，E3 的期望值不再成立',
		mod2.format('%s-%s', 'only') !== 'only-%s', '改坏了却仍保留占位符？');

	// 自证 C：去掉"已有实现就不覆盖"的判断 → E4 必须失败
	const b3 = src.replace("if (typeof String.prototype.format === 'function') return false;", '');
	const ctx3 = { console, L: { Class: { extend: makeClass } }, window: {} };
	vm.createContext(ctx3);
	const mod3 = vm.runInContext('(function(){\n' + b3 + '\n})()', ctx3);
	ok('自证 C：去掉"不覆盖上游"判断后，install() 不再返回 false',
		mod3.install() !== false, '改坏了却仍返回 false？');
}

console.log(bad === 0
	? '\n✓ compat 契约 ' + n + ' 项断言通过（全局垫片 / format 语义 / 不覆盖上游 / 接入时序）'
	: '\n✗ ' + bad + ' 项断言失败（共 ' + n + ' 项）');
process.exit(bad === 0 ? 0 : 1);
