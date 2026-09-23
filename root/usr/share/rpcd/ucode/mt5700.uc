'use strict';
/*
 * rpcd ucode 插件：mt5700。
 * OpenWrt ucode 语法：无 ===/模板字符串；无 require('json')，
 * 序列化用 sprintf('%J')，反序列化用内置迷你解析器。
 * 参数在 req.args 上（不是 req 顶层）。
 */

const fs = require('fs');
const uci = require('uci');

function readRpcConfig() {
	const cursor = uci.cursor();
	const port = int(cursor.get('at-webserver', 'config', 'websocket_port')) || 8765;
	const authKey = cursor.get('at-webserver', 'config', 'websocket_auth_key') || '';
	return { port: port, authKey: authKey };
}

function getStr(obj, key) {
	if (obj == null) {
		return null;
	}
	let v = obj[key];
	if (v == null) {
		return null;
	}
	return v;
}

/* 迷你 JSON 解析：ucode 无 s[i]、嵌套函数不提升，用 substr + 前置声明 */
function jsonParse(s) {
	let i = 0;
	let n = length(s);
	let parseVal;

	function ch() {
		if (i >= n) {
			return '';
		}
		return substr(s, i, 1);
	}

	function ws() {
		while (i < n) {
			let c = ch();
			if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
				i++;
			} else {
				break;
			}
		}
	}

	function parseStr() {
		i++;
		let out = '';
		while (i < n) {
			let c = ch();
			if (c == '\\') {
				i++;
				let e = ch();
				if (e == 'n') { out += '\n'; }
				else if (e == 't') { out += '\t'; }
				else if (e == 'r') { out += '\r'; }
				else if (e == '"') { out += '"'; }
				else if (e == '\\') { out += '\\'; }
				else if (e == '/') { out += '/'; }
				else { out += e; }
				i++;
			} else if (c == '"') {
				i++;
				return out;
			} else {
				out += c;
				i++;
			}
		}
		return out;
	}

	function parseNum() {
		let start = i;
		if (ch() == '-') { i++; }
		while (i < n) {
			let c = ch();
			if ((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
				i++;
			} else {
				break;
			}
		}
		return int(substr(s, start, i - start));
	}

	function parseArr() {
		i++;
		let arr = [];
		ws();
		if (ch() == ']') { i++; return arr; }
		while (i < n) {
			// 本固件 ucode 的数组没有 push 方法（调用会抛
			// "left-hand side is not a function"），只能按下标追加。
			arr[length(arr)] = parseVal();
			ws();
			if (ch() == ',') { i++; ws(); continue; }
			if (ch() == ']') { i++; break; }
			break;
		}
		return arr;
	}

	function parseObj() {
		i++;
		let obj = {};
		ws();
		if (ch() == '}') { i++; return obj; }
		while (i < n) {
			ws();
			if (ch() != '"') { break; }
			let k = parseStr();
			ws();
			if (ch() == ':') { i++; }
			let v = parseVal();
			obj[k] = v;
			ws();
			if (ch() == ',') { i++; continue; }
			if (ch() == '}') { i++; break; }
			break;
		}
		return obj;
	}

	parseVal = function () {
		ws();
		let c = ch();
		if (c == '{') { return parseObj(); }
		if (c == '[') { return parseArr(); }
		if (c == '"') { return parseStr(); }
		if (c == 't') { i += 4; return true; }
		if (c == 'f') { i += 5; return false; }
		if (c == 'n') { i += 4; return null; }
		return parseNum();
	};

	return parseVal();
}

/*
 * 解析承载 5G 流量的网络设备名。
 * 优先 UCI network.MT5700M.device，其次 ifname，都拿不到才退回 eth2。
 * 不硬编码单一设备名，避免不同机型/接口命名下取不到计数。
 */
function detectModemDevice() {
	let dev = null;
	try {
		const cursor = uci.cursor();
		dev = cursor.get('network', 'MT5700M', 'device');
		if (dev == null || dev == '') {
			dev = cursor.get('network', 'MT5700M', 'ifname');
		}
	} catch (e) {
		dev = null;
	}
	if (dev == null || dev == '') {
		dev = 'eth2';
	}
	return dev;
}

/*
 * 接口名白名单：只认 [A-Za-z0-9._-]，其余一律拒绝。
 *
 * device 可以直接从 RPC 参数传进来，而它会被拼进
 * `/sys/class/net/<dev>/statistics/rx_bytes`。rpcd 不做路径规范化，不过滤的话
 * 传一个带斜杠的名字就能把 ucode 的 fs.open 指到任意文件上 —— ucode 是以 root
 * 跑的，泄漏面取决于那个文件首行能不能被 int() 解析，但目录遍历本身就不该存在。
 *
 * 真实接口名全都落在这个集合里（eth2 / wwan0 / eth2.100），限制不会误伤。
 * 另外挡掉 "." / ".." 这类纯点名，避免拼出 /sys/class/net/.. 这种路径。
 */
function safeNetDevice(dev) {
	if (dev == null || dev == '') {
		return null;
	}
	if (length(dev) > 32) {
		return null;
	}
	let alnum = false;
	for (let i = 0; i < length(dev); i++) {
		let c = substr(dev, i, 1);
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			alnum = true;
		} else if (c != '.' && c != '_' && c != '-') {
			return null;
		}
	}
	if (!alnum) {
		return null;
	}
	return dev;
}

/* 读取单个字节计数器；失败返回 null（不做静默补 0，避免算出假速率） */
function readCounter(path) {
	let f;
	try {
		f = fs.open(path, 'r');
	} catch (e) {
		return null;
	}
	if (!f) {
		return null;
	}
	let s = f.read('line');
	f.close();
	if (s == null) {
		return null;
	}
	let v = int(s);
	if (v == null) {
		return null;
	}
	return v;
}

/*
 * 取网络接口累计字节数。
 * 实时速率由前端按「两次采样差 / 时间差」计算，这里只返回原始计数与本机时钟，
 * 由前端统一时间基准，规避 rpcd 与浏览器时钟不同源的抖动。
 *
 * 关键：全程不向模组下发任何 AT 命令，避免占用 AT 通道、干扰模组工作。
 */
function netrateCall(req) {
	let a = req.args;
	let dev = getStr(a, 'device');
	if (dev == null || dev == '') {
		dev = detectModemDevice();
	}
	dev = safeNetDevice(dev);
	if (dev == null) {
		return { success: false, error: '接口名不合法' };
	}

	const base = '/sys/class/net/' + dev;
	const rx = readCounter(base + '/statistics/rx_bytes');
	const tx = readCounter(base + '/statistics/tx_bytes');

	if (rx == null && tx == null) {
		return { success: false, device: dev, error: '读不到接口计数器，设备可能不存在或未 up' };
	}

	return {
		success: true,
		device: dev,
		rx_bytes: rx == null ? 0 : rx,
		tx_bytes: tx == null ? 0 : tx
	};
}

/*
 * 每次调用生成独立的临时文件名。
 *
 * 原来固定叫 /tmp/mt5700-rpc.json。LuCI 上多张卡片并行刷新是常态（状态页、邻区、
 * 载波各刷各的），两个请求会在极短的时间窗里先后写同一个文件：后写的那个会
 * 在前一个的 nc 读到之前把内容覆盖掉，于是前一个请求**实际发出去的是别人的
 * 命令**，拿回来的也是别人的应答 —— 表现为卡片偶尔显示别处的数据，且毫无报错。
 *
 * 另外这个文件里带着 auth_key（见下），固定路径等于把密钥长期明文摊在 /tmp。
 * 所以这里两件事一起做：文件名加随机后缀，且用完立刻删除。
 *
 * 后缀生成放在 try 里：万一某个固件的 ucode 没有 rand()，退回原来的固定名，
 * 行为与改动前一致，不会因为这个改动让整个 RPC 挂掉。
 */
function rpcTmpPath() {
	let suffix = '';
	try {
		suffix = '.' + sprintf('%d', time()) + '.' + sprintf('%d', rand());
	} catch (e) {
		suffix = '';
	}
	return '/tmp/mt5700-rpc' + suffix + '.json';
}

/* 所有退出路径都要删，早退分支也不能落下 */
function rpcTmpUnlink(path) {
	try { fs.unlink(path); } catch (e) { }
}

function rpcCall(method, params) {
	const rpcCfg = readRpcConfig();
	const port = rpcCfg.port;
	const authKey = rpcCfg.authKey;

	const payload = { id: 1, method: method, params: params };
	if (authKey != '') {
		payload.params.auth_key = authKey;
	}

	/* 本固件 ucode fs 无 connect，经 busybox nc 管道访问回环 RPC */
	const body = sprintf('%J', payload);
	const tmp = rpcTmpPath();
	let f;
	try {
		f = fs.open(tmp, 'w');
	} catch (e) {
		return { success: false, error: '无法写临时文件' };
	}
	if (!f) {
		return { success: false, error: '无法写临时文件' };
	}
	f.write(body + '\n');
	f.close();

	let p;

	/*
	 * 必须用 timeout 包住 nc。
	 *
	 * nc 连上后端、但后端迟迟不回包时会一直阻塞在读上（连接已被接受，对端既不
	 * 关闭也不发数据）。rpcd 每来一次 mt5700.* 调用就占一个 ucode 工作线程，
	 * 事件轮询每 1.5s 一发，几轮下来线程全被占住 —— 表现为「整个插件的页面
	 * 一起卡死、点什么都没反应」，而且没有任何报错可查。
	 *
	 * 注意：本固件的 busybox nc 是精简版，**不认 -w 选项**（传 -w 只会打印
	 * usage 并立刻退出，会让所有 RPC 全部失败），限时只能靠外部的 timeout。
	 *
	 * 上限取 45 秒：后端最坏耗时是有上界的 ——
	 * 普通命令 QUEUE_WAIT(8s) + WRITE(3s) + COMMAND_TIMEOUT(2s) = 13s，
	 * 短信后台任务 QUEUE_WAIT(8s) + WRITE(3s) + SMS_SEND_TIMEOUT(6s) = 17s，
	 * APDU 透传（AT+CSIM / AT+CGLA，eSIM 读写卡）QUEUE_WAIT(8s) + WRITE(3s)
	 * + APDU_TIMEOUT(12s) = 23s。
	 * 45s 留了余量：只会兜住「真的不回包」，不会把正常的慢响应掐掉。
	 *
	 * ★ 为什么必须跟着 APDU 一起放宽（2026-09-20 真机：eSIM 下载到一半中断）：
	 *   卡侧处理一段 STORE DATA 可能要几秒，后端等得起而这里等不起的话，
	 *   一次正常的慢应答会被本层掐成「Rust 后端无应答」，病因完全对不上。
	 */
	try {
		p = fs.popen('timeout 45 nc 127.0.0.1 ' + port + ' < ' + tmp, 'r');
	} catch (e) {
		rpcTmpUnlink(tmp);
		return { success: false, error: '无法连接 Rust 后端' };
	}
	if (!p) {
		rpcTmpUnlink(tmp);
		return { success: false, error: '无法连接 Rust 后端' };
	}

	let line = p.read('line');
	p.close();

	/*
	 * 立刻删掉：文件内容里含 auth_key（回环 RPC 的密钥），请求结束就不该再留在
	 * /tmp 里。文件存在的窗口只有 nc 那几十毫秒，但以前用固定文件名时会长期留着。
	 */
	rpcTmpUnlink(tmp);

	if (!line) {
		return { success: false, error: 'Rust 后端无应答（已限时 45 秒）' };
	}

	try {
		let resp = jsonParse(line);
		if (resp.error) {
			let msg = 'RPC 错误';
			if (resp.error.message) {
				msg = resp.error.message;
			}
			return { success: false, error: msg };
		}
		if (resp.result) {
			return resp.result;
		}
		return {};
	} catch (e) {
		return { success: false, error: '解析应答失败: ' + e.message };
	}
}

/*
 * ============================================================================
 * 只读缓存（保守版）
 * ----------------------------------------------------------------------------
 * 【为什么保守】FAN789/luci-app-mt5700m 的读缓存是为「每次读都起进程、开一次串口」
 * 的慢实现打的补丁（TTL 5s + 陈旧数据先返回 + 后台刷新）。我们的 AT 通道是
 * **Rust 常驻服务**：串口常开、有命令队列与并发处理，重复查询的代价远小于他们，
 * 所以不值得为省几次查询去牺牲数据新鲜度。
 *
 * 由此的取舍：
 *   · **只缓存「不变类」**（型号/固件/IMEI/ICCID/SMSC/接入模式）——这些值本来就不变，
 *     缓存零陈旧风险，收益是页面多次加载不再重复问模组；
 *   · **状态类（信号/载波/注册/温度）默认不缓存**（read_cache_ttl 默认 0），
 *     我们的后端完全扛得住实时轮询，宁可每拍都拿新的；
 *   · 任何**写命令**经过代理都清空缓存，保证「保存后读回」一定拿到新值；
 *   · Rust 后端自己维护状态的命令（扫频作业 AT^CELLSCAN、短信作业 AT^SMSJOB、
 *     FOTA 流程）**永不缓存** —— 见 NEVER_CACHE，缓存它们会返回过期的后端状态。
 *
 * UCI：read_cache_static_ttl（**默认 300**，0=关闭全部缓存）、read_cache_ttl（默认 0）。
 * ============================================================================
 */

const READ_CACHE_DIR = '/tmp/mt5700-read-cache';

/*
 * 不变类：写一次终身不变（或极少变），可安全长 TTL。
 *
 * 入选标准只有一条：**没有任何界面能改它**。可选的项一律不进 ——
 * 早先把 `AT+CSCA?`（短信中心号）和 `AT^C5GOPTION?` 也列了进来，而这两项在
 * 短信页 / 网络设置页都能改。虽然写命令会清空全部缓存兜住了大部分情况，
 * 但缓存的语义是「这项不会变」，可写的项放进来等于给自己埋雷
 * （比如从别的途径改了短信中心号，界面最多陈旧 5 分钟）。
 */
/*
 * ★ P03（2026-09-19 会审）：'AT^ICCID?' 已移出本档。
 * 入选标准只有一条 ——「没有任何界面能改它」。ICCID 在换卡 / eSIM 切换 profile 之后
 * 会变，属于可被改的标识，放进来等于给自己埋雷（换完 profile 最长陈旧 5 分钟）。
 * 前端 esim.js 早已用 { fresh: true } 绕开前端缓存，但绕不过 ucode 侧这 300 秒。
 */
const STATIC_READS = [
	'ATI', 'AT+CGMM', 'AT+CGMR', 'AT+CGSN', 'AT+CIMI', 'AT+CGMI',
	'AT^PHYNUM?', 'AT^VERSION?'
];

/* 无问号但属只读的查询（默认不启用缓存，留给 read_cache_ttl>0 时用） */
const BARE_READS = ['AT^DSFLOWQRY', 'AT^MONNC', 'AT^MONSC', 'AT^MONSSC'];

/* 后端自己维护状态：**永不缓存** */
/*
 * ★ P08（2026-09-19 会审）：第二项原写 'AT^SMSJOB'（脱字符），而真实命令是
 * 'AT+SMSJOB?'（加号 + 问号，见 rpcserver.rs:49 与 sms_center.js:476）。
 * cacheClass 用 index(cmd, ...) == 0 做前缀匹配，差一个字符就永不命中 ——
 * 一旦用户把 read_cache_ttl 调成非 0，短信作业状态就会被缓存住，与这里
 * 「后端自己维护状态的命令永不缓存」的约定完全相反。
 */
const NEVER_CACHE = ['AT^CELLSCAN', 'AT+SMSJOB', 'AT^FOTA', 'AT^FWUP', 'AT+CMG'];

function trimCmd(s) {
	let a = 0;
	let b = length(s);
	while (a < b) {
		let c = substr(s, a, 1);
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { a++; } else { break; }
	}
	while (b > a) {
		let c = substr(s, b - 1, 1);
		if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { b--; } else { break; }
	}
	return substr(s, a, b - a);
}

function cacheName(cmd) {
	let out = '';
	for (let i = 0; i < length(cmd); i++) {
		let c = substr(cmd, i, 1);
		if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) { out += c; }
		else { out += '_'; }
	}
	return substr(out, 0, 80) + '.' + length(cmd) + '.json';
}

/* 0=不缓存  1=状态类（默认关）  2=不变类 */
function cacheClass(cmd) {
	for (let i = 0; i < length(NEVER_CACHE); i++) {
		if (index(cmd, NEVER_CACHE[i]) == 0) { return 0; }
	}
	for (let i = 0; i < length(STATIC_READS); i++) {
		if (STATIC_READS[i] == cmd) { return 2; }
	}
	for (let i = 0; i < length(BARE_READS); i++) {
		if (BARE_READS[i] == cmd) { return 1; }
	}
	if (substr(cmd, length(cmd) - 1, 1) == '?' && index(cmd, '=') < 0) { return 1; }
	return 0;
}

function readCacheCfg() {
	let statik = 300;
	let volatileTtl = 0;
	try {
		const cursor = uci.cursor();
		let sv = cursor.get('at-webserver', 'config', 'read_cache_static_ttl');
		if (sv != null && sv != '') { statik = int(sv); }
		let v = cursor.get('at-webserver', 'config', 'read_cache_ttl');
		if (v != null && v != '') { volatileTtl = int(v); }
	} catch (e) { }
	if (statik == null || statik < 0) { statik = 300; }
	if (volatileTtl == null || volatileTtl < 0) { volatileTtl = 0; }
	return { statik: statik, volatile: volatileTtl };
}

function cacheGet(cmd, cls, cfg) {
	let ttl = (cls == 2) ? cfg.statik : cfg.volatile;
	if (ttl <= 0) { return null; }
	let file = READ_CACHE_DIR + '/' + cacheName(cmd);
	let raw = null;
	try { raw = fs.readfile(file); } catch (e) { return null; }
	if (raw == null || raw == '') { return null; }
	let entry = null;
	try { entry = jsonParse(raw); } catch (e) { return null; }
	if (entry == null || entry.t == null || entry.r == null) { return null; }
	let age = time() - entry.t;
	if (age < 0) { age = 0; }
	if (age > ttl) { return null; }
	return entry.r;
}

function cachePut(cmd, resp) {
	let file = READ_CACHE_DIR + '/' + cacheName(cmd);
	let tmp = file + '.tmp';
	try { fs.mkdir(READ_CACHE_DIR); } catch (e) { }
	try {
		fs.writefile(tmp, sprintf('%J', { t: time(), r: resp }));
		fs.rename(tmp, file);
	} catch (e) { }
}

function cacheClear() {
	let files = null;
	try { files = fs.lsdir(READ_CACHE_DIR); } catch (e) { return; }
	if (files == null) { return; }
	for (let i = 0; i < length(files); i++) {
		try { fs.unlink(READ_CACHE_DIR + '/' + files[i]); } catch (e) { }
	}
}

/* at 方法的唯一入口：读走缓存、写清缓存 */
function atCallCached(cmdRaw) {
	let cmd = trimCmd(cmdRaw);
	let cfg = readCacheCfg();
	let cls = cacheClass(cmd);
	if (cls > 0) {
		let hit = cacheGet(cmd, cls, cfg);
		if (hit != null) {
			hit.cached = true;
			return hit;
		}
		let resp = rpcCall('at', { cmd: cmd });
		if (resp != null && resp.success) { cachePut(cmd, resp); }
		return resp;
	}
	/*
	 * ★ P05（2026-09-19 会审）：这里原来是「cls == 0 就无条件 cacheClear()」。
	 * 但 cls == 0 里混着一堆**纯读**命令 —— AT+CSQ、AT+CNUM（network_status.js:236）、
	 * AT 这类既不带 '?' 也不在只读名单里的查询（cacheClass 只认「以 ? 结尾且不含 =」）。
	 * 后果：每查一次 AT+CNUM 就把 300 秒的 IMEI / 型号 / 固件缓存整目录删光，
	 * 本文件上面声称的「页面多次加载不再重复问模组」收益直接归零。
	 * 改为只在**确认是写命令**时清：含 '='，且不是 '=?' 测试命令（测试命令是只读的）。
	 * 判不准则宁可不清 —— 缓存最坏是陈旧（有 TTL 兜底），误清是白白多打串口。
	 */
	let eqIdx = index(cmd, '=');
	if (eqIdx >= 0 && substr(cmd, eqIdx + 1, 1) != '?') {
		/* 写命令：清掉读缓存，避免"保存后读回旧值" */
		cacheClear();
	}
	return rpcCall('at', { cmd: cmd });
}


/*
 * ================= ES9+ 转发（eSIM profile 下载） =================
 *
 * 为什么需要它：
 *   下载 eSIM profile 的 HTTPS 那一半（ES9+，GSMA SGP.22）必须能直连运营商的
 *   SM-DP+ 服务器。浏览器做不到 —— SM-DP+ 不发 CORS 头，跨域请求直接被拦。
 *   所以由路由器代发一次 POST，APDU 那一半仍在浏览器侧经 AT+CSIM 完成。
 *
 * ★ 安全边界（这本质上是一个「受限的外网 HTTP 客户端」，必须收紧）：
 *   ① 只认 https，URL 由本文件拼装，scheme 不可被参数影响；
 *   ② 主机必须是**合法 FQDN** —— 拒绝 IP 字面量 / localhost / 含端口或斜杠，
 *      否则这条通道就成了登录用户打内网的跳板（SSRF）；
 *   ③ 路径必须在 ES9+ 的 5 个端点白名单里，不接受任意路径；
 *   ④ 请求体必须是合法 JSON 且 ≤256KB；
 *   ⑤ 证书验证**保持开启**（不加 -k）。信任库＝系统 CA + 插件自带的
 *      GSMA CI（见下面 es9pCaBundle）；验不过就明确报失败，由界面原样
 *      呈现，而不是偷偷降低安全级别。
 */
const ES9P_PATHS = {
	initiateAuthentication: '/gsma/rsp2/es9plus/initiateAuthentication',
	authenticateClient: '/gsma/rsp2/es9plus/authenticateClient',
	getBoundProfilePackage: '/gsma/rsp2/es9plus/getBoundProfilePackage',
	handleNotification: '/gsma/rsp2/es9plus/handleNotification',
	cancelSession: '/gsma/rsp2/es9plus/cancelSession'
};

function es9pPathAllowed(path) {
	for (let k in ES9P_PATHS) {
		if (ES9P_PATHS[k] === path) {
			return true;
		}
	}
	return false;
}

/* 主机名白名单校验：只放行 [A-Za-z0-9.-] 的合法 FQDN */
function safeHost(h) {
	if (h == null || h == '') {
		return null;
	}
	let n = length(h);
	if (n < 4 || n > 253) {
		return null;
	}
	let dots = 0;
	let letters = 0;
	for (let i = 0; i < n; i++) {
		let c = substr(h, i, 1);
		if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			letters++;
		} else if ((c >= '0' && c <= '9') || c == '-') {
			/* 允许 */
		} else if (c == '.') {
			dots++;
		} else {
			return null;
		}
	}
	if (dots < 1 || letters < 1) {
		return null;   /* 无点 = 不是域名（也挡住 localhost/纯 IP） */
	}
	let first = substr(h, 0, 1);
	let last = substr(h, n - 1, 1);
	if (first == '.' || first == '-' || last == '.' || last == '-') {
		return null;
	}
	if (index(h, '..') >= 0) {
		return null;
	}
	return h;
}

/*
 * 临时文件必须用 mktemp 建，不能自己拼名字。
 *
 * /tmp 是 1777（任何本地用户都可写）。早先这里拼的是
 *   /tmp/mt5700-es9p-<tag>-<time()>.tmp
 * 时间戳是**秒级**的，本地用户可以提前算出下一次的文件名，在那里放一个符号链接
 * 指向 /etc/passwd 之类 —— 于是 fs.open(..., 'w') 与 curl -o 都会顺着链接写过去，
 * 等于以 root 身份覆盖任意文件（本地提权）。
 *
 * mktemp 用 O_EXCL 创建、权限 0600、文件名含随机数不可预测，且失败会明确报错。
 * 创建不成功就整个调用失败，绝不能退回可预测路径。
 */
/*
 * ================= 断网排查：系统侧只读采集 =================
 *
 * 分工（与前端的分界必须清楚，否则两边都会长成怪物）：
 *   本方法   —— 只**采集事实**（接口 up? 路由走哪个口? ARP 什么状态? USB 几速?），
 *                不做任何"通过/不通过"的判定；
 *   前端     —— 拿 facts 逐项判定、给文案与建议。
 * 这样"加一条判据"只改前端，"加一项事实"才动这里，两边都能独立扩展。
 *
 * ★ 为什么走外部脚本而不是在这里拼一长串 shell：
 *   ① 脚本可以手工跑（sh /usr/share/mt5700/diag-probe.sh）直接核对结果，
 *      排障时不用绕 rpcd；
 *   ② 脚本里加一项采集只加几行，ucode 不动。
 *
 * ★ 安全：命令与参数全部写死，不接受 req.args 的任何输入（脚本本身也忽略参数），
 *   因此没有命令注入面。
 */
const DIAG_PROBE = '/usr/share/mt5700/diag-probe.sh';

/* 上限 25 秒：脚本内三个 ICMP(2s×3) + DNS(5s) + TCP(4s) 最坏约 15s，留足余量。
   必须限时 —— rpcd 每个调用占一个 ucode 工作线程，脚本卡住会让整个插件无响应。 */
const DIAG_TIMEOUT = 25;
/* 事实条数上限，防止脚本异常输出把响应撑爆（同时也兜住下面的读循环） */
const DIAG_MAX_LINES = 200;

function diagFacts() {
	let f;
	try {
		f = fs.open(DIAG_PROBE, 'r');
	} catch (e) {
		return null;
	}
	if (!f) {
		return null;
	}
	f.close();

	let p;
	try {
		p = fs.popen('timeout ' + DIAG_TIMEOUT + ' /bin/sh ' + DIAG_PROBE, 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}

	let facts = {};
	for (let i = 0; i < DIAG_MAX_LINES; i++) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		let s = trim(line);
		if (s == '') {
			continue;
		}
		let idx = index(s, '=');
		if (idx <= 0) {
			continue;
		}
		facts[substr(s, 0, idx)] = substr(s, idx + 1);
	}
	p.close();
	return facts;
}

/*
 * ================= 出口 IP 探测（「换卡换 IP」能不能成立的判定依据） =================
 *
 * 为什么非有它不可：AT+CGPADDR 给的是 **PDP 地址**（本模组是桥接模式，路由器 WAN
 * 侧拿到的就是它，见 network_status.js 关于 CGPADDR 与 ^DHCP 同源的说明）。但运营商
 * 普遍做 CGNAT，PDP 地址常常是 10.x / 100.x 这类私网地址 —— 此时「互联网看到的我」
 * 是 CGNAT 出口地址，**只看 PDP 地址根本判断不出换卡后公网出口到底变没变**。
 *
 * 对照 vohive 的做法（internal/netprobe/netprobe.go）：它也是从设备侧发一次 HTTP
 * 回显，用「对端看到的源地址」当公网 IP（`GetPublicIPv4AndV6NoCache`），并且区分
 * privateIP（承载地址）与 publicIP（回显地址）两个字段 —— 上面这段区别正是它分两
 * 个字段的原因。本项目此前完全没有这个手段，所以只能给出「观测」而不是「轮换」。
 *
 * 分工（与 sysdiag 保持一致）：这里只取回**原文**，不解析、不判定；解析与合法性校验
 * 交给前端 Parse.parseExitIpBody。加一个回显服务只改这里，加一条判据只改前端。
 *
 * ★ 安全：URL 写死在白名单常量里，不接受 req 传入任意地址 —— 没有命令注入面。
 *   唯一的用户输入是 bind（要绑定的源 IP），逐字符校验成 IPv4 点分十进制才拼进命令行。
 */
const EXITIP_MAX_BODY = 64;
const EXITIP_TIMEOUT = 12;

/* 全部走 http：设备上的 curl 未必带 CA 信任库，https 缺根时会静默失败
   （es9p 那边为了过 GSMA CI 得额外拼一份 CA，这里没必要引入那份复杂度）。
   传出去的只是「我的 IP 是多少」这种公开信息，不需要机密性。 */
const EXITIP_ENDPOINTS = [
	{ id: 'ipify', url: 'http://api.ipify.org' },
	{ id: 'ifconfig', url: 'http://ifconfig.me/ip' },
	{ id: 'ipip', url: 'http://myip.ipip.net' }
];

/* bind 校验：只放行 IPv4 点分十进制。返回 '' 表示不绑定，null 表示不合法。 */
function safeBindIp(s) {
	if (s == null || s == '') {
		return '';
	}
	if (length(s) > 15) {
		return null;
	}
	let dots = 0;
	let digits = 0;
	for (let i = 0; i < length(s); i++) {
		let c = substr(s, i, 1);
		if (c >= '0' && c <= '9') {
			digits++;
		} else if (c == '.') {
			dots++;
		} else {
			return null;
		}
	}
	/* 3 个点 + 至少 4 位数字：挡掉 "...." / "1" / "999" 这类畸形输入 */
	if (dots != 3 || digits < 4) {
		return null;
	}
	return s;
}

function exitIpOnce(url, bind) {
	let cmd = 'timeout ' + EXITIP_TIMEOUT + ' curl -sS --max-time 8';
	if (bind != null && bind != '') {
		cmd = cmd + ' --interface ' + bind;
	}
	cmd = cmd + ' ' + url;
	let p;
	try {
		p = fs.popen(cmd, 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let body = '';
	for (let i = 0; i < 8; i++) {
		let line = p.read('line');
		if (line == null) {
			break;
		}
		body = body + line;
		if (length(body) > EXITIP_MAX_BODY) {
			break;
		}
	}
	p.close();
	if (body == '') {
		return null;
	}
	return substr(body, 0, EXITIP_MAX_BODY);
}

function exitIpFacts(bind) {
	if (!es9pToolAvailable()) {
		return { success: false, error: '设备上没有 curl，无法探测出口 IP' };
	}
	for (let i = 0; i < length(EXITIP_ENDPOINTS); i++) {
		let ep = EXITIP_ENDPOINTS[i];
		let body = exitIpOnce(ep.url, bind);
		if (body != null) {
			return { success: true, endpoint: ep.id, body: body };
		}
	}
	return { success: false, error: '三个回显服务都没返回内容（可能没网，或 DNS 未解析）' };
}

function es9pMktemp() {
	let p;
	try {
		p = fs.popen('mktemp /tmp/mt5700-es9p-XXXXXX', 'r');
	} catch (e) {
		return null;
	}
	if (!p) {
		return null;
	}
	let s = p.read('line');
	p.close();
	s = (s != null) ? trim(s) : '';
	if (length(s) == 0 || substr(s, 0, 1) != '/') {
		return null;
	}
	return s;
}

function es9pUnlink(path) {
	if (path == null) {
		return;
	}
	try { fs.unlink(path); } catch (e) { }
}

/*
 * ★ 为什么必须自带一份 GSMA CI（2026-09-19 真机实测）：
 *   运营商的 SM-DP+ 用的是 **GSMA 自己的 PKI**，证书由 "GSM Association -
 *   RSP2 Root CI1" 这类根 CI 签发。这套根**不在任何公开 CA 库里**
 *   （Windows / OpenWrt 的 ca-certificates.crt 都没有），所以 curl 一律报
 *       SSL certificate ... unable to get local issuer certificate (20)
 *   HTTP 状态码 000 —— 表现就是「下载永远卡在第一步」，看起来像网络问题，
 *   实际是信任库缺根。真实案例：consumer.rsp.world 的叶子证书 issuer 正是
 *   RSP2 Root CI1，用系统库怎么验都失败，补上这根后立刻验过。
 *
 *   解决办法是**补根**而不是绕过：把插件自带的 GSMA CI 与系统信任库合并成
 *   一份临时 bundle 交给 curl --cacert，证书验证继续开着（不加 -k）。
 *   只信任 GSMA 会漏掉「SM-DP+ 用普通 Web PKI 证书」的运营商，
 *   只信系统会漏掉 GSMA PKI —— 所以两者都要，合并使用。
 */
const GSMA_CI_PEM = '/etc/ssl/certs/mt5700-gsma-rsp-ci.pem';
const SYS_CA_PEM = '/etc/ssl/certs/ca-certificates.crt';

/* 读不到（不存在 / 没权限 / 抛异常）就返回 null，不让任何一处 IO 拖垮请求 */
function es9pReadOpt(path) {
	let r;
	try {
		r = fs.readfile(path);
	} catch (e) {
		return null;
	}
	if (r == null || length(r) == 0) {
		return null;
	}
	return r;
}

/*
 * 返回 { arg: " --cacert '<file>'", temp: <要事后删除的路径 或 null> }；
 * 两份都读不到时返回 null —— 那时不加参数，交回 curl 的默认行为
 * （仍然验证，不降级）。
 */
function es9pCaBundle() {
	const sys = es9pReadOpt(SYS_CA_PEM);
	const gsma = es9pReadOpt(GSMA_CI_PEM);

	if (sys == null && gsma == null) {
		return null;
	}
	if (gsma == null) {
		return { arg: " --cacert '" + SYS_CA_PEM + "'", temp: null };
	}
	if (sys == null) {
		return { arg: " --cacert '" + GSMA_CI_PEM + "'", temp: null };
	}

	/* 两份都有：合并成一份临时 bundle（顺序无关，curl 会逐个试） */
	const tmp = es9pMktemp();
	if (tmp == null) {
		/* 合不了也别失败：退到系统库，总比没有强 */
		return { arg: " --cacert '" + SYS_CA_PEM + "'", temp: null };
	}
	let f = fs.open(tmp, 'w');
	if (!f) {
		es9pUnlink(tmp);
		return { arg: " --cacert '" + SYS_CA_PEM + "'", temp: null };
	}
	f.write(sys);
	f.write('\n');
	f.write(gsma);
	f.close();
	return { arg: " --cacert '" + tmp + "'", temp: tmp };
}

/* 清掉 es9pCaBundle() 生成的临时 bundle（它自己不带生命周期） */
function es9pCaDone(ca) {
	if (ca != null && ca.temp != null) {
		es9pUnlink(ca.temp);
	}
}

function es9pToolAvailable() {
	let p;
	try {
		p = fs.popen('command -v curl', 'r');
	} catch (e) {
		return false;
	}
	if (!p) {
		return false;
	}
	let s = p.read('line');
	p.close();
	return (s != null && length(trim(s)) > 0);
}

function es9pPost(host, path, body) {
	const bodyFile = es9pMktemp();
	const outFile = es9pMktemp();
	if (bodyFile == null || outFile == null) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		return { success: false, error: '无法创建临时文件（设备上没有 mktemp？）' };
	}

	/* 信任库：系统 CA + GSMA CI，缺根就永远验不过（见上面 GSMA_CI_PEM 的注释） */
	const ca = es9pCaBundle();
	const caArg = (ca != null) ? ca.arg : '';

	let f = fs.open(bodyFile, 'w');
	if (!f) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		es9pCaDone(ca);
		return { success: false, error: '无法写临时文件' };
	}
	f.write(body);
	f.close();

	const cmd = 'timeout 45 curl -sS --max-time 35 -X POST' +
		" -H 'Content-Type: application/json'" +
		" -H 'X-Admin-Protocol: gsma/rsp/v2.2.2'" +
		" -H 'User-Agent: gsma-rsp-lpad'" +
		' --data-binary @' + bodyFile +
		' -o ' + outFile +
		" -w '%{http_code}'" +
		caArg +
		" 'https://" + host + path + "'";

	let p;
	try {
		p = fs.popen(cmd, 'r');
	} catch (e) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		es9pCaDone(ca);
		return { success: false, error: '无法发起 HTTPS 请求' };
	}
	if (!p) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		es9pCaDone(ca);
		return { success: false, error: '无法发起 HTTPS 请求' };
	}
	let codeLine = p.read('line');
	p.close();
	es9pUnlink(bodyFile);
	es9pCaDone(ca);

	let respBody = '';
	try {
		respBody = fs.readfile(outFile);
	} catch (e) {
		respBody = '';
	}
	es9pUnlink(outFile);

	let status = int(trim(codeLine != null ? codeLine : ''));
	if (status == null) {
		return { success: false, status: 0, body: respBody, error: '服务器无响应或连接失败' };
	}
	return { success: true, status: status, body: respBody };
}

return {
	mt5700: {
		at: {
			args: { cmd: '' },
			call: function (req) {
				let a = req.args;
				let cmd = getStr(a, 'cmd');
				if (cmd == null || cmd == '') {
					return { success: false, error: '缺少参数 cmd' };
				}
				/*
				 * 长度上限：最长的是短信 PDU（70 个 UCS2 字符 ≈ 280 个十六进制
				 * 字符，长短信再分几条），4096 留了十倍余量，正常业务绝不会触到。
				 * 拦的是异常输入 —— 它会被写进临时文件、经 nc 打到模组，
				 * 没有上限时一条请求就能把串口堵上好几秒。
				 */
				if (length(cmd) > 4096) {
					return { success: false, error: 'AT 命令过长（上限 4096 字节）' };
				}
				return atCallCached(cmd);
			}
		},
		events: {
			args: { since: 0 },
			call: function (req) {
				let a = req.args;
				let since = 0;
				let s = getStr(a, 'since');
				if (s != null && s != '') {
					since = int(s) || 0;
				}
				if (since < 0) {
					since = 0;
				}
				return rpcCall('events', { since: since });
			}
		},
		/* 后端运行日志：服务进程的内存环形缓冲（ubus mt5700.logs）。
		   本服务的 eprintln 输出不进 syslog，拨号对齐 / 串口探测 / URC 分发这些
		   过程只在缓冲里，LuCI「运行日志 → 模组拨号」视图读的就是它。 */
		logs: {
			args: { since: 0, limit: 300 },
			call: function (req) {
				let a = req.args;
				let since = int(getStr(a, 'since')) || 0;
				let limit = int(getStr(a, 'limit')) || 300;
				if (since < 0) {
					since = 0;
				}
				if (limit <= 0 || limit > 1200) {
					limit = 300;
				}
				return rpcCall('logs', { since: since, limit: limit });
			}
		},
		netrate: {
			args: { device: '' },
			call: function (req) {
				return netrateCall(req);
			}
		},
		/* 断网排查：一次性取回系统侧事实（只读，无参数）。
		   返回 { success, at, facts } —— facts 是 key → 字符串 的扁平映射，
		   判定全部交给前端。 */
		sysdiag: {
			args: {},
			call: function (req) {
				let facts = diagFacts();
				if (facts == null) {
					return {
						success: false,
						error: '系统排查脚本不可用（/usr/share/mt5700/diag-probe.sh 缺失或执行失败）'
					};
				}
				return { success: true, at: time(), facts: facts };
			}
		},
		/* 出口 IP 探测：从路由器侧取「互联网看到的我」—— 换卡换 IP 的判定依据。
		   只回原文（端点 id + 响应前 64 字节），解析与合法性校验在前端。
		   bind 可选：绑定到指定源 IP，多出口时用它锁定蜂窝那条链路。 */
		exitip: {
			args: { bind: '' },
			call: function (req) {
				let bind = safeBindIp(getStr(req.args, 'bind'));
				if (bind == null) {
					return { success: false, error: 'bind 不是合法 IPv4 地址' };
				}
				return exitIpFacts(bind);
			}
		},
		es9p: {
			args: { host: '', path: '', body: '', probe: 0 },
			call: function (req) {
				let a = req.args;

				/* probe=1：只探测通道可用性，不发任何网络请求 */
				if (a.probe) {
					let ok = es9pToolAvailable();
					return {
						success: true,
						available: ok,
						error: ok ? '' : '设备上没有 curl，无法访问 SM-DP+ 服务器'
					};
				}

				let host = safeHost(getStr(a, 'host'));
				if (host == null) {
					return { success: false, error: '主机地址不合法（必须是域名，不接受 IP）' };
				}
				let path = getStr(a, 'path');
				if (path == null || !es9pPathAllowed(path)) {
					return { success: false, error: '路径不在 ES9+ 白名单内' };
				}
				let body = getStr(a, 'body');
				if (body == null || body == '') {
					return { success: false, error: '缺少请求体' };
				}
				/* BPP 最大也就几十 KB，256KB 足够，顺手挡住异常输入 */
				if (length(body) > 262144) {
					return { success: false, error: '请求体过大（上限 256KB）' };
				}
				/* 注意：jsonParse 解析失败是**抛异常**，不是返回 null */
				try {
					if (jsonParse(body) == null) {
						return { success: false, error: '请求体不是合法 JSON' };
					}
				} catch (e) {
					return { success: false, error: '请求体不是合法 JSON' };
				}
				if (!es9pToolAvailable()) {
					return { success: false, error: '设备上没有 curl，无法访问 SM-DP+ 服务器' };
				}
				return es9pPost(host, path, body);
			}
		}
	}
};
