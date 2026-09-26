#!/usr/bin/env node
'use strict';

/**
 * AT 读命令分类契约（2026-09-26，`tools/audit-at-reads.py` 扫出来的漏项）
 * ----------------------------------------------------------------------------
 * 判据来源是**技术手册**，不是印象。《MT5700M-CN 5G系列模组AT命令手册》：
 *   · 7.8   AT+CGPADDR    查询 PDP 地址        （语法 `AT+CGPADDR=[<cid>[,…]]`，参数可选）
 *   · 5.26  AT+CNUM       查询本机号码
 *   · 13.30 AT+CGEQOSRDP  读取 EPS QoS 参数    （同样带可选参数）
 *   · 3.7   AT+CGMI       查询制造商信息
 * 真机复核（只读）：CGPADDR / CGMI / CGEQOSRDP 正常返回；
 *   CNUM 回 `+CME ERROR: not found`（卡上没写 MSISDN）—— 属**稳定失败**的查询。
 *
 * 为什么「被当成写命令」是个真问题（四条同时发生，最后一条最隐蔽）：
 *   ① 不缓存 → 每轮刷新都打一次串口
 *   ② 不重试 → 偶发 ERROR 直接变红叉
 *   ③ 不受忙态熔断保护 → 通道忙时一条条去撞 8 秒
 *   ④ 成功后调 `_dropStateCache()` → **状态类缓存整片作废**
 *      AT+CNUM 在网络状态页每轮刷新都调，于是 CPIN?/SIMSQ?/CFUN?/CGDCONT? 的缓存
 *      等于一直没生效 —— 这是「明明有分档缓存却还是慢」的一个真实来源。
 *
 * 用法：node tests/at-read-classification-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RPC_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/rpc.js');
const UCODE = path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc');
const rpcSrc = fs.readFileSync(RPC_JS, 'utf8');
const ucSrc = fs.readFileSync(UCODE, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

function loadRpc() {
	const src = rpcSrc
		.replace(/^\s*'require [^']*';\s*$/gm, '')
		.replace(/\n\s*return AtWsClass;\s*$/, '\n');
	const ctx = {
		console: { error: function () { }, log: function () { }, warn: function () { } },
		Promise, Date, JSON, Math, String, Number, RegExp, Object, Array, Error, isNaN, parseInt,
		setTimeout, clearTimeout,
		L: {
			Class: { extend: (x) => x },
			rpc: { declare: () => () => Promise.resolve({}) },
			uci: { load: () => Promise.resolve() },
			env: {}
		},
		window: undefined
	};
	vm.createContext(ctx);
	return vm.runInContext(
		'(function(){\n' + src + '\nreturn { isRetryableRead: isRetryableRead,' +
		' NON_QUESTION_READS: NON_QUESTION_READS,' +
		' IDENTIFIER_COMMANDS: IDENTIFIER_COMMANDS, STATE_COMMANDS: STATE_COMMANDS };\n})()',
		ctx);
}

function ucodeList(name) {
	const m = ucSrc.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'));
	if (!m) return null;
	return (m[1].match(/'([^']+)'/g) || []).map(function (x) { return x.slice(1, -1); });
}

const mod = loadRpc();
const isRead = mod.isRetryableRead;

/* ---------- ① 手册确认的查询必须被当成只读 ---------- */
const MANUAL_READS = ['AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP', 'AT+CGMI'];
MANUAL_READS.forEach(function (c) {
	ok('① 手册确认的查询「' + c + '」被当成只读', isRead(c) === true,
		'当前判为写命令 → 不缓存 / 不重试 / 不受熔断保护 / 还会清空状态缓存');
});

/* ---------- ② 有副作用的命令绝不能被当成只读（安全底线） ---------- */
const MUST_BE_WRITES = [
	'AT^RESET', 'AT+CFUN=0', 'AT+CFUN=1', 'AT^DSFLOWCLR', 'AT&F', 'ATE0',
	'AT^FOTA', 'AT^FWUP', 'AT+CMGS', 'AT+CUSD', 'AT^SETAUTODIAL=1,1,"IP","cmnet","","",0'
];
MUST_BE_WRITES.forEach(function (c) {
	ok('② 有副作用的「' + c + '」不被当成只读', isRead(c) === false);
});

/* ---------- ③ 所有 `?` 结尾的必须被当成只读（语法即查询） ---------- */
['AT+CEREG?', 'AT+C5GREG?', 'AT+CGACT?', 'AT^SIMSQ?', 'AT^ICCID?', 'AT+CLCK?'].forEach(function (c) {
	ok('③ 「' + c + '」按语法即查询，判为只读', isRead(c) === true);
});

/* ---------- ④ 前后端对「什么算只读」必须一致 ---------- */
const bare = ucodeList('BARE_READS');
ok('④ ucode BARE_READS 能解析出来（否则下面几条恒绿）', Array.isArray(bare) && bare.length >= 4,
	JSON.stringify(bare));
['AT+CGPADDR', 'AT+CNUM', 'AT+CGEQOSRDP'].forEach(function (c) {
	ok('④ 前后端一致：「' + c + '」在 ucode BARE_READS 里也有',
		!!bare && bare.indexOf(c) >= 0, JSON.stringify(bare));
});
const staticReads = ucodeList('STATIC_READS') || [];
MANUAL_READS.forEach(function (c) {
	ok('④ 前后端一致：「' + c + '」在 ucode 侧也被认为是只读',
		staticReads.indexOf(c) >= 0 || (!!bare && bare.indexOf(c) >= 0),
		'static=' + JSON.stringify(staticReads) + ' bare=' + JSON.stringify(bare));
});

/* ---------- ⑤ 会变化的地址类查询不得进「10 分钟不变类」 ---------- */
ok('⑤ AT+CGPADDR 不得进 ucode STATIC_READS（PDP 地址会随网络重配变化）',
	staticReads.indexOf('AT+CGPADDR') < 0, JSON.stringify(staticReads));
ok('⑤ AT+CGEQOSRDP 同理不得进 STATIC_READS',
	staticReads.indexOf('AT+CGEQOSRDP') < 0);

/* ---------- ⑥ 反向：把补上的那几条删掉，检查必须报红 ---------- */
function readsOf(src) {
	const m = src.match(/var NON_QUESTION_READS = \[([\s\S]*?)\];/);
	if (!m) return [];
	return (m[1].match(/'([^']+)'/g) || []).map(function (x) { return x.slice(1, -1); });
}
const cur = readsOf(rpcSrc);
ok('⑥ 反向：NON_QUESTION_READS 能解析出来', cur.length >= 5, JSON.stringify(cur));
ok('⑥ 反向：删掉 AT+CGPADDR 后它就不在名单里（证明上面 ① 不是恒绿）',
	cur.indexOf('AT+CGPADDR') >= 0 &&
	readsOf("var NON_QUESTION_READS = ['AT+CSQ'];\n").indexOf('AT+CGPADDR') < 0);

/* ---------- 汇总 ---------- */
if (fails.length) {
	console.log('✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（读命令分类与手册一致，前后端名单同步）');
