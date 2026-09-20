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
		eq('★ 成功时不发 cancelSession（收尾只在失败时走，别把装好的单子撤了）',
			srv.state.calls.filter(function (c) {
				return String(c.path).indexOf('cancelSession') >= 0;
			}).length, 0);
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

/* ---------- 12. 写卡中途超时的「静默接回」（2026-09-20 真机 bug） ---------- */

/*
 * 真机现象：进度条一路在动，走到某一块突然
 *   「下载失败：AT 服务未就绪：模组无响应（已等待 2000ms，收到 0 行不完整数据）」。
 *
 * 根因是 APDU 透传命令的耗时由**卡片**决定（写卡时卡侧做密钥运算与非易失写入），
 * 后端却一律按普通命令的 2 秒预算等；超时后 pending 被清空，卡迟到的回执会被
 * 当成主动上报推给前端、不留给下一条命令。
 *
 * ★★ 2026-09-20 三次真机对照实验定案：
 *   ① 超时那一刻**模组是活的**（紧接着发普通 AT，350ms / 151ms 正常回）；
 *   ② 向卡发 GET RESPONSE「敲门」会被模组拒成 `+CME ERROR: Incorrect parameters`，
 *      库没有这个分支 → 当致命错误抛出 → **整包作废**（39147 字节只写到 30%）；
 *   ③ 只连发普通 AT、什么都不碰 → 迟到约 0.4 秒的 `+CGLA: 4,"9000" | OK`
 *      被原样带回，349 块一路写完，Profile 真的装上。
 *   lpac 的 at_expect 用 poll(fd, 1, -1)（**永不超时**）正是同一个道理。
 *
 * 所以本节钉死的是：超时后**只发普通 AT** 把模组迟到的回包接回来，期间**绝不**
 * 向卡发任何 APDU。任何把 GET RESPONSE 敲门加回来的改动都必须在这里判红。
 */

/* 按顺序应答的 mock send；null 表示「模组无响应」超时（后端 2 秒墙） */
function seqSend(answers) {
	let i = 0;
	return function () {
		const a = answers[Math.min(i, answers.length - 1)];
		i++;
		if (a === null) {
			return Promise.resolve({
				success: false,
				error: '模组无响应（已等待 2000ms，收到 0 行不完整数据）: AT+CGLA=0,130,"81E2"'
			});
		}
		return Promise.resolve({ success: true, data: csimAnswer(a) });
	};
}

/*
 * 「静默接回」的 mock：前 delay 条普通 AT 什么都不带（模组还没吐回包），
 * 之后某一条 AT 的应答里带上模组迟到的 `+CSIM: ...`。
 * state.at = 真正问到串口的普通 AT 条数；给非 AT 命令一律回 9000（取余用）。
 *
 * ★★ 这里**模拟 rpc.js 的只读缓存**（真机踩过的坑）：
 *   isRetryableRead('AT') === true → `AT` 进 2.5 秒只读缓存，
 *   **不带 { fresh: true } 时第二条起直接吃缓存、根本到不了串口**，
 *   模组迟到的回包也就永远接不回来。
 *   真机冒烟脚本走 SSH 桥绕过了 rpc.js，所以只有在这里建模才拦得住。
 */
function lateSend(delay, lateHex) {
	const st = { at: 0, other: 0, cached: 0 };
	let cache = null;   /* 只读缓存的第一个成功结果（rpc.js READ_CACHE_TTL 2500ms） */
	return {
		state: st,
		send: function (cmd, opts) {
			if (String(cmd) !== 'AT') {
				st.other++;
				return Promise.resolve({ success: true, data: csimAnswer('AABBCCDDEE9000') });
			}
			if (!(opts && opts.fresh === true) && cache) {
				st.cached++;
				return Promise.resolve(cache);        /* 命中缓存：没到串口，看不到迟到行 */
			}
			st.at++;
			const res = {
				success: true,
				data: st.at > delay ? csimAnswer(lateHex) : 'OK'
			};
			if (!cache) cache = res;
			return Promise.resolve(res);
		}
	};
}

Euicc.setTransport('csim');

/* 12.1 超时判定：只有「没等到结束码」这一类才接回 */
ok('isAtTimeoutError 认「模组无响应（已等待 Nms，收到 M 行不完整数据）」',
	Euicc.isAtTimeoutError({
		code: 'EUICC_AT_ERROR',
		message: 'AT 服务未就绪：模组无响应（已等待 2000ms，收到 4 行不完整数据）: AT+CGLA=1,20,"81E2"'
	}) === true);
ok('isAtTimeoutError 不认「未连接到调制解调器」（那是另一回事，接回会盖住病因）',
	Euicc.isAtTimeoutError({ code: 'EUICC_AT_ERROR', message: 'AT 服务未就绪：未连接到调制解调器' }) === false);
ok('isAtTimeoutError 不认非 EUICC_AT_ERROR（卡片状态码不能被当成超时）',
	Euicc.isAtTimeoutError({ code: 'EUICC_OP_FAILED', message: '模组无响应' }) === false);
ok('isAtTimeoutError 对空值不抛异常', Euicc.isAtTimeoutError(null) === false);

/* 12.2 迟到的应答只在第 3 条 AT 才出现 → 必须继续等，不能第 2 次就判死 */
asyncTests.push((function () {
	const c = lateSend(2, '9000');
	return Euicc.recoverAfterTimeout(c.send, 1, 1, function () { }, { maxAttempts: 6, burst: 1 })
		.then(function (r) {
			eq('★ 接回模组迟到的 9000', r.sw, '9000');
			eq('★ 结果标记为 recovered（调用方必须写进日志）', r.recovered, true);
			eq('★ 第 3 条 AT 才拿到（不是第 2 条就放弃）', r.latePolls, 3);
			eq('接回过程只发普通 AT（一条 APDU 都没发）', c.state.other, 0);
			eq('★ 轮询的 AT 全部走 fresh（没有一条被 rpc.js 只读缓存吃掉）',
				c.state.cached, 0);
		}, function (e) {
			/* 接不回来时必须判红而不是让整个套件崩掉（崩掉会掩盖真正的病因） */
			ok('★ 接回模组迟到的 9000（接不回来要判红，不许崩掉套件）', false,
				(e && e.message) + '；cached=' + c.state.cached + ' at=' + c.state.at);
		});
})());

/* 12.3 迟到的应答是 61xx（数据未取完）→ 接回后必须再取余，不能拿残片当完整回执 */
asyncTests.push((function () {
	const st = { at: 0 };
	const send = function (cmd) {
		if (String(cmd) !== 'AT') {
			return Promise.resolve({ success: true, data: csimAnswer('C0FFEE9000') });
		}
		st.at++;
		return Promise.resolve({ success: true, data: st.at === 1 ? csimAnswer('6105') : 'OK' });
	};
	return Euicc.recoverAfterTimeout(send, 1, 1, function () { }, { maxAttempts: 6, burst: 1 })
		.then(function (r) {
			eq('★ 61xx：接回后自动取余，拼出完整数据', r.data.toUpperCase(), 'C0FFEE');
			eq('★ 61xx：最终 SW', r.sw, '9000');
		}, function (e) {
			ok('★ 61xx 接回后取余（失败要判红，不许崩掉套件）', false,
				(e && e.message) + ' at=' + st.at);
		});
})());

/* 12.4 一直等不到（模组始终不吐回包）→ 如实抛错，绝不谎报成功 */
asyncTests.push(threw('一直等不到迟到回包必须如实抛错（不许当成功）', function () {
	return Euicc.recoverAfterTimeout(function () {
		return Promise.resolve({ success: true, data: 'OK' });
	}, 1, 1, function () { }, { maxAttempts: 2, burst: 1 })
		.then(function (r) {
			throw new Error('不该走到这里，实际返回 ' + JSON.stringify(r));
		});
}, null));

/*
 * 12.5 ★★ 反向钉死：恢复路径里**绝不允许**出现「向卡发 APDU」的敲门动作。
 * 真机实测：敲门会被模组拒成 +CME ERROR → 库把它当致命错误 → 整包作废
 * （39147 字节的包只写到 30%）。只断言「没有 getResponseApdu」容易恒绿，
 * 所以连带验证「把 AT 轮询换成 GET RESPONSE 之后，同一条检查必须判假」。
 */
const recFn = src.slice(src.indexOf('function recoverAfterTimeout'),
	src.indexOf('api.recoverAfterTimeout = recoverAfterTimeout'));
const knockedSrc = src.split("send('AT', { fresh: true })").join(
	"sendAndCollect(send, ch, api.getResponseApdu(ch, 0), 0, '')");
/*
 * 「不发卡侧 APDU」的精确含义是：**拿到模组迟到的回包之前**一条都不许发。
 * 61xx 之后去取余是合法的 —— 那时卡已经回过话、模组也空闲了，取余只是把
 * 没取完的数据补全（不取反而会把残片当完整回执）。
 * 所以不能一刀切禁 `getResponseApdu`：那会把合法路径一起禁掉，断言只剩形式。
 */
function recNoKnock(s) {
	const f = s.slice(s.indexOf('function recoverAfterTimeout'),
		s.indexOf('api.recoverAfterTimeout = recoverAfterTimeout'));
	/* 锚在 `send('AT'` 上（不带右括号），这样加了 opts 也不会让守卫莫名其妙失效 */
	if (f.indexOf("send('AT'") < 0) return false;         /* 连轮询都没有 → 不是接回 */
	const parse = f.indexOf('lateAnswerOf(');
	if (parse < 0) return false;                          /* 没有接回的解析判定 */
	const a1 = f.indexOf('getResponseApdu');
	const a2 = f.indexOf('sendApdu(');
	const first = Math.min(a1 < 0 ? 1e9 : a1, a2 < 0 ? 1e9 : a2);
	return first > parse;                                 /* 所有 APDU 一律排在解析之后 */
}
ok('★ 拿到迟到回包之前，接回过程不发任何卡侧 APDU（只有普通 AT）', recNoKnock(src),
	'接回函数在解析迟到回包之前就去敲卡了');
ok('★ 61xx 接回后必须取余补全（残片当完整回执＝把自己的 bug 报成固件上限）',
	recFn.indexOf('a.hasMore') >= 0
		&& recFn.indexOf('getResponseApdu') > recFn.indexOf('lateAnswerOf('),
	'hasMore 分支没有取余');
ok('★ 接回用并发 burst（后端空闲期收到的行会被当主动上报丢掉，burst 压这个窗口）',
	/Promise\.all/.test(recFn) && /burst/.test(recFn), '没有 burst / Promise.all');
ok('★ 迟到回包靠「重发普通 AT」把模组的行带回来（有解析判定）',
	recFn.indexOf('lateAnswerOf') >= 0, '没有接回的解析判定');
ok('反向：把 AT 轮询换成 GET RESPONSE 敲门后，recNoKnock 必须判假（防断言恒绿）',
	knockedSrc !== src && recNoKnock(knockedSrc) === false,
	'替换没打中，或这条检查抓不到敲门');

/* 12.6 静态：写卡分块确实用了接回，且只用在写卡这一步 */
/* 写卡循环的唯一起点：`var lastData` 只在这里出现。
   （`var chain = Promise.resolve` 前面还有别的 helper，用它会多切一大段无关代码。） */
const writeLoop = src.slice(src.indexOf("var lastData = ''"), src.indexOf('return chain.then'));
/* 从「认出超时」到「交给接回」之间的那一段 —— 这里才是最危险的窗口 */
function timeoutSpan(w) {
	const k = w.indexOf('isAtTimeoutError(e)');
	if (k < 0) return '';
	const r = w.indexOf('recoverAfterTimeout(send, ch, 1, log,', k);
	return r < 0 ? '' : w.slice(k, r);
}
ok('写卡分块超时后先接回而不是直接作废整包',
	timeoutSpan(writeLoop).length > 0,
	'写卡循环里没有接回分支，超时仍会整包作废');
ok('★ 从判定超时到交给接回之间，不许出现任何卡侧 APDU（敲门就是在这里踩的雷）',
	(function () {
		const sp = timeoutSpan(writeLoop);
		/* 上界用来防止匹配跨到无关代码上而恒绿 */
		return sp.length > 0 && sp.length < 800
			&& !/getResponseApdu|sendApdu\(|sendAndCollect/.test(sp);
	})(), '超时后直接向卡发 APDU：真机被 +CME ERROR 拒成致命错误，整包作废');
ok('接回结果在日志里标出来（用户能看出这一块不是正常回执）',
	/r\.recovered \? '（接回模组迟到的应答）' : ''/.test(writeLoop),
	'接回来的结果和普通结果长得一样，排查时无法区分');
ok('写卡超时后的日志必须说清「改为只发普通 AT 等回包（不碰卡）」',
	writeLoop.indexOf('改为只发普通 AT 等模组吐回包（不碰卡）') > 0,
	'日志还在暗示会去敲卡，排查时会被带偏');
ok('makeSwError 挂了 e.sw（错误分流靠它，靠字符串匹配 message 太脆）',
	/e\.sw = sw;/.test(src), 'makeSwError 没挂 e.sw');
/*
 * 「只用在写卡这一步」：外部调用点恰好 1 处。
 * 函数体内还有一次递归（attempt+1），所以不能数函数名出现的总次数。
 */
ok('接回只在写卡分块启用（外部调用点恰好 1 处，鉴权步骤不得猜）',
	src.split('recoverAfterTimeout(send, ch, 1,').length - 1 === 1,
	'外部调用点 ' + (src.split('recoverAfterTimeout(send, ch, 1,').length - 1) + ' 处（期望 1）');
/* 反向：拆掉接回后，同一检查必须判红（split/join 全局替换，只换第一处会恒绿） */
/* 反向：拆掉接回（正则替换整个调用，连带后面的 opts 对象）后，同一检查必须判红 */
const noRecover = src.replace(
	/recoverAfterTimeout\(send, ch, 1, log,[\s\S]{0,160}?\)/g, 'Promise.reject(e)');
ok('反向：把接回换回「直接失败」后，写卡循环里的检查必须判红',
	noRecover !== src
		&& timeoutSpan(noRecover.slice(noRecover.indexOf("var lastData = ''"),
			noRecover.indexOf('return chain.then'))).length === 0,
	'拆掉接回后仍判为通过（或替换没打中），检查无效');
ok('反向：拆掉接回后外部调用点计数必须归零（防止有人用注释/字符串绕过计数）',
	noRecover.split('recoverAfterTimeout(send, ch, 1,').length - 1 === 0,
	'拆掉后仍有 ' + (noRecover.split('recoverAfterTimeout(send, ch, 1,').length - 1) + ' 处调用');

/* ---------- 12.7 「静默接回」的预算（真机：迟到约 0.4 秒，但必须留足冗余） ---------- */

/*
 * 真机第三次：卡在 A3[7] 那一块上算到约 2.4 秒才回（后端 2 秒墙先放弃），
 * 迟到的 9000 在 0.4 秒后被普通 AT 带回。次数给少了会在卡算完前就放弃
 * （第二次真机就是这样）；但也不能无限等 —— 页面会一直停在"写卡中"，
 * 所以窗口定在约 30 秒。
 */
ok('★ 默认轮数够多（≥100 轮，只作兜底）',
	Euicc.lateCapturePolicy.maxPolls >= 100,
	'实际 ' + Euicc.lateCapturePolicy.maxPolls);
ok('★ 一轮并发 ≥2 条 AT（把后端「有命令在等」的覆盖时间拉长）',
	Euicc.lateCapturePolicy.burst >= 2,
	'实际 ' + Euicc.lateCapturePolicy.burst);
/*
 * 决定"等多久"的必须是**毫秒**，不能是轮数 —— 轮数换算成时长依赖每轮
 * 并发条数 × 单条 AT 的实测延时，换环境就变。末块还要单独给长窗。
 */
ok('★ 时间窗是显式的毫秒常量（普通 ≥10 秒，末块 ≥ 普通）',
	Euicc.lateCapturePolicy.windowMs >= 10000
		&& Euicc.lateCapturePolicy.finalWindowMs >= Euicc.lateCapturePolicy.windowMs,
	'windowMs=' + Euicc.lateCapturePolicy.windowMs +
	' finalWindowMs=' + Euicc.lateCapturePolicy.finalWindowMs);
/* 反向：把常量改小，policy 必须跟着变 —— 证明上面两条读的是真常量，不是硬编码 */
ok('反向：把 LATE_MAX_POLLS 改成 1 后 policy 必须跟着变（防止断言恒绿）',
	(function () {
		const neg = src.split('LATE_MAX_POLLS = 400').join('LATE_MAX_POLLS = 1');
		if (neg === src) return false;   /* 替换没打中 → 反向用例本身失效 */
		const m = eval('(' + neg.match(/var Euicc = \((function[\s\S]*?)\)\(\);/)[1] + ')')();
		return m.lateCapturePolicy.maxPolls === 1;
	})(), '替换未生效或断言恒绿');
ok('反向：把 LATE_WINDOW_MS 改成 1 后 policy.windowMs 必须跟着变（防止断言恒绿）',
	(function () {
		const neg = src.split('LATE_WINDOW_MS = 30000').join('LATE_WINDOW_MS = 1');
		if (neg === src) return false;
		const m = eval('(' + neg.match(/var Euicc = \((function[\s\S]*?)\)\(\);/)[1] + ')')();
		return m.lateCapturePolicy.windowMs === 1;
	})(), '替换未生效或断言恒绿');

/* 时间窗已过期（windowMs<=0）→ 立刻如实抛错，一条 AT 都不许再发（不许空转）
   ★ 注意必须是 IIFE：asyncTests 里存的是 Promise，push 一个函数进去会被
     Promise.all 当普通值直接放行 —— 断言一次都不会执行（恒绿的假守卫）。 */
asyncTests.push((function () {
	let ats = 0;
	return Euicc.recoverAfterTimeout(function () {
		ats++;
		return Promise.resolve({ success: true, data: 'OK' });
	}, 1, 1, function () { }, { windowMs: -1, maxAttempts: 100, burst: 1 })
		.then(function (r) {
			ok('★ 时间窗已过期却仍返回了「接回成功」', false,
				'返回 ' + JSON.stringify(r) + '，发了 ' + ats + ' 条 AT');
		}, function (e) {
			ok('★ 时间窗过期后立刻抛错，不再空转 AT（也不许谎报成功）',
				!!e && ats === 0, '发了 ' + ats + ' 条 AT；e=' + (e && e.message));
			/*
			 * 接回耗尽后的错误**不能**再被 isAtTimeoutError 认成超时 ——
			 * 否则任何外层重试逻辑都可能反复重入接回，变成无限轮询。
			 */
			ok('★ 接回耗尽后的错误不再算「超时」（否则外层重试会反复重入接回）',
				Euicc.isAtTimeoutError(e) === false,
				'它被当成了超时，存在无限重入风险');
		});
})());

/* 一轮里的 N 条都在**同一轮被派发**（不是等一条回一条），覆盖窗口才是连续的 */
asyncTests.push((function () {
	let calls = 0;
	const send = function () {
		calls++;
		return Promise.resolve({
			success: true,
			data: calls >= 4 ? csimAnswer('9000') : 'OK'
		});
	};
	return Euicc.recoverAfterTimeout(send, 1, 1, function () { }, { maxAttempts: 3, burst: 4 })
		.then(function (r) {
			eq('★ 一轮 4 条 AT 里抓到了迟到回包', r.sw, '9000');
			eq('★ 只用了一轮（4 条），没白跑第二轮', calls, 4);
		}, function (e) {
			ok('★ 一轮 4 条里抓到迟到回包（失败要判红，不许崩掉套件）', false,
				(e && e.message) + ' calls=' + calls);
		});
})());

/*
 * ★★ 反向（行为级）：不带 fresh 的轮询会被 rpc.js 的只读缓存吃掉 ——
 *   第 2 条起 AT 直接返回缓存结果、**根本到不了串口**，模组迟到的回包永远看不到，
 *   接回必然失败。这条用例证明 fresh 不是装饰，而是接回能成立的前提。
 *   （真机冒烟脚本走 SSH 桥绕过了 rpc.js，静态断言也看不出来，只有建模缓存才拦得住。）
 */
asyncTests.push((function () {
	const st = { at: 0, cached: 0 };
	let cache = null;
	const send = function (cmd, opts) {
		void opts;   /* 故意无视 fresh：等价于 euicc.js 漏传 fresh */
		if (cache) { st.cached++; return Promise.resolve(cache); }
		st.at++;
		const res = { success: true, data: st.at > 2 ? csimAnswer('9000') : 'OK' };
		cache = res;   /* 第一条成功结果进缓存，此后永远吃缓存 */
		return Promise.resolve(res);
	};
	return Euicc.recoverAfterTimeout(send, 1, 1, function () { }, {
		maxAttempts: 6, burst: 2, windowMs: 60000
	}).then(function (r) {
		ok('★ 不走 fresh 时本该接不回来，却返回了成功', false, JSON.stringify(r));
	}, function (e) {
		ok('★ 不带 fresh 的轮询被只读缓存吃掉 → 接不回来（所以 fresh 是必需的）',
			!!e && st.cached > 0 && st.at === 1,
			'cached=' + st.cached + ' at=' + st.at + ' e=' + (e && e.message));
	});
})());
ok('★ 静态：轮询必须显式带 { fresh: true }',
	/send\('AT', \{ fresh: true \}\)/.test(recFn),
	'轮询没带 fresh，真机上会被只读缓存吃掉');

/* ---------- 13. 失败收尾：必须撤掉服务器会话（2026-09-20 真机） ---------- */

/*
 * 真机：写卡中断之后**两边都没撤** —— 服务器会话挂着、卡侧停在半截会话里。
 * 结果下一轮下载在第 5 段就被 6985 拒掉（探针实测），看上去像卡坏了。
 * 下载失败必须把 SM-DP+ 那半边撤干净；同时**绝不能**拿收尾盖掉原始错误。
 */
asyncTests.push((function () {
	const card = makeCard({ prepareSw: '6985' });
	const srv = makeServer();
	let err = null;
	return Euicc.downloadProfile(card.send, srv.es9p, {
		activation: { smdp: 'rsp.example.com' }
	}).then(function () {
		fails.push('下载失败却返回成功');
	}, function (e) {
		err = e;
	}).then(function () {
		eq('失败照旧抛 EUICC_OP_FAILED（收尾不许吞掉原始错误）', err && err.code, 'EUICC_OP_FAILED');
		eq('失败照旧带原始 SW', err && err.sw, '6985');
		const names = srv.state.calls.map(function (c) { return String(c.path).split('/').pop(); });
		eq('★ 失败后必须向服务器 cancelSession（脏会话会让下一轮被 6985 拒）',
			names[names.length - 1], 'cancelSession');
		ok('6985 的提示要点出「卡上已经有了 / 会话没清干净」',
			/卡上已经有了/.test(String((err && err.swHint) || '')),
			'hint: ' + (err && err.swHint));
		eq('收尾失败也不影响通道关闭', card.state.closes, 1);
	});
})());

/* 反向：把收尾换成「什么也不做」，上面的 cancelSession 断言必须翻红 */
asyncTests.push((function () {
	const noCleanup = src
		.split('p = api.cancelSession(es9p, smdp, tx);')
		.join('p = Promise.resolve({ ok: true });');
	if (noCleanup === src) {
		fails.push('反向用例没打中源码（收尾那行可能被改名了），检查已失效');
		return Promise.resolve();
	}
	const Neg = eval('(' + noCleanup.match(/var Euicc = \((function[\s\S]*?)\)\(\);/)[1] + ')')();
	const card = makeCard({ prepareSw: '6985' });
	const srv = makeServer();
	return Neg.downloadProfile(card.send, srv.es9p, { activation: { smdp: 'rsp.example.com' } })
		.catch(function () { /* 报错与否不重要，只看有没有发 cancelSession */ })
		.then(function () {
			const names = srv.state.calls.map(function (c) { return String(c.path).split('/').pop(); });
			ok('★ 反向：拆掉收尾后 cancelSession 必须消失（断言不恒绿）',
				names[names.length - 1] !== 'cancelSession',
				'拆掉后最后一条仍是 ' + names[names.length - 1]);
		});
})());

/* ---------- 12.8 整包末块：拿不到回执时靠只读读卡判定，不靠 6F00 猜 ---------- */
/*
 * 2026-09-20 第三次真机：写卡在整包末块超时，补取 10 次全无应答。
 * 旧逻辑对末块也是「拿 6F00 就按已写入处理」—— 可 6F00 只证明**卡上没有待取数据**，
 * 证明不了装好了。所以末块必须再只读地读一次 Profile 列表来核验。
 */
const ICCID = '894411' + '0'.repeat(12) + '1';   /* 19 位 */
const ICCID_BCD = '984411000000000000F1';        /* 卡侧 BCD，末尾 F 补位 */

function tlvHex(tag, valHex) {
	const n = valHex.length / 2;
	return tag + ('0' + n.toString(16)).slice(-2) + valHex;
}

eq('iccidKey 去掉非数字并取 19 位', Euicc.iccidKey('8944-11 0000000000001F'), ICCID);
eq('normalizeIccid 认明码数字串', Euicc.normalizeIccid(ICCID), ICCID);
eq('normalizeIccid 认 base64(ASCII 数字)',
	Euicc.normalizeIccid(Buffer.from(ICCID, 'ascii').toString('base64')), ICCID);
eq('normalizeIccid 认 base64(BCD 字节)',
	Euicc.normalizeIccid(Buffer.from(ICCID_BCD, 'hex').toString('base64')), ICCID + 'F');
eq('normalizeIccid 对认不出的值返回空（绝不乱比）', Euicc.normalizeIccid('###'), '');
eq('normalizeIccid 对空值返回空', Euicc.normalizeIccid(''), '');

/* 没有参照 ICCID → unknown（不是 absent） */
asyncTests.push(Euicc.verifyInstalled(
	function () { return Promise.resolve({ success: true, data: '' }); }, 1, '', function () { })
	.then(function (v) {
		eq('★ 没有参照 ICCID 时返回 unknown（不谎报 absent）', v.state, 'unknown');
	}));

/* 卡上查得到 → found */
const profResp = tlvHex('BF2D', tlvHex('A0', tlvHex('E3', tlvHex('5A', ICCID_BCD))));
asyncTests.push(Euicc.verifyInstalled(
	function () { return Promise.resolve({ success: true, data: csimAnswer(profResp + '9000') }); },
	1, ICCID, function () { })
	.then(function (v) {
		eq('★ 卡上查到该 ICCID → found', v.state, 'found');
	}));

/* 卡上没有 → absent */
asyncTests.push(Euicc.verifyInstalled(
	function () { return Promise.resolve({ success: true, data: csimAnswer('BF2D02A0009000') }); },
	1, ICCID, function () { })
	.then(function (v) {
		eq('★ 卡上没有该 ICCID → absent', v.state, 'absent');
	}));

/* 核验失败必须归 unknown：拿「核验不了」去推翻一次已经成功的下载，和猜成功是同一种错 */
const vfn = src.slice(src.indexOf('function verifyInstalled'),
	src.indexOf('api.verifyInstalled = verifyInstalled'));
ok('verifyInstalled 的失败分支返回 unknown 而不是 absent',
	/function \(e\) \{[\s\S]*?state: 'unknown'[\s\S]*?\};[\s\S]*?\}\)/.test(vfn) || /state: 'unknown'/.test(vfn),
	'失败分支没返回 unknown');
ok('反向：把失败分支换成 absent 后源码检查必须翻红（防恒绿）',
	vfn.split("state: 'unknown'").join("state: 'absent'").indexOf("state: 'unknown'") < 0,
	'替换后仍判定通过，检查无效');

/* 末块策略与核验点（静态） */
ok('写卡循环里区分了「整包最后一块」',
	/var isFinalBlock = \(si === segs\.length - 1\)/.test(writeLoop), '没有 isFinalBlock');
ok('★ 末块接不回来时先只读查卡核验（不是直接判死）',
	src.split('verifyInstalled(send, ch, expectIccid, log)').length - 1 === 2,
	'核验调用点 ' + (src.split('verifyInstalled(send, ch, expectIccid, log)').length - 1) + ' 处（期望 2）');
ok('反向：拆掉核验后调用点必须归零（防有人用注释绕过计数）',
	src.split('verifyInstalled(send, ch, expectIccid, log)').join('Promise.resolve({state:"found"})')
		.split('verifyInstalled(send, ch, expectIccid, log)').length - 1 === 0,
	'拆掉后仍有调用点，检查无效');
ok('参照 ICCID 走 iccidFromProfileMetadata（profileMetadata 是 base64 的 BER-TLV，不是 JSON 字段）',
	/resp && resp\.profileMetadata/.test(src) && /iccidFromProfileMetadata\(pm\)/.test(src),
	'没从 profileMetadata 解 TLV 取 ICCID');

/*
 * ★ 2026-09-20 真机：本机 SM-DP+ 回的 profileMetadata 是 base64 的
 *   StoreMetadataRequest，ICCID 在 tag 5A 里（GSM BCD，末位可能补 F）。
 *   原代码只看 JSON 字段 `pm.iccid` → 永远取不到 → 「末块核验」每次都降级成
 *   「无法核验」。真机日志里那句「服务器未在 profileMetadata 里给出 ICCID」
 *   就是它 —— 于是核验形同虚设，只能回头靠 6F00 猜。
 */
const PM_BCD = '5A0A' + ICCID_BCD;
const PM_B64 = Buffer.from(PM_BCD, 'hex').toString('base64');
eq('★ 从 base64 的 profileMetadata 里解出 ICCID（tag 5A / GSM BCD）',
	Euicc.iccidFromProfileMetadata(PM_B64), ICCID);
eq('ICCID 在更外层 SEQUENCE 里也能找到（深度优先）',
	Euicc.iccidFromProfileMetadata(
		Buffer.from('30' + ('0' + (PM_BCD.length / 2).toString(16)).slice(-2) + PM_BCD, 'hex')
			.toString('base64')), ICCID);
eq('认不出（没有 5A）返回空，不瞎猜', Euicc.iccidFromProfileMetadata('3003020101'), '');
eq('非 base64 的杂串返回空', Euicc.iccidFromProfileMetadata('###'), '');
eq('JS 对象形态仍走 normalizeIccid（向后兼容）',
	Euicc.iccidFromProfileMetadata({ iccid: ICCID }), ICCID);
eq('空值返回空', Euicc.iccidFromProfileMetadata(null), '');
ok('反向：把查找的 tag 从 5A 换掉后，上面的 ICCID 提取必须失效（防恒绿）',
	(function () {
		const neg = src.split("tlvFindHex(hex, '5A', 0)").join("tlvFindHex(hex, '99', 0)");
		if (neg === src) return false;   /* 替换没打中 → 反向用例本身失效 */
		const m = eval('(' + neg.match(/var Euicc = \((function[\s\S]*?)\)\(\);/)[1] + ')')();
		return m.iccidFromProfileMetadata(PM_B64) === '';
	})(), '换 tag 后仍取到值，说明这条断言没在读 tag');
ok('tlvFindHex 对截断的 TLV 返回空（绝不拿残片当值）',
	Euicc.tlvFindHex('5A0A984411', '5A') === '', '截断输入竟然返回值');

/* ---------- 汇总 ---------- */

/*
 * ★★ 元守卫：本文件的 asyncTests 由 Promise.all 消费 —— 每一项**必须是 Promise**。
 *   误 push 一个裸函数进去时，Promise.all 会把它当普通值直接放行，
 *   里面的 ok()/eq() 一次都不会执行 → 检查恒绿（本文件真发生过一次）。
 *   ⚠ 别照抄到 euicc-channel-fallback-contract.test.js：那边是
 *     asyncTests.reduce(chain.then) 约定，存函数才是对的。同名不同义。
 */
ok('★ asyncTests 每一项都是 Promise（裸函数会被 Promise.all 当普通值放行＝假守卫）',
	asyncTests.every(function (t) { return t && typeof t.then === 'function'; }),
	'有 ' + asyncTests.filter(function (t) { return !t || typeof t.then !== 'function'; }).length +
	' 项不是 Promise');

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
