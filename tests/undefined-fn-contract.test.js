#!/usr/bin/env node
/*
 * 「调用了未定义的函数」静态守卫（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * ★ 这个测试是被一个真 bug 逼出来的：
 *
 *   `epdgResultNode` 在 network_status.js 里被**调用了 3 次，却从来没有定义**
 *   （从 4ad7004 引入一直到 2.3.49）。后果是 VoWiFi 卡片渲染到 ePDG 那张表时
 *   直接抛 ReferenceError，卡片从那一行起就断掉。
 *
 *   它躲过了全部现有检查，原因有三条，各自对应一类盲区：
 *     ① `syntax-check.js` 只做语法解析 —— 调用一个不存在的名字**语法完全合法**；
 *     ② 契约测试断言的是「源码里必须有某段文本」，而这段文本**从来没被要求能跑**；
 *     ③ 真机只验了后端（ubus/RPC），前端**从没在浏览器里渲染过**（环境侧 404）。
 *
 *   三条里只有第③条能靠人补，①②只能靠静态扫描。所以补这个守卫。
 *
 * 判据：
 *   源码里出现 `NAME(`（且前面不是 `.`，不是关键字）→ NAME 必须在**同一个文件里**
 *   有定义（函数声明 / 变量赋值 / 对象属性 / 形参 / catch 参数），或在全局白名单里。
 *
 * ★ 为什么只扫单文件：这些 view 都是 `L.view.extend` 的闭包，跨文件的东西一律
 *   挂在命名空间上（`Mt5700.xxx` / `AtWs.xxx` / `Parse.xxx` / `Ui.xxx`），
 *   而带点的调用会被排除。所以「跨文件裸调用」本身就是 bug。
 *
 * 运行：node tests/undefined-fn-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = [
	path.join(ROOT, 'htdocs', 'luci-static', 'resources'),
	path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver')
];

/* 语言关键字与全局内置：名字后面跟 `(` 但显然不是本文件要定义的函数 */
const GLOBALS = new Set([
	/* 关键字 / 运算符形态 */
	'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new',
	'delete', 'void', 'else', 'do', 'in', 'of', 'instanceof', 'yield', 'await',
	'super', 'this', 'case',
	/* 本项目的注入全局（LuCI 的 'use strict' 闭包里由 L.view 提供） */
	'L', 'E', 'AtWs', 'Parse', 'Ui', 'Mt5700', 'require',
	/* 浏览器 / JS 内置 */
	'Promise', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean',
	'Date', 'RegExp', 'Error', 'TypeError', 'Map', 'Set', 'WeakMap', 'Symbol',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
	'decodeURIComponent', 'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout',
	'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
	'console', 'document', 'window', 'navigator', 'alert', 'confirm', 'fetch',
	'XMLHttpRequest', 'FormData', 'Blob', 'FileReader', 'Image', 'URL',
	'process', 'Buffer', 'Boolean', 'Function', 'Reflect', 'Proxy',
	/* 类型化数组 / 编解码 / 观察器（浏览器内置，不是本文件要定义的） */
	'Uint8Array', 'Uint8ClampedArray', 'Int8Array', 'Uint16Array', 'Int16Array',
	'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'DataView',
	'ArrayBuffer', 'TextDecoder', 'TextEncoder', 'btoa', 'atob',
	'ResizeObserver', 'IntersectionObserver', 'MutationObserver',
	/* AMD/UMD：第三方库（jsqr.js）的包装头，define 是全局 */
	'define'
]);

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}

/*
 * 把注释与**字符串/正则字面量的内容**抹掉，只留下代码骨架。
 *
 * ★★ 这里连踩三层坑，每一层都会让守卫报成片假阳性。改前请先读完：
 *
 *   ① 「先判 `//`、后判引号」：字符串里到处是 `http://`，被当成行注释后连字符串
 *      的收尾引号一起吃掉 → 状态机错位 → 后面成片代码被吞 → **声明全丢**。
 *   ② 「把字符串替换成 ""」但**不识别正则字面量**：`/['"]/`、`/[^"']+/` 这类正则
 *      里的引号会把引号状态机带偏，同样是成片吞代码。
 *   ③ 「只删注释、保留字符串」：不吞代码了，但字符串里的 `rotate(`、`rgba(`、
 *      `'initialiseSecureChannel(BF23)'` 全被当成调用 —— 一样是成片假阳性。
 *
 *   → 正解：**完整分词**（注释 / 字符串 / 正则三类都处理），代码块原样保留，
 *     字面量内容抹成 `""`，换行一律保留（否则报错行号整体前移，查都没法查）。
 *
 * ★ 正则起点用标准启发式判定：上一个**有意义的字符**属于 `(,=:[!&|?{};+-*%~^<>`
 *   或行首时，`/` 才是正则开始（否则是除法）。本项目里够用。
 */
const REGEX_PREV = '(),=:[!&|?{};+-*%~^<>\n';

function strip(src) {
	let out = '';
	let i = 0;
	const n = src.length;
	let prevSig = '\n';      /* 上一个非空白字符，用来判正则起点 */

	function blankLiteral(end) {
		/* 抹掉字面量内容，但保留其中的换行，维持行号 */
		for (let k = i; k < end; k++) {
			if (src[k] === '\n') out += '\n';
		}
		out += '""';
	}

	while (i < n) {
		const c = src[i];
		const d = src[i + 1];

		if (c === '/' && d === '/') {
			while (i < n && src[i] !== '\n') i++;
			continue;
		}
		if (c === '/' && d === '*') {
			i += 2;
			while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
				if (src[i] === '\n') out += '\n';
				i++;
			}
			i += 2;
			out += ' ';
			continue;
		}
		if (c === '/' && REGEX_PREV.indexOf(prevSig) >= 0) {
			/* 正则字面量：扫到未转义的 / 为止（跳过字符类 []） */
			i++;
			let inClass = false;
			while (i < n) {
				const r = src[i];
				if (r === '\\') { i += 2; continue; }
				if (r === '\n') break;                 /* 正则不跨行 */
				if (r === '[') inClass = true;
				else if (r === ']') inClass = false;
				else if (r === '/' && !inClass) { i++; break; }
				i++;
			}
			while (i < n && /[gimsuyd]/.test(src[i])) i++;   /* 标志位 */
			out += '""';
			prevSig = '"';
			continue;
		}
		if (c === '"' || c === "'" || c === '`') {
			const q = c;
			const start = i;
			i++;
			while (i < n && src[i] !== q) {
				if (src[i] === '\\') i++;
				i++;
			}
			i++;
			blankLiteral(i);
			prevSig = '"';
			continue;
		}
		out += c;
		if (c !== ' ' && c !== '\t' && c !== '\r') prevSig = c;
		i++;
	}
	return out;
}

/* 收集本文件里所有「有定义的名字」 */
function declared(src) {
	const names = new Set();

	/* function NAME(...) */
	let m;
	const reFn = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
	while ((m = reFn.exec(src))) names.add(m[1]);

	/* var/let/const NAME = ... （含逗号列表） */
	const reVar = /\b(?:var|let|const)\s+([^;=]+)/g;
	while ((m = reVar.exec(src))) {
		m[1].split(',').forEach(function (part) {
			const nm = part.trim().split(/[\s=]/)[0];
			if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
		});
	}

	/* NAME: function  /  NAME: (…) =>   （对象上的方法） */
	const reProp = /([A-Za-z_$][\w$]*)\s*:\s*(?:function\b|\([^)]*\)\s*=>)/g;
	while ((m = reProp.exec(src))) names.add(m[1]);

	/* 形参：function(...) 与 (...) =>  */
	const reParams = /\(([^()]*)\)\s*(?:=>|\{)/g;
	while ((m = reParams.exec(src))) {
		m[1].split(',').forEach(function (p) {
			const nm = p.trim().split(/[\s=]/)[0];
			if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
		});
	}
	/* catch (e) */
	const reCatch = /\}\s*catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
	while ((m = reCatch.exec(src))) names.add(m[1]);

	return names;
}

function called(src) {
	const hits = new Map();   /* name -> 行号 */
	const lines = src.split('\n');
	const re = /([A-Za-z_$][\w$]*)\s*\(/g;
	for (let ln = 0; ln < lines.length; ln++) {
		const line = lines[ln];
		let m;
		re.lastIndex = 0;
		while ((m = re.exec(line))) {
			const name = m[1];
			/* 前面是 `.` → 方法调用，由被调对象的命名空间负责，不在本文件范围 */
			const before = line.slice(0, m.index).trim();
			if (before.endsWith('.')) continue;
			if (!hits.has(name)) hits.set(name, ln + 1);
		}
	}
	return hits;
}

function walk(dir, out) {
	let entries = [];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) { /* 目录不存在就跳过 */ }
	entries.forEach(function (e) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'mock-modem') return;
			walk(p, out);
		} else if (e.name.endsWith('.js')) {
			out.push(p);
		}
	});
	return out;
}

let files = [];
DIRS.forEach(function (d) { files = files.concat(walk(d, [])); });
/* 去重（resources 与 resources/view/... 有包含关系） */
files = Array.from(new Set(files.filter(function (f) { return f.indexOf('view' + path.sep) >= 0 || f.indexOf(path.sep + 'resources' + path.sep + 'at-webserver') >= 0; })));
files.sort();

ok('★ 扫描到了前端 JS 文件（路径写错会让这个守卫恒绿）', files.length >= 10,
	'实际扫到 ' + files.length + ' 个');

files.forEach(function (f) {
	const raw = fs.readFileSync(f, 'utf8');
	const src = strip(raw);
	const names = declared(src);
	const calls = called(src);
	const missing = [];
	calls.forEach(function (ln, name) {
		if (GLOBALS.has(name)) return;
		if (names.has(name)) return;
		missing.push(name + '（第 ' + ln + ' 行）');
	});
	const rel = path.relative(ROOT, f).replace(/\\/g, '/');
	ok('★ ' + rel + ' 没有「调用了未定义的函数」', missing.length === 0,
		missing.length ? '  ' + missing.join('\n  ') : '');
});

console.log('未定义函数守卫：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
	console.log(fails.join('\n'));
	process.exit(1);
}
