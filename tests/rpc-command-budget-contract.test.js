/*
 * 静态断言：前端命令总预算（P04）与悬空定时器（P11）
 * ----------------------------------------------------------------------------
 * P04：单条命令原本最坏 3 次重试 × 14s ≈ 42.6s，而后端最坏 13s、ucode 20s 兜底 ——
 *      其中约 29s 是后端早就放弃之后的纯空等，还会独占全局串行队列。
 * P11：withTimeout 竞速胜出后必须清掉另一路的定时器（等价改写，不声称性能提升）。
 *
 * 每条都有反向验证：旧文本喂给同一检查函数必须判红。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) { pass++; }
	else { fails.push(detail ? name + ' :: ' + detail : name); }
}

const src = fs.readFileSync(SRC, 'utf8');

/* ---------------- P04：总预算 ---------------- */
ok('P04 sendCommand 声明了默认 20000ms 的总预算（对齐 ucode 的 timeout 20）',
	/var budget = opt\.budgetMs != null \? opt\.budgetMs : 20000;/.test(src),
	'没有总预算，单条命令仍会占满 42 秒');
ok('P04 重试前判断预算是否已用尽（且第一次必发）',
	/if \(attempt > 1 && \(Date\.now\(\) - t0\) >= budget\)/.test(src),
	'缺少预算判断；注意第一次必须照发，否则 budget 很小时命令永远发不出去');
ok('P04 单次超时取 min(commandTimeout, 剩余预算)',
	/var waitMs = Math\.max\(1000,[\s\S]{0,80}Math\.min\(self\.commandTimeout, budget - \(Date\.now\(\) - t0\)\)\)/.test(src),
	'单次超时没有按剩余预算收敛');
/* 反向：改动前的旧片段必须被判红 */
const oldSend = "		var attemptOnce = function () {\n"
	+ "			attempt++;\n"
	+ "			if (!self.connected) return { success: false, error: '未连接到调制解调器' };\n"
	+ "			return withTimeout(rpcAt(command), self.commandTimeout,\n";
ok('P04 反向：旧的「无预算」写法被同一检查判为不通过',
	!/var budget = opt\.budgetMs/.test(oldSend) && !/attempt > 1 && \(Date\.now\(\) - t0\)/.test(oldSend),
	'旧片段竟被判为通过，检查函数无效');

/* ---------------- P11：竞速后清定时器 ---------------- */
const wt = src.slice(src.indexOf('function withTimeout('), src.indexOf('function withTimeout(') + 900);
ok('P11 withTimeout 内持有定时器句柄并清理',
	/var h = null;/.test(wt) && /clearTimeout\(h\)/.test(wt),
	'withTimeout 仍留下悬空的 setTimeout');
ok('P11 成功与失败两条路径都清理（then 的第二参）',
	/\.then\(function \(v\) \{ clear\(\); return v; \}/.test(wt)
	&& /function \(e\) \{ clear\(\); throw e; \}/.test(wt),
	'只清了一条路径，另一条仍会留下定时器');
/* 反向：改动前的旧实现必须被判红 */
const oldWt = "function withTimeout(p, ms, msg) {\n"
	+ "	return Promise.race([\n"
	+ "		p,\n"
	+ "		new Promise(function (resolve, reject) {\n"
	+ "			setTimeout(function () { reject(new Error(msg || '请求超时')); }, ms);\n"
	+ "		})\n"
	+ "	]);\n"
	+ "}\n";
ok('P11 反向：旧的 Promise.race 直挂写法被判为不通过',
	!/clearTimeout/.test(oldWt),
	'旧实现竟被判为通过，检查函数无效');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
process.exit(0);
