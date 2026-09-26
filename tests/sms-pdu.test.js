#!/usr/bin/env node
/*
 * 短信 PDU 契约测试（无需真机、无需模组）
 * ---------------------------------------------------------------------------
 * 为什么需要这个文件：前端 smsEncode.js 负责**编码**（SMS-SUBMIT），
 * Rust pdu.rs 负责**解码**（SMS-DELIVER）。两边必须对同一套 3GPP 23.040 规则，
 * 否则「发出去的长短信」与「收到的长短信」都会错位，而且真机上很难一眼看出。
 *
 * 本测试自带一个**参考解码器**（逐行镜像 pdu.rs 的算法），
 * 于是「编码 → 参考解码 → 与原文比对」构成闭环，不依赖模组。
 *
 * 2026-09-13 用它抓到并修掉的三个真 bug（当时真机短信提交被阻塞，一直没暴露）：
 *   ① GSM7 带 UDH 时没有补 1 个填充位把 UDH 对齐到 septet 边界 → 收件人看到乱码；
 *   ② 同一情形 TP-UDL 用 message.length + 6（应为 + 7）→ 每片少 1 个字；
 *   ③ 无 UDH 时 TP-UDL 用字符数而非 septet 数 → 含 € ^ { } [ ] ~ | \ 的消息被截断。
 *
 * 运行：node tests/sms-pdu.test.js
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

/* ---------- 参考解码器（镜像 src/rust/src/pdu.rs） ---------- */
const GSM7_ALPHABET = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
	'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const EXT_REVERSE = { 0x0a: '\f', 0x14: '^', 0x28: '{', 0x29: '}', 0x2f: '\\', 0x3c: '[', 0x3d: '~', 0x3e: ']', 0x40: '|', 0x65: '€' };

function unpackSeptets(octets, count) {
	const out = [];
	for (let i = 0; i < count; i++) {
		const base = i * 7;
		let v = 0;
		for (let j = 0; j < 7; j++) {
			const b = base + j;
			const bi = Math.floor(b / 8);
			if (bi < octets.length && ((octets[bi] >> (b % 8)) & 1)) v |= (1 << j);
		}
		out.push(v);
	}
	return out;
}

function septetsToString(septets) {
	let s = '', i = 0;
	while (i < septets.length) {
		const c = septets[i];
		if (c === 0x1b && i + 1 < septets.length && EXT_REVERSE[septets[i + 1]] !== undefined) {
			s += EXT_REVERSE[septets[i + 1]];
			i += 2;
			continue;
		}
		s += c < GSM7_ALPHABET.length ? GSM7_ALPHABET[c] : '?';
		i++;
	}
	return s;
}

function hexToOctets(h) {
	const out = [];
	for (let i = 0; i + 1 < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16));
	return out;
}

/** 解析一条完整 PDU（含可选 SC 地址），返回 { first, udl, udh, content, encoding, seq, total, ref } */
function decodeSubmitOrDeliver(pduHex) {
	const b = hexToOctets(pduHex);
	let pos = 0;
	const scaLen = b[pos]; pos += 1 + scaLen;
	const first = b[pos]; pos += 1;
	const mti = first & 0x03;
	if (mti === 0x01) pos += 1;                       // SMS-SUBMIT: TP-MR
	const daLen = b[pos]; pos += 1 + 1;               // 长度 + TOA
	pos += Math.ceil(daLen / 2);
	pos += 1;                                         // PID
	const dcs = b[pos]; pos += 1;
	if (mti === 0x01) {
		/* VPF: 00 无 / 01 绝对 7 字节 / 10 相对 1 字节 / 11 绝对 7 字节 */
		const vpf = (first >> 3) & 0x03;
		pos += { 0: 0, 1: 7, 2: 1, 3: 7 }[vpf];
	} else {
		pos += 7;                                     // SCTS
	}
	const udl = b[pos]; pos += 1;
	const ud = b.slice(pos);

	let udhLen = 0, concat = null;
	if ((first & 0x40) && ud.length) {
		udhLen = ud[0] + 1;
		if (udhLen >= 6 && ud[1] === 0x00 && ud[2] === 0x03) {
			concat = { ref: ud[3], total: ud[4], seq: ud[5] };
		}
	}
	const encoding = (dcs >> 2) & 0x03;
	let content = '';
	if (encoding === 0x02) {
		for (let i = udhLen; i + 1 < ud.length; i += 2) content += String.fromCharCode((ud[i] << 8) | ud[i + 1]);
	} else if (encoding === 0x01) {
		content = ud.slice(udhLen).map((x) => String.fromCharCode(x)).join('');
	} else {
		const udhSeptets = Math.floor((udhLen * 8 + 6) / 7);   // pdu.rs 口径
		const total = Math.max(udl, udhSeptets);
		const septets = unpackSeptets(ud, total);
		content = udhSeptets <= septets.length ? septetsToString(septets.slice(udhSeptets)) : '';
	}
	return { mti, first, dcs, udl, udhLen, concat, content, encoding, scaOctets: 1 + scaLen };
}

/* ---------- 断言工具 ---------- */
let pass = 0;
const fails = [];
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '\n      ' + extra : ''));
}

const DEST = '10086';
function parts(message, smsc) {
	return SmsEncode.buildSubmitParts({ destination: DEST, message: message, smsc: smsc || '' });
}
function decodePart(p) {
	const full = p.pdu;
	const d = decodeSubmitOrDeliver(full);
	/* TP-UDL 位于 TPDU 内；TPDU 长度 = pdu 去掉 SC 地址部分 */
	d.tpduHex = full.substr(d.scaOctets * 2);
	return d;
}

/* ---------- 1. 首字节位序（厂商手册附录 表 20-6） ----------
 * b7 TP-RP | b6 TP-UDHI | b5 TP-SRR | b4:b3 TP-VPF | b2 TP-RD | b1:b0 TP-MTI
 */
{
	const single = decodePart(parts('hello')[0]);
	eq('单条首字节 MTI=SMS-SUBMIT', single.mti, 1);
	eq('单条首字节 VPF=10（相对格式）', (single.first >> 3) & 0x03, 2);
	eq('单条首字节 TP-RD=0（不去重，见下方说明）', (single.first >> 2) & 0x01, 0);
	eq('单条首字节 TP-SRR=0（不请求状态报告，bit5）', (single.first >> 5) & 0x01, 0);
	eq('单条首字节 TP-UDHI=0', (single.first >> 6) & 0x01, 0);

	const multi = decodePart(parts('A'.repeat(200))[0]);
	eq('长短信首字节 TP-UDHI=1', (multi.first >> 6) & 0x01, 1);
	eq('长短信首字节 TP-SRR=0', (multi.first >> 5) & 0x01, 0);
	eq('长短信首字节 TP-RD=0', (multi.first >> 2) & 0x01, 0);
}

/*
 * TP-RD 必须为 0（曾为 1，2026-09-14 改为 0）。
 *
 * TP-RD=1 =「请求短消息中心拒收重复短信」：SMSC 会把「同目的号码 + 同内容」且仍在
 * 有效期内的短信判为重复并丢弃。调试与重试场景（反复重发同一条）会静默失败。
 * 本项目无去重需求，且与已实测提交成功的样本首字节（0x11，无 RD）对齐。
 */
{
	eq('单条首字节整体 = 0x11（MTI=01 + VPF=10，无 RD/SRR/UDHI）',
		decodePart(parts('hello')[0]).first, 0x11);
	eq('长短信首字节整体 = 0x51（0x11 + UDHI）',
		decodePart(parts('A'.repeat(200))[0]).first, 0x51);
}

/* ---------- 2. GSM7 单条（无 UDH）：往返必须一致 ---------- */
for (const text of ['hello', 'normal text 12345', 'ABCabc123!@#$%']) {
	const d = decodePart(parts(text)[0]);
	eq('GSM7 单条往返: ' + JSON.stringify(text), d.content, text);
	eq('GSM7 单条 TP-UDL = 字符数: ' + JSON.stringify(text), d.udl, text.length);
}

/* ---------- 3. GSM7 单条 + 扩展字符：TP-UDL 必须按 septet 计 ----------
 * € ^ { } [ ] ~ | \ 在 7bit 流里占 2 个 septet，按字符数计会截断正文。
 */
for (const [text, septets] of [['ab^cd', 6], ['€', 2], ['a€b', 4], ['[]{}~|', 12], ['{€}', 6]]) {
	const d = decodePart(parts(text)[0]);
	eq('扩展字符往返: ' + JSON.stringify(text), d.content, text);
	eq('扩展字符 TP-UDL 按 septet: ' + JSON.stringify(text), d.udl, septets);
}

/* ---------- 4. GSM7 长短信（带 UDH）：
 *   每片正文 ≤153 septets；UDH 占 7 septets；TP-UDL = 7 + 正文 septets。
 */
{
	const text = 'A'.repeat(200);
	const ps = parts(text);
	eq('GSM7 长短信分片数', ps.length, 2);
	ps.forEach((p, i) => {
		const d = decodePart(p);
		const expect = text.substr(i * 153, 153);
		eq('长短信第 ' + (i + 1) + ' 片往返一致', d.content, expect);
		eq('长短信第 ' + (i + 1) + ' 片 TP-UDL = 7 + 正文 septets', d.udl, 7 + expect.length);
		eq('长短信第 ' + (i + 1) + ' 片 UDH 占 7 septets', Math.floor((d.udhLen * 8 + 6) / 7), 7);
		eq('长短信第 ' + (i + 1) + ' 片分段序号', [d.concat.seq, d.concat.total], [i + 1, 2]);
		eq('长短信两片 ref 相同', d.concat.ref, decodePart(ps[0]).concat.ref);
	});
}

/* ---------- 5. 边界：刚好 160 / 161 septets ---------- */
{
	const p160 = parts('A'.repeat(160));
	eq('160 字符仍单片', p160.length, 1);
	eq('160 字符往返', decodePart(p160[0]).content, 'A'.repeat(160));
	eq('160 字符 TP-UDL', decodePart(p160[0]).udl, 160);

	const p161 = parts('A'.repeat(161));
	eq('161 字符分两片', p161.length, 2);
	eq('161 字符第 1 片', decodePart(p161[0]).content, 'A'.repeat(153));
	eq('161 字符第 2 片', decodePart(p161[1]).content, 'A'.repeat(8));
}

/* ---------- 6. 长短信含扩展字符：按 septet 精确切分 ---------- */
{
	const text = 'x'.repeat(150) + '^' + 'y'.repeat(60);   // 150 + 2 + 60 = 212 septets
	const ps = parts(text);
	eq('含扩展字符的长短信分片数', ps.length, 2);
	let joined = '';
	ps.forEach((p) => { joined += decodePart(p).content; });
	eq('含扩展字符的长短信拼接后与原文一致', joined, text);
	/* 每片正文 septets 不得超过 153 */
	ps.forEach((p, i) => {
		const d = decodePart(p);
		const body = d.udl - 7;
		ok('第 ' + (i + 1) + ' 片正文 septets ≤ 153', body <= 153, '实际 ' + body);
	});
}

/* ---------- 7. UCS2：UDL 按八位组计（UDH 6 字节也计入） ---------- */
{
	const shortText = '中文测试';                       // 4 字符
	const d1 = decodePart(parts(shortText)[0]);
	eq('UCS2 单条往返', d1.content, shortText);
	eq('UCS2 单条 DCS=08', d1.dcs, 0x08);
	eq('UCS2 单条 TP-UDL = 2×字符数', d1.udl, 8);

	const longText = '测'.repeat(200);
	const ps = parts(longText);
	eq('UCS2 长短信分片数', ps.length, 3);              // ceil(200/67)
	ps.forEach((p, i) => {
		const d = decodePart(p);
		const expect = longText.substr(i * 67, 67);
		eq('UCS2 第 ' + (i + 1) + ' 片往返', d.content, expect);
		eq('UCS2 第 ' + (i + 1) + ' 片 TP-UDL = 6 + 2×字符数', d.udl, 6 + expect.length * 2);
	});
}

/* ---------- 8. UI 提示的条数必须等于实际分片数 ----------
 * messageStats 用于输入框下方提示，buildSubmitParts 才是真正发出去的，
 * 两者对不上会让用户以为只发 1 条却发了 3 条。
 */
for (const text of ['hello', 'A'.repeat(160), 'A'.repeat(161), 'A'.repeat(200),
	'ab^cd', '€'.repeat(80), '中文', '测'.repeat(70), '测'.repeat(71), '测'.repeat(200),
	'x'.repeat(150) + '^' + 'y'.repeat(60)]) {
	const st = SmsEncode.messageStats(text);
	const real = parts(text).length;
	eq('提示条数 = 实际分片数: ' + (text.length > 20 ? text.length + ' 字符' : JSON.stringify(text)), st.parts, real);
}

/* ---------- 9. SMSC 编码（SCA 长度含 TOA 字节；TP-DA 长度是数字位数） ---------- */
{
	const withSmsc = parts('hi', '+8613800755500')[0];
	const hex = withSmsc.pdu;
	/* +8613800755500 → 去掉 '+' 后 13 位数字 → 补 F 后 7 个八位组：
	 * 长度字节 = 1(TOA) + 7 = 8，故 SCA 共 9 个八位组 = 18 个十六进制字符 */
	eq('SCA 总长 = 长度字节 + 8 个八位组', hex.substr(0, 18), '0891683108705505F0');
	const d = decodeSubmitOrDeliver(hex);
	eq('解析出的 SCA 八位组数', d.scaOctets, 9);
	/* TPDU 从第 9 个八位组（index 18）开始：first(2) mr(2) da_len(2) toa(2) da(6) */
	eq('TP-DA 长度 = 数字位数（10086 → 5）', hex.substr(22, 2), '05');
	eq('TP-DA TOA = 81（不含国家码）', hex.substr(24, 2), '81');
	eq('TP-DA 打包（10086 → 0180F6）', hex.substr(26, 6), '0180F6');

	const noSmsc = parts('hi')[0];
	eq('无 SMSC 时首字节为 00（用 SIM 默认）', noSmsc.pdu.substr(0, 2), '00');
	eq('tpduLength 不含 SC 地址部分', noSmsc.tpduLength, (noSmsc.pdu.length - 2) / 2);
	const withSmscLen = parts('hi', '+8613800755500')[0];
	eq('有 SMSC 时 tpduLength 仍不含 SC 地址', withSmscLen.tpduLength, (withSmscLen.pdu.length - 18) / 2);
}

/* ---------- 10. 国际号码的 TP-DA 类型字节必须是 0x91 ----------
 * 0x91 = international（带国家码），0x81 = national/unknown。
 * 曾因发送前把号码开头的 '+' 剥掉，导致编码器永远判成 0x81。
 */
function partsTo(dest, message, smsc) {
	return SmsEncode.buildSubmitParts({ destination: dest, message: message, smsc: smsc || '' });
}
{
	const intl = partsTo('+8613800138000', 'hi')[0].pdu;
	const base = (parseInt(intl.substr(0, 2), 16) + 1) * 2;
	eq('国际号码 TP-DA 长度 = 13 位数字', intl.substr(base + 4, 2), '0D');
	eq('国际号码 TP-DA TOA = 0x91（international）', intl.substr(base + 6, 2), '91');

	const nat = partsTo('10086', 'hi')[0].pdu;
	const base2 = (parseInt(nat.substr(0, 2), 16) + 1) * 2;
	eq('国内短号 TP-DA 长度 = 5 位数字', nat.substr(base2 + 4, 2), '05');
	eq('国内短号 TP-DA TOA = 0x81', nat.substr(base2 + 6, 2), '81');
}

/* sms_center.js 不得在发送前剥掉开头的 '+'（编码器靠它判断 TOA） */
{
	const SC = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');
	const sc = fs.readFileSync(SC, 'utf8');
	ok('sms_center.js 不再剥掉号码开头的 +', !/target\.replace\(\s*\/\^\\\+\/\s*,\s*''\s*\)/.test(sc));
}

/* ---------- 11. 代理对（emoji 等）不得被切出孤立代理项 ----------
 * UCS2 容量按八位组 = UTF-16 码元算：带 UDH 每片 ≤134 字节 = 67 码元。
 * emoji 占 2 码元，且不能把代理对切开 → 每片最多 33 个 emoji（66 码元），
 * 所以 100 个 emoji 会是 33+33+33+1 = 4 片。
 */
{
	const emoji = '😀';
	const text = emoji.repeat(100);                       // 200 码元 / 100 码点
	const ps = parts(text);
	eq('100 emoji 分 4 片（每片 33 个，不切代理对）', ps.length, 4);
	eq('100 emoji 各片码点数', ps.map((p) => Array.from(decodePart(p).content).length), [33, 33, 33, 1]);
	const joined = ps.map((p) => decodePart(p).content).join('');
	eq('emoji 拼接后与原文一致', joined, text);
	ok('分片处没有孤立代理项',
		!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(joined));

	/* 单条上限 70 码元：35 个 emoji 仍可单片，36 个就要分片 */
	const p35 = parts(emoji.repeat(35));
	eq('35 个 emoji 单片', p35.length, 1);
	eq('35 个 emoji 往返', decodePart(p35[0]).content, emoji.repeat(35));
	const p36 = parts(emoji.repeat(36));
	ok('36 个 emoji 需要分片', p36.length > 1, '实际 ' + p36.length + ' 片');

	/* 每片 UCS2 正文不得超过 134 字节（含 6 字节 UDH）→ UDL ≤ 140 */
	ps.forEach((p, i) => {
		ok('emoji 第 ' + (i + 1) + ' 片 UDL ≤ 140', decodePart(p).udl <= 140, '实际 ' + decodePart(p).udl);
	});
}

/* ---------- 汇总 ---------- */
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach((f, i) => console.log('  ✗ ' + (i + 1) + '. ' + f));
	process.exit(1);
}
console.log('短信 PDU 契约测试全部通过（编码 ↔ pdu.rs 口径 往返一致）');
