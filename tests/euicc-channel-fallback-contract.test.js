#!/usr/bin/env node
/*
 * eSIM 通道策略与 APDU 格式契约测试（纯 Node / mock，绝不向真机下发任何 AT）
 * ---------------------------------------------------------------------------
 * 存在的理由：2026-09-19 真机实测（tools/esim-probe.py + 二分实验）证明本机卡与
 * 透传链路上有两条与 euicc.js 原实现**直接冲突**的事实：
 *   ① STORE DATA 带 Le=00（case 4）时，AT+CSIM 在**传输层**就回 ERROR，
 *      根本到不了卡片；不带 Le 才回 9000。
 *   ② 本卡不支持逻辑通道：open 成功（9000，ch=1）、SELECT ISD-R 成功，
 *      但带通道号的 STORE DATA 回 6881。
 * 原实现同时踩中两条 → 页面只能报「读取 eSIM 信息失败，请稍后重试」。
 *
 * 这里钉死三件事（每条都配**反向验证**：把改动前的旧实现喂给同一个检查函数
 * 必须判红，否则守卫等于没写）：
 *   A. STORE DATA 不再拼 Le
 *   B. 逻辑通道探活撞 6881 → 回退基本通道，且业务回调只执行一次
 *   C. 6881 不得判成 fatal（否则页面把 eUICC 误报成「普通 USIM」，比报错更糟）
 *
 * 运行：node tests/euicc-channel-fallback-contract.test.js
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

/* ---------- mock 卡侧 ---------- */

function csimAnswer(hex) {
	return '+CSIM: ' + hex.length + ',"' + hex + '"';
}

const EID_TLV = 'BF3E125A10' + '89004400112233445566778899AABBCCDD';

/*
 * 按「给通道 ch 的 STORE DATA 回什么」来参数化：
 *   logicalStroreSw='6881' 模拟本机卡（不支持逻辑通道）
 *   logicalStroreSw='9000' 模拟支持逻辑通道的卡
 */
function makeCard(opts) {
	opts = opts || {};
	const st = { cmds: [], apdus: [], closes: [], fnCalls: 0 };
	return {
		state: st,
		send: function (cmd) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(cmd);
			const apdu = mm ? mm[1].toUpperCase() : '';
			st.cmds.push(cmd);
			st.apdus.push(apdu);

			if (apdu === '0070000001') {
				return Promise.resolve({ success: true, data: csimAnswer(opts.openSw ? opts.openSw : '019000') });
			}
			if (/^0[01]A4040C10/.test(apdu)) {
				st.selects = (st.selects || 0) + 1;
				const sw = (apdu.charAt(1) === '0') ? (opts.basicSelectSw || '9000') : (opts.selectSw || '9000');
				if (sw === '6A82') return Promise.resolve({ success: true, data: csimAnswer('6A82') });
				return Promise.resolve({ success: true, data: csimAnswer('9000') });
			}
			if (/^007080\d\d00$/.test(apdu)) {
				st.closes.push(apdu);
				return Promise.resolve({ success: true, data: csimAnswer('9000') });
			}
			/* STORE DATA：按 CLA 的通道号分流 */
			const cla = parseInt(apdu.substr(0, 2), 16);
			const logical = (cla & 0x0f) !== 0;
			const body = apdu.substr(10, 4);
			if (body === 'BF3E') {
				const sw = logical ? (opts.logicalStoreSw || '9000') : '9000';
				if (sw !== '9000') return Promise.resolve({ success: true, data: csimAnswer(sw) });
				return Promise.resolve({ success: true, data: csimAnswer(EID_TLV + '9000') });
			}
			if (body === 'BF2D') {
				return Promise.resolve({ success: true, data: csimAnswer('BF2D02A0009000') });
			}
			return Promise.resolve({ success: false, error: '未预期的 APDU ' + apdu });
		}
	};
}

const asyncTests = [];

/* ---------- A. 逻辑通道撞 6881 → 回退基本通道（防御路径） ----------
 * ★ 注：这是**防御性**场景，不是本机实测路径。本机卡逻辑通道可用（2026-09-19 复测：
 *   open→SELECT→GET RESPONSE→GetEID 全 9000），eSIM 读不出来的唯一根因是 Le。
 *   但 6881/6A81 在 GSMA 里真实存在，这条路径保证那类卡不被误报成「不是 eUICC」。 */

asyncTests.push(function () {
	const card = makeCard({ logicalStoreSw: '6881' });
	let seenChannel = null;
	let fnCalls = 0;
	let gotSw = null;
	const fnApdus = [];
	return Euicc.withIsdrSession(card.send, function (ch, sendApdu) {
		fnCalls++;
		seenChannel = ch;
		/* 业务回调里的 APDU 才代表「回退后真正走哪条通道」；
		   探活本身一定先在逻辑通道上试一次，那不算数。 */
		const apdu = Euicc.buildGetProfiles(ch);
		fnApdus.push(apdu);
		return sendApdu(apdu).then(function (r) { gotSw = r.sw; });
	}).then(function () {
		eq('A1 回退后业务回调只执行一次', fnCalls, 1);
		eq('A2 回退后 channel 为基本通道 0', seenChannel, 0);
		eq('A3 基本通道上 GetProfiles 成功', gotSw, '9000');
		ok('A4 业务 APDU 走基本通道（CLA=0x80，低 4 位为 0）',
			fnApdus.every(function (a) { return /^80E2/.test(a); }),
			'实际 ' + fnApdus.join(','));
		ok('A5 逻辑通道被关掉，没泄漏', card.state.closes.indexOf('0070800100') >= 0,
			'closes=' + card.state.closes.join(','));
		ok('A6 基本通道不会被关闭（0070800000 会把基本通道一起关掉）',
			card.state.closes.indexOf('0070800000') < 0);
	});
});

/* ---------- B. 逻辑通道可用时不回退 ---------- */

asyncTests.push(function () {
	const card = makeCard({ logicalStoreSw: '9000' });
	let seenChannel = null;
	let fnCalls = 0;
	return Euicc.withIsdrSession(card.send, function (ch, sendApdu) {
		fnCalls++;
		seenChannel = ch;
		return sendApdu(Euicc.buildGetProfiles(ch));
	}).then(function () {
		eq('B1 逻辑通道可用时不回退（channel=1）', seenChannel, 1);
		eq('B2 业务回调仍只执行一次', fnCalls, 1);
		eq('B3 只在结束时关一次逻辑通道', card.state.closes.length, 1);
		eq('B4 关的是 1 号逻辑通道', card.state.closes[0], '0070800100');
	});
});

/* ---------- C. 6A82：两通道皆 6A82 才判「不是 eUICC」，且只回退一次 ----------
 *
 * ★ 2026-09-20 真机实测修订：旧断言「6A82 不触发基本通道重试」是错的。
 *   本机恰是 MANAGE CHANNEL OPEN 成功（分配通道 2/3）、该通道 SELECT 一律 6A82，
 *   而基本通道（CLA=00）SELECT 回 6121、GET EID 正确返回 32 位 EID ——
 *   卡是真 eUICC，只是逻辑通道够不着。无条件判「不是 eUICC」等于把通道能力
 *   问题报成卡的身份问题。现在 6A82 必须先回退基本通道复核。
 *   本组 mock 两条通道都是 6A82，因此回退后仍然要判 EUICC_NO_EUICC。
 */

asyncTests.push(function () {
	const card = makeCard({ selectSw: '6A82', basicSelectSw: '6A82' });
	let code = null;
	return Euicc.withIsdrSession(card.send, function () {
		return Promise.resolve({ ok: true });
	}).catch(function (e) { code = e && e.code; }).then(function () {
		eq('C1 两条通道都 6A82 → EUICC_NO_EUICC（这张卡真没有 ISD-R）', code, 'EUICC_NO_EUICC');
		const basicSelects = card.state.apdus.filter(function (a) { return a.indexOf('00A4040C10') === 0; });
		eq('C2 基本通道只复核一次，不重复回退', basicSelects.length, 1);
	});
});

/* ---------- C3. 逻辑通道 6A82 但基本通道正常 → 回退成功（本机真机形态） ---------- */

asyncTests.push(function () {
	const card = makeCard({ selectSw: '6A82' });
	let seenChannel = null;
	return Euicc.withIsdrSession(card.send, function (ch, sendApdu) {
		seenChannel = ch;
		return sendApdu(Euicc.buildGetProfiles(ch));
	}).then(function (r) {
		eq('C3 逻辑通道 6A82 + 基本通道正常 → 回退到基本通道', seenChannel, 0);
		eq('C4 回退后业务 APDU 成功', r.sw, '9000');
		ok('C5 业务 APDU 走基本通道 CLA=0x80', /^80E2/.test(Euicc.buildGetProfiles(0)),
			Euicc.buildGetProfiles(0));
	}).catch(function (e) {
		fails.push('C3 基本通道可用时不该判「不是 eUICC」，实际抛 ' + (e && e.code));
	});
});

/* ---------- D. 6881 不得判成 fatal（防「eUICC 被误报成普通卡」） ---------- */

eq('D1 swInfo(6881) 不是 fatal', Euicc.swInfo('6881').level !== 'fatal', true);
eq('D2 swInfo(6A81) 不是 fatal', Euicc.swInfo('6A81').level !== 'fatal', true);
ok('D3 swInfo(6881) 文案点明是逻辑通道问题',
	/逻辑通道/.test(Euicc.swInfo('6881').text || ''), Euicc.swInfo('6881').text);
eq('D4 6A82 仍判 fatal（这张卡确实不是 eUICC）', Euicc.swInfo('6A82').level, 'fatal');

/* ---------- E. STORE DATA 不带 Le（真机：带 Le 在传输层就 ERROR） ---------- */

/* 真机实测（2026-09-19 二分矩阵）：同一条 GetEID，带 Le → 传输层 ERROR；不带 → 9000 */
eq('E1 buildEs10b(1,BF2E,"") 无 Le', Euicc.buildEs10b(1, 'BF2E', ''), '81E2910003BF2E00');
eq('E2 buildGetEid(1) 无 Le', Euicc.buildGetEid(1), '81E2910006BF3E035C015A');
eq('E3 buildGetProfiles(1) 无 Le', Euicc.buildGetProfiles(1), '81E291000BBF2D085C055A4F9F709091');
ok('E4 分块每块都是 head(8)+lc(2)+tlv，末尾没有多余字节',
	Euicc.buildEs10bChunks(1, 'BF36', 'AA'.repeat(10), 120).every(function (c) {
		return c.length === 10 + Number(parseInt(c.substr(8, 2), 16)) * 2;
	}));

/* ---------- F. GET RESPONSE 必须**仍带** Le（case 2） ----------
 * 真机实测：SELECT 回 6121 后发 01C0000021 → 9000 拿到 FCI。
 * 去掉 STORE DATA 的 Le 时若手滑把这里的 Le 一起删了，就变成「选上了但取不回数据」，
 * 比现在的报错更难排查。这条是防「改 A 顺手改坏 B」。 */

eq('F1 getResponseApdu(1,0x21) 完整字节序列', Euicc.getResponseApdu(1, 0x21), '81C0000021');
eq('F2 getResponseApdu(0,0x21) 基本通道', Euicc.getResponseApdu(0, 0x21), '80C0000021');
eq('F3 le=0 时发 00（表示 ≥256 字节）', Euicc.getResponseApdu(0, 0), '80C0000000');

/* ---------- ★ 反向验证：下面的检查函数必须能检出「改动前的旧实现」 ---------- */

/*
 * 检查 A：源码里必须存在「逻辑通道回退基本通道」的三要素。
 * 反向：把 pingOn / channelUnsupported / channel = 0 任何一个抹掉，都必须判 false。
 */
function hasFallback(s) {
	return /function pingOn/.test(s)
		&& /channelUnsupported/.test(s)
		&& /channel = 0;/.test(s);
}
ok('★ 反向1 现行源码具备回退三要素', hasFallback(src));
ok('★ 反向1-a 抹掉 pingOn 后必须判红（否则守卫没在检查）',
	hasFallback(src.replace('function pingOn', 'function _pingOnX')) === false);
ok('★ 反向1-b 抹掉 channelUnsupported 判定后必须判红',
	hasFallback(src.replace(/channelUnsupported/g, '_x')) === false);
ok('★ 反向1-c 抹掉 channel = 0 回退赋值后必须判红',
	hasFallback(src.replace(/channel = 0;/g, 'channel = ch;')) === false);

/*
 * 检查 B：STORE DATA 不得再拼 Le。
 * 反向：把旧实现的 `+ '00'` 塞回去，必须判红。
 */
function hasNoLe(s) {
	const fn = /api\.storeDataApdu = function[\s\S]*?\n\t\};/.exec(s);
	if (!fn) return false;
	return !/\+\s*'00'/.test(fn[0]);
}
ok('★ 反向2 现行 storeDataApdu 不拼 Le', hasNoLe(src));
ok('★ 反向2-a 旧实现（拼了 Le）必须判红',
	hasNoLe(src.replace("return head + lc + tlvHex2;", "return head + lc + tlvHex2 + '00';")) === false);

/*
 * 检查 B2：GET RESPONSE **必须**保留 Le（去掉 STORE DATA 的 Le 时最容易手滑一起删）。
 * 反向：把 leHex 从返回值里抹掉，必须判红。
 */
function hasGetResponseLe(s) {
	const fn = /api\.getResponseApdu = function[\s\S]*?\n\t\};/.exec(s);
	if (!fn) return false;
	return /\+\s*leHex/.test(fn[0]);
}
ok('★ 反向2-b 现行 getResponseApdu 保留 Le', hasGetResponseLe(src));
ok('★ 反向2-c 把 GET RESPONSE 的 Le 也删掉时必须判红',
	hasGetResponseLe(src.replace("+ leHex;", ";")) === false);

/*
 * 检查 C：6881 必须有独立分支且不落 fatal。
 * 反向：把 6881 分支删掉（回到旧实现，落到 fatal 兜底），必须判红。
 */
/* 只在 6881 那个分支的局部判 level，不能全局搜 level: 'error'（别的 SW 分支也有，
   那样即使把 6881 分支删光也还是绿的 —— 守卫就没在检查） */
function hasChannelSwBranch(s) {
	return /sw === '6881'[\s\S]{0,260}?level: 'error'/.test(s);
}
ok('★ 反向3 现行 swInfo 有 6881/6A81 独立分支', hasChannelSwBranch(src));
ok('★ 反向3-a 删掉 6881 分支（回到旧实现）必须判红',
	hasChannelSwBranch(src.replace("if (sw === '6881' || sw === '6A81') {", "if (false) {")) === false);

/*
 * 检查 D：esim.js 必须把诊断码翻成中文给用户看（原来只有一句「请稍后重试」）。
 * 反向：换成旧的单句固定文案，必须判红。
 */
const ESIM_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'esim.js');
const esimSrc = fs.readFileSync(ESIM_JS, 'utf8');
/* ★ 2026-09-20 审计后锚点更新：主文案现在是 (detail || hint || '请稍后重试。')
   —— detail 是 probe 带回的 SW 矩阵人话（优先），hint 是按 code 查的 ERR_HINT，
   两者都在才算「把原因带进主文案」。 */
function hasReasonText(s) {
	return /ERR_HINT\s*=/.test(s)
		&& /EUICC_NO_EUICC\s*:/.test(s)
		&& /'读取 eSIM 信息失败：' \+ \(detail \|\| hint \|\| '请稍后重试。'\)/.test(s);
}
ok('★ 反向4 esim.js 把诊断码翻成中文并进主文案', hasReasonText(esimSrc));
ok('★ 反向4-a 退化成固定一句「请稍后重试」时必须判红',
	hasReasonText("var ERR_HINT = { EUICC_NO_EUICC: '这张卡上没有 ISD-R' };\n" +
		"card._body.appendChild(Mt5700.errorState('读取 eSIM 信息失败，请稍后重试。'));") === false);
ok('★ 反向4-b 只有映射但主文案不带原因时也必须判红',
	hasReasonText(esimSrc.replace("detail || hint || '请稍后重试。'", "'请稍后重试。'")) === false);

/* ---------- 收尾 ---------- */

asyncTests.reduce(function (chain, t) {
	return chain.then(t);
}, Promise.resolve()).then(function () {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	if (fails.length) {
		console.log('');
		fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
		process.exit(1);
	}
	console.log('eSIM 通道策略契约测试全部通过');
}).catch(function (e) {
	console.error('异步用例异常：' + (e && e.stack || e));
	process.exit(1);
});
