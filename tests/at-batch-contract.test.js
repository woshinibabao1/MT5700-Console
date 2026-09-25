#!/usr/bin/env node
'use strict';

/**
 * 后端批量只读接口 at_batch 契约（P20 性能专项）
 * ----------------------------------------------------------------------------
 * at_batch 一次请求能下发几十条命令，所以它必须是「最保守的那个接口」——
 * 后端放行一条写命令的代价不是多打一次串口，而是整个设备失控。这里钉四件事：
 *
 *   ① 入口形态：args 声明为数组（不是字符串，避免拼接类的注入面）
 *   ② **先校验后下发**：每条必须过 batchReadable 才允许进 atCallCached，
 *      且 batchReadable 的兜底必须是拒绝（不许留 `return true` 后门）
 *   ③ 有上限：条数与单条长度都卡住（拒绝无限 batch 把串口占死）
 *   ④ 逐条可核对：结果自带 cmd，前端能据此发现错位；ACL 两段都登记了这个方法
 *
 * 每条断言都有反向验证：把缺陷实现喂给同一个检查函数，必须判红 ——
 * 否则「检查通过了」只是因为检查本身没在工作。
 *
 * 用法：node tests/at-batch-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UC = path.join(ROOT, 'root/usr/share/rpcd/ucode/mt5700.uc');
const ACL = path.join(ROOT, 'root/usr/share/rpcd/acl.d/luci-app-mt5700.json');

const uc = fs.readFileSync(UC, 'utf8');
const aclRaw = fs.readFileSync(ACL, 'utf8');
let acl = null;
try { acl = JSON.parse(aclRaw); } catch (e) { /* 下面会判红 */ }

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
	if (cond) pass++;
	else fails.push(name + (detail ? ' —— ' + detail : ''));
}

/* ---------- 检查函数（正面 / 反向共用） ---------- */

function argsBlock(src) {
	const i = src.indexOf('at_batch: {');
	if (i < 0) return null;
	return src.slice(i, i + 3000);
}

/* ① 数组入口 */
function isArrayArg(src) {
	const b = argsBlock(src);
	return !!b && /args:\s*\{\s*cmds:\s*\[\s*\]\s*\}/.test(b);
}

/* ② 先校验后下发：batchReadable 的出现必须早于 atCallCached */
function guardBeforeDispatch(src) {
	const b = argsBlock(src);
	if (!b) return false;
	const g = b.indexOf('batchReadable(');
	const d = b.indexOf('atCallCached(');
	return g >= 0 && d >= 0 && g < d;
}

/* ② batchReadable 的兜底必须是拒绝 */
function denialsByDefault(src) {
	const i = src.indexOf('function batchReadable(');
	if (i < 0) return false;
	const j = src.indexOf('\n}', i);
	if (j < 0) return false;
	const body = src.slice(i, j).trim();
	return /return false;\s*$/.test(body);
}

/* ② 白名单复用既有名单，不在第二处再抄一份 */
function reusesExistingLists(src) {
	const i = src.indexOf('function batchReadable(');
	if (i < 0) return false;
	const j = src.indexOf('\n}', i);
	if (j < 0) return false;
	const body = src.slice(i, j);
	return body.indexOf('STATIC_READS') >= 0 && body.indexOf('BARE_READS') >= 0;
}

/* ③ 两条上限都在 */
function hasBothCaps(src) {
	const b = argsBlock(src);
	return !!b && b.indexOf('AT_BATCH_MAX') >= 0 && b.indexOf('AT_BATCH_CMD_MAX') >= 0;
}

/* ④ 每条结果带 cmd */
function resultsCarryCmd(src) {
	const b = argsBlock(src);
	return !!b && /cmd:\s*cmd/.test(b);
}

/* ---------- 正面断言 ---------- */

ok('① at_batch 已存在于 ubus 方法表', uc.indexOf('at_batch: {') >= 0,
	'没有找到 at_batch 方法');
ok('① 入口形态是数组（args: { cmds: [] }）', isArrayArg(uc),
	'cmds 不是数组声明 —— 字符串拼接类参数是注入面');
ok('② 先做只读校验、再下发（batchReadable 早于 atCallCached）', guardBeforeDispatch(uc),
	'存在绕过 batchReadable 直接 atCallCached 的路径');
ok('② batchReadable 的兜底是拒绝（不许留后门）', denialsByDefault(uc),
	'函数末尾不是 return false —— 认不出的形态会被放行');
ok('② 白名单复用 STATIC_READS / BARE_READS（不在第二处另抄一份）',
	reusesExistingLists(uc), 'batchReadable 没有引用既有名单');
ok('③ 条数与单条长度都有上限', hasBothCaps(uc), '缺少 AT_BATCH_MAX 或 AT_BATCH_CMD_MAX');
ok('④ 每条结果自带 cmd（前端可据此核对顺序）', resultsCarryCmd(uc), '结果里没有 cmd 字段');

/*
 * 方法表的定位必须用 lastIndexOf：文件里还有别的 `return {`（例如 at_batch 自己的
 * 返回），取第一个的话它落在 batchReadable 之后，判据就变成永真。
 */
const TABLE = uc.lastIndexOf('\nreturn {');

/* 顺序：batchReadable / 上限常量必须定义在方法表之前（ucode 不做提升） */
ok('② batchReadable 定义在方法表之前（ucode 不提升函数）',
	TABLE > 0 && uc.indexOf('function batchReadable(') >= 0 &&
	uc.indexOf('function batchReadable(') < TABLE,
	'batchReadable 未定义或定义在方法表之后');
ok('③ 上限常量定义在方法表之前',
	TABLE > 0 && uc.indexOf('const AT_BATCH_MAX') >= 0 &&
	uc.indexOf('const AT_BATCH_MAX') < TABLE,
	'AT_BATCH_MAX 未定义或定义在方法表之后');

/* ACL 两段都要登记 */
function aclHas(obj) {
	if (!obj) return false;
	const m = obj['luci-app-mt5700'] || {};
	const read = ((m.read || {}).ubus || {}).mt5700 || [];
	const write = ((m.write || {}).ubus || {}).mt5700 || [];
	return read.indexOf('at_batch') >= 0 && write.indexOf('at_batch') >= 0;
}
ok('④ ACL 的 read 与 write 两段都登记了 at_batch', aclHas(acl),
	'缺 ACL 登记 —— 页面会落到「没有权限」的兜底，且看不出是权限问题');

/* ---------- 反向验证：缺陷实现必须被同一批检查判红 ---------- */

const noGuard = uc.replace('at_batch: {', 'at_batch: { /* 缺陷样例 */');
const badNoGuard = [
	'at_batch: {',
	'\t\t\targs: { cmds: [] },',
	'\t\t\tcall: function (req) {',
	'\t\t\t\treturn { success: true, results: [] };',
	'\t\t\t}',
	'\t\t},'
].join('\n');
ok('② 反向：没有 batchReadable 校验的实现会被判"未先校验就下发"',
	guardBeforeDispatch(badNoGuard) === false,
	'缺陷实现竟被判为已校验');
ok('② 反向：把 batchReadable 兜底改成放行会被判红',
	denialsByDefault('\nfunction batchReadable(cmd) {\n\treturn true;\n}\n') === false,
	'`return true` 兜底竟被判为拒绝兜底');
ok('① 反向：args 写成字符串会被判红',
	isArrayArg('at_batch: {\n\targs: { cmds: \'\' },\n}') === false,
	'字符串 args 竟被判为数组入口');
ok('② 反向：先下发后校验的顺序会被判红',
	guardBeforeDispatch('at_batch: {\n\tatCallCached(cmd);\n\tbatchReadable(cmd);\n}') === false,
	'顺序颠倒竟被判为已先校验');
ok('④ 反向：结果不带 cmd 会被判红',
	resultsCarryCmd('at_batch: {\n\tresults[i] = { success: true, data: d };\n}') === false,
	'无 cmd 的结果竟被判为可核对');
void noGuard;

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	fails.forEach(function (f) { console.log('  ✗ ' + f); });
	process.exit(1);
}
process.exit(0);
