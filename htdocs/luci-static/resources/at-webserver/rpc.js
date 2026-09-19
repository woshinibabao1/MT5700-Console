'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/parse';
'require rpc';
/* global L, baseclass */

/**
 * AT LuCI RPC 客户端（保持原 ATClient 的 API 面）。
 *
 * 传输链路（LuCI RPC，无 WebSocket）：
 *   LuCI JS → L.rpc.declare('mt5700.at'/'mt5700.events') → rpcd → ucode 插件
 *   （/usr/share/rpcd/ucode/mt5700.uc）→ Rust 后端（127.0.0.1:<port>，TCP newline-JSON）
 *
 * 语义兼容：
 * - sendCommand(cmd) → {success,data,error}，保持 FIFO 顺序（RPC 逐条应答，前端仍串行化）
 * - subscribe/unsubscribe：事件轮询拉取增量（RPC 为请求-响应模型），推送类型与原 WS 一致：
 *   raw_data / new_sms / incoming_call / pdcp_data / memory_full / cellscan / urc_data
 * - 认证：LuCI 登录态由 rpcd 会话/ACL 保证；UCI websocket_auth_key 由 ucode 代理附加，
 *   页面无需输入密钥（原有密钥配置保持兼容）
 */

// rpcd 对象 mt5700 的方法声明（与 root/usr/share/rpcd/ucode/mt5700.uc 对应）
var rpcAt = L.rpc.declare({
	object: 'mt5700',
	method: 'at',
	params: ['cmd'],
	expect: {}
});

var rpcEvents = L.rpc.declare({
	object: 'mt5700',
	method: 'events',
	params: ['since'],
	expect: {}
});

/*
 * 接口累计字节数（实时速率数据源）。
 * 由 mt5700.uc 的 netrate 方法直接读 /sys/class/net/<dev>/statistics/，
 * 全程不下发任何 AT 命令，不占用 AT 通道、不干扰模组。
 * 返回 {success, device, rx_bytes, tx_bytes}，速率由调用方按采样差计算。
 */
var rpcNetRate = L.rpc.declare({
	object: 'mt5700',
	method: 'netrate',
	params: ['device'],
	expect: {}
});

/*
 * 断网排查：一次性取回系统侧事实（接口 / 路由 / ARP / 防火墙 / 服务 / USB / 探测）。
 *
 * 后端是 root/usr/share/mt5700/diag-probe.sh（只读采集，输出 key=value），
 * 由 mt5700.uc 的 sysdiag 方法转发。它**只给事实、不做判定** ——
 * 判定与建议全在页面侧的检查项注册表里。
 *
 * ★ 超时给 30s：脚本里三个 ICMP + 一次 DNS + 一次 TCP 握手，最坏约 15s，
 *   ucode 侧限时 25s，这里再留 rpcd 与网络栈的余量。
 *   比 AT 查询慢得多，所以只在用户点「一键排查」时才调（排查本身也不进页面自动跑）。
 */
var rpcSysDiag = L.rpc.declare({
	object: 'mt5700',
	method: 'sysdiag',
	params: [],
	expect: {}
});

/*
 * ES9+ 转发（eSIM profile 下载用）。
 *
 * 浏览器没法直连运营商的 SM-DP+ 服务器：SM-DP+ 不发 CORS 头，跨域会被拦
 * （这正是 lpac / luci-app-epm 都把下载甩给本机二进制的原因）。
 * 这里只让路由器代发一次 JSON POST，APDU 那一半仍在前端经 AT+CSIM 完成。
 *
 * 后端的收紧项见 mt5700.uc 的 es9p：只认 https、主机必须是合法 FQDN
 * （拒绝 IP / localhost，防 SSRF）、路径在 5 个 ES9+ 端点白名单内、证书照验。
 */
var rpcEs9p = L.rpc.declare({
	object: 'mt5700',
	method: 'es9p',
	params: ['host', 'path', 'body', 'probe'],
	expect: {}
});

function withTimeout(p, ms, msg) {
	return Promise.race([
		p,
		new Promise(function (resolve, reject) {
			setTimeout(function () { reject(new Error(msg || '请求超时')); }, ms);
		})
	]);
}

function ATClient() {
	this.connected = false;
	this.authenticated = true;       // RPC 模式：登录态由 LuCI/rpcd 会话保证
	this.requireAuth = false;
	this.authKey = '';
	this.commandTimeout = 14000;
	this.subscribers = [];            // 推送订阅者
	this.stateCallbacks = [];
	this.state = 'idle';
	this.error = null;
	this.commandQueue = Promise.resolve();
	this.pollTimer = null;
	this.pollInterval = 1500;         // 事件轮询间隔（毫秒）
	this.eventSeq = 0;
	this.firstPoll = true;
	this.host = '127.0.0.1';
	this.port = 8765;
	this.configReady = this.loadConfig();
}

ATClient.prototype.setConnectionState = function (state, err) {
	this.state = state;
	this.error = err || null;
	for (var i = 0; i < this.stateCallbacks.length; i++) {
		try { this.stateCallbacks[i](state, this.error); } catch (e) { /* 回调异常不影响主流程 */ }
	}
};

ATClient.prototype.isReady = function () {
	return this.connected;
};

/* ---------- 配置加载（保留 UCI 键语义；host 仅记录不再用于直连） ---------- */

ATClient.prototype.loadConfig = function () {
	var self = this;
	return L.uci.load('at-webserver').then(function () {
		var port = parseInt(L.uci.get('at-webserver', 'config', 'websocket_port') || '8765', 10) || 8765;
		var authKey = L.uci.get('at-webserver', 'config', 'websocket_auth_key') || '';
		var bind = L.uci.get('at-webserver', 'config', 'websocket_bind') || '';
		var allowWan = L.uci.get('at-webserver', 'config', 'websocket_allow_wan') === '1';
		if (!bind) {
			bind = allowWan ? '0.0.0.0' : '127.0.0.1';
		}
		self.port = port;
		self.bind = bind;
		self.host = bind;
		self.requireAuth = !!authKey;
		self.authKey = authKey;
		return self.port;
	}).catch(function (err) {
		self.port = 8765;
		self.bind = '127.0.0.1';
		self.host = '127.0.0.1';
		return self.port;
	});
};

/* ---------- 连接管理（RPC 模式下为逻辑连接） ---------- */

ATClient.prototype.connect = function () {
	if (this.isReady()) {
		this.setConnectionState('connected');
		return Promise.resolve(true);
	}
	var self = this;
	this.setConnectionState('connecting');
	return this.configReady.then(function () {
		self.connected = true;
		self.authenticated = true;
		self.firstPoll = true;
		self.reconnectAttempts = 0;
		self.setConnectionState('connected');
		if (self.subscribers.length) self.startPolling();
		return true;
	});
};

ATClient.prototype.disconnect = function () {
	this.clearPendingCommands('连接已手动断开');
	this.stopPolling();
	this.connected = false;
	this.authenticated = false;
	this.setConnectionState('disconnected');
	return Promise.resolve();
};

ATClient.prototype.reconnect = function () {
	var self = this;
	if (this.connected) return Promise.resolve();
	this.setConnectionState('reconnecting');
	return this.connect().catch(function () {});
};

/* ---------- 事件轮询 ---------- */

ATClient.prototype.startPolling = function () {
	var self = this;
	if (this.pollTimer) return;
	this.pollTimer = setInterval(function () { self.pollEvents(); }, this.pollInterval);
};

ATClient.prototype.stopPolling = function () {
	if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
};

ATClient.prototype.pollEvents = function () {
	var self = this;
	if (!this.connected) return;
	withTimeout(rpcEvents(this.eventSeq), 6000, '事件轮询超时').then(function (resp) {
		if (!self.connected) return;
		resp = resp || {};
		var seq = typeof resp.seq === 'number' ? resp.seq : self.eventSeq;
		var events = Array.isArray(resp.events) ? resp.events : [];
		self.eventSeq = seq;
		if (self.firstPoll) {
			// 首次连接只对齐序号，不重放服务启动前的事件（与原 WS 连接语义一致）
			self.firstPoll = false;
			return;
		}
		/*
		 * 事件分发必须自己兜住异常。
		 * handlePush → dispatchRawData → Parse.parseRawData 解析的是模组上报的
		 * 原始行，格式稍有出入就可能抛异常。若不在这里拦住，异常会冒泡到下面
		 * 的 catch，被当成「RPC 调用失败」——于是解析一个 URC 失败就会把整个
		 * 插件置为离线、停掉轮询、3 秒后重连，期间所有 AT 命令都只回
		 * 「未连接到调制解调器」。故障性质完全被误判，排查时会往网络方向找。
		 * 单条事件解析失败只应影响这一条事件，不该掀翻整条连接。
		 */
		for (var i = 0; i < events.length; i++) {
			try {
				self.handlePush(events[i]);
			} catch (e) {
				if (typeof console !== 'undefined' && console.warn) {
					console.warn('[mt5700] 事件处理异常，已跳过：', e);
				}
			}
		}
	}).catch(function (err) {
		if (self.connected && (err && err.message !== '事件轮询超时')) {
			self.setConnectionState('error', 'RPC 调用失败: ' + (err.message || err));
			self.connected = false;
			self.stopPolling();
			// rpcd/Rust 恢复后自动重连（有订阅者时）
			setTimeout(function () { self.reconnect(); }, 3000);
		}
	});
};

ATClient.prototype.handlePush = function (ev) {
	if (!ev || typeof ev.type !== 'string') return;
	if (ev.type === 'raw_data' && typeof ev.data === 'string') {
		this.dispatchRawData(ev.data);
		return;
	}
	if (['incoming_call', 'new_sms', 'pdcp_data', 'memory_full', 'cellscan', 'urc_data'].indexOf(ev.type) >= 0) {
		this.emitPush({ success: true, type: ev.type, data: ev.data });
	}
};

/* ---------- 命令发送（RPC，逐条独立应答） ---------- */

/*
 * 超时预算说明（对应「AT 终端只有 ATI 有回复」的修复）：
 * 后端把「排队等空闲通道」与「等模组应答」拆成了两段独立预算
 * （QUEUE_WAIT_TIMEOUT 8s + COMMAND_TIMEOUT 2s），最坏耗时约 10s。
 * 前端若仍用 8s，会在后端真正返回结果之前先报「命令执行超时」，
 * 把「模组无响应」和「后端还在排队」混为一谈。故前端放宽到 14s，
 * 留出网络与 rpcd 代理余量，让用户看到后端给出的准确原因。
 */
/*
 * 判断一条命令是否「可安全重试」。
 *
 * 本模组偶发单次 ERROR / 无响应（同一命令再发一次往往就正常），因此读类命令
 * 失败后自动重试若干次；写类命令绝不重试——重复下发可能造成重复操作
 * （例如短信重复发送、锁频命令重复生效）。
 */
/*
 * 不带 '?' 的纯读命令。
 *
 * 这里与下面 IDENTIFIER_COMMANDS / STATE_COMMANDS 一起构成「读命令」的完整名单，
 * 判断的是同一件事 —— 这条命令**没有副作用**，失败可以再发一次、结果可以缓存。
 * 三份名单必须集中在一处由 isRetryableRead 统一引用：早先这里和分档缓存各抄了一份，
 * 结果 IMEI / IMSI / 型号 / 固件（AT+CGSN / AT+CIMI / AT+CGMM / AT+CGMR）只进了
 * 缓存名单、没进重试名单，于是它们既拿不到 10 分钟缓存，还会走 sendCommand 的
 * 写命令分支 —— 每查一次 IMEI 就把状态类缓存全清一遍，分档等于白做。
 */
var NON_QUESTION_READS = [
	'AT+CSQ', 'AT^MONSC', 'AT^MONNC', 'AT^MONSSC', 'AT^DSFLOWQRY'
];

/* 判断一条命令是否「可安全重试」，同时决定它是否可缓存（见 sendCommand）。 */
function isRetryableRead(command) {
	var cmd = String(command == null ? '' : command).trim();
	if (!cmd) return false;
	if (cmd === 'AT' || cmd === 'ATI') return true;
	if (cmd.charAt(cmd.length - 1) === '?') return true;
	var k = normalizeCommand(cmd);
	return NON_QUESTION_READS.indexOf(k) >= 0
		|| IDENTIFIER_SET[k] === true
		|| STATE_SET[k] === true;
}

/*
 * 模组把错误当普通文本返回时的判定（ERROR / +CME ERROR / +CMS ERROR）
 *
 * ★ 必须**行锚定**且**不带 /i**。早期写法
 *     /(^|[\s\r\n])(ERROR|\+CME ERROR|\+CMS ERROR)/i
 *   的分隔符含 `\s`（空格也算），于是应答**正文**里的英文单词一样会命中：
 *   Text 模式（CMGF=1）下 `AT+CMGL=4` 返回的一条短信正文含 "error"，
 *   整份短信列表就被当成「命令失败」，界面表现为列表空白、日志里还查不到 ERROR。
 *
 *   行锚定 + 去掉 /i 后：
 *     "My network error again"        → 不命中（前面是空格，不是行首）
 *     "\r\nERROR\r\n"                 → 命中
 *     "\r\n+CME ERROR: 10\r\n"        → 命中（错误码后可跟任意说明文字）
 *   守卫见 tests/at-error-text-contract.test.js。
 */
function isErrorText(data) {
	if (data == null) return false;
	var txt = String(data);
	return /(^|[\r\n])[ \t]*(ERROR|\+CME ERROR|\+CMS ERROR)(:[^\r\n]*)?[ \t]*(?=[\r\n]|$)/.test(txt);
}

function delayMs(ms) {
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/*
 * 只读命令结果短时缓存
 * ----------------------------------------------------------------------------
 * 串口是独占资源，同一条只读查询被打两次（同一刷新周期内多个卡片各查一遍）
 * 或页面短时间来回切换时，缓存能直接省掉整条 AT 往返。
 *
 * 只缓存「只读查询」——由 isRetryableRead() 判定（AT/ATI、以 ? 结尾、
 * 以及少数不带 ? 的查询命令）。写命令、终端手动执行的命令一律不缓存。
 *
 * 默认 2500ms：比 5 秒的自动刷新略短，保证每轮刷新至少拿到一次新值，
 * 又足以吃掉同一轮里重复的查询。调用方可用 { fresh: true } 强制绕过。
 */
const READ_CACHE_TTL = 2500;
const READ_CACHE_MAX = 64;
ATClient.prototype._readCache = null;

/*
 * 缓存时长分档
 * ----------------------------------------------------------------------------
 * 一刀切 2500ms 时，缓存只在「同一轮刷新内去重」有用；而页面每 5~30 秒刷新
 * 一次，绝大多数查询都命中不了，像 IMEI 这种一辈子不变的值也被反复重查
 * （实测每条往返 240~300ms，7 条就是近 2 秒的纯等待）。
 *
 * 因此按「值本身多久会变」分三档。判据不是采样——采样会被 ^MONSC 这种
 * 「3 秒内恰好没变、实际随时会变」的命令骗到（实测它就曾被判成恒定），
 * 而是命令所读对象的物理属性：
 *
 *   ① IDENTIFIER（10 分钟）：读的是烧在模块里 / 刻在 SIM 卡上的标识。
 *      IMEI/SVN/MAC 在模块 EEPROM，IMSI/ICCID 在 SIM 卡，型号与固件版本由
 *      硬件与当前刷写的版本决定——除非换模块、换卡或升级固件，否则不会变。
 *      真机连查两次结果完全一致（864640060359112 / 460009711127691 等）。
 *      10 分钟上限是为了换卡后能自愈：换卡后最迟 10 分钟拿到新 IMSI。
 *
 *   ② STATE（15 秒）：会变，但只在用户主动操作后才变（插拔卡、切飞行
 *      模式、改 PIN）。比刷新周期(30s)短，保证每轮慢档刷新能拿到真实状态，
 *      又能吃掉页面来回切换时的重复查询。
 *      注意边界：^SYSINFOEX（系统模式/服务域）看起来像状态，但它会在
 *      5G↔4G 重选时**自行**变化，不属于「用户操作后才变」，故不进这一档。
 *
 *   ③ 其余一律 2500ms：信号、流量、温度这类连续量，一轮一查。
 *
 * 失败结果不缓存（_cachePut 只收 success）：本模组存在偶发单次 ERROR
 * （实测 AT^SYSINFOEX? 两次里有一次 ERROR），若把失败也缓存起来，一次
 * 偶发就会变成「持续显示失败」，比多等一次往返的代价大得多。
 */
var CACHE_TTL_IDENTIFIER = 10 * 60 * 1000;
var CACHE_TTL_STATE = 15 * 1000;

/* 物理标识类：模块/卡上写死，会话内不会变 */
var IDENTIFIER_COMMANDS = [
	'AT+CGSN',      /* IMEI */
	'AT+CIMI',      /* IMSI */
	'AT^ICCID?',    /* ICCID */
	'AT+CGMM',      /* 模块型号 */
	'AT+CGMR',      /* 固件版本 */
	'AT^PHYNUM?',   /* IMEI / MAC / SVN */
	'AT^VERSION?',  /* 各组件版本 */
	'ATI'           /* 厂商与模块标识 */
];

/* 状态类：只在用户操作后变化 */
var STATE_COMMANDS = [
	'AT+CPIN?',         /* SIM 锁状态 */
	'AT^SIMSQ?',        /* SIM 状态 */
	'AT+CFUN?',         /* 射频开关 */
	'AT+CLCK?',         /* PIN 锁开关 */
	'AT+CGDCONT?',      /* PDP 上下文 */
	'AT+CSCA?'          /* 短信中心号 */
];

var IDENTIFIER_SET = {};
IDENTIFIER_COMMANDS.forEach(function (c) { IDENTIFIER_SET[c] = true; });
var STATE_SET = {};
STATE_COMMANDS.forEach(function (c) { STATE_SET[c] = true; });

/* 命令归一化：忽略大小写与首尾空格，去掉重复空格 */
function normalizeCommand(command) {
	return String(command == null ? '' : command).trim().toUpperCase().replace(/\s+/g, '');
}

function cacheTtlFor(command) {
	var k = normalizeCommand(command);
	if (IDENTIFIER_SET[k]) return CACHE_TTL_IDENTIFIER;
	if (STATE_SET[k]) return CACHE_TTL_STATE;
	return READ_CACHE_TTL;
}

ATClient.prototype._cacheGet = function (command) {
	var c = this._readCache;
	if (!c) return null;
	var hit = c[normalizeCommand(command)];
	if (!hit) return null;
	if (Date.now() - hit.t > cacheTtlFor(command)) {
		delete c[normalizeCommand(command)];
		return null;
	}
	hit.hits = (hit.hits || 0) + 1;
	return hit.value;
};

ATClient.prototype._cachePut = function (command, value) {
	if (!value || value.success !== true) return;   /* 只缓存成功结果 */
	if (!this._readCache) this._readCache = {};
	var keys = Object.keys(this._readCache);
	if (keys.length >= READ_CACHE_MAX) {
		/* 简单淘汰：清掉最旧的一半，避免无限增长 */
		keys.sort(function (a, b) { return this._readCache[a].t - this._readCache[b].t; }.bind(this));
		for (var i = 0; i < keys.length / 2; i++) delete this._readCache[keys[i]];
	}
	this._readCache[normalizeCommand(command)] = { t: Date.now(), value: value, hits: 0 };
};

ATClient.prototype.cacheStats = function () {
	var c = this._readCache || {};
	var n = 0, h = 0;
	Object.keys(c).forEach(function (k) { n++; h += (c[k].hits || 0); });
	return { entries: n, hits: h };
};

ATClient.prototype.clearReadCache = function () {
	this._readCache = null;
};

/*
 * 只丢掉「状态类」缓存。
 * 写命令（改 PIN、切飞行模式、改 PDP、改短信中心号）执行成功后，被它改动的
 * 那些状态查询可能已经失效；物理标识类不受影响，没必要一起丢。
 */
ATClient.prototype._dropStateCache = function () {
	var c = this._readCache;
	if (!c) return;
	Object.keys(c).forEach(function (k) {
		if (STATE_SET[normalizeCommand(k)]) delete c[k];
	});
};

ATClient.prototype.sendCommand = function (command, opts) {
	var self = this;
	var opt = opts || {};
	var cacheable = !opt.fresh && isRetryableRead(command);
	if (cacheable) {
		var cached = this._cacheGet(command);
		if (cached) return Promise.resolve(cached);
	}
	var maxAttempts = opt.attempts != null
		? opt.attempts
		: (isRetryableRead(command) ? 3 : 1);

	this.commandQueue = this.commandQueue.then(function () {
		var attempt = 0;
		var attemptOnce = function () {
			attempt++;
			if (!self.connected) return { success: false, error: '未连接到调制解调器' };
			return withTimeout(rpcAt(command), self.commandTimeout,
				'命令执行超时（模组可能正忙或正在重连，请稍后重试）').then(function (resp) {
				resp = resp || {};
				if (resp.success === false || isErrorText(resp.data)) {
					if (attempt < maxAttempts) {
						return delayMs(200 * attempt).then(attemptOnce);
					}
					return { success: false, error: resp.error || '命令执行失败' };
				}
				return { success: true, data: resp.data };
			}).catch(function (err) {
				var msg = (err && err.message) || '命令执行失败';
				if (attempt < maxAttempts) {
					return delayMs(200 * attempt).then(attemptOnce);
				}
				return { success: false, error: msg };
			});
		};
		return attemptOnce();
	});
	if (cacheable) {
		return this.commandQueue.then(function (res) {
			self._cachePut(command, res);
			return res;
		});
	}
	/*
	 * 写命令：执行成功后丢掉状态类缓存。页面未必每次都记得调
	 * invalidateReadCache()，而「改完 PIN 还显示旧状态」这类问题很难排查，
	 * 因此在这里兜底——只丢状态类，物理标识类不受影响。
	 */
	return this.commandQueue.then(function (res) {
		if (res && res.success) self._dropStateCache();
		return res;
	});
};

/* 写命令之后，之前的只读缓存很可能已经过期，主动清掉避免读到陈旧值 */
ATClient.prototype.invalidateReadCache = function () {
	this.clearReadCache();
};

ATClient.prototype.clearPendingCommands = function (err) {
	// RPC 模式下无挂起 FIFO；保留函数以兼容调用点
	void err;
};

/* ---------- 订阅 ---------- */

ATClient.prototype.subscribe = function (cb) {
	if (this.subscribers.indexOf(cb) < 0) {
		this.subscribers.push(cb);
		if (this.connected) this.startPolling();
	}
};

ATClient.prototype.unsubscribe = function (cb) {
	var i = this.subscribers.indexOf(cb);
	if (i >= 0) this.subscribers.splice(i, 1);
	if (!this.subscribers.length) this.stopPolling();
};

ATClient.prototype.emitPush = function (resp) {
	for (var i = 0; i < this.subscribers.length; i++) {
		try { this.subscribers[i](resp); } catch (e) { console.error(e); }
	}
};

ATClient.prototype.onConnectionStateChange = function (cb) {
	this.stateCallbacks.push(cb);
	cb(this.state, this.error);
	/*
	 * 返回退订函数。
	 *
	 * 此前只进不出：每个页面进来都 push 一个闭包，闭包又持有该页的 DOM 节点，
	 * 于是进十次页面就积累十个永不回收的回调；而 connect() 在已就绪时仍会
	 * setConnectionState('connected')，每次渲染都会把历史回调全部触发一遍 ——
	 * 它们各自去更新一堆早已脱离文档的节点。
	 */
	var self = this;
	var detached = false;
	return function () {
		if (detached) return;
		detached = true;
		var i = self.stateCallbacks.indexOf(cb);
		if (i >= 0) self.stateCallbacks.splice(i, 1);
	};
};

ATClient.prototype.dispatchRawData = function (text) {
	var self = this;
	var parsed = parseRawData(text);
	for (var i = 0; i < parsed.length; i++) {
		self.emitPush({ success: true, type: 'urc_data', data: parsed[i] });
	}
};

ATClient.prototype.setConnection = function (host, port) {
	// RPC 模式下连接由 LuCI/rpcd 决定，仅记录参数保持兼容
	this.host = String(host || '').replace(/^\[|\]$/g, '');
	this.port = parseInt(port, 10) || this.port;
	try {
		localStorage.setItem('atHost', this.host);
		localStorage.setItem('atPort', String(this.port));
	} catch (e) { /* ignore */ }
	return Promise.resolve();
};

/* ================= UCI 保存/应用编排 =================
 *
 * 背景（问题一）：本应用原先在页面里直接连续调用
 *     L.uci.set(...) → L.uci.save() → L.uci.apply()
 * 这条链路存在三个与 OpenWrt 标准「保存及应用」流程不一致的地方：
 *
 *   1) 缺少「未保存更改的确认」。OpenWrt 的 CBI 表单在离开页面时会提示
 *      「有未保存的更改」，本应用的自定义 E() 表单没有挂到该机制上，
 *      用户改完不点保存直接切页，改动静默丢失，表现为「保存了但没生效」。
 *
 *   2) set/save/apply 三段各自独立，任何一段失败都只是整体 reject，
 *      无法区分「写内存失败」「落盘失败」「reload 失败」，用户看到的是
 *      一句笼统的「保存失败」。
 *
 *   3) reload 触发依赖 apply() 内部生成的配置 hash。当 at-webserver 的
 *      UCI 变更 hash 与上一次相同（例如只改了 service.js 里不写盘的派生
 *      项），rpcd 的 apply 会因为「无待应用变更」直接返回 ubus 状态码 5
 *      (NO_DATA)，前端把它当成失败——实际上配置已经生效。
 *
 * 本模块把上述流程收敛为一处，对外只暴露 uciSave(section) 与
 * uciHasChanges(section)，语义与 LuCI 的「保存并应用」按钮一致。
 */
var AtUci = {
	// 已注册「未保存更改」提示的页面数
	_dirty: false,
	_beforeUnload: null,
	_dirtyFlush: [],

	// 标记当前页面存在未保存更改，并在离开时提示（等价 LuCI 自带行为）
	markDirty: function () {
		if (this._dirty) return;
		this._dirty = true;
		this._beforeUnload = function (ev) {
			if (!AtUci._dirty) return undefined;
			ev.preventDefault();
			ev.returnValue = '';
			return '';
		};
		window.addEventListener('beforeunload', this._beforeUnload);
	},

	// 清除未保存标记（保存/应用成功、或用户主动放弃时调用）
	clearDirty: function () {
		this._dirty = false;
		if (this._beforeUnload) {
			window.removeEventListener('beforeunload', this._beforeUnload);
			this._beforeUnload = null;
		}
	},

	isDirty: function () { return this._dirty; },

	// 查询该配置是否存在待应用变更（rpcd uci.changes）
	uciHasChanges: function (section) {
		return L.uci.changes(section).then(function (changes) {
			return Array.isArray(changes) ? changes.length > 0 : !!changes;
		}).catch(function () {
			// changes 不可用时不阻断主流程，按「有变更」处理
			return true;
		});
	},

	/**
	 * 保存并应用（等价 CBI 底部「保存并应用」按钮）。
	 * 返回 { applied: bool, saved: bool, appliedSkipped: bool }
	 */
	uciSave: function (section, opts) {
		var options = opts || {};
		var result = { saved: false, applied: false, appliedSkipped: false, changes: null };

		return this.uciHasChanges(section).then(function (has) {
			result.changes = has;
			if (!has && options.skipWhenClean !== false) {
				// 无待应用变更：不需要 save/apply，直接视为已生效
				result.saved = true;
				result.appliedSkipped = true;
				return result;
			}
			return L.uci.save(section).then(function () {
				result.saved = true;
				return L.uci.apply(false, true);
			}).then(function () {
				result.applied = true;
				return result;
			}, function (err) {
				// ubus 状态码 5 = NO_DATA：rpcd 未收到待应用数据，通常表示
				// 变更已在上一轮 commit，配置实际已生效，不视为失败。
				var code = err && err.code;
				var msg = (err && err.message) || '';
				if (code === 5 || /未收到数据|No data|NO_DATA/i.test(msg)) {
					result.applied = true;
					result.appliedSkipped = true;
					return result;
				}
				throw err;
			});
		});
	},

	/**
	 * commit 型保存：仅落盘，不触发服务 reload。
	 * 用于「服务配置」这类自身不作为 reload 触发源、而由页面显式重载的场景。
	 */
	uciCommit: function (section) {
		var result = { saved: false, applied: false, appliedSkipped: false };
		return this.uciHasChanges(section).then(function (has) {
			if (!has) {
				result.saved = true;
				result.appliedSkipped = true;
				return result;
			}
			return L.uci.save(section).then(function () {
				result.saved = true;
				// append=true 表示「保存并应用」，会走 rpcd 的 commit+apply 全流程，
				// 从而正确记录 config hash 并触发 procd reload。
				return L.uci.apply(false, true);
			}).then(function () {
				result.applied = true;
				return result;
			}, function (err) {
				var code = err && err.code;
				var msg = (err && err.message) || '';
				if (code === 5 || /未收到数据|No data|NO_DATA/i.test(msg)) {
					result.applied = true;
					result.appliedSkipped = true;
					return result;
				}
				throw err;
			});
		});
	}
};

/* ================= 解析工具 ================= */

function extractATData(data, command) {
	var m = data.match(new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*([^\\r\\n]+)'));
	return m ? m[1] : null;
}

function extractATDataMultiline(data, command) {
	var re = new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*(.+)');
	return data.split('\n')
		.map(function (line) { var m = line.match(re); return m ? m[1].trim() : null; })
		.filter(Boolean);
}

function convertRsrp(raw) { return raw === 0 ? -140 : (raw >= 97 ? -44 : -140 + raw); }
function convertRsrq(raw) { return raw === 0 ? -19.5 : (raw >= 34 ? -3 : -19.5 + raw * 0.5); }
function convertSinr(raw) {
	var v = raw === 0 ? -20 : (raw >= 251 ? 30 : -20 + raw * 0.2);
	return Math.min(30, Math.max(-20, v));
}
function convertRssi(raw) { return raw === 0 ? -120 : (raw >= 96 ? -25 : -121 + raw); }

function calculateSignalPercent(rsrp) {
	if (!rsrp || rsrp >= 0) return '';
	var ratio = (rsrp - (-110)) / ((-70) - (-110));
	return Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
}

function parseHexValue(hexStr) { return parseInt(hexStr, 16) || 0; }

function hexToIP(hex) {
	if (!hex || typeof hex !== 'string') return '0.0.0.0';
	var clean = hex.trim().replace(/[\r\n]/g, '');
	if (!/^[0-9A-Fa-f]+$/.test(clean)) return '0.0.0.0';
	if (clean.length !== 8) clean = clean.padStart(8, '0').substring(0, 8);
	var bytes = [];
	for (var i = 0; i < 8; i += 2) bytes.push(parseInt(clean.substring(i, i + 2), 16) || 0);
	while (bytes.length < 4) bytes.push(0);
	return bytes.reverse().join('.');
}

function parseTemperature(v) {
	var n = typeof v === 'number' ? v : parseInt(v, 10);
	if (n >= 65535 || isNaN(n) || n > 1500) return 0;
	return parseFloat((n / 10).toFixed(1));
}

function formatFlow(bytes) {
	if (bytes < 1024) return bytes + ' B';
	if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
	if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
	if (bytes < 1099511627776) return (bytes / 1073741824).toFixed(2) + ' GB';
	return (bytes / 1099511627776).toFixed(2) + ' TB';
}

function formatSpeed(bytesPerSecond) {
	var bits = bytesPerSecond * 8;
	if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gbps';
	if (bits >= 1e6) return (bits / 1e6).toFixed(2) + ' Mbps';
	if (bits >= 1e3) return (bits / 1e3).toFixed(2) + ' Kbps';
	return Math.round(bits) + ' bps';
}

function splitSpeed(bytesPerSecond) {
	var bits = bytesPerSecond * 8;
	if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
	if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps' };
	if (bits >= 1e3) return { value: (bits / 1e3).toFixed(1), unit: 'Kbps' };
	return { value: Math.round(bits).toString(), unit: 'bps' };
}

function formatDuration(seconds, showDays) {
	if (showDays) {
		var d = Math.floor(seconds / 86400);
		var h = Math.floor((seconds % 86400) / 3600);
		var m = Math.floor((seconds % 3600) / 60);
		return d + '天' + h + '时' + m + '分' + (seconds % 60) + '秒';
	}
	var h2 = Math.floor(seconds / 3600);
	var m2 = Math.floor((seconds % 3600) / 60);
	return h2 + '时' + m2 + '分' + (seconds % 60) + '秒';
}

var NR_BANDS = {
	'1': '2100 MHz (FDD)', '2': '1900 MHz (FDD)', '3': '1800 MHz (FDD)', '5': '850 MHz (FDD)',
	'7': '2600 MHz (FDD)', '8': '900 MHz (FDD)', '20': '800 MHz (FDD)', '28': '700 MHz (FDD)',
	'38': '2600 MHz (TDD)', '40': '2300 MHz (TDD)', '41': '2500 MHz (TDD)', '77': '3700 MHz (TDD)',
	'78': '3500 MHz (TDD)', '79': '4700 MHz (TDD)'
};
var LTE_BANDS = {
	'1': '2100 MHz', '2': '1900 MHz', '3': '1800 MHz', '4': '1700 MHz (AWS)', '5': '850 MHz',
	'7': '2600 MHz', '8': '900 MHz', '12': '700 MHz', '20': '800 MHz', '28': '700 MHz', '38': '2600 MHz',
	'39': '1900 MHz', '40': '2300 MHz', '41': '2500 MHz', '42': '3400 MHz', '43': '3700 MHz'
};
function bandName(kind, band) {
	var table = kind === 'NR' ? NR_BANDS : LTE_BANDS;
	return table[String(band)] || ('Band ' + band);
}

/* ---- ^HCSQ / 信号 ---- */

function parseHCSQ(data) {
	var str = extractATData(data, '^HCSQ');
	if (!str) return null;
	var p = str.split(',');
	var mode = p[0] ? p[0].replace(/"/g, '').trim() : '';
	var networkMode;
	if (mode.indexOf('NR') === 0) networkMode = 'NR';
	else if (mode.indexOf('LTE') === 0) networkMode = 'LTE';
	else if (mode.indexOf('WCDMA') === 0) networkMode = 'WCDMA';
	else networkMode = mode || '';
	var result = { networkMode: networkMode, rssi: null, rsrp: null, rsrq: null, sinr: null };
	if (networkMode === 'NR') {
		/*
		 * NR 格式（实测 ^HCSQ: "NR",77,236,31）与 LTE 顺序不同：
		 *   "NR",<rsrp_raw>,<sinr_raw>,<rsrq_raw>
		 * 交叉验证：rsrp 77 → -63 dBm、sinr 236 → 27.2 dB，与 ^MONSC 的
		 * -65 dBm / 28 dB 独立吻合，故按此顺序解析（兼容 3 或 4 数值字段）。
		 */
		if (p.length >= 2) result.rsrp = convertRsrp(parseInt(p[1], 10));
		if (p.length >= 3) result.sinr = convertSinr(parseInt(p[2], 10));
		if (p.length >= 4) result.rsrq = convertRsrq(parseInt(p[3], 10));
	} else if (networkMode === 'LTE') {
		if (p.length >= 3) result.rsrp = convertRsrp(parseInt(p[2], 10));
		if (p.length >= 4) result.rsrq = convertRsrq(parseInt(p[3], 10));
		if (p.length >= 5) result.sinr = convertSinr(parseInt(p[4], 10));
	} else {
		if (p.length >= 2) result.rssi = convertRssi(parseInt(p[1], 10));
	}
	return result;
}

/* 从 CSS 变量取色，使信号配色随浅色 / 深色主题自动切换 */
function cssColor(name, fallback) {
	try {
		var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
		v = (v || '').trim();
		return v || fallback;
	} catch (e) {
		return fallback;
	}
}

function signalColor(rsrp) {
	if (rsrp == null || rsrp >= 0) return cssColor('--mt5700-text-muted', '#8a93a0');
	if (rsrp >= -90) return cssColor('--mt5700-sig-exc', '#0c7a54');
	if (rsrp >= -105) return cssColor('--mt5700-sig-fair', '#9a5c00');
	return cssColor('--mt5700-sig-bad', '#c62828');
}

/* ---- PS 注册状态 ---- */

function psRegText(stat) {
	switch (parseInt(stat, 10)) {
		case 0: return '未注册，正在搜索';
		case 1: return '已注册';
		case 2: return '未注册，正在搜索（但允许紧急呼叫）';
		case 3: return '注册被拒绝';
		case 4: return '未知';
		case 5: return '已注册（漫游）';
		default: return '等待状态中';
	}
}

/* ---- 主动上报识别 ---- */

function isUnsolicitedText(text) {
	if (!text) return false;
	if (text === 'RING' || text === 'IRING' || text === '^IRING' || text === 'NO CARRIER') return true;
	return text.indexOf('+CMTI:') === 0 || text.indexOf('^CEND:') === 0 ||
		text.indexOf('^SMMEMFULL') === 0 || text.indexOf('MEMORY FULL') >= 0 ||
		text.indexOf('^REJINFO') === 0 || text.indexOf('^SRVST') === 0 ||
		(text.indexOf('+CUSD:') === 0 && text.indexOf(',') >= 0);
}

/* ---- raw_data 拆分（^PDCPDATAINFO / URC） ---- */

function parseRawData(text) {
	var out = [];
	var re = /\^PDCPDATAINFO:\s*([^\r\n]+)/g;
	var m, rest = text;
	while ((m = re.exec(text)) !== null) {
		var fields = m[1].split(',');
		out.push({ type: 'PDCP', raw: m[1], parsed: parsePDCP(fields) });
		rest = rest.replace(m[0], '');
	}
	// 其余 URC
	var lines = rest.split('\n');
	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].trim();
		if (!line) continue;
		if (line.indexOf('^HCSQ:') === 0) {
			out.push({ type: 'HCSQ', raw: line, parsed: parseHCSQ(line) });
		} else if (line.indexOf('^CERSSI:') === 0) {
			out.push({ type: 'CERSSI', raw: line });
		} else if (line.indexOf('^REJINFO') === 0) {
			// 网络拒绝原因主动上报，解析后进 REJINFO 类型
			out.push({ type: 'REJINFO', raw: line, parsed: Parse.parseRejInfo(line) });
		}
		/*
		 * ^SRVST（服务状态）**不再解析分发**：对应功能「服务状态监听」已整块下线
		 * （手册只有设置命令 AT^SRVST=<n>、没有读命令，要看状态就得先开周期上报
		 *   再等模组推 —— 那会在模组里留下常驻上报，是 2.2.1 那类事故的源头）。
		 * 它仍留在上面的 isUnsolicitedText 里：万一有人从 AT 终端手动开过上报，
		 * 这条 URC 也能被正确归类成「非命令响应」，不会被当成某次查询的应答。
		 */
	}
	return out;
}

/* ---- PDCP 14 字段 ---- */

var PDCP_FIELDS = [
	{ key: 'rx_bytes', label: '下行字节' },
	{ key: 'tx_bytes', label: '上行字节' },
	{ key: 'rx_pkts', label: '下行包数' },
	{ key: 'tx_pkts', label: '上行包数' },
	{ key: 'rx_rate', label: '下行速率' },
	{ key: 'tx_rate', label: '上行速率' },
	{ key: 'rx_pdcp_delay', label: '下行 PDCP 时延(0.1ms)' },
	{ key: 'tx_pdcp_delay', label: '上行 PDCP 时延(0.1ms)' },
	{ key: 'rx_pkt_loss', label: '下行丢包率' },
	{ key: 'tx_pkt_loss', label: '上行丢包率' },
	{ key: 'rx_retx_pct', label: '下行重传率' },
	{ key: 'tx_retx_pct', label: '上行重传率' },
	{ key: 'rx_volte_bytes', label: '下行 VoLTE 字节' },
	{ key: 'tx_volte_bytes', label: '上行 VoLTE 字节' }
];

function parsePDCP(fields) {
	var obj = {};
	obj.rx_bytes = parseInt(fields[0], 10) || 0;
	obj.tx_bytes = parseInt(fields[1], 10) || 0;
	obj.rx_pkts = parseInt(fields[2], 10) || 0;
	obj.tx_pkts = parseInt(fields[3], 10) || 0;
	obj.rx_rate = parseInt(fields[4], 10) || 0;
	obj.tx_rate = parseInt(fields[5], 10) || 0;
	obj.rx_pdcp_delay = parseInt(fields[6], 10) || 0;
	obj.tx_pdcp_delay = parseInt(fields[7], 10) || 0;
	obj.rx_pkt_loss = parseInt(fields[8], 10) || 0;
	obj.tx_pkt_loss = parseInt(fields[9], 10) || 0;
	obj.rx_retx_pct = parseInt(fields[10], 10) || 0;
	obj.tx_retx_pct = parseInt(fields[11], 10) || 0;
	obj.rx_volte_bytes = parseInt(fields[12], 10) || 0;
	obj.tx_volte_bytes = parseInt(fields[13], 10) || 0;
	obj.downSpeed = obj.rx_rate / 1024;   // Kbps 原始
	obj.upSpeed = obj.tx_rate / 1024;
	return obj;
}

/* ---- MONSC ---- */

function parseMONSC(data) {
	var str = extractATData(data, '^MONSC');
	if (!str) return null;
	var p = str.split(',').map(function (s) { return s.trim(); });
	/*
	 * 手册 13.9.3 的字段序（**按 RAT 不同**，此前把三者当成同一套，导致 TAC/频点/PCI 全错位）：
	 *   NR ：<MCC>,<MNC>,<ARFCN-NR>,<SCS>,<Cell_ID>,<PCI>,<TAC>,<RSRP>,<RSRQ>,<SINR>
	 *   LTE：<MCC>,<MNC>,<ARFCN>,<Cell_ID>,<PCI>,<TAC>,<RSRP>,<RSRQ>,<RSSI>   （无 SCS）
	 * 实测 NR：^MONSC: NR,460,00,524910,1,C027F5065,114,14225C,-73,-9,24
	 *    → ARFCN 524910（**SSB 频点**，手册注：与上下行频点可不一致）、SCS 1(30kHz)、
	 *      Cell_ID C027F5065、PCI 0x114=276、TAC 0x14225C=1319516。
	 *      PCI 与 ^NRSSBID 的服务小区 PCI 276 交叉验证一致。
	 * 注意：<PCI> 与 <TAC> 是**十六进制**（LTE/NR 皆然），必须按 hex 解析/展示。
	 */
	/*
	 * 3GPP 的字符串型参数模组会带引号回（实测 `^MONSC` 的 <sysmode> 回 `"NR"`，
	 * 同文件 `^HCSQ` 的解析里就是这么处理的）。若不在入口统一剥掉：
	 *   ① `rat` 变成 '"NR"'，NR / LTE 三个分支全落空，后面的字段整体错位
	 *      —— PCI 会被当成十六进制去解析 Cell_ID，rsrp 拿到 NaN；
	 *   ② 而 NaN 会一路传到界面（信号条宽度变成 `width:NaN%`）。
	 * 在每个分支里各剥一次容易漏，所以在解析入口统一剥。
	 */
	var stripQuote = function (v) {
		return String(v === undefined || v === null ? '' : v).trim().replace(/"/g, '');
	};
	var hexInt = function (v) {
		var s = stripQuote(v);
		if (s === '') return null;
		var n = parseInt(s, 16);
		return isNaN(n) ? null : n;
	};
	var num = function (v) {
		var s = stripQuote(v);
		if (s === '') return null;
		var n = parseFloat(s);
		return isNaN(n) ? null : n;   /* 空串与非数字一律转 null，不让 NaN 往界面传 */
	};
	var hasLeadingMode = p.length > 0 && !/^-?\d+$/.test(stripQuote(p[0]));
	var d;
	if (hasLeadingMode) {
		var rat = stripQuote(p[0]).toUpperCase();
		if (rat === 'NR') {
			d = {
				sysMode: 'NR',
				mcc: p[1] || '', mnc: p[2] || '',
				channel: p[3] || '',                       // ARFCN（SSB 频点）
				scs: hexInt(p[4]),
				cid: p[5] || '',
				pci: hexInt(p[6]),                         // 十六进制
				lac: p[7] || '',                           // TAC（十六进制，展示时转十进制）
				rsrp: num(p[8]), rsrq: num(p[9]), sinr: num(p[10])
			};
		} else if (rat === 'LTE') {
			d = {
				sysMode: 'LTE',
				mcc: p[1] || '', mnc: p[2] || '',
				channel: p[3] || '',
				scs: null,
				cid: p[4] || '',
				pci: hexInt(p[5]),
				lac: p[6] || '',
				rsrp: num(p[7]), rsrq: num(p[8]), sinr: null, rssi: num(p[9])
			};
		} else {
			/* WCDMA 等：手册字段与 LTE 相近（PSC 代替 PCI），按 LTE 位序宽松解析 */
			d = {
				sysMode: rat,
				mcc: p[1] || '', mnc: p[2] || '',
				channel: p[3] || '',
				cid: p[4] || '',
				pci: hexInt(p[5]),
				lac: p[6] || '',
				rsrp: num(p[7]), rsrq: num(p[8]), sinr: null
			};
		}
	} else {
		/* 旧版格式（无前导制式，原始编码值） */
		d = {
			mcc: p[0] || '',
			mnc: p[1] || '',
			lac: p[2] || '',
			cid: p[3] || '',
			pci: hexInt(p[4]),
			channel: p[5] ? p[5].trim() : '',
			rsrp: p[6] !== undefined ? convertRsrp(parseInt(p[6], 10)) : null,
			rsrq: p[7] !== undefined ? convertRsrq(parseInt(p[7], 10)) : null,
			sinr: p[8] !== undefined ? convertSinr(parseInt(p[8], 10)) : null,
			sysMode: p[9] ? p[9].replace(/"/g, '').trim() : ''
		};
	}
	d.signalPercent = calculateSignalPercent(d.rsrp);
	return d;
}

/* ---- HFREQINFO 载波 ----
 *
 * 手册 13.16.1 语法结构 / 13.16.3 参数说明：
 *   ^HFREQINFO:<n>,<sysmode>,[<band>,<dl_fcn>,<dl_freq>,<dl_bw>,<ul_fcn>,<ul_freq>,<ul_bw>] ×1..4
 *   <n>        0 禁止主动上报 / 1 使能主动上报  —— **不是载波数**
 *   <sysmode>  1 GSM / 3 WCDMA（均不支持）/ 6 LTE / 7 NR
 *   每载波固定 7 个字段，NR 最多 4 个载波；LTE 只报主小区
 *   <dl_freq>/<ul_freq>：NR 单位 kHz，LTE 单位 100kHz；<dl_bw>/<ul_bw> 单位 kHz；无效值取 0
 *   TDD（如 n41）下 <dl_fcn> 与 <ul_fcn> 相同；辅载波常只报下行，上行字段为 0
 *
 * 真实应答示例（本机 NR 双载波聚合）：
 *   ^HFREQINFO: 0,7,41,528960,2644800,60000,528960,2644800,60000,41,513000,2565000,100000,0,0,1400
 *   = n=0, sysmode=7(NR)，随后 14 个字段 = 2 个载波 × 7
 *
 * 注意：本命令**不含** RSRP/RSRQ/SINR。按载波的信号质量要另取 ^MONSSC / ^CASCELLINFO
 * （本固件分别返回 NONE / ERROR，故按载波信号不可得）。
 *
 * 历史 bug：早期实现把应答当作「每行 8 字段（kind,band,channel,bandwidth,pci,rsrp,rsrq,sinr）」，
 * 既没跳过头两个字段、也没按 7 字段分组，导致整行右移、载波数算成 1（误判单载波），
 * 还把带宽/频点当信号原始值送进 convertRsrp/convertRsrq/convertSinr，
 * 凭空造出 -44 dBm / -3 dB / 30 dB 这种假信号值。
 */

var HFREQ_SYS_MODE = { 1: 'GSM', 3: 'WCDMA', 6: 'LTE', 7: 'NR' };

function parseHFREQINFO(data) {
	var out = [];
	var lines = extractATDataMultiline(data, '^HFREQINFO');
	for (var i = 0; i < lines.length; i++) {
		var f = lines[i].split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
		if (f.length < 3) continue;
		var sysMode = HFREQ_SYS_MODE[Number(f[1])] || ('模式 ' + f[1]);
		var rest = f.slice(2).filter(function (x) { return x !== ''; });
		var n = Math.floor(rest.length / 7);
		for (var k = 0; k < n; k++) {
			var c = rest.slice(k * 7, k * 7 + 7);
			var int = function (v) { var x = parseInt(v, 10); return isFinite(x) ? x : 0; };
			var band = int(c[0]);
			var dlFreq = int(c[2]);
			var ulFcn = int(c[4]);
			var ulFreq = int(c[5]);
			/* NR 频率单位 kHz，LTE 单位 100kHz */
			var toMHz = function (v) { return v ? (sysMode === 'LTE' ? v / 10 : v / 1000) : null; };
			out.push({
				index: k,
				kind: sysMode,
				sysMode: sysMode,
				band: band || null,
				dlFcn: int(c[1]),
				dlFreqMHz: toMHz(dlFreq),
				dlBwKHz: int(c[3]) || null,
				ulFcn: ulFcn,
				ulFreqMHz: toMHz(ulFreq),
				ulBwKHz: int(c[6]) || null,
				/* 上行频点与带宽都为 0 → 该载波只报了下行（常见于辅载波 SCell） */
				downlinkOnly: !ulFcn && !ulFreq
			});
		}
	}
	return out;
}

function operatorFromCode(code) {
	if (!code) return '未知运营商';
	var table = {
		'46000': '中国移动', '46001': '中国联通', '46002': '中国移动', '46003': '中国电信',
		'46004': '中国移动', '46005': '中国电信', '46006': '中国联通', '46007': '中国移动',
		'46008': '中国移动', '46009': '中国联通', '46011': '中国电信', '46013': '中国电信'
	};
	return table[code] || code;
}

function qciLabel(qci) {
	var table = { '1': 'QCI1 (VoLTE)', '2': 'QCI2', '3': 'QCI3', '4': 'QCI4', '5': 'QCI5 (IMS信令)', '6': 'QCI6', '7': 'QCI7', '8': 'QCI8', '9': 'QCI9 (默认承载)' };
	return table[String(qci).trim()] || ('QCI' + qci);
}

/* ================= 导出 ================= */

// eslint-disable-next-line no-undef
var atClient = (function () {
	var instance = null;
	return function () {
		if (!instance) instance = new ATClient();
		return instance;
	};
})();

/*
 * 取承载 5G 流量的网络接口累计字节数。
 *
 * 与 PDCP 方案的本质区别：此路径完全不下发 AT 命令，只经 rpcd 读
 * /sys/class/net/<dev>/statistics/，因此不占用 AT 通道、不会影响模组工作。
 *
 * 返回 Promise<{success, device, rx_bytes, tx_bytes}>。
 * 速率（字节/秒）需由调用方按「两次采样差 ÷ 时间差」计算，
 * 因为单次计数是累计值，本身不含速率语义。
 */
function fetchNetRate(device) {
	return withTimeout(rpcNetRate(device || ''), 5000, '接口统计读取超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, error: (resp && resp.error) || '读不到接口计数器' };
			}
			return {
				success: true,
				device: resp.device,
				rx_bytes: Number(resp.rx_bytes) || 0,
				tx_bytes: Number(resp.tx_bytes) || 0
			};
		})
		.catch(function (err) {
			return { success: false, error: (err && err.message) || '接口统计读取失败' };
		});
}

/*
 * 取系统侧排查事实。
 * 返回 Promise<{success, facts, error}>；facts 是 key → 字符串 的扁平映射。
 * 老固件上还没有 mt5700.sysdiag 这个方法，会被 rpcd 拒掉 —— 那时页面必须
 * 明确说"后端未升级"，而不是让"一键排查"点了没反应。
 */
function fetchSysDiag() {
	return withTimeout(rpcSysDiag(), 30000, '系统排查超时（脚本未返回）')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, facts: {}, error: (resp && resp.error) || 'rpcd 没有 mt5700.sysdiag 方法' };
			}
			return { success: true, facts: resp.facts || {}, at: Number(resp.at) || 0 };
		})
		.catch(function (err) {
			return { success: false, facts: {}, error: (err && err.message) || '系统排查失败' };
		});
}

/*
 * ES9+ 转发：向指定 SM-DP+ 主机发一次 JSON POST。
 * 返回 Promise<{success, status, body}>；失败时 success=false 且带 error。
 * 超时给 60s —— 后端 curl 上限 35s，加上 rpcd 与 ucode 的开销留足余量。
 */
function es9pPost(host, path, json) {
	return withTimeout(rpcEs9p(host, path, json, 0), 60000, 'ES9+ 请求超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { success: false, status: 0, body: '', error: (resp && resp.error) || 'ES9+ 请求失败' };
			}
			return { success: true, status: Number(resp.status) || 0, body: String(resp.body || '') };
		})
		.catch(function (err) {
			return { success: false, status: 0, body: '', error: (err && err.message) || 'ES9+ 请求失败' };
		});
}

/*
 * ES9+ 通道可用性探测（不发任何网络请求，只问后端有没有 curl）。
 * 老设备 / 裁剪过的固件上没有 mt5700.es9p 这个方法，L.rpc.declare 会直接
 * 被 rpcd 拒掉 —— 那时 esim.js 必须给出「设备侧缺少通道」的明确说明，
 * 而不是让「下载」按钮点了没反应。
 */
function es9pAvailable() {
	return withTimeout(rpcEs9p('', '', '', 1), 10000, 'ES9+ 探测超时')
		.then(function (resp) {
			if (!resp || resp.success === false) {
				return { available: false, error: (resp && resp.error) || 'rpcd 没有 mt5700.es9p 方法' };
			}
			return { available: !!resp.available, error: resp.error || '' };
		})
		.catch(function (err) {
			return { available: false, error: (err && err.message) || 'rpcd 没有 mt5700.es9p 方法' };
		});
}

var AtWs = {
	client: atClient(),
	netRate: fetchNetRate,
	sysDiag: fetchSysDiag,
	es9p: es9pPost,
	es9pAvailable: es9pAvailable,
	extractATData: extractATData,
	extractATDataMultiline: extractATDataMultiline,
	convertRsrp: convertRsrp,
	convertRsrq: convertRsrq,
	convertSinr: convertSinr,
	convertRssi: convertRssi,
	calculateSignalPercent: calculateSignalPercent,
	parseHexValue: parseHexValue,
	hexToIP: hexToIP,
	parseTemperature: parseTemperature,
	formatFlow: formatFlow,
	formatSpeed: formatSpeed,
	splitSpeed: splitSpeed,
	formatDuration: formatDuration,
	parseHCSQ: parseHCSQ,
	parseMONSC: parseMONSC,
	parseHFREQINFO: parseHFREQINFO,
	parsePDCP: parsePDCP,
	parseRawData: parseRawData,
	PDCP_FIELDS: PDCP_FIELDS,
	signalColor: signalColor,
	psRegText: psRegText,
	operatorFromCode: operatorFromCode,
	qciLabel: qciLabel,
	bandName: bandName,
	isUnsolicitedText: isUnsolicitedText,
	uci: AtUci
};

/* LuCI factory 必须返回 Class 子类；挂 window.AtWs 供页面使用 */
var AtWsClass = L.Class.extend(AtWs);
if (typeof window !== 'undefined') {
	window.AtWs = new AtWsClass();
}
return AtWsClass;
