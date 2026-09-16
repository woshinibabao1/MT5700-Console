#!/usr/bin/env node
'use strict';

/**
 * 看门狗 nc 调用契约测试（守 P12：watchdog.sh 的 nc 不能用 -w）
 *
 * 背景（真机实测，见 CHANGELOG 与 tests/ui-contract.test.js 6b 节）：
 *   本固件的 busybox nc 是精简版（v1.38），**不认 -w 选项** —— 传 `nc -w 5`
 *   只会打印 usage 并以 rc=1 立刻退出。于是 rpc_send() 每次都拿不到应答，
 *   「连续失败达阈值 → 下发复位命令」这条链路**从未真正执行过**，
 *   而界面上完全看不出来（连接恢复失败与模组无响应长得一样）。
 *
 *   同一条规则在 rpcd ucode 侧早有守卫（ui-contract.test.js），
 *   但 watchdog.sh 漏在守卫之外 —— 本文件就是补上这个口子，防它再回来。
 *
 * 只读：不连设备、不发 AT、不改任何文件。
 * 用法：node tests/watchdog-nc-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WD = path.join(ROOT, 'root', 'usr', 'share', 'mt5700', 'watchdog.sh');

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

const src = fs.readFileSync(WD, 'utf8');

/* ---------- A. 硬规则：不得出现 -w ---------- */

ok('★ watchdog 的 nc 不带 -w（本固件 busybox nc 不认，传了必失败）',
	!/nc\s+-w\b|nc[^'\n]*\s-w\s+\d/.test(src),
	(src.match(/nc[^'\n]*-w[^\n]*/) || [''])[0].trim().slice(0, 90));

/* ---------- B. 必须有超时，否则无 -w 时会永久阻塞 ---------- */

const rpcSend = (src.match(/rpc_send\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
ok('能定位 rpc_send()', rpcSend.length > 0);
ok('rpc_send 用 timeout 包裹 nc（没有 -w 兜底时这是唯一限时手段）',
	/timeout\s+\d+\s+nc\b/.test(rpcSend));
ok('nc 不存在时明确 return 1，不静默降级成「看起来成功」',
	/command\s+-v\s+nc[^|]*\|\|\s*return\s+1/.test(rpcSend));

/* ---------- C. 复位链路仍在（别修掉 -w 时把功能也删了） ---------- */

ok('仍保留复位命令下发入口（watch_reset_cmds）', /watch_reset_cmds/.test(src));
ok('复位命令经 rpc_send 下发，而不是各写一套 nc',
	(rpcSend.length > 0) && (src.split('rpc_send').length - 1) >= 2);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('看门狗 nc 契约测试全部通过');
