/*
 * 全局统一 TTL —— 契约测试
 *
 * 守的是「规则是否真的在包的必经路径上」，而不是「配置是否写成功」。
 * 2026-11-06 的实测教训：把 ip ttl set 挂在 fw4 的 srcnat 链（type nat）上，
 * 8 个 ping 包后 counter 是 **0** —— nat 链只在 conntrack 首包遍历，
 * 后续包绕开它。规则存在、applied 为 true、界面显示已生效，但 TTL 一个字没改。
 *
 * 用法：node tests/ttl-contract.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UC = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');
const UCI_DEFAULTS = path.join(ROOT, 'root', 'etc', 'uci-defaults', 'at-webserver');
const CONFIG = path.join(ROOT, 'root', 'etc', 'config', 'at-webserver');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const VIEW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_settings.js');

let pass = 0, fails = 0;
function ok(name, cond, extra) {
	if (cond) { pass++; return; }
	fails++;
	console.log('  ✗ ' + name + (extra ? '（' + extra + '）' : ''));
}

const uc = fs.readFileSync(UC, 'utf8');
const acl = fs.readFileSync(ACL, 'utf8');
const defaults = fs.readFileSync(UCI_DEFAULTS, 'utf8');
const config = fs.readFileSync(CONFIG, 'utf8');
const rpc = fs.readFileSync(RPC, 'utf8');
const view = fs.readFileSync(VIEW, 'utf8');

/* ---------- 1. 规则位置（核心不变量） ---------- */

/*
 * ★ 这一条是本文件存在的首要理由。nat 链只过首包，挂那里等于没做；
 *   filter hook postrouting 每包都过。真机 counter 实测：0 vs 4。
 */
ok('★ 规则挂在 filter hook postrouting（每包路径），不是 nat 链',
	/type filter hook postrouting priority mangle/.test(uc));
ok('★ 反向：不得再往 srcnat（type nat）里加 TTL 规则',
	!/nft add rule inet fw4 srcnat/.test(uc),
	'规则若回到 nat 链，只对每个连接的首包生效');
ok('链名是独占的 mt5700_ttl（不与他人共用 postrouting 链名）',
	/TTL_CHAIN\s*=\s*'mt5700_ttl'/.test(uc));

/* ---------- 2. 匹配范围与协议 ---------- */

ok('规则限定 iifname（只改 LAN 转发出去的包，不动路由器自身发出的）',
	/iifname "/.test(uc) && /ttlLanIf\(\)/.test(uc));
ok('同时处理 IPv4 TTL 与 IPv6 hoplimit',
	/ip ttl set /.test(uc) && /ip6 hoplimit set /.test(uc));
ok('LAN 接口名走 safeNetDevice 白名单（会拼进命令行）',
	/return safeNetDevice\(dev\)/.test(uc));
ok('拿不到合法接口名时回落成不限定（宁可达也不拼错）',
	/pre = \(lan != null\)/.test(uc));

/* ---------- 3. 取值校验 ---------- */

/*
 * ★ int('abc') 在 ucode 里返回 NaN 而不是 null —— NaN == null 为假、
 *   NaN < 1 与 NaN > 255 也都为假，三道范围判断会全部穿过，最终把 NaN 写进
 *   UCI（'' + NaN = "NaN"），而那个值每次防火墙重载都会被拼进 nft 命令。
 *   所以必须先用正则把"像不像数字"卡死。
 */
ok('★ 取值先用正则卡死再 int()（int 对非数字返回 NaN，范围判断挡不住）',
	/if \(match\(s, \/\^\[0-9\]\{1,3\}\$\/\) == null\) \{ return null; \}/.test(uc));
ok('★ 取值再判 type(n) == int（NaN 的类型不是 int）',
	/if \(type\(n\) != 'int'\) \{ return null; \}/.test(uc));
ok('取值范围 1-255（TTL_MIN / TTL_MAX）',
	/TTL_MIN = 1/.test(uc) && /TTL_MAX = 255/.test(uc));
ok('★ 反向：把正则那道去掉必须判红',
	!(function () {
		const broken = uc.replace(
			/if \(match\(s, \/\^\[0-9\]\{1,3\}\$\/\) == null\) \{ return null; \}/,
			'');
		return /if \(match\(s, \/\^\[0-9\]\{1,3\}\$\/\) == null\) \{ return null; \}/.test(broken);
	})());
ok('enabled 只接受 0 / 1',
	/if \(rawEnabled == '1' \|\| rawEnabled == 1\) \{ en = 1; \}/.test(uc)
	&& /else if \(rawEnabled == '0' \|\| rawEnabled == 0\) \{ en = 0; \}/.test(uc));

/* ---------- 4. 生命周期：关闭必须真的删掉 ---------- */

ok('关闭时 flush + delete 链（不是"下次重载不再添加"）',
	/nft flush chain inet fw4 ' \+ TTL_CHAIN/.test(uc)
	&& /nft delete chain inet fw4 ' \+ TTL_CHAIN/.test(uc));
ok('★ 反向：关闭分支里必须出现在 enabled 判断之前（否则关不掉）',
	(function () {
		const i = uc.indexOf('function ttlApplyNow');
		const j = uc.indexOf('\n}', i);
		const body = uc.slice(i, j);
		const offIdx = body.indexOf('if (!enabled)');
		const addIdx = body.indexOf('nft add chain');
		return offIdx >= 0 && addIdx > offIdx;
	})());

/* ---------- 5. 持久化 ---------- */

ok('规则同时写文件（持久）与立即应用（不等重载）',
	/ttlWriteNft\(value, en == 1\)/.test(uc) && /ttlApplyNow\(value, en == 1\)/.test(uc));
ok('★ 落盘走 .tmp + rename（半截文件会让整次防火墙重载失败）',
	/fs.writefile\(tmp, ttlNftBody/.test(uc) && /fs.rename\(tmp, TTL_NFT_FILE\)/.test(uc));
ok('关闭时保留文件、只写注释（避免 fw4 每次重载报 unreachable path）',
	/当前已关闭：刻意保留空规则/.test(uc));
ok('★ 反向：落盘不得直接覆盖目标文件',
	!/fs.writefile\(TTL_NFT_FILE,/.test(uc));

/* ---------- 6. 安装登记 ---------- */

/*
 * ★ fw4 的 include 只认 type='nftables'。script 类型在 fw4 下不会被执行
 *   （那是 fw3 时代的能力）—— 踩过一次：写成 firewall.d 脚本 + type=script，
 *   reload 后规则数是 0，而 uci show 一切正常。
 */
ok('★ 登记 type=nftables（script 类型在 fw4 下不执行）',
	/uci set firewall\.mt5700_ttl\.type='nftables'/.test(defaults));
ok('★ 反向：不得退回 script 类型',
	!/mt5700_ttl\.type='script'/.test(defaults));
ok('不写 family / reload（对 include 是 UNSUPPORTED，写了只会误导后来的人）',
	!/mt5700_ttl\.family=/.test(defaults) && !/mt5700_ttl\.reload=/.test(defaults));
ok('预生成空规则文件（否则 fw4 报 unreachable path）',
	/mkdir -p \/etc\/mt5700/.test(defaults) && /ttl\.nft/.test(defaults));

/* ---------- 7. 配置默认值与 offload 纪律 ---------- */

ok('默认关闭（不擅自动用户的网络）', /option ttl_enabled '0'/.test(config));
ok('默认值 128', /option ttl_value '128'/.test(config));
/*
 * ★ offload 开着时规则不生效。QModem 的做法是直接 uci set 关掉并重启防火墙，
 *   那会立刻打断所有连接。这里只**报告**状态，由用户决定。
 */
ok('★ offload 只读不写（不擅自改用户的防火墙配置）',
	/flow_offloading/.test(uc) && !/flow_offloading.*=.*'0'/.test(uc));
ok('后端把 offload 状态返回给前端', /offload_on: ttlOffloadOn\(\)/.test(uc));
ok('前端在 offload 开启时给出警告', /offload_on/.test(view) && /流量分载/.test(view));

/* ---------- 8. 链路完整性 ---------- */

ok('ACL 授权 ttl（read 与 write 两处）',
	(acl.split('"ttl"').length - 1) >= 2);
ok('rpc.js 声明 mt5700.ttl 通道', /method: 'ttl'/.test(rpc) && /params: \['action', 'enabled', 'value'\]/.test(rpc));
ok('rpc.js 暴露 AtWs.ttl', /ttl: function \(opts\)/.test(rpc));
ok('前端卡片调用 AtWs.ttl（get 与 set 都有）',
	/AtWs\.ttl\(\{ action: 'get' \}\)/.test(view) && /AtWs\.ttl\(\{ action: 'set'/.test(view));

/* ---------- 9. UI：状态必须区分"配置"与"实际" ---------- */

ok('★ 界面区分「已生效 / 配置开启但未生效」两种状态',
	/配置已开启，但规则没有生效/.test(view) && /已生效：实际 TTL/.test(view));
ok('前端输入校验与后端同口径（1-255 整数）',
	/\[0-9\]\{1,3\}/.test(view) && /Number\(val\) < 1 \|\| Number\(val\) > 255/.test(view));

/* ---------- 结果 ---------- */

console.log('TTL 契约测试：' + pass + ' 通过, ' + fails + ' 失败');
if (fails) process.exit(1);
