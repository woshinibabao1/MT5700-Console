#!/usr/bin/env node
/*
 * 短信承载域 / CS 域解析契约测试
 * ---------------------------------------------------------------------------
 * 2026-11-06：界面上那张「短信可达性」卡片已按用户口径下线
 *   （整块删除，含 loadReachability / renderReachability 与它的取数链）。
 *   本文件随之只保留**解析层**断言 —— parse.js 的 parseCsDomain / parseCgsms
 *   仍是公开 API（别的诊断路径将来可能用），而且它们的 stat 口径是踩过真机
 *   校准的，不该因为一个卡片下线就失去守卫。
 *   UI 判据类断言（双条件、必须读 AT+CREG? 等）随功能一起移除。
 *
 * 2026-09-24：真机实测校准后的依据（保留作历史记录）。
 *
 * 为什么单独一个文件：
 *   原先「短信承载域选了 CS 优先就报警」是**单条件**判据，措辞还写死
 *   「5G SA 下没有 CS 域」——那是假设不是实测。真机（中国移动卡）实测：
 *       +CGSMS: 3          （优先 CS）
 *       +CREG: 0,0         （CS 域未注册）   ← 原本根本没读这一项
 *       +CEREG: 2,1 / +C5GREG: 2,1（PS 侧正常）
 *       +CIREG: 1,1        （IMS 已注册）
 *   四条合起来才构成证据链；缺 +CREG 就只能靠假设倒推，机器回落 GSM/UMTS
 *   时 CS 域确实存在，那时 CGSMS=3 是**正确**配置，单条件会误报。
 *
 * 本测试覆盖：
 *   ① Parse.parseCsDomain：真机 stat 取值 → registered 判定（含漫游/搜网中/解析失败）
 *   ② Parse.parseCgsms：真机默认 3 的取向（只选/优先 CS 都算 preferCs）
 *
 * 运行：node tests/sms-reachability-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');

const pSrc = fs.readFileSync(PARSE, 'utf8');

const Parse = eval('(' + pSrc.match(/var Parse = \((function[\s\S]*?\n\})\)\(\);/)[1] + ')')();

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
/*
 * ★ eq 必须**自己记 pass/fail，不能转调 ok()**（红线 17d）。
 *   全仓有 assert-signature-contract 在扫「ok(…) 第一个参数是不是字符串字面量」——
 *   包装函数里写 ok(label, …) 时 label 是变量，会被判成「定义是 ok(label,…) 却传了
 *   表达式」，整批断言的顺序校验就此失效。内部统一直接 pass++ / fails.push。
 */
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* ---------- ① parseCsDomain：真机取值回归 ---------- */

ok('parseCsDomain 存在', typeof Parse.parseCsDomain === 'function');

// 真机实测值：+CREG: 0,0 —— CS 域未注册
const real = Parse.parseCsDomain('+CREG: 0,0\r\nOK');
ok('真机 +CREG: 0,0 能解析', real !== null);
eq('真机 stat=0', real && real.stat, 0);
eq('真机 CS 域判定为未注册', real && real.registered, false);

eq('stat=1（已注册本地网）→ registered', Parse.parseCsDomain('+CREG: 0,1').registered, true);
eq('stat=5（已注册漫游）→ registered', Parse.parseCsDomain('+CREG: 0,5').registered, true);
eq('stat=2（搜网中）→ 未注册', Parse.parseCsDomain('+CREG: 0,2').registered, false);
eq('stat=3（被拒）→ 未注册', Parse.parseCsDomain('+CREG: 0,3').registered, false);
eq('stat=8（仅紧急）→ 未注册', Parse.parseCsDomain('+CREG: 0,8').registered, false);
eq('无法解析 → null（不许按乐观值补齐）', Parse.parseCsDomain('ERROR'), null);
eq('空串 → null', Parse.parseCsDomain(''), null);

/* 回落场景（GSM/UMTS）：CS 域存在时 CGSMS=3 是正确配置，
   这条正是原单条件判据会误报的场景 —— 数据层必须判得出 registered=true。 */
eq('回落 GSM/UMTS 场景：stat=1 不得被判成未注册',
	Parse.parseCsDomain('+CREG: 0,1').registered, true);

/* ---------- ② parseCgsms：真机默认 3 ---------- */

const cg = Parse.parseCgsms('+CGSMS: 3');
eq('真机 CGSMS=3 → service', cg && cg.service, 3);
eq('真机 CGSMS=3 → preferCs', cg && cg.preferCs, true);
eq('CGSMS=1（只选 CS）同样 preferCs', Parse.parseCgsms('+CGSMS: 1').preferCs, true);
eq('CGSMS=2（优先 PS）→ preferCs=false', Parse.parseCgsms('+CGSMS: 2').preferCs, false);

/* ---------- 汇总 ----------
 * ★★★ 2026-11-06 修：此前这里直接印死「失败 0 项」「全部通过」，
 *   既不打印 fails 也不 process.exit(1)。后果是**任何断言失败都只让
 *   通过数从 16 掉到 15，退出码永远是 0**：
 *       verify-guards 的 [15]「CS 域判定丢掉 stat=5」变异因此被放过，
 *       CI 报「变异被放过」，而这条守卫从上一轮删可达性卡片重写本文件起
 *       就已经是死的（红线 18：测试自己也会失效）。
 *   现行口径与全仓一致：失败项以 `'  ✗ '` 打头（verify-guards 按这个前缀
 *   统计「判红 N 处」），有失败即 exit 1。
 */
if (fails.length) {
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（CS 域 stat 口径 / CGSMS 取向）');
process.exit(0);
