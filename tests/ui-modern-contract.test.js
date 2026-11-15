#!/usr/bin/env node
'use strict';

/**
 * UI 现代化契约测试（2026-11-15，Modern Web Guidance 落地）
 * ---------------------------------------------------------------------------
 * 这一轮把四处「手写实现」换成了浏览器原生能力，本文件钉住它们，
 * 防止后续改动悄悄退回旧写法（退回不会报错，只会让键盘/读屏/中文输入法用户变哑）：
 *
 *   1) 弹窗 = 原生 <dialog> + showModal()：焦点陷阱、Esc、背景 inert、
 *      关闭后焦点归还全部由浏览器负责，我们不再手写。
 *   2) 表格 = <caption> + th[scope] + role="region"：读屏能念出表名与列头，
 *      键盘能进到横向滚动区。
 *   3) 回车提交必须判 IME 组字（isComposing / keyCode 229）：
 *      中文输入法「确认候选词」的那个 Enter 不是「发送」。
 *   4) color-scheme 两套壳各自钉死：原生下拉、滚动条、::backdrop 跟着壳走。
 *
 * ★ 判源码前先剥注释：说明里写一句 `mask.showModal()` 就能让断言恒绿，
 *   这是本仓库踩过的坑（tests 只做文本匹配，注释一样会被匹配到）。
 *
 * 用法：node tests/ui-modern-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = path.join(ROOT, 'htdocs/luci-static/resources');

function read(rel) {
	const src = fs.readFileSync(path.join(R, rel), 'utf8');
	/* 剥块注释与行注释（跳过 :// 这种协议串），避免「注释里写了就算过」 */
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

const MT = read('at-webserver/mt5700.js');
const UI = read('at-webserver/ui.js');
const CSS = read('at-webserver/mt5700.css');
const SMS = read('view/at-webserver/sms_center.js');
const TERM = read('view/at-webserver/terminal.js');

let pass = 0, fail = 0;
function ok(name) { pass++; console.log('  ok   ' + name); }
/* ★ 失败前缀必须是 '  ✗ '：tools/verify-guards.py 靠它数「判红几处」 */
function has(name, cond, hint) {
	if (cond) return ok(name);
	fail++;
	console.log('  ✗ ' + name + (hint ? '  → ' + hint : ''));
}

/* ------------------------------------------------------------------ */
console.log('弹窗：原生 dialog');

has('mt5700.js 提供 api.modal 底座', /api\.modal = function \(opts\)/.test(MT));
has('confirm 走 api.modal，不再自建遮罩',
	/api\.confirm = function \(message, onOk, okText, onCancel\) \{\s*return api\.modal\(/.test(MT),
	'两套遮罩并存会让「Esc 能不能关」取决于调的是哪个');
has('模态用 showModal() 打开', /mask\.showModal\(\)/.test(MT),
	'show() 不进 top layer、不做焦点陷阱，等于没用原生弹窗');
has('用 closedBy 能力检测决定是否由浏览器做 light-dismiss',
	/'closedBy' in HTMLDialogElement\.prototype/.test(MT));
has('不支持 closedBy 时有指针内外判定兜底',
	/outsideDialog\(mask, e\)/.test(MT),
	'Safari 至今不支持 closedby，不给兜底就点遮罩关不掉');
has('不支持 showModal 的浏览器退回 div 遮罩',
	/E\('div', \{ 'class': 'mt5700-modal-mask' \}\)/.test(MT));
has('promptModal 走同一套底座', /return Mt5700\.modal\(/.test(UI));
has('promptModal 的 label 用 for 关联控件', /'for': fid/.test(UI),
	'div 当标签时点文字不聚焦、读屏念不出这一格是什么');
has('短信批量删除弹窗也走原生 dialog',
	/function makeMask\(\)[\s\S]{0,320}?document\.createElement\('dialog'\)/.test(SMS),
	'三个弹窗两套行为，用户永远记不住哪个能用 Esc');
has('dialog 关闭必须先 close() 再摘节点',
	/if \(mask\.tagName === 'DIALOG' && mask\.open\) mask\.close\(\)/.test(SMS),
	'只摘节点会让整页留在 inert 状态 —— 弹窗没了、点哪都没反应');

has('CSS 把 dialog 与 div 两套遮罩分开写',
	/dialog\.mt5700-modal-mask\s*\{/.test(CSS) && /div\.mt5700-modal-mask\s*\{/.test(CSS),
	'通用类名会让 display:flex 盖掉 UA 的 dialog:not([open]){display:none}');
has('dialog 只在 [open] 时 display',
	/dialog\.mt5700-modal-mask\[open\]\s*\{[^}]*display: flex/.test(CSS),
	'无条件 display 会把关闭状态的弹窗画在页面上');
has('::backdrop 承接遮罩色与模糊', /\.mt5700-modal-mask::backdrop\s*\{/.test(CSS));
has('::backdrop 设了 overflow 才能拦住滚动穿透',
	/\.mt5700-modal-mask::backdrop\s*\{[^}]*overflow: hidden/.test(CSS),
	'::backdrop 默认 overflow:visible，不是滚动容器，overscroll-behavior 不生效');
has('dialog 自身也 contain 了滚动链',
	/dialog\.mt5700-modal-mask\s*\{[^}]*overscroll-behavior: contain/.test(CSS));

/* ------------------------------------------------------------------ */
console.log('');
console.log('表格：语义与键盘可达');

has('表格带 <caption>', /E\('caption'/.test(MT),
	'没有表名的表格，读屏只会念「表格」');
has('caption 走视觉隐藏类', /'class': 'mt5700-sr-only'/.test(MT));
has('表头带 scope="col"', /E\('th', \{ scope: 'col' \}/.test(MT),
	'不写 scope，跨分组行时读屏会把列头念串');
has('表格容器 role=region + tabindex=0',
	/role: 'region', tabindex: '0'/.test(MT),
	'横向溢出时容器才是滚动区，不可聚焦就等于键盘进不去');
has('CSS 提供 .mt5700-sr-only', /\.mt5700-sr-only\s*\{/.test(CSS));
has('表格容器有可见焦点环', /\.mt5700-table-wrapper:focus-visible/.test(CSS));

/* ------------------------------------------------------------------ */
console.log('');
console.log('输入：回车必须让开输入法');

has('短信输入框判 IME 组字', /e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing/.test(SMS),
	'不判的话打「你好」时第一次回车就把半条短信发出去');
has('AT 终端判 IME 组字', /e\.key === 'Enter' && !e\.isComposing/.test(TERM));
has('自动刷新自定义间隔判 IME 组字',
	/if \(e\.key === 'Enter' && !e\.isComposing && e\.keyCode !== 229\)/.test(UI));

/* ------------------------------------------------------------------ */
console.log('');
console.log('配色：原生控件跟随壳');

has('.mt5700-sh 钉 dark', /\.mt5700-sh\s*\{[^}]*color-scheme: dark/.test(CSS));
has('.mt5700-page 钉 light', /\.mt5700-page\s*\{[^}]*color-scheme: light/.test(CSS),
	'固定浅色纸面里出现深色下拉/滚动条，等于两套皮肤打架');
has('浅色壳覆盖回 light',
	/\.mt5700-sh\[data-theme="light"\]\s*\{[^}]*color-scheme: light/.test(CSS));
has('切主题时同步 <meta name="color-scheme">',
	/shColorSchemeMeta\(theme\)/.test(MT) && /name', 'color-scheme'/.test(MT),
	'只改 CSS 变量，浏览器自绘的下拉与滚动条不会跟着变');

/* ------------------------------------------------------------------ */
console.log('');
console.log('提示：读屏能听见');

has('toast 带 role/aria-live',
	/role: type === 'error' \? 'alert' : 'status'/.test(MT));
has('toast 先入 DOM 再写文字',
	/document\.body\.appendChild\(t\);[\s\S]{0,400}?t\.textContent = message/.test(MT),
	'先造带文字的节点再插入，多数读屏会整条漏掉');

/* ------------------------------------------------------------------ */
console.log('');
console.log('自证：判据确实会红');

{
	const broken = MT.replace(/mask\.showModal\(\);/, '');
	has('自证 A：删掉 showModal 后判据不成立', !/mask\.showModal\(\)/.test(broken));
}
{
	const broken = SMS.replace('!e.isComposing && e.keyCode !== 229', '');
	has('自证 B：删掉 IME 判定后判据不成立', !/!e\.isComposing/.test(broken));
}
{
	const broken = CSS.replace(/color-scheme: dark;/, '');
	has('自证 C：删掉壳的 color-scheme 后判据不成立',
		!/\.mt5700-sh\s*\{[^}]*color-scheme: dark/.test(broken));
}
{
	const broken = MT.replace(/E\('th', \{ scope: 'col' \}/, "E('th'");
	has('自证 D：去掉 scope 后判据不成立', !/E\('th', \{ scope: 'col' \}/.test(broken));
}

console.log('');
console.log('ui-modern-contract: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
