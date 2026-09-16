'use strict';
'require baseclass';
/* global baseclass */

/**
 * 短信发送 PDU 编码器（等价原前端 node-pdu 的 SMS-SUBMIT 编码）。
 * 3GPP 23.040 / 23.038：
 * - GSM 7bit 打包（低位在前），非 GSM 字符自动切 UCS2
 * - 长短信自动分片并带 8-bit 拼接头（IEI 0x00）
 * - SMSC 地址打包、TPDU 长度计算
 */

var SmsEncode = (function () {
	var api = {};

	var GSM7_ALPHABET = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

	/*
	 * GSM7 扩展表：这些字符要写成 ESC(0x1B) + 下面这个字节，因此每个占 2 个 septet。
	 * 取值**必须**与解码端 `src/rust/src/pdu.rs::gsm7_extension` 逐项一致。
	 * 早期实现用的是「私有字符串的下标」（比如 '^' → 1、'€' → 2），那是错的：
	 * 收件人会把 '^' 解成 ESC+£、'€' 解成 ESC+$，凡含这些字符的短信全是乱码。
	 */
	var EXT_MAP = { '^': 0x14, '{': 0x28, '}': 0x29, '\\': 0x2f, '[': 0x3c, '~': 0x3d, ']': 0x3e, '|': 0x40, '€': 0x65 };
	var EXT_CHARS = '^' + '{' + '}' + '\\' + '[' + '~' + ']' + '|' + '€';

	function isExtChar(ch) {
		return Object.prototype.hasOwnProperty.call(EXT_MAP, ch);
	}

	function gsm7Code(ch) {
		var basic = GSM7_ALPHABET.indexOf(ch);
		if (basic >= 0) return basic;
		if (isExtChar(ch)) return EXT_MAP[ch];
		var code = ch.charCodeAt(0);
		if (code === 0x0d) return 13;
		if (code === 0x0a) return 10;
		if (code === 0x00) return 0;
		return null;
	}

	// 把字符列表编码成 7bit 位流（低位在前）。扩展字符输出 0x1B + 表内真值。
	function packSeptets(chars) {
		var bits = [];
		for (var i = 0; i < chars.length; i++) {
			var c = gsm7Code(chars[i]);
			if (c === null) return null;
			if (isExtChar(chars[i])) {
				pushBits(bits, 0x1b, 7);
				pushBits(bits, c, 7);
			} else {
				pushBits(bits, c, 7);
			}
		}
		return bits;
	}

	function pushBits(bits, value, count) {
		for (var i = 0; i < count; i++) {
			bits.push((value >> i) & 1);
		}
	}

	function bitsToOctets(bits) {
		var octets = [];
		for (var i = 0; i + 7 < bits.length; i += 8) {
			var b = 0;
			for (var j = 0; j < 8; j++) b |= bits[i + j] << j;
			octets.push(b);
		}
		// 剩余不足 8 位也补一个字节
		if (bits.length % 8 !== 0) {
			var last = 0;
			var start = Math.floor(bits.length / 8) * 8;
			for (var j = start; j < bits.length; j++) last |= bits[j] << (j - start);
			octets.push(last);
		}
		return octets;
	}

	function octetsToHex(octets) {
		return octets.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('').toUpperCase();
	}

	// SMSC 地址编码：+8613800755500 -> 08 91 683108705505F0
	// 目的地址编码：10086 -> 05 81 0180F6
	//
	// 两种地址的「长度」字段语义不同，必须分开计算（此前统一按字节数算，导致 PDU 错位）：
	//   - SMSC（SCA）：长度 = 后续字节总数 = 地址字节数 + TOA 自身 1 字节
	//   - 目的/源地址（TP-DA/TP-OA）：长度 = 号码的数字位数（3GPP 23.040 第 9.1.2.5 节）
	// 例：+8613800755500 有 13 位数字 -> 半字节补齐后 7 字节 -> SCA 长度 8 (0x08)；
	//     10086 有 5 位数字 -> TP-DA 长度 5 (0x05)，而非字节数 3。
	function encodeAddress(number, isSmsc) {
		var raw = number.replace(/[^\d]/g, '');
		var hasPlus = number.indexOf('+') === 0;
		if (!raw.length) return isSmsc ? '00' : '';
		var tonNpi = hasPlus ? 0x91 : 0x81;
		var digits = raw;
		if (digits.length % 2 !== 0) digits += 'F';
		var packed = '';
		for (var i = 0; i < digits.length; i += 2) {
			packed += digits[i + 1] + digits[i];
		}
		var len = isSmsc ? (digits.length / 2 + 1) : raw.length;
		return (len.toString(16) + tonNpi.toString(16)).padStart(4, '0').toUpperCase() + packed.toUpperCase();
	}

	// 用户数据（TP-UD）构造
	function buildUserData(message, udhi, encoding) {
		var concatHeader = udhi ? [0x05, 0x00, 0x03, udhi.ref & 0xff, udhi.total & 0xff, udhi.seq & 0xff] : null;

		if (encoding === 'UCS2') {
			var bytes = [];
			for (var i = 0; i < message.length; i++) {
				var code = message.charCodeAt(i);
				bytes.push((code >> 8) & 0xff, code & 0xff);
			}
			if (concatHeader) bytes = concatHeader.concat(bytes);
			// UCS2 的 TP-UDL 按八位组计，UDH 的 6 个八位组一并计入
			return { data: bytes, udl: bytes.length };
		}

		// GSM 7bit：header 字节先作为 8-bit 位流写入，再补填充位对齐到 septet 边界，
		// 最后接用户 septets。
		var bits = [];
		if (concatHeader) {
			for (var i = 0; i < concatHeader.length; i++) pushBits(bits, concatHeader[i], 8);
			/*
			 * 必须补齐到 7 位（septet）边界：6 个八位组 = 48 位，补 1 个填充位变 49 位 = 7 个 septet。
			 * 这正是「带 UDH 时每片正文只剩 153 个 septet」（160 − 7）的由来，
			 * 也是本项目 pdu.rs 解码端的口径（udh_septets = (udh_len * 8 + 6) / 7 = 7）。
			 * 少这一位会让收件人整段错位 1 bit，解出来是乱码。
			 */
			while (bits.length % 7 !== 0) bits.push(0);
		}
		var packed = packSeptets(Array.from(message));
		if (packed === null) return null; // 含 GSM7 无法表示的字符，调用方应改用 UCS2
		bits = bits.concat(packed);
		var octets = bitsToOctets(bits);
		/*
		 * TP-UDL（7bit）按 **septet** 计，不是按字符数：
		 *   · 扩展字符（€ ^ { } [ ] ~ | \）在 7bit 流里占 2 个 septet；
		 *   · UDH 也计入（6 字节头占 7 个 septet）。
		 * 此前这里用 message.length 计数、UDH 只加 6，导致
		 *   「含扩展字符的短消息被截断」与「长短信每片少 1 个字」。
		 */
		var msgSeptets = 0;
		var chars = Array.from(message);
		for (var k = 0; k < chars.length; k++) {
			msgSeptets += (isExtChar(chars[k])) ? 2 : 1;
		}
		var udhSeptets = concatHeader ? Math.ceil(concatHeader.length * 8 / 7) : 0;
		var udl = udhSeptets + msgSeptets;
		return { data: octets, udl: udl };
	}

	// 构建单条 SMS-SUBMIT 的 TPDU（不含 SMSC 部分），返回 hex
	function buildTpdu(opts) {
		var udhi = opts.udhi || null;
		/*
		 * TP 首字节位序（厂商手册附录 表 20-6，b7..b0）：
		 *   TP-RP(b7) TP-UDHI(b6) TP-SRR(b5) TP-VPF(b4:b3) TP-RD(b2) TP-MTI(b1:b0)
		 */
		var firstOctet = 0x01;          // MTI=01 (SMS-SUBMIT)
		if (udhi) firstOctet |= 0x40;   // TP-UDHI
		firstOctet |= 0x10;             // TP-VPF=10：TP-VP 用相对格式（1 字节，下方 vp='AA'）
		/*
		 * 不再置 TP-RD(0x04)。
		 *
		 * TP-RD=1 是「请求短消息中心拒收重复短信」：SMSC 会把「同一目的号码 + 同一
		 *  TP-MR + 同一内容」且在有效期内的短信判为重复并丢弃。调试时反复重发同一条
		 * （如 LLCX → 10086）就符合这个判定，表现为「第一条之后的都发不出去」。
		 * 本项目的诉求是把短信发出去，并无去重需求，故保持默认的 RD=0。
		 *
		 * 与实测对齐：已验证能提交成功的样本首字节正是 0x11（MTI=01 + VPF=10，无 RD）。
		 *
		 * 另注：0x20 是 bit5 = TP-SRR「请求状态报告」，不是 TP-RD。此前这里写成 0x20
		 * 而注释却写 TP-RD —— 实际效果是每条短信都向网络请求状态报告，而设备
		 * CNMI=2,1,0,2,0 的 <ds>=2 会把 +CDS 上报给终端，全项目又没有 +CDS 处理。
		 */

		var da = encodeAddress(opts.destination);
		var mr = '00';
		var pid = '00';
		var dcs = opts.encoding === 'UCS2' ? '08' : '00';
		var vp = 'AA'; // 24 小时（相对有效期，23.040 VP=0xAA）

		var ud = buildUserData(opts.message, udhi, opts.encoding);
		if (!ud) return null;
		var udl = ud.udl.toString(16).padStart(2, '0').toUpperCase();

		return firstOctet.toString(16).padStart(2, '0').toUpperCase() + mr + da + pid + dcs + vp + udl + octetsToHex(ud.data);
	}

	// 计算分片参数
	var GSM7_MAX = 160;
	var GSM7_MAX_UDH = 153;
	var UCS2_MAX = 140;   // 70 字符
	var UCS2_MAX_UDH = 134; // 67 字符

	function needsUcs2(message) {
		var chars = Array.from(message);
		for (var i = 0; i < chars.length; i++) {
			if (gsm7Code(chars[i]) === null) return true;
		}
		return false;
	}

	/*
	 * 分片算法只写一份：messageStats（输入框下方的提示）与 buildSubmitParts（真正发出去的）
	 * 必须走同一套逻辑，否则会出现「提示说 2 条、实际发 3 条」。
	 */
	function totalSeptets(message) {
		var chars = Array.from(message);
		var n = 0;
		for (var i = 0; i < chars.length; i++) n += isExtChar(chars[i]) ? 2 : 1;
		return n;
	}

	/** GSM7 长短信按 septet 精确切分（每片正文 ≤153 septets，扩展字符算 2） */
	function gsm7Chunks(message) {
		var chars = Array.from(message);
		var chunks = [], tmp = '', tmpS = 0;
		for (var i = 0; i < chars.length; i++) {
			var s = isExtChar(chars[i]) ? 2 : 1;
			if (tmpS + s > GSM7_MAX_UDH && tmp) { chunks.push(tmp); tmp = ''; tmpS = 0; }
			tmp += chars[i];
			tmpS += s;
		}
		if (tmp) chunks.push(tmp);
		return chunks;
	}

	/*
	 * UCS2 长短信按 **UTF-16 码元**（code unit）切分，而不是码点：
	 * 容量按八位组算 —— 单条 ≤140 字节 = 70 码元，带 UDH 每片 ≤134 字节 = 67 码元。
	 * 增补平面字符（emoji 等）占 2 个码元，若按码点数切分，
	 * 67 个 emoji 会被塞进一片 = 268 字节，PDU 直接无效。
	 * 刀口若落在代理对中间则退一个码元，避免切出孤立代理项。
	 */
	function ucs2Chunks(message) {
		var perUnits = Math.floor(UCS2_MAX_UDH / 2);     // 67
		var chunks = [];
		var start = 0;
		while (start < message.length) {
			var end = Math.min(start + perUnits, message.length);
			if (end < message.length) {
				var prev = message.charCodeAt(end - 1), next = message.charCodeAt(end);
				if (prev >= 0xD800 && prev <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
			}
			chunks.push(message.slice(start, end));
			start = end;
		}
		return chunks;
	}

	api.messageStats = function (message) {
		if (!message) return { encoding: '7bit', parts: 0, chars: 0 };
		var chars = Array.from(message).length;
		if (!needsUcs2(message)) {
			var septets = totalSeptets(message);
			var parts7 = septets <= GSM7_MAX ? 1 : gsm7Chunks(message).length;
			return { encoding: '7bit', parts: parts7, chars: chars, septets: septets };
		}
		var partsU = message.length <= Math.floor(UCS2_MAX / 2) ? 1 : ucs2Chunks(message).length;
		return { encoding: 'UCS2', parts: partsU, chars: chars };
	};

	/*
	 * ========================================================================
	 * 下发命令的构造（PDU 模式 / Text 模式）
	 * ------------------------------------------------------------------------
	 * ★ 命令与数据之间的分隔符必须是**字面反斜杠 + r**（0x5C 0x72），
	 *   绝不能是回车 0x0D。
	 *
	 * 真机实测（MT5700M-CN，固件 V200R001C20B025，用 AT+CMGW 只写存储验证）：
	 *   ① AT+CMGS=19<CR>0891…PDU<CR>
	 *      → 模组只回显 "AT+CMGS=19" 后再无应答。它把 <CR> 视为命令行结束，
	 *        随即进入「等待 PDU」的数据输入态；按 3GPP 该态只认
	 *        Ctrl-Z(0x1A) 结束，而我们并不发 0x1A，于是永远等不到 +CMGS。
	 *   ② AT+CMGS=19<0x5C><0x72>0891…PDU<CR>
	 *      → 模组把整行当**一条**命令解析：取 <length>，再把后面的十六进制
	 *        当 PDU，立即提交并返回 +CMGS: <mr> / OK。
	 * 官方 WEBUI 2.2.0 正是形态 ②（其前端写的是字面 "\\r"，真回车由后端补在
	 * 末尾），本实现与之逐字节对齐；末尾那个 <CR> 由 Rust 后端统一补
	 * （atclient::send_command 里 "不以 \r 结尾就补一个"）。
	 *
	 * 结论：整条命令里**只能有一个真回车，且必须在最末**，由后端补。
	 * ========================================================================
	 */
	var DATA_SEP = '\\r';

	/** PDU 模式（AT+CMGF=0）的单条发送命令 */
	api.buildPduSendCommand = function (part) {
		return 'AT+CMGS=' + part.tpduLength + DATA_SEP + part.pdu;
	};

	/** 字符串转 UCS2 十六进制（Text 模式 + AT+CSCS="UCS2" 时的参数写法） */
	api.toUcs2Hex = function (s) {
		var out = '';
		for (var i = 0; i < String(s).length; i++) {
			out += String(s).charCodeAt(i).toString(16).padStart(4, '0');
		}
		return out.toUpperCase();
	};

	/** 该内容是否必须用 UCS2（含 GSM7 表达不了的字符） */
	api.usesUcs2 = function (message) { return needsUcs2(message); };

	/*
	 * Text 模式的单条容量上限。
	 * 超过就必须分片，而 Text 模式没有分片语法（UDH 拼接头只能自己写 PDU），
	 * 所以调用方在超长时应改用 PDU 模式发送。
	 */
	api.TEXT_MAX_ASCII = 160;
	api.TEXT_MAX_UCS2 = 70;

	/*
	 * Text 模式（AT+CMGF=1）的发送命令。
	 *
	 * 返回 { pre, cmd, post }：
	 *   pre  —— 发送前必须下发的设置（字符集 / CSMP 的 DCS）
	 *   cmd  —— 真正的 AT+CMGS
	 *   post —— 发送后用来恢复现场的命令（**无论成败都要执行**）
	 *
	 * 中文为什么必须切 AT+CSCS="UCS2"：Text 模式下模组按当前 TE 字符集解释
	 * 我们送过去的字节。IRA（默认，ASCII）装不下中文，所以要先切 UCS2，
	 * 并且**号码与正文都要写成 UCS2 十六进制**（实测：ASCII 引号 + hex 号码
	 * + hex 正文可用；把引号也写成 hex 会让模组卡在数据输入态）。
	 */
	/*
	 * Text 模式（IRA/ASCII）分支的正文消毒。
	 *
	 * 只剥「会破坏 AT 命令分帧」的控制字符，**不能**用 Parse.sanitizeAtParam 代替：
	 * 那个函数连 , 和 ; 一起剥（它防的是参数注入），用在正文上会把
	 * "hello, world" 变成 "hello world" —— 那是擅自改动用户的短信内容。
	 *
	 * 必剥的四个（理由见上面 DATA_SEP 那段：整条命令里只能有一个真回车，且必须在最末）：
	 *   CR 0x0D / LF 0x0A —— 正文里出现真换行，一条命令就被截成两条，
	 *     后面的内容会被模组当作**新的 AT 命令行**解析 → AT 命令注入；
	 *   NUL 0x00          —— 部分固件按 C 字符串截断；
	 *   Ctrl-Z 0x1A       —— 3GPP 里它是「数据输入结束」，会让模组提前提交。
	 *
	 * UCS2 分支不受影响：走 toUcs2Hex 之后只剩 [0-9A-F]，天然安全。
	 */
	function sanitizeSmsText(text) {
		return String(text == null ? '' : text).replace(/[\r\n\x00\x1a]/g, '');
	}
	api.sanitizeSmsText = sanitizeSmsText;

	api.buildTextSendCommand = function (opts) {
		/* 只滤空白与括号的话，号码里带引号会拼出 AT+CMGS="10086"OK" 破坏命令；
		   非数字字符一概不要（PDU 路径的 encodeAddress 本来也会滤）。*/
		var da = String(opts.destination || '').trim().replace(/[^\d+]/g, '');
		var text = String(opts.message || '');
		if (!needsUcs2(text)) {
			return { pre: [], cmd: 'AT+CMGS="' + da + '"' + DATA_SEP + sanitizeSmsText(text), post: [] };
		}
		// 号码只编码数字部分：'+' 是格式符，由 <toda> 表达，不进 UCS2 串
		var daDigits = da.replace(/^\+/, '');
		return {
			pre: ['AT+CSCS="UCS2"', 'AT+CSMP=17,167,0,8'],
			cmd: 'AT+CMGS="' + api.toUcs2Hex(daDigits) + '"' + DATA_SEP + api.toUcs2Hex(text),
			post: ['AT+CSCS="IRA"', 'AT+CSMP=17,167,0,0']
		};
	};

	// 构建发送分片，等价 buildSubmitParts
	api.buildSubmitParts = function (opts) {
		var message = opts.message || '';

		var parts = [];
		if (!needsUcs2(message)) {
			if (totalSeptets(message) <= GSM7_MAX) {
				parts.push({ message: message, encoding: '7bit', udhi: null });
			} else {
				var chunks = gsm7Chunks(message);
				var ref = Math.floor(Math.random() * 255) + 1;
				chunks.forEach(function (seg, i) {
					parts.push({ message: seg, encoding: '7bit', udhi: { ref: ref, total: chunks.length, seq: i + 1 } });
				});
			}
		} else {
			if (message.length <= Math.floor(UCS2_MAX / 2)) {
				parts.push({ message: message, encoding: 'UCS2', udhi: null });
			} else {
				var chunksU = ucs2Chunks(message);
				var refC = Math.floor(Math.random() * 255) + 1;
				chunksU.forEach(function (seg, i) {
					parts.push({ message: seg, encoding: 'UCS2', udhi: { ref: refC, total: chunksU.length, seq: i + 1 } });
				});
			}
		}

		return parts.map(function (part) {
			var pdu = buildTpdu({
				destination: opts.destination,
				message: part.message,
				encoding: part.encoding,
				udhi: part.udhi
			});
			// SMSC 部分：有 smsc 时编码（长度含 TOA 字节）；没有则 00（使用 SIM 卡默认中心）
			var sca = opts.smsc ? encodeAddress(opts.smsc, true) : '00';
			var fullPdu = sca + pdu;
			var scaOctets = sca.length / 2;
			return { pdu: fullPdu, tpduLength: pdu.length / 2 };
		});
	};

	return api;
})();

var SmsEncodeClass = L.Class.extend(SmsEncode);
if (typeof window !== 'undefined') {
	window.SmsEncode = new SmsEncodeClass();
}
return SmsEncodeClass;
