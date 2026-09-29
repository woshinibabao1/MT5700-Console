#!/usr/bin/env node
'use strict';

/*
 * PDU 长度单位契约：UCS2 / 8bit 的 udl 计**八位组**，GSM7 计**码位**
 * ---------------------------------------------------------------------------
 * 依据（2026-09-30 对 tests/fixtures/pdu-samples.json 全量测算，非推断）：
 *
 *   | 样本 | DCS | enc | udl | 实到 UD 字节 | 按字符计会是 |
 *   | :-- | :-- | :-- | :-- | :-- | :-- |
 *   | UCS2 + 国际号码 | 0x08 | UCS2 | 4 | 4 | 8 |
 *   | 10086 的 UCS2 长短信首段（**真机样本**） | 0x08 | UCS2 | 136 | 136 | 272 |
 *   | DCS 0xC 组 | 0xC8 | UCS2 | 4 | 4 | 8 |
 *   | DCS 0x04（8bit） | 0x04 | 8bit | 4 | 4 | 8 |
 *   | GSM7（hello） | 0x00 | GSM7 | 5（码位） | 5 | — |
 *
 *   ⇒ UCS2/8bit 的 udl **逐条等于实到 UD 字节数**：单位是**八位组**。
 *
 * 为什么要有这条契约：
 *   前端 parse.js 原先在 UCS2 分支写 `udl * 2`（按"字符"计），它只靠
 *   `Math.min(pos + udLen, raw.length)` 的越界钳制才在常见输入上"碰巧"正确 ——
 *   一旦 raw 的 UD 之后还有字节（多行应答拼接、调用方多传），多出来的部分会被当正文吞进去。
 *   Rust 侧 src/rust/src/pdu.rs 同一处已按八位组校验并裁剪（不足直接 Err）。
 *   两侧口径必须同源，否则"两端一致"这条契约只是碰巧成立。
 *
 * 判据（**只认代码形态，不认注释** —— 本仓 find-orphans 的自证清单里就有
 * 「C 注释不算使用」这一条：用裸文本匹配会被注释里的示例误判/误放过）：
 *   ① 不得出现 `udLen = udl * 2` 这种**赋值**（注释里提到 `udl * 2` 不算违规）；
 *   ② 必须真的存在 `udLen = udl` 这一支（防止把整段删掉也算通过）；
 *   ③ pdu.rs 的 8bit/UCS2 字节需求必须取自 udl（与前端同源）；
 *   ④ pdu.rs 对"用户数据不足"必须在**字符串字面量**里报错（注释里提一句不算）。
 *
 * 用法：node tests/pdu-udl-unit-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const RUST = path.join(ROOT, 'src', 'rust', 'src', 'pdu.rs');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

const js = fs.readFileSync(PARSE, 'utf8');
const rs = fs.readFileSync(RUST, 'utf8');

/* 只匹配赋值形态：注释里写 "原先用 udl * 2" 不会被误判 */
const WRONG_ASSIGN = /udLen\s*=\s*udl\s*\*\s*2\s*;/;
const RIGHT_ASSIGN = /udLen\s*=\s*udl\s*;/;
const RUST_NEED = /0x02\s*\|\s*0x01\s*=>\s*udl/;
const RUST_ERR = /"[^"]*用户数据不足[^"]*"/;

ok('① parse.js 不得把 UCS2/8bit 的长度按字符算（`udLen = udl * 2;`）',
	WRONG_ASSIGN.test(js) === false,
	'parse.js 里仍有 `udLen = udl * 2;` —— UD 之后若还有字节会被当正文吞进来');

ok('② parse.js 必须存在 `udLen = udl;`（按八位组取长度，删掉整段也会判红）',
	RIGHT_ASSIGN.test(js) === true,
	'没找到 `udLen = udl;` —— 分支被删了，或判据会恒绿');

ok('③ pdu.rs 里 8bit/UCS2 的字节需求取自 udl（与前端同源）',
	RUST_NEED.test(rs) === true,
	'pdu.rs 里没看到 `0x02 | 0x01 => udl`');

ok('④ pdu.rs 对"用户数据不足"必须在字符串字面量里显式报错（不许静默截断）',
	RUST_ERR.test(rs) === true,
	'pdu.rs 里没有"用户数据不足"的报错字符串');

/* ---- 反向自检：判据必须能分辨正/反两种写法，且不被注释干扰（纯内存）---- */
const codeReversed = 'if (enc === 2) udLen = udl * 2;';
const codeFixed = 'if (enc === 1 || enc === 2) udLen = udl;';
const commentOnly = '/* 历史上的写法是 udl * 2，现已改为按八位组 */\nfunction f() {}';

ok('★ 反向自检：能检出按字符计的写法', WRONG_ASSIGN.test(codeReversed) === true);
ok('★ 反向自检：不会把正确的 `udLen = udl;` 误判为按字符计',
	WRONG_ASSIGN.test(codeFixed) === false && RIGHT_ASSIGN.test(codeFixed) === true);
ok('★ 反向自检：注释里提到 `udl * 2` 不算违规（"注释不算使用"）',
	WRONG_ASSIGN.test(commentOnly) === false);
ok('★ 反向自检：注释里的"用户数据不足"不算报错分支',
	RUST_ERR.test('// 这里应当报 用户数据不足') === false &&
	RUST_ERR.test('return Err("用户数据不足：声明 {n} 字节".into());') === true);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('PDU 长度单位契约通过（UCS2/8bit 按八位组，前后端同源）');
