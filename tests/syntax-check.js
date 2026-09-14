#!/usr/bin/env node
'use strict';
/*
 * 语法冒烟：把每个前端 JS 当函数体编译一遍。
 *
 * LuCI 的模块文件末尾是顶层 return（模块工厂体），直接 `node --check` 会报
 * 'Illegal return statement'，所以这里用 new Function 包一层再编译——只编译
 * 不执行，能抓出括号/引号/模板串之类的硬语法错误。这类错误在真机上的表现
 * 是整个页面白屏，靠肉眼看不出来。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs', 'luci-static', 'resources');

const files = [];
(function walk(d) {
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (e.name.endsWith('.js')) files.push(p);
	}
})(RES);

let bad = 0;
for (const f of files) {
	const src = fs.readFileSync(f, 'utf8');
	try {
		// eslint-disable-next-line no-new-func
		new Function(src);
	} catch (e) {
		bad++;
		console.error('FAIL ' + path.relative(ROOT, f) + ' —— ' + e.message);
	}
}
console.log(files.length + ' 个 JS 文件，语法错误 ' + bad + ' 个');
process.exit(bad ? 1 : 0);
