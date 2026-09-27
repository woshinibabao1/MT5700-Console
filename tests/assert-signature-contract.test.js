#!/usr/bin/env node
'use strict';

/*
 * 断言签名契约：**每个测试文件的 ok(…) / eq(…) 定义与调用顺序必须自洽**
 * ---------------------------------------------------------------------------
 * 起因（本轮真实踩到）：仓里多数测试文件的 ok 是 `ok(name, cond, detail)`，
 * 但有少数文件是**反过来的** `ok(cond, name)`。从别处复制一条断言过来、
 * 忘了调换顺序，字符串就落进了 cond 的位置：
 *
 *     ok('暂存项 led 走 ctrlStaged.set', !!m);   // cond 是个非空字符串 → 恒为真
 *
 * 结果这条断言**永远通过**，而它看起来和其它断言一模一样 ——
 * 这是最难发现的一类"假守卫"：文件在跑、数字在涨、什么都不防。
 *
 * ★ 2026-09-28 扩展到 eq(…)：eq 同样有两种相反的顺序 —— 多数文件是
 *   `eq(label, got, want)`，而 device-control-contract.test.js 是
 *   `eq(actual, expected, name)`（它的 ok 也是 `ok(cond, name)`，整份文件都是反序风格）。
 *   eq 的判定本身是**对称**的（`JSON.stringify(a) === JSON.stringify(b)`，两边互换不影响
 *   结果），所以顺序写错**不会**变成恒真/恒假的假守卫；但它会让报错里的
 *   「实际 / 期望」两个标签**互换** —— 排查时把期望当成实际看，等于把人往反方向带。
 *   从别的文件复制一条 eq 过来正是最容易犯的写法，故与 ok 用同一套判据一并守住。
 *   （device-control 的 eq 走 ok()，所以它那句 `ok(cond, name)` 也在本守卫覆盖下。）
 *
 * 本守卫对每个测试文件、每个受管函数名（ok / eq）：
 *   1. 看 `function <fn>(…)` 的第一个参数名，判定方向（值在前 / 名称在前）；
 *   2. 扫所有 `<fn>(` 调用，看第一个实参是不是字符串字面量；
 *   3. 两者矛盾就判红并指出文件与行号。
 *
 * 单参数的 ok(name)（只打印、不判定，如 sms-concurrency 的）跳过：
 * 它不参与成败，无从谈方向。
 *
 * 用法：node tests/assert-signature-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TESTS = path.join(ROOT, 'tests');
const SKIP_DIRS = ['node_modules', '.git'];

/* 受管的断言函数名。加新名字时：它的第一个参数必须能落进下面两张词表之一，
   否则 `unknowns` 会判红提醒补词 */
const GUARDED = ['ok', 'eq'];

/* 参数名 → 方向。命中 cond 类是"值在前"，命中 name 类是"名称在前"
   （eq 的第一参数名通常就是 label / actual / name，正好落在这两张表里，
     所以 2026-09-28 扩展时不需要改词表 —— 实测 16 个文件全部可判定） */
const COND_WORDS = ['cond', 'ok', 'pass', 'flag', 'value', 'actual', 'test', 'c', 'v'];
const NAME_WORDS = ['name', 'label', 'msg', 'desc', 'title', 'text', 'why', 'hint', 'detail'];

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

function walk(dir, out) {
	fs.readdirSync(dir).forEach(function (n) {
		if (SKIP_DIRS.indexOf(n) >= 0) return;
		const p = path.join(dir, n);
		if (fs.statSync(p).isDirectory()) { walk(p, out); return; }
		if (/\.js$/.test(n)) out.push(p);
	});
	return out;
}

/* 取 `function <fnName>(` 的参数列表；找不到返回 null（该文件不用这个函数） */
function fnSignature(src, fnName) {
	const m = new RegExp('\\bfunction\\s+' + fnName + '\\s*\\(([^)]*)\\)').exec(src);
	if (!m) return null;
	const params = m[1].split(',').map(function (s) { return s.trim(); })
		.filter(function (s) { return s.length; });
	return params;
}

function direction(params) {
	if (params.length < 2) return 'skip';            /* 单参数：不参与判定 */
	const first = params[0].toLowerCase();
	if (COND_WORDS.indexOf(first) >= 0) return 'cond-first';
	if (NAME_WORDS.indexOf(first) >= 0) return 'name-first';
	return 'unknown';
}

/*
 * 剥掉注释再扫，否则注释里提到 ok(…) 也会被当成一条调用
 * （仓里确实有这种注释：某处专门写着"此前留了一条 ok(..., true) 的恒真断言"）。
 * 替换成等长空格 —— 行号不变，报错才能指到真实位置。
 */
function stripCommentsPreserve(src) {
	let out = '';
	let i = 0;
	let inStr = null;
	let inLine = false;
	let inBlock = false;
	while (i < src.length) {
		const c = src[i];
		const n = src[i + 1];
		if (inLine) {
			out += (c === '\n' ? '\n' : ' ');
			if (c === '\n') inLine = false;
			i++;
			continue;
		}
		if (inBlock) {
			if (c === '*' && n === '/') { out += '  '; i += 2; inBlock = false; continue; }
			out += (c === '\n' ? '\n' : ' ');
			i++;
			continue;
		}
		if (inStr) {
			/*
			 * ★ 2026-09-28：字符串**内容**也要抹成等长空格 —— 只剥注释不够。
			 *   本文件的反向自检就是把示例代码写成字符串的：
			 *     const badFile = 'function ok(cond, name)…\n' + "ok('永远通过', true);\n";
			 *   不抹的话，那个字符串里的 ok(…) 会被扫成一条**真实调用**，
			 *   于是自检自己触发违规、本守卫恒判红（2026-09-28 扩展 eq 时正是这么暴露的）。
			 *   ★ 外层引号**必须保留**：firstArgIsName 就是靠"第一个非空白字符是不是引号"
			 *     来判断第一个实参是不是断言名的。
			 */
			if (c === '\\') { out += '  '; i += 2; continue; }
			if (c === inStr) { out += c; inStr = null; i++; continue; }
			out += (c === '\n' ? '\n' : ' ');
			i++;
			continue;
		}
		if (c === '/' && n === '/') { inLine = true; out += '  '; i += 2; continue; }
		if (c === '/' && n === '*') { inBlock = true; out += '  '; i += 2; continue; }
		if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue; }
		out += c;
		i++;
	}
	return out;
}

/* 第一个实参是不是"断言名"：字符串字面量，或 `label + ' …'` 这种拼接命名 */
function firstArgIsName(clean, from) {
	let i = from;
	while (i < clean.length && /[\s\r\n]/.test(clean[i])) i++;
	const ch = clean[i];
	if (ch === "'" || ch === '"' || ch === '`') return true;
	return /^[\w$.[\]]+\s*\+\s*[\x22\x27\x60]/.test(clean.slice(i));
}

/* 扫 <fnName>( 调用，返回 [{line, nameFirst}]。跳过**定义处**那一个 ——
   注意 `function ok(` 里 `ok(` 的下标不是 search 的结果（那是 `function` 的位置），
   直接比较会把定义本身当成一条调用，于是每个文件都误报一处。 */
function collectCalls(rawSrc, fnName) {
	const src = stripCommentsPreserve(rawSrc);
	const dm = new RegExp('\\bfunction\\s+' + fnName + '\\s*\\(').exec(src);
	const defOkIdx = dm ? dm.index + dm[0].indexOf(fnName) : -1;
	const out = [];
	const re = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
	let m;
	while ((m = re.exec(src)) !== null) {
		if (m.index === defOkIdx) continue;
		out.push({
			line: src.slice(0, m.index).split('\n').length,
			nameFirst: firstArgIsName(src, m.index + m[0].length)
		});
	}
	return out;
}

const files = walk(TESTS, []);
ok('扫到了测试文件（否则本守卫等于没跑）', files.length >= 20,
	'只扫到 ' + files.length + ' 个');

/*
 * ★ 2026-09-28：光有 `>= 20` 挡不住"扫描范围悄悄变小" —— 仓里现有 71 个 .js，
 *   门槛 20 意味着漏掉几十个也照样通过。这里按 module-extract-anchor 的 ②z2 同一手法，
 *   把**必须被扫到的关键文件逐个点名**；数字门槛保留（它防的是路径写错成 0）。
 */
const MUST_SCAN = ['assert-signature-contract.test.js', 'undefined-fn-contract.test.js',
	'parse-contract.test.js', 'euicc-contract.test.js', 'vowifi-contract.test.js'];
const notScanned = MUST_SCAN.filter(function (n) {
	return !files.some(function (p) { return p.endsWith(n); });
});
ok('★ 关键守卫文件都在扫描范围内（逐个点名，少一个就判红）',
	notScanned.length === 0, '没扫到：' + notScanned.join('、'));

const offenders = [];
const unknowns = [];
const checked = {};      /* fnName → 判定了多少份文件 */
GUARDED.forEach(function (f) { checked[f] = 0; });

files.forEach(function (p) {
	const rel = path.relative(ROOT, p).split(path.sep).join('/');
	let src;
	try { src = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
	GUARDED.forEach(function (fnName) {
		const params = fnSignature(src, fnName);
		if (!params) return;                     /* 不用这个函数的文件不归本守卫管 */
		const dir = direction(params);
		if (dir === 'skip') return;              /* 单参数：只打印，不判定 */
		if (dir === 'unknown') {
			unknowns.push(rel + '（' + fnName + '(' + params.join(', ') + ')）');
			return;
		}
		checked[fnName]++;
		collectCalls(src, fnName).forEach(function (c) {
			if (dir === 'cond-first' && c.nameFirst) {
				offenders.push(rel + ':' + c.line + ' —— ' + fnName + ' 定义是 ' + fnName + '(' + params[0]
					+ ', …)，这里却把名称放在第一个参数（ok 会恒为真 / eq 的「实际·期望」标签会互换）');
			}
			if (dir === 'name-first' && !c.nameFirst) {
				offenders.push(rel + ':' + c.line + ' —— ' + fnName + ' 定义是 ' + fnName + '(' + params[0]
					+ ', …)，第一个参数却不是名称（断言名会变成表达式）');
			}
		});
	});
});

/* ★ 2026-09-28：这两个门槛原来分别是 20 / 10，而实测定义了 ok() 的有 63 份、
   定义了 eq() 的有 16 份 —— 门槛留得太低，少判几十个文件也照样通过。
   按实测下调余量（不写死等于实测值，留出增删测试文件的弹性）。 */
ok('判定了一批文件的方向（否则本守卫等于没跑）', checked.ok >= 50,
	'ok 只判定了 ' + checked.ok + ' 个（实测 60+）');
ok('★ eq 也判到了一批文件（2026-09-28 扩展；为 0 说明 eq 检查等于没跑）',
	checked.eq >= 14, 'eq 只判定了 ' + checked.eq + ' 个（仓里 16 份文件定义了 eq）');
ok('★ 每个测试文件的 ok(…) 调用顺序都与自身定义一致（反序会让字符串落进条件位 → 恒为真）',
	offenders.filter(function (s) { return s.indexOf(' —— ok ') >= 0; }).length === 0,
	offenders.filter(function (s) { return s.indexOf(' —— ok ') >= 0; }).join('；'));
ok('★ 每个测试文件的 eq(…) 调用顺序都与自身定义一致（反序会让「实际 / 期望」标签互换）',
	offenders.filter(function (s) { return s.indexOf(' —— eq ') >= 0; }).length === 0,
	offenders.filter(function (s) { return s.indexOf(' —— eq ') >= 0; }).join('；'));
ok('所有 ok / eq 定义的首个参数名都能判出方向（无法判定的要补进关键词表）',
	unknowns.length === 0, unknowns.join('；'));

/*
 * 反向自检：造一个「定义 cond 在前、调用却把字符串放前面」的文件，必须判红。
 * 恒绿和"现在恰好都对"从结果上完全看不出区别。
 */
const badFile = 'function ok(cond, name) { if (cond) pass++; }\n'
	+ "ok('这条断言永远通过', true);\n";
const badParams = fnSignature(badFile, 'ok');
ok('★ 反向自检 A：ok 反序调用确实被判为违规（不是恒绿）',
	direction(badParams) === 'cond-first'
	&& collectCalls(badFile, 'ok').some(function (c) { return c.nameFirst; }));

const goodFile = 'function ok(name, cond) { if (cond) pass++; }\n'
	+ "ok('这条断言名在前', true);\n";
const goodParams = fnSignature(goodFile, 'ok');
ok('★ 反向自检 B：ok 顺序正确的调用被放过（不误伤）',
	direction(goodParams) === 'name-first'
	&& collectCalls(goodFile, 'ok').every(function (c) { return c.nameFirst; }));

/* eq 的反向自检：两种顺序各造一个，正例必须放过、反例必须判红。
   这两条同时钉住「扩展进来的 eq 检查真的在判」与「它没有把合法写法误伤」——
   仓里恰好两种顺序都有（15 份 eq(label, got, want) + device-control 的
   eq(actual, expected, name)），所以正例取后者、反例取前者在这份文件里的写法。 */
const eqValueFirst = 'function eq(actual, expected, name) { }\n'
	+ "eq(NIC_VALUES, ['1', '2'], '值域固定');\n";
const eqValueParams = fnSignature(eqValueFirst, 'eq');
ok('★ 反向自检 C：eq 值在前时，第 1 参是表达式的调用被放过（device-control 的写法）',
	direction(eqValueParams) === 'cond-first'
	&& collectCalls(eqValueFirst, 'eq').every(function (c) { return !c.nameFirst; }));

const eqNameFirst = 'function eq(label, got, want) { }\n'
	+ "eq('名称', 1, 2);\n";
const eqNameParams = fnSignature(eqNameFirst, 'eq');
ok('★ 反向自检 D：eq 名称在前时，第 1 参是字符串的调用被放过（多数文件的写法）',
	direction(eqNameParams) === 'name-first'
	&& collectCalls(eqNameFirst, 'eq').every(function (c) { return c.nameFirst; }));

const eqMixed = 'function eq(label, got, want) { }\n'
	+ "eq(Parse.parseNicRange('x'), ['0', '1'], '名称');\n";
ok('★ 反向自检 E：eq 定义名称在前、调用却按值在前 → 必须判红（复制粘贴的典型错法）',
	direction(fnSignature(eqMixed, 'eq')) === 'name-first'
	&& collectCalls(eqMixed, 'eq').some(function (c) { return !c.nameFirst; }));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
