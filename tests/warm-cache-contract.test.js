#!/usr/bin/env node
'use strict';

/**
 * 批量预热契约（P20 性能专项第二案）
 * ----------------------------------------------------------------------------
 * 做法是「先一趟取回来塞进既有读缓存，各卡片照旧各读各的」：
 * 好处是**完全不改动任何调用方** —— 预热没帮上忙也只是走原路径，不会有回归面。
 *
 * 但正因为它是往缓存里写东西，弄错的代价是「界面显示别人的数据」，
 * 这类问题不报错、最难查。这里钉住五件事：
 *
 *   ① 只有成功的应答进了缓存（失败要是被缓存，一次偶发 ERROR 就固化成持续失败）
 *   ② 预热只问「本来就会被缓存」的命令；写命令绝不该出现在批量请求里
 *   ③ 后端返回顺序错乱时，以每条自带的 cmd 为准回填（不许按下标错位写）
 *   ④ 预热失败不 reject、不阻断，但必须留痕（warmStats），不能静默吞掉
 *   ⑤ 预热成功之后，同一轮的 sendCommand 真的不再下发（这是提速的来源）
 *
 * 用法：node tests/warm-cache-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RPC_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/rpc.js');
const NS_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/network_status.js');
const rpcSrc = fs.readFileSync(RPC_JS, 'utf8');
const nsSrc = fs.readFileSync(NS_JS, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

/*
 * 载入 rpc.js。
 * batchResp / failBatch 控制 at_batch 的行为；atCalls 记录单条 at 的下发次数。
 */
function loadRpc(batchResp, failBatch, atResp) {
	const src = rpcSrc
		.replace(/^\s*'require [^']*';\s*$/gm, '')
		.replace(/\n\s*return AtWsClass;\s*$/, '\n');
	const atCalls = [];
	const batchLists = [];
	const ctx = {
		console: { error: function () { }, log: function () { } },
		Promise, Date, JSON, Math, String, Number, RegExp, Object, Array, Error, isNaN, parseInt,
		setTimeout: function (fn) { return setTimeout(fn, 0); },
		clearTimeout,
		L: {
			Class: { extend: (x) => x },
			rpc: {
				declare: function (decl) {
					if (decl.method === 'at_batch') {
						return function (cmds) {
							batchLists.push(cmds || []);
							if (failBatch) { return Promise.reject(new Error('网络错误')); }
							return Promise.resolve(batchResp ? batchResp(cmds) : { success: false });
						};
					}
					return function (command) {
						atCalls.push(command);
						return Promise.resolve(atResp
							? atResp(command)
							: { success: true, data: 'OK' });
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
	return { mod, atCalls, batchLists };
}

function newClient(mod) {
	const c = new mod.ATClient();
	c.connected = true;
	return c;
}

const READS = ['AT+CSQ', 'AT^HCSQ?', 'AT+CEREG?'];   /* 都是 isRetryableRead 认定的只读查询 */
const BARE = 'AT+CGPADDR';   /* 不带 ? 又不在只读名单：前端本就不缓存它 */

/* ---------- ①⑤ 成功应答进缓存，后续不再下发 ---------- */
function scenarioWarmHit() {
	const box = loadRpc(function (cmds) {
		return {
			success: true,
			results: cmds.map(function (c) {
				return { cmd: c, success: true, data: 'VAL:' + c };
			})
		};
	}, false);
	const c = newClient(box.mod);
	return c.warmCache(READS.concat([BARE])).then(function (n) {
		ok('① 预热把成功应答写进缓存（条数与长度一致）',
			n === READS.length, '实际 ' + n + ' / ' + READS.length);
		ok('① 预热准入与 sendCommand 的缓存判定同源（不缓存的命令也不预热）',
			(box.batchLists[0] || []).indexOf(BARE) < 0,
			'批量请求里出现了本不该预热的 ' + BARE);
		const before = box.atCalls.length;
		let chain = Promise.resolve();
		READS.forEach(function (cmd) {
			chain = chain.then(function () { return c.sendCommand(cmd); });
		});
		return chain.then(function () {
			ok('⑤ 预热之后同一轮的查询不再打串口（提速来源）',
				box.atCalls.length === before,
				'仍有 ' + (box.atCalls.length - before) + ' 次下发');
		});
	});
}

/* ---------- ① 失败应答绝不入缓存 ---------- */
function scenarioFailedNotCached() {
	const box = loadRpc(function (cmds) {
		return {
			success: true,
			results: cmds.map(function (c) {
				return { cmd: c, success: false, error: 'ERROR', data: 'STALE' };
			})
		};
		}, false, function () { return { success: false, error: 'ERROR' }; });
	const c = newClient(box.mod);
	const cmd = 'AT^NRSSBID?';
	return c.warmCache([cmd]).then(function (n) {
		ok('① 失败的预热结果一条都没进缓存', n === 0, '竟入了 ' + n + ' 条');
		const before = box.atCalls.length;
		return c.sendCommand(cmd, { attempts: 1 }).then(function (res) {
			ok('① 被预热的命令失败后仍会真的重发（失败没被固化）',
				box.atCalls.length === before + 1,
				'下发 ' + (box.atCalls.length - before) + ' 次');
			ok('① 预热失败后取回的是失败信息而不是被缓存的陈旧值',
				res && res.success === false,
				JSON.stringify(res));
		});
	});
}

/* ---------- ② 写命令不进批量请求 ---------- */
function scenarioNoWriteCommands() {
	const box = loadRpc(function (cmds) {
		return { success: true, results: cmds.map(function (c) { return { cmd: c, success: true }; }) };
	}, false);
	const c = newClient(box.mod);
	return c.warmCache(['AT+CSQ', 'AT+CFUN=1', 'AT^RESET', 'AT^HCSQ?']).then(function () {
		const sent = box.batchLists[0] || [];
		ok('② 批量请求里不含写命令',
			sent.indexOf('AT+CFUN=1') < 0 && sent.indexOf('AT^RESET') < 0,
			'实际下发 ' + JSON.stringify(sent));
		ok('② 只读命令仍在批量请求里',
			sent.indexOf('AT+CSQ') >= 0 && sent.indexOf('AT^HCSQ?') >= 0,
			JSON.stringify(sent));
	});
}

/* ---------- ③ 后端顺序错乱时按下标回填会错位 ---------- */
function scenarioOutOfOrder() {
	/* 故意让返回值顺序颠倒 + 多一条：只有以 cmd 为准才不会写错 key */
	const box = loadRpc(function () {
		return {
			success: true,
			results: [
				{ cmd: 'AT^HCSQ?', success: true, data: 'HCSQ-DATA' },
				{ cmd: 'AT+CSQ', success: true, data: 'CSQ-DATA' }
			]
		};
	}, false);
	const c = newClient(box.mod);
	return c.warmCache(['AT+CSQ', 'AT^HCSQ?']).then(function () {
		let chain = Promise.resolve();
		const got = {};
		['AT+CSQ', 'AT^HCSQ?'].forEach(function (cmd) {
			chain = chain.then(function () {
				return c.sendCommand(cmd).then(function (res) { got[cmd] = res && res.data; });
			});
		});
		return chain.then(function () {
			ok('③ 后端返回乱序时按 cmd 回填，不会把 CSQ 的数据写成 HCSQ',
				got['AT+CSQ'] === 'CSQ-DATA' && got['AT^HCSQ?'] === 'HCSQ-DATA',
				JSON.stringify(got));
		});
	});
}

/* ---------- ④ 预热失败不阻断但必须留痕 ---------- */
function scenarioFailureVisible() {
	const box = loadRpc(null, true);
	const c = newClient(box.mod);
	return c.warmCache(READS).then(function (n) {
		ok('④ 预热失败返回 0 且 promise 不 reject（不阻断任何调用方）',
			n === 0, '实际返回 ' + n);
		const st = c.warmStats();
		ok('④ 预热失败留痕可查（不许静默吞掉）',
			st.failures === 1 && !!st.error,
			JSON.stringify(st));
		const before = box.atCalls.length;
		return c.sendCommand('AT+CSQ', { attempts: 1 }).then(function () {
			ok('④ 预热失败后走原路径，命令照发',
				box.atCalls.length === before + 1,
				'下发 ' + (box.atCalls.length - before) + ' 次');
		});
	});
}

/* ---------- 静态：慢档必须真的用上预热 ---------- */
function slowStartsWithWarm(src) {
	const i = src.indexOf('function refreshSlow(');
	if (i < 0) return false;
	const seg = src.slice(i, i + 3000);
	return /var chain = AtWs\.client\.warmCache\(SLOW_WARM\);/.test(seg);
}

ok('⑤ 网络状态页慢档以预热开头（只实现不用等于白做）',
	slowStartsWithWarm(nsSrc),
	'refreshSlow 的起点不是 warmCache');
ok('⑤ 慢档准备了预热命令清单 SLOW_WARM',
	nsSrc.indexOf('var SLOW_WARM = [') >= 0,
	'没有 SLOW_WARM 清单');
ok('⑤ 反向：把慢档起点改回 Promise.resolve() 会被判红',
	slowStartsWithWarm('function refreshSlow() {\n\t\t\tvar chain = Promise.resolve();') === false,
	'旧写法竟被判为「已预热」');

Promise.resolve()
	.then(scenarioWarmHit)
	.then(scenarioFailedNotCached)
	.then(scenarioNoWriteCommands)
	.then(scenarioOutOfOrder)
	.then(scenarioFailureVisible)
	.catch(function (e) { fails.push('测试自身异常：' + (e && e.message)); })
	.then(function () {
		console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
		if (fails.length) {
			fails.forEach(function (f) { console.log('  ✗ ' + f); });
			process.exit(1);
		}
		process.exit(0);
	});
