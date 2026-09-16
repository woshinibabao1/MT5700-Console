#!/usr/bin/env node
'use strict';

/**
 * AT 应答「错误文本」判定契约测试
 *
 * 守的是 isErrorText()（rpc.js）的两条性质，缺一条就会出线上故障：
 *
 *   ① **不能把正文当错误**（假阳性）
 *      Text 模式（CMGF=1）下 `AT+CMGL=4` 的应答里直接带短信正文。
 *      旧正则 /(^|[\s\r\n])(ERROR|...)/i 的分隔符含 `\s`（空格也算），
 *      于是「My network error again」这种正文会被判成命令失败 ——
 *      表现为**短信列表整屏空白**，而日志里根本查不到 ERROR，极难定位。
 *
 *   ② **真错误必须认出来**（假阴性）
 *      行锚定不能矫枉过正：ERROR / +CME ERROR: 10 / +CMS ERROR: 500
 *      以及带说明文字的 `+CMS ERROR: 500 memory full` 都要命中，
 *      否则失败不会被识别（也就不会被重试、不会被上报）。
 *
 * 只读：不连设备、不发 AT。
 * 用法：node tests/at-error-text-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs/luci-static/resources');
const rpcSrc = fs.readFileSync(path.join(RES, 'at-webserver/rpc.js'), 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

/* 与 at-cache-contract.test.js 同样的载入手法：rpc.js 是 LuCI 模块体，
 * 末尾自带 `return AtWsClass;`，先摘掉再包 IIFE，否则自己的 return 先执行。 */
function loadRpc() {
	const src = rpcSrc
		.replace(/^\s*'require [^']*';\s*$/gm, '')
		.replace(/\n\s*return AtWsClass;\s*$/, '\n');
	const ctx = {
		console, Promise, setTimeout, clearTimeout, Date, JSON,
		L: {
			Class: { extend: (x) => x },
			rpc: { declare: () => function () { return Promise.resolve({ success: true, data: 'OK' }); } },
			uci: { load: () => Promise.resolve() },
			env: {}
		},
		window: undefined
	};
	vm.createContext(ctx);
	return vm.runInContext(
		'(function(){\n' + src + '\nreturn { isErrorText: isErrorText };\n})()',
		ctx
	);
}

const { isErrorText } = loadRpc();
ok('能载入 isErrorText', typeof isErrorText === 'function');

/* ---------- A. 假阳性：正文里的英文单词不算错误 ---------- */

const SHOULD_PASS = [
	['短信正文含 error（CMGL Text 模式，本 bug 的主证场景）',
		'+CMGL: 1,"REC UNREAD","10086",,"26/09/16,10:00:00"\r\nMy network error again\r\n\r\nOK'],
	['短信正文里 error 独立成行但小写（去掉 /i 后也不该命中）',
		'+CMGL: 2,"REC READ","10086",,"26/09/16,10:01:00"\r\nerror\r\n\r\nOK'],
	['APN 名字里含 error', '+CGDCONT: 1,"IP","error.apn","",0,0\r\nOK'],
	['运营商名含 ERROR 字样', '+COPS: 0,0,"CHN-ERRORNET",7\r\nOK'],
	['普通应答', 'AT+CSQ\r\n+CSQ: 25,99\r\n\r\nOK'],
	['日志式 0 errors', '0 errors found\r\nOK']
];

SHOULD_PASS.forEach(function (p) {
	ok('不误判：' + p[0], isErrorText(p[1]) === false,
		'被判成失败了（样本：' + JSON.stringify(p[1]).slice(0, 70) + '）');
});

/* ---------- B. 假阴性：真错误必须认出来 ---------- */

const SHOULD_FAIL = [
	['裸 ERROR（含 CRLF 包裹）', '\r\nERROR\r\n'],
	['裸 ERROR 无尾换行', 'ERROR'],
	['+CME ERROR 带错误码', '\r\n+CME ERROR: 10\r\n'],
	['+CMS ERROR 带错误码', '\r\n+CMS ERROR: 500\r\n'],
	['+CMS ERROR 带错误码与说明文字', '\r\n+CMS ERROR: 500 memory full\r\n'],
	['应答里前面有正常行、末尾才是 ERROR', '+CSQ: 25,99\r\nERROR\r\n']
];

SHOULD_FAIL.forEach(function (p) {
	ok('要识别：' + p[0], isErrorText(p[1]) === true,
		'没被判成失败（样本：' + JSON.stringify(p[1]).slice(0, 70) + '）');
});

/* ---------- C. 静态约束：不许再退回旧写法 ---------- */

ok('★ 判定正则不带 /i（带 i 会把小写正文也算错误）',
	!/function isErrorText[\s\S]{0,400}?\/i\.test/.test(rpcSrc));
const fnSrc = (rpcSrc.match(/function isErrorText[\s\S]{0,500}?\.test\(txt\)/) || [''])[0];
ok('★ 分隔符不含 \\s（把空格当行首的话，正文里的英文单词照样命中）',
	!/\[\\s/.test(fnSrc), fnSrc.replace(/\s+/g, ' ').slice(0, 130));
ok('★ 分隔符必须锚到 \\r 或 \\n（行锚定）', /\[\\r\\n\]/.test(fnSrc),
	fnSrc.replace(/\s+/g, ' ').slice(0, 130));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('AT 错误文本判定契约测试全部通过');
