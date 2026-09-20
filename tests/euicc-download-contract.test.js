#!/usr/bin/env node
/*
 * eSIM 下载链路契约测试（纯 Node，绝不向真机下发任何 AT）
 * ---------------------------------------------------------------------------
 * 覆盖 euicc.js 新增的「添加 Profile」一半：
 *   激活码解析 / 域名白名单（SSRF 面）/ SHA-256 确认码哈希 / base64↔hex /
 *   ES10b APDU 组装与分块 / ES9+ 端点 / downloadProfile 全流程（成功与失败）。
 *
 * 存在的理由：这条链路**没有真 eUICC 可跑**（本机是普通 USIM，SELECT ISD-R 6A82），
 * 只能靠 mock 把协议骨架钉死。尤其要钉住两条已踩过的坑：
 *   ① pickTagValue 不下钻构造 tag → 取不到 BF2E 里的挑战值，第一步就失败；
 *   ② 下载里嵌套 withIsdrSession → 重复开逻辑通道，卡上可能直接 6A81。
 *
 * 运行：node tests/euicc-download-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EUICC_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'euicc.js');
const src = fs.readFileSync(EUICC_JS, 'utf8');
const m = src.match(/var Euicc = \((function[\s\S]*?)\)\(\);/);
if (!m) {
	console.error('无法从 euicc.js 提取模块');
	process.exit(1);
}
/* eslint-disable no-eval */
const Euicc = eval('(' + m[1] + ')')();

let pass = 0;
const fails = [];
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
/* 断言「确实抛了带 code 的异常」——失败路径绝不能静默成功 */
function threw(label, fn, code) {
	return Promise.resolve().then(fn).then(function () {
		fails.push(label + '  → 本应抛错却成功了');
	}, function (e) {
		if (code && (e && e.code) !== code) {
			fails.push(label + '  → code 实际 ' + (e && e.code) + '，期望 ' + code);
		} else {
			pass++;
		}
	});
}
const asyncTests = [];

function toHex(str) {
	let s = '';
	for (let i = 0; i < str.length; i++) s += ('0' + str.charCodeAt(i).toString(16)).slice(-2);
	return s.toUpperCase();
}
function csimAnswer(dataAndSw) {
	return '+CSIM: ' + dataAndSw.length + ',"' + dataAndSw + '"';
}

/* ---------- 1. SHA-256（FIPS 180-4 标准测试向量） ---------- */

eq('sha256("") 标准向量', Euicc.sha256Hex(''),
	'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
eq('sha256("abc") 标准向量', Euicc.sha256Hex('abc'),
	'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
eq('sha256 长度恒为 64 hex', Euicc.sha256Hex('a'.repeat(1000)).length, 64);
eq('确认码空值不哈希', Euicc.hashConfirmationCode(''), null);
eq('确认码哈希 = SHA-256("1234")',
	Euicc.hashConfirmationCode('1234'),
	'03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4');
ok('确认码哈希不含明文（64 hex，无 31323334）',
	Euicc.hashConfirmationCode('1234').indexOf('31323334') < 0);

/* ---------- 2. base64 ↔ hex 往返 ---------- */

const sampleHex = 'A0A1FEFF0001027F80';
eq('hex→base64→hex 往返', Euicc.base64ToHex(Euicc.hexToBase64(sampleHex)), sampleHex);
eq('base64 是标准 alphabet', Euicc.hexToBase64('00FF00'), Buffer.from([0, 255, 0]).toString('base64'));
eq('hexToBase64 非法 hex 抛错', (function () {
	try { Euicc.hexToBase64('0G'); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_HEX');

/* ---------- 3. 域名白名单（后端 ES9+ 转发的 SSRF 面） ---------- */

eq('isFqdn 放行合法域名',
	[Euicc.isFqdn('rsp.example.com'), Euicc.isFqdn('lpa.ds.gsma.com'), Euicc.isFqdn('a-b.cn')],
	[true, true, true]);
eq('isFqdn 拒绝 IP / localhost / 无点 / 非法标签',
	[Euicc.isFqdn('127.0.0.1'), Euicc.isFqdn('192.168.10.1'), Euicc.isFqdn('localhost'),
		Euicc.isFqdn('LOCALHOST'), Euicc.isFqdn('localhost.'), Euicc.isFqdn('nodot'),
		Euicc.isFqdn('-bad.com'), Euicc.isFqdn('bad-.com'), Euicc.isFqdn(''),
		Euicc.isFqdn('[::1]'), Euicc.isFqdn('sp dp.com')],
	[false, false, false, false, false, false, false, false, false, false, false]);
eq('isFqdn 拒绝带端口/路径/斜杠（拼进 URL 会改语义）',
	[Euicc.isFqdn('rsp.example.com:443'), Euicc.isFqdn('rsp.example.com/x'),
		Euicc.isFqdn('rsp.example.com#y')],
	[false, false, false]);

/* ---------- 4. 激活码解析 ---------- */

eq('normalize 去掉空白与包裹引号',
	Euicc.normalizeActivationCode('  "LPA:1$rsp.example.com$ABC-123" \n'),
	'LPA:1$rsp.example.com$ABC-123');
eq('解析标准码', (function () {
	const r = Euicc.parseActivationCode('LPA:1$rsp.example.com$ABC-123');
	return [r.ok, r.smdp, r.matchingId, r.oid, r.confirmationCodeRequired];
})(), [true, 'rsp.example.com', 'ABC-123', '', null]);
eq('省略 LPA: 前缀也认', Euicc.parseActivationCode('1$rsp.example.com$ABC').ok, true);
eq('带 OID 与确认码标志',
	(function () {
		const r = Euicc.parseActivationCode('LPA:1$rsp.example.com$ABC$1.3.6.1$1');
		return [r.ok, r.oid, r.confirmationCodeRequired];
	})(), [true, '1.3.6.1', true]);
eq('确认码标志 0 → false',
	Euicc.parseActivationCode('LPA:1$rsp.example.com$ABC$$0').confirmationCodeRequired, false);
eq('拒绝：段数不对', Euicc.parseActivationCode('LPA:1$rsp.example.com').ok, false);
eq('拒绝：版本不是 1', Euicc.parseActivationCode('LPA:2$rsp.example.com$ABC').ok, false);
eq('拒绝：SM-DP+ 是 IP（SSRF 面）',
	Euicc.parseActivationCode('LPA:1$127.0.0.1$ABC').ok, false);
eq('拒绝：匹配码含非法字符',
	Euicc.parseActivationCode('LPA:1$rsp.example.com$ABC_123').ok, false);
eq('拒绝：确认码标志非 0/1',
	Euicc.parseActivationCode('LPA:1$rsp.example.com$ABC$$2').ok, false);
eq('拒绝：空输入', Euicc.parseActivationCode('   ').ok, false);
eq('build/parse 往返', (function () {
	const code = Euicc.buildActivationCode({
		smdp: 'rsp.example.com', matchingId: 'ABC', oid: '1.3.6.1', confirmationCodeRequired: true
	});
	const r = Euicc.parseActivationCode(code);
	return [code, r.ok, r.smdp, r.matchingId, r.oid];
})(), ['LPA:1$rsp.example.com$ABC$1.3.6.1$1', true, 'rsp.example.com', 'ABC', '1.3.6.1']);

/* ---------- 5. BER-TLV 组装 ---------- */

eq('tlvHex 短格式', Euicc.tlvHex('80', '0102'), '80020102');
eq('tlvHex 0x81 长格式', Euicc.tlvHex('80', '00'.repeat(200)).substr(0, 6), '80 81C8'.replace(' ', ''));
eq('tlvHex 0x82 长格式', Euicc.tlvHex('80', '00'.repeat(300)).substr(0, 8), '8082012C');
eq('tlvHex 超长抛错', (function () {
	try { Euicc.tlvHex('80', '00'.repeat(70000)); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');

/* ★ 2026-09-19 真机实测：本卡（及 MT5700M 透传）在 STORE DATA 带 Le=00 时，
   AT+CSIM 传输层直接返回 ERROR（不是卡片 SW）；不带 Le 才返回 9000。
   故 storeDataApdu 不再拼 Le，这里的期望同步去掉末尾两个字符。 */
eq('buildEs10b 组装：CLA/INS/Lc 全对（★ 不带 Le，实测带 Le 会传输层 ERROR）', (function () {
	const apdu = Euicc.buildEs10b(1, 'BF2E', '');
	return [apdu, apdu.length];
})(), ['80E2910003BF2E0000'.replace('80E2910003', '81E2910003').replace(/00$/, ''), 16]);
eq('buildEs10b 拒绝不在白名单的 tag', (function () {
	try { Euicc.buildEs10b(1, 'BF99', ''); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');

/* ---------- 6. 分块（BPP 几十 KB 装不进一个 APDU） ---------- */

const bppHex = 'BF36' + '0080' + 'AA'.repeat(600);   /* 伪 BPP，600 字节 */
const chunks = Euicc.buildEs10bChunks(1, 'BF36', 'AA'.repeat(600), 120);
ok('分块数量 = ceil(总长/mss)', chunks.length === Math.ceil((600 + 3 + 3) / 120),
	'实际 ' + chunks.length);
eq('末块 P1=0x91，其余 P1=0x11', chunks.map(function (c) { return c.substr(4, 2); })
	.map(function (p1, i, a) { return i === a.length - 1 ? p1 : p1; })
	.filter(function (p1, i, a) { return i === a.length - 1; })[0], '91');
eq('非末块全是 0x11', chunks.slice(0, -1).every(function (c) { return c.substr(4, 2) === '11'; }), true);
eq('P2 从 0 起递增', chunks.slice(0, 4).map(function (c) { return c.substr(6, 2); }),
	['00', '01', '02', '03']);
/* 无 Le 后，tlv 部分就是从第 10 个字符一直到末尾（旧写法再砍 2 是把 Le 当数据砍掉） */
eq('分片可原样拼回整条 TLV', chunks.map(function (c) { return c.substr(10); }).join(''),
	Euicc.tlvHex('BF36', 'AA'.repeat(600)));
eq('mss 越界回退默认 120', Euicc.buildEs10bChunks(1, 'BF36', 'AA'.repeat(600), 9999).length,
	chunks.length);
void bppHex;

/* ---------- 7. ES9+ 端点 ---------- */

eq('ES9+ 五个端点路径', [
	Euicc.es9pRequest('initiateAuthentication').path,
	Euicc.es9pRequest('authenticateClient').path,
	Euicc.es9pRequest('getBoundProfilePackage').path,
	Euicc.es9pRequest('handleNotification').path,
	Euicc.es9pRequest('cancelSession').path
], [
	'/gsma/rsp2/es9plus/initiateAuthentication',
	'/gsma/rsp2/es9plus/authenticateClient',
	'/gsma/rsp2/es9plus/getBoundProfilePackage',
	'/gsma/rsp2/es9plus/handleNotification',
	'/gsma/rsp2/es9plus/cancelSession'
]);
eq('未知端点抛错', (function () {
	try { Euicc.es9pRequest('evil'); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('es9pRequest 序列化成 JSON',
	JSON.parse(Euicc.es9pRequest('cancelSession', { transactionId: 'T1' }).json).transactionId, 'T1');

/* ---------- 8. pickTagValue 下钻（① 号坑的回归守卫） ---------- */

eq('取基本 tag', Euicc.pickTagValue('80080102030405060708', '80'), '0102030405060708');
eq('★ 下钻构造 tag：BF2E 里的 80',
	Euicc.pickTagValue('BF2E0A80080102030405060708', '80'), '0102030405060708');
eq('★ 下钻两层：BF28/A0/BF2F/80',
	Euicc.pickTagValue(Euicc.tlvHex('BF28', Euicc.tlvHex('A0',
		Euicc.tlvHex('BF2F', Euicc.tlvHex('80', '2A')))), '80'), '2A');
eq('0x81/0x82 长度也能取', [
	Euicc.pickTagValue('80' + '81' + '03' + 'AABBCC', '80'),
	Euicc.pickTagValue('80' + '82' + '0003' + 'AABBCC', '80')
], ['AABBCC', 'AABBCC']);
eq('取不到返回空串（不抛）', [
	Euicc.pickTagValue('', '80'), Euicc.pickTagValue('BF2E0A800801', '80'),
	Euicc.pickTagValue('ZZZZ', '80')
], ['', '', '']);
eq('畸形长度不越界（截断的 0x82）', Euicc.pickTagValue('808200', '80'), '');

/* ---------- 9. downloadProfile：mock 全流程 ---------- */

const CH = 1;
const CHALLENGE = '0102030405060708';
/*
 * ★ 2026-09-20：BPP 必须是**真实结构**（BF36 内 BF23/A0/A1+子项/A3+子项）。
 *   旧 mock 用 'AA'.repeat(400) 这种纯填充，掩盖了一个致命 bug —— 旧实现把
 *   整包当一个逻辑命令连发，卡得攒齐整包才解析，攒到 8160 字节必 6A84。
 *   mock 不像真包，就永远测不出「分段」这件事。
 */
const BPP_BODY = Euicc.tlvHex('BF36',
	Euicc.tlvHex('BF23', '11'.repeat(90)) +
	Euicc.tlvHex('A0', '22'.repeat(20)) +
	Euicc.tlvHex('A1',
		Euicc.tlvHex('87', 'A1'.repeat(120)) +
		Euicc.tlvHex('87', 'B2'.repeat(260))) +
		Euicc.tlvHex('A3',
		Euicc.tlvHex('88', 'C3'.repeat(400)) +
		Euicc.tlvHex('88', 'D4'.repeat(30))));

/* ---------- 8.5 ★ BPP 结构化分段（6A84 的真正修法） ---------- */

const SEGS = Euicc.splitBoundProfilePackage(BPP_BODY);
const SEG_MAX = Math.max.apply(null, SEGS.map(function (s) { return s.hex.length / 2; }));

ok('分段结果不少于 6 段（BF23 / A0 / A1头 / A1子×2 / A3头 / A3子×2）',
	SEGS.length >= 6, '段数 ' + SEGS.length);
eq('各段按序拼回 = 原包（既不丢字节也不重发）',
	SEGS.map(function (s) { return s.hex; }).join(''), BPP_BODY);
eq('第一段就是 BF36 头 + BF23 整块', SEGS[0].hex.indexOf('BF36') === 0 &&
	SEGS[0].hex.indexOf('BF23') > 0, true);
eq('★ A1 只发容器头（含值就变成整块连发）', (function () {
	const a1 = SEGS.filter(function (s) { return s.label.indexOf('A1 容器头') === 0; })[0];
	return a1 && a1.hex.length <= 8;   /* tag+长度，最多 4 字节 = 8 字符 */
})(), true);
eq('★ A3 只发容器头', (function () {
	const a3 = SEGS.filter(function (s) { return s.label.indexOf('A3 容器头') === 0; })[0];
	return a3 && a3.hex.length <= 8;
})(), true);
/*
 * ★ 这条是 6A84 的回归守卫本身：整包连发时卡要把整包攒进链接缓冲，
 *   攒到 8160 字节必炸。分段后「最大单段」必须**显著小于整包**。
 */
ok('★ 最大单段 < 整包长度（整包连发会撞卡侧缓冲 → 6A84）',
	SEG_MAX < BPP_BODY.length / 2,
	'最大单段 ' + SEG_MAX + 'B / 整包 ' + (BPP_BODY.length / 2) + 'B');
eq('每段自己的 P2 从 0 起算（每段都是新命令，lpac 的 reqseq 亦然）', (function () {
	return SEGS.every(function (s) {
		return Euicc.buildEs10bRawChunks(1, s.hex, 120)[0].substr(6, 2) === '00';
	});
})(), true);
eq('每段都以 P1=0x91 末块收尾', (function () {
	return SEGS.every(function (s) {
		const cs = Euicc.buildEs10bRawChunks(1, s.hex, 120);
		return cs[cs.length - 1].substr(4, 2) === '91';
	});
})(), true);
eq('缺 BF23 抛 EUICC_BAD_APDU', (function () {
	try { Euicc.splitBoundProfilePackage(Euicc.tlvHex('BF36', Euicc.tlvHex('A0', '00'))); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('缺 A3 抛 EUICC_BAD_APDU', (function () {
	try { Euicc.splitBoundProfilePackage(Euicc.tlvHex('BF36', Euicc.tlvHex('BF23', '00'))); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('非 BF36 开头抛 EUICC_BAD_APDU', (function () {
	try { Euicc.splitBoundProfilePackage(Euicc.tlvHex('BF3C', '00')); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');

/*
 * ★ 反向：把 A1 改回「整块下发」（子项照旧再发一遍 = 字节重复），
 *   「各段拼接 == 原包」必须翻红 —— 证明上面那条不是恒绿。
 *   （注意不能拿「段数变少」当判据：子项循环还在，段数不变，只有字节重复。）
 */
const negSrc = src
	.split("segs.push({ hex: bppHex.slice(a1.start, a1.valueStart), label: 'A1 容器头' });")
	.join("segs.push({ hex: bppHex.slice(a1.start, a1.end), label: 'A1 整块' });");
ok('★ 反向：改回整块下发 → 拼接不再等于原包（守卫不恒绿）', (function () {
	if (negSrc === src) return false;   /* 替换没打中 → 反向用例本身失效 */
	const neg = eval('(' + negSrc.match(/var Euicc = \((function[\s\S]*?)\)\(\);/)[1] + ')')();
	return neg.splitBoundProfilePackage(BPP_BODY).map(function (s) { return s.hex; })
		.join('') !== BPP_BODY;
})(), '替换未生效或断言恒绿');

/* 卡侧 mock：按 APDU 里的 ES10b tag 分派 */
function makeCard(opts) {
	opts = opts || {};
	const st = { cmds: [], opens: 0, closes: 0 };
	return {
		state: st,
		send: function (cmd) {
			st.cmds.push(cmd);
			const mm = /"([0-9A-Fa-f]*)"/.exec(cmd);
			const apdu = mm ? mm[1].toUpperCase() : '';
			if (apdu === '0070000001') { st.opens++; return Promise.resolve({ success: true, data: csimAnswer('019000') }); }
			if (apdu.indexOf('01A4040C10') === 0) return Promise.resolve({ success: true, data: csimAnswer('9000') });
			if (apdu === '0070800100') { st.closes++; return Promise.resolve({ success: true, data: csimAnswer('9000') }); }
			const body = apdu.substr(10, 4);   /* 跳过 CLA INS P1 P2 LC */
			/* 2026-09-19：withIsdrSession 会先用 GetEID 探活逻辑通道，mock 必须认得它，
			   否则它落到下面「P1=91 就算 BPP 分片」的兜底分支，把探活误计成一块 BPP。 */
			if (body === 'BF3E') return Promise.resolve({ success: true, data: csimAnswer('BF3E125A10' + '89004400112233445566778899AABBCCDD' + '9000') });
			if (body === 'BF2E') return Promise.resolve({ success: true, data: csimAnswer('BF2E0A80 08'.replace(' ', '') + CHALLENGE + '9000') });
			if (body === 'BF20') return Promise.resolve({ success: true, data: csimAnswer('BF2003' + '010203' + '9000') });
			if (body === 'BF38') return Promise.resolve({ success: true, data: csimAnswer(opts.authSw || '9000') });
			if (body === 'BF21') return Promise.resolve({ success: true, data: csimAnswer(opts.prepareSw || '9000') });
			if (body === 'BF36') { st.bppChunks = (st.bppChunks || 0) + 1; return Promise.resolve({ success: true, data: csimAnswer(opts.bppSw || '9000') }); }
			if (body === 'BF28') return Promise.resolve({ success: true, data: csimAnswer((opts.notifList || '') + '9000') });
			if (body === 'BF2B') return Promise.resolve({ success: true, data: csimAnswer('BF2B03' + '010203' + '9000') });
			if (body === 'BF30') { st.removed = true; return Promise.resolve({ success: true, data: csimAnswer('9000') }); }
			/*
			 * BPP 分块：后续块**不再带 BF36 头**（只有第一块带），
			 * 所以只能靠 P1 区分 —— 非末块 0x11、末块 0x91。
			 * 其余 ES10b 命令的 P1 也都是 0x91 且已在上面被 tag 命中，
			 * 走到这里还没匹配上的，就只可能是 BPP 分片。
			 */
			const p1 = apdu.substr(4, 2);
			if (p1 === '11' || p1 === '91') {
				st.bppChunks = (st.bppChunks || 0) + 1;
				return Promise.resolve({ success: true, data: csimAnswer(opts.bppSw || '9000') });
			}
			return Promise.resolve({ success: false, error: '未预期的 APDU ' + apdu });
		}
	};
}

/* SM-DP+ mock：按 path 分派 */
function makeServer(opts) {
	opts = opts || {};
	const st = { calls: [] };
	return {
		state: st,
		es9p: function (host, p, json) {
			st.calls.push({ host: host, path: p, json: json });
			if (opts.httpFail && p.indexOf(opts.httpFail) >= 0) {
				return Promise.resolve({ success: true, status: 500, body: '{"message":"boom"}' });
			}
			let body = '';
			if (p.indexOf('initiateAuthentication') >= 0) {
				body = JSON.stringify({
					transactionId: 'TX-1',
					serverSigned1: Euicc.hexToBase64('AABB'),
					serverSignature1: Euicc.hexToBase64('CCDD'),
					euiccCiPKIdToBeUsed: Euicc.hexToBase64('0102'),
					serverCertificate: Euicc.hexToBase64('EEFF')
				});
			} else if (p.indexOf('authenticateClient') >= 0) {
				body = JSON.stringify({
					smdpSigned2: Euicc.hexToBase64('1122'),
					smdpSignature2: Euicc.hexToBase64('3344'),
					smdpCertificate: Euicc.hexToBase64('5566')
				});
			} else if (p.indexOf('getBoundProfilePackage') >= 0) {
				body = JSON.stringify({ boundProfilePackage: Euicc.hexToBase64(BPP_BODY) });
			} else if (p.indexOf('handleNotification') >= 0) {
				return Promise.resolve({ success: true, status: 204, body: '' });
			}
			return Promise.resolve({ success: true, status: 200, body: body });
		}
	};
}

function notifListEmpty() {
	/* BF28 A0（一个 BF2F 都没有） */
	return Euicc.tlvHex('BF28', Euicc.tlvHex('A0', ''));
}

asyncTests.push((function () {
	const card = makeCard({ notifList: notifListEmpty() });
	const srv = makeServer();
	const steps = [];
	return Euicc.downloadProfile(card.send, srv.es9p, {
		activation: { smdp: 'rsp.example.com', matchingId: 'ABC' },
		onStep: function (n, t) { steps.push(n + ':' + t); }
	}).then(function (r) {
		eq('下载成功回传 transactionId', r.transactionId, 'TX-1');
		eq('★ 全程只开一次逻辑通道（修复前会开两次）', card.state.opens, 1);
		eq('通道最终被关闭', card.state.closes, 1);
		eq('ES9+ 三次调用按序打到正确主机', srv.state.calls.map(function (c) { return c.host; }),
			['rsp.example.com', 'rsp.example.com', 'rsp.example.com']);
		eq('initiateAuthentication 带 euiccChallenge(base64)',
			JSON.parse(srv.state.calls[0].json).euiccChallenge,
			Euicc.hexToBase64(CHALLENGE));
		eq('initiateAuthentication 带 euiccInfo1(base64)',
			JSON.parse(srv.state.calls[0].json).euiccInfo1,
			Euicc.hexToBase64('BF2003010203'));
		eq('authenticateClient 带 transactionId',
			JSON.parse(srv.state.calls[1].json).transactionId, 'TX-1');
		eq('getBoundProfilePackage 带 transactionId',
			JSON.parse(srv.state.calls[2].json).transactionId, 'TX-1');
		/* ★ 分段后每段是一条独立命令，块数 = 各段块数之和（不再等于「整包块数」） */
		const bppSegs = Euicc.splitBoundProfilePackage(BPP_BODY);
		let expectBlocks = 0;
		bppSegs.forEach(function (s) {
			expectBlocks += Euicc.buildEs10bRawChunks(CH, s.hex, 120).length;
		});
		ok('★ BPP 被切成多段（不是整包连发）', bppSegs.length >= 5,
			'段数 ' + bppSegs.length);
		eq('BPP 按结构分段后分块下发完', card.state.bppChunks, expectBlocks);
		eq('第一段确实带 BF36 头', card.state.cmds.some(function (c) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(c);
			return mm && mm[1].substr(10, 4) === 'BF36';
		}), true);
		eq('★ 不再把整包再套一层 BF36（旧 bug：BF36 里又套 BF36）',
			bppSegs.filter(function (s) { return s.hex.indexOf('BF36') === 0; }).length, 1);
		ok('步骤推进到「完成」', steps[steps.length - 1].indexOf('10:') === 0,
			steps.join(' | '));
		eq('无待发回执时 sent=0', r.notification.sent, 0);
	});
})());

/* 失败路径：服务器 500 —— 绝不能当成功 */
asyncTests.push((function () {
	const card = makeCard();
	const srv = makeServer({ httpFail: 'initiateAuthentication' });
	return threw('SM-DP+ 返回 500 必须抛 EUICC_ES9P_FAILED（禁止假成功）', function () {
		return Euicc.downloadProfile(card.send, srv.es9p, {
			activation: { smdp: 'rsp.example.com' }
		});
	}, 'EUICC_ES9P_FAILED').then(function () {
		eq('失败后通道依然被关（不泄漏）', card.state.closes, 1);
	});
})());

/* 失败路径：卡在 PrepareDownload 拒绝 */
asyncTests.push((function () {
	const card = makeCard({ prepareSw: '6985' });   /* 条件不满足 */
	const srv = makeServer();
	return threw('卡返回 6985 必须抛 EUICC_OP_FAILED', function () {
		return Euicc.downloadProfile(card.send, srv.es9p, {
			activation: { smdp: 'rsp.example.com' }
		});
	}, 'EUICC_OP_FAILED');
})());

/* 失败路径：没有 ES9+ 通道（老固件没刷 ucode） */
asyncTests.push(threw('缺 es9p 通道抛 EUICC_NO_ES9P', function () {
	return Euicc.downloadProfile(makeCard().send, null, {
		activation: { smdp: 'rsp.example.com' }
	});
}, 'EUICC_NO_ES9P'));

/* 失败路径：没填 SM-DP+ */
asyncTests.push(threw('缺 SM-DP+ 地址抛 EUICC_BAD_APDU', function () {
	return Euicc.downloadProfile(makeCard().send, makeServer().es9p, { activation: {} });
}, 'EUICC_BAD_APDU'));

/* ---------- 10. 回执处理 ---------- */

function notifListOne() {
	const item = Euicc.tlvHex('80', '01') + Euicc.tlvHex('81', '00')
		+ Euicc.tlvHex('0C', toHex('rsp.example.com'));
	return Euicc.tlvHex('BF28', Euicc.tlvHex('A0', Euicc.tlvHex('BF2F', item)));
}

eq('parseNotifications 抽序号/操作/地址', (function () {
	const n = Euicc.parseNotifications(notifListOne());
	return [n.length, n[0].seqHex, n[0].operation, n[0].address];
})(), [1, '01', '00', 'rsp.example.com']);
eq('parseNotifications 空列表', Euicc.parseNotifications(notifListEmpty()).length, 0);
eq('parseNotifications 空输入不抛', Euicc.parseNotifications('').length, 0);

asyncTests.push((function () {
	const card = makeCard({ notifList: notifListOne() });
	const srv = makeServer();
	return Euicc.processNotifications(card.send, srv.es9p, { host: 'rsp.example.com' })
		.then(function (r) {
			eq('回执：1 条待发 → 发 1 条', [r.sent, r.total], [1, 1]);
			eq('回执发出后从卡上删除', card.state.removed, true);
			eq('handleNotification 打到 handleNotification 端点',
				srv.state.calls[0].path, '/gsma/rsp2/es9plus/handleNotification');
			eq('pendingNotification 是 base64 的 DER',
				typeof JSON.parse(srv.state.calls[0].json).pendingNotification, 'string');
			eq('补发回执也只开一次通道', card.state.opens, 1);
		});
})());

asyncTests.push((function () {
	/* 通知里自带 SM-DP+ 地址（0C）时，即使调用方给的 host 不一样也以通知为准 */
	const card = makeCard({ notifList: notifListOne() });
	const srv = makeServer();
	return Euicc.processNotifications(card.send, srv.es9p, { host: 'wrong.example.com' })
		.then(function (r) {
			eq('回执按通知自带的地址发（不盲信调用方 host）',
				srv.state.calls[0].host, 'rsp.example.com');
			eq('且只发一条', [r.sent, r.total], [1, 1]);
		});
})());

asyncTests.push(threw('回执：无 ES9+ 通道抛 EUICC_NO_ES9P', function () {
	return Euicc.processNotifications(makeCard({ notifList: notifListOne() }).send, null, { host: 'rsp.example.com' });
}, 'EUICC_NO_ES9P'));

asyncTests.push((function () {
	const card = makeCard({ notifList: notifListOne() });
	const srv = makeServer({ httpFail: 'handleNotification' });
	return threw('回执被服务器拒（HTTP 500）抛 EUICC_ES9P_FAILED', function () {
		return Euicc.processNotifications(card.send, srv.es9p, { host: 'rsp.example.com' });
	}, 'EUICC_ES9P_FAILED').then(function () {
		eq('回执失败不应删除卡上记录（下次还能补发）', card.state.removed, undefined);
	});
})());

/* ---------- 11. 异常 code 集合仍固定 ---------- */

ok('新增的 EUICC_NO_ES9P / EUICC_ES9P_FAILED 已在 ERR_CODES 里',
	Euicc.ERR_CODES.indexOf('EUICC_NO_ES9P') >= 0 && Euicc.ERR_CODES.indexOf('EUICC_ES9P_FAILED') >= 0);

/* ---------- 12. 写卡中途「模组无响应」的续传（2026-09-20 真机 bug） ---------- */

/*
 * 真机现象：进度条一路在动，走到某一块突然
 *   「下载失败：AT 服务未就绪：模组无响应（已等待 2000ms，收到 4 行不完整数据）」。
 *
 * 根因是 APDU 透传命令的耗时由**卡片**决定（写卡时卡侧做密钥运算与非易失写入），
 * 后端却一律按普通命令的 2 秒预算等；超时后 pending 被清空，卡迟到的回执被当成
 * 主动上报丢掉，整包就此作废 —— 而卡其实多半已经把那一块吃下去了。
 *
 * 两条防线：
 *   ① 后端给 APDU 类命令独立的应答预算（Rust APDU_TIMEOUT，见 atclient）；
 *   ② 万一还是超时，前端发一条**只读** GET RESPONSE 把回执补回来（recoverAfterTimeout）。
 *
 * 本节钉死第 ② 条。注意它只认 6F00（「卡上没有待取数据」）为「已消费」，
 * 6E00 / 6A86 这类真错误必须照旧上抛 —— 把错误当成功比直接失败更糟。
 */

/* 按顺序应答的 mock send；null 表示「模组无响应」超时 */
function seqSend(answers) {
	let i = 0;
	return function () {
		const a = answers[Math.min(i, answers.length - 1)];
		i++;
		if (a === null) {
			return Promise.resolve({
				success: false,
				error: '模组无响应（已等待 2000ms，收到 4 行不完整数据）: AT+CSIM=20,"80C0000000"'
			});
		}
		return Promise.resolve({ success: true, data: csimAnswer(a) });
	};
}

Euicc.setTransport('csim');

/* 12.1 超时判定：只有「没等到结束码」这一类才续传 */
ok('isAtTimeoutError 认「模组无响应（已等待 Nms，收到 M 行不完整数据）」',
	Euicc.isAtTimeoutError({
		code: 'EUICC_AT_ERROR',
		message: 'AT 服务未就绪：模组无响应（已等待 2000ms，收到 4 行不完整数据）: AT+CGLA=1,20,"81E2"'
	}) === true);
ok('isAtTimeoutError 不认「未连接到调制解调器」（那是另一回事，续传会盖住病因）',
	Euicc.isAtTimeoutError({ code: 'EUICC_AT_ERROR', message: 'AT 服务未就绪：未连接到调制解调器' }) === false);
ok('isAtTimeoutError 不认非 EUICC_AT_ERROR（卡片状态码不能被当成超时）',
	Euicc.isAtTimeoutError({ code: 'EUICC_OP_FAILED', message: '模组无响应' }) === false);
ok('isAtTimeoutError 对空值不抛异常', Euicc.isAtTimeoutError(null) === false);

/* 12.2 卡上已无待取数据（6F00）→ 按已写入处理，但必须写进日志 */
asyncTests.push((function () {
	const logs = [];
	return Euicc.recoverAfterTimeout(seqSend(['6F00']), 1, 1, function (s) { logs.push(s); })
		.then(function (r) {
			eq('补取 6F00：按已写入处理（sw 归一为 9000）', r.sw, '9000');
			eq('补取 6F00：结果标记为 recovered', r.recovered, true);
			ok('补取 6F00：必须把「未收到应答」写进日志（不许假装什么都没发生）',
				logs.length > 0 && String(logs[0]).indexOf('6F00') >= 0,
				'日志实际: ' + JSON.stringify(logs));
		});
})());

/* 12.3 卡上还有数据 → 自动取余，返回的就是这一块真实的响应 */
asyncTests.push((function () {
	return Euicc.recoverAfterTimeout(seqSend(['6105', 'AABBCCDDEE9000']), 1, 1, function () { })
		.then(function (r) {
			eq('补取 61xx：自动取余后返回完整数据', r.data.toUpperCase(), 'AABBCCDDEE');
			eq('补取 61xx：最终 SW', r.sw, '9000');
		});
})());

/* 12.4 卡回真错误（6E00：CLA 不被接受）→ 照旧上抛，绝不当成功 */
asyncTests.push(threw('补取遇到 6E00 必须如实抛错（不能当「已写入」）', function () {
	return Euicc.recoverAfterTimeout(seqSend(['6E00']), 1, 1, function () { })
		.then(function (r) {
			throw new Error('不该走到这里，实际返回 ' + JSON.stringify(r));
		});
}, null));

/* 12.5 补取自己也一直超时 → 最多两次，之后明确报错 */
asyncTests.push(Euicc.recoverAfterTimeout(seqSend([null]), 1, 1, function () { })
	.then(function (r) {
		fails.push('连续超时竟返回成功：' + JSON.stringify(r));
	}, function (e) {
		eq('补取连续超时：抛 EUICC_AT_ERROR', e && e.code, 'EUICC_AT_ERROR');
		ok('补取连续超时：文案说明卡片可能已停止响应',
			/停止响应/.test(String(e && e.message || '')), '文案: ' + (e && e.message));
	}));

/* 12.6 静态：写卡分块确实用了续传，且只用在写卡这一步 */
const writeLoop = src.slice(src.indexOf('var chain = Promise.resolve'), src.indexOf('return chain.then'));
ok('写卡分块超时后先补取而不是直接作废整包',
	/sendApdu\(c\)\.catch\(function \(e\) \{[\s\S]{0,200}isAtTimeoutError\(e\)[\s\S]{0,300}recoverAfterTimeout\(send, ch, 1, log\)/.test(writeLoop),
	'写卡循环里没有补取分支，超时仍会整包作废');
ok('补取结果在日志里标「补取」（用户能看出这一块不是正常回执）',
	/r\.recovered \? '（补取）' : ''/.test(writeLoop),
	'补取回来的结果和普通结果长得一样，排查时无法区分');
ok('makeSwError 挂了 e.sw（6F00 判定靠它，靠字符串匹配 message 太脆）',
	/e\.sw = sw;/.test(src), 'makeSwError 没挂 e.sw');
/*
 * 「只用在写卡这一步」：外部调用点恰好 1 处。
 * 函数体内还有一次递归（attempt+1），所以不能数函数名出现的总次数。
 */
ok('续传只在写卡分块启用（外部调用点恰好 1 处，鉴权步骤不得猜）',
	src.split('recoverAfterTimeout(send, ch, 1,').length - 1 === 1,
	'外部调用点 ' + (src.split('recoverAfterTimeout(send, ch, 1,').length - 1) + ' 处（期望 1）');
/* 反向：拆掉补取后，同一检查必须判红（split/join 全局替换，只换第一处会恒绿） */
const noRecover = src.split('recoverAfterTimeout(send, ch, 1, log)').join('Promise.reject(e)');
ok('反向：把补取换回「直接失败」后，写卡循环里的补取检查必须判红',
	!/isAtTimeoutError\(e\)[\s\S]{0,300}recoverAfterTimeout\(send, ch, 1, log\)/
		.test(noRecover.slice(noRecover.indexOf('var chain = Promise.resolve'),
			noRecover.indexOf('return chain.then'))),
	'拆掉补取后仍判为通过，检查无效');
ok('反向：拆掉补取后外部调用点计数必须归零（防止有人用注释/字符串绕过计数）',
	noRecover.split('recoverAfterTimeout(send, ch, 1,').length - 1 === 0,
	'拆掉后仍有 ' + (noRecover.split('recoverAfterTimeout(send, ch, 1,').length - 1) + ' 处调用');

/* ---------- 汇总 ---------- */

Promise.all(asyncTests).then(function () {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	if (fails.length) {
		console.log('');
		fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
		process.exit(1);
	}
	console.log('euicc.js 下载链路契约测试全部通过');
}).catch(function (e) {
	console.error('异步用例异常：' + (e && e.stack || e));
	process.exit(1);
});
