#!/usr/bin/env node
'use strict';

/*
 * eUICC tag 白名单契约：**不许向卡发白名单外的 tag**
 * ---------------------------------------------------------------------------
 * 起因（一次必须整机断电才能恢复的事故）：为了"看看卡上有什么"，
 * 连发了 15 个**出处不明**的 tag 去探测，结果模组的 AT 通道直接锁死 ——
 * 串口再也不应答，只能整机断电。
 *
 * 所以这里的口径是：**tag 的出处必须是 pySim 的 ASN.1 定义**
 * （`pySim/euicc.py`），凭"看起来对"拼出来的 tag 不许发给卡。
 *
 * 本守卫的做法：把源码里出现过的 eUICC 私有 tag（BF 系列）全部登记成白名单，
 * 谁新写了一个 BFxx 却没登记，当场判红并提示去查出处。
 *
 * ★ 维护约定：新增一个 tag 时，**先在 pySim 的 pySim/euicc.py 里确认它的 ASN.1
 *   定义**，再把它加进下面的 KNOWN，并在注释里写明它是什么。
 *   只改代码不改这里的，CI 会挡住 —— 这正是本守卫存在的理由。
 *
 * 用法：node tests/euicc-tag-whitelist-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ATWB = path.join(ROOT, 'htdocs', 'luci-static', 'resources');
const FILES = [
	path.join(ATWB, 'at-webserver', 'euicc.js'),
	path.join(ATWB, 'view', 'at-webserver', 'esim.js')
];

/*
 * 已登记的 tag（均来自当前实现里真实使用的路径）。
 * 只写"确定的"，不确定的宁可留空 —— 编造语义比不写更糟。
 */
const KNOWN = {
	BF3E: 'GetEID 的响应容器（BF3E 12 5A 10 <16B EID>）',
	BF2D: 'GetProfiles（BF2D <len> 5C <count> <tags…>）',
	BF31: 'Profile 操作：enable',
	BF32: 'Profile 操作：disable',
	BF33: 'Profile 操作：delete',
	BF29: 'SetNickname（5A + ICCID + 90 + 昵称）',
	BF38: '鉴权类步骤（响应带安全语义，走独立超时口径）',
	BF21: '鉴权类步骤（同上）',
	BF22: 'EUICCInfo2',
	BF28: '待发回执列表（一次会话内继 BF2D 之后读取）',
	BF36: 'Bound Profile Package 的头（分段后第一段带 BF36）',
	BF20: '登记于当前实现',
	BF23: '登记于当前实现',
	BF2B: '登记于当前实现',
	BF2E: '登记于当前实现',
	BF2F: '登记于当前实现',
	BF30: '登记于当前实现',
	BF3C: '登记于当前实现'
};

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

/* 取源码里所有 BF 系列 tag 字面量，统一大写去重 */
function collectTags(src) {
	const found = {};
	const re = /\bBF([0-9A-Fa-f]{2})\b/g;
	let m;
	while ((m = re.exec(src)) !== null) {
		found['BF' + m[1].toUpperCase()] = true;
	}
	return Object.keys(found).sort();
}

const texts = FILES.map(function (p) { return fs.readFileSync(p, 'utf8'); });

ok('读到了 eSIM 链路的两个文件（否则本守卫等于没跑）',
	texts.every(function (t) { return t.length > 1000; }));

const seen = {};
texts.forEach(function (t) {
	collectTags(t).forEach(function (tag) { seen[tag] = true; });
});
const tags = Object.keys(seen).sort();

/* 白名单里登记了却没人用的 tag：说明登记过时了，留着会让守卫变钝 */
const stale = Object.keys(KNOWN).filter(function (t) { return !seen[t]; });
ok('白名单里没有已废弃不用的 tag（过时登记会让守卫变钝）',
	stale.length === 0, stale.join(','));

const unknown = tags.filter(function (t) { return !KNOWN[t]; });
ok('★ 没有向卡发送白名单外的 BF 系列 tag（盲目探测 tag 曾把模组 AT 通道锁死，只能整机断电）',
	unknown.length === 0,
	unknown.join(',') + '　处理：先在 pySim 的 pySim/euicc.py 里确认该 tag 的 ASN.1 定义，' +
	'再登记进本测试的 KNOWN 并注明它是什么');

ok('确实登记了一批 tag（否则本守卫等于没跑）', tags.length >= 10,
	'只登记了 ' + tags.length + ' 个：' + tags.join(','));

/*
 * 反向自检：往源码里塞一个未登记的 tag，守卫必须判红。
 * 纯内存变异，不落盘 —— 恒绿和"真的没有未知 tag"看起来一模一样。
 */
const probe = texts[0] + "\nvar probeTag = 'BF99';\n";
const after = collectTags(probe).filter(function (t) { return !KNOWN[t]; });
ok('★ 反向自检：未登记的 BF99 确实被判为未知（不是恒绿）',
	after.indexOf('BF99') >= 0,
	'实际结果 ' + JSON.stringify(after));

/* 对照：本仓真实用到的 tag 必须被判为已知，否则白名单本身写错了 */
const stillOk = tags.filter(function (t) { return !KNOWN[t]; });
ok('★ 反向自检：当前在用的 tag 全部判为已知（白名单没写漏）',
	stillOk.length === 0, stillOk.join(','));

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
