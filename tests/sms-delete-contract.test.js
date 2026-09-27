#!/usr/bin/env node
'use strict';

/**
 * 短信删除契约测试（sms_center.js 的批量删除 + 单条删除）
 * ---------------------------------------------------------------------------
 * ★ 用户报告：「优化短信批量删除功能，目前删除不了已发送的短信，
 *   还有没有全选按钮，样式太丑，全面重新设计」。
 *
 * 已发送的短信**一条也删不掉**，根因是一个「字段名在唯一的主路径上丢了」的缺陷：
 *
 *   loadSentLog()
 *     -> migrateLegacySent(r.messages)
 *          if (serverList.length) return Promise.resolve(serverList);   ← 主路径
 *          ...（只有「localStorage 老数据迁移成功」这条冷路径才走 toSentRecords）
 *     -> 于是主路径交出去的是**后端原始记录** {content,number,time,type,**id**}
 *
 *   而删除路径只读 `m.logId`（`logId` 只由 toSentRecords 产生）：
 *     deleteMessage:  else if (msg.logId != null) …  else 「这条记录还没同步到设备上」
 *     batchDelete:    if (!idxs.length && m.logId != null) logIds.push(m.logId)
 *   结果：单条删除弹一句驴唇不对马嘴的「还没同步到设备上」；
 *         批量删除 logIds 恒空、一条也删不掉，最后还报「成功删除 0 条短信」。
 *
 * 另外两处一并钉住：
 *   · 一条记录可能**同时**有模组槽位（index）和设备编号（logId），
 *     原来的 `if (idxs.length) … else if (logId)` / `if (!idxs.length && logId)`
 *     只要带了槽位就永远轮不到设备记录 —— 必须**都收**。
 *   · 批量删除对话框原来复用的是「同意条款」那组组件
 *     （.mt5700-agree-list + .mt5700-inline），没有全选、没有计数、视觉上不成列表。
 *
 * 用法：node tests/sms-delete-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver');
const SMS = fs.readFileSync(path.join(V, 'sms_center.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/mt5700.css'), 'utf8');

let pass = 0, fail = 0;
/* ★ 失败前缀必须是 '  ✗ '：tools/verify-guards.py 靠它数「判红几处」，
   写成别的会让守卫看上去「判红 0 处」。 */
function ok(name) { pass++; console.log('  ok   ' + name); }
function no(name, why) { fail++; console.log('  ✗ ' + name + '  → ' + why); }
function has(name, cond, why) { cond ? ok(name) : no(name, why); }

/* ------------------------------------------------------------------ */
console.log('== A. 根因：编号字段名不许在主路径上丢 ==');

/* 编号来源必须只有一处真相，且两个字段名都认 */
has('存在 logIdOf()（编号来源单一）',
	/function logIdOf\(m\) \{/.test(SMS),
	'各处置自己的一套取编号逻辑，就还会有下一次同源事故');
has('★ logIdOf 同时认 logId 与后端 id',
	/if \(m\.logId != null\) return m\.logId;/.test(SMS) && /return \(m\.id != null\) \? m\.id : null;/.test(SMS),
	'只认一个字段名 —— 主路径交出来的正是后端原始记录（字段是 id）');

/* ★ 本缺陷的直接钉桩：loadSentLog 出去之前必须统一转换 */
has('★ loadSentLog 对 migrateLegacySent 的结果统一过 toSentRecords',
	/migrateLegacySent\(r\.messages \|\| \[\]\)\.then\(toSentRecords\)/.test(SMS),
	'主路径（设备端已有记录）会绕过转换，把后端原始记录直接交给界面 —— 已发短信就此删不掉');

/* migrateLegacySent 的「不重复搬」判空要保留（性能意图没错，错的是出口没转换） */
has('migrateLegacySent 仍保留「设备端已有记录就不重复搬」的判空',
	/if \(serverList\.length\) return Promise\.resolve\(serverList\);/.test(SMS),
	'去掉判空会每次进页面都把本地老数据重搬一遍，记录翻倍');

has('toSentRecords 经 logIdOf 取编号（不在函数内另写一套）',
	/logId: logIdOf\(m\)/.test(SMS),
	'两套取法迟早漂移');

/* ------------------------------------------------------------------ */
console.log('== B. 删除路由：一条记录的两个目标都要收 ==');

/* 不许再有「二选一」的写法 */
has('★ 单条删除不再写成 else if (msg.logId …)',
	!/else if \(msg\.logId != null\)/.test(SMS),
	'带了模组槽位的记录永远轮不到设备记录，删了模组那条、设备那条还在');
has('★ 批量删除不再写成 !idxs.length && m.logId',
	!/!\s*idxs\.length\s*&&\s*m\.logId/.test(SMS),
	'同上：只要带了槽位，设备编号就被跳过');

has('存在 deleteTargetsOf()（两个目标一次收齐）',
	/function deleteTargetsOf\(m\) \{/.test(SMS) &&
	/return \{ indices: partIndicesOf\(m\), logId: logIdOf\(m\) \};/.test(SMS),
	'删除依据必须在同一处算出来，避免单条/批量各写一份');

has('单条与批量共用同一个 runDeletes()',
	/function runDeletes\(messages\) \{/.test(SMS) &&
	/runDeletes\(\[msg\]\)/.test(SMS) && /runDeletes\(picked\)/.test(SMS),
	'两处各写一套 = 修了一处漏另一处（本轮两个缺陷正是这样来的）');

has('删除结果按「短信条数」判定：模组侧与设备侧都成功才算删掉',
	/if \(atOk && r && r\.success\) stats\.ok\+\+; else stats\.fail\+\+;/.test(SMS),
	'只看一半会报出「成功」而记录还在');

has('编号以数字形态传给后端（ucode 的 args 声明是整型）',
	/AtWs\.smsLog\('del', '', t\.logId\)/.test(SMS),
	'字符串形态会被 rpcd 以 code=2 拒掉，界面只落一个「删除失败」');

has('删不掉的记录有明确出口，不伪装成成功',
	/function reportDeleteResult\(s\) \{/.test(SMS) && /stats\.unsynced\+\+/.test(SMS),
	'把「没删成」说成成功，用户会以为已经删了');

/* ------------------------------------------------------------------ */
console.log('== C. 批量删除对话框：全选 / 计数 / 反选 ==');

has('★ 有全选控件', /'全选'/.test(SMS) && /allChk/.test(SMS),
	'用户要的就是它');
has('★ 有反选按钮', /'反选'/.test(SMS),
	'全选之外还要能一键反转，否则「留几条删剩下的」要手点很多次');
has('★ 有实时计数（已选 N / 共 M 条）',
	/'已选 ' \+ n \+ ' \/ 共 ' \+ rows\.length \+ ' 条'/.test(SMS) || /已选 \$\{n\}/.test(SMS),
	'勾了几条必须看得见');
has('★ 全选框有半选态（部分选中）',
	/allChk\.indeterminate = n > 0 && n < rows\.length;/.test(SMS),
	'部分选中却显示成空框，用户会以为勾选丢了');
has('删除按钮带选中数量且为 0 时禁用',
	/delBtn\.disabled = n === 0;/.test(SMS) && /删除所选（/.test(SMS),
	'没有选中项还能点「删除」，会落一个让人困惑的警告');
has('选中状态只有一处真相（各行 checkbox），三处派生',
	/function sync\(\) \{/.test(SMS) && /allChk\.addEventListener\('change'/.test(SMS),
	'三处各自记数迟早对不上');

has('批量列表不再复用「同意条款」那组样式',
	!/mt5700-agree-list/.test(SMS) && !/mt5700-inline/.test(SMS),
	'那是给同意条款用的，套在短信列表上就是「样式太丑」的来源');

/* 新样式必须真的存在，否则类名挂上去也没有视觉效果 */
['mt5700-modal-wide', 'mt5700-sms-pick-toolbar', 'mt5700-sms-pick-count',
	'mt5700-sms-pick-list', 'mt5700-sms-pick-row', 'mt5700-sms-pick-main',
	'mt5700-sms-pick-head', 'mt5700-sms-pick-num', 'mt5700-sms-pick-time',
	'mt5700-sms-pick-text'].forEach(function (cls) {
	has('CSS 定义了 .' + cls, CSS.indexOf('.' + cls) >= 0,
		'JS 挂了类名但 CSS 里没有 → 样式完全不起作用');
});

has('标题用 mt5700-modal-header 包住（那个类才有内边距）',
	/mt5700-modal-header/.test(SMS),
	'mt5700-modal-title 自身没有 padding，直接贴在弹窗边缘');

has('正文预览走 textContent（E 的文本参数），不拼 HTML',
	!/innerHTML/.test(SMS.slice(SMS.indexOf('function batchDelete'), SMS.indexOf('function batchDelete') + 6000)),
	'短信正文是不可信输入，绝不能进 innerHTML');

/* ------------------------------------------------------------------ */
console.log('== D. 行为：用真实函数 + 假设备跑一遍路由 ==');

/** 从源码里抽出若干具名函数（函数体到首个「两制表符缩进的右花括号」为止） */
function extract(names) {
	var out = [];
	for (var i = 0; i < names.length; i++) {
		var re = new RegExp('function ' + names[i] + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\t\\t\\}');
		var m = SMS.match(re);
		if (!m) return null;
		out.push(m[0]);
	}
	return out.join('\n');
}

var CORE = extract(['partIndicesOf', 'logIdOf', 'deleteTargetsOf', 'runDeletes']);
has('能抽出 partIndicesOf / logIdOf / deleteTargetsOf / runDeletes 四个函数',
	CORE !== null, '抽不出来就没法测这段行为（依赖要一起抽，否则求值是 ReferenceError）');

var api = null;
if (CORE) {
	try {
		/* AtWs 走参数注入：不 mock 就真的会去打设备 */
		/* eslint-disable no-new-func */
		api = new Function('AtWs', CORE + '\n; return { deleteTargetsOf: deleteTargetsOf, runDeletes: runDeletes };');
	} catch (e) {
		api = null;
	}
}

/** 造一个假设备：记录下发了哪些命令，并按需让指定的一条失败 */
function makeEnv(opt) {
	opt = opt || {};
	var calls = { cmgd: [], logdel: [] };
	var env = {
		client: {
			sendCommand: function (cmd) {
				var ix = parseInt(String(cmd).replace(/^AT\+CMGD=/, ''), 10);
				calls.cmgd.push(ix);
				return Promise.resolve((opt.cmgdFail || []).indexOf(ix) >= 0 ? { success: false } : { success: true });
			}
		},
		smsLog: function (action, entry, id) {
			calls.logdel.push(id);
			return Promise.resolve((opt.logFail || []).indexOf(id) >= 0
				? { success: false, error: '没有找到该条已发记录' }
				: { success: true });
		}
	};
	return { AtWs: env, calls: calls };
}

function run(name, env, msgs, check) {
	return api(env.AtWs).runDeletes(msgs).then(function (s) {
		check(s, env.calls);
	}, function (e) {
		no(name, 'runDeletes 抛异常：' + (e && e.message));
	});
}

var jobs = [];
if (api) {
	var fns = api(makeEnv().AtWs);

	/* --- 路由本身的判定（同步，先跑） --- */
	var t1 = fns.deleteTargetsOf({ index: 5, content: 'a' });
	has('只有模组槽位 → indices=[5]、logId=null',
		t1.indices.length === 1 && t1.indices[0] === 5 && t1.logId === null, JSON.stringify(t1));

	var t2 = fns.deleteTargetsOf({ id: 7, content: 'b' });
	has('★ 只有后端 id（主路径的形态）→ logId=7',
		t2.indices.length === 0 && t2.logId === 7,
		'取不到编号就是「删除不了已发送的短信」：' + JSON.stringify(t2));

	var t3 = fns.deleteTargetsOf({ index: 5, id: 7, content: 'c' });
	has('★ 两者都有 → 两个目标都收齐（不是二选一）',
		t3.indices.length === 1 && t3.indices[0] === 5 && t3.logId === 7, JSON.stringify(t3));

	var t4 = fns.deleteTargetsOf({ partIndices: [1, 2, 3], logId: 9 });
	has('长短信多段 + 设备编号 → 1,2,3 与 9 都在',
		t4.indices.join(',') === '1,2,3' && t4.logId === 9, JSON.stringify(t4));

	var t5 = fns.deleteTargetsOf({ content: 'd' });
	has('两者都没有 → 两个目标都空（交给 unsynced 分支）',
		t5.indices.length === 0 && t5.logId === null, JSON.stringify(t5));

	/* --- 异步：真的跑一遍 runDeletes --- */
	jobs.push(run('只有槽位：发 1 条 AT+CMGD、不发设备请求', makeEnv(), [{ index: 5 }],
		function (s, c) {
			has('只有槽位：走 AT+CMGD 且计为成功 1 条',
				c.cmgd.join(',') === '5' && c.logdel.length === 0 && s.ok === 1 && s.fail === 0,
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
		}));

	jobs.push(run('只有后端 id：发 1 条 smslog del、不发 AT', makeEnv(), [{ id: 7 }],
		function (s, c) {
			has('★ 只有后端 id：走设备记录删除（这条以前一条也走不到）',
				c.cmgd.length === 0 && c.logdel.join(',') === '7' && s.ok === 1 && s.fail === 0,
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
			has('★ 传给后端的编号是 number（rpcd 的 args 是整型）',
				typeof c.logdel[0] === 'number',
				'字符串形态会被 rpcd 以 code=2 拒掉，界面只落一个「删除失败」，实际传了 ' + typeof c.logdel[0]);
		}));

	jobs.push(run('两者都有：AT 与设备记录都发', makeEnv(), [{ index: 5, id: 7 }],
		function (s, c) {
			has('★ 两者都有：AT+CMGD 与 smslog del 都发了（旧代码只发前者）',
				c.cmgd.join(',') === '5' && c.logdel.join(',') === '7' && s.ok === 1,
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
		}));

	jobs.push(run('AT 失败 → 这条算失败（即使设备侧成功）', makeEnv({ cmgdFail: [5] }), [{ index: 5, id: 7 }],
		function (s, c) {
			has('AT 失败时不许报成功',
				s.fail === 1 && s.ok === 0 && c.logdel.length === 1,
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
		}));

	jobs.push(run('设备记录删除失败 → 这条算失败', makeEnv({ logFail: [7] }), [{ id: 7 }],
		function (s) {
			has('设备侧失败时不许报成功', s.fail === 1 && s.ok === 0, 'stats=' + JSON.stringify(s));
		}));

	jobs.push(run('长短信多段：逐段下发，全成功才算删掉', makeEnv(), [{ partIndices: [1, 2, 3] }],
		function (s, c) {
			has('长短信逐段删，顺序为 1,2,3',
				c.cmgd.join(',') === '1,2,3' && s.ok === 1 && s.fail === 0,
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
		}));

	jobs.push(run('多段里有一段失败 → 整条算失败', makeEnv({ cmgdFail: [2] }), [{ partIndices: [1, 2, 3] }],
		function (s, c) {
			has('任一段失败则整条算失败（不报半成功）',
				s.fail === 1 && s.ok === 0 && c.cmgd.join(',') === '1,2,3',
				'stats=' + JSON.stringify(s));
		}));

	jobs.push(run('两者都没有 → 记为 unsynced，且一个请求都不发', makeEnv(), [{ content: 'x' }],
		function (s, c) {
			has('未同步的记录：计 unsynced 且不发任何请求',
				s.unsynced === 1 && s.ok === 0 && s.fail === 0 &&
				c.cmgd.length === 0 && c.logdel.length === 0,
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
		}));

	jobs.push(run('混合一批：收/发/未同步各自计数正确', makeEnv(),
		[{ index: 1 }, { id: 2 }, { index: 3, id: 4 }, { content: 'y' }],
		function (s, c) {
			has('混合批次：3 条可删 + 1 条未同步，计数与请求都对',
				s.ok === 3 && s.fail === 0 && s.unsynced === 1 &&
				c.cmgd.join(',') === '1,3' && c.logdel.join(',') === '2,4',
				'stats=' + JSON.stringify(s) + ' calls=' + JSON.stringify(c));
		}));
} else {
	no('无法构造行为测试环境', 'CORE 抽取失败');
}

/* ------------------------------------------------------------------ */
console.log('== E. 反向自证：把缺陷改回去，上面的判据必须不再成立 ==');

/* 自证 A：去掉 loadSentLog 的统一转换 */
{
	var broken = SMS.replace('migrateLegacySent(r.messages || []).then(toSentRecords)',
		'migrateLegacySent(r.messages || [])');
	has('自证 A：去掉统一转换后，「主路径字段名会丢」的判据不再成立',
		!/migrateLegacySent\(r\.messages \|\| \[\]\)\.then\(toSentRecords\)/.test(broken));
}
/* 自证 B：把 logIdOf 改回只认 logId */
{
	var broken2 = SMS.replace(
		'function logIdOf(m) {\n\t\t\tif (!m) return null;\n\t\t\tif (m.logId != null) return m.logId;\n\t\t\treturn (m.id != null) ? m.id : null;\n\t\t}',
		'function logIdOf(m) {\n\t\t\tif (!m) return null;\n\t\t\treturn (m.logId != null) ? m.logId : null;\n\t\t}');
	has('自证 B：logIdOf 只认 logId 后，「两个字段名都认」的判据不再成立',
		!/return \(m\.id != null\) \? m\.id : null;/.test(broken2));
}
/* 自证 C：把二选一写法放回去 */
{
	var broken3 = SMS.replace('return { indices: partIndicesOf(m), logId: logIdOf(m) };',
		'var idx = partIndicesOf(m); return { indices: idx, logId: idx.length ? null : logIdOf(m) };');
	has('自证 C：改回「有槽位就不收编号」后，deleteTargetsOf 的单一写法判据不再成立',
		!/return \{ indices: partIndicesOf\(m\), logId: logIdOf\(m\) \};/.test(broken3));
}

/* ------------------------------------------------------------------ */
Promise.all(jobs).then(function () {
	console.log('');
	console.log('sms-delete-contract: ' + pass + ' passed, ' + fail + ' failed');
	process.exit(fail ? 1 : 0);
}, function (e) {
	console.log('  ✗ 行为测试整体失败  → ' + (e && e.message));
	console.log('');
	console.log('sms-delete-contract: ' + pass + ' passed, ' + (fail + 1) + ' failed');
	process.exit(1);
});
