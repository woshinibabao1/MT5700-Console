#!/usr/bin/env node
'use strict';

/*
 * 静默 catch 契约：**吞掉异常必须给出交代**
 * ---------------------------------------------------------------------------
 * 起因（一条反复踩的坑）：写
 *
 *     .catch(function () { busy = false; })
 *
 * 看起来无害，实际把「读不出来」伪装成了「没有」——
 * 卡上明明有回执，界面却说没有；AT 通道断了，页面却显示"不支持 eSIM"。
 * 排查时永远看不出是失败还是真的空，因为**错误在 catch 里凭空消失了**。
 *
 * 但并非所有无参数 catch 都是错的：有些地方的设计就是"失败按没有处理"
 * （例如二维码没识别出来，就当图里没有二维码，不该把用户带到报错页）。
 * 这类**合理吞错**的共同点是：**它旁边写清了为什么**。
 *
 * 所以口径是：无参数 catch 必须满足其一
 *   ① 函数体内有用户可见反馈（改文案 / 提示 / 抛错 / 告警）
 *   ② catch 前后邻近处有注释说明为什么可以吞
 * 两条都不占 = 判红，把隐式决策逼成显式的。
 *
 * 范围限定在 eSIM 链路（euicc.js / esim.js）：这里吞错的代价最大
 * （"卡上没东西"和"读卡失败"在界面上长得一模一样），
 * 全站 80 多处无参数 catch 里大部分是纯 UI 细节，不宜一刀切。
 *
 * 用法：node tests/silent-catch-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ATWB = path.join(ROOT, 'htdocs', 'luci-static', 'resources');
const FILES = [
	path.join(ATWB, 'at-webserver', 'euicc.js'),
	path.join(ATWB, 'view', 'at-webserver', 'esim.js')
];

/* 用户可见反馈：只要出现其一，就说明这个失败**没有**被无声吞掉 */
const FEEDBACK = [
	'textContent', 'appendChild', 'innerHTML', 'insertBefore',
	'Mt5700.', 'renderError', 'errorState', 'throw ',
	'console.warn', 'console.error', 'mt5700-notice'
];

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* 从 `{` 起做括号配对取出函数体，跳过字符串与注释里的括号 */
function extractBody(src, start) {
	let depth = 0;
	let inStr = null;
	let inLine = false;
	let inBlock = false;
	for (let i = start; i < src.length; i++) {
		const c = src[i];
		const n = src[i + 1];
		if (inLine) { if (c === '\n') inLine = false; continue; }
		if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
		if (inStr) {
			if (c === '\\') { i++; continue; }
			if (c === inStr) inStr = null;
			continue;
		}
		if (c === '/' && n === '/') { inLine = true; i++; continue; }
		if (c === '/' && n === '*') { inBlock = true; i++; continue; }
		if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return { body: src.slice(start, i + 1), end: i };
		}
	}
	return { body: src.slice(start), end: src.length };
}

/* 找所有无参数 catch：`.catch(function () {` / `.catch(() => {` */
function findSilentCatches(src) {
	const re = /\.catch\(\s*(function\s*\(\s*\)|function\s*\(\s*\)\s*)?\s*\{|(?:^|[^\w])\.catch\(\s*\(\s*\)\s*=>\s*\{/g;
	const out = [];
	let m;
	while ((m = re.exec(src)) !== null) {
		/* 取 catch 起始处那一段，供后文判断是不是"无参数" */
		const head = src.slice(m.index, m.index + 40);
		if (/catch\(\s*function\s*\(\s*[a-zA-Z_$]/.test(head)) continue;   /* 有参数，会用到 err */
		const brace = src.indexOf('{', m.index + m[0].length - 1);
		if (brace < 0) continue;
		const r = extractBody(src, brace);
		out.push({ index: m.index, body: r.body, end: r.end });
	}
	return out;
}

function hasFeedback(body) {
	return FEEDBACK.some(function (k) { return body.indexOf(k) >= 0; });
}

/* 邻近注释：catch 所在行向上 8 行、向下 2 行（含函数体）里有说明 */
function nearbyNote(src, index, body) {
	if (/\/\/|\/\*/.test(body)) return true;
	const lines = src.slice(0, index).split('\n');
	const up = lines.slice(Math.max(0, lines.length - 8));
	if (up.some(function (l) { return /\/\/|\/\*/.test(l); })) return true;
	const down = src.slice(index).split('\n').slice(0, 3);
	return down.some(function (l) { return /\/\/|\/\*/.test(l); });
}

const texts = FILES.map(function (p) {
	return { name: path.relative(ROOT, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') };
});

ok('读到了 eSIM 链路的两个文件（否则本守卫等于没跑）',
	texts.every(function (f) { return f.src.length > 1000; }));

const offenders = [];
let total = 0;
texts.forEach(function (f) {
	findSilentCatches(f.src).forEach(function (hit) {
		total++;
		if (hasFeedback(hit.body)) return;
		if (nearbyNote(f.src, hit.index, hit.body)) return;
		const line = f.src.slice(0, hit.index).split('\n').length;
		offenders.push(f.name + ':' + line + ' —— ' + hit.body.replace(/\s+/g, ' ').slice(0, 90));
	});
});

ok('扫到了无参数 catch（否则本守卫等于没跑）', total >= 3,
	'只扫到 ' + total + ' 处');

ok('★ 每个无参数 catch 都有交代（要么给出用户可见反馈，要么注释说明为何可吞）',
	offenders.length === 0,
	offenders.join('；') + '　修法：补一句注释说明为什么这里可以按失败处理，' +
	'或让用户看到"读取失败"而不是什么都不发生');

/*
 * 反向自检：构造一段"纯吞错"，守卫必须判红。
 * 恒绿和"现在确实都写了注释"从结果上看一模一样。
 */
const bad = "Promise.resolve().then(function () { return 1; })\n"
	+ "\t.catch(function () { busy = false; });\n";
const badHits = findSilentCatches(bad);
ok('★ 反向自检 A：无反馈无注释的 catch 确实被判为违规（不是恒绿）',
	badHits.length === 1 && !hasFeedback(badHits[0].body)
	&& !nearbyNote(bad, badHits[0].index, badHits[0].body),
	'扫到 ' + badHits.length + ' 处');

/* 对照：同样的写法，只要旁边有说明就该放过 —— 否则守卫会逼人删掉合理设计 */
const good = "/* 列出失败只静默，不掩盖主操作的成功提示 */\n"
	+ "Promise.resolve().then(function () { return 1; })\n"
	+ "\t.catch(function () { busy = false; });\n";
const goodHits = findSilentCatches(good);
ok('★ 反向自检 B：邻近有说明的吞错被正确放过（不误伤合理设计）',
	goodHits.length === 1 && nearbyNote(good, goodHits[0].index, goodHits[0].body),
	'扫到 ' + goodHits.length + ' 处');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
