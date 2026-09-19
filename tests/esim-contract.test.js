#!/usr/bin/env node
/*
 * eSIM 回执闭环 / 通知列表 / 误报成功加固 契约测试（纯 Node，绝不向真机下发任何 AT）
 * ---------------------------------------------------------------------------
 * 照抄 tests/euicc-download-contract.test.js:19-29 的正则 eval 方式把 euicc.js 整段
 * 抠出来在 Node 里真跑，覆盖 Proposer 的 P01–P09 里能用「静态断言 / 本地 mock」验证的
 * 部分（P10/P11/P12 等换卡 / 不改，本文件不覆盖）：
 *   - P02  api.listNotifications 只读列出，且**不**下发 BF2B/BF30（绝不顺手删）
 *   - P04  parseNotifications 解析出 iccid（nibble 已交换）/ opLabel；未知 operation 显示
 *          「操作 <n>」而非编造的「删除」；removeNotification 入参校验（非法 seqHex 抛
 *          EUICC_BAD_APDU）
 *   - P05  swInfo('6985').hint 不含「重试」
 *   - P06  es10Result('BF3100') === null（标识不识别当成功 → 误报，由 esim.js 分支纠正）
 *   - P08  cancelSession 发出路径 /gsma/rsp2/es9plus/cancelSession；HTTP 500 只 log 不抛；
 *          空 tx 抛 EUICC_BAD_APDU；downloadProfile 的 onStep 在 step 4 抛错时不再下发
 *          getBoundProfilePackage（后续 BPP 被中止）
 *   源码分支（esim.js）的 P01/P06/P07 判据用文本断言验证（正则匹配源码行）。
 *
 * 运行：node tests/esim-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EUICC_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'euicc.js');
const ESIM_JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'esim.js');
const euiccSrc = fs.readFileSync(EUICC_JS, 'utf8');
const esimSrc = fs.readFileSync(ESIM_JS, 'utf8');
const rpcSrc = fs.readFileSync(path.join(__dirname, '..', 'htdocs', 'luci-static',
	'resources', 'at-webserver', 'rpc.js'), 'utf8');

/* 同款正则 eval 加载 euicc.js（与 euicc-download-contract.test.js:23 一致） */
const m = euiccSrc.match(/var Euicc = \((function[\s\S]*?)\)\(\);/);
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

/* ---------- 1. P02：listNotifications 只读，绝不下发 BF2B / BF30 ---------- */

const notifListOne = Euicc.tlvHex('BF28', Euicc.tlvHex('A0', Euicc.tlvHex('BF2F',
	Euicc.tlvHex('80', '01') + Euicc.tlvHex('81', '00'))));

/* 卡侧 mock：记录所有下发的 APDU，便于断言「有没有发 BF2B/BF30」 */
function makeListCard() {
	const cmds = [];
	const st = { cmds: cmds };
	return {
		state: st,
		send: function (cmd) {
			cmds.push(cmd);
			const mm = /"([0-9A-Fa-f]*)"/.exec(cmd);
			const apdu = mm ? mm[1].toUpperCase() : '';
			if (apdu === '0070000001') return Promise.resolve({ success: true, data: '+CSIM: 6,"019000"' });
			if (apdu.indexOf('01A4040C10') === 0) return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
			if (apdu === '0070800100') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
			const body = apdu.substr(10, 4); /* 跳过 CLA INS P1 P2 LC */
			if (body === 'BF28') return Promise.resolve({ success: true, data: '+CSIM: ' + (notifListOne.length / 2) + ',"' + notifListOne + '9000"' });
			/* 关键的负向断言：listNotifications 绝不会走到 BF2B（handleNotification）/ BF30（Remove） */
			return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
		}
	};
}

asyncTests.push((function () {
	const card = makeListCard();
	return Euicc.listNotifications(card.send).then(function (r) {
		eq('P02 listNotifications 返回 {items:[…]}', r.items.length, 1);
		eq('P02 listNotifications 仅列出未删除', r.items[0].seqHex, '01');
		const sentBf2b = card.state.cmds.some(function (c) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(c);
			return mm && mm[1].toUpperCase().indexOf('BF2B') >= 0;
		});
		const sentBf30 = card.state.cmds.some(function (c) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(c);
			return mm && mm[1].toUpperCase().indexOf('BF30') >= 0;
		});
		ok('P02 listNotifications 未下发 BF2B（不顺便发回执）', !sentBf2b);
		ok('P02 listNotifications 未下发 BF30（不顺便删）', !sentBf30);
	});
})());

/* ---------- 2. P04：parseNotifications 补 iccid / opLabel ---------- */

function toHex(str) {
	let s = '';
	for (let i = 0; i < str.length; i++) s += ('0' + str.charCodeAt(i).toString(16)).slice(-2);
	return s.toUpperCase();
}
/* 一条带 5A(ICCID) 与 81=09(未知操作) 的通知 */
const notifWithIccid = Euicc.tlvHex('BF28', Euicc.tlvHex('A0', Euicc.tlvHex('BF2F',
	Euicc.tlvHex('80', '05') + Euicc.tlvHex('81', '09') + Euicc.tlvHex('5A', '9821138000717510') + Euicc.tlvHex('0C', toHex('smdp.example.com')))));

eq('P04 parseNotifications 解析 iccid（nibble 已交换）', (function () {
	const n = Euicc.parseNotifications(notifWithIccid);
	return n.length && n[0].iccid;
})(), Euicc.swapNibbles('9821138000717510'));
ok('P04 parseNotifications 未知 operation(09) 显示「操作 9」而非编造的「删除」', (function () {
	const n = Euicc.parseNotifications(notifWithIccid);
	return n.length && n[0].opLabel === '操作 9';
})());
ok('P04 parseNotifications 没有 5A 时 iccid 为空串', (function () {
	const n = Euicc.parseNotifications(notifListOne);
	return n.length && n[0].iccid === '';
})());
eq('P04 parseNotifications 发往地址来自卡上 0C', (function () {
	const n = Euicc.parseNotifications(notifWithIccid);
	return n.length && n[0].address;
})(), 'smdp.example.com');

/* ---------- 3. P04：removeNotification 入参校验 ---------- */

asyncTests.push(threw('P04 removeNotification(seqHex=\'XYZ\') 非法 → EUICC_BAD_APDU', function () {
	return Euicc.removeNotification(makeListCard().send, 'XYZ');
}, 'EUICC_BAD_APDU'));

asyncTests.push(threw('P04 removeNotification(seqHex 长度 6) 非法 → EUICC_BAD_APDU', function () {
	return Euicc.removeNotification(makeListCard().send, '012345');
}, 'EUICC_BAD_APDU'));

asyncTests.push((function () {
	/* 合法 seqHex 应下发改 removeNotificationFromList（BF30）且不抛 */
	const card = makeListCard();
	const seqHex = '0A';
	const bf30Resp = Euicc.tlvHex('BF30', '03' + '010203');
	return Euicc.removeNotification(card.send, seqHex).then(function (r) {
		ok('P04 removeNotification 合法 seqHex 成功返回', r && r.sw === '9000');
		const sentBf30 = card.state.cmds.some(function (c) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(c);
			return mm && mm[1].toUpperCase().indexOf('BF30') >= 0;
		});
		ok('P04 removeNotification 下发 BF30（RemoveNotificationFromList）', sentBf30);
	});
})());

/* ---------- 4. P05：swInfo('6985').hint 不含「重试」 ---------- */

ok('P05 swInfo(6985).hint 不含「重试」', (Euicc.swInfo('6985').hint || '').indexOf('重试') < 0,
	'实际: ' + (Euicc.swInfo('6985').hint || ''));
ok('P05 swInfo(6985).text 指向 M2M / 锁卡', /M2M|锁卡|SM-SR/.test(Euicc.swInfo('6985').text || ''));

/* ---------- 5. P06：es10Result('BF3100') === null（标识不识别当成功） ---------- */

eq('P06 es10Result(\'BF3100\') === null', Euicc.es10Result('BF3100'), null);
eq('P06 es10Result(\'BF3103800100\') === 0（对照，仍正确识别）', Euicc.es10Result('BF3103800100'), 0);

/* ---------- 6. P08：cancelSession ---------- */

/* 极简 ES9+ mock：记录 path */
function makeEs9p() {
	const calls = [];
	return {
		calls: calls,
		es9p: function (host, path, json) {
			calls.push({ host: host, path: path, json: json });
			return Promise.resolve({ success: true, status: 200, body: '{}' });
		}
	};
}

asyncTests.push((function () {
	const srv = makeEs9p();
	return Euicc.cancelSession(srv.es9p, 'rsp.example.com', 'TX-9').then(function (r) {
		eq('P08 cancelSession 路径 = /gsma/rsp2/es9plus/cancelSession', srv.calls[0].path, '/gsma/rsp2/es9plus/cancelSession');
		eq('P08 cancelSession 带 transactionId', JSON.parse(srv.calls[0].json).transactionId, 'TX-9');
		ok('P08 cancelSession HTTP 200 → ok', r.ok === true);
	});
})());

asyncTests.push(threw('P08 cancelSession 空 tx → EUICC_BAD_APDU', function () {
	return Euicc.cancelSession(makeEs9p().es9p, 'rsp.example.com', '');
}, 'EUICC_BAD_APDU'));

asyncTests.push((function () {
	/* HTTP 500 只 log 不抛（best-effort） */
	const calls = [];
	const srv = function (host, path, json) {
		calls.push({ host: host, path: path, json: json });
		return Promise.resolve({ success: true, status: 500, body: '{"message":"boom"}' });
	};
	return Euicc.cancelSession(srv, 'rsp.example.com', 'TX-9').then(function (r) {
		ok('P08 cancelSession HTTP 500 不抛，返回 ok=false', r.ok === false && typeof r.status === 'number');
	});
})());

/* ---------- 7. P08：downloadProfile 在 onStep 抛错后不再下发 getBoundProfilePackage ---------- */

asyncTests.push((function () {
	const CH = 1;
	const CHALLENGE = '0102030405060708';
	const BPP_BODY = 'AA'.repeat(400);
	function makeCard2() {
		const st = { cmds: [] };
		return {
			state: st,
			send: function (cmd) {
				st.cmds.push(cmd);
				const mm = /"([0-9A-Fa-f]*)"/.exec(cmd);
				const apdu = mm ? mm[1].toUpperCase() : '';
				if (apdu === '0070000001') return Promise.resolve({ success: true, data: '+CSIM: 6,"019000"' });
				if (apdu.indexOf('01A4040C10') === 0) return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				if (apdu === '0070800100') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				const body = apdu.substr(10, 4);
				if (body === 'BF2E') return Promise.resolve({ success: true, data: '+CSIM: ' + ('BF2E0A80 08'.replace(' ', '') + CHALLENGE).length / 2 + ',"' + 'BF2E0A80 08'.replace(' ', '') + CHALLENGE + '9000"' });
				if (body === 'BF20') return Promise.resolve({ success: true, data: '+CSIM: 12,"BF20030102039000"' });
				if (body === 'BF38') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				if (body === 'BF21') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				if (body === 'BF28') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				if (body === 'BF2B') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				if (body === 'BF30') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				const p1 = apdu.substr(4, 2);
				if (p1 === '11' || p1 === '91') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
				return Promise.resolve({ success: false, error: '未预期的 APDU ' + apdu });
			}
		};
	}
	function makeServer2() {
		const st = { calls: [] };
		return {
			state: st,
			es9p: function (host, path, json) {
				st.calls.push({ host: host, path: path, json: json });
				if (path.indexOf('initiateAuthentication') >= 0) {
					return Promise.resolve({ success: true, status: 200, body: JSON.stringify({
						transactionId: 'TX-1',
						serverSigned1: Euicc.hexToBase64('AABB'),
						serverSignature1: Euicc.hexToBase64('CCDD'),
						euiccCiPKIdToBeUsed: Euicc.hexToBase64('0102'),
						serverCertificate: Euicc.hexToBase64('EEFF')
					}) });
				}
				if (path.indexOf('authenticateClient') >= 0) {
					return Promise.resolve({ success: true, status: 200, body: JSON.stringify({
						smdpSigned2: Euicc.hexToBase64('1122'),
						smdpSignature2: Euicc.hexToBase64('3344'),
						smdpCertificate: Euicc.hexToBase64('5566')
					}) });
				}
				if (path.indexOf('getBoundProfilePackage') >= 0) {
					return Promise.resolve({ success: true, status: 200, body: JSON.stringify({ boundProfilePackage: Euicc.hexToBase64(BPP_BODY) }) });
				}
				return Promise.resolve({ success: true, status: 200, body: '{}' });
			}
		};
	}
	const card = makeCard2();
	const srv = makeServer2();
	/* P08：在 step 4（拿到 tx 之后、getBoundProfilePackage 之前）由 onStep 抛错，模拟用户取消 */
	let aborted = false;
	return Euicc.downloadProfile(card.send, srv.es9p, {
		activation: { smdp: 'rsp.example.com' },
		onStep: function (n) {
			if (n >= 4 && !aborted) { aborted = true; throw new Error('已取消'); }
		}
	}).then(function () {
		fails.push('P08 取消后 downloadProfile 应 reject，却 resolve 了');
	}, function () {
		pass++;
		const gotBpp = srv.state.calls.some(function (c) { return c.path.indexOf('getBoundProfilePackage') >= 0; });
		ok('P08 取消后不再下发 getBoundProfilePackage', !gotBpp);
	});
})());

/* ---------- 7b. R06：真 mock 行为断言——读操作每次只开一条 ISD-R 逻辑通道 ----------
 * 不靠源码正则，而是伪造 send 直接驱动 Euicc 业务用例，统计 MANAGE CHANNEL OPEN
 * （0070000001）的下发次数。R01/R03 的根因就是「并发开两条通道」——这里断言单次
 * listProfiles 恰好只开一条（无并发双开 / 无嵌套）。轮询的「最多 3 次」封顶由 esim.js
 * 闭包内的 attempt < 3 + backoff 约束（见上方源码断言），底层通道纪律则由本用例保证。 */
asyncTests.push((function () {
	const opens = { count: 0 };
	const card = {
		send: function (cmd) {
			const mm = /"([0-9A-Fa-f]*)"/.exec(cmd);
			const apdu = mm ? mm[1].toUpperCase() : '';
			if (apdu === '0070000001') opens.count++; /* MANAGE CHANNEL OPEN */
			if (apdu === '0070000001') return Promise.resolve({ success: true, data: '+CSIM: 6,"019000"' });
			if (apdu.indexOf('01A4040C10') === 0) return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
			if (apdu === '0070800100') return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
			return Promise.resolve({ success: true, data: '+CSIM: 6,"9000"' });
		}
	};
	opens.count = 0;
	return Euicc.listProfiles(card.send).then(function () {
		eq('R06 listProfiles 每次只读开一条 ISD-R 逻辑通道（无并发双开）', opens.count, 1);
	});
})());

/* ---------- 8. esim.js 源码分支判据（P01 / P06 / P07） ---------- */

ok('P01 esim.js 源码含回执异常判据（failed 或 total=0）', /nf\.failed\s*\|\|\s*!\(nf\s*&&\s*nf\.total/.test(esimSrc));
ok('P06 esim.js 源码含 result === null 分支', /r\s*&&\s*r\.result\s*===\s*null/.test(esimSrc));
ok('P07 esim.js 源码含有限轮询封顶（attempt < 3）', /attempt\s*<\s*3/.test(esimSrc));
/* R06：匹配字面按钮构造而非通用词，避免命中失败提示文案 */
ok('P07 esim.js 源码含「刷新列表」按钮（Mt5700.ghostButton 字面）', /Mt5700\.ghostButton\('刷新列表'/.test(esimSrc));
ok('P07 esim.js 源码含退避序列 backoff=[6000,12000,24000]', /backoff\s*=\s*\[6000,\s*12000,\s*24000\]/.test(esimSrc));
ok('P02 esim.js 源码含 showPendingReceipts 调用', /showPendingReceipts\(\)/.test(esimSrc));
ok('P04 esim.js 源码含 移除 二次确认文案', /移除回执不可逆/.test(esimSrc));
ok('R02 esim.js 源码已删除逐行发送按钮（无 sendNotification）', !/sendNotification/.test(esimSrc));

/* ---------- 9. 256 字节截断必须被识别成「设备做不到」，不许赖到我们自己头上 ----------
 *
 * ★ 起因（2026-09-19 真机实测，H5000M + 真 eUICC）：AT+CSIM 单条响应只有 256 字节，
 *   AuthenticateServer 需要 1631 字节 → 拿到的是残片。旧实现没有识别，残片被当完整
 *   响应发给服务器，页面显示「下发的数据卡片读不懂（本地 TLV 组装有误）」，
 *   把**固件的能力上限报成了我们自己的组包 bug**，排查方向被彻底带偏。
 *
 *   判据：
 *   A. euicc.js 在拿到数据后先比对 TLV 声明长度，命中抛 EUICC_CSIM_TRUNCATED；
 *   B. esim.js 的 handleErr 必须给 EUICC_CSIM_TRUNCATED 一个**独立分支**——
 *      落到 else 只会显示裸 message，用户看不出「这是设备做不到」，会反复重试；
 *   C. swInfo('6A80') 的文案不得再写死「本地 TLV 组装有误」。
 */

function hasTruncationGuard(src) {
	/*
	 * 要素式守卫：拆成五个必要条件，缺任一即判红。
	 *
	 * ★ 为什么不用「首尾锚定 + [\s\S]{0,200}? 字符距离」那种写法：
	 *   它同时对两件事敏感 —— 中间插入注释/判据会把距离撑爆（静默不匹配 → 假红），
	 *   而只锚首尾又会漏掉中间的比对条件（改坏恒假照样绿）。
	 *   2026-09-20 真的踩到了：给守卫加 TRANSPORT 判据后它立刻假红。
	 *   要素式对排版不敏感，只认「这几件事都做了没有」，两个方向都守得住。
	 */
	var hasWant = /var want\s*=\s*api\.tlvTotalBytes\(/.test(src);
	var hasGot = /var got\s*=\s*data\.length\s*\/\s*2/.test(src);
	var hasCmp = /got\s*<\s*want/.test(src);
	var hasBoundary = /got\s*%\s*CSIM_MAX_RESPONSE_BYTES\s*\)\s*===\s*0/.test(src);
	var hasThrow = /EUICC_CSIM_TRUNCATED/.test(src);
	return hasWant && hasGot && hasCmp && hasBoundary && hasThrow;
}
function hasTruncationBranch(src) {
	/* handleErr 里的独立分支 */
	return /code === 'EUICC_CSIM_TRUNCATED'/.test(src);
}

ok('A1 euicc.js 有 TLV 声明长度比对 + 抛 EUICC_CSIM_TRUNCATED 的守卫', hasTruncationGuard(euiccSrc));
/*
 * ★ 反向用例必须用**全局**替换：CSIM_MAX_RESPONSE_BYTES / EUICC_CSIM_TRUNCATED
 *   在文件里都出现多次（常量定义、ERR_CODES、抛错处），String.replace 只换第一个，
 *   打不到守卫本体 —— 那样反向用例会「看起来在测、其实恒绿」。
 */
function replaceAll(src, from, to) {
	return src.split(from).join(to);
}

ok('A2 反向：把比对条件换成恒假必须判红',
	hasTruncationGuard(replaceAll(euiccSrc, 'got < want', 'false')) === false);
ok('A3 反向：去掉 256 边界判据必须判红',
	hasTruncationGuard(replaceAll(euiccSrc, 'CSIM_MAX_RESPONSE_BYTES', '__NOPE__')) === false);
ok('A4 反向：去掉抛错必须判红',
	hasTruncationGuard(replaceAll(euiccSrc, 'EUICC_CSIM_TRUNCATED', '__NOPE__')) === false);

ok('B1 esim.js handleErr 有 EUICC_CSIM_TRUNCATED 独立分支', hasTruncationBranch(esimSrc));
ok('B2 反向：删掉该分支（回到裸 message）必须判红',
	hasTruncationBranch(esimSrc.replace("code === 'EUICC_CSIM_TRUNCATED'", "code === '__NEVER__'")) === false);

const sw6a80 = Euicc.swInfo('6A80');
ok('C1 swInfo(6A80) 文案不再写死「本地 TLV 组装有误」',
	!/本地 TLV 组装有误/.test(sw6a80.text || ''), sw6a80.text);
ok('C2 swInfo(6A80) 文案点出「不完整」这个真实可能',
	/不完整/.test(sw6a80.text || ''), sw6a80.text);

/* ---------- D. APDU 双通路（2026-09-20） ----------
 *
 * 钉的是「两条通路并存时的契约」：
 *   - euicc.js 必须同时具备 csim 与 cgla 两套命令/解析，且能被 setTransport 切换；
 *   - 前端必须把当前通路显示出来（走 CSIM 时下载不可用，不能让用户瞎重试）。
 * 反向用例：改坏任一条都要判红（静态守卫的老毛病：恒绿的摆设比没有更危险）。
 *
 * ★ 2026-09-20 删掉了这一组里原来 5 条 lpac 相关断言（D6~D9/D11）。
 *   路线已定为全自研：lpac 的 stdio 驱动在本设备不可用（SSH exec 通道 stdin 立刻 EOF）、
 *   at 后端又因 `=?` 假阴性超时，相关 ubus 方法 / rpc / 前端探测一并删除，
 *   留下的断言会变成「钉住一段没人用的死代码」，所以跟着删。
 */

function hasApduTransport(src) {
	return /api\.cglaCommand\s*=/.test(src) &&
		/api\.parseCglaAnswer\s*=/.test(src) &&
		/api\.csimCommand\s*=/.test(src) &&
		/api\.parseCsimAnswer\s*=/.test(src) &&
		/api\.setTransport\s*=/.test(src) &&
		/api\.detectTransport\s*=/.test(src);
}
ok('D1 euicc.js 同时具备 CSIM / CGLA 两套命令与解析，且可切换',
	hasApduTransport(euiccSrc));
ok('D2 反向：删掉 cglaCommand 必须判红',
	hasApduTransport(replaceAll(euiccSrc, 'api.cglaCommand', 'api.__NOPE__')) === false);
ok('D3 反向：删掉 detectTransport 必须判红',
	hasApduTransport(replaceAll(euiccSrc, 'api.detectTransport', 'api.__NOPE__')) === false);
ok('D4 euicc.js 走 CGLA 时不发 MANAGE CHANNEL（模组自己管通道）',
	/TRANSPORT === 'cgla'[\s\S]{0,200}?Promise\.resolve\(1\)/.test(euiccSrc));
ok('D5 反向：CGLA 分支若改回显式 open 必须判红',
	/Promise\.resolve\(1\)/.test(replaceAll(euiccSrc, 'Promise.resolve(1)', '__NOPE__')) === false);

/* ucode：ES9+ 转发必须还在，且不再有任何 lpac 残留（全自研路线） */
const ucSrc = fs.readFileSync(path.join(__dirname, '..', 'root', 'usr', 'share',
	'rpcd', 'ucode', 'mt5700.uc'), 'utf8');
ok('D6 ucode 仍暴露 mt5700.es9p（下载必需的 HTTPS 转发）', /es9p:\s*\{/.test(ucSrc));
ok('D7 ucode 已无 lpac 残留（全自研，不引入第三方二进制）',
	!/lpac/i.test(ucSrc) && !/function lpacAvailable/.test(ucSrc));
/* 反向自检：往源码里塞回一个 lpac 字样，D7 的正则必须能抓到（否则它是恒绿摆设） */
ok('D8 反向自检：ucode 若重新出现 lpac，D7 的守卫必须判红',
	!/lpac/i.test(ucSrc) && /lpac/i.test(ucSrc + '\nfunction lpacAvailable() {}'));

/* rpc.js / esim.js：自研链路的承接 */
ok('D9 rpc.js 已无 lpac 探测（只留自研的 es9p）',
	!/lpacAvailable/.test(rpcSrc) && !/method: 'lpac'/.test(rpcSrc));
ok('D10 esim.js 展示当前 APDU 通路（CSIM 时点明下载不可用）',
	/APDU 通路：/.test(esimSrc) && /下载不可用/.test(esimSrc));
ok('D11 esim.js 已无 lpac 探测残留', !/probeLpac/.test(esimSrc));

/* ---------- E. 卡容量展示（2026-09-20） ----------
 *
 * 钉的是「容量只能来自 EUICCInfo2，且不许编造总量」：
 *   - euicc.js 必须发 BF22（BF3C 是 GetEuiccConfiguredAddresses，不是 Info2 —— 踩过）；
 *   - 必须能解析 84 里的 81/82/83；
 *   - 前端必须展示剩余量，且**不得**出现「总容量 / 百分比」这类编造出来的分母。
 */
ok('E1 euicc.js 的 ES10b tag 白名单含 BF22（EUICCInfo2）',
	/ES10B_TAGS\s*=\s*\[[^\]]*'BF22'/.test(euiccSrc));
ok('E2 euicc.js 有 buildGetEuiccInfo2 且发 BF22',
	/api\.buildGetEuiccInfo2\s*=\s*function[^;]*BF22/.test(euiccSrc));
ok('E3 反向：把 BF22 换成 BF3C 必须判红（BF3C 是配置地址，不是容量）',
	/api\.buildGetEuiccInfo2\s*=\s*function[^;]*BF22/
		.test(replaceAll(euiccSrc, "'BF22'", "'BF3C'")) === false);
ok('E4 euicc.js 解析 extCardResource（84 容器 + 81/82/83 三个子字段）',
	/api\.parseExtCardResource\s*=/.test(euiccSrc) &&
	/pickTagValue\(info2Hex, '84'\)/.test(euiccSrc) &&
	/pickTagValue\(blob, '81'\)/.test(euiccSrc) &&
	/pickTagValue\(blob, '82'\)/.test(euiccSrc) &&
	/pickTagValue\(blob, '83'\)/.test(euiccSrc));
ok('E5 反向：解析函数若漏掉 82（剩余非易失内存）必须判红',
	/pickTagValue\(blob, '82'\)/.test(replaceAll(euiccSrc, "pickTagValue(blob, '82')", '__NOPE__')) === false);
ok('E6 probe 带回 capacity；取不到时降级为 null，绝不让整页报错',
	/capacity:\s*info\.capacity \|\| null/.test(euiccSrc) &&
	/capacity: null/.test(euiccSrc));
ok('E7 esim.js 展示剩余量，并明确「卡不给总容量」（不编造分母/百分比）',
	/剩余非易失存储/.test(esimSrc) && /剩余易失存储/.test(esimSrc) &&
	/不给总容量/.test(esimSrc));
ok('E8 esim.js 在卡未上报容量时给出明确说明（不静默留空）',
	/未在 EUICCInfo2 中上报 extCardResource/.test(esimSrc));

/* ---------- 汇总 ---------- */

Promise.all(asyncTests).then(function () {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	if (fails.length) {
		console.log('');
		fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
		process.exit(1);
	}
	console.log('esim 契约测试全部通过（P01–P09 静态 / mock 断言）');
}).catch(function (e) {
	console.error('异步用例异常：' + (e && e.stack || e));
	process.exit(1);
});
