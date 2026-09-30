#!/usr/bin/env node
'use strict';

/*
 * 未读徽章契约（防「读了刷新又未读」复发）—— 2026-09-30 真机复现后新增
 * ---------------------------------------------------------------------------
 * 真机现象（设备 192.168.10.1，v2.4.14 插件）：
 *   10086 的【订购成功提醒】全文已被用户读过，列表里仍显示「未读」；
 *   点开会话徽章消失，**刷新后又出现**。
 *
 * 取证链（都在本仓有据可查）：
 *   ① 模组侧恒为已读：`AT+CMGL=0` 连发三次全是空（无未读），全量列表每条都是 `,1,`；
 *      —— 服务端收到 `+CMTI` 会立刻 `AT+CMGR` 取内容做通知，消息到达即被置读；
 *   ② 用户 Console 实测：`20:43:48` 点开会话 → 名单里 10086 被清（clearUnread 生效）；
 *      `20:44:28` 刷新后 10086 又回到名单**末尾**（被重新 markUnread）；
 *   ③ 把事件游标置 0、关闭首轮跳过（重放服务端缓冲的全部事件）→ 名单**一字未变**
 *      ⇒ 事件重放不是原因；
 *   ④ 用户确认该窗口内没有新短信 ⇒ 也不是新消息触发。
 *
 * ⇒ 结论：不是"状态被谁改回去"，而是**未读名单的设计会让徽章长期挂着**：
 *   · `clearUnread` 原先只在**点击左侧联系人行**时调用 —— 会话自动打开/恢复时读了也不清；
 *   · `unreadCount` 有一条"名单里有号码就至少算 1"的回退 —— 会话里已无未读消息也显示未读。
 *
 * 本契约钉住三件事（每一条都能被变异判红）：
 *   ① 会话**被显示**就要清未读（renderConversation 里调用 clearUnread）；
 *   ② unreadCount 不得再退回"号码在名单里就算 1"的宽回退（只能收窄到"消息对象还没到"）；
 *   ③ 名单要能**自动收敛**：列表已带来该会话消息且无未读时，剔除残留号码。
 * 反向自检：判据必须能分辨"修好的写法"与"旧写法"（否则等于恒绿）。
 *
 * 用法：node tests/sms-unread-phantom-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SMS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'sms_center.js');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

const src = fs.readFileSync(SMS, 'utf8');

/* ① 会话被显示即视为已读 */
const SHOW_CLEARS = /function renderConversation\(\)\s*\{[\s\S]{0,900}?clearUnread\(state\.selectedContact\)/;
ok('① renderConversation 显示会话时清未读（否则自动打开/恢复的会话读了也不算已读）',
	SHOW_CLEARS.test(src),
	'renderConversation 里没有 clearUnread(state.selectedContact) —— 未读会一直挂着');

/* ② unreadCount 不得再有宽回退（等号右边直接是 isUnread，没有"消息数为 0"的前置条件）。
 *    ★ 判据用**行首锚定**：注释行以 `*`/`//` 开头，不会命中；
 *      否则本文件上方解释"旧写法"的那段注释会把判据自己顶红（本仓「C 注释不算使用」那个坑）。 */
const WIDE_FALLBACK = /^[ \t]*c\.unreadCount\s*=\s*unreadN\s*\|\|\s*\(\s*isUnread\(/m;
ok('② unreadCount 不得退回"号码在名单里就算 1"的宽回退（幻影未读的来源）',
	WIDE_FALLBACK.test(src) === false,
	'仍存在宽回退：会话里已无未读消息也会显示未读');

/* ②b 正例：必须存在收窄后的回退形态（消息对象还没到时兜底） */
ok('② 保留号码级兜底（模组到达即置读，刷新后只能靠它表示未读）',
	/^[ \t]*c\.unreadCount\s*=\s*unreadN\s*\|\|\s*\(\(isUnread\(c\.number\)\s*&&\s*newerThanRead\)/m.test(src),
	'没找到"号码级 + 晚于水位线"的兜底 —— 未点开的新短信刷新后会变已读');

/* ③ 名单自动收敛 */
ok('③ 列表已带来该会话消息且无未读时，剔除名单里的残留号码并落盘',
	/clearUnread\(c\.number\)/.test(src),
	'没有自动收敛：残留号码会一直挂着，每次重建都把徽章算回来');

/* ---- 反向自检（纯内存）---- */
const OLD_WIDE = 'c.unreadCount = unreadN || (isUnread(c.number) ? 1 : 0);';
const NEW_NARROW = 'c.unreadCount = unreadN || ((c.messages.length === 0 && isUnread(c.number)) ? 1 : 0);';
ok('★ 反向自检：能认出旧的宽回退', WIDE_FALLBACK.test(OLD_WIDE) === true);
ok('★ 反向自检：不会把收窄后的写法误判为宽回退', WIDE_FALLBACK.test(NEW_NARROW) === false);
ok('★ 反向自检：能认出"会话显示即已读"的写法',
	SHOW_CLEARS.test('function renderConversation() {\n\tif (state.selectedContact) clearUnread(state.selectedContact);\n}') === true);

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('未读徽章契约通过（显示即已读 / 无宽回退 / 名单自动收敛）');
