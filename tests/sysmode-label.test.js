#!/usr/bin/env node
/*
 * 网络制式文案 / 连接状态标题 契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景（2026-09-17 真机 + 手册双查证）：
 *   AT^SYSINFOEX 的 <sysmode> 合法值只有 0/1/3/5/6/11（11 = NR-5GC），
 *   AT^MONSC / AT^HCSQ 只返回裸 "NR" —— 模组**没有任何 5G-Advanced 字段**。
 *   所以「5GA-NR」只能是启发式：NR + 聚合载波数 ≥ 2（用户拍板的规则）。
 *
 * 这里把 systemModeLabel 抽出来真跑一遍，而不是用正则匹配源码 ——
 * 判定逻辑的自相矛盾只有跑起来才看得见（先例：diagnostics 的「一般」配「全部正常」）。
 *
 * 运行：node tests/sysmode-label.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const JS = path.join(__dirname, '..', 'htdocs', 'luci-static', 'resources',
	'view', 'at-webserver', 'network_status.js');
const src = fs.readFileSync(JS, 'utf8');

const log = [];
function say(s) { log.push(s); }

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; say('  ✓ ' + label); return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
	say('  ✗ ' + label + (extra ? '  → ' + extra : ''));
}

function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（是否改过名？请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

const labelFactory = new Function(
	extractFn(src, 'hasPsService') + '\n' +
	extractFn(src, 'systemModeLabel') + '\nreturn systemModeLabel;');
const label = labelFactory();
const hasPs = new Function(
	extractFn(src, 'regRank') + '\n' +
	extractFn(src, 'hasPsService') + '\nreturn hasPsService;')();
const hasAny = new Function(
	extractFn(src, 'regRank') + '\n' +
	extractFn(src, 'normStat') + '\n' +
	extractFn(src, 'hasPsService') + '\n' +
	extractFn(src, 'hasAnyPsService') + '\nreturn hasAnyPsService;')();
const norm = new Function(
	extractFn(src, 'normStat') + '\nreturn normStat;')();

say('=== 制式文案（后缀必须跟随真实 sysMode） ===');

/* 用户拍板的规则：NR + 载波 ≥ 2 → 5GA-NR */
ok('NR + 2 载波 → 5GA-NR', label('NR', 2) === '5GA-NR', label('NR', 2));
ok('NR + 3 载波 → 5GA-NR', label('NR', 3) === '5GA-NR', label('NR', 3));
ok('NR + 1 载波 → 5G-NR', label('NR', 1) === '5G-NR', label('NR', 1));
ok('NR + 0 载波 → 5G-NR（无聚合不该报 5GA）', label('NR', 0) === '5G-NR', label('NR', 0));
ok('NR-5GC 也算 NR（^SYSINFOEX 的字符串形态）',
	label('NR-5GC', 2) === '5GA-NR', label('NR-5GC', 2));
ok('小写 nr 也能识别', label('nr', 2) === '5GA-NR', label('nr', 2));

/* 后缀跟随数据：绝不能把 LTE 标成 NR */
ok('LTE → 4G-LTE（载波再多也不变 5G）', label('LTE', 3) === '4G-LTE', label('LTE', 3));
ok('WCDMA → 3G-WCDMA', label('WCDMA', 2) === '3G-WCDMA', label('WCDMA', 2));
ok('GSM → 2G-GSM', label('GSM', 2) === '2G-GSM', label('GSM', 2));

/* 兜底：不认识的制式原样返回裸值，不编造代际 */
ok('未知制式原样返回（不编代际）', label('FOOBAR', 2) === 'FOOBAR', label('FOOBAR', 2));
ok('空值 → —', label('', 0) === '—', JSON.stringify(label('', 0)));
ok('null → —', label(null, 2) === '—', JSON.stringify(label(null, 2)));

/*
 * ★ 2026-09-20 真机 bug：卡上没有 Profile 时 AT+CEREG 报「未注册，正在搜索」，
 *   但 ^SYSINFOEX 的 <sysmode> 仍残留着上一次的 NR —— 页面于是显示「5G-NR」，
 *   看着像驻留在 5G 上，其实一格信号都没有。制式必须跟着「是否真驻留」走。
 */
say('');
say('=== 未注册时不得显示残留制式 ===');

ok('★ 未注册 → —（不显示模组残留的 NR）',
	label('NR', 2, false) === '—', label('NR', 2, false));
ok('★ 未注册时 LTE 也要抹掉', label('LTE', 1, false) === '—', label('LTE', 1, false));
ok('已注册 → 照常出制式', label('NR', 2, true) === '5GA-NR', label('NR', 2, true));
/* 第三参缺省（老调用方）不能误伤成「未注册」 */
ok('第三参省略时按「有服务」处理（不误抹）',
	label('LTE', 1) === '4G-LTE', label('LTE', 1));

say('');
say('=== hasPsService：CGREG 状态码判定 ===');

ok('stat=1（已注册）→ true', hasPs(1, {}) === true);
ok('stat=5（已注册漫游）→ true', hasPs(5, {}) === true);
ok('stat=0（未注册）→ false', hasPs(0, { mcc: '460' }) === false);
ok('stat=2（正在搜索）→ false', hasPs(2, { mcc: '460' }) === false);
ok('stat=3（注册被拒）→ false', hasPs(3, { mcc: '460' }) === false);
/* null = 这一轮没取到，退化看 MCC：未注册时 MONSC 的 MCC 是 000 */
ok('stat=null + MCC=000 → false（退化判据仍认得出没服务）',
	hasPs(null, { mcc: '000' }) === false);
ok('stat=null + MCC=460 → true（一次查询失败不能抹掉制式）',
	hasPs(null, { mcc: '460' }) === true);

say('');
say('=== hasAnyPsService：CEREG 为准、CGREG 兜底 ===');

ok('★ CEREG=2（未注册）→ false（本 bug 的正解）',
	hasAny(2, null, { mcc: '000' }) === false);
ok('CEREG=1（已注册）→ true', hasAny(1, null, {}) === true);
ok('CEREG=5（漫游已注册）→ true', hasAny(5, null, {}) === true);
ok('★ CEREG=0 但 CGREG=1 → true（纯 LTE/NR 下 CGREG 会恒报 0，不能误判没服务）',
	hasAny(null, 1, { mcc: '460' }) === true);
ok('CEREG 未知 + CGREG=2 → false', hasAny(null, 2, { mcc: '460' }) === false);
ok('两条都未知 + MCC=460 → true', hasAny(null, null, { mcc: '460' }) === true);
ok('两条都未知 + MCC=000 → false', hasAny(null, null, { mcc: '000' }) === false);
ok('★ CEREG 优先于 CGREG：CEREG=1 与 CGREG=0 冲突时听 CEREG',
	hasAny(1, 0, {}) === true);

say('');
say('=== normStat：AT 响应里的字符串 stat ===');

ok('"2" → 2', norm('2') === 2);
ok('空串 → null（不拿 0 冒充「未注册」）', norm('') === null);
ok('null → null', norm(null) === null);
ok('非数字 → null', norm('abc') === null);

say('');
say('=== 连接状态标题带运营商 ===');

ok('connCard 取了标题节点', /connTitleEl\s*=\s*connCard\.querySelector\('\.mt5700-card-title'\)/.test(src));
ok('标题拼成「连接状态 ・ <运营商>」', /'连接状态 ・ '\s*\+\s*op/.test(src));
ok('未知运营商不拼进标题（免得标题变长还无意义）',
	/state\.operator\s*!==\s*'未知运营商'/.test(src));
ok('renderConn 里刷新标题（运营商是慢档才拿到的）',
	extractFn(src, 'renderConn').indexOf('connTitleEl') !== -1);
ok('★ 网络制式把「是否真驻留」传给 systemModeLabel（未注册不显示残留制式）',
	/systemModeLabel\(state\.cell\.sysMode,\s*state\.carriers\.length,\s*hasAnyPsService\(/.test(src));

say('');
if (fails.length) {
	console.log(log.join('\n'));
	console.log('\n✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（network_status.js 制式文案 / 标题）');
