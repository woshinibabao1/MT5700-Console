#!/usr/bin/env node
'use strict';

/**
 * 「通道忙 → 快速失败」契约（2026-09-26，治用户报的「AT 命令卡住，新加载一个页面加载不出来」）
 * ----------------------------------------------------------------------------
 * 病因（源码 + 真机双重取证）：
 *
 * 后端有三条**通道忙**类应答，它们的共同点是「重试毫无意义，只会排到更长的队尾」：
 *   · `等待空闲通道超时（8s）：模组正忙或正在重连，请稍后重试`   ← atclient.rs:575
 *   · `模组正在发送短信，请稍候再试`                          ← rpcserver.rs:433
 *   · `正在扫频，模组暂时无法响应其它命令，请先取消扫频`         ← rpcserver.rs:442
 * 后端**自己**早就为这类情况定了正确范式（rpcserver.rs:430-443）：忙时**立即失败返回**，
 * 注释原话「否则每个查询都要等满排队预算，一页十几个查询叠加起来就是『界面加载不出来』」。
 *
 * 但前端 `rpc.js` **一条都不认识**（全文件 grep 无这三句）→ 走普通失败路径 →
 * `isRetryableRead()` 对 `?` 结尾的查询返回 true → **重试 3 次**，而每次重试都要
 * 重新 `cmd_mu.lock()` 排队 8s → 单条命令最坏烧掉 20s（预算上限），
 * 而 `commandQueue` 是**全局单链**，这段时间本页其它命令、其它页面全部排队等待 →
 * 用户看到的就是「加载出一片空白 / 页面加载不出来」。
 *
 * 修法（本测试钉住的五件事）：
 *   ① 忙态失败**不重试**（重试＝把自己排到更长的队尾）
 *   ② 忙态之后开一个短窗口（与后端 QUEUE_WAIT 同量级），窗口内**只读命令直接快速失败**，
 *      不再逐条去撞 8 秒的墙 —— 这正是「一页十几个查询叠加」的解药
 *   ③ 窗口内**写命令照常下发**（读不到 ≠ 不许保存；不能让熔断把用户的操作也拦掉）
 *   ④ 窗口过期自动半开放行（不需要额外状态）；探针成功即解除
 *   ⑤ 普通失败（真 ERROR）照旧重试 3 次 —— 不许把偶发容错一起削弱
 *
 * 用法：node tests/busy-fastfail-contract.test.js
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

/* ---------- 可控制的时钟（熔断窗口要能被测试推进） ---------- */
const RealDate = Date;
let fakeNow = 1700000000000;

function makeDate() {
	const D = function () {
		return arguments.length ? new RealDate(Array.prototype.slice.call(arguments)) : new RealDate(fakeNow);
	};
	D.now = function () { return fakeNow; };
	D.parse = RealDate.parse;
	D.UTC = RealDate.UTC;
	D.prototype = RealDate.prototype;
	return D;
}

function loadRpc(handler) {
	const src = rpcSrc
		.replace(/^\s*'require [^']*';\s*$/gm, '')
		.replace(/\n\s*return AtWsClass;\s*$/, '\n');
	const calls = [];
	const ctx = {
		console: { error: function () { }, log: function () { }, warn: function () { } },
		Promise, JSON, Math, String, Number, RegExp, Object, Array, Error, isNaN, parseInt,
		Date: makeDate(),
		setTimeout: function (fn) { return setTimeout(fn, 0); },
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
		'\nreturn { ATClient: ATClient, isRetryableRead: isRetryableRead,'
		+ ' isBusyError: (typeof isBusyError === "function" ? isBusyError : null),'
		+ ' BUSY_COOLDOWN_MS: (typeof BUSY_COOLDOWN_MS === "number" ? BUSY_COOLDOWN_MS : null) };\n})()',
		ctx
	);
	return { mod, calls, advance: function (ms) { fakeNow += ms; } };
}

const BUSY_QUEUE = '等待空闲通道超时（8s）：模组正忙或正在重连，请稍后重试';
const BUSY_SMS = '模组正在发送短信，请稍候再试';
const BUSY_SCAN = '正在扫频，模组暂时无法响应其它命令，请先取消扫频';

const respBusy = () => ({ success: false, error: BUSY_QUEUE });
const respPlainErr = () => ({ success: false, error: 'ERROR' });
const okResp = () => ({ success: true, data: 'OK' });

function newClient(mod) {
	const c = new mod.ATClient();
	c.connected = true;
	return c;
}

/* ---------- 场景 ---------- */

/* ① 忙态不重试；② 忙态后的只读命令快速失败（不发请求） */
function scenarioFastFail() {
	const box = loadRpc(respBusy);
	const c = newClient(box.mod);
	return c.sendCommand('AT+CSQ?').then(function (r1) {
		const afterFirst = box.calls.length;
		return c.sendCommand('AT+CEREG?').then(function (r2) {
			return {
				firstCalls: afterFirst,
				secondCalls: box.calls.length - afterFirst,
				r1: r1, r2: r2
			};
		});
	});
}

/* ③ 忙态窗口内，写命令必须照常下发 */
function scenarioWriteNotBlocked() {
	const box = loadRpc(respBusy);
	const c = newClient(box.mod);
	return c.sendCommand('AT+CSQ?').then(function () {
		const before = box.calls.length;
		return c.sendCommand('AT+CMGF=0').then(function (r) {
			return { sent: box.calls.length - before, res: r };
		});
	});
}

/* ④ 窗口过期后半开放行；⑤ 探针失败重新武装、探针成功即解除
 *
 * ★ 首版这里少了一步：半开探针**失败**时要重新武装熔断（这是对的），
 *   而我设完 mode='ok' 没推进时钟就断言「已恢复」——那是**测试自己的漏洞**，
 *   会把正确实现判成错的。现在按真实时序走，并额外验证
 *   「成功之后**不需要**再等窗口」。
 */
function scenarioRecovery() {
	let mode = 'busy';
	const box = loadRpc(function () { return mode === 'busy' ? respBusy() : okResp(); });
	const c = newClient(box.mod);
	const seq = [];
	return c.sendCommand('AT+CSQ?').then(function () {
		seq.push(box.calls.length);                  /* 1: 首发失败 → 武装 */
		return c.sendCommand('AT+CEREG?').then(function () {
			seq.push(box.calls.length);              /* 2: 窗口内 → 不应新增 */
			box.advance(60000);
			return c.sendCommand('AT+CREG?').then(function () {
				seq.push(box.calls.length);          /* 3: 过期 → 放行探针（仍 busy → 重新武装） */
				return c.sendCommand('AT+COPS?').then(function () {
					seq.push(box.calls.length);      /* 4: 探针失败后 → 不应新增 */
					mode = 'ok';
					box.advance(60000);
					return c.sendCommand('AT+CIMI').then(function () {
						seq.push(box.calls.length);  /* 5: 越过新窗口 → 放行探针（成功 → 解除） */
						return c.sendCommand('AT+CGSN').then(function (r) {
							seq.push(box.calls.length);  /* 6: 成功后**不再等窗口** → 应放行 */
							return { seq: seq, lastOk: !!(r && r.success) };
						});
					});
				});
			});
		});
	});
}

/* ⑤ 普通失败照旧重试 3 次（回归保护：别把偶发容错一起削了） */
function scenarioPlainErrorStillRetries() {
	const box = loadRpc(respPlainErr);
	const c = newClient(box.mod);
	return c.sendCommand('AT^NRSSBID?').then(function () {
		return box.calls.length;
	});
}

/* ⑥ 同一 tick 并发排队的命令，也要在**出队时**快速失败
 *
 * ★ 这一条是浏览器 A/B 实测逼出来的：只做「入队时」检查时，
 *   忙态下 12 秒窗口里仍下发了 12 次 —— 因为真实页面用 Promise.all
 *   把一整轮命令同一 tick 排进队列，它们全部通过了入队检查。
 */
function scenarioQueuedSameTick() {
	const box = loadRpc(respBusy);
	const c = newClient(box.mod);
	return Promise.all([
		c.sendCommand('AT+CSQ?'), c.sendCommand('AT+CEREG?'), c.sendCommand('AT+CREG?'),
		c.sendCommand('AT+COPS?'), c.sendCommand('AT+CGACT?'), c.sendCommand('AT+CGDCONT?')
	]).then(function () { return box.calls.length; });
}

/* 忙态文案识别（含单一真源：后端真实字面量必须被覆盖） */
function scenarioBusyRecognised() {
	const box = loadRpc(okResp);
	const f = box.mod.isBusyError;
	if (typeof f !== 'function') return { hasFn: false };
	return {
		hasFn: true,
		q: !!f(BUSY_QUEUE), sms: !!f(BUSY_SMS), scan: !!f(BUSY_SCAN),
		plain: !!f('ERROR'), empty: !!f(''), nul: !!f(null),
		cooldown: box.mod.BUSY_COOLDOWN_MS
	};
}

/* ---------- 单一真源：前端识别的文案必须覆盖后端字面量 ---------- */
const UCODE = fs.readFileSync(
	path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc'), 'utf8');

function backendBusyLiterals() {
	const at = fs.readFileSync(path.join(ROOT, 'src/rust/src/atclient.rs'), 'utf8');
	const rs = fs.readFileSync(path.join(ROOT, 'src/rust/src/rpcserver.rs'), 'utf8');
	const found = [];
	/* 后端用 format!/&str 拼，取「文案前缀」作为指纹 */
	['等待空闲通道超时', '模组正在发送短信', '正在扫频，模组暂时无法响应其它命令'].forEach(function (k) {
		if (at.indexOf(k) >= 0 || rs.indexOf(k) >= 0) found.push(k);
	});
	return found;
}

/*
 * ucode 侧：at_batch 撞到忙必须**提前收尾**。
 * 这是「全局反省」的产物 —— 同一个放大器在 batch 里更狠：
 * N 条 × 8 秒全在**一次** ucode 调用里跑，而 rpcd 单线程 → 整个 LuCI 冻结。
 */
function ucodeEarlyBreak(src) {
	/* 收尾分支必须在调用 atCallCached 之前出现，否则挡不住 */
	const iSkip = src.indexOf('busyReason != null');
	const iCall = src.indexOf('let r = atCallCached(cmd);');
	const hasSkipFlag = /skipped\+\+;/.test(src);
	const hasBusyFlag = /busy:\s*true/.test(src);
	return iSkip > 0 && iCall > iSkip && hasSkipFlag && hasBusyFlag;
}

function ucodeBusyPrefixes(src) {
	const m = src.match(/const BUSY_PREFIXES = \[([\s\S]*?)\];/);
	if (!m) return [];
	return (m[1].match(/'([^']+)'/g) || []).map(function (x) { return x.slice(1, -1); });
}

/* ---------- 跑 ---------- */

const results = {};
scenarioFastFail()
	.then(function (r) {
		results.fastfail = r;
		return scenarioWriteNotBlocked();
	})
	.then(function (r) {
		results.write = r;
		return scenarioRecovery();
	})
	.then(function (r) {
		results.recover = r;
		return scenarioPlainErrorStillRetries();
	})
	.then(function (n) {
		results.plain = n;
		return scenarioQueuedSameTick();
	})
	.then(function (n) {
		results.sameTick = n;
		results.busy = scenarioBusyRecognised();
	})
	.catch(function (e) {
		fails.push('测试自身异常：' + (e && e.message));
	})
	.then(function () {
		const f = results.fastfail || {};
		ok('① 忙态失败只下发一次，不重试（重试＝排到更长的队尾）',
			f.firstCalls === 1, '实际下发 ' + f.firstCalls + ' 次');
		ok('① 忙态结论原样返回（错误文案里已经写了「请稍后重试」，不该被吞掉）',
			!!(f.r1 && f.r1.success === false && /忙/.test(String(f.r1.error))),
			JSON.stringify(f.r1));
		ok('② 忙态窗口内第二条只读命令**不发请求**（快速失败，这正是「一页十几条叠死」的解药）',
			f.secondCalls === 0, '窗口内又发了 ' + f.secondCalls + ' 次');

		const w = results.write || {};
		ok('③ 忙态窗口内**写命令照常下发**（读不到 ≠ 不许保存）',
			w.sent === 1, '写命令下发 ' + w.sent + ' 次');

		const rc = results.recover || {};
		const sq = rc.seq || [];
		ok('④ 窗口内不发请求（熔断生效）', sq[1] === 1,
			'窗口内累计 ' + sq[1] + ' 次（应为 1）');
		ok('④ 窗口过期后半开放行一条探针', sq[2] === 2,
			'过期后累计 ' + sq[2] + ' 次（应为 2）');
		ok('④ 探针仍失败 → 重新武装熔断（不能无限探）', sq[3] === 2,
			'探针失败后又发 ' + (sq[3] - sq[2]) + ' 次（应为 0）');
		ok('⑤ 越过新窗口后再次放行探针', sq[4] === 3,
			'累计 ' + sq[4] + ' 次（应为 3）');
		ok('⑤ ★ 探针成功后**立即**解除熔断（不需要再等一个窗口）', sq[5] === 4,
			'成功后累计 ' + sq[5] + ' 次（应为 4）');
		ok('⑤ 解除后命令正常返回成功', rc.lastOk === true);

		ok('⑤ 普通 ERROR 仍重试 3 次（不许把偶发容错一起削弱）',
			results.plain === 3, '实际 ' + results.plain + ' 次');

		ok('⑥ ★ 同一 tick 并发排队的 6 条命令只下发 1 次（出队时也要查熔断）',
			results.sameTick === 1,
			'实际下发 ' + results.sameTick + ' 次 —— 若为 6，说明只在入队时查了熔断，'
			+ '真实页面的 Promise.all 会整轮撞满 8 秒');

		const b = results.busy || {};
		ok('忙态文案识别函数存在', b.hasFn === true);
		ok('识别「等待空闲通道超时」', b.q === true);
		ok('识别「模组正在发送短信」', b.sms === true);
		ok('识别「正在扫频」', b.scan === true);
		ok('普通 ERROR 不被误判成忙态', b.plain === false);
		ok('空串 / null 不炸也不误判', b.empty === false && b.nul === false);
		ok('熔断窗口与后端排队预算同量级（4~20 秒之间）',
			typeof b.cooldown === 'number' && b.cooldown >= 4000 && b.cooldown <= 20000,
			'当前 ' + b.cooldown);

		/* ★ 单一真源：前端必须覆盖后端真实存在的每一条忙态文案 */
		const lits = backendBusyLiterals();
		ok('★ 单一真源：后端确实存在这三条忙态文案（否则本测试在测空气）',
			lits.length === 3, '找到 ' + JSON.stringify(lits));
		lits.forEach(function (k) {
			const sample = k === '等待空闲通道超时' ? BUSY_QUEUE
				: (k === '模组正在发送短信' ? BUSY_SMS : BUSY_SCAN);
			ok('★ 单一真源：后端文案「' + k + '」被前端识别',
				b.hasFn === true && b[k === '等待空闲通道超时' ? 'q' : (k === '模组正在发送短信' ? 'sms' : 'scan')] === true,
				sample);
		});

		/* ---------- ucode 侧：同一个放大器在 batch 里更狠 ---------- */
		const up = ucodeBusyPrefixes(UCODE);
		ok('★ ucode 侧也定义了忙态前缀表（BUSY_PREFIXES）', up.length === 3,
			JSON.stringify(up));
		lits.forEach(function (k) {
			ok('★ 单一真源：ucode 前缀表覆盖后端文案「' + k + '」',
				up.indexOf(k) >= 0, JSON.stringify(up));
		});
		ok('★ ucode：at_batch 撞到忙会提前收尾（收尾分支必须挡在 atCallCached 之前）',
			ucodeEarlyBreak(UCODE),
			'若只把判断放在调用之后，N×8 秒一样会跑完，等于没改');
		ok('★ 反向：删掉提前收尾分支后，本检查必须报红',
			ucodeEarlyBreak(UCODE) === true &&
			ucodeEarlyBreak(UCODE.replace(/busyReason != null/g, 'false')) === false);

		/* ---------- 前端：忙态时不要发批次 ---------- */
		ok('★ 前端 warmCache 在忙态窗口内不发批次（直接返回 0，卡片走 sendCommand 快速失败）',
			/if \(Date\.now\(\) < this\._busyUntil\) \{[\s\S]{0,400}?return Promise\.resolve\(0\);/.test(rpcSrc),
			'否则一轮 batch 仍会进 rpcd，后端逐条撞满 8 秒');
		ok('★ 前端 warmCache 接住后端的 busy 标记并开熔断',
			/resp\.busy === true[\s\S]{0,220}?self\._noteBusy\(/.test(rpcSrc));

		console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
		if (fails.length) {
			fails.forEach(function (x) { console.log('  ✗ ' + x); });
			process.exit(1);
		}
		process.exit(0);
	});
