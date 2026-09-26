#!/usr/bin/env node
'use strict';

/*
 * 模块提取锚点契约
 * ---------------------------------------------------------------------------
 * 起因（2026-09-26 真实踩到，整片测试一次性崩掉）：
 *
 *   仓里有 23 处测试用这条正则把 LuCI 模块从源码里抠出来跑：
 *       /var X = \((function[\s\S]*?)\)\(\);/
 *   它是**非贪婪**的，遇到模块内部任何一个 IIFE 的收尾 `})();` 就提前结束。
 *   当天往 parse.js 里加了一个内部 IIFE，结果：
 *       7 个测试 SyntaxError: Unexpected end of input
 *       5 个测试「无法从 xxx.js 中提取模块」
 *   而 parse.js 本身一个字符都没写错 —— 崩的是**提取方式**，不是被测代码。
 *
 * 修法：模块真正的收尾 `})();` 是**顶格**的，内部 IIFE 的收尾都带缩进。
 * 于是把锚点收紧成「换行 + 顶格 }」：
 *       /var X = \((function[\s\S]*?\n\})\)\(\);/
 *
 * ★ 两个已经踩过的写法错误（写错就整片崩，注释在这里免得再踩）：
 *   ① 只插 \n 不插 \}  → 匹配不上（文本是 `\n})();`，`}` 在 `\n` 之后）；
 *   ② 把 \n\} 插到分组**外面** → 抠出来的函数体少了收尾 `}`，
 *      eval 时 SyntaxError: Unexpected token ')'。
 *   必须让 `\n}` 留在分组**内部**：分组以 `\n}` 结尾，后面 `\)\(\);` 吃掉 `)();`。
 *
 * 本守卫钉三件事：
 *   ① 反例证明「脆弱版真的会截断、锚定版不会」—— 否则这条规矩没有依据；
 *   ② 每个前端模块用锚定版抠出来的函数体**必须能编译通过**（长度不撒谎，
 *      能不能 eval 才撒不了谎）；
 *   ③ tests/ 里不允许再出现未加锚的提取正则。
 *
 * 用法：node tests/module-extract-anchor.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs', 'luci-static', 'resources');
const TESTS = path.join(ROOT, 'tests');

let pass = 0;
const fails = [];

function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

function walk(dir, out) {
	fs.readdirSync(dir).forEach(function (n) {
		if (n === 'node_modules' || n === '.git') return;
		const p = path.join(dir, n);
		if (fs.statSync(p).isDirectory()) { walk(p, out); return; }
		if (/\.js$/.test(n)) out.push(p);
	});
	return out;
}

/* ---------- ① 反例：脆弱版必须真的脆弱 ---------- */

/*
 * 造一份**带内部 IIFE** 的模块源码：内部 IIFE 收尾带缩进（`\t})();`），
 * 模块真正的收尾顶格。MARKER_TAIL 放在内部 IIFE 之后 —— 谁把它抠丢了，
 * 谁就是提前收尾了。
 */
const SAMPLE = [
	'var Demo = (function () {',
	'\tvar api = {};',
	'\tapi.inner = (function () { return 1; })();',
	"\tapi.tail = 'MARKER_TAIL';",
	'\treturn api;',
	'})();',
	''
].join('\n');

const FRAGILE_RE = /var Demo = \((function[\s\S]*?)\)\(\);/;
/* 锚定版：分组内以「换行 + 顶格 }」收尾 */
const ANCHORED_RE = /var Demo = \((function[\s\S]*?\n\})\)\(\);/;

const fragileCap = (FRAGILE_RE.exec(SAMPLE) || [])[1];
const anchoredCap = (ANCHORED_RE.exec(SAMPLE) || [])[1];

ok('①a 脆弱正则确实能匹配（反例不是靠"根本匹配不上"通过的）',
	typeof fragileCap === 'string' && fragileCap.length > 0);
ok('①b 脆弱正则在内部 IIFE 处提前收尾，丢掉了后面的内容',
	typeof fragileCap === 'string' && fragileCap.indexOf('MARKER_TAIL') < 0,
	'脆弱版没有截断，说明反例构造失效');
ok('①c 锚定正则取回完整函数体（含内部 IIFE 之后的 MARKER_TAIL）',
	typeof anchoredCap === 'string' && anchoredCap.indexOf('MARKER_TAIL') >= 0,
	'锚定版也截断了，说明锚点写错了');
ok('①d 锚定版取回的分组以换行 + } 收尾（能直接 eval）',
	typeof anchoredCap === 'string' && /\n\}$/.test(anchoredCap),
	JSON.stringify(String(anchoredCap).slice(-12)));

/* ---------- ② 真机源码：锚定版抠出来的每个模块都必须能编译 ---------- */

/*
 * 逐个模块验证。判据不用「长度」也不用「含不含某行文本」——
 * 那两种都能靠巧合通过；直接丢给 Function 编译器，抠坏了一定抛异常。
 */
const MODULE_FILES = walk(path.join(RES, 'at-webserver'), [])
	.concat(walk(path.join(RES, 'view', 'at-webserver'), []));

let declared = 0;
MODULE_FILES.forEach(function (file) {
	const src = fs.readFileSync(file, 'utf8');
	const names = [];
	const declRe = /(?:^|\n)var\s+(\w+)\s*=\s*\(function/g;
	let m;
	while ((m = declRe.exec(src)) !== null) names.push(m[1]);
	names.forEach(function (name) {
		declared++;
		const rel = path.relative(ROOT, file).replace(/\\/g, '/');
		const re = new RegExp('var\\s+' + name + '\\s*=\\s*\\((function[\\s\\S]*?\\n\\})\\)\\(\\);');
		const cap = (re.exec(src) || [])[1];
		ok('② ' + rel + ' 的 ' + name + ' 用锚定正则能取到完整函数体',
			typeof cap === 'string' && cap.length > 0);
		if (typeof cap !== 'string') return;
		let compileErr = '';
		try {
			/* 只编译不执行：模块里会引用 L / window 等浏览器全局，跑不得 */
			new Function('return (' + cap + ')');
		} catch (e) {
			compileErr = e.message;
		}
		ok('② ' + rel + ' 的 ' + name + ' 抠出来的函数体能编译通过',
			compileErr === '', compileErr);
	});
});

ok('②z 至少扫到 6 个模块声明（扫描器没空转）', declared >= 6, '实际 ' + declared);

/* ---------- ③ 测试侧：不允许再出现未加锚的提取正则 ---------- */

/* 未加锚的样子：`(function[\s\S]*?)` 之后直接就是分组收尾 */
const FRAGILE_PATTERN = /\(function\[\\s\\S\]\*\??\)(?!\\n\\})/;

function hasFragile(src) {
	return FRAGILE_PATTERN.test(src);
}

ok('③a 检测器能认出未加锚的提取正则（反例必须先能被抓到）',
	hasFragile("const m = s.match(/var X = \\((function[\\s\\S]*?)\\)\\(\\);/);"),
	'检测器对已知坏样本无反应');
ok('③b 检测器不误伤已加锚的提取正则',
	!hasFragile("const m = s.match(/var X = \\((function[\\s\\S]*?\\n\\})\\)\\(\\);/);"),
	'锚定版被误判为脆弱');

const testFiles = walk(TESTS, []);
const bad = [];
testFiles.forEach(function (f) {
	/* 本文件里那两处「脆弱正则」是 ① / ③a 的反例样本，是**故意**留的，跳过自己 */
	if (path.basename(f) === 'module-extract-anchor.test.js') return;
	if (hasFragile(fs.readFileSync(f, 'utf8'))) bad.push(path.basename(f));
});
ok('③c tests/ 里没有未加锚的模块提取正则',
	bad.length === 0, bad.join('、'));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.error('模块提取锚点契约失败 ' + fails.length + ' 项：');
	fails.forEach(function (f) { console.error('  ✗ ' + f); });
	console.error('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	process.exit(1);
}
console.log('模块提取锚点契约测试全部通过（' + pass + ' 项）');
