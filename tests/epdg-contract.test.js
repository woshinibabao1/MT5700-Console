#!/usr/bin/env node
/*
 * ePDG 探测 / VoWiFi 可行性契约测试（无需真机，纯 Node 跑）
 * ---------------------------------------------------------------------------
 * 2026-09-24：VoWiFi 的第一道门是「运营商在公网发布 ePDG 了吗」。
 *
 * 为什么必须单独一个测试文件：
 *   这条判定跨三个文件（ucode 新方法 / ACL / rpc 声明 / 前端文案），而且它的
 *   **结论形态是负面的** —— 绝大多数卡会拿到「运营商没发布」。这种结论最容易被
 *   写歪：查不到就说没发布，等于把「本机 DNS 坏了」也算到运营商头上。
 *   所以这里守的不是「功能在不在」，而是**判据有没有被绕开**。
 *
 * 本测试覆盖：
 *   ① ucode epdg：args 为空（无用户输入面）、域名由常量拼、拼前过 safeEpdgFqdn
 *   ② ★ 阳性对照门禁：阳性对照都查不到时，verdict 必须是 unknown，
 *      不许落「该运营商未发布」（这是本功能最容易写歪的一处）
 *   ③ 四态判定：available / polluted / not_published / unknown 各自成立，
 *      且「读不出来」不许并进「没有」（红线 23）
 *   ④ AT+CIMI 必须走 fresh：它在 STATIC_READS 里缓存 300s，换卡后不 fresh
 *      会拿上一张卡的 IMSI 拼出上一张卡的域名（红线 24 同型事故）
 *   ⑤ ACL 两段放行 epdg / rpc.js 声明并暴露 AtWs.epdg / 前端四态文案齐全
 *   ⑥ 真机取值回归（2026-09-24 实测，中国移动卡 + 三组对照）
 *
 * 运行：node tests/epdg-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const UCODE = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'ucode', 'mt5700.uc');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');
const RPC = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver', 'rpc.js');
const VIEW = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'network_status.js');

const ucSrc = fs.readFileSync(UCODE, 'utf8');
const aclSrc = fs.readFileSync(ACL, 'utf8');
const rpcSrc = fs.readFileSync(RPC, 'utf8');
const viewSrc = fs.readFileSync(VIEW, 'utf8');

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return true; }
	fails.push('  ✗ ' + name + (hint ? '\n      ' + hint : ''));
	return false;
}
function eq(name, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return true; }
	fails.push('  ✗ ' + name + '\n      实际: ' + g + '\n      期望: ' + w);
	return false;
}

/* 按括号配对抠出整个函数（改名请同步本测试） */
function grab(name, src) {
	const i = src.indexOf('function ' + name + '(');
	if (i < 0) throw new Error('源码里找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, started = false;
	for (let j = i; j < src.length; j++) {
		const c = src[j];
		if (c === '{') { depth++; started = true; }
		else if (c === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
	}
	throw new Error('函数体括号不配对：' + name);
}

/* ucode 与 JS 在这几个函数上语法一致（length()/substr() 是注入的），直接 eval 跑真逻辑。
   常量从源码里抠出来一起注入 —— 断言的是**源码里那个真实值**，不是这里另抄一份。 */
const L = (x) => x.length;
const S = (s, a, b) => s.substr(a, b);
const EPDG_PREFIX = (ucSrc.match(/const EPDG_PREFIX = '([^']+)';/) || [])[1];
const EPDG_SUFFIX = (ucSrc.match(/const EPDG_SUFFIX = '([^']+)';/) || [])[1];
ok('能从源码抠出 EPDG_PREFIX / EPDG_SUFFIX（改名请同步本测试）',
	EPDG_PREFIX === 'epdg.epc.' && EPDG_SUFFIX === '.pub.3gppnetwork.org');
/* ucode 的 length()/substr()/trim()/index() 都是内置，这里注入同义实现即可
   （index(h, n) ≡ JS 的 h.indexOf(n)） */
const T = (s) => String(s).trim();
const IX = (h, n) => String(h).indexOf(n);
function ucFn(names, entry) {
	const bodies = names.map((n) => grab(n, ucSrc)).join('\n');
	// eslint-disable-next-line no-new-func
	return new Function('length', 'substr', 'trim', 'index', 'EPDG_PREFIX', 'EPDG_SUFFIX',
		bodies + '\n; return ' + entry + ';');
}

/* ---------- 1. ucode：注入面必须封死 ---------- */

ok('ucode 注册了 mt5700.epdg', /\bepdg: \{/.test(ucSrc));
ok('★ epdg 不接受任何入参（args 为空 → 没有命令注入面）',
	/epdg: \{\s*\n\s*args: \{\},/.test(ucSrc));
ok('★ ePDG 域名由前缀/后缀常量拼装（不是 req 里的字符串）',
	/const EPDG_PREFIX = 'epdg\.epc\.';/.test(ucSrc)
	&& /const EPDG_SUFFIX = '\.pub\.3gppnetwork\.org';/.test(ucSrc));
ok('★ DNS 服务器写死在常量里（不接受外部传入）',
	/const EPDG_DNS = \['223\.5\.5\.5', '114\.114\.114\.114'\];/.test(ucSrc));
/*
 * ★ 阳性对照why换成 AT&T（mnc280.mcc310）：原先用 T-Mobile（mnc260），但那是
 *   「听说它开了 VoWiFi」；AT&T 是**本机实测过**的 —— 2026-09-24 经 DoH 解析出
 *   真实公网地址 107.122.31.31。对照组的意义是「证明这条链路能查到真东西」，
 *   没实测过的对照组证明不了任何事。
 */
ok('★ 对照组域名是常量（阳性对照不能被请求带偏）',
	/const EPDG_POS_FQDN = 'epdg\.epc\.mnc280\.mcc310\.pub\.3gppnetwork\.org';/.test(ucSrc));

/* safeEpdgFqdn：拼进 shell 前的最后一道闸 */
const safeFqdn = ucFn(['safeEpdgFqdn'], 'safeEpdgFqdn');
ok('safeEpdgFqdn 放行标准 ePDG 域名',
	safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('epdg.epc.mnc000.mcc460.pub.3gppnetwork.org')
	=== 'epdg.epc.mnc000.mcc460.pub.3gppnetwork.org');
ok('★ safeEpdgFqdn 拒绝命令注入（分号 + 空格 + 反引号一律挡掉）',
	safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('epdg.epc.mnc000.mcc460.pub.3gppnetwork.org; rm -rf /') === null);
ok('★ safeEpdgFqdn 拒绝不是 ePDG 形状的其他域名',
	safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('www.baidu.com') === null);
ok('★ safeEpdgFqdn 拒绝空串与超短串', safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('') === null && safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('epdg') === null);
/*
 * ★★ 下面两条是**专为穿过长度检查**设计的：长度必须落在 32~80 之间，
 *   否则会被 length 那一关先挡下 —— 前缀/后缀的形状校验就算被改坏也测不出来。
 *   2026-09-24 变异验证时这条真被放过过一次：当时只有 www.baidu.com 这种短串，
 *   去掉前缀校验后它仍被 length 挡住，变异判不出来（红线 16：写了守卫 ≠ 有了守卫）。
 */
ok('★★ 前缀不对但长度合规的域名也要挡',
	safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('www.baidu.com.evil.example.pub.3gppnetwork.org') === null);
ok('★★ 后缀不对但长度合规的域名也要挡',
	safeFqdn(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('epdg.epc.mnc000.mcc460.attacker.example.com') === null);

/* ---------- 1b. nslookup 输出解析（★ 真机格式回归） ----------
 *
 * 2026-09-24 真机踩坑：busybox nslookup 的开头两行是
 *     Server:\t223.5.5.5
 *     Address:\t223.5.5.5:53        ← 带端口
 * 它是**输入**不是结果，而且 "223.5.5.5:53" 与传入的 dns 常量并不相等 ——
 * 用「值 != dns」过滤根本滤不掉。上线第一版就栽在这里：必然不存在的 mnc999
 * 也「解析到了地址」，总判定恒为 available，最关键的结论被反过来说。
 *
 * 所以下面三条断言用的都是**真机抓下来的输出格式**，不是想象的格式。
 */
const pick = ucFn(['nsPickAddrs'], 'nsPickAddrs');
const NS_SRV = ['Server:\t223.5.5.5', 'Address:\t223.5.5.5:53'];
eq('★★ NXDOMAIN 输出（真机格式）一个地址都不产生',
	pick(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)(
		NS_SRV.concat(['', "** server can't find epdg.epc.mnc000.mcc460.pub.3gppnetwork.org: NXDOMAIN"]),
		'223.5.5.5'), []);
eq('★★ 阳性对照（真机格式）：Server 段被排除，只留真正的 A 记录',
	pick(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)(
		NS_SRV.concat(['', 'Name:\tepdg.epc.mnc260.mcc310.pub.3gppnetwork.org',
			'Address 1: 208.54.5.195']),
		'223.5.5.5'), ['208.54.5.195']);
eq('★★ 阴性对照（真机格式）：只回 127.0.0.1 —— 通配污染的原貌',
	pick(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)(
		NS_SRV.concat(['', 'Name:\tepdg.epc.mnc999.mcc460.pub.3gppnetwork.org',
			'Address 1: 127.0.0.1']),
		'223.5.5.5'), ['127.0.0.1']);

/* ---------- 2. 四态判定（可执行，用真机实测值回归） ---------- */

const epdgState = ucFn(['isLoopbackAddr', 'epdgState'], 'epdgState');

/* 2026-09-24 真机：中国移动卡（IMSI 460009711127691） */
eq('真机回归：本卡 ePDG 查不到 → not_published',
	epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)({ addrs: [], nx: true, cname: '' }), 'not_published');
eq('真机回归：阳性对照 T-Mobile 解析到 208.54.39.163 → available',
	epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)({ addrs: ['208.54.39.163'], nx: false, cname: '' }), 'available');
eq('真机回归：阴性对照 mnc999 只回 127.0.0.1 → polluted（不是真 ePDG）',
	epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)({ addrs: ['127.0.0.1'], nx: false, cname: '' }), 'polluted');
eq('★ 读不出来必须独立成 unknown，不许并进「没有」',
	epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)({ addrs: [], nx: false, cname: '' }), 'unknown');
eq('★ 探针本身没跑起来（null）也是 unknown', epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)(null), 'unknown');
eq('IPv6 环回 ::1 同样判污染',
	epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)({ addrs: ['::1'], nx: false, cname: '' }), 'polluted');
eq('★ 真地址与环回地址混合时，按「有真地址」判 available（不因混入假地址降级）',
	epdgState(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)({ addrs: ['127.0.0.1', '182.239.118.1'], nx: false, cname: '' }), 'available');

const isLoop = ucFn(['isLoopbackAddr'], 'isLoopbackAddr');
ok('isLoopbackAddr 认 127.x', isLoop(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('127.0.0.1') === true);
ok('isLoopbackAddr 认 ::1', isLoop(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('::1') === true);
ok('★ isLoopbackAddr 不误杀 182.239.118.1（真机 CSL ePDG）', isLoop(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('182.239.118.1') === false);

/* IMSI 提取：AT 应答里夹着 \r\nOK，只取第一段够长的数字串 */
const exImsi = ucFn(['extractImsi'], 'extractImsi');
eq('extractImsi 从「460009711127691\\r\\nOK」里取出 IMSI',
	exImsi(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('460009711127691\r\nOK'), '460009711127691');
eq('★ extractImsi 遇到没有 IMSI 的应答返回空串（不许返回 OK 里的杂数）',
	exImsi(L, S, T, IX, EPDG_PREFIX, EPDG_SUFFIX)('ERROR'), '');

/* ---------- 3. ★★ 阳性对照门禁（本功能最关键的一条判据） ---------- */

const factsBody = grab('epdgFacts', ucSrc);
ok('★★ 阳性对照查不到时，verdict 必须退回 unknown（不许把 DNS 故障说成运营商没发布）',
	/posCtl\.state != 'available'[\s\S]{0,200}?verdict = 'unknown';/.test(factsBody),
	'找不到「阳性对照失败 → verdict=unknown」的分支');
ok('★ 阳性对照必须真的参与判定（不能只是查了不看的装饰）',
	/let posCtl = epdgProbe\(safeEpdgFqdn\(EPDG_POS_FQDN\)\);/.test(factsBody));
ok('★ 阳性对照组也要查一次（不是写死结论）',
	/posCtl: posCtl,/.test(factsBody));
ok('★ 阴性对照组（mnc999）也要查并返回（用来识别通配污染）',
	/negCtl = epdgProbe\(negFqdn\);/.test(factsBody) && /negCtl: negCtl,/.test(factsBody));

/* ---------- 4. AT+CIMI 必须 fresh（换卡后不能拿旧 IMSI） ---------- */

ok('★★ AT+CIMI 走 fresh（否则换卡后 300s 内拼出上一张卡的 ePDG 域名）',
	/rpcCall\('at', \{ cmd: 'AT\+CIMI', fresh: true \}\)/.test(ucSrc),
	'STATIC_READS 里 AT+CIMI 缓存 300 秒，不 fresh 就是红线 24 的同型事故');
ok('★ 读不到 IMSI 要明确报失败（不许拿空值继续拼域名）',
	/读不到 IMSI（AT\+CIMI 失败）/.test(factsBody) && /AT\+CIMI 的应答里没有 IMSI/.test(factsBody));

/* ---------- 5. MNC 长度不猜：两种解读都查 ---------- */

/*
 * ★ MNC 长度**不猜**（参考 VoCat：orchestrator 不猜 MNC 长度）。
 *   猜错会拼出一个必然 NXDOMAIN 的域名 —— 那等于把「我拼错了」报成「运营商没发布」。
 *   正确做法：问卡（EF_AD），问不出来退 EHPLMN，再问不出来才两种都查且如实标注。
 */
ok('★ MNC 长度先问卡（EF_AD），不是从 IMSI 猜',
	/let mncLen = readMncLength\(\);/.test(factsBody)
	&& /mncSource = 'ef_ad';/.test(factsBody));
ok('★ 卡上读不到 MNC 长度时退 EHPLMN，仍读不到才标 ambiguous 并两种都查',
	/mncSource = 'ehplmn';/.test(factsBody)
	&& /mncSource = 'ambiguous';/.test(factsBody)
	&& /let m2 = substr\(imsi, 3, 2\);/.test(factsBody)
	&& /let m3 = substr\(imsi, 3, 3\);/.test(factsBody));
ok('★ 3GPP 标准写法（MNC 补零到三位）与两位变体都要构造（参考 alternate3GPPHostname）',
	/r\.label = '标准写法（mnc' \+ m3 \+ '）';/.test(factsBody)
	&& /r\.label = '两位变体（mnc' \+ substr\(m3, 1\) \+ '）';/.test(factsBody));

/* ---------- 5b. DoH 地理回退（参考 VoCat resolveEPDG） ---------- */

const probeBody = grab('epdgProbe', ucSrc);
ok('★★ 系统 DNS 没给出 available 时，要换 DoH 再问一次（单条链路的结论可能正好说反）',
	/let d = dohLookup\(fqdn, EPDG_ECS\);/.test(probeBody));
ok('★ DoH 要带归属国的 EDNS Client Subnet（ePDG 权威 DNS 常只对归属国解析器给答案）',
	/edns_client_subnet=/.test(ucSrc) && /const EPDG_ECS = '223\.5\.5\.0\/24';/.test(ucSrc));
ok('★ DoH 端点写成常量（不接受外部传入）',
	/const EPDG_DOH = 'https:\/\/dns\.alidns\.com\/resolve';/.test(ucSrc));
ok('★ 只有 DoH 给出**更确定**的结论才覆盖系统 DNS（unknown 不覆盖）',
	/if \(r\.doh\.state == 'unknown'\) \{\s*\n\s*return r;/.test(probeBody));
ok('★ DoH 的结论要单独留在 r.doh 上（两条路各说了什么必须都能看见，否则判不了污染）',
	/r\.doh = \{ addrs: d\.addrs, nx: d\.nx, status: d\.status, state: epdgState\(d\) \};/.test(probeBody));
ok('★ 系统 DNS 已经说 available 就不再查 DoH（省一次往返）',
	/if \(r\.state == 'available'\) \{\s*\n\s*return r;/.test(probeBody));
/*
 * ★ 防回归：曾经 epdgResolve 与 epdgProbe **各查一次 DoH** —— 同一个域名被问两遍，
 *   耗时翻倍，而且两层各自覆盖 state，最后采用哪个取决于调用顺序。
 *   分工必须是：epdgResolve 只管系统 DNS，换链路只在 epdgProbe 里做一次。
 */
ok('★ epdgResolve 只走系统 DNS（DoH 全仓只在 epdgProbe 里查一次）',
	!/dohLookup/.test(grab('epdgResolve', ucSrc)),
	'epdgResolve 里又出现了 dohLookup —— 同一个域名会被查两遍');

/* ---------- 5c. 身份链与 AKA 证据（参考 VoCat SIMIdentity / AKAEvidence） ---------- */

ok('★ MNC 长度用 AT+CRSM 读 EF_AD（卡说了算，不从 IMSI 猜）',
	/'AT\+CRSM=176,' \+ EF_AD_ID \+ ',0,0,4'/.test(ucSrc));
ok('★ CRSM 只在成功状态字下才认数据（错误应答里的内容不许当成 EF 内容）',
	/crsmOk\(/.test(ucSrc) && /crsmHex\(/.test(ucSrc));
ok('★ ICCID 与 IMSI 同一次 fresh 取（换卡后不许新 IMSI 配旧 ICCID）',
	/let iccid = readIccid\(\);/.test(factsBody));
const aidBody = grab('uiccAkaAid', ucSrc);
ok('★★ AKA 应用的 AID 从 STATUS 的 FCI 里解（tag 84），函数体内不发 AT+CCHO',
	/AT\+CRSM=242/.test(aidBody) && !/AT\+CCHO/.test(aidBody),
	'逐个 AID 去试＝盲扫未定义对象，会把 AT 通道搞死');
/*
 * ★★ 反向守卫（真机事故，2026-09-24 本机）：
 *   用 AT+CCHO 开逻辑通道做「能不能鉴权」验证，连开两次之后 CCHO 一律
 *   `+CME ERROR: missing resource`，且 AT+CCHC 对已开的 session 一律回
 *   `+CME ERROR: SIM failure` —— **通道占上就无法回收**，只能重启模组。
 *   euicc.js 里也早就记着同一条（「永远不用 CCHO，固定 sessionid=0」）。
 *   页面可以被反复点、可以被强杀，每次点击都占一份不可回收的卡资源是不可接受的。
 *   → AKA 就绪只用卡自己上报的 FCI/AID 作证据，**一条 CCHO 都不许发**。
 */
ok('★★ ePDG/VoWiFi 探测全程不许发 AT+CCHO（逻辑通道占上后不可回收）',
	!/AT\+CCHO/.test(factsBody) && !/'AT\+CCHO/.test(ucSrc));
ok('★★ AKA 证据等级要如实区分（fci = 卡上报的 AID，不是开过通道）',
	/verified: 'fci'/.test(ucSrc) && /verified: 'none'/.test(ucSrc));
/*
 * ★ 判定：canonical（EF_AD 定长推出的标准写法）结论优先。
 *   真机：mnc000 明确 NXDOMAIN，两位变体 mnc00 返回 127.0.0.1 —— 后者跟
 *   「必然不存在的 mnc999」同值，是污染不是证据。不这么判就会被污染项
 *   把「运营商明确没发布」搅成「无法判定」。
 */
ok('★★ 权威域名说 NXDOMAIN 时，被污染的变体不许把结论搅成 unknown',
	/canon != null && canon\.state == 'not_published'/.test(factsBody)
	&& /verdict = 'not_published';/.test(factsBody));
ok('★ 阶段链四段齐全且各自独立报（sim / aka / epdg / ims）',
	/key: 'sim'/.test(factsBody) && /key: 'aka'/.test(factsBody)
	&& /key: 'epdg'/.test(factsBody) && /key: 'ims'/.test(factsBody));
ok('★ IMS 是否注册只看 AT+CIREG 实测（不认「功能开关是开的」）',
	/'AT\+CIREG\?'/.test(ucSrc) && /stat: imsStat/.test(factsBody));

/* ---------- 6. ACL / rpc / 前端 ---------- */

const aclJson = JSON.parse(aclSrc);
let aclHits = 0;
function walk(o) {
	if (o == null || typeof o !== 'object') return;
	if (Array.isArray(o)) {
		if (o.indexOf('epdg') >= 0) aclHits++;
		o.forEach(walk);
		return;
	}
	for (const k in o) walk(o[k]);
}
walk(aclJson);
ok('★ ACL 两段都放行 epdg（漏一处就是 rpcd Access denied，页面静默失败）',
	aclHits >= 2, '实际命中段数: ' + aclHits);

ok('rpc.js 声明了 mt5700.epdg',
	/method: 'epdg'/.test(rpcSrc) && /var rpcEpdg = L\.rpc\.declare\(\{/.test(rpcSrc));
ok('★ rpc 声明不带 params（域名由后端拼，前端不传任何东西进去）',
	/var rpcEpdg = L\.rpc\.declare\(\{[\s\S]{0,200}?params: \[\]/.test(rpcSrc));
ok('rpc.js 暴露了 AtWs.epdg', /\bepdg: fetchEpdg,/.test(rpcSrc));

/* 前端：四态文案必须齐全，缺一种就会显示 undefined */
const stateMap = viewSrc.slice(viewSrc.indexOf('var EPDG_STATE = {'), viewSrc.indexOf('var EPDG_VERDICT = {'));
ok('前端 EPDG_STATE 四态齐全（available/polluted/not_published/unknown）',
	/available:/.test(stateMap) && /polluted:/.test(stateMap)
	&& /not_published:/.test(stateMap) && /unknown:/.test(stateMap));
ok('前端总判定 EPDG_VERDICT 四态齐全',
	/var EPDG_VERDICT = \{[\s\S]{0,400}?unknown: '无法判定'/.test(viewSrc));
ok('★ 探测是手动触发（不在页面加载时偷偷联网）',
	/Mt5700\.ghostButton\(t\.busy \? '探测中…' : '探测 ePDG', runEpdg\)/.test(viewSrc));
ok('★ 后端没升级时前端要明确提示（不能静默什么都不出）',
	/后端未升级：rpcd 没有 mt5700\.epdg 方法/.test(viewSrc));
ok('★ 探测中重复点击要挡住（并发探测会占满 rpcd 工作线程）',
	/function runEpdg\(\) \{\s*\n\s*var t = state\.tools\.epdg;\s*\n\s*if \(t\.busy\) return;/.test(viewSrc));
ok('★ 页面已卸载就不再重绘（避免已发起的链回来时操作已销毁的 DOM）',
	/if \(!disposed\) renderVowifi\(\);/.test(viewSrc));

/* ---------- 汇总 ---------- */

console.log('ePDG / VoWiFi 契约测试：' + pass + ' 项通过，' + fails.length + ' 项失败');
if (fails.length) {
	console.log(fails.join('\n'));
	process.exit(1);
}
