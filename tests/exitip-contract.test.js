#!/usr/bin/env node
/*
 * 出口 IP 探测 / 换卡换 IP 契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-24：补齐「换卡换出口 IP」的判定依据。
 *
 * 为什么要单独一个测试文件：
 *   这条链路横跨四个文件（ucode 新方法 / ACL / rpc 声明 / parse 解析），
 *   而且它是**唯一一处会从设备向外发请求**的功能 —— 注入面与误判面都在这里，
 *   任一端改形都会变成「看起来探测了、其实是假结果」。
 *
 * 本测试覆盖：
 *   ① ucode exitip：URL 写死白名单（不接受 req 传入）、bind 逐字符校验后才拼命令行
 *   ② ACL 两段都放行 exitip（漏了就是 rpcd Access denied，页面静默失败）
 *   ③ rpc.js 声明了 exitip 并暴露 AtWs.exitIp；**取不到 IP 必须报失败而不是给占位值**
 *   ④ Parse.parseExitIpBody：合法 v4/v6 认、错误页 / 空串 / 越界段一律 null
 *   ⑤ 前端：不自动轮换（单模组＝唯一上行）、失败给「切回原 Profile」出口
 *
 * 运行：node tests/exitip-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const ESIM = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'esim.js');

const ucSrc = fs.readFileSync(UCODE, 'utf8');
const aclSrc = fs.readFileSync(ACL, 'utf8');
const rpcSrc = fs.readFileSync(RPC, 'utf8');
const pSrc = fs.readFileSync(PARSE, 'utf8');
const esimSrc = fs.readFileSync(ESIM, 'utf8');

const Parse = eval('(' + pSrc.match(/var Parse = \((function[\s\S]*?)\)\(\);/)[1] + ')')();

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* 按括号配对抠出整个函数（改名请同步本测试） */
function grab(name, src) {
	const i = src.indexOf('function ' + name + '(');
	if (i < 0) throw new Error('源码里找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, started = false;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
	}
	throw new Error('函数体括号不配对：' + name);
}

/* ---------- 1. ucode：注入面必须封死 ---------- */

ok('ucode 注册了 mt5700.exitip', /\bexitip: \{/.test(ucSrc));
ok('★ exitip 只接受 bind 一个参数（没有 url/host 之类的用户输入面）',
	/exitip: \{\s*\n\s*args: \{ bind: '' \}/.test(ucSrc));
ok('★ 回显端点写死在常量里（URL 不接受外部传入 → 无命令注入面）',
	/const EXITIP_ENDPOINTS = \[/.test(ucSrc));
ok('★ 拼命令行用的是白名单常量里的 url，不是 req 的任何字段',
	/exitIpOnce\(ep\.url, bind\)/.test(ucSrc));

/* bind 校验：唯一的用户输入，必须先过 safeBindIp 才拼进命令行 */
ok('★ 拼 --interface 之前先过 safeBindIp（漏了就是命令注入）',
	/let bind = safeBindIp\(getStr\(req\.args, 'bind'\)\);/.test(ucSrc)
	&& /if \(bind == null\) \{\s*\n\s*return \{ success: false/.test(ucSrc));

const safeBind = grab('safeBindIp', ucSrc);
function truthyTable(fnBody) {
	/*
	 * 把 safeBindIp 变成一个可执行的判定：ucode 与 JS 在这几行语法上一致
	 * （length/substr/for 都一样），直接 eval 即可。
	 */
	// eslint-disable-next-line no-new-func
	return new Function('s', 'length', 'substr', fnBody + '; return safeBindIp(s);');
}
const evalBind = truthyTable(safeBind);
ok('★ safeBindIp("") → 不绑定（空串合法，多出口时可不绑）', evalBind('', (x) => x.length, (a, b, c) => a.substr(b, c)) === '');
ok('★ safeBindIp("10.68.233.15") 放行',
	evalBind('10.68.233.15', (x) => x.length, (a, b, c) => a.substr(b, c)) === '10.68.233.15');
ok('★ safeBindIp("10.68.233.15; rm -rf /") 拒绝（分号/空格/斜杠一律 null）',
	evalBind('10.68.233.15; rm -rf /', (x) => x.length, (a, b, c) => a.substr(b, c)) === null);
ok('★ safeBindIp("1.2.3.4 && curl evil") 拒绝',
	evalBind('1.2.3.4 && curl evil', (x) => x.length, (a, b, c) => a.substr(b, c)) === null);
ok('★ safeBindIp("....") 拒绝（3 个点但 0 位数字）',
	evalBind('....', (x) => x.length, (a, b, c) => a.substr(b, c)) === null);
ok('★ safeBindIp("999.1.1.1") 形态上放行（值域校验交给调用方与 curl，这里不越权判语义）',
	evalBind('999.1.1.1', (x) => x.length, (a, b, c) => a.substr(b, c)) === '999.1.1.1');
ok('★ safeBindIp 长度上限 15（超长直接 null，挡住拼接型输入）',
	evalBind('1.2.3.4.5.6.7.8.9', (x) => x.length, (a, b, c) => a.substr(b, c)) === null);

/* ---------- 2. 通路：ACL 与 rpc 声明 ---------- */

/* ACL 有 read 段与 write 段两处 mt5700 列表，漏一处就 Access denied */
const aclLists = aclSrc.match(/"mt5700": \[[\s\S]*?\]/g) || [];
ok('★ ACL 里至少两处 mt5700 方法列表', aclLists.length >= 2, '实际 ' + aclLists.length + ' 处');
ok('★ ACL 每一处 mt5700 列表都放行了 exitip（漏一处＝页面静默失败）',
	aclLists.length > 0 && aclLists.every(function (s) { return /"exitip"/.test(s); }),
	JSON.stringify(aclLists.map(function (s) { return /"exitip"/.test(s); })));
ok('rpc.js 声明了 mt5700.exitip', /method: 'exitip'/.test(rpcSrc));
ok('rpc.js 暴露了 AtWs.exitIp', /\bexitIp: fetchExitIp/.test(rpcSrc));

/* ---------- 3. 取值口径：取不到必须报失败，不许给占位值 ---------- */

ok('★ 取到的响应不是 IP → 判失败并带 error（不许把错误页当地址）',
	/回显服务返回的内容不是 IP/.test(rpcSrc));
ok('★ 失败路径返回的 ip 是空串，不是 0.0.0.0 之类占位（红线 23）',
	/return \{ success: false, ip: ''/.test(rpcSrc));
ok('★ 探测带超时（后端三个端点最坏 24s，前端 20s 先失败，不让用户干等）',
	/withTimeout\(rpcExitIp\(bind \|\| ''\), 20000/.test(rpcSrc));

/* ---------- 4. Parse.parseExitIpBody ---------- */

eq('裸 IPv4 直接认', Parse.parseExitIpBody('203.0.113.7'), '203.0.113.7');
eq('带换行的裸 IPv4（trim 后认）', Parse.parseExitIpBody('  203.0.113.7\n'), '203.0.113.7');
eq('ipip 那种带中文说明的响应只取 IP',
	Parse.parseExitIpBody('当前 IP：203.0.113.7 来自于：中国 北京'), '203.0.113.7');
eq('IPv6 认', Parse.parseExitIpBody('2001:db8::1'), '2001:db8::1');
eq('空串 → null（不是 0.0.0.0）', Parse.parseExitIpBody(''), null);
eq('null → null', Parse.parseExitIpBody(null), null);
eq('HTML 错误页 → null（不许当地址显示）',
	Parse.parseExitIpBody('<html><head><title>502 Bad Gateway</title></head></html>'), null);
eq('纯文本无 IP → null', Parse.parseExitIpBody('service unavailable'), null);
eq('★ 段值越界（999.1.1.1）→ null（不许把非法地址当出口 IP）',
	Parse.parseExitIpBody('999.1.1.1'), null);
eq('★ 只有三段 → null', Parse.parseExitIpBody('10.68.233'), null);

/* ---------- 5. 前端：不自动轮换 + 失败有出口 ---------- */

ok('★ esim.js 在切换前先抓 prevRaw（下发后列表会被重渲染，晚一步就取不回来）',
	/var prevRaw = currentEnabledRaw;/.test(esimSrc));
ok('★ 只在「启用另一张」且原卡已知时才给切回入口（禁用场景不误给）',
	/if \(verb === '启用' && prevIccidHex && prevIccidHex !== expectIccidHex\)/.test(esimSrc));
ok('★ 提供「切回原 Profile」入口', /Mt5700\.dangerButton\('切回原 Profile'/.test(esimSrc));
ok('★ 不自动回滚：切回必须经确认框（断网操作要可预期）',
	/function restoreProfile[\s\S]{0,400}?Mt5700\.confirm/.test(esimSrc));
ok('★ 轮换本身仍由用户手动触发（单模组＝唯一上行，不引入定时自动切换）',
	!/setInterval\([\s\S]{0,200}?(enableProfile|rotateProfile)/.test(esimSrc));
ok('★ 换 IP 结论区分三种：已变 / 未变 / 无法判定（不许把「读不出来」当「没变」）',
	/出口 IP 已变/.test(esimSrc)
	&& /出口 IP 未变/.test(esimSrc)
	&& /出口 IP 无法判定/.test(esimSrc)
	&& /这不是「没变」/.test(esimSrc));
ok('★ 出口 IP 与承载地址是两个字段分别记（CGNAT 下两者不是一回事）',
	/addr: ''/.test(esimSrc) && /exit: ''/.test(esimSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	console.log('出口 IP 契约测试失败 ' + fails.length + ' 项：');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	console.log('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	process.exit(1);
}
console.log('出口 IP 契约测试全部通过');
console.log('通过 ' + pass + ' 项，失败 0 项');
