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
// 注意：必须提供 L.Class.extend —— 项目里 6 个库（parse/rpc/ui/mt5700/compat/smsEncode）
// 末尾都用 `var XxxClass = L.Class.extend(Xxx)` 收尾（LuCI 要求模块返回 Class 子类）。
// 早期这个桩只给了 view/rpc/uci，于是 parse.js:1045 一执行就 TypeError，
// 整个文件的用例一条都没跑到（v1.0 起就是这样，属于「测试看着有、其实没跑」）。
const sandbox = {
	window: {}, AtWs: undefined, Parse: undefined,
	L: {
		view: { extend: function (o) { return o; } },
		Class: {
			extend: function (proto) {
				function Klass() {}
				Klass.prototype = proto;
				return Klass;
			}
		},
		rpc: { declare: function () { return function () { return Promise.resolve({}); }; } },
		uci: { load: function () { return Promise.resolve(); }, get: function () { return ''; } }
	}
};
sandbox.window = sandbox;

function loadLib(name) {
	const code = fs.readFileSync(path.join(libDir, name), 'utf8');
	// 去掉 'use strict' 与 require 指令（node 单测不需要 LuCI 加载器）
	const cleaned = code
		.split('\n')
		.filter(function (l) { return l.indexOf("'require ") !== 0; })
		.join('\n');
	// 库文件按 LuCI 约定「顶层 return <Class>」，且把实例挂到 window.<Name> 上。
	// 所以不能靠 new Function 的返回值取值（顶层 return 会先返回，拼在后面的 return 是死代码）——
	// 必须把 window 传进去（`typeof window !== 'undefined'` 在 node 里为假，不传就不挂实例），
	// 执行完再从 sandbox 上取。
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
	// 先加载 parse.js（rpc.js 的 parseRawData 运行时引用全局 Parse），两者都把实例挂在 window 上
	const parse = loadLib('parse.js');
	const Parse = parse.Parse;
	check('parse.js 实例可用', !!Parse && typeof Parse.parseSimsq === 'function',
		Parse ? 'ok' : 'sandbox.Parse 未挂上');
	const ws = loadLib('rpc.js');
	const AtWs = ws.AtWs;
	check('rpc.js 实例可用', !!AtWs && typeof AtWs.parseRawData === 'function',
		AtWs ? 'ok' : 'sandbox.AtWs 未挂上');
	if (!Parse || !AtWs) throw new Error('库未能实例化，后续断言无意义');

	/* ---- 辅载波聚合：本文件此前的这一整块已删除 ----
	 * 它断言的是 parseMonsscAll / parseMonssc / parseCascellAll / carrierSignalFor /
	 * unmatchedSecondaries 五个函数，而「辅载波信号」这条路线已改为 ^NRSSBID，
	 * 这五个函数在解析层里**都不存在**。也就是说这一块断言早就调不到任何东西了——
	 * 再加上上面 loadLib 的两个桩缺陷，整份文件长期是「0 项通过」地静默挂着。
	 * NRSSBID / MONNC 的覆盖现在在 parse-contract.test.js（含服务波束、邻区、
	 * ARFCN→MHz、PCI 十六进制、无效码转 null、LTE 分支），不在这里重复。 */

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

	/* ---- SIMSQ ---- */
	/* 标签文案以 parse.js 的 SIM_STATUS（全项目唯一一份码表）为准：
	 *   12 = 卡初始化完成，短信与电话可接入
	 *   11 = 卡初始化完成，可接入网络  ← 本卡长期停在这一档
	 *   98 = 卡已失效（PUK 锁死或物理损坏）
	 * ★ 文案用「短信与电话」，**不写「电话本」**（用户拍板）——见下方断言。
	 * ★ 11 的文案必须交代「实测短信正常」：手册口径是「11 时短信与电话未接入」，
	 *   但本机实测 11 下收发短信完全正常，照抄手册会误导（2026-09-14 真机结论）。 */
	const sqReady = Parse.parseSimsq('^SIMSQ: 0,12');
	check('parseSimsq 完全就绪（12）', !!sqReady && sqReady.present === true && sqReady.dead === false
		&& sqReady.label === '卡初始化完成，短信与电话可接入', sqReady ? sqReady.label : 'null');

	const sq11 = Parse.parseSimsq('^SIMSQ: 1,11');
	check('parseSimsq 仅可接入网络（11）', !!sq11 && sq11.status === 11 && sq11.present === true && sq11.dead === false,
		sq11 ? sq11.label : 'null');
	check('11 与 12 的文案必须可区分', sq11.label !== sqReady.label, sq11.label + ' vs ' + sqReady.label);
	check('文案不出现「电话本」，统一写「电话」',
		sq11.label.indexOf('电话本') < 0 && sqReady.label.indexOf('电话本') < 0,
		sq11.label + ' / ' + sqReady.label);
	check('11 的文案写明「实测短信收发正常」（不能照抄手册的「未接入」吓唬人）',
		sq11.label.indexOf('实测 11 下短信收发正常') >= 0, sq11.label);

	/* ★ 11 不算告警：本卡常态，短信不受影响；0（未插卡）才要报警。
	 * 判据见 parse.js 的 SIM_STATUS_WARN。 */
	check('11 不触发告警提示色', Parse.simIsWarn(11) === false, String(Parse.simIsWarn(11)));
	check('12 不触发告警提示色', Parse.simIsWarn(12) === false, String(Parse.simIsWarn(12)));
	check('0（未插卡）触发告警提示色', Parse.simIsWarn(0) === true, String(Parse.simIsWarn(0)));
	check('98（卡失效）触发告警提示色', Parse.simIsWarn(98) === true, String(Parse.simIsWarn(98)));
	check('短标签里 11 不写「未就绪」', Parse.simShort(11).indexOf('未就绪') < 0, Parse.simShort(11));

	const sqDead = Parse.parseSimsq('^SIMSQ: 0,98');
	// 原版语义：present 只排除 0/99，98（失效）依然 present=true
	check('parseSimsq 失效', sqDead.dead === true && sqDead.present === true, sqDead ? sqDead.label : 'null');

	/* ---- rpc.js raw_data 拆分 REJINFO ---- */
	const parsed = AtWs.parseRawData('^REJINFO:46000,1,40,2,3,40,"0026F8","FF","0A444202"\r\n');
	const rejType = parsed.filter(function (p) { return p.type === 'REJINFO'; });
	check('parseRawData 拆分 REJINFO 类型', rejType.length === 1 && rejType[0].parsed && rejType[0].parsed.plmn === '46000',
		rejType.length + ' 条');
	/* ---- 数值健壮性：缺字段 / 带引号，都不能产出 NaN ----
	 * 这几条跑的是真实解析结果（不是正则匹配源码），因为 NaN 一旦漏出就会被
	 * 当成有效值一路显示到界面上（信号条宽度会变成 width:NaN%，功率显示成 0dBm）。
	 */

	const ncNoPci = Parse.parseMonncAll('^MONNC: NR,524910\r\n')[0];
	check('MONNC 缺 PCI 字段时给 null（不能是 NaN）',
		ncNoPci && ncNoPci.pci === null, 'pci=' + (ncNoPci && ncNoPci.pci));
	const ncTrail = Parse.parseMonncAll('^MONNC: NR,524910,100,\r\n')[0];
	check('MONNC 尾随逗号不会解析出 NaN',
		ncTrail && ncTrail.pci === 0x100 && !Number.isNaN(ncTrail.pci),
		'pci=' + (ncTrail && ncTrail.pci));

	const txEmpty = Parse.parseNrTxPower('^NTXPOWER: 1,2,3,,5');
	check('发射功率缺字段时给 null（不能算成 0dBm）',
		!txEmpty.length || txEmpty[0].prach === null,
		'prach=' + (txEmpty.length ? txEmpty[0].prach : 'n/a'));

	const rrcOne = Parse.parseRrcstat('^RRCSTAT: 1');
	check('RRC 只有单字段时状态文案不含 NaN',
		!!rrcOne && rrcOne.rrc === null && String(rrcOne.rrcText).indexOf('NaN') < 0,
		rrcOne ? String(rrcOne.rrcText) : 'null');

	/* 3GPP 字符串参数带引号：^MONSC 的 <sysmode> 会回 "NR" */
	const monQuoted = AtWs.parseMONSC('^MONSC: "NR",460,00,524910,1,C027F5065,114,14225C,-73,-9,24');
	check('MONSC 制式带引号时仍能识别为 NR',
		!!monQuoted && monQuoted.sysMode === 'NR', monQuoted ? monQuoted.sysMode : 'null');
	check('MONSC 带引号时字段不错位（PCI 按十六进制解出 276）',
		!!monQuoted && monQuoted.pci === 276, monQuoted ? String(monQuoted.pci) : 'null');
	check('MONSC 带引号时 RSRP 正常（-73，不是 NaN）',
		!!monQuoted && monQuoted.rsrp === -73, monQuoted ? String(monQuoted.rsrp) : 'null');
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
