#!/usr/bin/env node
/*
 * 「全网扫频已下线，且不再留半截引用」守卫测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景：全网扫频**页面**已下线（CHANGELOG「变更 - 下线「全网扫频」」）——
 *   视图 scan.js、菜单项、parse.js 的 parseScan* / buildScanCommand 都已移除。
 *
 * ★ 用户 2026-09-26 的追问：「我不是已经删除全网扫频了么？为什么不删干净？」
 *   查下来确实有三类半截引用：
 *     · 配置里 `cellscan_timeout` 的注释仍把它描述成「一次 ^CELLSCAN 全网扫频
 *       允许运行的秒数」，读起来像是活功能；旁边 read_cache_static_ttl 的注释
 *       还被复制粘贴成了同一句（张冠李戴）。
 *     · 前端 handlePush 仍认 `cellscan` / `memory_full` 两个事件 —— 前者无任何
 *       消费方（全站只有两个订阅者：urc_data 与 new_sms），后者后端根本不发。
 *     · po/pot 里 11 条翻译只在历史记录里还活着。
 *
 * ★ 本测试同时钉住那条**刻意保留**的东西，免得以后被「顺手删掉」：
 *   Rust 后端仍拦截 `AT^CELLSCAN`（伪命令 + 超时 + ABORT）。这不是残留，是安全网：
 *   一旦去掉拦截，用户在 AT 调试终端里手敲 `AT^CELLSCAN` 就会**原样下发到模组**，
 *   变成一次无上限的整网扫频、独占串口好几分钟 —— 比现在更糟。
 *   因此「Rust 拦截 / ucode 永不缓存名单 / 配置里的超时」三者必须**同时在场或
 *   同时缺席**，不许只删其中一处（这正是「同一件事有两个家」的典型）。
 *
 * 运行：node tests/cellscan-removed-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = function (rel) { return path.join(ROOT, rel); };

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
function read(rel) {
	try { return fs.readFileSync(P(rel), 'utf8'); } catch (e) { return null; }
}
function gone(rel) {
	try { fs.accessSync(P(rel)); return false; } catch (e) { return true; }
}

const rpcJs = read('htdocs/luci-static/resources/at-webserver/rpc.js') || '';
const parseJs = read('htdocs/luci-static/resources/at-webserver/parse.js') || '';
const menuJson = read('root/usr/share/luci/menu.d/luci-app-mt5700.json') || '';
const ucode = read('root/usr/share/rpcd/ucode/mt5700.uc') || '';
const cfg = read('root/etc/config/at-webserver') || '';
const rpcRs = read('src/rust/src/rpcserver.rs') || '';
const po = read('po/zh_Hans/luci-app-mt5700.po') || '';
const pot = read('po/templates/luci-app-mt5700.pot') || '';

/* ---------- 1. 功能本体：视图 / 菜单 / 解析段 ---------- */
ok('视图 scan.js 已删除', gone('htdocs/luci-static/resources/view/at-webserver/scan.js'));
ok('菜单里不再有扫频入口', !/scan/i.test(menuJson));
ok('parse.js 不再有 parseScan* 解析段', !/parseScan/.test(parseJs));
ok('parse.js 不再有 buildScanCommand', !/buildScanCommand/.test(parseJs));

/* ---------- 2. 前端：不再认这两个没人消费的事件 ---------- */
function feEvents(src) {
	const m = src.match(/\[([^\]]*?)\]\.indexOf\(ev\.type\)/);
	if (!m) return null;
	return (m[1].match(/'([a-z_][a-z0-9_]*)'/g) || []).map(function (x) {
		return x.slice(1, -1);
	});
}
const evList = feEvents(rpcJs);
ok('★ handlePush 事件名单能解析出来（否则下面两条恒绿）', Array.isArray(evList) && evList.length >= 3,
	JSON.stringify(evList));
ok('handlePush 不再认 cellscan（后端推来按预期丢弃）',
	!!evList && evList.indexOf('cellscan') < 0, JSON.stringify(evList));
ok('handlePush 不再认 memory_full（后端从不发它）',
	!!evList && evList.indexOf('memory_full') < 0, JSON.stringify(evList));
ok('仍认得真正有生产方与消费方的两个事件',
	!!evList && evList.indexOf('urc_data') >= 0 && evList.indexOf('new_sms') >= 0,
	JSON.stringify(evList));

/* ---------- 3. ★ 三处耦合：必须同时在场或同时缺席 ---------- */
/* Rust 侧钉的是**真正那句拦截**，不是「文件里出现过 AT^CELLSCAN」——
   后者在 rpcserver.rs 里出现十几次，单点变异翻不动它，反向断言就测不准。 */
function hasIntercept(src) {
	return /starts_with\("AT\^CELLSCAN"\)/.test(src);
}
const rustIntercepts = hasIntercept(rpcRs);
const ucodeNever = /'AT\^CELLSCAN'/.test(ucode);
const cfgTimeout = /option\s+cellscan_timeout\b/.test(cfg);
const allIn = rustIntercepts && ucodeNever && cfgTimeout;
const allOut = !rustIntercepts && !ucodeNever && !cfgTimeout;
ok('★ Rust 拦截 / ucode 永不缓存名单 / 配置超时 —— 三者必须同步（同在场或同缺席）',
	allIn || allOut,
	'rust=' + rustIntercepts + ' ucode=' + ucodeNever + ' cfg=' + cfgTimeout);
ok('（当前状态）三者都在场：说明终端误发 AT^CELLSCAN 仍有超时兜底', allIn);

/* ---------- 4. 配置：注释不得再把已下线功能说成活的 ---------- */
ok('cellscan_timeout 的注释已改写成「仅终端安全网」口径',
	/cellscan_timeout[^\n]*仅用于终端/.test(cfg), cfg.split('\n').filter(function (l) {
		return l.indexOf('cellscan_timeout') >= 0;
	}).join(' | ').slice(0, 160));
ok('★ 旧的错误口径「一次 ^CELLSCAN 全网扫频允许运行的秒数」已不存在',
	!/全网扫频允许运行的秒数/.test(cfg));
ok('★ read_cache_static_ttl 不再挂着扫频的注释（曾张冠李戴）',
	!/read_cache_static_ttl[^\n]*CELLSCAN/.test(cfg));

/* ---------- 5. i18n：孤儿翻译已清 ---------- */
ok('po 里不再有「全网扫频」词条', po.indexOf('msgid "全网扫频"') < 0);
ok('pot 里不再有「全网扫频」词条', pot.indexOf('msgid "全网扫频"') < 0);

/* ---------- 6. 常驻扫描器在位 ---------- */
ok('孤儿扫描器 tools/find-orphans.py 在位（这一类问题以后自动抓）',
	!gone('tools/find-orphans.py'));

/* ---------- 7. 反向：把任一处放回去，守卫必须检出 ---------- */
function hasScanEvent(src) {
	const list = feEvents(src);
	return !!list && list.indexOf('cellscan') >= 0;
}
ok('★ 反向：handlePush 若重新放回 cellscan，守卫必须检出',
	hasScanEvent(rpcJs) === false &&
	hasScanEvent(rpcJs.replace("'pdcp_data'", "'pdcp_data', 'cellscan'")) === true);
ok('★ 反向：配置若重新写成旧口径，守卫必须检出',
	!/全网扫频允许运行的秒数/.test(cfg) &&
	/全网扫频允许运行的秒数/.test(cfg + '\n# 一次 ^CELLSCAN 全网扫频允许运行的秒数\n') === true);
/* 三处耦合的判定函数：分开传三个源，反向断言才能精确拆掉其中一处。
   ★ 首版把 ucode 与 cfg 写死在闭包里、只让 rust 可换，于是「拆掉 ucode 那一处」
     的替换串用的是 Rust 的写法（`"AT^CELLSCAN"`）而不是 ucode 的（`'AT^CELLSCAN'`），
     替换根本没生效 —— 反向断言测了个空气。 */
function coupling(rustSrc, ucodeSrc, cfgSrc) {
	const r = hasIntercept(rustSrc);
	const u = /'AT\^CELLSCAN'/.test(ucodeSrc);
	const c = /option\s+cellscan_timeout\b/.test(cfgSrc);
	return (r && u && c) || (!r && !u && !c);
}
ok('★ 反向：拆掉 ucode 那一条，耦合检查必须报红',
	coupling(rpcRs, ucode, cfg) === true &&
	coupling(rpcRs, ucode.replace("'AT^CELLSCAN', ", ''), cfg) === false);
ok('★ 反向：拆掉配置那一条，耦合检查同样必须报红',
	coupling(rpcRs, ucode, cfg.replace(/option\s+cellscan_timeout[^\n]*\n/, '')) === false);
ok('★ 反向：拆掉 Rust 那句拦截，耦合检查必须报红',
	coupling(rpcRs.replace(/starts_with\("AT\^CELLSCAN"\)/, 'starts_with("AT^NOPE")'),
		ucode, cfg) === false);
ok('★ 反向：gone() 对存在的文件必须返回 false（否则第 1 节全恒绿）',
	gone('Makefile') === false && gone('tests/run-all.js') === false);

/* ---------- 汇总 ---------- */
if (fails.length) {
	/* ★ 失败项前缀必须是 `  ✗ `：tools/verify-guards.py 用 `out.count('  ✗')`
	   统计「这个变异被几处断言抓住」。写成别的符号（首版写的是 `  - `）会让
	   统计恒为 0 处 —— 守卫其实生效了，报告却显示「判红 0 处」，看着像没干活。 */
	console.log('✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（全网扫频页面已下线，无半截引用；后端安全网三处同步在场）');
