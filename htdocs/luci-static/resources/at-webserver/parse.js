'use strict';
'require baseclass';
/* global AtWs, baseclass */

/**
 * 补充解析库：运行状态 / 短信 / 锁频 / 定时锁频 / 系统配置解读 DTO。
 * 全部从原 React 前端 modem/*.ts 等价迁移，与 Rust 后端的应答格式严格一致。
 */

var Parse = (function () {
	var api = {};

	/* ================= 状态类 ================= */

	// AT^LENDC?
	api.parseLendc = function (text) {
		var match = text.match(/\^LENDC:\s*([\d,\s]+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (v) { return Number(v.trim()); })
			.filter(function (v) { return isFinite(v); });
		var v = f.length >= 5 ? f.slice(1) : f;
		if (v.length < 4) return null;
		return {
			available: v[0] === 1,
			plmnAvailable: v[1] === 1,
			restricted: v[2] === 0,
			established: v[3] === 1
		};
	};

	var INVALID_POWER = 999;
	var power = function (v) {
		var n = Number((v || '').trim());
		if (!isFinite(n) || n === INVALID_POWER) return null;
		return n;
	};

	// AT^TXPOWER?
	api.parseNrTxPower = function (text) {
		var match = text.match(/\^NTXPOWER:\s*(.+)/);
		if (!match) return [];
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var carriers = [];
		for (var i = 0; i + 4 < f.length && carriers.length < 4; i += 5) {
			var freq = Number(f[i + 4]);
			carriers.push({
				pusch: power(f[i]), pucch: power(f[i + 1]), srs: power(f[i + 2]), prach: power(f[i + 3]),
				freq: isFinite(freq) && freq !== 0 ? freq : null
			});
		}
		return carriers;
	};

	var REG_STATES = { 0: '未注册，未搜网', 1: '已注册', 2: '未注册，搜网中', 3: '注册被拒绝', 4: '未知原因', 5: '已注册（漫游）', 8: '仅紧急业务' };
	var ACT_TYPES = { 10: 'EUTRAN-5GC', 11: 'NR-5GC' };

	// AT+C5GREG?
	api.parseC5greg = function (text) {
		var match = text.match(/\+C5GREG:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
		if (f.length < 2) return null;
		var stat = Number(f[1]);
		if (!isFinite(stat)) return null;
		var act = Number(f[4]);
		return {
			stat: stat,
			statText: REG_STATES[stat] || ('状态 ' + stat),
			registered: stat === 1 || stat === 5,
			tac: f[2] || '', ci: f[3] || '',
			act: ACT_TYPES[act] || '',
			nssai: f[6] || ''
		};
	};

	var compressIPv6 = function (groups) {
		var bestStart = -1, bestLen = 0, start = -1, len = 0;
		groups.forEach(function (g, i) {
			if (g === '0') {
				if (start < 0) start = i;
				len += 1;
				if (len > bestLen) { bestLen = len; bestStart = start; }
			} else { start = -1; len = 0; }
		});
		if (bestLen < 2) return groups.join(':');
		var head = groups.slice(0, bestStart).join(':');
		var tail = groups.slice(bestStart + bestLen).join(':');
		return head + '::' + tail;
	};

	var formatPdpAddress = function (raw) {
		var parts = raw.split('.').map(function (v) { return Number(v); });
		if (parts.length === 4 && parts.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
			return { address: parts.join('.'), family: 'IPv4' };
		}
		if (parts.length === 16 && parts.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
			var groups = [];
			for (var i = 0; i < 16; i += 2) groups.push(((parts[i] << 8) | parts[i + 1]).toString(16));
			return { address: compressIPv6(groups), family: 'IPv6' };
		}
		return { address: raw, family: raw.indexOf(':') >= 0 ? 'IPv6' : '未知' };
	};

	// AT+CGPADDR
	api.parseCgpaddr = function (text) {
		return text.split(/\r?\n/)
			.map(function (line) { return line.match(/\+CGPADDR:\s*(\d+),?\s*"?([^"\r\n]*)"?/); })
			.filter(function (m) { return m !== null && m[2].trim() !== ''; })
			.map(function (m) {
				var fmt = formatPdpAddress(m[2].trim());
				return { cid: Number(m[1]), address: fmt.address, family: fmt.family };
			});
	};

	/* ================= 温度 ================= */

	// AT^CHIPTEMP?
	api.parseCHIPTEMP = function (text) {
		var match = text.match(/\^CHIPTEMP:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var g = function (i) { return f[i] !== undefined ? AtWs.parseTemperature(f[i]) : 0; };
		return { sub3GPA: g(0), sub6GPA: g(1), mimoPa: g(2), tcxo: g(3), ap1: g(4), ap2: g(5), modem1: g(6) };
	};

	/* ================= MCS ================= */

	// AT^MCS=0 / =1
	/*
	 * ^MCS 实测格式（5 字段，纯十进制文本，无字节序问题）：
	 *   ^MCS: <方向回显>,<层数>,<码字/保留>,<MCS 值>,<保留>
	 *   下行查询 AT^MCS=1 → "^MCS: 1,1,1,0,255"
	 *   上行查询 AT^MCS=0 → "^MCS: 0,1,1,20,255"
	 * f0 是查询方向回显（1=DL / 0=UL），不是 MCS；MCS 在 f3。
	 * MCS 有效值域 0-31，超出（如 255）视为无效，回退 null。
	 */
	api.parseMCS = function (text) {
		var match = text.match(/\^MCS:\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (s) { return s.trim(); });
		var mcs = f[3] !== undefined ? parseInt(f[3], 10) : NaN;
		var rank = f[1] !== undefined ? parseInt(f[1], 10) : NaN;
		return {
			mcs: (mcs >= 0 && mcs <= 31) ? mcs : null,
			rank: (rank >= 1 && rank <= 8) ? rank : null
		};
	};

	/*
	 * MCS → 调制方式显示映射（3GPP TS 38.214 MCS 表 2 口径，兼顾两例锚点）：
	 *   0-9   → QPSK
	 *   10-16 → 16QAM
	 *   17-25 → 64QAM   （上行 MCS 20 → 64QAM）
	 *   26-31 → 256QAM  （下行 MCS 27 → 256QAM）
	 * 无效值返回 null，由调用方回退既有占位符。
	 */
	api.mcsModulation = function (mcs) {
		if (mcs == null || isNaN(mcs) || mcs < 0 || mcs > 31) return null;
		if (mcs <= 9) return 'QPSK';
		if (mcs <= 16) return '16QAM';
		if (mcs <= 25) return '64QAM';
		return '256QAM';
	};

	/* ================= IPv6 CAP ================= */

	api.ipv6CapDescription = function (v) {
		if (v === 0) return '不支持 IPv6';
		if (v === 1) return '支持 IPv6';
		return '能力值 ' + v;
	};

	/* ================= 系统配置解读（SYSCFGEX，手册 13.2） =================
	 * 这几个字段都是编码/位掩码，直接摆十六进制没人看得懂，这里翻成中文/频段号。
	 */

	/*
	 * 解析 `AT^SYSCFGEX?` 应答 → { acqorder, band, roam, srvdomain, lteband }
	 *
	 * 为什么必须清洗字段：应答形如
	 *   ^SYSCFGEX: "080302",2000000680380,1,2,1E200000095\r\nOK
	 * 最后一段后面没有逗号收尾，若用 ([^,]*) 抓取会把 "\r\nOK" 一起吞进来。
	 * 这些值要原样拼回 AT^SYSCFGEX= 命令，带换行会把命令行截断成两条，
	 * 因此这里统一去掉换行与应答尾部的 OK/ERROR。
	 */
	api.parseSysCfg = function (text) {
		var m = String(text == null ? '' : text)
			.match(/\^SYSCFGEX:\s*"([^"]*)",\s*([^,]*),\s*(\d+),\s*(\d+),\s*([^,\r\n]*)/);
		if (!m) return null;
		var tok = function (v) {
			return String(v == null ? '' : v)
				.replace(/[\r\n]+/g, '')
				.replace(/\s*(OK|ERROR)\s*$/i, '')
				.trim();
		};
		return {
			acqorder: tok(m[1]), band: tok(m[2]),
			roam: Number(m[3]), srvdomain: Number(m[4]),
			lteband: tok(m[5])
		};
	};

	/* 把回读字段拼成可安全下发的 AT^SYSCFGEX 命令（空值视为「不修改」用 99/0 占位由调用方决定） */
	api.buildSysCfgCommand = function (cfg) {
		var c = cfg || {};
		var num = function (v, d) { var n = parseInt(v, 10); return isFinite(n) ? n : d; };
		return 'AT^SYSCFGEX="' + String(c.acqorder || '') + '",' + String(c.band || '') + ','
			+ num(c.roam, 1) + ',' + num(c.srvdomain, 2) + ',' + String(c.lteband || '') + ',,';
	};

	/* ================= NR 能力（NRRCCAPQRY，手册 13.26） =================
	 * 真机语法只有 AT^NRRCCAPQRY=<mode>（带 ? 的形式恒回 ERROR，实测 0/3）。
	 * 应答形如 `^NRRCCAPQRY: <mode>,<para1>,<para2>,…`，取第 1 个参数即为该能力开关。
	 * 界面用到 mode：2 = VoNR 能力、3 = NR CA 能力、5 = DSS 能力。
	 */
	api.parseNrrcCapQry = function (text, mode) {
		var m = String(text == null ? '' : text)
			.match(new RegExp('\\^NRRCCAPQRY:\\s*' + Number(mode) + '\\s*,\\s*(\\d+)'));
		return m ? Number(m[1]) : null;
	};

	/* <acqorder>：每 2 位一个制式，按顺序表示搜索优先级 */
	var ACQ_CODES = { '01': 'GSM', '02': 'WCDMA', '03': 'LTE', '04': 'CDMA 1X', '07': 'CDMA EVDO', '08': 'NR', '99': '（不修改）' };
	api.decodeAcqOrder = function (s) {
		var t = String(s == null ? '' : s).trim().replace(/^"|"$/g, '');
		if (!t) return '未设置';
		if (t === '99') return '不修改（保持原有接入次序）';
		var out = [];
		for (var i = 0; i + 1 < t.length + 1; i += 2) {
			var code = t.substr(i, 2);
			if (code.length < 2) break;
			out.push(ACQ_CODES[code] || ('未知(' + code + ')'));
		}
		return out.length ? out.join(' → ') : '未设置';
	};

	/*
	 * <band>（GSM/WCDMA 频带位掩码）。手册 13.2.3 的宏值 → 名称。
	 * 0x00680380 是手册特别标注的「自动」组合；0x3FFFFFFF=任何频带；0x40000000=不修改。
	 */
	var BAND_BITS = [
		[0x00000080, 'GSM 1800'], [0x00000100, 'GSM 900(EGSM)'], [0x00000200, 'GSM 900(PGSM)'],
		[0x00080000, 'GSM 850'], [0x00100000, 'GSM 900(铁路)'], [0x00200000, 'GSM 1900'],
		[0x00400000, 'WCDMA I (2100)'], [0x00800000, 'WCDMA II (1900)'],
		[0x04000000, 'WCDMA V (850)'], [0x08000000, 'WCDMA VI (800)'],
		[0x0002000000000000, 'WCDMA VIII (900)'], [0x0004000000000000, 'WCDMA IX (1700)'],
		[0x1000000000000000, 'WCDMA XIX (850)']
	];
	api.decodeBandMask = function (s) {
		var t = String(s == null ? '' : s).trim();
		if (!t) return '未设置';
		var v = parseInt(t, 16);
		if (isNaN(v)) return '无法解析（应为十六进制）';
		if (v === 0x3FFFFFFF) return '任何频带（不限制）';
		if (v === 0x40000000) return '不修改';
		if (t.replace(/^0+/, '').toUpperCase() === '680380') {
			return '自动（GSM 850/900/1800/1900 + WCDMA I；如需含 WCDMA 900，值为 2000000680380）';
		}
		/* 注意：JS 位运算只有 32 位，而手册里 WCDMA VIII/IX/XIX 的宏值在第 49/50/60 位，
		   所以一律用「取模 + 除法」拆位，不能用 & 1 << n。 */
		var names = [];
		var known = 0;
		BAND_BITS.forEach(function (b) {
			if (Math.floor(v / b[0]) % 2 === 1) { names.push(b[1]); known += b[0]; }
		});
		var left = v - known;
		if (left > 0) names.push('未识别位 0x' + left.toString(16).toUpperCase());
		return names.length ? names.join(' · ') : '未设置';
	};

	/* <lteband>：位掩码，第 n 位 = LTE B(n+1)（手册 13.2.3 逐条列出，与位序一致） */
	api.decodeLteBandMask = function (s) {
		var t = String(s == null ? '' : s).trim();
		if (!t) return '未设置';
		var v = parseInt(t, 16);
		if (isNaN(v)) return '无法解析（应为十六进制）';
		if (String(t).toUpperCase().replace(/^0+/, '') === '7FFFFFFFFFFFFFFF') return '任何频段（不限制）';
		var out = [];
		for (var i = 0; i <= 63; i++) {
			if (v <= 0) break;
			if (v % 2 === 1) out.push('B' + (i + 1));
			v = Math.floor(v / 2);
		}
		return out.length ? out.join(', ') : '未设置';
	};

	api.ROAM_TEXT = {
		0: '0 · 开启国内国际漫游（旧语义：不支持漫游）',
		1: '1 · 开启国内漫游、关闭国际漫游（旧语义：支持漫游）',
		2: '2 · 关闭国内漫游、开启国际漫游（旧语义：不修改）',
		3: '3 · 关闭国内国际漫游'
	};

	api.SRV_DOMAIN_TEXT = {
		0: '0 · CS_ONLY（仅电路域）',
		1: '1 · PS_ONLY（仅分组域）',
		2: '2 · CS_PS（电路 + 分组域）',
		3: '3 · ANY（任意）',
		4: '4 · 不修改'
	};


	/* ================= 补充注册/连接状态（对标 FAN789 项目用到的命令） ================= */

	/* +CEREG? / +C5GREG? 这类「<n>,<stat>」结构的通用解析 */
	api.parseRegStat = function (text, prefix) {
		var m = String(text).match(new RegExp('\\' + prefix + ':\\s*([^\\r\\n]*)'));
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
		var stat = Number(f[1]);
		if (!isFinite(stat)) return null;
		return { stat: stat, statText: REG_STATES[stat] || ('状态 ' + stat) };
	};

	/* +CIREG?（IMS 注册）：<n>,<info>；info 0=未注册 1=已注册（决定 VoLTE/VoNR/IMS 短信能否用） */
	api.parseCireg = function (text) {
		var m = String(text).match(/\+CIREG:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim(); });
		var info = Number(f[1]);
		if (isFinite(info)) return { info: info, text: info ? '已注册' : '未注册' };
		/* 有些固件返回位域形式（16 进制），退化为原样显示 */
		return { info: null, text: (f[1] || '—') };
	};

	/* ^RRCSTAT?：<enable>,<rrc_status>[,<camp_status>]（手册 13.21） */
	api.RRC_TEXT = { 0: '空闲（非连接态）', 1: '连接态', 2: 'INACTIVE（NR 非激活）', 3: '无效' };
	api.CAMP_TEXT = { 98: '已驻留', 99: '未驻留' };
	api.parseRrcstat = function (text) {
		var m = String(text).match(/\^RRCSTAT:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim(); });
		var rrc = Number(f[1]);
		var camp = f[2] !== undefined ? Number(f[2]) : null;
		return {
			enable: Number(f[0]),
			rrc: isFinite(rrc) ? rrc : null,
			rrcText: api.RRC_TEXT[rrc] || ('状态 ' + rrc),
			camp: (camp != null && isFinite(camp)) ? camp : null,
			campText: api.CAMP_TEXT[camp] || null
		};
	};


	/* +COPS?：<mode>,<format>,"<oper>",<act>（27.007）—— 当前是自动选网还是手动锁了运营商 */
	api.C0PS_MODE = { 0: '自动选网', 1: '手动选网', 2: '已注销', 3: '仅限手动', 4: '自动/手动' };
	api.C0PS_ACT = {
		0: 'GSM', 2: 'UMTS', 3: 'GSM/EGPRS', 4: 'UMTS/HSDPA', 5: 'UMTS/HSUPA', 6: 'UMTS/HSPA',
		7: 'LTE（E-UTRAN）', 8: 'CDMA2000 HRPD', 9: 'LTE-A', 10: 'LTE NB-IoT', 11: 'NR（5G）', 12: 'NR（5G）'
	};
	api.parseCops = function (text) {
		var m = String(text).match(/\+COPS:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
		var mode = Number(f[0]);
		var act = f[3] !== undefined && f[3] !== '' ? Number(f[3]) : null;
		return {
			mode: isFinite(mode) ? mode : null,
			modeText: api.C0PS_MODE[mode] || ('模式 ' + f[0]),
			oper: f[2] || '',
			act: act,
			actText: (act != null && api.C0PS_ACT[act]) ? api.C0PS_ACT[act] : (act != null ? ('制式 ' + act) : '')
		};
	};

	/* ^VERSION?：多行 ^VERSION:<KEY>:<value>；挑有用的几项 */
	api.parseVersion = function (text) {
		var out = {};
		String(text).split(/\r?\n/).forEach(function (line) {
			var m = line.match(/\^VERSION:([A-Z]+):(.*)$/);
			if (m) out[m[1]] = m[2].trim();
		});
		return (out.EXTS || out.EXTH || out.ROMSIZE) ? out : null;
	};

	/* ================= 短信 ================= */

	api.normalizePhoneNumber = function (phoneNumber) {
		if (!phoneNumber) return '';
		var normalized = phoneNumber.replace(/^\+/, '');
		if (normalized.indexOf('86') === 0 && normalized.length > 2) {
			var rest = normalized.substring(2);
			if (/^\d+$/.test(rest)) return rest;
		}
		if (/^\d+$/.test(normalized)) return normalized;
		var digits = normalized.replace(/\D/g, '');
		return digits || normalized;
	};

	/*
	 * AT 命令「参数」转义 —— 前端是 AT 通道的唯一入口，凡把用户输入拼进 AT 命令
	 * 的地方都必须过一遍，否则一个带引号或换行的值就能闭合字符串、续接第二条命令。
	 * 例如下面这个 APN 会让模组在设拨号参数的同时把射频关掉：
	 *     cmnet\r\nAT+CFUN=0\r\n
	 * 剥掉的四个字符各有讲究：
	 *   "    闭合字符串参数，是注入的基础；
	 *   \r\n  另起一行写下一条命令（后端按行下发，等于一次请求发两条）；
	 *   ; ,  参数分隔符，会让一个值变成多个参数。
	 * 只用于「参数值」；整条命令不能过这个函数（命令本身需要引号与逗号）。
	 */
	/* 逐段判 0-255：只约束形状的正则会把 999.999.999.999 也放行。 */
	api.isValidIPv4 = function (v) {
		var parts = String(v == null ? '' : v).trim().split('.');
		if (parts.length !== 4) return false;
		for (var i = 0; i < 4; i++) {
			if (!/^\d{1,3}$/.test(parts[i])) return false;
			if (Number(parts[i]) > 255) return false;
		}
		return true;
	};

	api.sanitizeAtParam = function (value) {
		return String(value == null ? '' : value).replace(/["\r\n;,]/g, '');
	};

	api.isValidPhoneNumber = function (number) {
		return /^\d{5,19}$/.test(api.normalizePhoneNumber(number));
	};

	api.formatPDUTime = function (ts) {
		var d = ts instanceof Date ? ts : new Date(ts);
		if (isNaN(d.getTime())) return new Date().toLocaleString('zh-CN');
		var pad = function (n) { return String(n).padStart(2, '0'); };
		return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
			',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
	};

	api.parseMessageTime = function (timeStr) {
		if (!timeStr) return new Date();
		var match = String(timeStr).trim().match(/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})/);
		if (match) {
			return new Date(2000 + parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10),
				parseInt(match[4], 10), parseInt(match[5], 10), parseInt(match[6], 10));
		}
		var parsed = new Date(timeStr);
		return isNaN(parsed.getTime()) ? new Date() : parsed;
	};

	/* ================= 短信 PDU 解码（等价 Rust pdu.rs / Go pdu.go） ================= */

	var GSM7_ALPHABET = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

	function gsm7Extension(c) {
		var table = {
			0x0A: '\u000C', 0x14: '^', 0x28: '{', 0x29: '}', 0x2F: '\\',
			0x3C: '[', 0x3D: '~', 0x3E: ']', 0x40: '|', 0x65: '€'
		};
		return table[c] !== undefined ? table[c] : null;
	}

	function unpackSeptets(data, count) {
		var out = [];
		var acc = 0, bits = 0;
		for (var i = 0; i < data.length && out.length < count; i++) {
			acc |= data[i] << bits;
			bits += 8;
			while (bits >= 7 && out.length < count) {
				out.push(acc & 0x7F);
				acc >>= 7;
				bits -= 7;
			}
		}
		if (bits > 0 && out.length < count) out.push(acc & 0x7F);
		return out;
	}

	function septetsToString(septets) {
		var sb = '';
		var i = 0;
		while (i < septets.length) {
			var c = septets[i];
			if (c === 0x1B && i + 1 < septets.length) {
				var ext = gsm7Extension(septets[i + 1]);
				if (ext !== null) { sb += ext; i += 2; continue; }
			}
			if (c < GSM7_ALPHABET.length) sb += GSM7_ALPHABET[c];
			else sb += '?';
			i += 1;
		}
		return sb;
	}

	/*
	 * UCS2 字节解码（PDU 用，入参为字节数组）。
	 * 注意：上方另有一个入参为 hex 字符串的 var decodeUcs2（USSD 用），
	 * var 赋值会遮蔽函数声明——若重名会让 PDU 正文整体乱码，故这里改名 _Bytes。
	 */
	function decodeUcs2Bytes(data) {
		var out = '';
		for (var i = 0; i + 1 < data.length; i += 2) {
			out += String.fromCharCode((data[i] << 8) | data[i + 1]);
		}
		return out;
	}

	function bcdDigit(b) { return (b & 0x0F) * 10 + (b >> 4); }

	function decodeTimestamp(ts) {
		if (ts.length < 7) return new Date();
		var year = 2000 + bcdDigit(ts[0]);
		var month = bcdDigit(ts[1]);
		var day = bcdDigit(ts[2]);
		var hour = bcdDigit(ts[3]);
		var minute = bcdDigit(ts[4]);
		var second = bcdDigit(ts[5]);
		if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) {
			return new Date();
		}
		return new Date(year, month - 1, day, hour, minute, second);
	}

	function decodeAddress(raw, offset) {
		var lenNibbles = raw[offset];
		var ton = (raw[offset + 1] >> 4) & 0x07;
		var start = offset + 2;
		var digits = '';
		var nibbles = lenNibbles;
		var i = start;
		while (nibbles > 0 && i < raw.length) {
			var b = raw[i];
			var d1 = b & 0x0F;
			var d2 = (b >> 4) & 0x0F;
			if (d1 < 0x0F) digits += String(d1);
			if (d2 < 0x0F) digits += String(d2);
			nibbles -= 2;
			i += 1;
		}
		if (ton === 5) {
			var alphaBytes = raw.slice(start, i);
			/* 半字节长度折算 septet 数：向下取整（多余填充位不构成字符） */
			var septets = unpackSeptets(alphaBytes, Math.floor(lenNibbles * 4 / 7));
			return { address: septetsToString(septets), ton: ton };
		}
		if (ton === 1) return { address: '+' + digits, ton: ton };
		return { address: digits, ton: ton };
	}

	/*
	 * TP-DCS 编码判定（3GPP TS 23.038）：
	 *   0x00-0x3F 一般数据编码组：bit3-2 选编码（00=7bit 01=8bit 10=UCS2）
	 *   0x40-0xBF 保留/自动丢弃组：按 bit3-2 判定
	 *   0xC0-0xDF 消息等待组：bit3=1 为 UCS2，否则 GSM7
	 *   0xF0-0xFF 数据编码/消息类别组：固定 GSM7（bit3-2 是类别不是编码！）
	 * 返回 0=GSM7 / 1=8bit / 2=UCS2。
	 * 旧实现用 dcs & 0x0C，会把 F 组的类别位误读成编码位导致乱码。
	 */
	function dcsEncoding(dcs) {
		var group = dcs >> 4;
		if (group === 0xC || group === 0xD || group === 0xE) {
			return (dcs & 0x08) ? 2 : 0;
		}
		if (group === 0xF) {
			return 0;
		}
		return (dcs >> 2) & 0x03;
	}

	// 解析一条 SMS-DELIVER PDU（hex），返回 { sender, content, date, partial }
	api.decodeIncomingPdu = function (hex) {
		var raw = [];
		for (var i = 0; i + 1 < hex.length; i += 2) {
			raw.push(parseInt(hex.slice(i, i + 2), 16));
		}
		if (raw.length < 2) return null;
		var smscLen = raw[0];
		var pos = 1 + smscLen;
		if (pos >= raw.length) return null;
		var firstOctet = raw[pos];
		var mti = firstOctet & 0x03;
		if (mti !== 0) return null; // 只处理 SMS-DELIVER
		pos += 1;
		var oaLen = raw[pos];
		if (pos + 1 + Math.ceil(oaLen / 2) > raw.length) return null;
		var addr = decodeAddress(raw, pos);
		pos += 2 + Math.ceil(oaLen / 2);
		if (pos + 1 >= raw.length) return null;
		var pid = raw[pos]; pos += 1;
		var dcs = raw[pos]; pos += 1;
		if (pos + 7 > raw.length) return null;
		var ts = raw.slice(pos, pos + 7);
		var date = decodeTimestamp(ts);
		pos += 7;
		if (pos >= raw.length) return null;
		var udl = raw[pos]; pos += 1;
		/*
		 * 长度口径必须和下面的解码口径同源。旧实现用 dcs & 0x0C 推长度、又用
		 * dcsEncoding 决定怎么解，两者对 0xF 组（数据编码/消息类别组）结论相反：
		 * 该组的 bit3-2 是消息类别、不是编码，固定按 GSM7 处理，而旧的长度分支
		 * 会当 8bit/UCS2 取字节数，正文因此被截断或读到界外。
		 * 已按 256 个 DCS 全量自检：差异只落在 0xF 组，常见 DCS 完全等价。
		 */
		var enc = dcsEncoding(dcs);
		var udLen;
		if (enc === 1) udLen = udl;
		else if (enc === 2) udLen = udl * 2;
		else udLen = Math.ceil(udl * 7 / 8);
		var ud = raw.slice(pos, Math.min(pos + udLen, raw.length));

		var content = '';
		var partial = null;
		var udhi = (firstOctet & 0x40) !== 0;
		var userData = ud;
		var headerLen = 0;

		if (udhi && ud.length > 0) {
			headerLen = ud[0];
			var hdr = ud.slice(1, 1 + headerLen);
			userData = ud.slice(1 + headerLen);
			var p = 0;
			while (p + 1 < hdr.length) {
				var iei = hdr[p];
				var iel = hdr[p + 1];
				if (p + 2 + iel > hdr.length) break;
				var ieData = hdr.slice(p + 2, p + 2 + iel);
				if (iei === 0x00 && iel >= 3) {
					partial = { reference: ieData[0], parts_count: ieData[1], part_number: ieData[2] };
				} else if (iei === 0x08 && iel >= 4) {
					partial = { reference: ((ieData[0] << 8) | ieData[1]), parts_count: ieData[2], part_number: ieData[3] };
				}
				p += 2 + iel;
			}
		}

		if (enc === 2) {
			content = decodeUcs2Bytes(userData);
		} else if (enc === 1) {
			var c8 = '';
			for (var k = 0; k < userData.length; k++) c8 += String.fromCharCode(userData[k]);
			content = c8;
		} else {
			/*
			 * 7-bit：UDH 占用的 septet 数按其八位组长度折算，
			 * 必须先解「完整 UD 字节流」的 septet 序列、再跳过头部码位；
			 * 旧实现先按字节切掉 UDH 再解包，位流错位导致长短信正文乱码。
			 */
			var udhSeptets = (udhi && ud.length > 0) ? Math.ceil((ud[0] + 1) * 8 / 7) : 0;
			var totalSeptets = Math.max(udl, udhSeptets);
			var septets = unpackSeptets(ud, totalSeptets);
			content = udhSeptets <= septets.length
				? septetsToString(septets.slice(udhSeptets))
				: '';
		}

		return { sender: addr.address, content: content, date: date, partial: partial };
	};

	// 解析 CMGL=4 应答（PDU 块 / 已解码文本行），输出 SMS[]（等价 modem/sms.ts parseCMGL + PDU 解析）
	api.parseCMGL = function (data) {
		var sms = [];
		var text = data;
		try {
			var jsonData = JSON.parse(data);
			if (jsonData.success && jsonData.data) text = jsonData.data;
		} catch (e) { /* not json */ }
		if (typeof text !== 'string') return sms;

		var blocks = text.split(/(?=\+CMGL:\s*\d+)/);
		for (var b = 0; b < blocks.length; b++) {
			var block = blocks[b];
			var idxM = block.match(/\+CMGL:\s*(\d+)/);
			var idx = idxM ? parseInt(idxM[1], 10) : null;
			if (!idxM) continue;

			/* 状态位 <stat>：PDU 模式是数字，文本模式是带引号的 "REC UNREAD" 等。
			   按鼎桥《AT 命令手册》9.8/9.10：0=收到的未读短信，1=已读，
			   2/3=存储的未发送/已发送。
			   文本模式第二字段以引号开头，不会被这条数字正则命中，故不会串味。 */
			var statM = block.match(/\+CMGL:\s*\d+\s*,\s*(\d+)\s*,/);
			var stat = statM ? parseInt(statM[1], 10) : null;

			// 已解码文本行：+CMGL: idx,"REC READ","<number>",,"<time>"
			var simple = block.match(/\+CMGL:\s*\d+,"([^"]*)","([^"]*)",,"([^"]*)"/);
			if (simple) {
				sms.push({
					index: idx,
					content: block.split('\n').slice(1).join('\n').trim(),
					number: api.normalizePhoneNumber(simple[2] || ''),
					time: simple[3] || '',
					type: simple[1].indexOf('REC') === 0 ? 'received' : 'sent',
					unread: /UNREAD/i.test(simple[1] || '')
				});
				continue;
			}

			// PDU 块：+CMGL: idx,stat,,,<len> 下一行是 PDU hex
			var lines = block.split('\n').map(function (l) { return l.trim(); });
			var pduHex = '';
			for (var li = 0; li < lines.length; li++) {
				if (/^[0-9A-Fa-f]{20,}$/.test(lines[li])) { pduHex = lines[li]; break; }
			}
			if (pduHex) {
				var decoded = api.decodeIncomingPdu(pduHex);
				if (decoded) {
					sms.push({
						index: idx,
						content: decoded.content,
						number: api.normalizePhoneNumber(decoded.sender || ''),
						time: api.formatPDUTime(decoded.date),
						type: 'received',
						unread: stat === 0,
						isConcatenated: !!decoded.partial,
						concatenatedRef: decoded.partial ? decoded.partial.reference : undefined,
						concatenatedSeq: decoded.partial ? decoded.partial.part_number : undefined,
						concatenatedTotal: decoded.partial ? decoded.partial.parts_count : undefined
					});
				}
			}
		}
		return sms;
	};

	// 短信中心保存的已发消息缓存（等价原 localStorage sms_sent_messages_cache）
	api.SMS_CACHE_KEY = 'sms_sent_messages_cache';
	api.MAX_SMS_CACHE = 1000;

	api.getCachedSentMessages = function () {
		try {
			var raw = localStorage.getItem(api.SMS_CACHE_KEY);
			if (!raw) return [];
			var parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed;
		} catch (e) { /* ignore */ }
		return [];
	};

	api.saveSentMessageToCache = function (msg) {
		var list = api.getCachedSentMessages();
		list.unshift(msg);
		if (list.length > api.MAX_SMS_CACHE) list = list.slice(0, api.MAX_SMS_CACHE);
		try { localStorage.setItem(api.SMS_CACHE_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
		return list;
	};

	api.clearSentMessageCache = function () {
		try { localStorage.removeItem(api.SMS_CACHE_KEY); } catch (e) { /* ignore */ }
	};

	/* ================= 锁频 ================= */

	api.LOCK_TYPES = [
		{ label: '关闭', value: 0 }, { label: '锁定频点', value: 1 },
		{ label: '锁定小区', value: 2 }, { label: '锁定 Band', value: 3 }
	];
	api.LTE_BANDS = [
		{ label: 'B1 2100MHz', value: 1 }, { label: 'B3 1800MHz', value: 3 }, { label: 'B5 850MHz', value: 5 },
		{ label: 'B8 900MHz', value: 8 }, { label: 'B34 2100MHz TDD', value: 34 }, { label: 'B38 2600MHz TDD', value: 38 },
		{ label: 'B39 1900MHz TDD', value: 39 }, { label: 'B40 2300MHz TDD', value: 40 }, { label: 'B41 2500MHz TDD', value: 41 }
	];
	api.NR_BANDS = [
		{ label: 'n1 2100MHz', value: 1 }, { label: 'n3 1800MHz', value: 3 }, { label: 'n5 850MHz', value: 5 },
		{ label: 'n8 900MHz', value: 8 }, { label: 'n28 700MHz', value: 28 }, { label: 'n41 2500MHz', value: 41 },
		{ label: 'n77 3700MHz', value: 77 }, { label: 'n78 3500MHz', value: 78 }, { label: 'n79 4700MHz', value: 79 }
	];
	api.SCS_TYPES = [
		{ label: '15 kHz', value: 0 }, { label: '30 kHz', value: 1 }, { label: '60 kHz', value: 2 },
		{ label: '120 kHz', value: 3 }, { label: '240 kHz', value: 4 }
	];
	api.MAX_LOCK_ITEMS = 20;
	api.MAX_ARFCN = 4294967295;
	api.MAX_PCI = { lte: 503, nr: 1007 };

	api.getDefaultScsType = function (band) {
		// mmWave: 257/258/260/261 -> 3 (120kHz)，TDD 常用 -> 1 (30kHz)，其余 0
		if ([257, 258, 260, 261].indexOf(Number(band)) >= 0) return 3;
		if ([41, 48, 77, 78, 79].indexOf(Number(band)) >= 0) return 1;
		return 0;
	};

	var checkArfcn = function (label, raw) {
		if (!/^\d+$/.test(raw)) throw new Error(label + ' 频点必须为 0-' + api.MAX_ARFCN + ' 的整数');
		if (Number(raw) > api.MAX_ARFCN) throw new Error(label + ' 频点超出范围（0-' + api.MAX_ARFCN + '）');
		return raw;
	};
	var checkPci = function (kind, raw) {
		var max = api.MAX_PCI[kind];
		var label = kind === 'lte' ? 'LTE' : 'NR';
		if (!/^\d+$/.test(raw)) throw new Error(label + ' PCI 必须为 0-' + max + ' 的整数');
		if (Number(raw) > max) throw new Error(label + ' PCI 超出范围（0-' + max + '）');
		return raw;
	};

	api.toLockLists = function (kind, type, items) {
		var empty = { type: type, bands: '', arfcns: '', scs_types: '', pcis: '' };
		if (type === 0) return empty;
		var label = kind === 'lte' ? 'LTE' : 'NR';
		var valid = items.filter(function (i) { return i.band != null; });
		if (!valid.length) throw new Error('请至少输入一个有效的 ' + label + ' 频段');
		if (valid.length > api.MAX_LOCK_ITEMS) throw new Error(label + ' 最多只能锁 ' + api.MAX_LOCK_ITEMS + ' 组');
		var bands = valid.map(function (i) { return String(i.band); }).join(',');
		if (type === 3) return { type: type, bands: bands, arfcns: '', scs_types: '', pcis: '' };
		var arfcns = valid.map(function (i) { return checkArfcn(label, String(i.arfcn || '').trim()); }).join(',');
		var scs_types = kind === 'nr' ? valid.map(function (i) { return String(i.scs != null ? i.scs : api.getDefaultScsType(i.band)); }).join(',') : '';
		if (type === 1) return { type: type, bands: bands, arfcns: arfcns, scs_types: scs_types, pcis: '' };
		var pcis = valid.map(function (i) { return checkPci(kind, String(i.pci || '').trim()); }).join(',');
		return { type: type, bands: bands, arfcns: arfcns, scs_types: scs_types, pcis: pcis };
	};

	// 前端拼锁频命令（即时生效场景）
	api.buildLockCommand = function (kind, type, mobility, items) {
		var cmd = kind === 'lte' ? 'AT^LTEFREQLOCK' : 'AT^NRFREQLOCK';
		if (type === 0) return cmd + '=0';
		var l = api.toLockLists(kind, type, items);
		var num = l.bands.split(',').length;
		var head = cmd + '=' + type + ',' + mobility + ',' + num;
		if (type === 3) return head + ',"' + l.bands + '"';
		if (kind === 'lte') {
			return type === 1
				? head + ',"' + l.bands + '","' + l.arfcns + '"'
				: head + ',"' + l.bands + '","' + l.arfcns + '","' + l.pcis + '"';
		}
		return type === 1
			? head + ',"' + l.bands + '","' + l.arfcns + '","' + l.scs_types + '"'
			: head + ',"' + l.bands + '","' + l.arfcns + '","' + l.scs_types + '","' + l.pcis + '"';
	};

	api.fromLockLists = function (kind, lists) {
		var split = function (v) { return (v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean); };
		var bands = split(lists.bands);
		if (!bands.length) return [{}];
		var arfcns = split(lists.arfcns);
		var scs = split(lists.scs_types);
		var pcis = split(lists.pcis);
		return bands.map(function (band, i) {
			return {
				band: Number(band), arfcn: arfcns[i], pci: pcis[i],
				scs: kind === 'nr' ? (scs[i] != null ? Number(scs[i]) : api.getDefaultScsType(Number(band))) : undefined
			};
		});
	};

	/* ================= 定时锁频 DTO ================= */

	// AT+SCHED? -> "+SCHED: {json}\r\nOK"
	api.parseScheduleResponse = function (data) {
		var json = String(data).match(/\+SCHED:\s*(\{[\s\S]*\})/);
		if (!json) return null;
		try { return JSON.parse(json[1]); } catch (e) { return null; }
	};

	api.buildScheduleSetCommand = function (cfg) {
		var payload = {};
		Object.keys(cfg).forEach(function (k) { if (k !== 'status') payload[k] = cfg[k]; });
		return 'AT+SCHED=' + JSON.stringify(payload);
	};

	api.modeText = function (mode) { return mode === '' ? '当前时段不锁频' : mode; };

	/* ================= 辅载波/辅站小区（carrier.ts 等价迁移） ================= */
	// 手册 13.27 AT^MONSSC — NSA 下 5G 辅连接服务小区（最多 8CC）
	// 手册 13.18 AT^CASCELLINFO? — LTE CA 的辅小区（最多 4 个 SCELL）
	// ^HFREQINFO 只给频点与带宽，这两条补每个辅载波各自的信号质量。

	var MEAS_TYPES = { 0: 'SSB', 1: 'CSI-RS' };
	var NR_INVALID = { rsrp: -1256, rsrq: -348, sinr: -188 };
	// 手册 13.18.3 <ulbw>/<dlbw>
	var LTE_BANDWIDTHS = { 0: 1.4, 1: 3, 2: 5, 3: 10, 4: 15, 5: 20 };

	var descale = function (value, min, max) {
		return value < min || value > max ? Number((value / 8).toFixed(1)) : value;
	};
	var numOrNull = function (v) {
		var t = String(v == null ? '' : v).trim();
		if (t === '') return null;
		var n = Number(t);
		return isFinite(n) ? n : null;
	};

	/*
	 * 解析 ^NRSSBID（手册 13.28）：SA 连接态且网侧配置测量时，报服务小区
	 * 与最多 4 个邻区的 SSB 测量。这是本固件在 SA 下**唯一**能拿到
	 * 其他小区 PCI/RSRP/SINR 的途径（^MONSSC 仅 NSA、^CASCELLINFO 仅 LTE CA）。
	 * 注意：邻区测量**不含 RSRQ**。
	 * 结构：ARFCN,CID,PCI,RSRP,SINR,TA, 8×(SSBID,RSRP), N_NB,
	 *       N×[PCI,ARFCN,RSRP,SINR, 4×(SSBID,RSRP)]
	 * 无效值：PCI 0xFFFF、RSRP/SINR 0x7FFF、ARFCN 0xFFFFFFFF。
	 */
	api.parseNrssbid = function (text) {
		var m = String(text).match(/\^NRSSBID:\s*([^\r\n]*)/);
		if (!m) return null;
		var f = m[1].split(',').map(function (s) { return s.trim(); });
		if (f.length < 23) return null;
		var valid = function (v, bad) {
			var n = numOrNull(v);
			return (n === null || bad.indexOf(n) >= 0) ? null : n;
		};
		/* 波束对：每 2 个字段是 (SSBID, RSRP)，RSRP 无效值 32767 直接丢弃 */
		var beamsOf = function (from, count) {
			var out = [];
			for (var i = 0; i < count; i++) {
				var id = numOrNull(f[from + i * 2]);
				var rsrp = valid(f[from + i * 2 + 1], [32767]);
				if (id === null || rsrp === null || id === 255) continue;
				out.push({ id: id, rsrp: rsrp });
			}
			return out;
		};
		var serving = {
			arfcn: valid(f[0], [4294967295]),
			cid: f[1] || '',
			pci: valid(f[2], [65535]),
			rsrp: valid(f[3], [32767]),
			sinr: valid(f[4], [32767]),
			ta: numOrNull(f[5]),
			beams: beamsOf(6, 8)
		};
		if (serving.arfcn === null) return null;
		var nNb = numOrNull(f[22]) || 0;
		var neighbors = [];
		for (var i = 0; i < nNb; i++) {
			var o = 23 + i * 12;
			if (o + 3 >= f.length) break;
			var nb = {
				pci: valid(f[o], [65535]),
				arfcn: valid(f[o + 1], [4294967295]),
				rsrp: valid(f[o + 2], [32767]),
				sinr: valid(f[o + 3], [32767]),
				beams: beamsOf(o + 4, 4)
			};
			if (nb.arfcn !== null) neighbors.push(nb);
		}
		return { serving: serving, neighbors: neighbors };
	};

	/*
	 * 解析 ^MONNC（当前邻区）：每行 `^MONNC: <RAT>,<arfcn>,<pci_hex>,<rsrp>,<rsrq>[,<sinr>]`。
	 * NR 的 RSRP/RSRQ/SINR 在超范围时是 ×8 定点（如 -1256），这里还原；
	 * PCI 是十六进制（实测出现过 "10A" / "16B"）。
	 */
	api.parseMonncAll = function (text) {
		var out = [];
		String(text).split(/\r?\n/).forEach(function (line) {
			var m = line.match(/\^MONNC:\s*(\w+)\s*(?:,(.+))?/);
			if (!m || m[1] === 'NONE' || !m[2]) return;
			var v = m[2].split(',').map(function (s) { return s.trim().replace(/"/g, ''); });
			var cell = { rat: m[1], arfcn: numOrNull(v[0]), pci: parseInt(v[1], 16) };
			/* 无效码按「无测量」处理：RSRP -157/-1256、RSRQ -44/-348、SINR -24/-188 */
			var fix = function (raw, big, invalid) {
				var n = numOrNull(raw);
				if (n === null) return null;
				if (invalid.indexOf(n) >= 0) return null;
				var val = Math.abs(n) > big ? Number((n / 8).toFixed(1)) : n;
				return invalid.indexOf(val) >= 0 ? null : val;
			};
			if (m[1] === 'NR') {
				cell.rsrp = fix(v[2], 157, [-157, -1256]);
				cell.rsrq = fix(v[3], 43.5, [-44, -348, -5.5]);
				cell.sinr = fix(v[4], 40, [-24, -188, -23.5]);
			} else {
				var rsrp = numOrNull(v[2]);
				var rsrq = numOrNull(v[3]);
				cell.rsrp = (rsrp === null || rsrp <= -140) ? null : rsrp;
				cell.rsrq = (rsrq === null || rsrq <= -20) ? null : rsrq;
			}
			cell.band = api.arfcnToBand(m[1], cell.arfcn);
			out.push(cell);
		});
		return out;
	};

	/* ARFCN → 频段号（常用频段表；测不准返回 null，调用方按 null 处理） */
	api.arfcnToBand = function (rat, arfcn) {
		var n = numOrNull(arfcn);
		if (n === null) return null;
		var table = rat === 'LTE'
			? [[1, 0, 599], [3, 1200, 1949], [5, 2400, 2649], [8, 3450, 3799],
				[34, 36200, 36349], [38, 37750, 38249], [39, 38250, 38649],
				[40, 38650, 39649], [41, 39650, 41589]]
			: [[1, 422000, 434000], [3, 376000, 396000], [5, 173800, 175000], [8, 185000, 192000],
				[28, 151600, 160600], [41, 499200, 537999], [77, 620000, 680000],
				[78, 620000, 653333], [79, 693334, 733333]];
		for (var i = 0; i < table.length; i++) {
			if (n >= table[i][1] && n <= table[i][2]) return table[i][0];
		}
		return null;
	};

	/* NR-ARFCN → MHz（3GPP 全局栅格：<600000 时 5kHz 步进，以上 15kHz） */
	api.nrArfcnToMHz = function (n) {
		n = Number(n);
		if (!isFinite(n) || n <= 0) return null;
		return n < 600000 ? n * 0.005 : 3000 + (n - 600000) * 0.015;
	};

	/* ================= 网络拒绝原因 ^REJINFO（reject.ts 等价迁移） ================= */
	// 手册 13.14：注册或业务请求或网络 DETACH 过程被网络拒绝时主动上报。
	// 锁频锁错小区导致掉网时，这条上报能直接区分"被网络拒绝"和"根本没覆盖"。

	var REJ_DOMAINS = { 0: 'CS 域', 1: 'PS 域', 2: 'CS+PS 域' };
	var REJ_RATS = {
		0: 'GERAN(2G)', 1: 'UTRAN(3G)', 2: 'E-UTRAN(4G)',
		5: 'NR-5GC(5G SA)', 6: '其他'
	};
	var REJ_TYPES = {
		0: 'LAU 被拒', 1: '鉴权失败', 2: '业务请求被拒', 3: '网络 detach 被拒',
		4: 'ATTACH 被拒', 5: 'RAU 被拒', 6: 'TAU 被拒'
	};
	// 原因值来自 3GPP TS 24.008 / 24.301 / 24.501，未收录的原样显示编号
	var REJ_CAUSES = {
		2: 'IMSI 未在 HSS 登记', 3: '非法终端', 5: 'IMEI 不被接受', 6: '非法设备',
		7: '不允许使用分组域业务', 8: '不允许使用分组域和非分组域业务', 9: '网络无法识别终端身份',
		10: '已被网络隐式分离', 11: '不允许使用该 PLMN', 12: '不允许在该跟踪区注册',
		13: '该跟踪区不允许漫游', 14: '该 PLMN 不提供分组域业务', 15: '跟踪区内没有合适的小区',
		16: 'MSC 暂时不可达', 17: '网络故障', 18: 'CS 域不可用', 19: 'ESM 流程失败',
		20: 'MAC 校验失败', 21: '同步失败', 22: '网络拥塞', 23: '终端安全能力不匹配',
		24: '安全模式被拒绝', 25: '未授权接入该 CSG', 26: '非 EPS 鉴权不可接受',
		27: '不允许使用 N1 模式', 28: '受限的服务区域', 31: '需要重定向到 4G 核心网',
		35: '该 PLMN 未授权所请求的业务', 39: 'CS 业务暂时不可用', 40: '没有激活的 EPS 承载',
		42: '严重网络故障', 43: 'LADN 不可用', 62: '没有可用的网络切片',
		65: '已达到 PDU 会话数量上限', 67: '切片与 DNN 资源不足',
		71: '不允许通过非 3GPP 接入 5G 核心网', 72: '服务网络未授权',
		95: '消息语义错误', 96: '必选信元无效', 97: '消息类型不存在或未实现',
		98: '消息类型与协议状态不匹配', 99: '信元不存在或未实现',
		100: '条件信元错误', 101: '消息与协议状态不匹配', 111: '协议错误',
		256: '鉴权失败（模组内部扩展）', 258: '联合注册中 CS 失败（其他原因）',
		301: 'CS/PS 注册网络无响应', 302: 'CS/PS 注册建链异常', 303: 'CS/PS 注册建链异常'
	};
	// 手册 13.14.2：USIM 鉴权失败的原因值从 65537 开始，共 65537~65543
	var USIM_CAUSE_MIN = 65537, USIM_CAUSE_MAX = 65543;

	api.rejectCauseText = function (cause) {
		if (REJ_CAUSES[cause]) return REJ_CAUSES[cause];
		if (cause >= USIM_CAUSE_MIN && cause <= USIM_CAUSE_MAX) return 'USIM 鉴权失败（#' + cause + '）';
		return '未知原因（#' + cause + '）';
	};

	// 解析一行 ^REJINFO 上报，不匹配时返回 null。手册正文用了全角冒号，两种都收。
	api.parseRejInfo = function (line) {
		var match = line.match(/\^REJINFO[：:]\s*(.+)/);
		if (!match) return null;
		var f = match[1].split(',').map(function (v) { return v.trim(); });
		if (f.length < 6) return null;
		var unquote = function (v) { return String(v == null ? '' : v).trim().replace(/^"|"$/g, ''); };
		var num = function (v) {
			var n = Number(unquote(v));
			return isFinite(n) ? n : 0;
		};
		var domain = num(f[1]), cause = num(f[2]), rat = num(f[3]), rejectType = num(f[4]);
		return {
			plmn: unquote(f[0]),
			domain: domain,
			domainText: REJ_DOMAINS[domain] != null ? REJ_DOMAINS[domain] : '域 ' + domain,
			cause: cause,
			causeText: api.rejectCauseText(cause),
			rat: rat,
			ratText: REJ_RATS[rat] != null ? REJ_RATS[rat] : '制式 ' + rat,
			rejectType: rejectType,
			rejectTypeText: REJ_TYPES[rejectType] != null ? REJ_TYPES[rejectType] : '类型 ' + rejectType,
			originalCause: num(f[5]),
			lac: unquote(f[6] || ''),
			rac: unquote(f[7] || ''),
			cellId: unquote(f[8] || ''),
			// 手册：当 LNAS 注册被拒绝 #19 时才会带上这个值
			esmCause: f[9] !== undefined ? num(f[9]) : undefined,
			raw: line.trim(),
			at: Date.now()
		};
	};

	/* ================= SIM 卡状态 ^SIMSQ（手册 6.6） ================= */

	/*
	 * SIM 状态码表 —— **全插件唯一真源**。
	 * mt5700.js（顶部状态芯片）与 network_status.js（SIM 徽章）只准消费
	 * simShort() / simIsWarn() / simDetail()，不许再各抄一份 —— 此前三处各写一份，
	 * 改一次文案要改三遍，迟早漏一处。
	 *
	 * ★ 11 与 12 到底差在哪（2026-09-14 真机结论，推翻了此前「11 就不能发短信」的判断）：
	 *   手册写的是「12 才算短信与电话可接入」。但本卡长期停在 1,11，实测：
	 *     · 短信收发完全正常（CPMS "SM",44,50，向 10086 实发并收到回复）；
	 *     · 开机自愈推 HVSST 之后状态**仍停在 11**，根本推不动。
	 *   也就是说 11 既不影响短信，也不是能靠推卡修好的故障 —— 它是这张卡的常态。
	 *   所以 11 不再算告警态，文案也不再写「短信未接入」这种与实际不符、还吓人的话。
	 */
	var SIM_STATUS = {
		0: '卡不在位', 1: '卡已插入', 2: '卡被 PIN/PUK 锁定', 3: 'SIMLOCK 锁定',
		10: '卡文件初始化中',
		11: '卡初始化完成，可接入网络（手册标注「短信与电话未接入」；本机实测 11 下短信收发正常）',
		12: '卡初始化完成，短信与电话可接入', 98: '卡已失效（PUK 锁死或物理损坏）',
		99: '卡已移除', 100: '卡初始化失败'
	};

	/* 徽章 / 状态芯片用的短标签（详细说明走 simDetail） */
	var SIM_STATUS_SHORT = {
		0: '未插卡', 1: '已插卡', 2: 'PIN 锁定', 3: 'SIM 锁定',
		10: '初始化中', 11: '已初始化 · 可接入网络', 12: '就绪 · 短信与电话可接入',
		98: '卡失效', 99: '已移除', 100: '卡错误'
	};

	/*
	 * 哪些状态要点提示色。
	 * ★ 11 刻意**不**告警：本卡常态，且短信不受影响（见上）。
	 *   1（已插卡）只是过渡态，同样不告警。
	 *   未收录的状态按「告警」处理（保守：宁可提示，不要漏）。
	 */
	var SIM_STATUS_WARN = {
		0: true, 1: false, 2: true, 3: true,
		10: true, 11: false, 12: false,
		98: true, 99: true, 100: true
	};

	function simLabel(table, s) {
		if (s == null || s === '') return '未知';
		return table[s] != null ? table[s] : '状态 ' + s;
	}

	api.simDetail = function (s) { return simLabel(SIM_STATUS, s); };
	api.simShort = function (s) { return simLabel(SIM_STATUS_SHORT, s); };
	api.simIsWarn = function (s) {
		if (s == null || s === '') return false;   // 没读到状态时不该报警
		return SIM_STATUS_WARN[s] !== false;
	};

	api.parseSimsq = function (text) {
		var match = String(text).match(/\^SIMSQ:\s*(\d+)\s*,\s*(\d+)/);
		if (!match) return null;
		var status = Number(match[2]);
		return {
			status: status,
			label: api.simDetail(status),
			shortLabel: api.simShort(status),
			warn: api.simIsWarn(status),
			dead: status === 98,
			present: status !== 0 && status !== 99
		};
	};

	return api;
})();

/*
 * LuCI requires factory to return a Class subclass (instantiated once).
 * Also set window.Parse for page-side global.
 */
var ParseClass = L.Class.extend(Parse);
if (typeof window !== 'undefined') {
	window.Parse = new ParseClass();
}
return ParseClass;
