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
	const tmp = '/tmp/mt5700-rpc.json';
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
	try {
		p = fs.popen('nc 127.0.0.1 ' + port + ' < ' + tmp, 'r');
	} catch (e) {
		return { success: false, error: '无法连接 Rust 后端' };
	}
	if (!p) {
		return { success: false, error: '无法连接 Rust 后端' };
	}

	let line = p.read('line');
	p.close();

	if (!line) {
		return { success: false, error: 'Rust 后端无应答' };
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

/* 不变类：写一次终身不变（或极少变），可安全长 TTL */
const STATIC_READS = [
	'ATI', 'AT+CGMM', 'AT+CGMR', 'AT+CGSN', 'AT+CIMI', 'AT+CGMI',
	'AT^ICCID?', 'AT^PHYNUM?', 'AT^VERSION?', 'AT+CSCA?', 'AT^C5GOPTION?'
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
		}
	}
};
