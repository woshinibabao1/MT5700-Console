#!/usr/bin/env node
/*
 * 「连接看门狗已彻底删除」守卫测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景（2026-09-20，用户拍板）：砍掉整个看门狗功能。
 *
 *   它常驻轮询、断网后自动续约 / 复位。问题是在「卡上没有 Profile → 永远注册
 *   不上网」这种注定失败的场景下，它会持续制造 ifdown/ifup churn（真机异常累计
 *   400+），把设备越拖越卡；而断网排查页本来就能给出只读体检与建议命令，
 *   自动动作反而抢了用户的判断。网口重枚举时的 DHCP 续约仍由 hotplug 脚本
 *   `99-mt5700-renew` **事件驱动**地做一次，不依赖常驻轮询。
 *
 * ★ 这个测试存在的唯一理由：删除是跨 10+ 文件的动作，最容易留下**半截引用**
 *   —— 脚本删了但 init.d 还在、UCI 键删了但 UI 还在读、测试还钉着已删除的键。
 *   这类残留不会报错，只会静默退化（读到一个恒空的 UCI 键、指向不存在的服务）。
 *   所以这里按「文件 / 配置 / UI / 后端事实表 / 文档」五层各钉一条。
 *
 * 运行：node tests/watchdog-removed-contract.test.js
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

/* ---------- 1. 功能本体：服务与脚本必须真的不存在 ---------- */
ok('init.d/mt5700-watchdog 已删除', gone('root/etc/init.d/mt5700-watchdog'));
ok('usr/share/mt5700/watchdog.sh 已删除', gone('root/usr/share/mt5700/watchdog.sh'));
ok('看门狗专项测试已删除', gone('tests/watchdog-routing.test.js') &&
	gone('tests/watchdog-routing.test.sh') && gone('tests/watchdog-nc-contract.test.js'));
ok('Makefile 不再给看门狗脚本 chmod', !/mt5700-watchdog/.test(read('Makefile') || ''));
ok('run-all.js 不再列看门狗测试', !/watchdog/i.test(read('tests/run-all.js') || ''));

/* ---------- 2. UCI：7 个 watch_* 键必须清干净 ---------- */
const uciCfg = read('root/etc/config/at-webserver') || '';
ok('随包 UCI 配置不再有 watch_* 键', !/watch_/.test(uciCfg));
const uciDef = read('root/etc/uci-defaults/at-webserver') || '';
ok('uci-defaults 不再补 watch_* 默认值', !/watch_/.test(uciDef));
ok('uci-defaults 不再 enable/start 看门狗服务', !/mt5700-watchdog/.test(uciDef));

/* ---------- 3. 前端：配置页区块与排查项 ---------- */
const svc = read('htdocs/luci-static/resources/view/at-webserver/service.js') || '';
ok('「服务配置」页不再有看门狗设置区块', !/watch_|看门狗/.test(svc));
const ns = read('htdocs/luci-static/resources/view/at-webserver/network_status.js') || '';
ok('断网排查不再有「看门狗」检查项', !/svc_watchdog/.test(ns));
ok('★ 接口名不再依赖已删除的 watch_iface（那个键恒空）', !/watch_iface/.test(ns));

/* ---------- 4. 后端事实表：diag-probe 不再上报 svc_watchdog ---------- */
const diag = read('root/usr/share/mt5700/diag-probe.sh') || '';
ok('diag-probe.sh 不再 emit svc_watchdog', !/svc_watchdog/.test(diag));
ok('diag-probe.sh 注释不再宣称与 watchdog 分工', !/watchdog\.sh/.test(diag));

/* ---------- 5. 反向：把任一处放回去，守卫必须检出（证明不是恒绿） ---------- */
function hasWatchKey(s) { return /watch_/.test(s); }
function hasSvcFact(s) { return /svc_watchdog/.test(s); }
ok('★ 反向：uci 配置若重新出现 watch_enabled，守卫必须检出',
	hasWatchKey(uciCfg) === false &&
	hasWatchKey(uciCfg + '\n\toption watch_enabled 1') === true);
ok('★ 反向：diag 若重新 emit svc_watchdog，守卫必须检出',
	hasSvcFact(diag) === false &&
	hasSvcFact(diag + '\nemit svc_watchdog 1') === true);
ok('★ 反向：gone() 对存在的文件必须返回 false（否则上面 4 条全是恒绿）',
	gone('Makefile') === false && gone('root/etc/init.d/at-webserver') === false);

/* ---------- 汇总 ---------- */
if (fails.length) {
	console.log('✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（连接看门狗已彻底删除，无半截引用）');
