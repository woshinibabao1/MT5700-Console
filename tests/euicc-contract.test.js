#!/usr/bin/env node
/*
 * eUICC / eSIM 管理契约测试（无需真机，纯 Node 跑，绝不向真机下发任何 AT）
 * ---------------------------------------------------------------------------
 * 用 parse-contract.test.js / air-health-contract.test.js 同款正则把 euicc.js 整段
 * 抠出来在 Node 里真跑，注入 mock send 对拍提案 §1.3 字节表、61xx 取余、6A82 引导态、
 * delete 无 A0 包裹、写操作只发一次（钉 P02/P03/P04/P05/P06/P07/P10/P12）。
 *
 * 运行：node tests/euicc-contract.test.js
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

/* mock send：命令 → 应答。返回 Promise<{success,data}>，绝不触碰真机。 */
function mockSend(map, counter) {
	return function (cmd) {
		if (counter) counter.push(cmd);
		var r = map[cmd];
		if (!r) r = { success: true, data: '' };
		return Promise.resolve(r);
	};
}
function csimAnswer(dataAndSw) {
	/* 直接给引号内的 hex，拼成 +CSIM: N,"..." 形式 */
	var hex = dataAndSw;
	return '+CSIM: ' + hex.length + ',"' + hex + '"';
}

/* 异步用例统一收集，最后 Promise.all 汇总（R11：杜绝 setTimeout 假绿通道） */
var asyncTests = [];

/* ---------- 1. 基础编码 / P02 长度口径 ---------- */

eq('isHex 校验', [Euicc.isHex('00A4'), Euicc.isHex('0'), Euicc.isHex('xy')], [true, false, false]);
eq('hexToBytes 奇偶/非法抛错', (function () {
	try { Euicc.hexToBytes('xyz'); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_HEX');
eq('bytesToHex 大写无分隔', Euicc.bytesToHex(new Uint8Array([0x00, 0xa4, 0x08])), '00A408');
eq('swapNibbles 半字节交换（提案自证样例 9821…↔8912…）',
	Euicc.swapNibbles('98211380007175100017'), '89123108001757010071');
/* P02 核心：长度 = hex 字符数，不是字节数 */
eq('csimCommand 长度是字符数（9 字节→18）',
	Euicc.csimCommand('00A40804047FFF6F07'), 'AT+CSIM=18,"00A40804047FFF6F07"');
eq('parseCsimAnswer 抽取 + 末 4 字符为 SW',
	Euicc.parseCsimAnswer('+CSIM: 6,"019000"'),
	{ data: '01', sw: '9000', hasMore: false, le: 0 });
eq('parseCsimAnswer 61xx → hasMore + le',
	Euicc.parseCsimAnswer('+CSIM: 8,"12346100"'),
	{ data: '1234', sw: '6100', hasMore: true, le: 0 });
eq('parseCsimAnswer 无 +CSIM 行 → null', Euicc.parseCsimAnswer('ERROR'), null);

/* ---------- 2. §1.3 逐字节 APDU 表 ---------- */

eq('① 开逻辑通道', Euicc.openChannelApdu(), '0070000001');
eq('⑩ 关逻辑通道 ch=1', Euicc.closeChannelApdu(1), '0070800100');
eq('② SELECT ISD-R ch=1', Euicc.selectIsdrApdu(1), '01A4040C10' + Euicc.ISDR_AID);
eq('③ GET RESPONSE ch=1 le=0', Euicc.getResponseApdu(1, 0), '81C0000000');
eq('④ GetEID', Euicc.buildGetEid(1), '81E2910006BF3E035C015A00');
eq('⑤ GetProfiles 默认 5 tag', Euicc.buildGetProfiles(1), '81E291000BBF2D085C055A4F9F70909100');
eq('⑤ GetProfiles 自定义 3 tag（9F70 计 2 字节）',
	Euicc.buildGetProfiles(1, ['5A', '4F', '9F70']), '81E2910009BF2D065C035A4F9F7000');

/* ---------- 3. P04 反例：delete 不含 A0 / 81 包裹，enable 反之 ---------- */

const DEL_ICCID = '980193000050577617F1';
const delApdu = Euicc.buildProfileOperation(1, 'delete', { kind: 'iccid', hex: DEL_ICCID }, false);
const delCmd = Euicc.csimCommand(delApdu);
eq('⑧ delete 字节序列', delApdu, '81E291000FBF330C5A0A980193000050577617F100');
ok('⑧ delete 不含 A0 包裹（排除 5A0A 标识里的巧合子串）', delApdu.replace('5A0A', '').indexOf('A0') < 0, delApdu);
ok('⑧ delete 不含 8101 refresh', delApdu.indexOf('8101') < 0, delApdu);

const enApdu = Euicc.buildProfileOperation(1, 'enable', { kind: 'iccid', hex: DEL_ICCID }, true);
ok('⑥ enable 含 A0 包裹', enApdu.replace('5A0A', '').indexOf('A0') >= 0, enApdu);
ok('⑥ enable 含 8101 refresh(FF)', enApdu.indexOf('8101FF') >= 0, enApdu);
ok('⑥ enable/delete 结构不对称（对照）', enApdu.replace('5A0A', '').indexOf('A0') >= 0 && delApdu.replace('5A0A', '').indexOf('A0') < 0);

const disApdu = Euicc.buildProfileOperation(1, 'disable', { kind: 'aid', hex: 'A0000005591010FFFFFFFF8900001000' }, false);
ok('⑦ disable 含 A0 容器 + 810100（refresh=false）', disApdu.indexOf('A0') >= 0 && disApdu.indexOf('810100') >= 0, disApdu);

/* ---------- 4. P07 / §1.4 KORE 样本解析（只取 8 字段，不泄漏） ---------- */

/* 用程序化构造保证 TLV 长度自洽，避免手算字节数出错 */
function lenHex(n) {
	var s = n.toString(16).toUpperCase();
	return s.length === 1 ? '0' + s : s;
}
function tlv(tag, valHex) {
	return tag + lenHex(valHex.length / 2) + valHex;
}
var KORE_ICCID = '980193000050577617F1';
var KORE_AID = 'A0000005591010FFFFFFFF8900001000';
var koreE3 = tlv('E3',
	tlv('5A', KORE_ICCID) +
	tlv('4F', KORE_AID) +
	tlv('9F70', '00') +
	tlv('90', '4D794E616D') +   /* MyNam */
	tlv('91', '53704E616D'));    /* SpNam */
var KORE = tlv('BF2D', tlv('A0', koreE3));
const parsed = Euicc.parseGetProfiles(KORE);
eq('KORE 解析出 1 条 Profile', parsed.list.length, 1);
eq('KORE iccidRaw 原样', parsed.list[0].iccidRaw, KORE_ICCID);
eq('KORE iccid = 标准半字节交换结果', parsed.list[0].iccid, Euicc.swapNibbles(KORE_ICCID));
eq('KORE state = disabled（9F70=00）', parsed.list[0].state, 'disabled');
eq('KORE aid 原样', parsed.list[0].aid, KORE_AID);
eq('KORE 昵称 UTF-8 解码', parsed.list[0].nickname, 'MyNam');
eq('KORE 运营商 UTF-8 解码', parsed.list[0].spName, 'SpNam');
eq('KORE 只含 8 个白名单字段', Object.keys(parsed.list[0]).sort(),
	['aid', 'iccid', 'iccidRaw', 'nickname', 'profileClass', 'profileName', 'spName', 'state']);

/* 截断 / 不支持 tag 必须抛固定 code，绝不静默 */
eq('TLV 声明长度超出剩余 → EUICC_TLV_TRUNCATED', (function () {
	try { Euicc.parseGetProfiles('BF2DFF5A0A980193000050577617F1'); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_TLV_TRUNCATED');

/* ---------- 4b. R01 / R02 / R03 / R13 逐字节与形态断言 ---------- */

/* R01：buildSetNickname 的 BF29 值体长度 = 14 + 昵称字节数（1 / 2 / 中文3 字节） */
var NICCID = '980193000050577617F1';
function bf29Len(apdu) {
	var i = apdu.indexOf('BF29');
	return parseInt(apdu.substr(i + 4, 2), 16);
}
eq('R01 nickname=1字节 → BF29 长度=14+1=15', bf29Len(Euicc.buildSetNickname(1, NICCID, 'A')), 14 + 1);
eq('R01 nickname=2字节 → BF29 长度=14+2=16', bf29Len(Euicc.buildSetNickname(1, NICCID, 'AB')), 14 + 2);
eq('R01 nickname=中文3字节 → BF29 长度=14+3=17', bf29Len(Euicc.buildSetNickname(1, NICCID, '中')), 14 + 3);
/* 整条 APDU 字节级断言：修复前产出 0C（12），修复后应为 10（16） */
eq('R01 buildSetNickname(1,ICCID,\'AB\') 完整字节序列',
	Euicc.buildSetNickname(1, NICCID, 'AB'),
	'81E2910013BF29105A0A980193000050577617F19002414200');
/* R13：iccidHex 必须 20 字符 */
eq('R13 buildSetNickname iccid 长度 19 → EUICC_BAD_APDU', (function () {
	try { Euicc.buildSetNickname(1, NICCID.slice(0, 19), 'AB'); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');

/* R02：es10Result 两种响应形态 */
eq('R02 BF3303800103 → 3', Euicc.es10Result('BF3303800103'), 3);
eq('R02 BF3103800100 → 0', Euicc.es10Result('BF3103800100'), 0);
eq('R02 800103 → 3', Euicc.es10Result('800103'), 3);
eq('R02 800100 → 0', Euicc.es10Result('800100'), 0);
eq('R02 空串 → null', Euicc.es10Result(''), null);

/* R03：csimCommand 输入校验（单点汇聚） */
['"', ';', '\r', '\n'].forEach(function (c) {
	eq('R03 含非法字符 ' + JSON.stringify(c) + ' → EUICC_BAD_APDU', (function () {
		try { Euicc.csimCommand(c); return 'no-throw'; }
		catch (e) { return e.code; }
	})(), 'EUICC_BAD_APDU');
});
eq('R03 奇数长度 → EUICC_BAD_APDU', (function () {
	try { Euicc.csimCommand('00A40'); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('R03 越界 522 字符 → EUICC_BAD_APDU', (function () {
	try { Euicc.csimCommand(new Array(523).join('0')); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');

/* R13：buildProfileOperation 白名单 + ident.hex 长度 */
eq('R13 op=enabel 拼错 → EUICC_BAD_APDU', (function () {
	try { Euicc.buildProfileOperation(1, 'enabel', { kind: 'iccid', hex: NICCID }, true); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('R13 op=undefined → EUICC_BAD_APDU', (function () {
	try { Euicc.buildProfileOperation(1, undefined, { kind: 'iccid', hex: NICCID }, true); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('R13 iccid 长度 19 → EUICC_BAD_APDU', (function () {
	try { Euicc.buildProfileOperation(1, 'delete', { kind: 'iccid', hex: NICCID.slice(0, 19) }, false); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('R13 iccid 长度 21 → EUICC_BAD_APDU', (function () {
	try { Euicc.buildProfileOperation(1, 'delete', { kind: 'iccid', hex: NICCID + '0' }, false); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
var NAID = 'A0000005591010FFFFFFFF8900001000';
eq('R13 aid 长度 31 → EUICC_BAD_APDU', (function () {
	try { Euicc.buildProfileOperation(1, 'disable', { kind: 'aid', hex: NAID.slice(0, 31) }, false); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('R13 aid 长度 33 → EUICC_BAD_APDU', (function () {
	try { Euicc.buildProfileOperation(1, 'disable', { kind: 'aid', hex: NAID + '00' }, false); return 'no-throw'; }
	catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');

/* ---------- 5. P06 / 6A82 → EUICC_NO_EUICC（引导态 G1，不报错） ---------- */

asyncTests.push((function () {
	const send = mockSend({
		'AT^SIMSQ?': { success: true, data: '^SIMSQ: 0,1' },
		'AT+CSIM=?': { success: true, data: '+CSIM: (4-520),(cmd)' },
		[Euicc.csimCommand(Euicc.openChannelApdu())]: { success: true, data: csimAnswer('019000') },
		[Euicc.csimCommand(Euicc.selectIsdrApdu(1))]: { success: true, data: csimAnswer('6A82') }
	});
	return Euicc.listProfiles(send).then(function () {
		fails.push('6A82 应当抛 EUICC_NO_EUICC，但 resolve 了');
	}, function (e) {
		eq('6A82 → EUICC_NO_EUICC', e.code, 'EUICC_NO_EUICC');
	});
})());

/* ---------- 6. P04 / 61xx 两段响应拼接完整 ---------- */

asyncTests.push((function () {
	const getProfilesCmd = Euicc.csimCommand(Euicc.buildGetProfiles(1));
	const grCmd = Euicc.csimCommand(Euicc.getResponseApdu(1, 0));
	const counter = [];
	const send = function (cmd) {
		counter.push(cmd);
		if (cmd === grCmd) return Promise.resolve({ success: true, data: csimAnswer('56789000') });
		if (cmd === getProfilesCmd) return Promise.resolve({ success: true, data: csimAnswer('12346100') });
		if (cmd === Euicc.csimCommand(Euicc.openChannelApdu())) return Promise.resolve({ success: true, data: csimAnswer('019000') });
		if (cmd === Euicc.csimCommand(Euicc.selectIsdrApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('9000') });
		return Promise.resolve({ success: true, data: csimAnswer('9000') });
	};
	return Euicc.withIsdrSession(send, function (ch, sendApdu) {
		return sendApdu(Euicc.buildGetProfiles(1)).then(function (r) { return r.data; });
	}).then(function (data) {
		eq('61xx 两段响应拼接完整', data, '12345678');
	});
})());

/* ---------- 7. P10 写操作只发一次（钉不重发） ---------- */

asyncTests.push((function () {
	const counter = [];
	const send = function (cmd) {
		counter.push(cmd);
		if (cmd === delCmd) return Promise.resolve({ success: true, data: csimAnswer('9000') });
		if (cmd === Euicc.csimCommand(Euicc.openChannelApdu())) return Promise.resolve({ success: true, data: csimAnswer('019000') });
		if (cmd === Euicc.csimCommand(Euicc.selectIsdrApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('9000') });
		if (cmd === Euicc.csimCommand(Euicc.closeChannelApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('6200') });
		return Promise.resolve({ success: true, data: csimAnswer('9000') });
	};
	return Euicc.deleteProfile(send, { kind: 'iccid', hex: DEL_ICCID }).then(function () {
		const hits = counter.filter(function (c) { return c === delCmd; }).length;
		eq('delete 业务 APDU 仅下发 1 次（未重试）', hits, 1);
		/* 写路径：open + select + delete + close = 4 次 send，无额外重发 */
		eq('delete 总 send 调用数 = 4（开/选/删/关）', counter.length, 4);
	});
})());

/* ---------- 8. P05 关通道 6200 不报错（仅 warn） ---------- */

asyncTests.push((function () {
	const counter = [];
	const send = function (cmd) {
		counter.push(cmd);
		if (cmd === Euicc.csimCommand(Euicc.openChannelApdu())) return Promise.resolve({ success: true, data: csimAnswer('019000') });
		if (cmd === Euicc.csimCommand(Euicc.selectIsdrApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('9000') });
		if (cmd === Euicc.csimCommand(Euicc.closeChannelApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('6200') });
		return Promise.resolve({ success: true, data: csimAnswer('9000') });
	};
	return Euicc.listProfiles(send).then(function (res) {
		ok('关通道 6200 不阻断正常流程', res && Array.isArray(res.list));
	});
})());

/* ---------- 8b. R11 非 close 场景 62xx 不抛错（仅 warn） ---------- */

asyncTests.push((function () {
	const send = function (cmd) {
		if (cmd === Euicc.csimCommand(Euicc.openChannelApdu())) return Promise.resolve({ success: true, data: csimAnswer('019000') });
		if (cmd === Euicc.csimCommand(Euicc.selectIsdrApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('9000') });
		if (cmd === Euicc.csimCommand(Euicc.closeChannelApdu(1))) return Promise.resolve({ success: true, data: csimAnswer('9000') });
		return Promise.resolve({ success: true, data: csimAnswer('6283') }); /* 任意业务命令回 62xx */
	};
	return Euicc.withIsdrSession(send, function (ch, sendApdu) {
		return sendApdu('00A4000000');
	}).then(function (r) {
		eq('非 close 场景 62xx 不抛错（仅 warn）', r && r.sw, '6283');
	}, function () {
		fails.push('非 close 场景 62xx 不应抛错');
	});
})());

/* ---------- 9. §1.6 引导态探测（G3 无卡 / G2 无 CSIM / 正常态） ---------- */

asyncTests.push((function () {
	const sendNoCard = mockSend({
		'AT^SIMSQ?': { success: true, data: '^SIMSQ: 0,99' }
	});
	return Euicc.probe(sendNoCard).then(function (p) {
		eq('G3 无卡：SIMSQ status=99 → no_card', p.state, 'no_card');

		const sendNoCsim = mockSend({
			'AT^SIMSQ?': { success: true, data: '^SIMSQ: 0,1' },
			'AT+CSIM=?': { success: true, data: 'ERROR' }
		});
		return Euicc.probe(sendNoCsim).then(function (p2) {
			eq('G2 无 CSIM：CSIM=? 返回 ERROR → no_csim', p2.state, 'no_csim');

			const eid = '112233445566778899AABBCCDDEEFF00';
			const sendOk = mockSend({
				'AT^SIMSQ?': { success: true, data: '^SIMSQ: 0,1' },
				'AT+CSIM=?': { success: true, data: '+CSIM: (4-520),(cmd)' },
				[Euicc.csimCommand(Euicc.openChannelApdu())]: { success: true, data: csimAnswer('019000') },
				[Euicc.csimCommand(Euicc.selectIsdrApdu(1))]: { success: true, data: csimAnswer('9000') },
				[Euicc.csimCommand(Euicc.buildGetEid(1))]: { success: true, data: csimAnswer('BF3E125A10' + eid + '9000') },
				[Euicc.csimCommand(Euicc.closeChannelApdu(1))]: { success: true, data: csimAnswer('9000') }
			});
			return Euicc.probe(sendOk).then(function (p3) {
				eq('正常态：probe ok 且回传 EID', [p3.state, p3.eid], ['ok', eid]);
			});
		});
	});
})());

/* ---------- 10. 异常 code 集合固定（双向全等，R11） ---------- */

var EXPECTED_CODES = [
	'EUICC_BAD_HEX', 'EUICC_BAD_APDU', 'EUICC_TLV_TRUNCATED', 'EUICC_UNSUPPORTED_TAG',
	'EUICC_AT_ERROR', 'EUICC_NO_CSIM', 'EUICC_NO_CARD', 'EUICC_NO_CHANNEL',
	'EUICC_CHANNEL_LEAK', 'EUICC_NO_EUICC', 'EUICC_BUSY', 'EUICC_POLICY_DENIED', 'EUICC_OP_FAILED'
];
ok('异常 code 集合与 §1.2 完全一致（双向，含 R05 新增 EUICC_NO_CARD）',
	Euicc.ERR_CODES.length === EXPECTED_CODES.length &&
	EXPECTED_CODES.every(function (c) { return Euicc.ERR_CODES.indexOf(c) >= 0; }) &&
	Euicc.ERR_CODES.every(function (c) { return EXPECTED_CODES.indexOf(c) >= 0; }));

/* ---------- 汇总（等所有异步用例完成，R11） ---------- */

Promise.all(asyncTests).then(function () {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	if (fails.length) {
		console.log('');
		fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
		process.exit(1);
	}
	console.log('euicc.js 契约测试全部通过');
}).catch(function (e) {
	console.error('异步用例异常：' + (e && e.stack || e));
	process.exit(1);
});
