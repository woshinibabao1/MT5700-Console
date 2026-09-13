#!/usr/bin/env node
'use strict';

/**
 * SIM 卡状态自愈 + 「AT 只走 Rust」契约测试
 *
 * 背景：本卡实测 `AT^SIMSQ?` 长期停在 `1,11`（网络可用、短信与电话未接入）。
 * 按用户要求新增 SIM 自愈：`AT^SETMODE?` = 4 且 SIMSQ ≠ 12 时，
 * `AT^HVSST=1,0` → 等 3 秒 → `AT^HVSST=1,1`。
 *
 * 三条硬约束，本测试就是钉死它们：
 *   ① **一切 AT 都走 Rust** —— 不许任何 shell/前端自己开串口、抄一份 HVSST；
 *   ② **每次开机最多执行一次** —— tmpfs 标记文件（跨服务重启也拦得住）；
 *   ③ **HVSST 配对必须闭合** —— =1,0 之后无论如何都要补 =1,1，
 *      否则 SIM 检测会一直停在关闭状态（这是最容易出的事故）。
 *
 * 本机没有 cargo/rustc，Rust 的行为测试（假模组集成测试）在 CI 上跑，
 * 这里只做**静态守卫**：源码里那些「少一行就出事」的写法必须一直在。
 *
 * 用法：node tests/sim-heal-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIMHEAL_RS = path.join(ROOT, 'src/rust/src/simheal.rs');
const ATCLIENT_RS = path.join(ROOT, 'src/rust/src/atclient.rs');
const CONFIG_RS = path.join(ROOT, 'src/rust/src/config.rs');
const MAIN_RS = path.join(ROOT, 'src/rust/src/main.rs');
const UCI_CFG = path.join(ROOT, 'root/etc/config/at-webserver');
const UCI_DEF = path.join(ROOT, 'root/etc/uci-defaults/at-webserver');
const SERVICE_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/service.js');
const WD_SH = path.join(ROOT, 'root/usr/share/mt5700/watchdog.sh');
const PARSE_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/parse.js');
const M5700_JS = path.join(ROOT, 'htdocs/luci-static/resources/at-webserver/mt5700.js');
const NETSTATUS_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/network_status.js');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
	if (cond) {
		pass++;
		console.log('  ok   ' + name);
	} else {
		fail++;
		console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
	}
}

function exists(p) {
	return fs.existsSync(p);
}

function read(p) {
	return exists(p) ? fs.readFileSync(p, 'utf8') : '';
}

/** 剥掉整行注释，避免被源码里解释历史写法的注释误伤。 */
function stripHashComments(text) {
	return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** 剥掉 `//` 行注释与 `///` 文档注释（Rust）。 */
function stripRustLineComments(text) {
	return text.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const simheal = read(SIMHEAL_RS);
const atclient = read(ATCLIENT_RS);
const atclientCode = stripRustLineComments(atclient);
const configRs = read(CONFIG_RS);
const mainRs = read(MAIN_RS);
const uciCfg = read(UCI_CFG);
const uciDef = read(UCI_DEF);
const svc = read(SERVICE_JS);
const wdCode = stripHashComments(read(WD_SH));

/* ---------------------------------------------------------------------------
 * 1. 模块与判据
 * ------------------------------------------------------------------------- */

console.log('== 1. Rust 侧：模块、判据、阈值 ==');

ok('存在 src/rust/src/simheal.rs', exists(SIMHEAL_RS));
ok('main.rs 注册了 mod simheal', /^\s*mod simheal;/m.test(mainRs));

ok('期望连接模式是 4（USB 网口模式）', /pub const EXPECTED_SETMODE: i64 = 4;/.test(simheal));
ok('「完全就绪」判据是 12', /pub const SIM_STATUS_READY: i64 = 12;/.test(simheal));
ok('HVSST 配对等待是 3 秒', /pub const HVSST_PAIR_WAIT: Duration = Duration::from_secs\(3\);/.test(simheal),
	'用户指定 sleep 3，与 WTModem 的 mt5700m.sh 一致');

ok('parse_setmode 认「整行裸值」形态（真机就是回 4）',
	/line\.len\(\) == 1 && line\.as_bytes\(\)\[0\]\.is_ascii_digit\(\)/.test(simheal),
	'tests/mock-modem/real-samples.txt 里真机 AT^SETMODE? 回的是裸值 4\\r\\nOK');
ok('parse_setmode 也兼容 ^SETMODE: 前缀形态', /strip_prefix\("\^SETMODE:"\)/.test(simheal));
ok('parse_simsq_status 取第二个字段（跳过 <mode>）',
	/strip_prefix\("\^SIMSQ:"\)/.test(simheal) && /fields\.next\(\)\?;/.test(simheal));
ok('解析失败一律返回 None（宁可不动也不瞎动）',
	(simheal.match(/-> Option<i64>/g) || []).length >= 2);

/* ---------------------------------------------------------------------------
 * 2. ★ 每次开机最多执行一次
 * ------------------------------------------------------------------------- */

console.log('== 2. ★ 每次开机最多执行一次 ==');

ok('标记文件在 /tmp（tmpfs：服务重启保留、设备重启清空）',
	/marker_path\(\) -> PathBuf[\s\S]{0,200}\/tmp\/mt5700-simheal\.done/.test(simheal),
	'用内存标志挡不住「procd 重启服务后自愈又跑一遍」');
ok('标记文件用 create_new（O_EXCL 原子创建，跨进程只有一个赢家）',
	/create_new\(true\)/.test(simheal));
ok('文件已存在时判定为「已用过」', /ErrorKind::AlreadyExists => false/.test(simheal));
ok('进程内还有一层 AtomicBool 兜底（swap 判定）',
	/self\.used\.swap\(true, Ordering::SeqCst\)/.test(simheal));
ok('atclient 持有守卫实例', /sim_heal_guard: crate::simheal::BootGuard/.test(atclient));

const claimIdx = atclientCode.indexOf('self.sim_heal_guard.claim()');
ok('ensure_sim_ready 里真的调用了守卫', claimIdx >= 0);
ok('拿不到机会就立刻返回（不推 HVSST）',
	claimIdx >= 0 && /if !self\.sim_heal_guard\.claim\(\)[\s\S]{0,220}return;/.test(atclientCode));

// 「卡已就绪 / 非 USB 模式 / 卡不在位」这三种情况必须在 claim 之前返回，
// 否则会白白耗掉本次开机唯一的一次机会。
const hv10First = atclientCode.indexOf('"AT^HVSST=1,0"');
ok('提前返回都在 claim 之前（机会不会被白耗）',
	claimIdx > 0 && hv10First > 0 && claimIdx < hv10First,
	'claim 必须发生在确认「确实需要推卡」之后');
ok('非 USB 网口模式会提前返回', /EXPECTED_SETMODE => \{\}/.test(atclientCode));
ok('卡已就绪（12）会提前返回', /if status == simheal::SIM_STATUS_READY/.test(atclientCode));
ok('卡不在位 / 已失效 / 已移除（0/98/99）会提前返回',
	/matches!\(status, 0 \| 98 \| 99\)/.test(atclientCode),
	'卡都没插的时候推 HVSST 毫无意义，不能白耗机会');

/* ---------------------------------------------------------------------------
 * 3. ★ HVSST 配对必须闭合
 * ------------------------------------------------------------------------- */

console.log('== 3. ★ HVSST 配对必须闭合 ==');

const i10 = atclientCode.indexOf('"AT^HVSST=1,0"');
const i11 = atclientCode.indexOf('"AT^HVSST=1,1"');
ok('两条 HVSST 都在 ensure_sim_ready 里', i10 > 0 && i11 > 0);
ok('顺序是 =1,0 在前、=1,1 在后', i10 > 0 && i11 > i10);

const pairSegment = i10 > 0 && i11 > i10 ? atclientCode.slice(i10, i11) : '';
ok('两发之间没有提前 return（否则会把卡留在 HVSST=0）',
	pairSegment.length > 0 && !/\breturn;/.test(pairSegment),
	'=1,0 无论回什么、甚至收不到应答，都必须继续把 =1,1 发出去');
ok('配对之间的等待用 tokio::time::sleep，不响应 ctx 取消',
	/tokio::time::sleep\(simheal::HVSST_PAIR_WAIT\)/.test(pairSegment) &&
	!/sleep_ctx/.test(pairSegment),
	'服务正好在 3 秒窗口里关闭时，也不能把 SIM 检测丢在关闭状态');

// Rust 侧的行为测试（假模组）钉住「=1,0 回 ERROR 也要补 =1,1」
ok('有「推送恰好一次」的行为测试', /sim_heal_pushes_hvsst_exactly_once_per_boot/.test(atclient));
ok('有「=1,0 回 ERROR 仍需闭合配对」的行为测试', /sim_heal_always_closes_the_hvsst_pair/.test(atclient));
ok('有「卡已就绪不消耗唯一机会」的行为测试', /sim_heal_skips_when_ready_and_keeps_the_single_shot/.test(atclient));
ok('有「非 USB 模式不消耗唯一机会」的行为测试', /sim_heal_skips_when_not_usb_mode/.test(atclient));
ok('有「卡不在位/已失效不消耗唯一机会」的行为测试', /sim_heal_skips_dead_sim_and_keeps_the_single_shot/.test(atclient));
ok('有「关闭开关一条命令都不发」的行为测试', /sim_heal_disabled_sends_nothing/.test(atclient));

// ★ 配对两发必须用「永不取消」的上下文。用调用方的 ctx 下发时，
//   `send_command_inner` 的「等命令锁」与「命令间隔」两处取消点都在
//   **写入串口之前** —— 服务恰好在配对窗口里关闭，配对就真的断在半路，
//   卡会留在 HVSST=0（SIM 检测关闭）。这是 1.0.2 留下的缺口。
ok('simheal.rs 提供 pair_context（永不取消的上下文）',
	/pub fn pair_context\(\) -> \(watch::Sender<bool>, watch::Receiver<bool>\)/.test(simheal));
ok('配对两发都用 pair_ctx',
	/send_command\(\s*&pair_ctx\s*,\s*"AT\^HVSST=1,0"/.test(atclientCode) &&
	/send_command\(\s*&pair_ctx\s*,\s*"AT\^HVSST=1,1"/.test(atclientCode));
ok('没有任何一发 HVSST 用会取消的 ctx 下发',
	!/send_command\(\s*ctx\s*,\s*"AT\^HVSST/.test(atclientCode),
	'用 ctx 下发会让「服务正在关闭」把配对断在半路');
ok('_pair_tx 与 pair_ctx 绑定保活（sender 一旦 drop 会反转成「立刻取消」）',
	/let \(_pair_tx, pair_ctx\) = simheal::pair_context\(\);/.test(atclientCode));
ok('有「pair_context 保活时不报取消」的单测',
	/pair_context_never_cancels_while_sender_is_alive/.test(simheal));
ok('有「sender 被 drop 会反转语义」的单测（把这个坑固化下来）',
	/dropping_the_pair_sender_inverts_the_semantics/.test(simheal));
ok('有「配对上下文能完成一次往返」的行为测试',
	/pair_context_drives_a_normal_round_trip/.test(atclient));

/* ---------------------------------------------------------------------------
 * 4. ★ 一切 AT 都走 Rust（不许 shell / 前端抄一份）
 * ------------------------------------------------------------------------- */

console.log('== 4. ★ 一切 AT 指令都走 Rust ==');

ok('看门狗脚本里没有 HVSST（SIM 自愈是 Rust 的活，不许在 shell 里再抄一份）',
	!/AT\^HVSST/.test(wdCode), 'watchdog.sh 里只允许出现在注释里作为 AT 分支的举例');

const shellFiles = [
	['watchdog.sh', path.join(ROOT, 'root/usr/share/mt5700/watchdog.sh')],
	['hotplug 续约脚本', path.join(ROOT, 'root/etc/hotplug.d/net/99-mt5700-renew')],
	['init.d 脚本', path.join(ROOT, 'root/etc/init.d/mt5700-watchdog')]
];
for (const [label, p] of shellFiles) {
	const t = read(p);
	if (!t) continue;
	ok(label + ' 不直接用 microcom 碰串口', !/microcom/.test(stripHashComments(t)));
	ok(label + ' 不直接用 stty 碰串口', !/\bstty\b/.test(stripHashComments(t)));
}
ok('前端不出现 microcom / navigator.serial',
	!/microcom|navigator\.serial/.test(svc));
ok('自愈用的 AT 全部经 AtClient::send_command',
	/self\.send_command\(ctx, "AT\^SETMODE\?"/.test(atclientCode) &&
	/self\.send_command\(ctx, "AT\^SIMSQ\?"/.test(atclientCode) &&
	/send_command\(\s*&pair_ctx\s*,\s*"AT\^HVSST=1,0"/.test(atclientCode) &&
	/send_command\(\s*&pair_ctx\s*,\s*"AT\^HVSST=1,1"/.test(atclientCode),
	'查询走调用方的 ctx；配对两发走永不取消的 pair_ctx');

/* ---------------------------------------------------------------------------
 * 5. 挂在初始化链路里，且时机正确
 * ------------------------------------------------------------------------- */

console.log('== 5. 挂载点：连上模组后、拨号对齐之前 ==');

const initIdx = atclientCode.indexOf('async fn init_modem');
const callIdx = atclientCode.indexOf('self.ensure_sim_ready(ctx).await;');
const autodialIdx = atclientCode.indexOf('self.ensure_autodial(ctx).await;');
ok('init_modem 里调用了 ensure_sim_ready', initIdx > 0 && callIdx > initIdx);
ok('ensure_sim_ready 排在 ensure_autodial 之前',
	callIdx > 0 && autodialIdx > 0 && callIdx < autodialIdx,
	'推卡可能让模组重读 SIM，拨号对齐要在最终状态下做');

/* ---------------------------------------------------------------------------
 * 6. 配置项四处口径一致
 * ------------------------------------------------------------------------- */

console.log('== 6. sim_heal_enable 默认值口径一致 ==');

ok('Rust 结构体有 sim_heal_enable 字段', /pub sim_heal_enable: bool,/.test(configRs));
ok('Rust 默认配置为 true', /sim_heal_enable: true,/.test(configRs));
ok('Rust 从 UCI 读 sim_heal_enable（默认 true）',
	/values\.bool\("sim_heal_enable", true\)/.test(configRs));
ok('随包 config 默认开', /^\s*option sim_heal_enable '1'/m.test(uciCfg));
ok('uci-defaults 升级补齐默认开', /^\s*sim_heal_enable=1\s*\\?$/m.test(uciDef));
ok('service.js 回填默认开', /get\('sim_heal_enable', '1'\)/.test(svc));
ok('service.js 保存时写回', /set\('sim_heal_enable'/.test(svc));

/* ---------------------------------------------------------------------------
 * 7. 界面可发现
 * ------------------------------------------------------------------------- */

console.log('== 7. 界面 ==');

ok('service.js 有「SIM 卡状态自愈」卡片', /Mt5700\.card\('SIM 卡状态自愈'/.test(svc));
ok('界面提示写明「每次开机最多执行一次」', /每次开机最多执行一次/.test(svc));
ok('界面提示写明判定条件（SETMODE=4 且 SIMSQ 非 12）',
	/AT\^SETMODE\? 为 4/.test(svc) && /AT\^SIMSQ\? 不是 12/.test(svc));
ok('界面提示写明「AT 由后端服务下发」', /所有 AT 指令一律由后端服务下发/.test(svc));

/* ---------------------------------------------------------------------------
 * 8. SIM 文案统一为「短信与电话」
 * ------------------------------------------------------------------------- */

console.log('== 8. SIM 文案统一（不写「电话本」） ==');

for (const [label, p] of [['parse.js', PARSE_JS], ['mt5700.js', M5700_JS], ['network_status.js', NETSTATUS_JS], ['service.js', SERVICE_JS]]) {
	const t = read(p);
	ok(label + ' 不出现「电话本」', t.indexOf('电话本') < 0,
		'用户拍板：界面文案统一写「短信与电话」');
}
ok('parse.js 码表 12 写「短信与电话可接入」', /12: '卡初始化完成，短信与电话可接入'/.test(read(PARSE_JS)));
ok('parse.js 码表 11 写明「短信与电话未接入」', /11: '卡初始化完成，可接入网络（短信与电话未接入）'/.test(read(PARSE_JS)));

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
process.exit(1);
