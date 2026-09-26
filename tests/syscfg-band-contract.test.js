#!/usr/bin/env node
'use strict';

/*
 * 频段位掩码 / 写后校验 契约测试
 * ============================================================================
 *
 * 钉住 2026-09-26 实测「频段改不了」这个坑的两半。当日在本机 Hiveton H5000M
 * （MT5700M-CN，固件 V200R001C20B025）逐条下发 + 回读取得的证据：
 *
 *   ① **<band> 不能用手册 magic value 0x3FFFFFFF（CM_BAND_PREF_ANY）**
 *      下发 `AT^SYSCFGEX="080302",3FFFFFFF,1,2,1E200000095,,` → 模组**回 OK，
 *      但回读 NV 一字不改**。判别实验：先把 band 压成别的值再发 ANY，回读依旧
 *      纹丝不动 —— 不是"裁剪后恰好相等"，是这条分支在固件上根本没写进去。
 *      改成「手册列出的每个单值按位叠加」后立刻落盘（14 个位全在）。
 *      → 界面上的「全部频段」必须是叠加值，绝不能是 ANY。
 *
 *   ② **<lteband> 的 ALL 会被硬件能力掩码裁剪（这是生效，不是失败）**
 *      先把 lteband 压到 1（仅 BC1）再下发 7FFFFFFFFFFFFFFF，回读被撑回
 *      1E200000095（BC1/3/5/8/34/38/39/40/41）—— 生效了，只是被按能力掩码做了
 *      AND。本机日常就处在这个能力全集上，于是"改完看着没变化"。
 *      → 写后比对**不能**用字符串相等，否则会把正常的裁剪误报成失败。
 *
 *   ③ **AT 回 OK ≠ 写入成功**
 *      上述两种情形模组都回 OK。任何以 OK 为准的成功提示都是在骗人，
 *      保存后必须回读校验，并把没被接受的项如实说出来。
 *
 * 用法：node tests/syscfg-band-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'htdocs/luci-static/resources');
const PARSE_JS = path.join(RES, 'at-webserver/parse.js');
const MODEM_JS = path.join(RES, 'view/at-webserver/modem_settings.js');

const parseJs = fs.readFileSync(PARSE_JS, 'utf8');
const modemJs = fs.readFileSync(MODEM_JS, 'utf8');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) { pass++; return; }
	fails.push(name + (detail ? ' —— ' + detail : ''));
}

/* 按既有测试的做法加载 LuCI 模块（rpc.js 上下文），拿到 Parse */
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

/* 取 `var NAME = [` 起的整段数组字面量 */
function varBlock(src, name) {
	const i = src.indexOf('var ' + name + ' = [');
	if (i < 0) return '';
	const j = src.indexOf('];', i);
	return j < 0 ? '' : src.slice(i, j + 2);
}

/* 十六进制串 → 置位下标数组（测试侧独立实现，与被测实现不共用） */
function bitsOf(hexStr) {
	const h = String(hexStr || '').toUpperCase();
	const out = [];
	for (let i = 0; i < h.length; i++) {
		const nib = parseInt(h[h.length - 1 - i], 16);
		if (isNaN(nib)) continue;
		for (let b = 0; b < 4; b++) {
			if ((nib >> b) & 1) out.push(i * 4 + b);
		}
	}
	return out;
}

/* ---------- A. 「全部频段」不能用 ANY magic value ---------- */

/* API 尚未实现时优雅报红（不抛异常），TDD 红阶段才有可读的诊断信息 */
const bandAll = String(Parse.BAND_ALL_MASK == null ? '' : Parse.BAND_ALL_MASK);
const lteAll = String(Parse.LTE_BAND_ALL_MASK == null ? '' : Parse.LTE_BAND_ALL_MASK);

ok('A1 Parse.BAND_ALL_MASK 已导出且非空',
	typeof Parse.BAND_ALL_MASK === 'string' && /^[0-9A-F]+$/.test(Parse.BAND_ALL_MASK),
	'got=' + Parse.BAND_ALL_MASK);

/*
 * ★ 反向断言：这组"_ANY 不能出现"是整个 ① 的核心。
 *   只要有人把它改回 3FFFFFFF，这条立刻变红。
 */
ok('A2 <band> 的「全部频段」不是 ANY magic value 3FFFFFFF',
	bandAll.toUpperCase() !== '3FFFFFFF',
	'实测该值在本机固件上回 OK 但不写入 NV');

ok('A3 BAND_ALL_MASK 不落在任何 magic 取值上（3FFFFFFF / 40000000）',
	['3FFFFFFF', '40000000'].indexOf(bandAll.toUpperCase()) < 0,
	Parse.BAND_ALL_MASK);

/* ---------- B. 覆盖手册列出的全部位（含补录的 bit25） ---------- */

/* 手册 13.2.3 逐个列出的 <band> 单值（不含 ANY / NO_CHANGE 两个 magic） */
const MANUAL_BITS = [7, 8, 9, 19, 20, 21, 22, 23, 25, 26, 27, 49, 50, 60];
const maskBits = bitsOf(bandAll);

ok('B1 BAND_ALL_MASK 覆盖手册全部 ' + MANUAL_BITS.length + ' 个频段位',
	MANUAL_BITS.every((b) => maskBits.indexOf(b) >= 0),
	'缺位=' + JSON.stringify(MANUAL_BITS.filter((b) => maskBits.indexOf(b) < 0)));

ok('B2 BAND_ALL_MASK 不含手册之外的杂位',
	maskBits.every((b) => MANUAL_BITS.indexOf(b) >= 0),
	'多出=' + JSON.stringify(maskBits.filter((b) => MANUAL_BITS.indexOf(b) < 0)));

ok('B3 含 bit25（手册 2000000 CM_BAND_PREF_WCDMA_IX_1700 AWS）',
	maskBits.indexOf(25) >= 0,
	'bit25 曾长期漏登记，导致「全部频段」少一个 WCDMA 1700');

ok('B4 含 bit60（WCDMA XIX 850）—— 它使掩码跨 54 位',
	maskBits.indexOf(60) >= 0);

/*
 * ★ bit7..bit60 跨 54 位 > 双精度 53 位安全范围，用 Number 累加会丢低位。
 *   这里用「精确等于实测值」锁定，任何走 Number 累加的实现都会对不上。
 */
ok('B5 掩码值精确等于实测下发值 100600000EF80380',
	bandAll.toUpperCase() === '100600000EF80380',
	Parse.BAND_ALL_MASK + '（2026-09-26 真机下发后回读落盘确认）');

/* ---------- C. 单源：ALL_MASK 必须由 BAND_BITS 推导 ---------- */

const defIdx = parseJs.indexOf('api.BAND_ALL_MASK');
const defBlock = defIdx < 0 ? '' : parseJs.slice(defIdx, defIdx + 400);
ok('C1 BAND_ALL_MASK 由 BAND_BITS 推导（不是手写字面量）',
	defBlock.indexOf('BAND_BITS') >= 0,
	'手写字面量会在改 BAND_BITS 后静默失配');

ok('C2 BAND_ALL_MASK 经 hexFromBits 拼串（避开 2^53）',
	defBlock.indexOf('hexFromBits') >= 0);

/* ---------- D. LTE 的 ALL 保留 magic value（它实测生效） ---------- */

ok('D1 Parse.LTE_BAND_ALL_MASK 已导出',
	typeof Parse.LTE_BAND_ALL_MASK === 'string' && Parse.LTE_BAND_ALL_MASK.length > 0,
	'got=' + Parse.LTE_BAND_ALL_MASK);

ok('D2 <lteband> 的「全部频段」仍是手册 magic value 7FFFFFFFFFFFFFFF',
	lteAll.toUpperCase() === '7FFFFFFFFFFFFFFF',
	'与 <band> 相反：本机实测这一条生效（会被硬件能力掩码裁剪，属正常）');

/* ---------- E. 写后校验：按位子集判定 ---------- */

const check = Parse.sysCfgApplyCheck;
ok('E1 Parse.sysCfgApplyCheck 已导出', typeof check === 'function');

if (typeof check === 'function') {
	/* 真实案例 ①：LTE ALL 下发后被能力掩码裁剪（当成功能，不是故障） */
	const lte = check({ lteband: '7FFFFFFFFFFFFFFF' }, { lteband: '1E200000095' });
	const lteRow = lte.filter((r) => r.key === 'lteband')[0];
	ok('E2 LTE ALL 被裁剪判定为 clipped（不是 rejected）',
		lteRow && lteRow.state === 'clipped',
		JSON.stringify(lteRow));

	/* 真实案例 ②：band ANY 下发后 NV 完全没动 */
	const bd = check({ band: '3FFFFFFF' }, { band: '2000000680380' });
	const bdRow = bd.filter((r) => r.key === 'band')[0];
	ok('E3 band ANY 不写入判定为 rejected',
		bdRow && bdRow.state === 'rejected',
		JSON.stringify(bdRow));

	/* 真实案例 ③：显式叠加值完整落盘 */
	const okBand = check({ band: '100600000EF80380' }, { band: '100600000EF80380' });
	ok('E4 完全一致时判定为 exact',
		okBand.filter((r) => r.key === 'band')[0].state === 'exact');

	/* 模组回读大小写不保证：=? 实测报小写 3fffffff，? 报大写 1E200000095 */
	const ci = check({ band: '100600000EF80380' }, { band: '100600000ef80380' });
	ok('E5 大小写差异不算未生效',
		ci.filter((r) => r.key === 'band')[0].state === 'exact');

	/* 非位图字段必须严格相等 —— 不能用子集判定，否则 '0803' 会被当成 "裁剪过的 080302" */
	const acq = check({ acqorder: '080302' }, { acqorder: '0803' });
	ok('E6 acqorder 严格相等（不套用位图子集规则）',
		acq.filter((r) => r.key === 'acqorder')[0].state === 'rejected');

	const acqOk = check({ acqorder: '080302' }, { acqorder: '080302' });
	ok('E7 acqorder 一致时 exact',
		acqOk.filter((r) => r.key === 'acqorder')[0].state === 'exact');

	/*
	 * 返回的数组含**全部参与校验的字段**（exact 也在），由调用方筛。
	 * 这样调用方既能报失败，也能列出"已生效"的项，不必再猜。
	 */
	const roam = check({ roam: 0, srvdomain: 2 }, { roam: 0, srvdomain: '2' });
	ok('E8 roam / srvdomain 按值比对（1 与 "1" 视为相同）',
		roam.length === 2
			&& roam.every((r) => r.state === 'exact'), JSON.stringify(roam));

	const roamBad = check({ roam: 0 }, { roam: 1 });
	ok('E9 roam 改不动要报 rejected',
		roamBad.filter((r) => r.key === 'roam')[0].state === 'rejected');

	/* 「不修改」的字段根本没下发，不该出现在报告里 */
	const unchanged = check({ band: '', acqorder: '080302' }, { acqorder: '080302', band: '2000000680380' });
	ok('E10 值为空（不修改）的字段不参与校验',
		unchanged.filter((r) => r.key === 'band').length === 0);

	/* 回读不到 → 不判定，交给调用方（不要假装知道） */
	const missing = check({ band: '100600000EF80380' }, { band: '' });
	ok('E11 回读值为空时不臆修行',
		missing.filter((r) => r.key === 'band')[0].state === 'unknown',
		JSON.stringify(missing));

	/* 比下发值更宽：模组保留了额外的位 */
	const wider = check({ band: '80' }, { band: '2000000680380' });
	ok('E12 回读比下发更宽（含有下发没给的位）是 rejected',
		wider.filter((r) => r.key === 'band')[0].state === 'rejected');
}

/* ---------- F. modem_settings.js 源码契约 ---------- */

const bandBlock = varBlock(modemJs, 'BAND_OPTIONS');
ok('F1 取到 BAND_OPTIONS 定义块', bandBlock.length > 0);
ok('F2 「全部频段」选项引用 Parse.BAND_ALL_MASK',
	bandBlock.indexOf('Parse.BAND_ALL_MASK') >= 0);
ok('F3 BAND_OPTIONS 里不再残留 ANY 字面量 3FFFFFFF（反向）',
	bandBlock.indexOf('3FFFFFFF') < 0,
	'留着就是复发的种子');

const lteBlock = varBlock(modemJs, 'LTE_OPTIONS');
ok('F4 取到 LTE_OPTIONS 定义块', lteBlock.length > 0);
ok('F5 LTE「全部频段」引用 Parse.LTE_BAND_ALL_MASK',
	lteBlock.indexOf('Parse.LTE_BAND_ALL_MASK') >= 0);
ok('F6 LTE_OPTIONS 里不再硬写 7FFFFFFFFFFFFFFF（反向）',
	lteBlock.indexOf('7FFFFFFFFFFFFFFF') < 0);

/*
 * ★★ 顺序断言：必须先校验再报成功。
 *   之前的写法是 res.success → success(...)，于是 ① 那种"回 OK 但没写"的
 *   情形被报成成功，用户只在下拉悄悄跳回原值时才察觉 —— 这正是本次故障的表象。
 */
const anchor = modemJs.indexOf("Mt5700.primaryButton('保存网络配置'");
ok('F7 定位到「保存网络配置」按钮', anchor > 0);
if (anchor > 0) {
	const saveBlock = modemJs.slice(anchor, anchor + 1600);
	const iCheck = saveBlock.indexOf('Parse.sysCfgApplyCheck');
	const iSuccess = saveBlock.indexOf('Mt5700.success(');
	/*
	 * 回读必须独立于窗口大小来断言：直接检查 readSysCfg 这个函数体内有没有真的
	 * 发 AT^SYSCFGEX?。用大窗口去找会连带读到后面的无关代码。
	 */
	const readFn = modemJs.slice(modemJs.indexOf('function readSysCfg()'),
		modemJs.indexOf('function readSysCfg()') + 300);
	ok('F8 readSysCfg 确实发 AT^SYSCFGEX? 回读模组当前值',
		readFn.indexOf("AT^SYSCFGEX?") >= 0);
	ok('F8b 保存流程保存后调用 readSysCfg 回读（不是只信 res.success）',
		saveBlock.indexOf('readSysCfg(') >= 0);
	ok('F9 保存流程走 Parse.sysCfgApplyCheck 做写后校验',
		iCheck >= 0);
	ok('F10 「成功」提示排在写后校验之后（不允许先看 result.success 就报成功）',
		iCheck >= 0 && iSuccess > iCheck,
		'iCheck=' + iCheck + ' iSuccess=' + iSuccess);
	ok('F11 有未被接受的项时不再弹成功提示',
		/Mt5700\.(warning|error)\(/.test(saveBlock));
}

/* ---------- 汇总 ---------- */

console.log('syscfg-band-contract: ' + pass + ' passed, ' + fails.length + ' failed');
fails.forEach((f) => console.log('  ✗ ' + f));
if (fails.length) process.exit(1);
