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
	 * 上限取 20 秒而不是更短：后端最坏耗时是有上界的 ——
	 * 普通命令 QUEUE_WAIT(8s) + WRITE(3s) + COMMAND_TIMEOUT(2s) = 13s，
	 * 短信后台任务 QUEUE_WAIT(8s) + WRITE(3s) + SMS_SEND_TIMEOUT(6s) = 17s。
	 * 20s 留了余量，只会兜住「真的不回包」，不会把正常的慢响应掐掉。
	 * （后端后来给写入也加了 3s 超时，预算按加过之后的最坏值核过，仍然够。）
	 */
	try {
		p = fs.popen('timeout 20 nc 127.0.0.1 ' + port + ' < ' + tmp, 'r');
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
		return { success: false, error: 'Rust 后端无应答（已限时 20 秒）' };
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
const STATIC_READS = [
	'ATI', 'AT+CGMM', 'AT+CGMR', 'AT+CGSN', 'AT+CIMI', 'AT+CGMI',
	'AT^ICCID?', 'AT^PHYNUM?', 'AT^VERSION?'
];

/* 无问号但属只读的查询（默认不启用缓存，留给 read_cache_ttl>0 时用） */
const BARE_READS = ['AT^DSFLOWQRY', 'AT^MONNC', 'AT^MONSC', 'AT^MONSSC'];

/* 后端自己维护状态：**永不缓存** */
const NEVER_CACHE = ['AT^CELLSCAN', 'AT^SMSJOB', 'AT^FOTA', 'AT^FWUP', 'AT+CMG'];

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
	/* 写命令（或后端状态类命令）：清掉读缓存，避免"保存后读回旧值" */
	cacheClear();
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
 *   ⑤ 证书验证**保持开启**（不加 -k）。服务器链不全时会明确报失败，
 *      由界面原样呈现，而不是偷偷降低安全级别。
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

	let f = fs.open(bodyFile, 'w');
	if (!f) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
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
		" 'https://" + host + path + "'";

	let p;
	try {
		p = fs.popen(cmd, 'r');
	} catch (e) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		return { success: false, error: '无法发起 HTTPS 请求' };
	}
	if (!p) {
		es9pUnlink(bodyFile);
		es9pUnlink(outFile);
		return { success: false, error: '无法发起 HTTPS 请求' };
	}
	let codeLine = p.read('line');
	p.close();
	es9pUnlink(bodyFile);

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
		netrate: {
			args: { device: '' },
			call: function (req) {
				return netrateCall(req);
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
