#!/usr/bin/env node
/*
 * 短信可达性（承载域 × CS 域交叉判据）契约测试
 * ---------------------------------------------------------------------------
 * 2026-09-24：真机实测校准后的守卫。
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
 *   ③ 前端判据必须是**双条件**（preferCs 且 CS 实测未注册），且落在 renderReachability 块内
 *   ④ 必须真的去读 AT+CREG?（没有这一项交叉判据就是空的）
 *   ⑤ 旧的写死文案「5G SA）没有 CS 域」不得残留（红线 13）
 *   ⑥ IMS 能力值（ext_info）在 <n>=1 时不上报，界面必须写「未上报」而非倒推不可用
 *
 * 运行：node tests/sms-reachability-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');
const SMS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_settings.js');

const pSrc = fs.readFileSync(PARSE, 'utf8');
const smsSrc = fs.readFileSync(SMS, 'utf8');

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

/* ---------- ③ 判据必须是双条件，且落在 renderReachability 块内 ---------- */

/*
 * ★ 收窄到块内（红线 17c）：`preferCs` 在 parse.js 与 connection-tools 里也有同形出现，
 *   跨文件/跨函数的宽松正则会被别处的同形代码顶住而恒绿。
 */
const fnIdx = smsSrc.indexOf('function renderReachability(');
ok('renderReachability 可定位', fnIdx >= 0);
const block = fnIdx >= 0 ? smsSrc.slice(fnIdx, smsSrc.indexOf('\n\t\t}', fnIdx)) : '';

ok('★ 判据含 preferCs（条件一：承载域取向）',
	/preferCs/.test(block), '块内未找到 preferCs');
ok('★ 判据含 v\.cs\.registered（条件二：CS 域实测）',
	/v\.cs\.registered/.test(block), '块内未找到 v.cs.registered —— 会退化成单条件假设判据');

/*
 * ★ 关键：两个条件必须在**同一个条件表达式**里（AND），
 *   分成两个独立 if 就不是交叉判据了。
 */
ok('★ 两个条件在同一个 && 表达式里（真交叉，不是两个独立 if）',
	/preferCs\s*&&\s*!v\.cs\.registered/.test(block),
	'未找到 `preferCs && !v.cs.registered` 的合取形式');

/* ---------- ④ 必须真的读 AT+CREG? ---------- */

const loadIdx = smsSrc.indexOf('function loadReachability(');
ok('loadReachability 可定位', loadIdx >= 0);
const loadBlock = loadIdx >= 0 ? smsSrc.slice(loadIdx, smsSrc.indexOf('\n\t\t}', loadIdx)) : '';

ok('★ 可达性读取了 AT+CREG?（否则交叉判据的第二条件永远是 null）',
	/AT\+CREG\?/.test(loadBlock));
ok('★ 用 parseCsDomain 解析（不是自己另写一套 stat 口径）',
	/parseCsDomain/.test(loadBlock));
ok('★ v.cs 初值进 v 对象（漏了会 undefined，判据恒走 unknown 分支）',
	/var v = \{[^}]*cs:\s*null/.test(loadBlock));

/* ---------- ⑤ 旧的错误文案不得残留（红线 13） ---------- */

ok('★ 旧的写死假设「5G SA）没有 CS 域」已清除',
	!/5G SA[）)]?没有 CS 域/.test(smsSrc), '仍残留按假设倒推的文案');

/* ---------- ⑥ IMS 能力值：n=1 时不上报，不许倒推 ---------- */

ok('★ 能力值未上报时写「未上报」而不是判不可用',
	/能力值未上报/.test(smsSrc));
/*
 * 反向：不许出现「能力值读不到 ⇒ IMS 短信不可用」这类倒推。
 * 手册 7.6：<n>=1 只上报 reg_info，ext_info 要 <n>=2 的 URC 才带。
 */
ok('★ 反例：不得出现「能力值」与「不可用」直接相连的结论句',
	!/能力值[^'"]{0,20}不可用/.test(smsSrc));

/* ---------- 汇总 ---------- */

if (fails.length) {
	/*
	 * ★ 输出格式必须带前导两空格：`tools/verify-guards.py` 用 `out.count('\n  ✗')`
	 *   统计「变异被哪几条断言抓住」。写成 `'✗ '` 会让它数出 0 —— 于是变异明明被
	 *   检出了、报告却显示「判红 0 处」，下一个人会以为这组守卫是装饰品（而且
	 *   将来脚本一旦改成依赖该计数判成败，就会静默失守）。全仓统一 `'  ✗ '`。
	 */
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	console.log('\n通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	process.exit(1);
}
console.log('通过 ' + pass + ' 项，失败 0 项');
console.log('短信可达性（承载域 × CS 域交叉判据）契约测试全部通过');
