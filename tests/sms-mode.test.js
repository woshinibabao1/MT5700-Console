#!/usr/bin/env node
/*
 * 短信「PDU / Text 两种模式」命令构造契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 为什么单独开一个文件：
 *   这两条链路的坑**不在算法，而在字节形态**——真机上「看起来对」的命令
 *   模组可能根本不收，而且失败表现是「静默超时」，没有任何错误码可查。
 *   所以把真机实测出来的形态固化成断言，防止日后被"顺手改回标准写法"。
 *
 * 真机实测依据（MT5700M-CN，固件 V200R001C20B025，2026-09-14）：
 *   ① AT+CMGS=19<CR>0891…PDU<CR>      → 只回显 "AT+CMGS=19" 后无应答：
 *        模组把 <CR> 当命令行结束，进入「等待 PDU」态，只认 Ctrl-Z(0x1A)；
 *   ② AT+CMGS=19<0x5C><0x72>0891…PDU<CR>
 *                                     → 立即返回 +CMGS: <mr> / OK。
 *   Text 模式同理：明文要用字面 "\r" 分隔，且
 *    · 纯 ASCII：AT+CMGS="10086"<0x5C><0x72>test                → 写入成功
 *    · 中文：先 AT+CSCS="UCS2" + AT+CSMP=17,167,0,8，再发
 *            AT+CMGS="0031…0036"<0x5C><0x72>4F60597D            → 写入成功
 *      （引号必须是 ASCII 引号；把引号也写成 0022 会让模组卡在数据输入态）
 *
 * 运行：node tests/sms-mode.test.js
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

const LITERAL_R = '\\r';            // 源码里的 '\\r' —— 运行期是 0x5C 0x72
const REAL_CR = String.fromCharCode(0x0d);

let passed = 0;
let failed = 0;
function ok(cond, name, extra) {
	if (cond) { passed++; return; }
	failed++;
	console.error('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
}

/* =========================== PDU 模式 =========================== */
console.log('— PDU 模式（AT+CMGF=0）');

const part = SmsEncode.buildSubmitParts({
	smsc: '+8613800743500',
	destination: '10086',
	message: 'LLCX'
})[0];
const pduCmd = SmsEncode.buildPduSendCommand(part);

ok(pduCmd.indexOf('AT+CMGS=' + part.tpduLength) === 0,
	'PDU 命令以 AT+CMGS=<TPDU 字节数> 开头',
	'实际: ' + pduCmd.slice(0, 40));
ok(pduCmd.indexOf(LITERAL_R) > 0,
	'PDU 命令用字面 \\r 作分隔符（官方 WEBUI 2.2.0 的形态）');
ok(pduCmd.indexOf(REAL_CR) < 0,
	'PDU 命令里**不能**出现真回车：模组会把它当命令行结束，然后只等 0x1A',
	'发现 0x0D 于位置 ' + pduCmd.indexOf(REAL_CR));
ok(pduCmd.endsWith(part.pdu),
	'命令末尾是完整 PDU（末尾的真 CR 由 Rust 后端补）');
ok(pduCmd === 'AT+CMGS=' + part.tpduLength + LITERAL_R + part.pdu,
	'命令 = "AT+CMGS=<len>" + 字面\\r + PDU，没有多余字符',
	'实际: ' + pduCmd);

// 与真机成功样本对齐：官方那条 PDU 的 TPDU 长度是 19
const sampleCmd = SmsEncode.buildPduSendCommand({
	tpduLength: 19,
	pdu: '0891683108703405F0110005910180F60008a708004C004C00430058'
});
ok(sampleCmd === 'AT+CMGS=19' + LITERAL_R + '0891683108703405F0110005910180F60008a708004C004C00430058',
	'与真机提交成功的样本命令逐字节一致（10086 / LLCX）',
	'实际: ' + sampleCmd);

/* =========================== Text 模式：ASCII =========================== */
console.log('— Text 模式（AT+CMGF=1）ASCII');

const ascii = SmsEncode.buildTextSendCommand({ destination: '10086', message: 'test' });
ok(ascii.cmd === 'AT+CMGS="10086"' + LITERAL_R + 'test',
	'ASCII 明文命令 = AT+CMGS="<号码>" + 字面\\r + 明文',
	'实际: ' + ascii.cmd);
ok(ascii.cmd.indexOf(REAL_CR) < 0, 'ASCII 命令不含真回车');
ok(Array.isArray(ascii.pre) && ascii.pre.length === 0,
	'纯 ASCII 不需要改动字符集（pre 为空），避免动全局 CSCS');
ok(Array.isArray(ascii.post) && ascii.post.length === 0,
	'纯 ASCII 无需恢复现场（post 为空）');

const asciiPlus = SmsEncode.buildTextSendCommand({ destination: '+8613800138000', message: 'hi' });
ok(asciiPlus.cmd === 'AT+CMGS="+8613800138000"' + LITERAL_R + 'hi',
	'带 + 的号码原样保留（<toda> 由 + 决定为 145）',
	'实际: ' + asciiPlus.cmd);

/* =========================== Text 模式：中文 =========================== */
console.log('— Text 模式 中文（UCS2）');

const cn = SmsEncode.buildTextSendCommand({ destination: '10086', message: '你好' });
ok(cn.pre.indexOf('AT+CSCS="UCS2"') >= 0,
	'中文先切 AT+CSCS="UCS2"（IRA 装不下中文）');
ok(cn.pre.indexOf('AT+CSMP=17,167,0,8') >= 0,
	'中文把 CSMP 的 DCS 设为 8（UCS2）');
ok(cn.cmd.indexOf('AT+CMGS="') === 0,
	'UCS2 下也用 **ASCII 引号**：实测把引号写成 0022 会让模组卡在数据输入态',
	'实际: ' + cn.cmd);
ok(cn.cmd.indexOf('"00310030003000380036"') > 0,
	'号码写成 UCS2 十六进制（10086 → 00310030003000380036）',
	'实际: ' + cn.cmd);
ok(cn.cmd.indexOf(LITERAL_R + '4F60597D') > 0,
	'正文写成 UCS2 十六进制（你好 → 4F60597D）',
	'实际: ' + cn.cmd);
ok(cn.cmd.indexOf(REAL_CR) < 0, '中文命令不含真回车');
ok(cn.post.indexOf('AT+CSCS="IRA"') >= 0,
	'发完必须恢复 AT+CSCS="IRA"：字符集是全局设置，不恢复会让整条 AT 通道的应答变成 UCS2');
ok(cn.post.indexOf('AT+CSMP=17,167,0,0') >= 0,
	'发完必须恢复 CSMP 默认值');

const cnPlus = SmsEncode.buildTextSendCommand({ destination: '+8613800138000', message: '你好' });
ok(cnPlus.cmd.indexOf('002B') < 0,
	'+ 不进 UCS2 串（它是格式符，由 <toda> 表达）',
	'实际: ' + cnPlus.cmd);

/* =========================== 工具函数 =========================== */
console.log('— 工具函数与容量上限');

ok(SmsEncode.toUcs2Hex('10086') === '00310030003000380036', 'toUcs2Hex 号码');
ok(SmsEncode.toUcs2Hex('你好') === '4F60597D', 'toUcs2Hex 中文');
ok(SmsEncode.usesUcs2('hello') === false, 'usesUcs2：纯 ASCII 为 false');
ok(SmsEncode.usesUcs2('你好') === true, 'usesUcs2：含中文为 true');
ok(SmsEncode.TEXT_MAX_ASCII === 160, 'Text 模式 ASCII 上限 160');
ok(SmsEncode.TEXT_MAX_UCS2 === 70, 'Text 模式 UCS2 上限 70');

/* =========================== 汇总 =========================== */
console.log('');
if (failed > 0) {
	console.error('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
	process.exit(1);
}
console.log('通过 ' + passed + ' 项，失败 0 项');
console.log('短信双模式命令构造契约测试全部通过');
