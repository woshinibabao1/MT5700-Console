#!/usr/bin/env node
'use strict';

/**
 * 看门狗「AT / 本机 Shell 命令分流」契约测试
 *
 * 背景：v1.0 与 v1.0.3 的看门狗在真机实测里都被发现处理错了，根因有四类：
 *   ① AT 下发通道用错传输 —— 用 wget 打 HTTP POST，而 8765 是**裸 TCP newline-JSON**，
 *      于是「AT 命令」这条分支从来就没真正下发过；
 *   ② `A && B || C` 写法在 A 失败时会把 B 再执行一遍（命令跑两次）；
 *   ③ `printf '%b'` 还原多行会顺带解释 \t \c \\，改坏合法 shell 命令；
 *   ④ while 循环读命令列表没占独立 fd，列表里的命令读 stdin 会吃掉后续行。
 * 另有 AT 判据写太窄：只认 AT+/AT^，把 AT / ATI / ATE0 / ATZ / AT&F 误当 shell 命令。
 *
 * 本测试分两层：
 *   A. 静态守卫 —— 直接读源码断言上述缺陷不会复活（纯文本，任何平台都跑）
 *   B. 行为测试 —— 调 tests/watchdog-routing.test.sh 真跑分流逻辑（需要 sh，缺失则跳过）
 *
 * 用法：node tests/watchdog-routing.test.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WD_SH = path.join(ROOT, 'root/usr/share/mt5700/watchdog.sh');
const UCI_DEF = path.join(ROOT, 'root/etc/uci-defaults/at-webserver');
const UCI_CFG = path.join(ROOT, 'root/etc/config/at-webserver');
const SERVICE_JS = path.join(ROOT, 'htdocs/luci-static/resources/view/at-webserver/service.js');
const HARNESS = path.join(__dirname, 'watchdog-routing.test.sh');

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

function eq(name, actual, expected) {
	ok(name, actual === expected, '实际=[' + actual + '] 期望=[' + expected + ']');
}

function read(p) {
	return fs.readFileSync(p, 'utf8');
}

const wd = read(WD_SH);
const uciDef = read(UCI_DEF);
const uciCfg = read(UCI_CFG);
const svc = read(SERVICE_JS);

/* 守卫要看的是「代码」，不是注释 —— 文件头专门记录了这些历史错误写法，
 * 若把注释算进来，守卫会被自己的说明文字误伤。这里剥掉整行注释。 */
const wdCode = wd.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/* ---------------------------------------------------------------------------
 * A. 静态守卫
 * ------------------------------------------------------------------------- */

console.log('== A1. AT 通道必须是裸 TCP，不是 HTTP ==');

// ① 通道用错传输
ok('watchdog.sh 不用 wget（8765 不是 HTTP）', !/\bwget\b/.test(wdCode),
	'曾用 wget --post-file 打 http://127.0.0.1:8765/，wget 打不进裸 TCP JSON 端口');
ok('watchdog.sh 不用 curl', !/\bcurl\b/.test(wdCode));
ok('watchdog.sh 不出现 http:// 请求 URL', !/https?:\/\//.test(wdCode));
ok('watchdog.sh 用 nc 走裸 TCP', /\bnc\b/.test(wdCode),
	'应通过 nc/socat 连接 127.0.0.1:8765，按行收发 JSON');

// AT 通路上必须有失败判定
ok('send_at 校验应答里的 "success":true', /"success":true/.test(wdCode),
	'只看「连得上」不算成功，必须解析 result.success');
ok('send_at 会提取服务端 error 文案', /"error"/.test(wdCode));
ok('send_at 带上 auth_key（配置了密钥时）', /auth_key/.test(wdCode),
	'websocket_auth_key 非空时请求必须携带，否则一律 -32001 认证失败');
ok('watchdog.sh 从 UCI 读 websocket_port', /websocket_port/.test(wdCode));
ok('watchdog.sh 兼容 websocket_bind 绑到具体地址的情况', /websocket_bind/.test(wdCode),
	'绑到非 0.0.0.0 的本机地址时，连 127.0.0.1 会连不上');

console.log('== A2. 多行还原不能改坏命令 ==');

// ③ printf %b
ok("不用 printf '%b' 还原多行", !/printf\s+'?%b/.test(wdCode),
	"%b 会顺带解释 \\t \\c \\\\ 等，把 `printf 'a\\tb'` 这类合法命令改坏");
ok('只翻译字面 \\n（split_cmds 用 gsub）', /gsub\(\/\\\\n\//.test(wdCode));

console.log('== A3. 命令执行不能跑两次、不能丢行 ==');

// ② A && B || C：原缺陷长这样
//   $(command -v timeout >/dev/null 2>&1 && timeout 30 /bin/sh -c "$line" || /bin/sh -c "$line")
// timeout 存在但命令本身非 0 退出时，|| 分支会把命令**再执行一遍**。
ok('没有 `command -v timeout … || /bin/sh -c` 的双执行写法',
	!/command -v timeout[\s\S]{0,160}\|\|[\s\S]{0,80}\/bin\/sh\s+-c/.test(wdCode),
	'A 失败时会走 || 分支把命令再跑一遍');
ok('超时包装用显式 if/else', /if command -v timeout/.test(wdCode));
ok('run_sh_cmd 分别捕获退出码', /_shrc=\$\?/.test(wdCode));

// ④ 独立 fd
ok('读命令列表用独立 fd 3', /done 3< /.test(wdCode),
	'否则列表里的命令读 stdin 会把剩余待执行命令吃掉');

console.log('== A4. AT / shell 分流规则 ==');

ok('有 is_at_cmd 分流函数', /^is_at_cmd\(\)/m.test(wdCode));
ok('AT 判据覆盖整个 AT 族（[Aa][Tt]*）', /\[Aa\]\[Tt\]\*\)/.test(wdCode),
	'只认 AT+/AT^ 会把 AT / ATI / ATE0 / ATZ / AT&F 误判成 shell 命令');
ok('有 run_sh_cmd 执行本机命令', /^run_sh_cmd\(\)/m.test(wdCode));
ok('reset_modem 对两类命令分别处理', /is_at_cmd "\$line"/.test(wdCode) && /run_sh_cmd "\$line"/.test(wdCode));
ok('空行与 # 注释被忽略', /case "\$line" in \\#\*\) continue/.test(wdCode));

console.log('== A5. 默认值四处口径一致（历史教训：抄了多份会打架） ==');
const DEFAULT_CMDS = 'ifdown MT5700M\\nsleep 2\\nifup MT5700M';
ok('watchdog.sh 缺键兜底为三条 shell 命令', wd.indexOf(DEFAULT_CMDS) >= 0, '找不到 ' + DEFAULT_CMDS);
ok('config 随包默认值为三条 shell 命令', uciCfg.indexOf(DEFAULT_CMDS) >= 0);
ok('uci-defaults 升级补齐为三条 shell 命令', uciDef.indexOf(DEFAULT_CMDS) >= 0);
ok('service.js 前端默认值为三条 shell 命令', svc.indexOf(DEFAULT_CMDS) >= 0);
ok('config 不再把 AT+CFUN=1,1 当默认', !/watch_reset_cmds\s+'AT\+CFUN=1,1'/.test(uciCfg),
	'协议栈复位会让 eth2 数据面挂死，只宜作兜底而非默认');
ok('uci-defaults 不再把 AT+CFUN=1,1 装进新配置', !/^\s*watch_reset_cmds=AT\+CFUN=1,1\s*$/m.test(uciDef));

ok('看门狗默认开启（config）', /option watch_enabled '1'/.test(uciCfg));
ok('看门狗默认开启（watchdog.sh 兜底）', /W_ENABLED=1/.test(wd) && /watch_enabled 1/.test(wd));
ok('看门狗默认开启（service.js 回填）', /get\('watch_enabled', '1'\)/.test(svc));
ok('uci-defaults 把旧默认 0 迁移成 1', /\$\{?_cur_en[\s\S]{0,140}watch_enabled=1/.test(uciDef));
ok('uci-defaults 迁移旧默认 AT+CFUN=1,1', /LEGACY_RESET_CMDS/.test(uciDef),
	'通道修好后旧残留值会真的复位协议栈，必须迁掉');

console.log('== A6. 前端多行往返 ==');
ok('service.js 读回时把字面 \\n 还原成换行', /replace\(\/\\\\n\/g, '\\n'\)/.test(svc));
ok('service.js 保存时用字面 \\n 连接', /join\('\\\\n'\)/.test(svc));
ok('service.js 逐行裁首尾空白（带 g 或逐行处理）', /replace\(\/\^\\s\+\|\\s\+\$\/g, ''\)/.test(svc));
ok('service.js 丢弃空行后再拼接', /filter\(function \(x\) \{ return x !== ''; \}\)/.test(svc));
ok('service.js 提示文案说明了分流规则', /行首是 AT \/ at/.test(svc));

/* ---------------------------------------------------------------------------
 * B. 行为测试（需要 sh）
 * ------------------------------------------------------------------------- */

console.log('== B. 行为测试：真跑分流逻辑 ==');

const probe = spawnSync('sh', ['-c', 'echo ok'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
	console.log('  skip 当前环境没有可用的 sh，跳过行为测试');
	console.log('        （CI/Linux 上会自动执行 tests/watchdog-routing.test.sh）');
} else {
	const r = spawnSync('sh', [HARNESS.replace(/\\/g, '/')], { cwd: ROOT, encoding: 'utf8' });
	const out = (r.stdout || '') + (r.stderr || '');
	const m = out.match(/^(PASS|FAILED)\s+(.*)$/m);
	if (m) console.log('  ' + (m[1] === 'PASS' ? 'ok   ' : 'FAIL ') + 'watchdog-routing.test.sh: ' + m[2]);
	else console.log('  FAIL watchdog-routing.test.sh 未给出结论\n' + out.slice(-800));
	ok('行为测试全部通过', r.status === 0, '退出码=' + r.status);
}

console.log('');
if (fail === 0) {
	console.log('PASS 全部通过（' + pass + ' 项）');
	process.exit(0);
}
console.log('FAILED ' + fail + ' 项失败 / 共 ' + (pass + fail) + ' 项');
process.exit(1);
