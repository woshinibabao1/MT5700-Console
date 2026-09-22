#!/usr/bin/env node
'use strict';

/*
 * Shell 注释风格契约：**禁止在 shell 里写 C 风格注释**
 * ---------------------------------------------------------------------------
 * 起因（一条真踩过的坑）：shell 里的「斜杠星号」不是注释，是 **glob**。
 * 有人照着 C 的习惯写了一行 C 风格注释，bash 会把它展开成
 * **根目录 `/` 下的全部文件列表**，再把第一个文件名当命令执行 —— 报错形如
 *
 *     /LICENSE.txt: line 2: Note: command not found
 *
 * 看着像某个文件坏了，实际是注释被当命令跑了。而 `bash -n <script>`
 * **查不出这个问题**（语法完全合法），所以只能靠静态扫描守住。
 *
 * 两条判据，取自「glob 长这样、注释不长这样」的差别：
 *   A. 单行：同一行里「斜杠星号」之后还能找到「星号斜杠」
 *   B. 块起始：某一行（去空白后）以「斜杠星号」开头
 * 且「斜杠星号」紧跟一个斜杠的一律跳过 —— 那是路径 glob
 * （`.pkgdir/*​/usr/bin/`、`/sys/bus/usb/devices/*`），
 * 是本仓合法且必需的写法。
 *
 * 修法：把 C 风格注释改成 # 注释。
 *
 * 用法：node tests/shell-comment-style-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.workbuddy', 'target'];

/* 只扫会被 shell 解释的目录：root 下既有 .sh 也有无扩展名的 init.d / uci-defaults */
const SCAN_DIRS = ['root', 'scripts'];

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

function walk(dir, out) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		return out;   /* 目录不存在就跳过 */
	}
	names.forEach(function (name) {
		if (SKIP_DIRS.indexOf(name) >= 0) return;
		const p = path.join(dir, name);
		let st;
		try { st = fs.statSync(p); } catch (e) { return; }
		if (st.isDirectory()) { walk(p, out); return; }
		out.push(p);
	});
	return out;
}

/* 判定「这个文件会被 shell 解释」。扩展名不可靠：OpenWrt 的 init.d /
   uci-defaults 脚本传统上没有扩展名，只能靠 shebang 或路径认。 */
function isShellFile(p, text) {
	const ext = path.extname(p).toLowerCase();
	if (ext === '.sh') return true;
	const rel = path.relative(ROOT, p).split(path.sep).join('/');
	if (/^root\/etc\/(init\.d|uci-defaults)\//.test(rel) && ext === '') return true;
	const first = (text.split('\n')[0] || '').replace(/\r$/, '');
	return /^#!.*\/(sh|bash|ash|busybox)\b/.test(first);
}

const OPEN = '/*';
const CLOSE = '*/';

/* 找出 C 风格注释。斜杠星号后紧跟斜杠的是路径 glob，跳过。 */
function findCStyleComments(text) {
	const lines = text.split('\n');
	const hits = [];
	lines.forEach(function (line, idx) {
		let found = null;
		let i = 0;
		while (i >= 0) {
			const s = line.indexOf(OPEN, i);
			if (s < 0) break;
			if (line[s + 2] === '/') { i = s + 2; continue; }   /* 路径 glob，不是注释 */
			if (line.indexOf(CLOSE, s + 2) >= 0) { found = '单行注释'; break; }
			i = s + 2;
		}
		if (!found && /^\s*\/\*/.test(line)) found = '块注释起始';
		if (found) hits.push({ line: idx + 1, kind: found, text: line.trim() });
	});
	return hits;
}

const all = [];
SCAN_DIRS.forEach(function (d) { walk(path.join(ROOT, d), all); });

const shellFiles = all.map(function (p) {
	let text;
	try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
	return isShellFile(p, text) ? { p: p, text: text } : null;
}).filter(Boolean);

/*
 * 「扫到了文件」不能用总数糊弄过去（计数式断言对"漏掉某一类"不设防）：
 * 直接点名两个必须被覆盖的文件 —— 一个是有扩展名的常规脚本，
 * 一个是 init.d 下**没有扩展名**、只能靠 shebang 认出来的那种（最容易漏扫）。
 */
const rels = shellFiles.map(function (f) {
	return path.relative(ROOT, f.p).split(path.sep).join('/');
});
ok('扫描覆盖了 root/etc/init.d/at-webserver（无扩展名，靠 shebang 认出）',
	rels.indexOf('root/etc/init.d/at-webserver') >= 0, rels.join(','));
ok('扫描覆盖了 root/usr/share/mt5700/diag-probe.sh',
	rels.indexOf('root/usr/share/mt5700/diag-probe.sh') >= 0, rels.join(','));
ok('扫到的 shell 脚本不少于 4 个（否则本守卫等于没跑）', shellFiles.length >= 4,
	'只扫到 ' + shellFiles.length + ' 个：' + rels.join(','));

const offenders = [];
shellFiles.forEach(function (f) {
	const hits = findCStyleComments(f.text);
	if (!hits.length) return;
	const rel = path.relative(ROOT, f.p).split(path.sep).join('/');
	hits.forEach(function (h) {
		offenders.push(rel + ':' + h.line + '（' + h.kind + '）—— ' + h.text.slice(0, 80));
	});
});

ok('所有 shell 脚本都没有 C 风格注释（会被 glob 展开成根目录文件列表并当命令执行）',
	offenders.length === 0,
	offenders.slice(0, 8).join('；') + '　修法：改成 # 注释');

/*
 * 反向自检：既要认得出 C 注释，也要放得过真实的 glob 写法。
 * 少任何一条，它就可能是恒绿的。
 */
const cStyle = '#!/bin/sh\n' + OPEN + ' 注意：下面是兼容分支 ' + CLOSE + '\necho hi\n';
ok('★ 反向自检 A：单行 C 注释确实被检出（不是恒绿）',
	findCStyleComments(cStyle).length === 1,
	'检出 ' + findCStyleComments(cStyle).length + ' 处');

const blockStyle = '#!/bin/sh\n' + OPEN + '\n * 多行说明\n ' + CLOSE + '\necho hi\n';
ok('★ 反向自检 B：多行 C 注释（块起始）确实被检出',
	findCStyleComments(blockStyle).length === 1,
	'检出 ' + findCStyleComments(blockStyle).length + ' 处');

/* 这三条是本仓里**真实存在**的合法 glob，必须放过去，否则守卫会逼人删代码 */
const realGlobs = [
	'for d in /sys/bus/usb/devices/*; do',
	'ls -d package/* 2>/dev/null || true',
	'ls -la build_dir/target-*_musl/luci-app-mt5700/.pkgdir/*/usr/bin/ 2>/dev/null | head -10'
];
const globHits = findCStyleComments(realGlobs.join('\n'));
ok('★ 反向自检 C：真实的路径 glob（含斜杠星号斜杠形态）不被误判为注释',
	globHits.length === 0,
	'误判 ' + globHits.length + ' 处：' + JSON.stringify(globHits));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
