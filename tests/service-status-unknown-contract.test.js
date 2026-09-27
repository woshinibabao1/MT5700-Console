#!/usr/bin/env node
'use strict';

/*
 * 服务状态「读不到 ≠ 没有」契约
 * ---------------------------------------------------------------------------
 * 起因（2026-09-28 实测到）：
 *
 *   service.js 里两个 rpcd 读取都用了「失败就给个空壳」的 catch：
 *       listSerial('/dev').catch(function () { return { entries: [] }; })
 *       statBinary(BINARY).catch(function () { return null; })
 *   于是「读失败」与「系统里真的没有」**完全不可区分**，而渲染侧据此下结论：
 *       if (!binExists) { label: '未安装', hint: '…请重新安装 luci-app-mt5700。' }
 *   一次 rpcd 超时/权限问题，界面就断言「后端未安装」并**劝用户重装**。
 *
 *   resolveStatus 自己的注释写得很清楚 ——「**区分** 运行中/已停止/未注册/未安装/
 *   已禁用五种语义，给出对应的修复建议」—— 这个函数的立意就是精确区分，
 *   把「读不到」混进「未安装」正好违背它。同仓已有先例：
 *   sms_settings.js 的 `unknown=true`（回读不到就不许据此断言生效与否）。
 *
 * 本守卫钉四件事：
 *   ① 两处 catch 必须**留下"失败过"的痕迹**（不许静默返回空壳）；
 *   ② 返回给渲染层的对象必须带 binUnknown / serialUnknown；
 *   ③ resolveStatus 必须**先**处理 binUnknown 再落到「未安装」；
 *   ④ 行为断言：直接抽出 resolveStatus 真跑，binUnknown=true 时
 *      label 不得是「未安装」、hint 不得出现「重新安装」。
 *
 * ★ 每条都要能判红（第 5 节有反向自检）；恒绿的守卫等于没有守卫。
 * 用法：node tests/service-status-unknown-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'service.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* ---------------- ① 两处 catch 必须留痕 ---------------- */

ok('① statBinary 的 catch 会置 statFailed（不再静默返回空壳）',
	/statBinary\(BINARY\)\.catch\(function \(\) \{ statFailed = true; return null; \}\)/.test(src),
	'statBinary 的失败没留痕 —— 界面会把「读不到」当成「未安装」');

ok('① listSerial 的 catch 会置 serialFailed（不再静默返回空列表）',
	/listSerial\('\/dev'\)\.catch\(function \(\) \{ serialFailed = true; return \{ entries: \[\] \}; \}\)/.test(src),
	'listSerial 的失败没留痕 —— 会把「读不到」当成「机器上没有串口」');

ok('① 两个标志都在使用前声明（否则是隐式全局）',
	/var statFailed = false;/.test(src) && /var serialFailed = false;/.test(src),
	'缺少 var 声明，赋值会创建隐式全局变量');

/* ---------------- ② 返回对象必须带 unknown 标志 ---------------- */

ok('② 返回对象带 binUnknown',
	/binUnknown:\s*statFailed/.test(src), '渲染层拿不到「二进制状态未知」这个信息');

ok('② 返回对象带 serialUnknown',
	/serialUnknown:\s*serialFailed/.test(src), '渲染层拿不到「串口列表读取失败」这个信息');

ok('② 串口下拉在读失败时给出可见提示（不许只显示空列表）',
	/state\.serialUnknown/.test(src) && /读取 \/dev 失败/.test(src),
	'读失败与「没有串口」在界面上仍然一样');

/* serviceList 是第三个同类来源：读失败 -> registered=false -> 报「未注册」并
   把用户引去查 /etc/init.d/at-webserver 是否被 overlay 覆盖 */
ok('② serviceList 的 catch 会置 svcFailed（不再静默返回空壳）',
	/serviceList\(SERVICE\)\.catch\(function \(\) \{ svcFailed = true; return \{\}; \}\)/.test(src),
	'serviceList 的失败没留痕 —— 会把「读不到」当成「未注册」');
ok('② 返回对象带 svcUnknown', /svcUnknown:\s*svcFailed/.test(src), '渲染层拿不到该信息');
ok('② refreshStatus 也留痕并在开头复位（否则失败一次后永远停在未知）',
	/var svcRefreshFailed = false;/.test(src) &&
	/rpcServiceList\(SERVICE\)\.catch\(function \(\) \{ svcRefreshFailed = true; return \{\}; \}\)/.test(src) &&
	/state\.svcUnknown = svcRefreshFailed;/.test(src),
	'refreshStatus 未留痕或未复位');

/* ---------------- ③ resolveStatus 必须先判 unknown ---------------- */

const iUnknown = src.indexOf('state.binUnknown');
const iNotInstalled = src.indexOf("label: '未安装'");
ok('③ resolveStatus 里 binUnknown 的判断排在「未安装」之前',
	iUnknown >= 0 && iNotInstalled > iUnknown,
	'顺序反了 —— 读失败仍会先落到「未安装」');

const iSvcUnknown = src.indexOf('state.svcUnknown) {');
const iNotReg = src.indexOf("label: '未注册'");
ok('③ resolveStatus 里 svcUnknown 的判断排在「未注册」之前',
	iSvcUnknown >= 0 && iNotReg > iSvcUnknown,
	'顺序反了 —— 读失败仍会先落到「未注册」并把人引去查 init 脚本');

/* ---------------- ④ 行为断言：抽出 resolveStatus 真跑 ---------------- */

/* 只取常量与 resolveStatus 本身，不执行模块体（它会引用 L / E 等浏览器全局） */
const seg = src.match(/var SERVICE = 'at-webserver';[\s\S]*?\nfunction resolveStatus[\s\S]*?\n\}\n/);
ok('④ 能抽出 resolveStatus 用于行为断言', !!seg, '源码结构变了，请同步本守卫');

if (seg) {
	/* 在受控作用域里求值，拿到 resolveStatus */
	const resolveStatus = new Function(seg[0] + '\nreturn resolveStatus;')();

	const base = {
		enabled: '1', running: false, registered: true, pid: null,
		binExists: true, binExec: true, userStopped: false
	};
	const unknown = resolveStatus(Object.assign({}, base, { binExists: false, binUnknown: true }));
	const reallyGone = resolveStatus(Object.assign({}, base, { binExists: false, binUnknown: false }));

	ok('④ 读失败时不下「未安装」的结论',
		unknown.label !== '未安装', '仍报「' + unknown.label + '」');
	ok('④ 读失败时措辞里不许劝人重新安装',
		String(unknown.hint).indexOf('重新安装') < 0, unknown.hint);
	ok('④ 读失败要有明确文案（不是空提示）',
		unknown.label === '状态未知' && String(unknown.hint).length > 10, unknown.label);
	ok('④ 真没装时仍然如实报「未安装」并给出重装建议（没有矫枉过正）',
		reallyGone.label === '未安装' && String(reallyGone.hint).indexOf('重新安装') > 0,
		reallyGone.label + ' / ' + reallyGone.hint);
	ok('④ 未知态用 warning 而不是 danger（不确定不该标成故障）',
		unknown.variant === 'warning', '实际 ' + unknown.variant);

	/* serviceList 读失败：不得报「未注册」，更不得把用户引去查 init 脚本 */
	const svcUnknown = resolveStatus(Object.assign({}, base, { registered: false, svcUnknown: true }));
	const svcGone = resolveStatus(Object.assign({}, base, { registered: false, svcUnknown: false }));
	ok('④ serviceList 读失败时不下「未注册」的结论',
		svcUnknown.label !== '未注册', '仍报「' + svcUnknown.label + '」');
	ok('④ serviceList 读失败时不许把人引去查 init.d（那是错误归因）',
		String(svcUnknown.hint).indexOf('init.d') < 0, svcUnknown.hint);
	ok('④ 真未注册时仍然如实报「未注册」并给出 init 脚本线索（没有矫枉过正）',
		svcGone.label === '未注册' && String(svcGone.hint).indexOf('init.d') > 0,
		svcGone.label + ' / ' + String(svcGone.hint).slice(0, 40));
}

/* ---------------- ⑤ 反向自检：上面的判据必须能判红 ---------------- */

/*
 * 造一份「旧写法」源码：catch 返回空壳、没有 unknown 标志。
 * 用同一批判据去测它，必须全部不通过 —— 否则说明这些判据是恒绿的。
 */
const OLD = [
	"listSerial('/dev').catch(function () { return { entries: [] }; })",
	"statBinary(BINARY).catch(function () { return null; })",
	"binExists: binExists,",
	"function resolveStatus(state) {",
	"\tvar binExists = !!state.binExists;",
	"\tif (!binExists) { return { label: '未安装', variant: 'danger', hint: '请重新安装 luci-app-mt5700。' }; }",
	"\treturn { label: '已停止' };",
	"}"
].join('\n');

ok('★ 反向自检 A：旧写法（catch 静默返回空壳）会被 ① 判红',
	!/statFailed = true/.test(OLD) && !/serialFailed = true/.test(OLD));
ok('★ 反向自检 B：旧写法会被 ② 判红（没有 unknown 标志）',
	!/binUnknown:\s*statFailed/.test(OLD) && !/serialUnknown:\s*serialFailed/.test(OLD));
ok('★ 反向自检 C：旧写法会被 ③ 判红（unknown 判断缺失）',
	OLD.indexOf('state.binUnknown') < 0);

/* 行为层的反向自检：把旧 resolveStatus 拿来真跑，必须报「未安装」+ 劝重装 */
const oldSeg = OLD.match(/function resolveStatus[\s\S]*?\n\}/);
if (oldSeg) {
	const oldResolve = new Function(oldSeg[0] + '\nreturn resolveStatus;')();
	const r = oldResolve({ enabled: '1', binExists: false, binUnknown: true, registered: true });
	ok('★ 反向自检 D：旧 resolveStatus 在「读失败」时确实会误报「未安装」（证明 ④ 测的是真差别）',
		r.label === '未安装' && String(r.hint).indexOf('重新安装') > 0,
		'实际 ' + r.label);
} else {
	fails.push('★ 反向自检 D 无法构造（旧样本没匹配上）');
}

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('服务状态「读不到 ≠ 没有」契约测试全部通过');
