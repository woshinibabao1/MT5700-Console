#!/usr/bin/env node
/*
 * 短信正文 AT 命令注入防护测试（无需真机、无需模组）
 * ---------------------------------------------------------------------------
 * 为什么需要这个文件：Text 模式（AT+CMGF=1）下发时，正文是**直接拼进 AT 命令
 * 字符串**的。按 smsEncode.js 里 DATA_SEP 那段实测结论，整条命令里只能有
 * 一个真回车、且必须在最末（由后端补）。正文里只要出现 CR/LF，一条命令就
 * 被截成两条，后面的内容会被模组当成**新的 AT 命令行**执行 —— 这是货真价实的
 * AT 命令注入，而短信正文是本项目唯一「完全由外部输入决定」的内容。
 *
 * 交叉验证维度：
 *   ① 边界/异常推导：CR / LF / NUL / Ctrl-Z 逐个试；
 *   ② 与既有功能兼容：确认消毒**只**剥控制字符，不误伤 , ; " 等正常标点
 *      （即不能用 Parse.sanitizeAtParam 顶替，那个会连标点一起剥）；
 *   ③ 编码分支：UCS2 分支走十六进制，天然免疫，一并列进来防回归。
 *
 * 运行：node tests/sms-text-injection.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'smsEncode.js');
const src = fs.readFileSync(SRC, 'utf8');
const m = src.match(/var SmsEncode = \((function[\s\S]*?\n\})\)\(\);/);
if (!m) {
	console.error('无法从 smsEncode.js 中提取编码模块');
	process.exit(1);
}
/* eslint-disable no-eval */
const SmsEncode = eval('(' + m[1] + ')')();

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}

/* ---------- 1. 正文里的行终止符必须被剥掉 ---------- */

const CR = '\r';
const LF = '\n';

function asciiCmd(message) {
	return SmsEncode.buildTextSendCommand({ destination: '10086', message: message }).cmd;
}

ok('正文含 CR 时命令里没有真回车', asciiCmd('hi' + CR + 'AT+CFUN=0').indexOf(CR) < 0,
	'实测：' + JSON.stringify(asciiCmd('hi' + CR + 'AT+CFUN=0')));
ok('正文含 LF 时命令里没有真换行', asciiCmd('hi' + LF + 'AT+CFUN=0').indexOf(LF) < 0,
	'实测：' + JSON.stringify(asciiCmd('hi' + LF + 'AT+CFUN=0')));
ok('正文含 CRLF 时命令仍只有一行', asciiCmd('a' + CR + LF + 'AT^RESET').split(/\r|\n/).length === 1);
ok('注入内容被降级为正文（不再独立成行）',
	asciiCmd('hi' + CR + 'AT+CFUN=0') === 'AT+CMGS="10086"\\rhiAT+CFUN=0',
	'实测：' + JSON.stringify(asciiCmd('hi' + CR + 'AT+CFUN=0')));

/* ---------- 2. 其余破坏分帧的控制字符 ---------- */

ok('Ctrl-Z(0x1A) 被剥掉（否则模组提前提交）',
	asciiCmd('a\x1a' + 'b').indexOf('\x1a') < 0);
ok('NUL(0x00) 被剥掉', asciiCmd('a\x00b').indexOf('\x00') < 0);

/* ---------- 3. 消毒不能误伤正常内容（防「负优化」） ---------- */

const normal = 'hello, world; "quoted" 100% & <tags>';
ok('逗号、分号、引号、尖括号等正常标点一律保留',
	asciiCmd(normal).indexOf(normal) >= 0,
	'实测：' + JSON.stringify(asciiCmd(normal)));
ok('消毒不改动纯 ASCII 正文的长度',
	SmsEncode.sanitizeSmsText('abcdef') === 'abcdef');

/* sanitizeAtParam 会剥 , ; —— 正文绝不能走它 */
ok('sanitizeSmsText 保留逗号（与 Parse.sanitizeAtParam 语义不同）',
	SmsEncode.sanitizeSmsText('a,b') === 'a,b');
ok('sanitizeSmsText 保留分号', SmsEncode.sanitizeSmsText('a;b') === 'a;b');

/* ---------- 4. 号码仍按原规则消毒 ---------- */

ok('号码里的非数字被剔除',
	SmsEncode.buildTextSendCommand({ destination: '10086"OK"', message: 'x' }).cmd
		.indexOf('AT+CMGS="10086"') === 0,
	'实测：' + SmsEncode.buildTextSendCommand({ destination: '10086"OK"', message: 'x' }).cmd);
ok('号码带 + 号时保留', SmsEncode.buildTextSendCommand({ destination: '+8613800138000', message: 'x' }).cmd
	.indexOf('AT+CMGS="+8613800138000"') === 0);

/* ---------- 5. UCS2 分支天然免疫（防回归） ---------- */

const ucs2 = SmsEncode.buildTextSendCommand({ destination: '10086', message: '你好\r\nAT+CFUN=0' });
ok('中文走 UCS2 分支', SmsEncode.usesUcs2('你好'));
ok('UCS2 分支输出仅含十六进制与命令骨架',
	/^AT\+CMGS="[0-9A-F]+"\\r[0-9A-F]+$/.test(ucs2.cmd),
	'实测：' + ucs2.cmd);
ok('UCS2 分支不含真回车', ucs2.cmd.indexOf(CR) < 0 && ucs2.cmd.indexOf(LF) < 0);

/* ---------- 6. 边界输入 ---------- */

ok('空正文不炸', asciiCmd('') === 'AT+CMGS="10086"\\r');
ok('null 正文不炸', SmsEncode.buildTextSendCommand({ destination: '10086', message: null }).cmd
	=== 'AT+CMGS="10086"\\r');
ok('sanitizeSmsText(undefined) 返回空串', SmsEncode.sanitizeSmsText(undefined) === '');
ok('sanitizeSmsText(null) 返回空串', SmsEncode.sanitizeSmsText(null) === '');

/* ---------- 结果 ---------- */

console.log('短信正文注入防护测试：' + pass + ' 通过, ' + fails.length + ' 失败');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
