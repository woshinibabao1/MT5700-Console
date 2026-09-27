#!/usr/bin/env node
/*
 * GSM7 默认字母表的**三方一致性**契约。
 *
 * 为什么需要它：这张表在仓库里有**三份独立定义**，分别服务三条路径 ——
 *   · htdocs/.../parse.js      前端解码（septetsToString）
 *   · htdocs/.../smsEncode.js  前端编码（gsm7Code）
 *   · src/rust/src/pdu.rs      后端解码（septets_to_string）
 * 任何一份漂移，都会让「同一份 PDU 在不同路径下解出不同字符」，而且**不会报错** ——
 * 只是短信内容悄悄变了。这与本会话查出的另外三起前后端漂移（unpackSeptets 的填充位、
 * dcs_encoding 的分组、decodeAddress 的 BCD/TON）是同一类问题：各自的测试只守自己那一侧。
 *
 * 判据：三份都恰好 128 个码位（0x00–0x7F 按码位直接索引，多一个少一个整表错位），
 * 且**逐字符相等**；另加 14 个 GSM 03.38 的关键锚点，防止三份"一起错"。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const P_PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const P_ENCODE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'smsEncode.js');
const P_RUST = path.join(ROOT, 'src', 'rust', 'src', 'pdu.rs');

let pass = 0;
let fail = 0;
function ok(name, cond, hint) {
	if (cond) {
		pass++;
		console.log('  ok  ' + name);
	} else {
		fail++;
		console.log('  ✗ ' + name + (hint ? '  → ' + hint : ''));
	}
}
function read(p) {
	try {
		return fs.readFileSync(p, 'utf8');
	} catch (e) {
		return '';
	}
}
/* 只求值一个字面量，安全 */
function jsLiteral(file, re) {
	const m = read(file).match(re);
	if (!m) return null;
	try {
		return vm.runInNewContext(m[1]);
	} catch (e) {
		return null;
	}
}
/* Rust 的 concat!("…","…")：拆段后求值（这些转义 Rust 与 JS 语义相同） */
function rustAlphabet() {
	const m = read(P_RUST).match(/GSM7_ALPHABET: &str = concat!\(([\s\S]*?)\);/);
	if (!m) return null;
	const segs = m[1].match(/"((?:[^"\\]|\\.)*)"/g) || [];
	try {
		return segs.map(function (s) {
			return vm.runInNewContext('"' + s.slice(1, -1) + '"');
		}).join('');
	} catch (e) {
		return null;
	}
}

console.log('== GSM7 字母表三方一致性 ==');

const a = jsLiteral(P_PARSE, /var GSM7_ALPHABET = ('(?:[^'\\]|\\.)*');/);
const b = jsLiteral(P_ENCODE, /var GSM7_ALPHABET = ('(?:[^'\\]|\\.)*');/);
const c = rustAlphabet();

ok('parse.js 里取到字母表', a !== null);
ok('smsEncode.js 里取到字母表', b !== null);
ok('pdu.rs 里取到字母表', c !== null);

[['parse.js', a], ['smsEncode.js', b], ['pdu.rs', c]].forEach(function (kv) {
	const n = kv[1];
	ok(kv[0] + ' 恰好 128 个码位', n !== null && Array.from(n).length === 128,
		'实际 ' + (n === null ? '取不到' : Array.from(n).length) + ' 个 —— 表按码位索引，多一个少一个整表错位');
	ok(kv[0] + ' 全部是 BMP 字符（码元数 == 码点数）', n !== null && n.length === Array.from(n).length,
		'含增补平面字符时，下游用 .length 判界（septetsToString）会越界或错位');
});

ok('parse.js == smsEncode.js', a !== null && a === b, '前端解码与编码用的表必须同一份');
ok('parse.js == pdu.rs', a !== null && a === c, '前端与后端的表必须同一份');
ok('smsEncode.js == pdu.rs', b !== null && b === c, '编码端与后端解码的表必须同一份');

/* 关键锚点：防止"三份一起错" */
const ANCHORS = [
	[0x00, '@'], [0x0A, '\n'], [0x0D, '\r'], [0x1B, '\u001b'], [0x20, ' '],
	[0x24, '\u00a4'], [0x30, '0'], [0x3F, '?'], [0x40, '\u00a1'], [0x41, 'A'],
	[0x5A, 'Z'], [0x61, 'a'], [0x7A, 'z'], [0x7F, '\u00e0'],
];
for (const [i, ch] of ANCHORS) {
	const tag = '0x' + i.toString(16).toUpperCase().padStart(2, '0');
	const got = [a, b, c].map(function (s) { return s === null ? '?' : Array.from(s)[i]; });
	ok('锚点 ' + tag + ' 三份都是 ' + JSON.stringify(ch),
		got[0] === ch && got[1] === ch && got[2] === ch,
		'实际 ' + got.map(function (g) { return JSON.stringify(g); }).join(' / '));
}

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' / ' + (pass + fail) + ' 项');
process.exit(1);
