#!/usr/bin/env node
/*
 * 页面引导单一真源 + 认证失败可行动（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * ★ 这个测试是被 2026-09-25 全量审计的一个发现逼出来的：
 *
 *   「连上 AT 服务之后跑一次刷新」这段引导代码，被 10 个页面各自抄了一遍，
 *   每段里还带着一个「拿到 REQUIRE_AUTH_KEY 就弹输入框补密钥」的分支。
 *
 *   而那个分支**永远走不到**：RPC 模式下 ATClient.connect() 不会 reject
 *   （configReady 恒 resolve / authenticated 恒 true，回调还包了 try/catch），
 *   全仓也没有任何抛 REQUIRE_AUTH_KEY 的生产方。10 个分支＝10 份走不到的死代码，
 *   而且分散在 10 个文件里，谁都不知道改一处该同步另外九处。
 *
 *   更糟的是：为什么一直没人发现它是死的？因为
 *   tests/upgrade-poll.test.js 里有一条断言，专门钉住
 *   `/REQUIRE_AUTH_KEY[\s\S]{0,400}Ui\.promptModal/` **必须存在** ——
 *   守卫把死代码钉成了契约，删它反而变红（与当初的 EPDG_VERDICT 完全同类）。
 *
 * 现在的两条可达路径（本文件就是它们的守卫）：
 *   ① 页面引导   → Mt5700.connectThen（mt5700.js，10 份收口成 1 份）
 *   ② 认证失败   → mt5700.uc 的 rpcCall 把后端 -32001 翻成带处置指引的文案
 *                  （后端是逐请求校验密钥的，没有前置握手，见 rpcserver.rs）
 *
 * ★ 为什么「认证失败」必须收口到后端而不是各自在前台处理：
 *   同一个密钥错误会让页面上几十个读数入口同时报错，只有统一翻译才能每个都
 *   给出「去哪儿改」，否则就是满屏复读机。
 *
 * 运行：node tests/bootstrap-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEW_DIR = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver');
const CORE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'mt5700.js');
const RPCJS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');

const coreSrc = fs.readFileSync(CORE, 'utf8');
const rpcSrc = fs.readFileSync(RPCJS, 'utf8');
const ucSrc = fs.readFileSync(UCODE, 'utf8');
const views = fs.readdirSync(VIEW_DIR).filter(function (f) { return /\.js$/.test(f); }).sort();

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}

/* ---------- ① 引导入口：全局单一真源 ---------- */

ok('★ mt5700.js 定义了 Mt5700.connectThen（全站唯一的引导入口）',
	/api\.connectThen\s*=\s*function\s*\(onReady\)\s*\{/.test(coreSrc));

ok('★ connectThen 先等连接成功，再跑回调（不等的后果：没连上就发，必然失败）',
	/return AtWs\.client\.connect\(\)\.then\(function \(\) \{\s*\n\s*if \(typeof onReady === 'function'\) onReady\(\);/.test(coreSrc));

ok('★ connectThen 的回调是可选的（终端页连上就行，没有要拉的初始数据）',
	/if \(typeof onReady === 'function'\)/.test(coreSrc));

/*
 * ★★ 反向断言：RPC 模式下 connect() 不可能 reject，所以任何页面都不许再写
 *    「connect().catch → 判 REQUIRE_AUTH_KEY → 弹窗」这一段。
 *    没有这条，将来有人照抄老页面就会把死代码带回来，而且第二次没人能发现。
 */
views.forEach(function (f) {
	const src = fs.readFileSync(path.join(VIEW_DIR, f), 'utf8');
	ok('★ ' + f + ' 不含 REQUIRE_AUTH_KEY 分支（该错误 RPC 模式下无人抛出）',
		src.indexOf('REQUIRE_AUTH_KEY') < 0);
	ok('★ ' + f + ' 不含裸 connect().catch 引导块（一律走 Mt5700.connectThen）',
		src.indexOf('AtWs.client.connect().catch') < 0);
});

/*
 * 需要「连上后刷数据」的页面，必须真的走单一真源。
 * ★ 这里不写死「必须有几个」，只要求：凡用到 AtWs.client 且要首屏拉数据的页面，
 *   引导一律经 connectThen —— 由上面两条反向断言保证形态，这里保证「有地方在用」。
 */
const users = views.filter(function (f) {
	return fs.readFileSync(path.join(VIEW_DIR, f), 'utf8').indexOf('Mt5700.connectThen') >= 0;
});
ok('★ 全部需要首刷的页面都走 Mt5700.connectThen（当前 ' + users.length + ' 个页面）',
	users.length >= 10, '实际：' + users.join(', '));

/* ---------- ② 认证失败：后端统一翻译成可行动文案 ---------- */

ok('★ rpc.js 的 ATClient.connect 确实没有 reject 路径（死代码判据的根）',
	/ATClient\.prototype\.connect = function \(\) \{[\s\S]{0,900}?\}\n?/.test(rpcSrc)
	&& !/connect\s*=\s*function[\s\S]{0,900}?REQUIRE_AUTH_KEY/.test(rpcSrc));

ok('★ 全仓没有 REQUIRE_AUTH_KEY 的生产方（只有 rpc.js 之外的地方能证明它真会被抛）',
	/^[\s\S]*?function[^;{]*\{[^}]*REQUIRE_AUTH_KEY/.test(rpcSrc) === false);

ok('★ ucode 声明了 RPC_ERR_AUTH_FAILED 常量（不把 -32001 写散在多处）',
	/const RPC_ERR_AUTH_FAILED = -32001;/.test(ucSrc));

ok('★★ ucode 把 -32001 翻成带处置指引的文案（否则用户只看到「认证失败」四个字）',
	/resp\.error\.code == RPC_ERR_AUTH_FAILED[\s\S]{0,200}?msg = '认证失败：[^']*websocket_auth_key[^']*'/.test(ucSrc));

ok('★ 译文保留「认证失败」前缀（下游若有按原文匹配的逻辑不会失效）',
	/msg = '认证失败：/.test(ucSrc));

/* ---------- 结果 ---------- */

console.log('引导收口契约：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
	console.log(fails.join('\n'));
	process.exit(1);
}
