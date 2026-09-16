#!/usr/bin/env node
/*
 * 设备控制契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 固定「模组设置 → 设备控制」这一卡里三条命令的约定。依据 2026-09-16 真机只读实测
 * （MT5700M-CN / V200R001C20B025）与 AT 手册第 11 章：
 *
 *   AT^LEDSWITCH?      → ^LEDSWITCH:1          值域 (0-1)       手册 11.12
 *   AT^TDPMCFG?        → ^TDPMCFG: 1,0,0,0     值域 ((0-1) ×4)  手册 11.16
 *   AT^TDPCIELANCFG?   → ^TDPCIELANCFG: 1      值域 (0,1)       手册 11.19
 *
 * 这份测试护住的是两个真实缺陷：
 *
 *   1) 「电源管理」原来下发 `AT^TDPMCFG=1` —— 而命令是 <mode>,<mode>,<mode>,<mode>
 *      四个参数，只有 byte[0] 有定义（pcie），其余是保留位。少发的位行为未定义，
 *      原实现还把它描述成「无业务时进入低功耗」，与手册的「pcie 控制器功耗控制」无关。
 *
 *   2) 「网卡速率」原下拉是 0/1/2/3 = 自动协商/1000Mbps/100Mbps/10Mbps 全双工 —— 那是
 *      **别的模组型号**的定义。手册 11.19 的语义是「选 PCIe 网口所接的 PHY 型号」
 *      （1=RTL8111 1G、2=RTL8125 2.5G），厂家 HiGoROS webui 也正是这么标；而且本机
 *      固件 ^TDPCIELANCFG=? 实报值域只有 (0,1)，原来那两个 2/3 发下去会被模组拒。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'modem_settings.js');
const PARSE = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'parse.js');

const msSrc = fs.readFileSync(MS, 'utf8');
const pSrc = fs.readFileSync(PARSE, 'utf8');

const Parse = eval('(' + pSrc.match(/var Parse = \((function[\s\S]*?)\)\(\);/)[1] + ')')();

let pass = 0;
const fails = [];

function ok(cond, name) {
	if (cond) { pass++; return; }
	fails.push(name);
}
function eq(actual, expected, name) {
	ok(JSON.stringify(actual) === JSON.stringify(expected),
		name + '（实际 ' + JSON.stringify(actual) + '）');
}
function has(needle, name) { ok(msSrc.indexOf(needle) >= 0, name); }
function hasNot(needle, name) { ok(msSrc.indexOf(needle) < 0, name); }

/* ---------------- 真机原文（2026-09-16 只读抓取） ---------------- */

const REAL_NIC_RANGE = '^TDPCIELANCFG: (0,1)\r\nOK';
const REAL_NIC_VALUE = '^TDPCIELANCFG: 1\r\nOK';
const REAL_DPM = '^TDPMCFG: 1,0,0,0\r\nOK';
const REAL_LED = '^LEDSWITCH:1\r\nOK';
const MANUAL_NIC_RANGE = '^TDPCIELANCFG: (1,2)\r\nOK';

/* ---------------- 1. 网卡 PHY 值域必须按 =? 实报解析 ---------------- */

eq(Parse.parseNicRange(REAL_NIC_RANGE), ['0', '1'], '真机 =? 原文 (0,1) 解出值域');
eq(Parse.parseNicRange(MANUAL_NIC_RANGE), ['1', '2'], '手册举例 (1,2) 解出值域');
eq(Parse.parseNicRange('^TDPCIELANCFG: (0-1)'), ['0', '1'], '范围式 (0-1) 展开（同固件的 TDPMCFG 用范围式）');
eq(Parse.parseNicRange('^TDPCIELANCFG: (0, 1)'), ['0', '1'], '带空格的枚举');
eq(Parse.parseNicRange('^TDPCIELANCFG: (0,0,1)'), ['0', '1'], '重复取值去重');
eq(Parse.parseNicRange('^TDPCIELANCFG: (list of supported <n>s)'), null,
	'文档占位符 → null（调用方据此禁用下拉）');
eq(Parse.parseNicRange('^TDPCIELANCFG: (0-100)'), null, '跨度过大不展开 → null');
eq(Parse.parseNicRange('ERROR'), null, 'ERROR → null');
eq(Parse.parseNicRange(''), null, '空串 → null');
eq(Parse.parseNicRange(null), null, 'null → null');

/* ---------------- 2. PCIe 控制器：必须按 4 参数下发 ---------------- */

const DPM_RE = /\^TDPMCFG:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/;
const dpm = REAL_DPM.match(DPM_RE);
ok(dpm !== null && dpm.slice(1).join(',') === '1,0,0,0',
	'真机 ^TDPMCFG: 1,0,0,0 解出 4 个参数（byte[0]=pcie）');

has("pcieReserved.join(',')", '下发命令按 4 参数拼接（保留位原样回写）');
hasNot("AT^TDPMCFG=' + (checked ? '1' : '0')", '不再出现只发 1 个参数的老写法');
has('pcieReserved = [m[2], m[3], m[4]]', '读回时记下保留位，供下次下发回写');

/* ---------------- 3. 文案：不许再用别的模组型号的定义 ---------------- */

hasNot('1000Mbps 全双工', '「1000Mbps 全双工」文案已移除（那是别的模组型号的定义）');
hasNot('100Mbps 全双工', '「100Mbps 全双工」文案已移除');
hasNot('10Mbps 全双工', '「10Mbps 全双工」文案已移除');
hasNot('开启后模组在无业务时进入低功耗', '「电源管理」的错误描述已移除');
has('RTL8111', '网卡 PHY 选项出现 RTL8111（手册 11.19）');
has('RTL8125', '网卡 PHY 选项出现 RTL8125（手册 11.19）');
has('PCIe 控制器', '「电源管理」已按手册正名为「PCIe 控制器」');

const labelSrc = msSrc.match(/var NIC_LABEL = \{[^}]*\};/);
ok(labelSrc !== null, '找到 NIC_LABEL 映射表');
const NIC_LABEL = labelSrc ? new Function(labelSrc[0] + ' return NIC_LABEL;')() : {};
ok(/RTL8111/.test(NIC_LABEL['1'] || ''), 'NIC_LABEL[1] 标注为 RTL8111');
ok(/RTL8125/.test(NIC_LABEL['2'] || ''), 'NIC_LABEL[2] 标注为 RTL8125');

/* ---------------- 4. 交互：三项都走暂存，不逐项立即写模组 ---------------- */

const stagedCount = (msSrc.match(/ctrlStaged\.set\(/g) || []).length;
ok(stagedCount >= 3, '三项设置都走暂存（ctrlStaged.set 出现 ' + stagedCount + ' 次）');
has("Mt5700.staged({ onChanged: function () { fetchDeviceControl(); } })",
	'暂存条应用/撤销后回读模组实际值');
hasNot('handleSetNic', '旧的「改下拉即写模组 + 弹重启」处理函数已移除');
has('Parse.parseNicRange', '值域来源是 Parse.parseNicRange（真机实报驱动，不写死）');
ok((msSrc.match(/if \(!res\.success\) throw new Error/g) || []).length >= 3,
	'暂存项的 run 失败时 reject（否则界面会报「已应用」而模组其实没改）');

/* ---------------- 5. 读回正则要吃得下真机原文 ---------------- */

ok(/\^LEDSWITCH:\s*(\d+)/.exec(REAL_LED)[1] === '1',
	'^LEDSWITCH:1（冒号后无空格）能读出值');
ok(/\^TDPCIELANCFG:\s*(\d+)/.exec(REAL_NIC_VALUE)[1] === '1',
	'^TDPCIELANCFG: 1 能读出值');
has('\\^LEDSWITCH:\\s*(\\d+)', 'LED 读回正则用 \\s* 兼容无空格形态');

/* ---------------- 汇总 ---------------- */

if (fails.length) {
	console.log('设备控制契约：通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
	fails.forEach(function (f) { console.log('  FAIL  ' + f); });
	process.exit(1);
}
console.log('设备控制契约：通过 ' + pass + ' 项，失败 0 项');
