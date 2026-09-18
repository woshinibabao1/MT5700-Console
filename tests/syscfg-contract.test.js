#!/usr/bin/env node
'use strict';

/**
 * 网络系统配置（AT^SYSCFGEX）契约测试
 *
 * 钉住三件容易被写错、且写错后果严重的事：
 *
 *   ① **漫游有两套语义，同一数值含义可以完全相反**
 *      手册 13.2.3：NV 项「漫游特性」未激活时取值 0-2（0 不支持漫游 / 1 支持 /
 *      2 无变化）；激活后取值 0-3（0 开启国内国际 / 1 开国内关国际 /
 *      2 关国内开国际 / 3 全关）。注意 **0 在前者是「禁止」、在后者是「全开」**。
 *      因此下拉项必须由 AT^SYSCFGEX=? 实报的范围决定。
 *      本机实测 =? 返回 (0-2)，即基础语义 —— 写死 0-3 那套会把意思显示反。
 *
 *   ② **服务域有官方硬约束**
 *      手册 13.2.3 注 2：接入制式含 LTE(03) 或 NR(08) 时，服务域不允许设为 0 或 3。
 *      这条只写在文档里，界面不体现的话用户会选完被模组默默拒绝。
 *
 *   ③ **未读回模组原值前不允许保存**
 *      SYSCFGEX 是一次性下发整组参数的接口，把空值写下去等于让模组不搜任何网络。
 *
 * 用法：node tests/syscfg-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs/luci-static/resources');
const MODEM_JS = path.join(RES, 'view/at-webserver/modem_settings.js');

const modemJs = fs.readFileSync(MODEM_JS, 'utf8');

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

function loadLuciModule(relPath, returnExpr) {
	let src = fs.readFileSync(path.join(RES, 'at-webserver', relPath), 'utf8');
	src = src.replace(/^\s*'require [^']*';\s*$/gm, '');
	const ctx = {
		console,
		L: {
			Class: { extend: (x) => x },
			rpc: { declare: () => function () { return Promise.resolve({}); } },
			uci: { load: () => Promise.resolve() }
		},
		window: undefined
	};
	vm.createContext(ctx);
	return vm.runInContext('(function(){\n' + src + '\nreturn ' + returnExpr + ';\n})()', ctx);
}

const Parse = loadLuciModule('parse.js', 'Parse');

/* ---------- A. 取值范围解析（决定漫游用哪套语义） ---------- */

/* 本机 2026-09-15 实采 */
const TEST_REPLY = '^SYSCFGEX: ("01","02","03","08"),'
	+ '((2000000400380,"GSM900/GSM1800/WCDMA900/WCDMA2100"),(280000,"GSM850/GSM1900"),(3fffffff,"All bands")),'
	+ '(0-2),(0-4),'
	+ '((1e200000095,"LTE BC1/LTE BC3/LTE BC5/LTE BC8/LTE BC34/LTE BC38/LTE BC39/LTE BC40/LTE BC41"),(7fffffffffffffff,"All bands"))';

const ranges = Parse.parseSysCfgRanges(TEST_REPLY);
ok('^SYSCFGEX=? 能解析出漫游范围', ranges.roam != null);
ok('本机漫游范围是 0-2（基础语义）',
	ranges.roam && ranges.roam.min === 0 && ranges.roam.max === 2,
	JSON.stringify(ranges.roam));
ok('服务域范围是 0-4',
	ranges.srvdomain && ranges.srvdomain.min === 0 && ranges.srvdomain.max === 4,
	JSON.stringify(ranges.srvdomain));

/* 已激活漫游特性的设备：范围应为 0-3，跳到国内/国际语义 */
const RANGES_03 = Parse.parseSysCfgRanges('^SYSCFGEX: ("01","02","03","08"),(...),(0-3),(0-4),(...)');
ok('范围 0-3 也能正确解析', RANGES_03.roam && RANGES_03.roam.max === 3);

/* ---------- B. 漫游选项随范围切换语义 ---------- */

const opts2 = Parse.roamOptions(2);
ok('范围 0-2 → 3 个选项', opts2.length === 3, '实际 ' + opts2.length);
ok('范围 0-2 用基础语义（0 = 不允许漫游）',
	opts2[0].value === '0' && /不允许漫游/.test(opts2[0].label) && !/国内/.test(opts2[0].label),
	opts2[0] && opts2[0].label);

const opts3 = Parse.roamOptions(3);
ok('范围 0-3 → 4 个选项', opts3.length === 4, '实际 ' + opts3.length);
ok('范围 0-3 用国内/国际语义（0 = 国内 + 国际都允许）',
	opts3[0].value === '0' && /国内 \+ 国际都允许/.test(opts3[0].label),
	opts3[0] && opts3[0].label);

/*
 * 国内 / 国际四档必须齐全：2×2 的四种组合（国内×国际）一个都不能少，
 * 否则用户想「只开国际漫游」这类组合时根本选不到。这条钉的是「选项不全」，
 * 与下面「本机只有 3 档」不矛盾 —— 档位数由模组实报范围决定，四档的**定义**必须完整。
 */
ok('国内/国际四档齐全（都允许 / 仅国内 / 仅国际 / 都不允许）',
	opts3.length === 4 &&
	/仅允许国内漫游/.test(Parse.ROAM_TEXT[1]) &&
	/仅允许国际漫游/.test(Parse.ROAM_TEXT[2]) &&
	/国内国际都不允许/.test(Parse.ROAM_TEXT[3]),
	JSON.stringify(Parse.ROAM_TEXT));

/*
 * 数值前缀「0 · 」在漫游上是**故意保留**的（两套语义要能对手册核对），
 * 但括号里不得再并列另一套语义 —— 旧版写成「0 · 开启国内国际漫游（旧语义：不支持漫游）」，
 * 一行两套含义，读的人分不清当前生效哪套。
 */
ok('漫游文案不得在同一项里并列两套语义（无「旧语义」尾巴）',
	Object.keys(Parse.ROAM_TEXT).every((k) => !/旧语义/.test(Parse.ROAM_TEXT[k])) &&
	Object.keys(Parse.ROAM_TEXT_BASIC).every((k) => !/旧语义/.test(Parse.ROAM_TEXT_BASIC[k])),
	'ROAM_TEXT=' + JSON.stringify(Parse.ROAM_TEXT));

/*
 * 核心断言：同一个数值 0，在两套语义下含义相反。
 * 这条不是「实现细节」，而是为什么必须有上面这套动态切换的理由 ——
 * 一旦有人把它写死成其中一套，另一类设备上的显示就是反的。
 */
ok('数值 0 在两套语义下含义相反（这正是不许写死一套的原因）',
	/^0 · 不允许漫游/.test(Parse.ROAM_TEXT_BASIC[0]) &&
	/^0 · 国内 \+ 国际都允许/.test(Parse.ROAM_TEXT[0]),
	'两套语义的主句若不再相反，说明手册理解变了，需重新核对 13.2.3');

/* ---------- B2. 服务域选项（集中到 parse.js，避免页面内联一份重复定义） ---------- */

const srvOpts = Parse.srvDomainOptions();
ok('服务域 5 个选项且 value 为 0-4',
	srvOpts.length === 5 && srvOpts.map((o) => o.value).join(',') === '0,1,2,3,4',
	JSON.stringify(srvOpts.map((o) => o.value)));
ok('服务域 label 是中文人话（不带数字前缀 / 英文缩写）',
	srvOpts.every((o) => !/^\d ·/.test(o.label) && !/[A-Z_]{3,}/.test(o.label)),
	JSON.stringify(srvOpts.map((o) => o.label)));
ok('手册原名保留在 SRV_DOMAIN_CODE 里（不丢排障信息）',
	Parse.SRV_DOMAIN_CODE[0] === 'CS_ONLY' && Parse.SRV_DOMAIN_CODE[2] === 'CS_PS',
	JSON.stringify(Parse.SRV_DOMAIN_CODE));

/* ---------- B3. 频段选项：label 简化，但十六进制码不得被抹掉 ---------- */

/*
 * 简化 label 要治的是「选项太啰嗦」，不是「抹掉排障信息」。频段是位图，
 * 十六进制码正是拿去对 AT 手册 13.2.3 的唯一依据 —— 它移到 hint 里可以，
 * 但整个文件里必须还留着这些码（作为选项 value），否则排障时无从下手。
 */
['00680380', '2000000680380', '3FFFFFFF', '1E200000095', '7FFFFFFFFFFFFFFF'].forEach((code) => {
	ok('频段预设码 ' + code + ' 仍在源码里（未因简化被抹掉）', modemJs.indexOf(code) >= 0);
});
ok('频段 label 不再把十六进制码塞进文案（码移出 label）',
	!/label: '[0-9A-F]{8,} · /.test(modemJs),
	'仍有形如「00680380 · 自动」的选项文案');

/* ---------- C. 读回与下发 ---------- */

const QUERY_REPLY = '^SYSCFGEX: "080302",2000000680380,1,2,1E200000095\r\nOK';
const cfg = Parse.parseSysCfg(QUERY_REPLY);
ok('能解析 ^SYSCFGEX? 应答', cfg != null);
ok('接入顺序解析正确', cfg && cfg.acqorder === '080302', cfg && cfg.acqorder);
ok('频段位图未被尾部 OK 污染', cfg && cfg.band === '2000000680380', cfg && cfg.band);
ok('漫游/服务域解析为数值', cfg && cfg.roam === 1 && cfg.srvdomain === 2);
ok('LTE 频段解析正确（不含换行/OK）', cfg && cfg.lteband === '1E200000095', cfg && cfg.lteband);

const cmd = Parse.buildSysCfgCommand(cfg);
ok('下发命令格式正确', /^AT\^SYSCFGEX="080302",2000000680380,1,2,1E200000095,,$/.test(cmd), cmd);
ok('下发命令不含换行（否则会被截成两条 AT 命令）', !/[\r\n]/.test(cmd));

/* ---------- D. 界面：五项俱全 + 约束显性化 ---------- */

ok('卡片名为「网络系统配置」', /Mt5700\.card\('网络系统配置'/.test(modemJs));
ok('暴露网络接入顺序', /formGroup\('网络接入顺序'/.test(modemJs));
ok('暴露 2G / 3G 频段', /formGroup\('2G \/ 3G 频段'/.test(modemJs));
ok('暴露漫游', /formGroup\('漫游'/.test(modemJs));
ok('暴露服务域', /formGroup\('服务域'/.test(modemJs));
ok('暴露 4G / LTE 频段', /formGroup\('4G \/ LTE 频段'/.test(modemJs));

/*
 * 卡片内顺序。两类各成一组，别把同类拆开：
 *   制式（接入顺序）→ 频段（2G/3G、4G/LTE 相邻）→ 注册（服务域、漫游）
 * 漫游放最后：它能给几档由模组实报范围决定，与前面四项「选项固定」性质不同。
 */
const ORDER = ['网络接入顺序', '2G / 3G 频段', '4G / LTE 频段', '服务域', '漫游'];
const ORDER_POS = ORDER.map((n) => modemJs.indexOf("formGroup('" + n + "'"));
ok('顺序为 接入顺序 → 2G/3G 频段 → 4G/LTE 频段 → 服务域 → 漫游',
	ORDER_POS.every((p, i) => p > 0 && (i === 0 || p > ORDER_POS[i - 1])),
	JSON.stringify(ORDER_POS));

/* 迁移位置最容易犯的错：新块加上了、旧块没删 → 页面上出现两个同名设置 */
ok('2G / 3G 频段只挂载一次', modemJs.split("formGroup('2G / 3G 频段'").length === 2);
ok('4G / LTE 频段只挂载一次', modemJs.split("formGroup('4G / LTE 频段'").length === 2);
ok('频段选项表各只定义一次', modemJs.split('var BAND_OPTIONS').length === 2
	&& modemJs.split('var LTE_OPTIONS').length === 2);

/* 0x2000000680380 = 自动组合 + WCDMA VIII(900)；旧版误标成「WCDMA 900 + 1700」 */
ok('2G/3G 预设不再把 WCDMA 900 误标成 1700', !/WCDMA 900 \+ 1700/.test(modemJs));

/* 服务域下拉必须来自 parse.js 的单一来源，页面不得再内联一份 */
ok('服务域选项取自 Parse.srvDomainOptions()', /Mt5700\.select\(Parse\.srvDomainOptions\(\)/
	.test(modemJs));

/* 频段解读走位图解码，不手编频段名（手编必然对错位） */
ok('2G/3G 提示用 decodeBandMask 解码', /Parse\.decodeBandMask\(bandSel\.value\)/.test(modemJs));
ok('4G/LTE 提示用 decodeLteBandMask 解码', /Parse\.decodeLteBandMask\(lteSel\.value\)/.test(modemJs));

/* 服务域范围外的值不能被静默吞掉 */
ok('服务域范围外的当前值也会补为选项（不静默改写）',
	/ensureOption\(srvSel, String\(sysCfg\.srvdomain\)/.test(modemJs));

/* 手册 13.2.3 注 2 的约束 */
const srvConstraint = extractFunction(modemJs, 'applySrvConstraint()');
ok('存在服务域约束函数', srvConstraint.length > 0);
ok('含 LTE(03) 或 NR(08) 时禁用 0 与 3',
	/acq\.indexOf\('03'\) >= 0 \|\| acq\.indexOf\('08'\) >= 0/.test(srvConstraint) &&
	/setSrvDisabled\('0', hasLteOrNr\)/.test(srvConstraint) &&
	/setSrvDisabled\('3', hasLteOrNr\)/.test(srvConstraint),
	'未实现手册注 2 的禁用逻辑');
ok('已选中非法值时自动纠正为 2（CS_PS）',
	/srvSel\.value = '2';/.test(srvConstraint), '只禁用不纠正会让非法值被下发');
ok('约束生效时给出可见说明', /srvNote\.textContent = hasLteOrNr/.test(srvConstraint));

/* 未读回前禁止保存 */
ok('未读回模组原值前禁止保存',
	/if \(!sysCfgReady\)/.test(modemJs) && /尚未读回模组当前参数/.test(modemJs));

/* 漫游选项动态重建 */
ok('漫游下拉按 =? 实报范围重建',
	/Parse\.roamOptions\(sysRanges\.roam\.max\)/.test(modemJs));
ok('页面加载时会查询取值范围',
	/function fetchSysCfgRanges\(\)/.test(modemJs) && /\.then\(fetchSysCfgRanges\)/.test(modemJs));
ok('范围查询失败不影响其余卡片（自带 catch 兜底）',
	/catch\(function \(\) \{\}\)/.test(extractFunction(modemJs, 'fetchSysCfgRanges()')),
	'未兜错会让一次 =? 失败连带整页后续卡片都不加载');

/* 不在预设内的当前值不得被静默改写 */
ok('下拉里没有的当前值会被补为选项（不静默改写）',
	/function ensureOption\(sel, value, label\)/.test(modemJs) &&
	/预设未收录/.test(modemJs));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('失败 ' + fails.length + ' 项：');
	fails.forEach((f) => console.log('  ✗ ' + f));
	console.log('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	process.exit(1);
}
console.log('通过 ' + pass + ' 项，失败 0 项');
console.log('网络系统配置（SYSCFGEX）契约测试全部通过');
