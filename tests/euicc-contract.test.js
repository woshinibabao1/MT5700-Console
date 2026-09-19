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
/* ★ 2026-09-19 真机实测：STORE DATA 固定 case 3（**无 Le**）。
   带 Le=00 时本模组透传层直接回 ERROR（CLA=00/80/81 全部失败），卡根本收不到。
   响应数据由 GET RESPONSE（case 2，带 Le）取回 —— 见下面 ③ 的 getResponseApdu，它有 Le。 */
eq('④ GetEid（无 Le）', Euicc.buildGetEid(1), '81E2910006BF3E035C015A');
eq('⑤ GetProfiles 默认 5 tag（无 Le）', Euicc.buildGetProfiles(1), '81E291000BBF2D085C055A4F9F709091');
eq('⑤ GetProfiles 自定义 3 tag（9F70 计 2 字节，无 Le）',
	Euicc.buildGetProfiles(1, ['5A', '4F', '9F70']), '81E2910009BF2D065C035A4F9F70');
/* ★ 反向验证：STORE DATA 绝不能再出现末尾 Le=00。
   少了这条，有人把 storeDataApdu 改回 '+ "00"' 时上面三条能跟着改、守卫却还是绿的。 */
ok('★ 反向：STORE DATA 末字节不是 Le（case 3）',
	/00$/.test(Euicc.buildGetEid(1)) === false,
	Euicc.buildGetEid(1));
ok('★ 反向：GET RESPONSE 仍必须带 Le（case 2，取余靠它）',
	Euicc.getResponseApdu(1, 0) === '81C0000000',
	Euicc.getResponseApdu(1, 0));

/* ---------- 3. P04 反例：delete 不含 A0 / 81 包裹，enable 反之 ---------- */

const DEL_ICCID = '980193000050577617F1';
const delApdu = Euicc.buildProfileOperation(1, 'delete', { kind: 'iccid', hex: DEL_ICCID }, false);
const delCmd = Euicc.csimCommand(delApdu);
eq('⑧ delete 字节序列（无 Le）', delApdu, '81E291000FBF330C5A0A980193000050577617F1');
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
eq('R01 buildSetNickname(1,ICCID,\'AB\') 完整字节序列（无 Le）',
	Euicc.buildSetNickname(1, NICCID, 'AB'),
	'81E2910013BF29105A0A980193000050577617F190024142');
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
		/* 写路径：open + select + **探活 GetEid** + delete + close = 5 次 send。
		   ★ 多出来的那一条是探活（2026-09-19）：本卡逻辑通道 open 与 SELECT 都成功、
		     到 STORE DATA 才回 6881，所以必须在执行写操作**之前**判定通道是否可用，
		     否则 delete/enable 这类写操作会跑到一半失败再被迫重跑，有重复下发风险。
		     探活用只读 GetEid，无副作用。 */
		eq('delete 总 send 调用数 = 5（开/选/探活/删/关）', counter.length, 5);
		/* ★ 反向：写操作必须只下发一次（探活不得导致 fn 重跑），这是探活方案的核心保障 */
		eq('★ delete 业务 APDU 仅 1 次（探活未导致重跑）', hits, 1);
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

/* ---------- 9b. AT+CSIM 单条响应 256 字节上限 → EUICC_CSIM_TRUNCATED ----------
 *
 * ★ 2026-09-19 真机实测（H5000M / MT5700）：ES10b.AuthenticateServer 的响应 TLV
 *   声明 1631 字节，AT+CSIM 只回得来 256 字节，且卡上没有任何残留可取
 *   （81C0000000 / 81C00000FF / 81C0000080 / 81C0000001 四种 GET RESPONSE 全 0 字节，
 *    重发末块回 6A86）。也就是说超过 256 字节的响应在本设备上永远取不全。
 *   没有这道闸时，残片会被当完整响应发往 SM-DP+，表现为服务器侧
 *   「Server authentication failed（1.2/4.2）」+ 卡侧 6A80 —— 把固件能力上限
 *   报成了本地组包 bug，排查方向完全跑偏。这两条用例就是钉死这个因果的。
 */

eq('tlvTotalBytes 短格式', Euicc.tlvTotalBytes('8002AABB'), 4);
eq('tlvTotalBytes 0x81 长格式', Euicc.tlvTotalBytes('808103AABBCC'), 6);
eq('tlvTotalBytes 0x82 长格式', Euicc.tlvTotalBytes('80820003AABBCC'), 7);
eq('tlvTotalBytes 双字节 tag（真机 BF38 82 065F）',
	Euicc.tlvTotalBytes('BF3882065F'), 2 + 3 + 0x065F);
eq('tlvTotalBytes 解析不出返回 -1（不抛，交由调用方忽略）',
	[Euicc.tlvTotalBytes(''), Euicc.tlvTotalBytes('80'), Euicc.tlvTotalBytes('ZZ'),
		Euicc.tlvTotalBytes('808200')],
	[-1, -1, -1, -1]);

/* 顶层结构：tag BF3E(2) + 长度 82 XX XX(3) = 5 字节头，值 251 字节 → 合计 256 */
/* 声明 516 字节、实收正好 256 字节（被切在缓冲区边界上） */
const CUT_256 = 'BF3E' + '8201FF' + 'AA'.repeat(251);
/* 完整的 256 字节响应：声明 = 实收 = 256，绝不能误判成截断 */
const FULL_256 = 'BF3E' + '8200FB' + 'AA'.repeat(251);
eq('截断样本实收 256 字节', CUT_256.length / 2, 256);
eq('完整样本也是 256 字节（同为边界值，用来守误判）', FULL_256.length / 2, 256);

function csimSendFor(eidHex, counter) {
	return mockSend({
		'AT^SIMSQ?': { success: true, data: '^SIMSQ: 0,1' },
		'AT+CSIM=?': { success: true, data: '+CSIM: (4-520),(cmd)' },
		[Euicc.csimCommand(Euicc.openChannelApdu())]: { success: true, data: csimAnswer('019000') },
		[Euicc.csimCommand(Euicc.selectIsdrApdu(1))]: { success: true, data: csimAnswer('9000') },
		[Euicc.csimCommand(Euicc.buildGetEid(1))]: { success: true, data: csimAnswer(eidHex + '9000') },
		[Euicc.csimCommand(Euicc.closeChannelApdu(1))]: { success: true, data: csimAnswer('9000') }
	}, counter);
}

asyncTests.push((function () {
	return Promise.resolve().then(function () {
		return Euicc.withIsdrSession(csimSendFor(CUT_256), function (ch, sendApdu) {
			return sendApdu(Euicc.buildGetEid(ch));
		});
	}).then(function () {
		fails.push('★ 响应被 256 字节上限截断必须抛 EUICC_CSIM_TRUNCATED  → 本应抛错却成功了');
	}, function (e) {
		if ((e && e.code) !== 'EUICC_CSIM_TRUNCATED') {
			fails.push('★ 响应被 256 字节上限截断必须抛 EUICC_CSIM_TRUNCATED  → code 实际 ' +
				(e && e.code) + '：' + (e && e.message));
		} else {
			pass++;
		}
	});
})());

asyncTests.push((function () {
	/* 反向守卫：同样 256 字节，但声明与实收一致 —— 不能误报截断，否则正常卡会被冤枉 */
	return Euicc.withIsdrSession(csimSendFor(FULL_256), function (ch, sendApdu) {
		return sendApdu(Euicc.buildGetEid(ch));
	}).then(function (r) {
		ok('★ 完整的 256 字节响应不误判为截断', r && r.sw === '9000', r && r.sw);
	}, function (e) {
		fails.push('完整的 256 字节响应被误判为截断：code=' + (e && e.code));
	});
})());

/* ---------- 10. 异常 code 集合固定（双向全等，R11） ---------- */

var EXPECTED_CODES = [
	'EUICC_BAD_HEX', 'EUICC_BAD_APDU', 'EUICC_TLV_TRUNCATED', 'EUICC_UNSUPPORTED_TAG',
	'EUICC_AT_ERROR', 'EUICC_NO_CSIM', 'EUICC_NO_CARD', 'EUICC_NO_CHANNEL',
	'EUICC_CHANNEL_LEAK', 'EUICC_NO_EUICC', 'EUICC_BUSY', 'EUICC_POLICY_DENIED', 'EUICC_OP_FAILED',
	/* 下载链路（ES9+ 走后端转发）专有：设备无转发通道 / SM-DP+ 侧失败 */
	'EUICC_NO_ES9P', 'EUICC_ES9P_FAILED',
	/* 模组 AT+CSIM 单条响应装不下（CSIM 通路取不全大响应的根因；走 CGLA 不受限） */
	'EUICC_CSIM_TRUNCATED'
];
ok('异常 code 集合与 §1.2 完全一致（双向，含 R05 新增 EUICC_NO_CARD）',
	Euicc.ERR_CODES.length === EXPECTED_CODES.length &&
	EXPECTED_CODES.every(function (c) { return Euicc.ERR_CODES.indexOf(c) >= 0; }) &&
	Euicc.ERR_CODES.every(function (c) { return EXPECTED_CODES.indexOf(c) >= 0; }));

/* ---------- 11. AT+CGLA 传输通路（手册 3.16，真机 2026-09-19 取证） ----------
 *
 * ★ 这一组**必须串行跑**：transport 是模块级全局状态，而 asyncTests 是
 *   Promise.all 并发的 —— 并发改它会让 CSIM 那组用例发出的命令变成
 *   `AT+CGLA=...`，mock 匹配不上而集体假红。所以整组串成一条链，
 *   在 Promise.all 之后单独跑，跑完复位成 csim。
 *
 * 钉死三件事：
 *   ① CGLA 下**不发 MANAGE CHANNEL**（模组自己管逻辑通道，发了反而 6A81）；
 *   ② CGLA 下 61xx 由本模块自己发 GET RESPONSE，**多轮能拼出 >256 字节**的响应
 *      （这正是 CSIM 通路做不到、而 Profile 下载必须依赖的能力）；
 *   ③ detectTransport 的判据是「AT 层是否接受命令」，不是「SW 是否为 9000」
 *      —— 用 `=?` 测试形式探测在本模组上是假阴性，那正是上一次误判的起因。
 */

function cglaAnswer(dataAndSw) {
	return '+CGLA: ' + dataAndSw.length + ',"' + dataAndSw + '"';
}

eq('cglaCommand 拼装（sessionid 固定 0，length 是十六进制字符数）',
	Euicc.cglaCommand('00A40804047FFF6F07'),
	'AT+CGLA=0,18,"00A40804047FFF6F07"');
eq('cglaCommand 长度校验与 CSIM 一致（521 字符 → 抛错）', (function () {
	try { Euicc.cglaCommand(new Array(523).join('0')); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('cglaCommand 非法 hex → 抛错', (function () {
	try { Euicc.cglaCommand('00A4ZZ'); return 'no-throw'; } catch (e) { return e.code; }
})(), 'EUICC_BAD_APDU');
eq('parseCglaAnswer 抽取 + 末 4 字符为 SW',
	Euicc.parseCglaAnswer('+CGLA: 6,"019000"'),
	{ data: '01', sw: '9000', hasMore: false, le: 0 });
eq('parseCglaAnswer 61xx → hasMore + le',
	Euicc.parseCglaAnswer('+CGLA: 8,"123461F0"'),
	{ data: '1234', sw: '61F0', hasMore: true, le: 240 });
eq('parseCglaAnswer 无 +CGLA 行 → null', Euicc.parseCglaAnswer('ERROR'), null);
eq('setTransport 只接受 csim/cgla（拼错时保持现状，不静默降级）', (function () {
	var a = Euicc.setTransport('cgla'), b = Euicc.getTransport();
	var c = Euicc.setTransport('bogus'), d = Euicc.getTransport();
	Euicc.setTransport('csim');
	return [a, b, c, d];
})(), ['cgla', 'cgla', 'cgla', 'cgla']);

/* 三轮拼出 256+256+100 = 612 字节 —— 远超 CSIM 通路的 256 上限 */
const CHUNK_A = 'AA'.repeat(256);
const CHUNK_B = 'BB'.repeat(256);
const CHUNK_C = 'CC'.repeat(100);

function cglaSend(counter) {
	const map = {
		[Euicc.cglaCommand(Euicc.selectIsdrApdu(1))]: { success: true, data: cglaAnswer('9000') },
		[Euicc.cglaCommand(Euicc.buildGetEid(1))]: { success: true, data: cglaAnswer(CHUNK_A + '61F0') },
		[Euicc.cglaCommand(Euicc.getResponseApdu(1, 240))]: { success: true, data: cglaAnswer(CHUNK_B + '6164') },
		[Euicc.cglaCommand(Euicc.getResponseApdu(1, 100))]: { success: true, data: cglaAnswer(CHUNK_C + '9000') }
	};
	return function (cmd) {
		if (counter) counter.push(cmd);
		return Promise.resolve(map[cmd] || { success: true, data: '' });
	};
}

function cglaChain() {
	const sent = [];
	Euicc.setTransport('cgla');
	return Euicc.withIsdrSession(cglaSend(sent), function (ch, sendApdu) {
		return sendApdu(Euicc.buildGetEid(ch));
	}).then(function (r) {
		eq('★ CGLA：多轮 GET RESPONSE 拼出超过 256 字节的完整响应', r.data.length / 2, 612);
		/* A 占字符 0~511，B 占 512~1023，C 占 1024~1223（各段按字节数 ×2） */
		eq('★ CGLA：拼接顺序正确（A→B→C，无错位无覆盖）',
			r.data.slice(0, 6) + r.data.slice(512, 518) + r.data.slice(1024, 1030),
			'AAAAAA' + 'BBBBBB' + 'CCCCCC');
		eq('★ CGLA：末轮 SW', r.sw, '9000');
		/* 通道管理：open=0070000001，close=0070800100。CGLA 下一条都不该出现。 */
		const mgmt = sent.filter(function (c) { return /CGLA=0,\d+,"007[08]/.test(c); });
		eq('★ CGLA：不发 MANAGE CHANNEL（open/close 各 0 条，模组自己管通道）', mgmt.length, 0);
		/* 对照：CSIM 通路**必须**发 open —— 证明上面那条不是「两条通路都不发」 */
		const csent = [];
		Euicc.setTransport('csim');
		return Euicc.withIsdrSession(csimSendFor(FULL_256, csent), function (ch2, sendApdu2) {
			return sendApdu2(Euicc.buildGetEid(ch2));
		}).then(function () {
			const mgmt2 = csent.filter(function (c) { return /CSIM=10,"007[08]/.test(c); });
			eq('对照：CSIM 通路照旧发 open + close（与 CGLA 分支形成反证）', mgmt2.length, 2);
		});
	}).then(function () {
		/* detectTransport：判据是「AT 层是否接受命令」，与 SW 无关 */
		return Euicc.detectTransport(mockSend({
			[Euicc.cglaCommand(Euicc.selectIsdrApdu(1))]: { success: true, data: cglaAnswer('6A82') }
		}));
	}).then(function (t) {
		eq('★ detectTransport：AT 层接受命令即判 cgla（卡回 6A82 不影响判定）', t, 'cgla');
		return Euicc.detectTransport(mockSend({
			[Euicc.cglaCommand(Euicc.selectIsdrApdu(1))]: { success: true, data: 'ERROR' }
		}));
	}).then(function (t2) {
		eq('detectTransport：AT 层 ERROR → 回退 csim', t2, 'csim');
		return Euicc.detectTransport(mockSend({}));
	}).then(function (t3) {
		eq('detectTransport：无 +CGLA 应答 → 回退 csim', t3, 'csim');
	}, function (e) {
		fails.push('CGLA 用例链异常：' + (e && e.stack || e));
	});
}

/* ---------- 卡容量（EUICCInfo2 / extCardResource） ----------
 *
 * ★ 逐条对照 pySim/euicc.py 的定义，tag 不是拍脑袋来的：
 *     EuiccInfo2 tag=0xBF22、ExtCardResource tag=0x84（个别实现发构造型 A4）
 *     84 内：81=installedApplication / 82=freeNonVolatileMemory / 83=freeVolatileMemory
 *
 * ★ 本机卡 `BF3C` 只回了 `81 15 "testrootsmds.gsma.com"`，那是
 *   **GetEuiccConfiguredAddresses**（tag 0xBF3C）的 RootDsAddress，不是容量 ——
 *   这条用例把「BF3C 形状 → 判为未上报」钉死，防止后人再把两者搞混。
 */

eq('buildGetEuiccInfo2 发 BF22（不是 BF3C）', Euicc.buildGetEuiccInfo2(1), '81E2910003BF2200');

/* 84 容器：81 01 08 / 82 03 010000 / 83 02 2000 —— 变长大端整数，不是定宽 */
const INFO2_84 = 'BF220E840C' + '810108' + '8203010000' + '83022000';
eq('parseExtCardResource：84 容器三项全解（变长大端整数）',
	Euicc.parseExtCardResource(INFO2_84),
	{ installedApplication: 8, freeNonVolatileMemory: 65536, freeVolatileMemory: 8192 });

/* 同一份内容按构造型 A4 发，也必须解得出来 */
eq('parseExtCardResource：A4 变体同样识别',
	Euicc.parseExtCardResource(INFO2_84.replace('840C', 'A40C')),
	{ installedApplication: 8, freeNonVolatileMemory: 65536, freeVolatileMemory: 8192 });

/* 1 字节的小数值（SGP.22 允许变长，不能按 3 字节读） */
eq('parseExtCardResource：1 字节数值不被当成 3 字节',
	Euicc.parseExtCardResource('BF22088406820140830102'),
	{ freeNonVolatileMemory: 64, freeVolatileMemory: 2 });

/* 本机卡的真实形状：EUICCInfo2 里只有地址串、没有 84 → 必须判「未上报」（null） */
eq('parseExtCardResource：无 extCardResource → null（本机卡 BF3C 同形状）',
	Euicc.parseExtCardResource('BF2217' + '8115' + Buffer.from('testrootsmds.gsma.com').toString('hex').toUpperCase()),
	null);

eq('parseExtCardResource：84 存在但三个子字段全缺 → null',
	Euicc.parseExtCardResource('BF22028400'), null);
eq('parseExtCardResource：非 hex / 空串 → null',
	[Euicc.parseExtCardResource(''), Euicc.parseExtCardResource('zzzz')], [null, null]);
eq('parseExtCardResource：只报 82 一项也要给出来（不要求三项齐全）',
	Euicc.parseExtCardResource('BF220584038201FF'),
	{ freeNonVolatileMemory: 255 });

/* ---------- 汇总（等所有异步用例完成，R11） ---------- */

Promise.all(asyncTests).then(function () {
	/* CGLA 组要改模块级 transport，**必须**在并发用例跑完之后串行执行 */
	return cglaChain();
}).then(function () {
	Euicc.setTransport('csim'); /* 复位，避免污染同进程内的其它用例 */
}).then(function () {
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
