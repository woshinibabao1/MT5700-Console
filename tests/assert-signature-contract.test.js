#!/usr/bin/env node
'use strict';

/*
 * 断言签名契约：**每个测试文件的 ok(…) 定义与调用顺序必须自洽**
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
 * 本守卫对每个测试文件：
 *   1. 看 `function ok(…)` 的第一个参数名，判定方向（条件在前 / 名称在前）；
 *   2. 扫所有 ok( 调用，看第一个实参是不是字符串字面量；
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

/* 参数名 → 方向。命中 cond 类是"条件在前"，命中 name 类是"名称在前" */
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

/* 取 `function ok(` 的参数列表；找不到返回 null（该文件不用 ok） */
function okSignature(src) {
	const m = /\bfunction\s+ok\s*\(([^)]*)\)/.exec(src);
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
			out += c;
			if (c === '\\') { out += (n || ''); i += 2; continue; }
			if (c === inStr) inStr = null;
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
	return /^[\w$.[\]]+\s*\+\s*['"`]/.test(clean.slice(i));
}

/* 扫 ok( 调用，返回 [{line, nameFirst}]。跳过**定义处**那一个 ——
   注意 `function ok(` 里 `ok(` 的下标不是 search 的结果（那是 `function` 的位置），
   直接比较会把定义本身当成一条调用，于是每个文件都误报一处。 */
function collectCalls(rawSrc) {
	const src = stripCommentsPreserve(rawSrc);
	const dm = /\bfunction\s+ok\s*\(/.exec(src);
	const defOkIdx = dm ? dm.index + dm[0].indexOf('ok') : -1;
	const out = [];
	const re = /\bok\s*\(/g;
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

const offenders = [];
const unknowns = [];
let checked = 0;

files.forEach(function (p) {
	const rel = path.relative(ROOT, p).split(path.sep).join('/');
	let src;
	try { src = fs.readFileSync(p, 'utf8'); } catch (e) { return; }
	const params = okSignature(src);
	if (!params) return;                       /* 不用 ok() 的文件不归本守卫管 */
	const dir = direction(params);
	if (dir === 'skip') return;                /* ok(name) 只打印，不判定 */
	if (dir === 'unknown') { unknowns.push(rel + '（ok(' + params.join(', ') + ')）'); return; }
	checked++;
	collectCalls(src).forEach(function (c) {
		if (dir === 'cond-first' && c.nameFirst) {
			offenders.push(rel + ':' + c.line + ' —— 定义是 ok(' + params[0]
				+ ', …)，这里却把名称放在第一个参数（会恒为真，守卫静默失效）');
		}
		if (dir === 'name-first' && !c.nameFirst) {
			offenders.push(rel + ':' + c.line + ' —— 定义是 ok(' + params[0]
				+ ', …)，第一个参数却不是名称（断言名会变成表达式）');
		}
	});
});

ok('判定了一批文件的方向（否则本守卫等于没跑）', checked >= 20,
	'只判定了 ' + checked + ' 个');
ok('★ 每个测试文件的 ok(…) 调用顺序都与自身定义一致（反序会让字符串落进条件位 → 恒为真）',
	offenders.length === 0, offenders.join('；'));
ok('所有 ok 定义的首个参数名都能判出方向（无法判定的要补进关键词表）',
	unknowns.length === 0, unknowns.join('；'));

/*
 * 反向自检：造一个「定义 cond 在前、调用却把字符串放前面」的文件，必须判红。
 * 恒绿和"现在恰好都对"从结果上完全看不出区别。
 */
const badFile = 'function ok(cond, name) { if (cond) pass++; }\n'
	+ "ok('这条断言永远通过', true);\n";
const badParams = okSignature(badFile);
ok('★ 反向自检 A：反序调用确实被判为违规（不是恒绿）',
	direction(badParams) === 'cond-first'
	&& collectCalls(badFile).some(function (c) { return c.nameFirst; }));

const goodFile = 'function ok(name, cond) { if (cond) pass++; }\n'
	+ "ok('这条断言名在前', true);\n";
const goodParams = okSignature(goodFile);
ok('★ 反向自检 B：顺序正确的调用被放过（不误伤）',
	direction(goodParams) === 'name-first'
	&& collectCalls(goodFile).every(function (c) { return c.nameFirst; }));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
