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

eq('buildEs10b 组装：CLA/INS/Lc/Le 全对', (function () {
	const apdu = Euicc.buildEs10b(1, 'BF2E', '');
	return [apdu, apdu.length];
})(), ['80E2910003BF2E0000'.replace('80E2910003', '81E2910003'), 18]);
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
eq('分片可原样拼回整条 TLV', chunks.map(function (c) { return c.substr(10, c.length - 12); }).join(''),
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
const BPP_BODY = 'AA'.repeat(400);

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
		eq('BPP 按 BF36 分块下发完（块数 = 分块函数算出的块数）',
			card.state.bppChunks, Euicc.buildEs10bChunks(CH, 'BF36', BPP_BODY, 120).length);
		eq('第一块确实带 BF36 头', card.state.cmds.some(function (c) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(c);
			return mm && mm[1].substr(10, 4) === 'BF36';
		}), true);
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
