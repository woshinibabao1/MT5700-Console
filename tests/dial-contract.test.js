#!/usr/bin/env node
'use strict';

/**
 * 拨号设置契约测试
 *
 * 钉住三件「看着像配置问题、其实是界面没把话说清楚」的事，以及一个真 BUG。
 *
 *   ① **CID 0「未激活」是界面编出来的**
 *      实测（本机 2026-09-15）：`AT+CGACT?` 只返回 1、5、6、21~31，**没有 CID 0**。
 *      默认承载是 LTE 附着时由网络建立的，不归 CGACT 管（手册 7.1：cid 0 是注册
 *      必需的默认 PDP，不可删除）。旧代码 `ctx.active = !!actives[ctx.cid]` 把
 *      「CGACT 没报这一条」当成 false，界面就写「未激活」——同一次采样里
 *      `AT^NDISSTATQRY?` 明明是 `1,1,,,"IPV4",1,,,"IPV6"`（IPv4/IPv6 都拿到了）。
 *      改后没报到记为 null（不适用），渲染成「随附着建立」，也不再给激活/去激活
 *      按钮（对默认承载下发 AT+CGACT 要么 ERROR，要么动到不该这边管的承载）。
 *
 *   ② **APN 空不是没配，是使用签约值**
 *      手册 7.1 原话：「若该值为空，则使用签约值」。本机 CID 0/1 的 APN 都是空串，
 *      照样上网。原来渲染成「-」，看起来像漏配，改成「（签约值）」。
 *
 *   ③ **协议类型（IPv4/IPv6/IPv4v6）只有文本没有控件**
 *      手册 16.18 的 `AT^SETAUTODIAL=<enable>,<dial_mode>,[[<protocol>],...]`，
 *      `<protocol>` 取值 "IP"/"IPV6"/"IPV4V6"；本机实测 `^SETAUTODIAL:1,1,"IPV4V6",...`。
 *      旧界面只在状态徽章里把它读出来，没有任何控件能改 —— 补全下拉并写回命令。
 *
 *   ④ **dial_mode 少了 0**
 *      手册 16.18：0=模组内部拨号、1=上位机拨号（USB 数传）、2=上位机拨号（网口数传），
 *      举例就是 `AT^SETAUTODIAL=1,0`。旧代码只有 1/2，且 syncAutodialDefault 会把
 *      非 1/2 的值强行改写成 1 回写 UCI —— 等于偷偷改设备配置。
 *
 * 用法：node tests/dial-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DIAL_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/dial.js');
const dialJs = fs.readFileSync(DIAL_JS, 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

function extractFunction(src, signature) {
	const start = src.indexOf('function ' + signature);
	if (start < 0) return '';
	let depth = 0;
	for (let i = src.indexOf('{', start); i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	return '';
}

function countOf(needle) {
	return dialJs.split(needle).length - 1;
}

/* ---------- A. 自动拨号应答解析（真实执行） ---------- */

const parseFnSrc = extractFunction(dialJs, 'parseAutoDialResponse(raw)');
ok('能定位 parseAutoDialResponse', parseFnSrc.length > 0);

const parseAutoDialResponse = (function () {
	const box = vm.createContext({});
	return vm.runInContext(parseFnSrc + '\nparseAutoDialResponse;', box);
})();

/* 本机 2026-09-15 实测应答 */
const REAL_DIAL = '^SETAUTODIAL:1,1,"IPV4V6","","","",0\r\nOK';
/* 手册 16.18 查询语法里写的是 ^SETAUTODAIL:（少一个 I），举例却是 SETAUTODIAL: */
const MANUAL_DAIL = '^SETAUTODAIL:1,0,"IPV4V6","cmnet","user","pwd",2\r\nOK';

const realParsed = parseAutoDialResponse(REAL_DIAL);
ok('能解析本机实测应答', realParsed != null);
ok('实测：自动拨号已开启（enable=1）', realParsed && realParsed.enable === 1);
ok('实测：拨号方式 = 1（上位机拨号 / USB 数传）', realParsed && realParsed.dialMode === 1);
ok('实测：协议 = IPV4V6', realParsed && realParsed.protocol === 'IPV4V6');
ok('实测：APN 为空（使用签约值，不是解析失败）', realParsed && realParsed.apn === '');
ok('实测：鉴权 = 0（无鉴权）', realParsed && realParsed.authType === 0);

const dailParsed = parseAutoDialResponse(MANUAL_DAIL);
ok('兼容手册里的 ^SETAUTODAIL: 拼写（否则整页读不回配置）', dailParsed != null,
	'固件若回 ^SETAUTODAIL:，旧代码会当成解析失败');
ok('DAIL 拼写下 dial_mode=0 能读出来', dailParsed && dailParsed.dialMode === 0);
ok('DAIL 拼写下 APN/用户名/密码/鉴权齐全',
	dailParsed && dailParsed.apn === 'cmnet' && dailParsed.username === 'user' &&
	dailParsed.password === 'pwd' && dailParsed.authType === 2);

ok('无法识别的应答返回 null 而不是半截对象',
	parseAutoDialResponse('ERROR') === null && parseAutoDialResponse('') === null);

/* ---------- B. PDP 列表：CGACT 没报 ≠ 未激活 ---------- */

/* 本机 2026-09-15 实测（CID 21 那行为验证 21~31 过滤而补，其余为原样） */
const CGDCONT_SAMPLE = [
	'+CGDCONT: 0,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 1,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 5,"IPV4V6","ims","",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0',
	'+CGDCONT: 21,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0'
].join('\r\n') + '\r\nOK';

/* 实测：CGACT 报告里没有 CID 0 */
const CGACT_SAMPLE = [
	'+CGACT: 1,1',
	'+CGACT: 5,1',
	'+CGACT: 6,0',
	'+CGACT: 21,0',
	'+CGACT: 22,0'
].join('\r\n') + '\r\nOK';

function runFetchPdp(cgdcont, cgact) {
	const src = extractFunction(dialJs, 'fetchPDPContexts()');
	ok('能定位 fetchPDPContexts', src.length > 0);
	if (!src) return Promise.resolve(null);
	const box = {
		Ui: {
			sendCmd: function (cmd) {
				return Promise.resolve({
					success: true,
					data: cmd.indexOf('CGDCONT') >= 0
						? (cgdcont || CGDCONT_SAMPLE)
						: (cgact || CGACT_SAMPLE)
				});
			}
		},
		renderPDP: function () { },
		Mt5700: { error: function () { } },
		pdpList: null,
		console: console
	};
	vm.createContext(box);
	vm.runInContext(src + '\nglobalThis.__fetchPDP = fetchPDPContexts;', box);
	return Promise.resolve(box.__fetchPDP()).then(function () { return box.pdpList; });
}

runFetchPdp().then(function (list) {
	ok('PDP 列表解析成功', Array.isArray(list) && list.length > 0);
	if (!Array.isArray(list)) return finish();

	ok('CID 0（默认承载）仍然在列表里', list.some(function (c) { return c.cid === 0; }),
		'藏掉 CID 0 会堵死改默认承载 APN 的入口');
	ok('21~31 网络保留段被过滤', !list.some(function (c) { return c.cid >= 21; }));

	const cid0 = list.filter(function (c) { return c.cid === 0; })[0];
	ok('CID 0 在 CGACT 没报到时记为 null（不是 false）', cid0 && cid0.active === null,
		cid0 ? '实际 ' + cid0.active + '（false 会被渲染成「未激活」）' : '没有 CID 0');

	const cid1 = list.filter(function (c) { return c.cid === 1; })[0];
	ok('CGACT 明确报 1 的 CID 1 判为已激活', cid1 && cid1.active === true);
	/* 「报 0 → 未激活」这条另起合成样本验证，见文末（实测样本里没有 CID 6 的 CGDCONT） */

	/* ---------- C. 渲染语义（源码层，钉住写法不回退） ---------- */

	ok('不再用 !!actives[cid] 把「没报到」当未激活', !/!!actives\[ctx\.cid\]/.test(dialJs),
		'旧写法回来了，CID 0 又会显示成「未激活」');
	ok('改用 hasOwnProperty 区分「没报到」与「报了 0」',
		/hasOwnProperty\.call\(actives/.test(dialJs));
	ok('「随附着建立」文案只出现一次（防止注释里也有、断言恒真）',
		countOf('随附着建立') === 1, '实际 ' + countOf('随附着建立') + ' 次');
	ok('active 为 null 时不给激活 / 去激活按钮',
		/if \(ctx\.active !== null\) \{/.test(dialJs));
	ok('APN 为空显示「（签约值）」而不是「-」',
		/ctx\.apn \|\| '（签约值）'/.test(dialJs) && !/ctx\.apn \|\| '-'/.test(dialJs));

	/* ---------- D. 协议类型与拨号方式 ---------- */

	const normSrc = extractFunction(dialJs, 'normalizePdpType(type)');
	ok('能定位 normalizePdpType', normSrc.length > 0);
	const normalizePdpType = (function () {
		const box = vm.createContext({});
		return vm.runInContext(normSrc + '\nnormalizePdpType;', box);
	})();
	ok('IP / IPV6 / IPV4V6 原样保留',
		normalizePdpType('IP') === 'IP' && normalizePdpType('IPV6') === 'IPV6' &&
		normalizePdpType('IPV4V6') === 'IPV4V6');
	ok('手册外的取值（PPP/空/undefined）回落到 IPV4V6，避免 select 空选中',
		normalizePdpType('PPP') === 'IPV4V6' && normalizePdpType('') === 'IPV4V6' &&
		normalizePdpType(undefined) === 'IPV4V6');

	ok('APN 表单里新增了「协议类型」下拉',
		/Mt5700\.formGroup\('协议类型', protoSel/.test(dialJs));
	ok('协议下拉用手册 16.18 的三项取值',
		/\{ label: 'IPv4', value: 'IP' \}/.test(dialJs) &&
		/\{ label: 'IPv6', value: 'IPV6' \}/.test(dialJs) &&
		/\{ label: 'IPv4\/IPv6', value: 'IPV4V6' \}/.test(dialJs));
	ok('下发的 SETAUTODIAL 第 3 个参数取自下拉，而不是上次的旧值',
		/'AT\^SETAUTODIAL=' \+ enable \+ ',' \+ mode \+ ',"' \+ Parse\.sanitizeAtParam\(normalizePdpType\(apnForm\.protocol\)\)/.test(dialJs),
		'仍在使用 settings.protocol，改了下拉也不会下发');
	ok('协议变更后回写 settings.protocol（徽章跟着变）',
		/settings\.protocol = normalizePdpType\(apnForm\.protocol\);/.test(dialJs));
	ok('拨号方式补齐 0=模组内部拨号（手册 16.18 举例即 AT^SETAUTODIAL=1,0）',
		/\{ label: '模组内部拨号', value: 0 \}/.test(dialJs));
	ok('0 也有对应文案，不再显示「未知」', /0: '模组内部拨号'/.test(dialJs));
	ok('UCI 同步不再把 dial_mode=0 改写成 1',
		/if \(wantMode !== '0' && wantMode !== '1' && wantMode !== '2'\) wantMode = '1';/.test(dialJs),
		'仍会把 0 当成非法值改写成 1，等于偷偷改设备配置');

	/*
	 * 合成样本（**不是**实测值，仅用于补齐分支覆盖）：
	 * 实测的 CGACT 里有 `+CGACT: 6,0`，但实测 CGDCONT 里没有 CID 6 ——
	 * 列表里根本不会出现它，所以「报 0 → active === false」这条一直没被真正断言，
	 * 此前甚至留了一条 ok(..., true) 的**字面量恒真**断言（永远 pass，等于没覆盖）。
	 * 这里在实测样本里插一行 CID 6，把这条真正跑出来。
	 */
	const CGDCONT_WITH_CID6 = CGDCONT_SAMPLE.replace('\r\n+CGDCONT: 21',
		'\r\n+CGDCONT: 6,"IPV4V6","","",0,0,0,0,0,0,1,,,,,,0,,0,0,0,0\r\n+CGDCONT: 21');

	return runFetchPdp(CGDCONT_WITH_CID6, CGACT_SAMPLE);
}).then(function (list2) {
	const cid6 = (list2 || []).filter(function (c) { return c.cid === 6; })[0];
	ok('★ CGACT 明确报 0 的 CID 6 判为未激活（active === false，不是 null）',
		cid6 && cid6.active === false,
		cid6 ? '实际 ' + cid6.active + '（null 表示「CGACT 没报到」，语义不同）'
			: '列表里没有 CID 6，样本没生效');

	finish();
}).catch(function (err) {
	fails.push('PDP 列表解析抛出异常 —— ' + (err && err.message));
	finish();
});

function finish() {
	console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	if (fails.length) {
		console.log('');
		fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
		process.exit(1);
	}
	console.log('拨号设置契约测试全部通过');
}
