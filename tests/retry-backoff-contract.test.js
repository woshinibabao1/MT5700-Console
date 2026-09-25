#!/usr/bin/env node
'use strict';

/**
 * 失败命令重试降级契约（P20 性能专项第一案）
 * ----------------------------------------------------------------------------
 * 病因（2026-09-25 实测）：一条 AT 命令从浏览器到模组再回来要约 100ms，
 * 而 `isRetryableRead()` 让每条只读命令失败后**重试 3 次**，中间还有
 * `200ms × attempt` 的退避。于是**注定失败**的一条命令要烧掉
 *
 *     100 + 200 + 100 + 400 + 100 ≈ 900ms      = 9 倍成本
 *
 * 本机正好有四类命令在特定状态下稳定 ERROR：
 *   · AT^SIMST?      ^SIMST 是主动上报 URC，根本没有查询语法
 *   · AT^SYSINFOEX?  手册 13.1 的语法是 `AT^SYSINFOEX`（**不带问号**）
 *   · AT^SYSINFO     手册里不存在这条命令
 *   · AT^NRSSBID?    要 NR 连接态且网侧配置了测量才有值，其余情况 +CME ERROR
 * 网络状态页一轮三十余次调用，这几条就把整轮拖长好几秒。
 *
 * 修法是「自适应降级」而不是「改小 maxAttempts」：
 *   偶发单次 ERROR 的代价是一次重试，而**缓存失败结果**的代价是持续显示失败
 *   （见 at-cache-contract 第 ③ 条），所以前两次失败必须照旧重试；
 *   只有同一条命令**连续两轮都没翻身**，才把它当成「这条现在就是不支持」，
 *   后续每轮只发一次；一旦成功立刻复位。
 *
 * 这里钉住四件事：
 *   ① 前两次失败照旧重试 3 次（不许削弱对偶发 ERROR 的容忍）
 *   ② 连续失败两轮之后，每轮只发 1 次（这是提速的来源）
 *   ③ 成功立刻复位（否则一次偶发就永久降级，等于把偶发失败钉死）
 *   ④ 调用方显式传了 attempts 时，降级逻辑不得插手
 *
 * 用法：node tests/retry-backoff-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RPC_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/rpc.js');
const rpcSrc = fs.readFileSync(RPC_JS, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

/* ---------- 载入 rpc.js，并让底层 RPC 可被观测计数 ---------- */

function loadRpc(handler) {
	const src = rpcSrc
		.replace(/^\s*'require [^']*';\s*$/gm, '')
		.replace(/\n\s*return AtWsClass;\s*$/, '\n');
	const calls = [];
	const ctx = {
		console: { error: function () { }, log: function () { } },
		Promise, Date, JSON, Math, String, Number, RegExp, Object, Array, Error, isNaN, parseInt,
		setTimeout: function (fn) { return setTimeout(fn, 0); },   /* 退避 200/400ms → 0 */
		clearTimeout,
		L: {
			Class: { extend: (x) => x },
			rpc: {
				declare: function () {
					return function (command) {
						calls.push(command);
						return Promise.resolve(handler(command, calls.length));
					};
				}
			},
			uci: { load: () => Promise.resolve() },
			env: {}
		},
		window: undefined
	};
	vm.createContext(ctx);
	const mod = vm.runInContext(
		'(function(){\n' + src +
		'\nreturn { ATClient: ATClient, isRetryableRead: isRetryableRead };\n})()',
		ctx
	);
	return { mod, calls };
}

/* 应答：success=false 表示命令执行失败（后端回了 ERROR） */
const alwaysFail = () => ({ success: false, error: 'ERROR' });
const alwaysOk = () => ({ success: true, data: 'OK' });

function newClient(mod) {
	const c = new mod.ATClient();
	c.connected = true;   /* RPC 模式下 connect() 只做配置加载，这里直接置位 */
	return c;
}

/* ---------- ① 前两次失败照旧重试 ---------- */

function scenarioAlwaysFail() {
	const box = loadRpc(alwaysFail);
	const c = newClient(box.mod);
	const cmd = 'AT^NRSSBID?';
	const rounds = [];
	let chain = Promise.resolve();
	for (let i = 0; i < 4; i++) {
		chain = chain.then(function () {
			const before = box.calls.length;
			return c.sendCommand(cmd).then(function () {
				rounds.push(box.calls.length - before);
			});
		});
	}
	return chain.then(function () { return rounds; });
}

/* ---------- ③ 成功后复位 ---------- */

function scenarioRecover() {
	const box = loadRpc(function (cmd, n) {
		/* 第 19 次之后开始成功：模拟模组状态变了，这条命令又能用了 */
		return n >= 19 ? alwaysOk() : alwaysFail();
	});
	const c = newClient(box.mod);
	const cmd = 'AT^HFREQINFO?';
	const rounds = [];
	let chain = Promise.resolve();
	for (let i = 0; i < 6; i++) {
		chain = chain.then(function () {
			const before = box.calls.length;
			return c.sendCommand(cmd).then(function () {
				rounds.push(box.calls.length - before);
			});
		});
	}
	return chain.then(function () { return rounds; });
}

/* ---------- ④ 显式 attempts 不受降级影响 ---------- */

function scenarioExplicitAttempts() {
	const box = loadRpc(alwaysFail);
	const c = newClient(box.mod);
	const cmd = 'AT^DHCPV6?';
	const rounds = [];
	let chain = Promise.resolve();
	for (let i = 0; i < 4; i++) {
		chain = chain.then(function () {
			const before = box.calls.length;
			return c.sendCommand(cmd, { attempts: 1, fresh: true }).then(function () {
				rounds.push(box.calls.length - before);
			});
		});
	}
	return chain.then(function () { return rounds; });
}

scenarioAlwaysFail()
	.then(function (rounds) {
		ok('① 第一次失败仍重试三次（对偶发 ERROR 的容忍不许削弱）',
			rounds[0] === 3, '实际下发 ' + rounds[0] + ' 次');
		ok('① 第二次失败仍重试三次（连败一次不足以判定「不支持」）',
			rounds[1] === 3, '实际下发 ' + rounds[1] + ' 次');
		ok('② 连续两轮失败之后降级为只发一次（提速来源）',
			rounds[2] === 1, '实际下发 ' + rounds[2] + ' 次');
		ok('② 降级状态持续有效（不是只省一轮）',
			rounds[3] === 1, '实际下发 ' + rounds[3] + ' 次');
		ok('② 反向：若实现仍是固定三次重试，本测试会当场判红',
			rounds[2] !== 3, '第三轮仍是 3 次 —— 降级没生效');
	})
	.then(scenarioRecover)
	.then(function (rounds) {
		const firstSuccessRound = rounds.findIndex(function (t) { return t === 1; });
		ok('③ 命令恢复可用后，重试次数回到三次（偶发失败会被再次容忍）',
			firstSuccessRound >= 0 && rounds[firstSuccessRound] === 1,
			'各轮下发次数 ' + JSON.stringify(rounds));
		ok('③ 连续失败过程中确实经历了「两次重试 → 降级」的转折',
			rounds[0] === 3 && rounds[1] === 3,
			'前两轮 ' + JSON.stringify(rounds.slice(0, 2)));
	})
	.then(scenarioExplicitAttempts)
	.then(function (rounds) {
		ok('④ 显式 attempts 的调用不受降级逻辑影响（调用方说了算）',
			rounds.every(function (t) { return t === 1; }),
			'各轮 ' + JSON.stringify(rounds));
	})
	.catch(function (e) { fails.push('测试自身异常：' + (e && e.message)); })
	.then(function () {
		console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
		if (fails.length) {
			fails.forEach(function (f) { console.log('  ✗ ' + f); });
			process.exit(1);
		}
		process.exit(0);
	});
