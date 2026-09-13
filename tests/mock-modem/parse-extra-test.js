'use strict';
/**
 * 前端解析层单测（node 环境模拟浏览器加载 rpc.js / parse.js）：
 * 覆盖"全部移植"新增的解析函数：辅载波聚合（MONSSC/CASCELLINFO）、REJINFO、SIMSQ。
 * 运行：node parse-extra-test.js
 */

const fs = require('fs');
const path = require('path');

const libDir = path.join(__dirname, '..', '..', 'htdocs', 'luci-static', 'resources', 'at-webserver');

// 用 Function 模拟 LuCI 全局环境加载两个库文件
const sandbox = {
	window: {}, AtWs: undefined, Parse: undefined,
	L: {
		view: { extend: function (o) { return o; } },
		// parse.js 结尾用 L.Class.extend(Parse) 产出类再 new 出一个单例，
		// 缺这个桩整个文件会因为 "Cannot read properties of undefined (reading 'extend')"
		// 直接崩掉——之前就是这么静默失效的，本文件一度「0 项通过」却没人发现。
		Class: { extend: function (o) { return function () { return o; }; } },
		rpc: { declare: function () { return function () { return Promise.resolve({}); }; } },
		uci: { load: function () { return Promise.resolve(); }, get: function () { return ''; } }
	}
};
sandbox.window = sandbox;

/*
 * 库文件是 LuCI 约定：顶层 `return <Class>`，同时把实例挂到 window.Parse / window.AtWs 上。
 * 所以不能靠 new Function 的返回值取值（顶层 return 会先返回 Class）——
 * 执行完再从 sandbox 上取（sandbox.window === sandbox）。
 */
function loadLib(name) {
	const code = fs.readFileSync(path.join(libDir, name), 'utf8');
	// 去掉 'use strict' 与 require 指令（node 单测不需要 LuCI 加载器）
	const cleaned = code
		.split('\n')
		.filter(function (l) { return l.indexOf("'require ") !== 0; })
		.join('\n');
	// 'window' 必须作为参数传入：库里是 `if (typeof window !== 'undefined') window.Parse = ...`，
	// 不传的话 node 里 typeof window === 'undefined'，分支不进 → 实例挂不上。
	const fn = new Function('AtWs', 'Parse', 'E', 'L', 'window', cleaned);
	fn(sandbox.AtWs, sandbox.Parse, function () { return { appendChild: function () {} }; }, sandbox.L, sandbox);
	return { Parse: sandbox.Parse, AtWs: sandbox.AtWs };
}

let results = [];
function check(name, cond, detail) {
	results.push({ name: name, ok: !!cond, detail: detail || '' });
	console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
}

try {
	// 先加载 parse.js（rpc.js 依赖全局 Parse），两者都往 window.* 上挂实例
	const parseLib = loadLib('parse.js');
	const Parse = parseLib.Parse;
	check('parse.js 实例可用', !!Parse && typeof Parse.parseSimsq === 'function' && typeof Parse.parseCpin === 'function',
		Parse ? 'ok' : 'sandbox.Parse 未挂上');
	const wsLib = loadLib('rpc.js');
	const AtWs = wsLib.AtWs;
	check('rpc.js 实例可用', !!AtWs && typeof AtWs.parseRawData === 'function',
		AtWs ? 'ok' : 'sandbox.AtWs 未挂上');
	if (!Parse || !AtWs) throw new Error('库未能实例化，后续断言无意义');

	/* ---- 辅载波 ----
	 * ^MONSSC / ^CASCELLINFO 那套（parseMonsscAll / parseCascellAll / carrierSignalFor /
	 * unmatchedSecondaries）已随「辅载波信号改用 ^NRSSBID」整体删除，本文件里对应的断言
	 * 也随之删掉 —— 它们调用的四个函数在解析层早已不存在，整份文件一直是
	 * 「0 项通过」地静默挂着，谁也没发现。NRSSBID 的覆盖见 parse-contract.test.js。 */

	/* ---- REJINFO ---- */
	const rejLine = '^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"';
	const rej = Parse.parseRejInfo(rejLine);
	check('parseRejInfo 解析', !!rej && rej.plmn === '46000' && rej.domainText === 'PS 域', rej ? rej.plmn + ' ' + rej.domainText : 'null');
	check('REJINFO 原因与类型', rej.causeText === '没有激活的 EPS 承载' && rej.rejectTypeText === '网络 detach 被拒' && rej.ratText === 'E-UTRAN(4G)',
		rej.causeText + ' / ' + rej.rejectTypeText + ' / ' + rej.ratText);
	check('REJINFO 小区信息', rej.lac === '0026F8' && rej.cellId === '0A444202', rej.lac + ' / ' + rej.cellId);
	// 全角冒号也要能收（手册正文写法）
	const rejFull = Parse.parseRejInfo('^REJINFO：46000,1,40,2,3,40,"0026F8","FF","0A444202"');
	check('REJINFO 全角冒号兼容', !!rejFull && rejFull.plmn === '46000', rejFull ? 'ok' : 'null');
	// USIM 鉴权扩展原因
	check('REJINFO USIM 原因', Parse.rejectCauseText(65537) === 'USIM 鉴权失败（#65537）', Parse.rejectCauseText(65537));

	/* ---- SIMSQ ----
	 * 码表以手册 6.6 <sim_status> 为准，语义对照 WTModem mt5700m.sh::chkSimExt 校准。
	 * 全项目只有 parse.js 一份码表（mt5700.js / network_status.js / modem_settings.js 都读它），
	 * 这里钉死关键语义：只有 12 算就绪，1「已插卡」只是物理到位，不能当正常。 */
	const sq = Parse.parseSimsq('^SIMSQ: 0,12\r\nOK');
	check('parseSimsq 就绪 12', !!sq && sq.short === '就绪' && sq.healthy === true && sq.present === true,
		sq ? sq.short + '/' + sq.healthy : 'null');
	const sqDead = Parse.parseSimsq('^SIMSQ: 0,98');
	// 原版语义：present 只排除 0/99，98（失效）依然 present=true
	check('parseSimsq 失效 98', sqDead.dead === true && sqDead.present === true && sqDead.healthy === false,
		sqDead ? sqDead.short : 'null');
	const sqInserted = Parse.parseSimsq('^SIMSQ: 1,1');
	check('parseSimsq 已插卡(1)不算健康', sqInserted.short === '已插卡' && sqInserted.healthy === false,
		sqInserted ? sqInserted.short : 'null');
	const sq11 = Parse.parseSimsq('^SIMSQ: 1,11');
	check('parseSimsq 已初始化(11)不算健康', sq11.short === '已初始化' && sq11.healthy === false
		&& sq11.label.indexOf('短信与电话尚未接入') >= 0, sq11 ? sq11.label : 'null');
	const sqUnknown = Parse.parseSimsq('^SIMSQ: 1,77');
	check('parseSimsq 未知码不误判为健康', sqUnknown.healthy === false && sqUnknown.short === '状态 77',
		sqUnknown ? sqUnknown.short : 'null');
	check('parseSimsq 解析不出返回 null', Parse.parseSimsq('ERROR') === null);

	/* 真机样本直塞（tests/mock-modem/real-samples.txt 里记录的原始字节，
	   含 \r\n 与尾随 OK）：确保交付格式变化不会影响三个调用点 */
	const realSimsq = '^SIMSQ: 1,11\r\nOK';
	const realSq = Parse.parseSimsq(realSimsq);
	check('真机 ^SIMSQ: 1,11 → 已初始化且不健康',
		!!realSq && realSq.status === 11 && realSq.short === '已初始化' && realSq.healthy === false,
		realSq ? realSq.short + '/' + realSq.detail : 'null');
	const realCpin = '+CPIN: READY\r\nOK';
	const realPin = Parse.parseCpin(realCpin);
	check('真机 +CPIN: READY → ready=true', !!realPin && realPin.ready === true && realPin.blocked === false,
		realPin ? realPin.label : 'null');

	/* ---- CPIN ----
	 * 参照 WTModem mt5700m.sh::sim_pin_chk。两个坑：
	 *   1) 模组可能回 "+CPIN: SIM PUK"（带空格），旧正则 \w+ 只能抓到 "SIM"；
	 *   2) 旧代码把非 READY 反写成 READY，把最要命的锁卡状态盖掉了。 */
	const pinReady = Parse.parseCpin('+CPIN: READY\r\nOK');
	check('parseCpin READY', !!pinReady && pinReady.ready === true && pinReady.blocked === false,
		pinReady ? pinReady.label : 'null');
	const pinWait = Parse.parseCpin('+CPIN: SIM PIN\r\nOK');
	check('parseCpin 等待 PIN（带空格）', !!pinWait && pinWait.ready === false && pinWait.needPin === true
		&& pinWait.label === '等待输入 PIN', pinWait ? pinWait.label : 'null');
	const pinWait2 = Parse.parseCpin('+CPIN: SIMPIN\r\nOK');
	check('parseCpin 等待 PIN（无空格）', !!pinWait2 && pinWait2.needPin === true,
		pinWait2 ? pinWait2.label : 'null');
	const puk = Parse.parseCpin('+CPIN: SIM PUK\r\nOK');
	check('parseCpin PUK（带空格不被截断）', !!puk && puk.needPuk === true
		&& puk.code === 'SIM PUK' && puk.label.indexOf('PUK') >= 0, puk ? puk.code + '/' + puk.label : 'null');
	const puk2 = Parse.parseCpin('+CPIN: SIMPUK2');
	check('parseCpin PUK2（无空格也认得）', !!puk2 && puk2.needPuk === true, puk2 ? puk2.label : 'null');
	const pinOdd = Parse.parseCpin('+CPIN: PH-NET PIN');
	check('parseCpin 网络个人码', !!pinOdd && pinOdd.needPin === true && pinOdd.blocked === true,
		pinOdd ? pinOdd.label : 'null');
	const pinUnkown = Parse.parseCpin('+CPIN: WEIRD');
	check('parseCpin 未知码按「需处理」而非 READY', !!pinUnkown && pinUnkown.ready === false
		&& pinUnkown.blocked === true, pinUnkown ? pinUnkown.code : 'null');
	check('parseCpin 解析不出返回 null', Parse.parseCpin('ERROR') === null);

	/* ---- rpc.js raw_data 拆分 REJINFO ---- */
	const parsed = AtWs.parseRawData('^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"\r\n');
	const rejType = parsed.filter(function (p) { return p.type === 'REJINFO'; });
	check('parseRawData 拆分 REJINFO 类型', rejType.length === 1 && rejType[0].parsed && rejType[0].parsed.plmn === '46000',
		rejType.length + ' 条');

	/* ---- 调用点取值契约 ----
	 * 复刻三个调用点真正用到的字段表达式。目的不是测解析器本身，而是防
	 * 「parse 返回结构改了 → 页面上静默渲染 undefined」，这比看错码表更难发现：
	 * 页面不报错、不标黄，只是字是空的。这里把取值路径钉死，改结构必须连测一起改。
	 *   mt5700.js         → sq.short / sq.healthy / sq.detail
	 *   network_status.js → sq.detail / sq.healthy、pin.ready / pin.label
	 *   modem_settings.js → sq.label / pin.label */
	const ca = Parse.parseSimsq('^SIMSQ: 1,12\r\nOK');
	check('调用点 mt5700.js：short/healthy/detail 三个字段都有值',
		!!ca && typeof ca.short === 'string' && ca.short.length > 0
		&& ca.healthy === true
		&& typeof ca.detail === 'string' && ca.detail.length > 0,
		ca ? ca.short + ' / ' + ca.detail : 'null');
	const cb = Parse.parseSimsq('^SIMSQ: 1,98');
	check('调用点 network_status.js：detail 非空且 healthy=false（要标黄）',
		!!cb && typeof cb.detail === 'string' && cb.detail.length > 0 && cb.healthy === false
		&& typeof cb.dead === 'boolean',
		cb ? cb.detail : 'null');
	const cc = Parse.parseSimsq('^SIMSQ: 1,11');
	check('调用点 modem_settings.js：label 非空且 dead 有值',
		!!cc && typeof cc.label === 'string' && cc.label.length > 0 && typeof cc.dead === 'boolean',
		cc ? cc.label : 'null');
	const pa = Parse.parseCpin('+CPIN: SIM PUK\r\nOK');
	check('调用点 network_status.js：pin.label 非空且 ready=false',
		!!pa && typeof pa.label === 'string' && pa.label.length > 0 && pa.ready === false,
		pa ? pa.label : 'null');
	const pb = Parse.parseCpin('+CPIN: READY\r\nOK');
	check('调用点 modem_settings.js：pin.label 非空且 ready=true',
		!!pb && typeof pb.label === 'string' && pb.label.length > 0 && pb.ready === true,
		pb ? pb.label : 'null');
} catch (e) {
	check('单测执行', false, String(e && e.stack || e));
}

const fails = results.filter(function (r) { return !r.ok; });
console.log('\n===== 结果: ' + (results.length - fails.length) + '/' + results.length + ' 通过 =====');
if (fails.length) {
	fails.forEach(function (f) { console.log('FAILED: ' + f.name + ' — ' + f.detail); });
	process.exit(1);
}
process.exit(0);
