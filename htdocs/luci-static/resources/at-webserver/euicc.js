'use strict';
'require baseclass';
/* global L */
/*
 * eUICC / eSIM 管理 —— 纯函数模块（无 DOM、无 UI、不依赖 rpc/ui/mt5700）。
 *
 * 全部 APDU 经既有 ubus `mt5700.at` 下发（调用方注入 send），本文件不接触串口、
 * 不直连 ttyUSB、不引入 lpac。这样测试可以用正则把本模块整段抠出来在 Node 里真跑。
 *
 * 设计约束见提案 §1.2 / §1.3 / §1.4 / §1.5：
 *   - P02  AT+CSIM 的 <length> 是十六进制字符数（apduHex.length，不是 /2）
 *   - P03  开/选/操/关 四步顺序，通道号取响应首字节并校验 1..19
 *   - P04  61xx 必须 GET RESPONSE 取余，MAX_ROUNDS=8 防死循环
 *   - P05  关通道返回 62xx 仅 warn，不报错
 *   - P06  6A82 = 非 eUICC，进入引导态，不 toast
 *   - P07  BER-TLV 只取 12 个 tag，禁止通用 ASN.1 解析器
 *   - P11  纯函数 + 尾部 LuCI 工厂（照抄 parse.js）
 */

var Euicc = (function () {
	var api = {};

	/* ============ 常量 ============ */

	var ISDR_AID = 'A0000005591010FFFFFFFF8900000100';
	var MAX_ROUNDS = 8;

	/*
	 * GET RESPONSE 轮次上限 —— 按传输分别取。
	 *
	 * AT+CSIM 下 8 轮已经绰绰有余：它只可能拿到 1 轮（见下面的 256 字节上限），
	 * 超过就是异常，早抛早好。
	 *
	 * AT+CGLA 下必须放宽：★ 2026-09-19 真机实测，ES10b.AuthenticateServer 的
	 * 1636 字节响应是靠 **7 轮** `81C00000xx` 拼出来的（每轮 256 字节）。
	 * 8 轮只剩 1 轮余量，BPP 阶段任何一次多取都会撞上限。64 轮对应 16KB，
	 * 对 BPP 之外所有 ES10b 响应都够，撞上限时仍由 EUICC_TLV_TRUNCATED 兜住。
	 */
	var MAX_ROUNDS_CGLA = 64;

	/*
	 * ======================= APDU 传输层 =======================
	 *
	 * 两条通路，运行时二选一（默认 csim，探测到 CGLA 可用就升到 cgla）：
	 *
	 *   AT+CSIM —— 通用兜底。★ 单条响应硬上限 256 字节（模组固件限制），
	 *     且模组**自己把 GET RESPONSE 做完了再返回**，卡上不留残留，
	 *     所以超过 256 字节的响应永远取不全。读 / 管这类短响应够用，
	 *     Profile 下载必然卡死在 AuthenticateServer。
	 *
	 *   AT+CGLA —— 手册 3.16 节写明「是对 AT+CSIM 命令的扩展。主要体现在
	 *     卡返回的数据长度**超过 255 个字节**时，会通过 <flag> 指示当前接收
	 *     的数据是否为最后一包」。★ 真机实测：它**透传卡的 61xx**，
	 *     由 TE 自己发 GET RESPONSE 控制每轮取多少、多轮拼起来
	 *     —— 这正是 lpac 依赖的行为，也是本设备唯一能取全大响应的方式。
	 *
	 * ★★ 探测方式踩过的坑（2026-09-19，写在这里防止再犯）：
	 *   我最早用 `AT+CGLA=?` 这类**测试命令**探测，三个（CCHO/CCHC/CGLA）
	 *   全回裸 ERROR，于是判定「本模组不支持 CGLA」，并据此写了下面那段
	 *   「下载在本设备不可行」的结论 —— **结论是错的**。
	 *   真实用法 `AT+CGLA=0,<len>,"<apdu>"` 完全可用。
	 *   → 教训：本模组的 `=?` 测试形式会**假阴性**，探测能力必须用真实参数试。
	 *
	 * ★★ 另一个坑：CCHO 开的 session 不 CCHC 掉会占住通道，导致后续数据
	 *   APDU 变 6A81（我因此误判过一次「卡不支持逻辑通道」）。
	 *   → 所以这里**永远不用 CCHO**，固定 sessionid=0（模组自己管通道）。
	 */
	var TRANSPORT = 'csim';

	/*
	 * AT+CSIM 单条响应能带回的**最大数据字节数**。
	 *
	 * ★ 2026-09-19 真机实测（H5000M / MT5700）：这是**模组固件**的硬上限，不是我们
	 *   或卡的限制，已经用四条独立证据钉死：
	 *     ① ES10b.AuthenticateServer 的响应 TLV 声明 1631 字节，实收恰好 256 字节；
	 *     ② 响应里 SW=9000（不是 61xx），也就是说模组自己认为「已经给完了」；
	 *     ③ 截断后立刻补发 81C0000000 / 81C00000FF / 81C0000080 / 81C0000001
	 *        四种 GET RESPONSE，全部 0 字节（9000 / 6700）—— 卡上没有残留；
	 *     ④ 重发末块回 6A86，卡不会重吐一次响应。
	 *   （STORE DATA 带 Le 的 case 4 无论 Le 取何值都被 AT+CSIM 层拒。）
	 *
	 * ⚠️ 旧注释这里还写着「AT+CCHO / AT+CGLA 该模组全部不支持，AT+CSIM 是唯一
	 *    APDU 通路」，以及由此推出的「完整 Profile 下载在本设备上走不通」——
	 *    **这两句都已被推翻**（见上方「APDU 传输层」注释块的踩坑记录）：
	 *    那次判定的依据是 `=?` 测试命令假阴性，真实用法下 AT+CGLA 完全可用，
	 *    且能把 1636 字节的响应分 7 轮完整吐出。
	 *
	 * 现状：256 只是 **AT+CSIM 这一条通路**的上限。走 AT+CGLA 不受它约束；
	 *   仍走 CSIM 时（CGLA 不可用、或尚未探测），下面的截断守卫照旧生效，
	 *   读取 / 启用 / 禁用 / 删除这类短响应操作也照旧不受影响。
	 */
	var CSIM_MAX_RESPONSE_BYTES = 256;

	/* 通道号记录（R04）：检测通道泄漏。每次 open 成功更新；若本次通道号比上次大，
	 * 记下疑似泄漏提示，交由上层（probe → esim.js）展示，避免悄然累积到第 20 次后 open 失败。 */
	var lastChannel = 0;
	var channelLeakNote = '';
	/*
	 * ★ P08 不要在这里缓存探活 EID（初版用的是一个模块级变量，已删除）：
	 *   模块级可变状态在**并发会话**下会互相覆盖 —— 会话 A 探活取到 EID 后，
	 *   会话 B 的探活（解析失败）把它写成空串，A 就会误判「没取到」而重发 BF3E；
	 *   更糟的是换卡场景下会把上一张卡的 EID 带给新卡。
	 *   正确做法：探活结果按会话传递 —— withIsdrSession 把 {sw, eid} 作为 fn 的第三参传入。
	 */

	/*
	 * 异常 code 固定集合（§1.2）。所有抛错必须是带 code 的 Error 实例，
	 * 上层按 code 分流到不同引导态 / 文案。禁止抛裸字符串。
	 */
	var ERR_CODES = [
		'EUICC_BAD_HEX', 'EUICC_BAD_APDU', 'EUICC_TLV_TRUNCATED',
		'EUICC_UNSUPPORTED_TAG', 'EUICC_AT_ERROR', 'EUICC_NO_CSIM',
		'EUICC_NO_CARD', 'EUICC_NO_CHANNEL', 'EUICC_CHANNEL_LEAK', 'EUICC_NO_EUICC',
		'EUICC_BUSY', 'EUICC_POLICY_DENIED', 'EUICC_OP_FAILED',
		/* 下载链路（ES9+ 走后端转发）专有：通道缺失 / 服务器侧失败 */
		'EUICC_NO_ES9P', 'EUICC_ES9P_FAILED',
		/* 模组 AT+CSIM 单条响应装不下（见 CSIM_MAX_RESPONSE_BYTES 注释） */
		'EUICC_CSIM_TRUNCATED'
	];

	function makeError(code, message) {
		var e = new Error(message || code);
		e.code = code;
		return e;
	}

	function hex2(n) {
		var s = (n & 0xff).toString(16).toUpperCase();
		return s.length === 1 ? '0' + s : s;
	}

	/* ============ 基础：hex / bytes / 编码 ============ */

	api.isHex = function (v) {
		return typeof v === 'string' && v.length > 0 && v.length % 2 === 0 &&
			/^[0-9A-Fa-f]+$/.test(v);
	};

	api.hexToBytes = function (hex) {
		if (!api.isHex(hex)) throw makeError('EUICC_BAD_HEX', '非法十六进制：' + hex);
		var out = new Uint8Array(hex.length / 2);
		for (var i = 0; i < out.length; i++) {
			out[i] = parseInt(hex.substr(i * 2, 2), 16);
		}
		return out;
	};

	api.bytesToHex = function (b) {
		var s = '';
		for (var i = 0; i < b.length; i++) {
			s += hex2(b[i]);
		}
		return s;
	};

	/* ICCID 的 BCD 半字节交换：逐字节交换高低 4 位（标准 SIM ICCID 解码）。 */
	api.swapNibbles = function (hex) {
		if (hex.length % 2 !== 0) throw makeError('EUICC_BAD_HEX', '奇数长度无法交换：' + hex);
		if (!api.isHex(hex)) throw makeError('EUICC_BAD_HEX', '非法十六进制：' + hex);
		var out = '';
		for (var i = 0; i < hex.length; i += 2) {
			var hi = hex.charAt(i);
			var lo = hex.charAt(i + 1);
			out += lo + hi;
		}
		return out.toUpperCase();
	};

	/* UTF-8 解码：优先 TextDecoder，否则手写循环；非法序列替换为 U+FFFD，不抛。 */
	api.utf8FromBytes = function (b) {
		if (typeof TextDecoder !== 'undefined') {
			try {
				return new TextDecoder('utf-8', { fatal: false }).decode(b);
			} catch (e) { /* 退化到手写 */ }
		}
		var s = '';
		var i = 0;
		while (i < b.length) {
			var c = b[i];
			if (c < 0x80) {
				s += String.fromCharCode(c);
				i += 1;
			} else if (c >= 0xC0 && c < 0xE0) {
				var c2 = b[i + 1] || 0;
				s += String.fromCharCode(((c & 0x1f) << 6) | (c2 & 0x3f));
				i += 2;
			} else if (c >= 0xE0 && c < 0xF0) {
				var d2 = b[i + 1] || 0;
				var d3 = b[i + 2] || 0;
				s += String.fromCharCode(((c & 0x0f) << 12) | ((d2 & 0x3f) << 6) | (d3 & 0x3f));
				i += 3;
			} else if (c >= 0xF0) {
				var e2 = b[i + 1] || 0;
				var e3 = b[i + 2] || 0;
				var e4 = b[i + 3] || 0;
				var cp = ((c & 0x07) << 18) | ((e2 & 0x3f) << 12) | ((e3 & 0x3f) << 6) | (e4 & 0x3f);
				cp -= 0x10000;
				s += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3ff));
				i += 4;
			} else {
				s += '\uFFFD';
				i += 1;
			}
		}
		return s;
	};

	/* 手写 UTF-8 编码（Node / 老浏览器无 TextEncoder 时也可用）。 */
	function utf8ToBytes(str) {
		var out = [];
		for (var i = 0; i < str.length; i++) {
			var c = str.charCodeAt(i);
			if (c < 0x80) {
				out.push(c);
			} else if (c < 0x800) {
				out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3f));
			} else if (c >= 0xD800 && c <= 0xDBFF) {
				var c2 = str.charCodeAt(++i);
				var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
				out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
					0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
			} else {
				out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
			}
		}
		return out;
	}

	/* ============ P02：AT+CSIM 命令拼装 ============ */

	/*
	 * 关键：<length> 是十六进制字符数（apduHex.length），不是字节数。
	 * 真机样本 AT+CSIM=18,"00A40804047FFF6F07"（9 字节 = 18 字符）可证。
	 */
	/* 单点汇聚：任何调用方最终都经此函数下发 APDU，必须挡住非法/越界输入。
	 * 真机 AT+CSIM=<len> 实测 <len> 范围 (4-520)（4 字符起、520 字符封顶）。 */
	api.csimCommand = function (apduHex) {
		if (!api.isHex(apduHex)) throw makeError('EUICC_BAD_APDU', 'APDU 不是合法十六进制串');
		if (apduHex.length < 4 || apduHex.length > 520) {
			throw makeError('EUICC_BAD_APDU', 'APDU 长度超出 4~520 字符');
		}
		return 'AT+CSIM=' + String(apduHex.length) + ',"' + apduHex.toUpperCase() + '"';
	};

	/*
	 * 从 AT 应答里抽取 +CSIM 的引号内 hex。
	 * 应答形如 `+CSIM: 6,"019000"`：末 4 字符是 SW，其余是数据。
	 * hasMore = SW1==61（还有数据需 GET RESPONSE）；le = SW2（0 记 256）。
	 * 无 +CSIM: 行 → null。
	 */
	api.parseCsimAnswer = function (atText) {
		if (!atText) return null;
		var m = String(atText).match(/[+]CSIM:\s*(\d+)\s*,\s*"([0-9A-Fa-f]*)"/);
		if (!m) return null;
		var hex = m[2];
		if (hex.length < 4) return { data: hex, sw: '', hasMore: false, le: 0 };
		var data = hex.slice(0, hex.length - 4);
		var sw = hex.slice(hex.length - 4);
		var hasMore = sw.charAt(0) === '6' && sw.charAt(1) === '1';
		var le = parseInt(sw.slice(2), 16) || 0;
		return { data: data, sw: sw, hasMore: hasMore, le: le };
	};

	/* ============ 传输层：AT+CGLA ============ */

	/*
	 * AT+CGLA=<sessionid>,<length>,<command>（手册 3.16）。
	 *
	 * sessionid 固定 0：★ 真机实测，sessionid=0 时**模组自己管逻辑通道** ——
	 *   不 open 也能直接 SELECT ISD-R / 读 EID；而 TE 再插手 MANAGE CHANNEL
	 *   （0070000001）反而被拒（6A81）。所以走 CGLA 时必须跳过 open / close。
	 *
	 * <length> 与 AT+CSIM 同为**十六进制字符数**（不是字节数）。
	 * 长度上限同样按 4~520 字符校验：CSIM 侧是实测 `(4-520)`，CGLA 侧手册未给上限，
	 * 保守沿用同一上限既能挡异常输入，也让两条通路的分块策略完全一致。
	 */
	api.cglaCommand = function (apduHex) {
		if (!api.isHex(apduHex)) throw makeError('EUICC_BAD_APDU', 'APDU 不是合法十六进制串');
		if (apduHex.length < 4 || apduHex.length > 520) {
			throw makeError('EUICC_BAD_APDU', 'APDU 长度超出 4~520 字符');
		}
		return 'AT+CGLA=0,' + String(apduHex.length) + ',"' + apduHex.toUpperCase() + '"';
	};

	/*
	 * 抽取 +CGLA 应答。形态与 +CSIM 一致：`+CGLA: <len>,"<hex>"`，
	 * 末 4 字符是 SW。hasMore / le 的判定也一致（SW1==61 表示卡上还有数据）。
	 *
	 * ★ 关键差异不在解析，而在**谁发 GET RESPONSE**：AT+CSIM 下模组自己取完
	 *   再返回（于是被 256 截断且不留残留）；AT+CGLA 下它把 61xx 原样透传给 TE，
	 *   由本文件的 sendAndCollect 循环取余 —— 多轮拼起来就能拿到完整响应。
	 */
	api.parseCglaAnswer = function (atText) {
		if (!atText) return null;
		var m = String(atText).match(/[+]CGLA:\s*(\d+)\s*,\s*"?([0-9A-Fa-f]*)"?/);
		if (!m) return null;
		var hex = m[2];
		if (hex.length < 4) return { data: hex, sw: '', hasMore: false, le: 0 };
		var data = hex.slice(0, hex.length - 4);
		var sw = hex.slice(hex.length - 4);
		var hasMore = sw.charAt(0) === '6' && sw.charAt(1) === '1';
		var le = parseInt(sw.slice(2), 16) || 0;
		return { data: data, sw: sw, hasMore: hasMore, le: le };
	};

	/**
	 * 切换 APDU 传输通路。返回切换后的值（非法值不改，保持现状）。
	 * 只接受 'csim' / 'cgla'，避免拼错时静默走成默认通路。
	 */
	api.setTransport = function (name) {
		if (name !== 'csim' && name !== 'cgla') return TRANSPORT;
		TRANSPORT = name;
		return TRANSPORT;
	};

	api.getTransport = function () {
		return TRANSPORT;
	};

	/** 按当前通路拼 AT 命令 / 解析应答。模块内所有下发都必须过这两个函数。 */
	function apduCommand(apduHex) {
		return TRANSPORT === 'cgla' ? api.cglaCommand(apduHex) : api.csimCommand(apduHex);
	}

	function parseApduAnswer(text) {
		return TRANSPORT === 'cgla' ? api.parseCglaAnswer(text) : api.parseCsimAnswer(text);
	}

	function maxRounds() {
		return TRANSPORT === 'cgla' ? MAX_ROUNDS_CGLA : MAX_ROUNDS;
	}

	/*
	 * 运行时探测：本模组到底能不能用 AT+CGLA。
	 *
	 * ★ 判据是「AT 层是否接受这条命令」，**不是**「SW 是不是 9000」。
	 *   用 SELECT ISD-R 试：普通 USIM 会回 6A82 —— 命令照样被 AT 层接受了，
	 *   那已经足以证明 CGLA 通路可用（卡是不是 eUICC 是另一回事，交给上层判）。
	 *   反过来，`AT+CGLA=?` 这种测试形式在本模组上回裸 ERROR（假阴性），
	 *   绝不能拿它当判据 —— 那正是我上一次误判「CGLA 不支持」的原因。
	 *
	 * 探测失败一律回退 'csim'：CGLA 只是更强的通路，没有它旧路径照样能用。
	 */
	api.detectTransport = function (send) {
		return send(api.cglaCommand(api.selectIsdrApdu(1))).then(function (res) {
			var fail = api.atFailure(res);
			if (fail.kind === 'ok') {
				/* AT 层接受了命令；再确认应答能被解析（否则后面每条都会炸） */
				if (api.parseCglaAnswer(res && res.data)) return 'cgla';
			}
			return 'csim';
		}, function () {
			return 'csim';
		});
	};

	/* ============ AT 层失败归类（§1.5 ②） ============ */

	api.atFailure = function (res) {
		if (res && res.success === true) return { kind: 'ok' };
		var data = res && typeof res.data === 'string' ? res.data : '';
		var cme = data.match(/CME ERROR:\s*(\d+)/);
		if (cme) {
			var code = cme[1];
			if (code === '14' || code === '515') return { kind: 'cme', code: 'BUSY' };
			if (code === '10' || code === '13') return { kind: 'cme', code: 'NOCARD' };
			return { kind: 'cme', code: code };
		}
		if (/ERROR/.test(data)) return { kind: 'transport' };
		if (res && res.error) return { kind: 'error', code: res.error };
		return { kind: 'empty' };
	};

	/* ============ 卡片 SW 层错误矩阵（§1.5 ①） ============ */

	api.swInfo = function (sw) {
		/* P01：入参非 4 字符十六进制（含 undefined / null / 截断）一律走兜底，绝不抛 */
		if (typeof sw !== 'string' || sw.length !== 4) {
			return {
				level: 'error',
				text: '未知卡片错误 SW=' + (sw == null ? '' : String(sw)),
				hint: '未知状态码，请连同上下文（第几步 / 段号）一并提 issue；可重试'
			};
		}
		if (sw === '9000') return { level: 'ok', text: '', hint: '' };
		if (sw.charAt(0) === '6' && sw.charAt(1) === '1') {
			var xx = sw.slice(2);
			return {
				level: 'more',
				text: '数据未取完（还有 ' + (xx === '00' ? '≥256' : parseInt(xx, 16)) + ' 字节）',
				hint: '立即发 GET RESPONSE 取余'
			};
		}
		if (sw === '6283') {
			return { level: 'warn', text: '卡片上的数据已被作废', hint: '重启模组后重试' };
		}
		if (sw.charAt(0) === '6' && sw.charAt(1) === '2') {
			return {
				level: 'warn',
				text: '逻辑通道可能已释放，卡片未给成功确认',
				hint: '若下次 open 通道号递增，建议重启模组'
			};
		}
		if (sw === '6985') {
			return {
				level: 'error',
				text: '卡片拒绝该操作：可能这张是 M2M eUICC（SGP.02，只能由 SM-SR 远程管理）或被厂家锁卡，本页无法管理',
				hint: '请勿反复尝试，这类拒绝通常与卡商 / SIM 管理平台绑定，再试也不会改变结果'
			};
		}
		if (sw === '6A80') {
			/*
			 * ★ 2026-09-19 真机实测更正：本设备（AT+CSIM 单条响应上限 256 字节）上，
			 *   下载走到 PrepareDownload 时的 6A80 **不是本地组包的锅** —— 是上一步
			 *   AuthenticateServer 的响应被截成残片、又被原样发给服务器/卡造成的。
			 *   旧文案写死「本地 TLV 组装有误」，等于把固件的能力上限报成我们自己的 bug，
			 *   排查方向会被彻底带偏（我就是被这句带着翻了半天组包代码）。
			 *   真正的截断现在由上层的 EUICC_CSIM_TRUNCATED 守卫拦下（见 sendAndCollect），
			 *   走到这里说明数据本身确实有问题，但文案必须同时点出「数据不完整」这个可能。
			 */
			return {
				level: 'error',
				text: '下发的数据卡片读不懂（数据不正确或不完整）',
				hint: '若发生在下载中途，多为上一步响应被截断所致，见上方提示；否则请勿重试并提 issue'
			};
		}
		if (sw === '6A82') {
			return {
				level: 'fatal',
				text: '这张卡不是 eUICC（卡上没有 ISD-R）',
				hint: ''
			};
		}
		if (sw === '6A88') {
			return { level: 'error', text: '卡上找不到指定的 tag', hint: '缩减 tag 列表（只留 5A/4F/9F70）重试 1 次' };
		}
		/*
		 * 6881 / 6A81：卡不支持逻辑通道。
		 * ★ 2026-09-19 真机实测（更正过一次，别再抄旧结论）：
		 *   本机卡**逻辑通道完全可用**（open→SELECT→GET RESPONSE→GetEID 全 9000），
		 *   eSIM 读不出来的**唯一根因是 Le**：带 Le=00（case 4）时 AT+CSIM 在传输层
		 *   直接 ERROR，不带 Le 才 9000 —— 与 CLA 是 00 / 80 / 82 无关（三组对照实测）。
		 *   早先曾误判成「本卡不支持逻辑通道」，真实原因是我那份二分脚本没先 open
		 *   通道就拿 CLA=81 发数据，卡当然回 6881。已用正确流程复测推翻。
		 *   现保留本分支的意义：6881 是 GSMA 里真实存在的状态（确实有卡不支持逻辑通道），
		 *   有了它，这类卡会由 withIsdrSession 自动回退基本通道，而不是被判成
		 *   fatal → 页面显示「这张卡不是 eUICC」（把 eUICC 误报成普通卡，比报错更糟）。
		 */
		if (sw === '6881' || sw === '6A81') {
			return {
				level: 'error',
				text: '这张卡不支持逻辑通道',
				hint: '已自动改用基本通道重试'
			};
		}
		if (sw === '6E00' || sw === '6D00') {
			return { level: 'fatal', text: '卡片不接受该 CLA / 指令', hint: '固件透传能力受限，本页不可用' };
		}
		/*
		 * ★ 6A84 =「文件内空间不足」（ISO 7816-4：Not enough memory space in the file）。
		 *
		 *   2026-09-20 前它在下载第 8 步必现，且**与分块大小无关**（mss=60/120/240
		 *   都死在累计 8160 字节）—— 那不是卡装不下 Profile，是旧实现把整包 BPP
		 *   当**一个**逻辑命令连续下发，卡得把整包攒在链接缓冲里才能解析，
		 *   攒到 8160 字节就溢出。改成按 BPP 的 TLV 结构分段（每段一条独立
		 *   STORE DATA，卡收一段解析一段）后该错消失。
		 *
		 *   这里保留分支是因为 6A84 本身仍然真实存在（卡的 Profile 区真的不够时
		 *   就是这个码）；有了它，用户看到的是「空间不足」而不是「不支持此操作」。
		 */
		if (sw === '6A84') {
			return {
				level: 'error',
				text: '卡上空间不足（SW=6A84）：这批数据放不进卡的缓冲或 Profile 存储区',
				hint: '先看 eSIM 页显示的剩余容量；若剩余充足，多半是卡侧缓冲上限（非本页可绕过），请提 issue 并附段号'
			};
		}
		/*
		 * ★ 6999 = JavaCard ISO7816.SW_APPLET_SELECT_FAILED ——「Applet 选择失败」，
		 *   即这一刻卡上并没有选中 ISD-R（出处：JavaCard 3.1 API 常量定义，
		 *   值 0x6999；ISO 7816-4 本身没有给 SW2=0x99 定义语义，是 GP/JavaCard 侧的约定）。
		 *
		 *   真机背景（2026-09-20 用户遇到「下载失败：6999」）：下载要走十几条
		 *   STORE DATA，中途一旦 SIM 被复位（手工 ifdown/ifup 重拨、模组重搜网、
		 *   或热插拔都会重新初始化 SIM），ISD-R 的选择就丢了，后续每一条都被回 6999。
		 *   —— 它不是「卡不支持下载」，也不是参数错了，是**选择态丢失**。
		 *
		 * 文案必须点出这一层：只报一个裸状态码，用户无从判断是该重试还是该放弃。
		 */
		if (sw === '6999') {
			return {
				level: 'error',
				text: '卡上的 ISD-R 没被选中（Applet 选择失败，SW=6999）',
				hint: '多因下载途中 SIM 被复位（手工重拨 ifdown/ifup、模组重搜网、热插拔）' +
					'导致选择态丢失；先刷新页面让插件重新选中 ISD-R 再试，' +
					'并保证下载期间不要动接口'
			};
		}
		/* 兜底。★ 旧文案写「不支持此操作」是错的 —— 它把「我没识别出这个码」
		   说成了「卡不支持这个功能」，用户会因此放弃本来能成功的重试。 */
		return {
			level: 'error',
			text: '未知卡片错误 SW=' + sw,
			hint: '这个状态码本页还没收录；请连同上下文（第几步 / 段号）一并提 issue，可重试'
		};
	};

	/*
	 * 是否「逻辑通道不被支持」这一类 SW。判定独立成函数，供 withIsdrSession 回退使用。
	 * 6881 = 逻辑通道不支持；6A81 = 功能不支持（部分卡以这个表达同一件事）。
	 */
	api.isChannelUnsupportedSw = function (sw) {
		return sw === '6881' || sw === '6A81';
	};

	/* ============ 通道 / STORE DATA APDU（§1.3） ============ */

	api.openChannelApdu = function () {
		return '0070000001';
	};

	api.closeChannelApdu = function (ch) {
		return '007080' + hex2(ch) + '00';
	};

	api.selectIsdrApdu = function (ch) {
		return hex2(ch) + 'A4040C10' + ISDR_AID;
	};

	/*
	 * STORE DATA（ES10c 容器）：CLA=0x80|ch, INS=0xE2, P1=0x91(默认，末块),
	 * P2=0x00, Lc=tlv 字节数, DATA=tlv。**不带 Le（case 3）**。
	 * opts.p1 可覆盖 P1（>254 字节分块时倒数第二块之前用 0x11，本页不触发）。
	 *
	 * ★ 2026-09-19 真机实测（H5000M）：末尾带 Le=00 时 AT 透传层直接回 ERROR，
	 *   CLA=00 / 80 / 81 三种**全部**失败 —— 卡根本没收到这条 APDU。不带的同一条
	 *   命令则正常返回。故这里固定 case 3；响应数据改由 GET RESPONSE 取回
	 *   （case 2，带 Le，真机实测可用：SELECT 返回 6121 后 01C0000021 → 9000）。
	 *   即：case 4 不被该模组透传支持，case 2 正常，与 T=0 的常见行为一致。
	 */
	api.storeDataApdu = function (ch, tlv, opts) {
		var p1 = (opts && opts.p1 != null) ? opts.p1 : 0x91;
		/* P2 默认是 0；分块发送时它是块序号（lpac 的 es10x_command_iter） */
		var p2 = (opts && opts.p2 != null) ? opts.p2 : 0x00;
		var tlvHex2 = api.bytesToHex(tlv);
		var lc = hex2(tlv.length);
		var head = api.bytesToHex(new Uint8Array([0x80 | (ch & 0x0f), 0xE2, p1, p2]));
		return head + lc + tlvHex2;
	};

	api.getResponseApdu = function (ch, le) {
		var leHex = (le === 0) ? '00' : hex2(le);
		return api.bytesToHex(new Uint8Array([0x80 | (ch & 0x0f), 0xC0, 0x00, 0x00])) + leHex;
	};

	api.buildGetEid = function (ch) {
		return api.storeDataApdu(ch, api.hexToBytes('BF3E035C015A'));
	};

	/*
	 * GetProfiles：BF2D <len> 5C <count> <tags...>
	 * 默认 tags = ['5A','4F','9F70','90','91']（iccid/aid/state/nickname/spName）；
	 * 上限 5 个，保证响应 <256 字节规避 61xx。
	 * 每个 tag 按 hex 字符串长度 /2 计字节数（'9F70' 是 2 字节 tag）。
	 */
	api.buildGetProfiles = function (ch, tags) {
		var t = (tags && tags.length) ? tags.slice(0, 5) : ['5A', '4F', '9F70', '90', '91'];
		var tagBytes = 0;
		for (var i = 0; i < t.length; i++) tagBytes += t[i].length / 2;
		var valLen = 2 + tagBytes; /* 5C(1) + count(1) + tag 字节 */
		var payload = 'BF2D' + hex2(valLen) + '5C' + hex2(t.length) + t.join('');
		return api.storeDataApdu(ch, api.hexToBytes(payload));
	};

	/*
	 * 启用/禁用/删除。enable=BF31 / disable=BF32 / delete=BF33。
	 * enable/disable：A0 包裹标识 + 81 01 <00|FF>（refresh flag）。
	 * delete：无 A0、无 refresh（P04 反例：照抄 enable 会失败）。
	 */
	api.buildProfileOperation = function (ch, op, ident, refresh) {
		/* 操作名白名单：拼错（含 undefined）一律拒绝，绝不退化成 delete。 */
		if (op !== 'enable' && op !== 'disable' && op !== 'delete') {
			throw makeError('EUICC_BAD_APDU', '未知操作：' + op);
		}
		/* ident.hex 必须是合法 hex，且按 kind 校验长度（iccid=20 / aid=32 字符）。 */
		if (!ident || !api.isHex(ident.hex)) {
			throw makeError('EUICC_BAD_APDU', 'ident.hex 非法');
		}
		var expectLen = ident.kind === 'iccid' ? 20 : 32;
		if (ident.hex.length !== expectLen) {
			throw makeError('EUICC_BAD_APDU', 'ident.hex 长度不符（期望 ' + expectLen + ' 字符）');
		}
		var opTag = op === 'enable' ? 'BF31' : (op === 'disable' ? 'BF32' : 'BF33');
		var idTag = ident.kind === 'iccid' ? '5A0A' + ident.hex : '4F10' + ident.hex;
		var body;
		if (op === 'delete') {
			body = idTag;
		} else {
			var refreshByte = refresh ? 'FF' : '00';
			body = 'A0' + hex2(idTag.length / 2) + idTag + '8101' + refreshByte;
		}
		var payload = opTag + hex2(body.length / 2) + body;
		return api.storeDataApdu(ch, api.hexToBytes(payload));
	};

	api.buildSetNickname = function (ch, iccidHex, nickname) {
		if (!api.isHex(iccidHex) || iccidHex.length !== 20) {
			throw makeError('EUICC_BAD_APDU', 'iccidHex 必须是 20 字符十六进制');
		}
		var nb = utf8ToBytes(nickname || '');
		if (nb.length > 64) throw makeError('EUICC_OP_FAILED', '昵称超过 64 字节');
		/* BF29 值体 = 5A(1) + 0A(1) + ICCID(10) + 90(1) + 长度字节(1) + 昵称(nb) = 14 + nb */
		var payload = 'BF29' + hex2(14 + nb.length) +
			'5A0A' + iccidHex + '90' + hex2(nb.length) + api.bytesToHex(new Uint8Array(nb));
		return api.storeDataApdu(ch, api.hexToBytes(payload));
	};

	/* ============ P07：极简 BER-TLV 解析（只取 12 个 tag） ============ */

	function readTlvHead(bytes, pos) {
		if (pos >= bytes.length) return null;
		var b0 = bytes[pos];
		var tag, tagLen;
		if ((b0 & 0x1f) === 0x1f) {
			/* 低 5 位全 1 → 多字节 tag；只支持 9F/BF 前缀 + 1 字节（共 2 字节） */
			if (pos + 1 >= bytes.length) throw makeError('EUICC_TLV_TRUNCATED', 'tag 截断');
			if (b0 === 0x9f || b0 === 0xBF) {
				tag = hex2(b0) + hex2(bytes[pos + 1]);
				tagLen = 2;
			} else {
				throw makeError('EUICC_UNSUPPORTED_TAG', '不支持的多字节 tag @' + pos);
			}
		} else {
			tag = hex2(b0);
			tagLen = 1;
		}
		var lenPos = pos + tagLen;
		if (lenPos >= bytes.length) throw makeError('EUICC_TLV_TRUNCATED', 'length 截断');
		var lenByte = bytes[lenPos];
		var len, lenLen;
		if (lenByte < 0x80) {
			len = lenByte;
			lenLen = 1;
		} else if (lenByte === 0x81) {
			if (lenPos + 1 >= bytes.length) throw makeError('EUICC_TLV_TRUNCATED', 'length 截断');
			len = bytes[lenPos + 1];
			lenLen = 2;
		} else if (lenByte === 0x82) {
			if (lenPos + 2 >= bytes.length) throw makeError('EUICC_TLV_TRUNCATED', 'length 截断');
			len = (bytes[lenPos + 1] << 8) | bytes[lenPos + 2];
			lenLen = 3;
		} else {
			throw makeError('EUICC_TLV_TRUNCATED', 'length 形式过长（>=0x83）');
		}
		var valueStart = lenPos + lenLen;
		var valueEnd = valueStart + len;
		if (valueEnd > bytes.length) throw makeError('EUICC_TLV_TRUNCATED', '声明长度超出剩余字节');
		return {
			tag: tag, tagLen: tagLen, len: len, lenLen: lenLen,
			valueStart: valueStart, valueEnd: valueEnd
		};
	}

	function parseTlvChildren(bytes) {
		var out = [];
		var pos = 0;
		while (pos < bytes.length) {
			var head = readTlvHead(bytes, pos);
			if (!head) break;
			out.push({
				tag: head.tag,
				value: bytes.subarray(head.valueStart, head.valueEnd)
			});
			pos = head.valueEnd;
		}
		return out;
	}

	/* GetProfiles 响应解析（§1.4）。只产出 ProfileInfo 的 8 个字段。 */
	api.parseGetProfiles = function (dataHex) {
		if (!dataHex) return { list: [] };
		var bytes = api.hexToBytes(dataHex);
		var root = readTlvHead(bytes, 0);
		if (!root || root.tag !== 'BF2D') return { list: [] };

		var body = bytes.subarray(root.valueStart, root.valueEnd);
		var children = parseTlvChildren(body);

		var errCode = undefined;
		var a0 = null;
		for (var i = 0; i < children.length; i++) {
			if (children[i].tag === '81') {
				errCode = children[i].value[0];
			} else if (children[i].tag === 'A0') {
				a0 = children[i].value;
			}
		}
		if (errCode === 1 || errCode === 127) {
			throw makeError('EUICC_OP_FAILED', 'GetProfiles 返回错误码 ' + errCode);
		}

		var list = [];
		if (a0) {
			var profiles = parseTlvChildren(a0);
			for (var j = 0; j < profiles.length; j++) {
				if (profiles[j].tag !== 'E3') continue;
				list.push(parseProfile(profiles[j].value));
			}
		}
		return { list: list, errorCode: errCode };
	};

	function parseProfile(value) {
		var p = {
			iccid: '', iccidRaw: '', aid: '', state: 'disabled',
			nickname: '', spName: '', profileName: '', profileClass: null
		};
		var fields = parseTlvChildren(value);
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			if (f.tag === '5A') {
				p.iccidRaw = api.bytesToHex(f.value);
				p.iccid = api.swapNibbles(p.iccidRaw);
			} else if (f.tag === '4F') {
				p.aid = api.bytesToHex(f.value);
			} else if (f.tag === '9F70') {
				p.state = (f.value[0] === 0x01) ? 'enabled' : 'disabled';
			} else if (f.tag === '90') {
				p.nickname = api.utf8FromBytes(f.value);
			} else if (f.tag === '91') {
				p.spName = api.utf8FromBytes(f.value);
			} else if (f.tag === '92') {
				p.profileName = api.utf8FromBytes(f.value);
			} else if (f.tag === '95') {
				p.profileClass = f.value[0];
			}
			/* 93/94/icon、B6/B7/B8/99 等：不取、不显示 */
		}
		return p;
	}

	/* 从 GetEID 响应抽 EID（BF3E 12 5A 10 <16B>） */
	function parseEid(dataHex) {
		if (!dataHex) return '';
		var i = dataHex.indexOf('5A10');
		if (i < 0) return '';
		return dataHex.substr(i + 4, 32);
	}

	/*
	 * ES10c 结果码提取。两种真实响应形态都要兼容（不猜规格）：
	 *   形态一：裸 `80 01 <code>`（如 800103 → 3）。
	 *   形态二：ES10c 信封 `BF31/BF32/BF33/BF29`，下钻取子节点 tag=80 的值
	 *           （如 BF3303800103 → 子节点 80=03 → 3；BF3103800100 → 0）。
	 * 无法识别 / 空串 → 返回 null（调用方按「成功」处理，不误报失败）。
	 */
	function es10Result(dataHex) {
		if (!dataHex || dataHex.length < 6) return null;
		/* 形态一：裸 80 01 xx */
		if (dataHex.substr(0, 2) === '80') {
			return parseInt(dataHex.substr(4, 2), 16);
		}
		/* 形态二：ES10c 信封，下钻取 tag=80 的子节点值 */
		try {
			var bytes = api.hexToBytes(dataHex);
			var root = readTlvHead(bytes, 0);
			if (root && (root.tag === 'BF31' || root.tag === 'BF32' ||
					root.tag === 'BF33' || root.tag === 'BF29')) {
				var body = bytes.subarray(root.valueStart, root.valueEnd);
				var children = parseTlvChildren(body);
				for (var i = 0; i < children.length; i++) {
					if (children[i].tag === '80' && children[i].value.length >= 1) {
						return children[i].value[0];
					}
				}
			}
		} catch (e) {
			return null;
		}
		return null;
	}

	function es10CodeToErr(code) {
		if (code === 3) return 'EUICC_POLICY_DENIED';
		if (code === 5) return 'EUICC_BUSY';
		if (code === 1 || code === 2 || code === 4 || code === 127) return 'EUICC_OP_FAILED';
		return 'EUICC_OP_FAILED';
	}

	/*
	 * P07：ES10 结果码 → 中文人话（esim.js handleErr 优先采用，替代裸串「ES10 result n」）。
	 * 缺省 → 'ES10 结果码 ' + code（绝不编造未定义码的含义）。
	 *
	 * ★ R10：这里**故意不收录 3 和 5**。它们被 es10CodeToErr 翻译成
	 *   EUICC_POLICY_DENIED / EUICC_BUSY，而 handleErr 里那两个分支排在 P07 分支之前，
	 *   且文案比本表更具体（「运营商预置 Profile 禁止删除」「约 10 秒后重试」）。
	 *   把它们写进本表只会制造「已覆盖」的假象 —— 测试断言 es10ResultText(3) 通过了，
	 *   用户却永远走不到那行代码。
	 */
	function es10ResultText(code) {
		var map = {
			1: '找不到该 Profile（ICCID/AID 在卡上不存在）',
			2: '状态不符：删除前必须先禁用、启用前必须处于禁用',
			127: '卡返回未定义错误'
		};
		if (Object.prototype.hasOwnProperty.call(map, code)) return map[code];
		return 'ES10 结果码 ' + code;
	}
	api.es10ResultText = es10ResultText;

	/* 带人话文案的 SW 错误（R08）：把 §1.5① 错误矩阵的 text/hint 挂到 err 上，
	 * 让上层 handleErr 优先展示，而不是把裸 SW（如 6A80）直接 toast 给用户。 */
	function makeSwError(code, sw) {
		var info = api.swInfo(sw);
		var e = makeError(code, sw);
		e.swText = info.text;
		e.swHint = info.hint;
		/*
		 * ★ e.sw（2026-09-20）：上层需要按状态码分流，而 e.message 里还可能带
		 *   别的信息（如「open 失败 SW=xxxx」），靠字符串匹配既脆又容易误判。
		 *   这里显式挂上原始状态码，调用方一律读 e.sw。
		 */
		e.sw = sw;
		return e;
	}

	/* ============ 会话：open → select → fn → close（P03/P04/P05） ============ */

	/*
	 * sendApdu 发送一条 APDU 并自动处理 61xx 取余（GET RESPONSE 循环，MAX_ROUNDS 闸）。
	 * 返回 { data, sw }，data 为拼接完整的响应数据（不含 SW）。
	 */
	function sendAndCollect(send, ch, apdu, round, acc) {
		return send(apduCommand(apdu)).then(function (res) {
			/* R05：统一先过 atFailure，把 AT 层失败按形态分流，避免「AT 未连接」被误报成「固件不支持」。 */
			var fail = api.atFailure(res);
			if (fail.kind === 'error') {
				throw makeError('EUICC_AT_ERROR', 'AT 服务未就绪：' + ((res && res.error) || '未连接到调制解调器'));
			}
			if (fail.kind === 'cme' && fail.code === 'BUSY') {
				throw makeError('EUICC_BUSY', '卡片正忙，约 10 秒后重试');
			}
			if (fail.kind === 'cme' && fail.code === 'NOCARD') {
				throw makeError('EUICC_NO_CARD', '未检测到卡片');
			}
			if (fail.kind === 'empty') {
				throw makeError('EUICC_AT_ERROR', '模组无响应');
			}
			/* ★ 2026-09-19 真机实测：AT 透传层拒绝这条 APDU 时会回 ERROR（kind='transport'），
			   例如本模组不接受 case 4（带 Le 的 STORE DATA）。原先这里没有分支，会一路走到
			   parseCsimAnswer 匹配不到 +CSIM: → 抛「无法解析 CSIM 应答」，把真实病因
			   （APDU 格式被拒）藏起来，排查时极易误判成固件不支持 CSIM。 */
			if (fail.kind === 'transport') {
				throw makeError('EUICC_AT_ERROR', 'AT 层拒绝了这条 APDU（透传未返回结果，多为 APDU 格式问题）');
			}
			var a = parseApduAnswer(res && res.data);
			if (!a) throw makeError('EUICC_AT_ERROR', '无法解析 ' +
				(TRANSPORT === 'cgla' ? 'CGLA' : 'CSIM') + ' 应答');
			if (a.hasMore) {
				if (round + 1 >= maxRounds()) {
					throw makeError('EUICC_TLV_TRUNCATED', 'GET RESPONSE 超过 ' + maxRounds() + ' 轮');
				}
				var gr = api.getResponseApdu(ch, a.le);
				return sendAndCollect(send, ch, gr, round + 1, acc + a.data);
			}
			var data = acc + a.data;
			/*
			 * ★ 2026-09-19 真机实测：AT+CSIM 单条响应上限 256 字节，且**卡上不留残留**
			 *   （四种 GET RESPONSE 全 0 字节）。也就是说超过 256 字节的响应永远取不全。
			 *
			 *   不加这道闸的后果（这次就是这么被误导的）：AuthenticateServer 只拿到
			 *   前 256 字节，我们把残片当完整响应发给 SM-DP+，服务器回 1.2/4.2
			 *   「Server authentication failed」，随后 PrepareDownload 又回 6A80。
			 *   页面于是显示「下发的数据卡片读不懂（本地 TLV 组装有误）」——
			 *   把固件的能力上限报成了我们自己的组包 bug，排查方向完全跑偏。
			 *
			 *   判据：实收字节数是 256 的整数倍（被切在缓冲区边界上）且小于 TLV 声明的总长。
			 */
			var want = api.tlvTotalBytes(data);
			var got = data.length / 2;
			/*
			 * 只在 AT+CSIM 通路下判：这条判据描述的是**该通路特有的固件行为**
			 * （响应被切在 256 字节缓冲区边界上、且卡上不留残留）。
			 * AT+CGLA 由本模块自己控制取余轮次，不存在这个行为；在那里套用
			 * 同一判据会把病因归成「CSIM 的 256 上限」，属于错误归因。
			 * CGLA 侧取不全由上面的 maxRounds() 闸（EUICC_TLV_TRUNCATED）兜住。
			 */
			if (TRANSPORT === 'csim' && want > 0 && got < want &&
				(got % CSIM_MAX_RESPONSE_BYTES) === 0) {
				throw makeError('EUICC_CSIM_TRUNCATED',
					'这条响应需要 ' + want + ' 字节，但模组只回传了 ' + got +
					' 字节（AT+CSIM 单条响应上限 256 字节，且卡上没有残留可再取）。' +
					'Profile 下载需要把响应取全 —— 若本设备支持 AT+CGLA，' +
					'切到该通路即可（它会分多轮把大响应吐完）；' +
					'读取 Profile、启用 / 禁用 / 删除等短响应操作不受影响。');
			}
			/*
			 * ★ 2026-09-20 真机实测：这里**原先**有一句
			 *     if (a.sw === '6A82') throw makeError('EUICC_NO_EUICC', 'SELECT ISD-R 返回 6A82');
			 *   已删除，理由两条：
			 *   ① 越权：sendAndCollect 是通用收发，却对**任何** APDU 的 6A82 都判
			 *      「卡不是 eUICC」，连文案都写死 SELECT —— 而 GET EID / GetProfiles
			 *      在逻辑通道上同样可能回 6A82，那与卡的身份毫无关系；
			 *   ② 不回退：它抛的错不带回退标记，withIsdrSession 不会去基本通道复核，
			 *      于是一次通道能力问题被直接坐实成「这张卡不是 eUICC」。
			 *   6A82 统一交给下面的 swInfo（fatal）处理，并在那里按通道号决定是否
			 *   先回退基本通道复核；SELECT 场景另有 selectAndPing 里的明确判定。
			 */
			var info = api.swInfo(a.sw);
		/* R08 带人话文案。channelUnsupported 供 withIsdrSession 判定是否回退基本通道 ——
		   不能靠 err.code 区分，因为 6881 与其它操作失败共用 EUICC_OP_FAILED。 */
		if (info.level === 'fatal' || info.level === 'error') {
			var se = makeSwError(info.level === 'fatal' ? 'EUICC_NO_EUICC' : 'EUICC_OP_FAILED', a.sw);
			se.swInfo = info;
			if (api.isChannelUnsupportedSw(a.sw)) se.channelUnsupported = true;
			/*
			 * ★ 逻辑通道上的 6A82 先回退基本通道复核（2026-09-20 真机实测）。
			 *   本机卡：MANAGE CHANNEL OPEN 成功（分配通道 2/3），但该通道的 CLA
			 *   去 SELECT ISD-R / GET EID 一律 6A82 或 6D00；同一张卡走基本通道
			 *   （CLA=00/80）SELECT 返回 6121、GET EID 正确回 32 位 EID。
			 *   —— 卡是真 eUICC，只是这条逻辑通道上够不着。
			 *   `ch !== 0` 是防重复回退的闸门：基本通道上仍 6A82 才是真的没有 ISD-R。
			 */
			if (a.sw === '6A82' && ch !== 0) se.maybeNoEuicc = true;
			throw se;
		}
		return { data: data, sw: a.sw };
		});
	}

	function doClose(send, channel) {
		/*
		 * ★ 基本通道（channel === 0）不 close：它没有「关闭」的概念，
		 *   而 0070800000 会把基本通道一起关掉，可能打断模组 SIM 驱动自己的操作。
		 *
		 * ★ CGLA 通路同样不 close：sessionid=0 下逻辑通道**由模组自己管**，
		 *   TE 发 007080xxxx 会被拒（6A81）。走这条通路时 withIsdrSession
		 *   也根本不会 open，自然没有要关的东西。
		 */
		if (channel == null || channel === 0 || TRANSPORT === 'cgla') return Promise.resolve();
		return send(apduCommand(api.closeChannelApdu(channel)))
			.then(function (res) {
				var a = parseApduAnswer(res && res.data);
				if (a && a.sw && a.sw.charAt(0) === '6' && a.sw.charAt(1) === '2') {
					/* P05：关通道返回 62xx 仅 warn，不报错 */
					if (typeof console !== 'undefined' && console.warn) {
						console.warn('[euicc] 关闭逻辑通道 ' + channel + ' 返回 ' + a.sw + '（非致命）');
					}
				}
			})
			.catch(function () { /* 关闭失败不影响上层结果 */ });
	}

	/*
	 * ★ 写卡阶段的「超时续传」（2026-09-20 真机：eSIM 下载到一半被「模组无响应」掐断）
	 * ---------------------------------------------------------------------------
	 * 背景：AT 透传命令的应答时间由**卡片**决定。后端没等到结束码就返回
	 * 「模组无响应（已等待 Nms，收到 M 行不完整数据）」，但**卡片多半已经把这一块
	 * 吃下去了** —— 我们只是没拿到它的回执（超时后 pending 被清空，迟到的
	 * `+CGLA:` / `OK` 会被当成主动上报丢掉）。此时直接判失败，整次下载在半途作废。
	 *
	 * 这里做一次**只读**兜底：发 GET RESPONSE（case 2，不写卡）把卡侧回执取回来。
	 *   ① 取回数据（61xx → 自动取余 / 9000 带数据）→ 那就是这一块真实的响应；
	 *   ② 卡回「没有待取数据」（6F00）→ 说明这一块的 9000 已经发出、被我们错过，
	 *      按「已消费」继续下一块（**并在日志里写明**，绝不假装什么都没发生）；
	 *   ③ 探路自己也超时 → 最多再来一次，仍不行才真的报错。
	 *
	 * ★ 只在**写卡分块**这一步启用：鉴权类步骤（BF38 / BF21）的响应带安全语义，
	 *   猜错的代价远大于重跑一次，那里一律如实报错、让用户重来。
	 */

	/* 只有「模组还没回结束码」这一类超时才值得续传；
	   「AT 服务未就绪 / 未连接到调制解调器」是另一回事，续传只会把病因盖住。 */
	function isAtTimeoutError(e) {
		if (!e || e.code !== 'EUICC_AT_ERROR') return false;
		var m = String(e.message || '');
		return m.indexOf('模组无响应') >= 0 || m.indexOf('不完整数据') >= 0;
	}
	api.isAtTimeoutError = isAtTimeoutError;

	function waitMs2(ms) {
		return new Promise(function (resolve) { setTimeout(resolve, ms); });
	}

	/*
	 * 向卡补取一次响应（GET RESPONSE，只读）。
	 * 返回 { data, sw, recovered }；recovered 为真表示结果不是原命令给的 ——
	 * 调用方必须把它记进日志，不能让用户以为一切正常。
	 */
	function recoverAfterTimeout(send, ch, attempt, log) {
		if (attempt > 2) {
			throw makeError('EUICC_AT_ERROR',
				'连续 ' + attempt + ' 条 APDU 都没收到应答，卡片可能已停止响应');
		}
		return waitMs2(500 * attempt).then(function () {
			return sendAndCollect(send, ch, api.getResponseApdu(ch, 0), 0, '');
		}).then(function (r) {
			return { data: r.data || '', sw: r.sw, recovered: true };
		}, function (e) {
			if (isAtTimeoutError(e)) return recoverAfterTimeout(send, ch, attempt + 1, log);
			/*
			 * 6F00 =「没有精确诊断」，在 GET RESPONSE 语境下就是**卡上没有待取数据**：
			 * 原命令的 9000 已经发出、只是被我们错过（非末块几乎都是这种）。
			 * 只认这一个码：6E00（CLA 不被接受）、6A86（P1P2 错）等都是真错误，
			 * 把它们也当成功，就会把「通道 / 参数错了」掩盖成「写卡成功」。
			 */
			if (e && e.sw === '6F00') {
				if (typeof log === 'function') {
					log('⚠ 该块未收到应答，卡上也已无待取数据（6F00）——按已写入处理；' +
						'若最终安装失败，卡侧校验会报错，请整包重下');
				}
				return { data: '', sw: '9000', recovered: true, recoveredBy: '6F00' };
			}
			throw e;
		});
	}
	api.recoverAfterTimeout = recoverAfterTimeout;

	/*
	 * 在指定通道上 SELECT ISD-R，再发一条**只读** GetEID 探活。ch=0 表示基本通道。
	 *
	 * ★ 为什么要探活（2026-09-19 真机实测）：本卡的逻辑通道 open 成功（9000，ch=1）、
	 *   SELECT ISD-R 也成功（6121 → GET RESPONSE → 9000），**到 STORE DATA 才回 6881**。
	 *   所以通道是否可用必须在执行 fn 之前判定 —— 否则 fn（可能是 enable / delete 这类
	 *   写操作）会在跑到一半失败后被迫重跑一次，有重复下发风险。GetEID 只读、
	 *   无副作用，可以安全地多发一次。
	 */
	function selectAndPing(send, ch) {
		return sendAndCollect(send, ch, api.selectIsdrApdu(ch), 0, '')
			.then(function (sel) {
				/*
				 * ★ 2026-09-20 真机实测更正：6A82 **不能**一律判成「这张卡不是 eUICC」。
				 *
				 *   现象：AT+CSIM 通路下 MANAGE CHANNEL OPEN 成功（卡分配通道 2/3），
				 *   但用该通道的 CLA（82/83）去 SELECT ISD-R 一律 6A82；
				 *   而同一张卡走基本通道（CLA=00）SELECT 返回 6121、
				 *   GET EID 三种 CLA（00/80/81）全部正确返回 32 位 EID。
				 *   —— 卡是真 eUICC，只是「这条逻辑通道上选不到」。
				 *
				 *   旧代码无条件 throw EUICC_NO_EUICC，而回退只认 6881/6A81，
				 *   于是这类卡被直接判成普通 USIM，页面显示「这张卡不是 eUICC」。
				 *   把固件/通道的能力问题报成卡的身份问题，是彻底的误判。
				 *
				 *   改法：6A82 打上 maybeNoEuicc 标记抛出，由 pingOn 先回退基本通道复核；
				 *   基本通道（ch=0）上仍然 6A82，才真是卡上没有 ISD-R。
				 */
				if (sel.sw === '6A82') {
					var e = makeError('EUICC_NO_EUICC', 'SELECT ISD-R 返回 6A82（通道 ' + ch + '）');
					e.maybeNoEuicc = true;
					throw e;
				}
				return sel;
			})
			.then(function () {
				return sendAndCollect(send, ch, api.buildGetEid(ch), 0, '');
			})
			.then(function (eidRes) {
				/* P08：把探活取到的 EID 一并返回，由 withIsdrSession 按会话传给 fn，
				 * 供 api.probe 复用，避免二次下发 BF3E。 */
				return { sw: eidRes.sw, eid: parseEid(eidRes.data) };
			});
	}

	/*
	 * withIsdrSession：开通道 → 校验通道号 → 选 ISD-R → **探活** → fn(ch, sendApdu) → 强制关通道。
	 * send 注入点：(atCmd) => Promise<{success,data,error}>。
	 * 异常统一带 err.code；finally 语义用 .catch 兜底 close（P10 不重发、关通道必执行）。
	 *
	 * ★ 2026-09-19「探活 + 基本通道回退」的定位（写清楚，免得后人以为是本机故障的修复）：
	 *   本机 eSIM 读不出来的**唯一根因**是 storeDataApdu 多拼了 Le（见该函数注释），
	 *   本机卡逻辑通道**可用**，所以这里的探活必然成功、不会触发回退 —— 对现有设备
	 *   它是一条纯开销（每次会话多一条只读 GetEID，约几十 ms）。
	 *   保留它的理由：6881/6A81 在 GSMA 里真实存在（确有卡不支持逻辑通道），没有回退时
	 *   这类卡会被 swInfo 判成 fatal → 页面显示「这张卡不是 eUICC」，把 eUICC 误报成
	 *   普通卡，比直接报错更糟。回退只在明确拿到 6881/6A81 时触发，其余错误照旧上抛，
	 *   不会把真实病因换成一次无效重试。
	 */
	api.withIsdrSession = function (send, fn) {
		var channel = null;
		var result;

		/*
		 * 第一步：拿到可用的通道号。
		 *
		 * CGLA 通路：**不发 MANAGE CHANNEL**。sessionid=0 下逻辑通道由模组自己管，
		 *   真机实测 TE 再插手会被拒（6A81）。这里只取一个**名义通道号 1** 用来拼
		 *   CLA=0x81 —— 与 lpac 一致（它同样用 CLA = 0x80 | channel），且真机
		 *   下载链路全程以 CLA=0x81 经 CGLA 下发，步骤 4~8 全部通过。
		 *
		 * CSIM 通路：照旧显式 open，隔离性最好 —— 不占用基本通道的当前选择，
		 *   不会打断模组 SIM 驱动自己的操作。
		 */
		var opened;
		if (TRANSPORT === 'cgla') {
			/*
			 * ★ channel 必须在这里赋值：opened 只 resolve 通道号，
			 *   而 fn 拿到的是外层变量 channel —— 不赋值的话 fn 会收到 null，
			 *   ES10b 的 CLA 从 0x81 退化成 0x80，与探活用的不是同一条通道。
			 */
			channel = 1;
			opened = Promise.resolve(1);
		} else {
			opened = sendAndCollect(send, 0, api.openChannelApdu(), 0, '')
				.then(function (open) {
					if (open.sw !== '9000') throw makeError('EUICC_NO_CHANNEL', 'open 失败 SW=' + open.sw);
					var b = api.hexToBytes(open.data);
					if (!b.length) throw makeError('EUICC_NO_CHANNEL', 'open 响应无通道号');
					var ch = b[0];
					if (!(ch >= 1 && ch <= 19)) throw makeError('EUICC_NO_CHANNEL', '通道号越界 ' + ch);
					channel = ch;
					/* R04：通道号比上次大 → 疑似泄漏，记下提示（不抛错，避免页面直接挂掉）。 */
					if (ch > lastChannel && lastChannel > 0) {
						channelLeakNote = '疑似通道泄漏（本次通道号 ' + ch + '，上次 ' + lastChannel + '），建议重启模组';
					}
					lastChannel = ch;
					return ch;
				});
		}

		function pingOn(ch) {
			return selectAndPing(send, ch).catch(function (e) {
				/*
				 * 逻辑通道撞 6881 / 6A81 → 回退基本通道（ch=0）。
				 * 6A82 现在**也要回退**（见 selectAndPing 注释）：它在本机卡上只是
				 * 「这条逻辑通道选不到 ISD-R」，基本通道却能正常读 EID，
				 * 直接判成「不是 eUICC」是把通道能力问题误报成卡的身份问题。
				 *
				 * ★ 回退条件里的 `ch !== 0` 是防死循环的关键：基本通道（ch=0）上
				 *   仍然 6A82，才真的说明卡上没有 ISD-R，此时不再回退、直接上抛。
				 *
				 * 其余错误（AT 服务未就绪等）都**不**回退，直接抛，
				 * 避免把真实病因换成一次无效重试。
				 */
				if (ch !== 0 && e && (e.code === 'EUICC_NO_CHANNEL'
					|| e.channelUnsupported === true || e.maybeNoEuicc === true)) {
					return doClose(send, ch).then(function () {
						channel = 0;
						channelLeakNote = ''; /* 已放弃逻辑通道，泄漏提示不再有意义 */
						return selectAndPing(send, 0);
					}, function () {
						channel = 0;
						channelLeakNote = '';
						return selectAndPing(send, 0);
					});
				}
				throw e;
			});
		}

		return opened
			.then(function (ch) {
				return pingOn(ch);
			}, function (e) {
				/*
				 * open 本身就失败 → 直接走基本通道。
				 *
				 * ★ 2026-09-20 真机实测：通道被耗尽后 MANAGE CHANNEL OPEN 直接回
				 *   6A81（功能不支持）。sendAndCollect 把它归成 EUICC_OP_FAILED 并
				 *   打了 channelUnsupported 标记，**不是** EUICC_NO_CHANNEL，
				 *   旧条件认不出来 → 不回退 → 整条通路报废。
				 *   这里两个条件都要认：拿不到通道号，本来就该走基本通道。
				 *
				 * AT 服务未就绪（EUICC_AT_ERROR）之类不回退 —— 那不是通道问题，
				 *   回退也救不回来，只会把真实病因换成一次无效重试。
				 */
				if (e && (e.code === 'EUICC_NO_CHANNEL' || e.channelUnsupported === true)) {
					channel = 0;
					return selectAndPing(send, 0);
				}
				throw e;
			})
			/*
			 * fn 第三参 pingInfo = 本次会话探活的 { sw, eid }（按会话传递，不是全局变量）。
			 * 既有回调只吃前两参，完全向后兼容。
			 */
			.then(function (pingInfo) {
				return fn(channel, function (apdu) {
					return sendAndCollect(send, channel, apdu, 0, '');
				}, pingInfo || { sw: '', eid: '' });
			})
			.then(function (r) {
				result = r;
				return doClose(send, channel);
			})
			.then(function () {
				return result;
			})
			.catch(function (e) {
				return doClose(send, channel).then(function () {
					throw e;
				}, function () {
					throw e;
				});
			});
	};

	/* ============ 引导态探测（§1.6 入口） ============ */

	api.probe = function (send) {
		function checkCard() {
			/* R06：AT^SIMSQ? 属 STATE_SET 缓存，引导态刷新必须绕过缓存读实时值。 */
			return send('AT^SIMSQ?', { fresh: true }).then(function (res) {
				var fail = api.atFailure(res);
				if (fail.kind === 'cme' && fail.code === 'NOCARD') return { state: 'no_card' };
				if (fail.kind === 'cme' && fail.code === 'BUSY') throw makeError('EUICC_BUSY', '卡片正忙，约 10 秒后重试');
				/* R05：AT 服务未就绪（未连接/无响应）→ 明确报错，不要误判成固件不支持 CSIM。 */
				if (fail.kind === 'error' || fail.kind === 'empty') {
					throw makeError('EUICC_AT_ERROR', 'AT 服务未就绪');
				}
				var txt = res && typeof res.data === 'string' ? res.data : '';
				var m = txt.match(/\^SIMSQ:\s*\d+\s*,\s*(\d+)/);
				if (m) {
					var status = Number(m[1]);
					var present = status !== 0 && status !== 99;
					if (!present) return { state: 'no_card' };
				}
				return null;
			}).catch(function (e) {
				if (e.code === 'EUICC_BUSY' || e.code === 'EUICC_AT_ERROR') throw e;
				return null;
			});
		}

		function checkCsim() {
			return send('AT+CSIM=?').then(function (res) {
				var fail = api.atFailure(res);
				if (fail.kind === 'cme' && fail.code === 'BUSY') throw makeError('EUICC_BUSY', '卡片正忙，约 10 秒后重试');
				/* R05：AT 服务未就绪与「固件不支持」必须区分开（G2 文案拆两种）。 */
				if (fail.kind === 'error' || fail.kind === 'empty') {
					throw makeError('EUICC_AT_ERROR', 'AT 服务未就绪');
				}
				var txt = res && typeof res.data === 'string' ? res.data : '';
				if (/ERROR/.test(txt) || !/\(4-520\)/.test(txt)) {
					return { state: 'no_csim', raw: txt };
				}
				return null;
			}).catch(function (e) {
				if (e.code === 'EUICC_BUSY' || e.code === 'EUICC_AT_ERROR') throw e;
				return null;
			});
		}

		return checkCard()
			.then(function (r) { if (r && r.state) return r; return checkCsim(); })
			.then(function (r) {
				if (r && r.state) return r;
				/*
				 * 传输通路升级：能用 AT+CGLA 就用（它能分多轮取全大响应，
				 * Profile 下载靠的就是这个）；用不了就留在 AT+CSIM。
				 * 探测失败静默回退，不阻断 —— 两条通路都能读卡。
				 */
				return api.detectTransport(send).then(function (t) {
					api.setTransport(t);
					return null;
				}, function () {
					api.setTransport('csim');
					return null;
				});
			})
			.then(function (r) {
				if (r && r.state) return r;
				return api.withIsdrSession(send, function (ch, sendApdu, pingInfo) {
				/*
				 * P08：EID 已由本次会话的探活（selectAndPing）取回并随 pingInfo 传进来，
				 * 不必再发一次 BF3E。卡容量（extCardResource）在同一条通道里顺手取：
				 * 失败一律降级成「未上报」，绝不上抛。
				 *
				 * ★ R06：复用是「能复用就复用」，不是「必须复用」。探活解析失败
				 *   （pingInfo.eid 为空串）时退回现发一次 BF3E（旧行为），
				 *   绝不把空 EID 当成「这台设备没有 EID」交给页面。
				 */
				var eidReady = (pingInfo && pingInfo.eid)
					? Promise.resolve(pingInfo.eid)
					: sendApdu(api.buildGetEid(ch)).then(function (r) { return parseEid(r.data); });
				return eidReady.then(function (eid) {
					return sendApdu(api.buildGetEuiccInfo2(ch)).then(function (r3) {
						return { eid: eid, capacity: api.parseExtCardResource(r3.data) };
					}, function () {
						return { eid: eid, capacity: null };
					});
				});
			}).then(function (info) {
					/* R04：把疑似通道泄漏提示一并带回，交给 esim.js 展示。
					   transport 一并回传，供界面说明当前走的是哪条通路。 */
					return {
						state: 'ok',
						eid: info.eid,
						capacity: info.capacity || null,
						channelNote: channelLeakNote,
						transport: api.getTransport()
					};
				}).catch(function (e) {
					if (e.code === 'EUICC_NO_EUICC') return { state: 'no_euicc' };
					if (e.code === 'EUICC_NO_CHANNEL') return { state: 'no_csim', channelNote: 'open 通道失败' };
					if (e.code === 'EUICC_NO_CARD') return { state: 'no_card' };
					return { state: 'error', error: e.code };
				});
			});
	};

	/* ============ 业务用例（内部走 withIsdrSession） ============ */

	api.listProfiles = function (send) {
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return sendApdu(api.buildGetProfiles(ch)).then(function (r) {
				return api.parseGetProfiles(r.data);
			});
		});
	};

	/*
	 * P09：一次会话内读全「Profile 列表 + 待发回执」两项（先 BF2D 再 BF28），
	 * 避免首屏各开一条 ISD-R 会话（卡片只有 1~3 条逻辑通道，并发/重复开会被拒）。
	 * 只读、无副作用；错误码沿用现有 EUICC_*。它不取代 listProfiles / listNotifications
	 * （其它入口仍各自独立会话），保持对既有导出函数的向后兼容。
	 */
	api.listProfilesAndNotifications = function (send) {
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return sendApdu(api.buildGetProfiles(ch)).then(function (r1) {
				var parsed = api.parseGetProfiles(r1.data);
				return sendApdu(api.buildListNotification(ch)).then(function (r2) {
					/* P09b：回执 SW≠9000（如 6A88「找不到 tag」）时降级为空列表，
					   Profile 列表照常返回。 */
					var items = (r2.sw === '9000')
						? api.parseNotifications(r2.data || '')
						: [];
					return { list: parsed.list || [], items: items };
				}, function (e) {
					/*
					 * ★ R04：只吞「卡上没这一项」这一类（6A88 找不到 tag / 6A82 找不到文件）。
					 *   AT 断连（EUICC_AT_ERROR）、无卡（EUICC_NO_CARD）、响应截断
					 *   （EUICC_TLV_TRUNCATED）**一律原样上抛** —— 无差别 catch 会把
					 *   「读不出来」伪装成「卡上没有待发的回执」，用户据此以为没事，
					 *   回执就一直挂着。宁可让首屏报出真实错误，也不要假装的空列表。
					 */
					var sw = (e && (e.sw || e.message)) || '';
					if (sw === '6A88' || sw === '6A82') {
						return { list: parsed.list || [], items: [] };
					}
					throw e;
				});
			});
		});
	};

	function runOperation(send, op, ident, refresh) {
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return sendApdu(api.buildProfileOperation(ch, op, ident, refresh)).then(function (r) {
				var code = es10Result(r.data);
				if (code !== null && code !== 0) {
					var e = makeError(es10CodeToErr(code), 'ES10 result ' + code);
					e.result = code;
					throw e;
				}
				return { sw: r.sw, result: code };
			});
		});
	}

	api.enableProfile = function (send, ident, refresh) {
		return runOperation(send, 'enable', ident, refresh !== false);
	};

	api.disableProfile = function (send, ident, refresh) {
		return runOperation(send, 'disable', ident, refresh !== false);
	};

	api.deleteProfile = function (send, ident) {
		return runOperation(send, 'delete', ident, false);
	};

	api.setNickname = function (send, iccidHex, nickname) {
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return sendApdu(api.buildSetNickname(ch, iccidHex, nickname)).then(function (r) {
				var code = es10Result(r.data);
				if (code !== null && code !== 0) {
					var e = makeError(es10CodeToErr(code), 'ES10 result ' + code);
					e.result = code;
					throw e;
				}
				return { sw: r.sw };
			});
		});
	};

	/* 暴露常量（测试 / 上层偶用） */

	/* ===================================================================
	 * 添加 Profile（下载）—— ES10b（卡侧 APDU）+ ES9+（SM-DP+ HTTPS）
	 * -------------------------------------------------------------------
	 * 依据（逐条对照，不是凭记忆）：
	 *   - lpac（estkme-group/lpac）  euicc/es10b.c、euicc/es9p.c、euicc/euicc.c
	 *   - osmocom pySim              pySim/esim/rsp.py、pySim/esim/es9p.py
	 *   - luci-app-lpac              view/lpac/download.js（激活码校验规则）
	 *
	 * ★ 为什么必须有后端转发（ES9+）：
	 *   浏览器直连 SM-DP+ 会被 CORS 拦掉（SM-DP+ 不发 CORS 头），
	 *   所以 HTTPS 那一半只能由路由器代发（ubus mt5700.es9p → curl）。
	 *   APDU 那一半本来就在本地（AT+CSIM），不受影响。
	 *
	 * ★ 真机状态（2026-09-20 实测更正，旧注释写的「本机是普通 USIM」是错的）：
	 *   本机卡**是真 eUICC**：EID = 89086030202200000026000173326959，
	 *   GET IDENTITY 稳定返回，EUICCInfo2（BF22）也读得到。
	 *   旧结论来自一次误判 —— 在 open 出来的逻辑通道上 SELECT ISD-R 回 6A82，
	 *   而基本通道（CLA=00）回 6121、GET EID 三种 CLA 全部成功。
	 *   「6A82 = 不是 eUICC」只在基本通道上也 6A82 时才成立（见 selectAndPing）。
	 *   卡上当前 0 个 Profile（GetProfiles 回 BF2D02A000），所以设备没有网络。
	 *
 *   ★★ 下载链路（2026-09-20 真机端到端跑通，旧注释写的「BPP 写到 8160 字节
 *   必 6A84，尚未解决」**已被推翻**）：
 *     根因不是卡装不下 Profile，而是**旧实现把整包 BPP 当一条逻辑命令连发**，
 *     卡得把整包攒进链接缓冲才能解析，攒到 8160 字节就溢出（mss=60/120/240
 *     三组对照都死在同一个**字节数**上，正是「卡在攒整包」的铁证）。
 *     改成按 BPP 自身的 TLV 结构分段后（见 splitBoundProfilePackage），
 *     本机 61376 字节的 BPP 分 66 段 / 546 块一次通过，回执 5/5 HTTP 204。
 *     空卡重下（禁用→删除→重下→启用）复现成功，不是偶然。
	 * =================================================================== */

	/* ---------- SHA-256（确认码必须先哈希再进 APDU） ----------
	 *
	 * ★ 为什么不用 crypto.subtle：它只在**安全上下文**（https 或 localhost）
	 *   下存在，而 LuCI 是 http://192.168.x.x，`window.crypto.subtle` 直接是
	 *   undefined（MDN：SubtleCrypto 仅在 Secure Contexts 暴露）。
	 *   确认码哈希又是 ES10b PrepareDownload 的必填项，只能自己实现。
	 *   算法按 FIPS 180-4 §4.1.2 / §5.3.3，用标准测试向量钉住：
	 *     空串 → e3b0c442…，"abc" → ba7816bf…
	 */
	var SHA256_K = [
		0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
		0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
		0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
		0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
		0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
		0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
		0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
		0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
		0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
		0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
		0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
	];

	function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

	api.sha256Hex = function (input) {
		var bytes;
		if (typeof input === 'string') bytes = utf8ToBytes(input);
		else if (input && input.length != null) bytes = Array.prototype.slice.call(input);
		else throw makeError('EUICC_BAD_HEX', 'sha256 输入必须是字符串或字节数组');

		var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
			0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
		var len = bytes.length;
		var withPad = bytes.slice();
		withPad.push(0x80);
		while (withPad.length % 64 !== 56) withPad.push(0);
		var bits = len * 8;
		/* 长度按 64 位大端写入；JS 位运算是 32 位，用乘法拆成两段避免溢出 */
		var hi = Math.floor(bits / 0x100000000);
		var lo = bits >>> 0;
		withPad.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff,
			(lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

		var w = new Array(64);
		for (var off = 0; off < withPad.length; off += 64) {
			var t;
			for (t = 0; t < 16; t++) {
				w[t] = ((withPad[off + t * 4] << 24) | (withPad[off + t * 4 + 1] << 16)
					| (withPad[off + t * 4 + 2] << 8) | withPad[off + t * 4 + 3]) >>> 0;
			}
			for (t = 16; t < 64; t++) {
				var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
				var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
				w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
			}
			var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
			for (t = 0; t < 64; t++) {
				var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				var ch = (e & f) ^ ((~e) & g);
				var t1 = (hh + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
				var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
				var maj = (a & b) ^ (a & c) ^ (b & c);
				var t2 = (S0 + maj) >>> 0;
				hh = g; g = f; f = e; e = (d + t1) >>> 0;
				d = c; c = b; b = a; a = (t1 + t2) >>> 0;
			}
			h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
			h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
			h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
			h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
		}
		var out = '';
		for (var i = 0; i < 8; i++) {
			out += ('0000000' + h[i].toString(16)).slice(-8);
		}
		return out;
	};

	/*
	 * 确认码哈希（SGP.22 / lpac es10b.c）：
	 *   hashCC = SHA-256(确认码的 UTF-8 字节)，以 tag 0x04 挂进 PrepareDownload。
	 *   卡上从不出现确认码明文，只有它的哈希。
	 */
	api.hashConfirmationCode = function (cc) {
		if (cc == null || cc === '') return null;
		return api.sha256Hex(String(cc));
	};

	/* ---------- base64 ↔ hex（ES9+ 的 DER 字段一律 base64 传输） ---------- */

	api.hexToBase64 = function (hex) {
		/*
		 * 空串是合法的：它代表「零字节」，base64 结果就是 ''。
		 * 早先直接交给 isHex 判，而 isHex 要求 length>0，于是空串被当成非法
		 * 抛 EUICC_BAD_HEX —— 在下载流程里表现为「卡返回空数据时整条链路炸掉」。
		 */
		if (hex == null || hex === '') return '';
		if (!api.isHex(hex)) throw makeError('EUICC_BAD_HEX', 'hexToBase64 输入非法');
		var b = api.hexToBytes(hex);
		var s = '';
		for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return btoa(s);
	};

	api.base64ToHex = function (b64) {
		var s = atob(String(b64 == null ? '' : b64).replace(/\s+/g, ''));
		var out = '';
		for (var i = 0; i < s.length; i++) out += hex2(s.charCodeAt(i) & 0xff);
		return out;
	};

	/* ---------- 激活码：LPA:1$<SM-DP+>$<匹配码>[$<OID>][$<确认码标志>] ----------
	 * 规则取自 luci-app-lpac 的 activationCodeIssue()：3~5 段、首段必须是 1、
	 * 匹配码 [A-Za-z0-9-]、第 5 段只能是 0/1（确认码必需标志）。
	 * 确认码本身**不在码里**，是独立输入项。
	 */

	/*
	 * 域名校验：只认 FQDN。
	 * ★ 拒绝 IP 字面量不只是格式洁癖 —— 这条地址会被原样交给后端的 ES9+ 转发，
	 *   放行了 127.0.0.1 / 192.168.x.x 就等于给登录用户一个打内网的 HTTPS 跳板。
	 */
	function isFqdn(v) {
		var s = String(v == null ? '' : v).trim();
		if (!s) return false;
		if (s.charAt(s.length - 1) === '.') s = s.slice(0, -1);
		if (s.length < 4 || s.length > 253) return false;
		if (/^[0-9.]+$/.test(s)) return false;      /* IPv4 或纯数字 */
		if (s.indexOf(':') >= 0) return false;       /* IPv6 */
		if (/^localhost$/i.test(s)) return false;
		var labels = s.split('.');
		if (labels.length < 2) return false;
		for (var i = 0; i < labels.length; i++) {
			var lb = labels[i];
			if (!lb || lb.length > 63) return false;
			if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lb)) return false;
		}
		return true;
	}
	api.isFqdn = isFqdn;

	/* 扫码器 / 复制粘贴常带进来的脏东西：空白、包裹引号。 */
	api.normalizeActivationCode = function (text) {
		return String(text == null ? '' : text)
			.replace(/[\r\n\t\v\f ]/g, '')
			.replace(/^["'“”‘’`]+/, '')
			.replace(/["'“”‘’`]+$/, '');
	};

	api.parseActivationCode = function (text) {
		var raw = api.normalizeActivationCode(text);
		if (!raw) return { ok: false, error: '请填写激活码，或扫描运营商给的二维码' };
		var s = /^LPA:/i.test(raw) ? raw.slice(4) : raw;
		var f = s.split('$');
		if (f.length < 3 || f.length > 5) {
			return {
				ok: false,
				error: '格式不对：应为 LPA:1$<服务器>$<匹配码>，当前是 ' + f.length + ' 段'
			};
		}
		if (f[0] !== '1') {
			return { ok: false, error: '不支持的版本「' + (f[0] || '空') + '」，目前只支持 1' };
		}
		var smdp = f[1] || '';
		if (!isFqdn(smdp)) return { ok: false, error: 'SM-DP+ 地址不合法：' + (smdp || '（空）') };
		var mid = f[2] || '';
		if (!/^[A-Za-z0-9-]{1,255}$/.test(mid)) {
			return { ok: false, error: '匹配码不合法（只允许字母、数字、连字符）：' + (mid || '（空）') };
		}
		var oid = f[3] || '';
		if (oid && !/^[0-9A-Za-z.\-]{1,255}$/.test(oid)) {
			return { ok: false, error: 'OID 不合法：' + oid };
		}
		/* 第 5 段：确认码必需标志。缺省 = 服务器没声明，以服务器返回为准。 */
		var ccReq = null;
		if (f.length === 5) {
			if (f[4] !== '0' && f[4] !== '1') {
				return { ok: false, error: '确认码标志只能是 0 或 1，当前是「' + f[4] + '」' };
			}
			ccReq = f[4] === '1';
		}
		return {
			ok: true, code: raw, smdp: smdp, matchingId: mid, oid: oid,
			confirmationCodeRequired: ccReq
		};
	};

	/* 反拼回来，用于「手动填写」那一路，也给测试做往返校验 */
	api.buildActivationCode = function (o) {
		o = o || {};
		var f = ['1', String(o.smdp || ''), String(o.matchingId || '')];
		if (o.oid) f.push(String(o.oid));
		if (o.confirmationCodeRequired != null) f.push(o.confirmationCodeRequired ? '1' : '0');
		return 'LPA:' + f.join('$');
	};

	/* ---------- ES10b 下载相关 APDU ----------
	 * tag 出处：lpac euicc/es10b.c 的 es10b_*_r 定义
	 *   BF2E GetEuiccChallenge（响应内含 80 = 16 字节挑战值，SGP.22 规定）
	 *   BF20 GetEuiccInfo1  （响应整体即 EUICCInfo1 的 DER，原样交给 SM-DP+）
	 *   BF22 GetEuiccInfo2  （响应整体即 EUICCInfo2，内含 84 = extCardResource）
	 *   BF38 AuthenticateServer
	 *   BF21 PrepareDownload（内含 0x04 = hashCC，仅确认码必需时带）
	 *   BF36 LoadBoundProfilePackage（按 BF23 / A0 / A1 / A2 / A3 逐段下发）
	 *   BF28 ListNotification / BF2B RetrieveNotificationList / BF30 RemoveNotificationFromList
	 *
	 * 传输层一律是 STORE DATA：CLA=0x80|ch, INS=0xE2。
	 * 分块时非末块 P1=0x11、末块 P1=0x91，P2 递增（lpac euicc/euicc.c es10x_command_iter）。
	 */
	/*
	 * ★★ tag 出处以 pySim 的 ASN.1 定义为准（pySim/euicc.py，逐条对照过）：
	 *   EuiccInfo2                 tag = 0xBF22
	 *   EuiccConfiguredAddresses   tag = 0xBF3C   ← 不是 Info2！
	 *
	 * 这条区分踩过一次：本机卡 `BF3C 00` 返回 `BF3C 17 81 15 "testrootsmds.gsma.com"`，
	 * 一度被当成「EUICCInfo2 里没有容量字段」。其实 81 是 RootDsAddress，
	 * 整条是 **GetEuiccConfiguredAddresses**（SGP.22 ES10a），跟容量毫无关系。
	 * 真正的 EUICCInfo2 要发 **BF22**。
	 */
	var ES10B_TAGS = ['BF2E', 'BF20', 'BF22', 'BF38', 'BF21', 'BF36', 'BF28', 'BF2B', 'BF30'];

	/* 组装一个 BER-TLV（支持 0x81/0x82 长格式） */
	function tlvHex(tag, valHex) {
		valHex = valHex || '';
		var n = valHex.length / 2;
		if (n < 0x80) return tag + hex2(n) + valHex;
		if (n <= 0xff) return tag + '81' + hex2(n) + valHex;
		if (n <= 0xffff) return tag + '82' + hex2(n >> 8) + hex2(n & 0xff) + valHex;
		throw makeError('EUICC_BAD_APDU', 'TLV 值过长：' + n + ' 字节');
	}
	api.tlvHex = tlvHex;

	/*
 * 读一个 BER-TLV 的「整体字节数」（tag 字节 + 长度字节 + 值字节）。
 * 只看最外层：tag 占 1 或 2 字节（低位 5 位全 1 则还有第二个字节），
 * 长度支持短格式（<0x80）与 0x81/0x82 长格式。
 * 解析不出来（太短 / 十六进制非法 / 长度字段不完整）返回 -1，由调用方决定怎么处理。
 *
 * 用途：判断响应是否被 AT+CSIM 的 256 字节上限截断 —— ES10b 的每个响应都是
 * 单个顶层 BER-TLV，声明长度大于实收长度且实收恰好 256 的整数倍，就是被切了。
 */
api.tlvTotalBytes = function (hex) {
	if (!hex || !api.isHex(hex) || hex.length < 4) return -1;
	var i = 0;
	var b0 = parseInt(hex.substr(0, 2), 16);
	i = 2;
	if ((b0 & 0x1f) === 0x1f) {
		if (hex.length < 4) return -1;
		i = 4;
	}
	if (i + 2 > hex.length) return -1;
	var l8 = parseInt(hex.substr(i, 2), 16);
	i += 2;
	var valueLen;
	if ((l8 & 0x80) === 0) {
		valueLen = l8;
	} else {
		var n = l8 & 0x7f;
		if (n < 1 || n > 2) return -1;
		if (i + n * 2 > hex.length) return -1;
		valueLen = parseInt(hex.substr(i, n * 2), 16);
		i += n * 2;
	}
	return i / 2 + valueLen;
};

api.buildEs10b = function (ch, tag, derHex) {
		if (ES10B_TAGS.indexOf(tag) < 0) {
			throw makeError('EUICC_BAD_APDU', '不允许的 ES10b tag：' + tag);
		}
		if (derHex && !api.isHex(derHex)) throw makeError('EUICC_BAD_HEX', 'derHex 非法');
		return api.storeDataApdu(ch, api.hexToBytes(tlvHex(tag, derHex || '')));
	};

	/*
	 * 长数据分块（BPP 常见几十 KB，一个 APDU 装不下）。
	 * 把**整个 TLV**（含 tag 与长度）按 mss 切片：第一片带着 tag+长度头，
	 * 后续片继续值字节；非末片 P1=0x11，末片 P1=0x91，P2 从 0 递增。
	 * mss 默认 120 —— lpac 的 es10x_mss 默认值，对 USB CDC 与多数卡片都稳。
	 */
	/*
	 * ★★ BPP 分段（2026-09-20 重写，对齐 lpac euicc/es10b.c 的
	 *   es10b_load_bound_profile_package_r —— 6A84 的真正修法）
	 *
	 * 旧实现是**错的**：把整包 BPP 当一个逻辑命令、按 255 字节切成几十块
	 * 连续下发（P1=0x11 链接）。卡必须把整包攒齐才能解析，攒到 **8160 字节**
	 * 就撞上卡的链接缓冲上限 → 6A84。三组 mss（60/120/240）都死在同一个
	 * **字节数**上，正是「卡在攒整包」的铁证。
	 *
	 * lpac 的做法是**按 BPP 自身的 TLV 结构切段**，每段是一条**独立的**
	 * STORE DATA 命令，卡收一段解析一段，缓冲永远不会累积：
	 *
	 *   ① BF36 头 + BF23 整块（initialiseSecureChannelRequest）
	 *   ② A0 整块（configureISDP）
	 *   ③ A1 **只发容器头**（tag+长度，不含值），随后 A1 的每个子 TLV 各发一次
	 *   ④ A2 整块（可选，存在才发）
	 *   ⑤ A3 **只发容器头**，随后 A3 的每个子 TLV 各发一次
	 *
	 * ③⑤ 是关键：先告诉卡「接下来有 N 字节属于这个容器」，再逐个子元素喂进去，
	 *   卡那边是流式消费，不需要为整个容器留缓冲。
	 * 每段内部若超过 255 字节，再用旧的 P1=0x11/0x91 链接切成块（lpac 的
	 *   es10x_command_iter），此时累积上限只是「单个子元素」的大小。
	 */

	/* 读一个 BER-TLV 节点。hex 是十六进制串，i 是**字符下标**。
	 * 返回 { tag, start, valueStart, valueLen, end }；end = 本节点结束处的字符下标。
	 * 解析不出来返回 null（越界 / 不支持的长度格式）。 */
	function readTlvAt(hex, i) {
		if (!hex || i + 4 > hex.length) return null;
		var b0 = parseInt(hex.substr(i, 2), 16);
		var tag = hex.substr(i, 2);
		var j = i + 2;
		if ((b0 & 0x1f) === 0x1f) {
			/* 两字节 tag（BF36 / BF23 这类） */
			if (i + 6 > hex.length) return null;
			tag = hex.substr(i, 4);
			j = i + 4;
		}
		if (j + 2 > hex.length) return null;
		var l8 = parseInt(hex.substr(j, 2), 16);
		j += 2;
		var valueLen;
		if ((l8 & 0x80) === 0) {
			valueLen = l8;
		} else {
			var n = l8 & 0x7f;
			if (n < 1 || n > 2) return null;
			if (j + n * 2 > hex.length) return null;
			valueLen = parseInt(hex.substr(j, n * 2), 16);
			j += n * 2;
		}
		var end = j + valueLen * 2;
		if (end > hex.length) return null;
		return {
			tag: tag.toUpperCase(), start: i, valueStart: j,
			valueLen: valueLen, end: end
		};
	}

	/* 列出一个构造型节点的所有直接子节点 */
	function tlvChildren(hex, node) {
		var out = [];
		var i = node.valueStart;
		while (i + 4 <= node.end) {
			var c = readTlvAt(hex, i);
			if (!c || c.end > node.end) break;
			out.push(c);
			i = c.end;
		}
		return out;
	}

	function tlvFindChild(hex, node, tag) {
		var kids = tlvChildren(hex, node);
		for (var k = 0; k < kids.length; k++) {
			if (kids[k].tag === tag) return kids[k];
		}
		return null;
	}

	/*
	 * 把一个 BoundProfilePackage（服务器给的，本身以 BF36 开头）
	 * 切成若干「段」，每段是一条独立 STORE DATA 命令的内容。
	 * 返回 [{ hex, label }]，label 只用于日志。
	 */
	api.splitBoundProfilePackage = function (bppHex) {
		if (!bppHex || !api.isHex(bppHex)) {
			throw makeError('EUICC_BAD_HEX', 'BPP 不是合法十六进制');
		}
		var outer = readTlvAt(bppHex, 0);
		if (!outer || outer.tag !== 'BF36') {
			throw makeError('EUICC_BAD_APDU', 'BPP 不是以 BF36 开头的 BoundProfilePackage');
		}
		var segs = [];

		var bf23 = tlvFindChild(bppHex, outer, 'BF23');
		if (!bf23) throw makeError('EUICC_BAD_APDU', 'BPP 里找不到 BF23（initialiseSecureChannelRequest）');
		segs.push({ hex: bppHex.slice(0, bf23.end), label: 'initialiseSecureChannel(BF23)' });

		var a0 = tlvFindChild(bppHex, outer, 'A0');
		if (a0) segs.push({ hex: bppHex.slice(a0.start, a0.end), label: 'configureISDP(A0)' });

		var a1 = tlvFindChild(bppHex, outer, 'A1');
		if (a1) {
			segs.push({ hex: bppHex.slice(a1.start, a1.valueStart), label: 'A1 容器头' });
			tlvChildren(bppHex, a1).forEach(function (c, i) {
				segs.push({ hex: bppHex.slice(c.start, c.end), label: 'A1[' + i + '] tag=' + c.tag });
			});
		}

		var a2 = tlvFindChild(bppHex, outer, 'A2');
		if (a2) segs.push({ hex: bppHex.slice(a2.start, a2.end), label: 'A2' });

		var a3 = tlvFindChild(bppHex, outer, 'A3');
		if (!a3) throw makeError('EUICC_BAD_APDU', 'BPP 里找不到 A3（loadProfileElements 容器）');
		segs.push({ hex: bppHex.slice(a3.start, a3.valueStart), label: 'A3 容器头' });
		tlvChildren(bppHex, a3).forEach(function (c, i) {
			segs.push({ hex: bppHex.slice(c.start, c.end), label: 'A3[' + i + '] tag=' + c.tag });
		});

		return segs;
	};

	/* 把**已经组好的一段 TLV 原文**按 mss 切成 APDU（不再套 tag）。
	 * P2 从 0 起算 —— 每段都是一条新命令，序号必须归零（lpac 的 reqseq 亦然）。 */
	api.buildEs10bRawChunks = function (ch, hex, mss) {
		var limit = (mss > 0 && mss <= 240) ? mss : 120;
		var chunks = [];
		for (var i = 0; i < hex.length; i += limit * 2) {
			chunks.push(hex.substr(i, limit * 2));
		}
		return chunks.map(function (c, idx) {
			var last = idx === chunks.length - 1;
			return api.storeDataApdu(ch, api.hexToBytes(c), {
				p1: last ? 0x91 : 0x11, p2: idx & 0xff
			});
		});
	};

	api.buildEs10bChunks = function (ch, tag, derHex, mss) {
		return api.buildEs10bRawChunks(ch, tlvHex(tag, derHex || ''), mss);
	};

	/*
	 * ctxParams1 —— ES10b.AuthenticateServer 的**必带**字段（SGP.22 里它不是
	 * OPTIONAL）。装配方式照 lpac 的实现（euicc/es10b.c 的
	 * es10b_authenticate_server_r），真机可验：
	 *
	 *   A0                      CtxParams1 = CHOICE 的 ctxParamsForCommonAuthentication
	 *   ├─ 80 <matchingId>      [0] UTF8String（激活码里的匹配码）
	 *   └─ A1                   [1] DeviceInfo
	 *      ├─ 80 04 <tac>       [0] Octet4（IMEI 前 4 位；没有就用 lpac 的默认值）
	 *      ├─ A1 00             [1] deviceCapabilities（lpac 留空）
	 *      └─ 82 <imei>         [2] Octet8，可选，本项目不填
	 *
	 * ★ 为什么必须补（2026-09-19 真机实测）：缺这一段时卡直接回
	 *   `BF38 17 A1 15 80 10 <transactionId> 02 01 7F` —— 按规范这是
	 *   AuthenticateResponseError，authenticateErrorCode = 127 = undefinedError，
	 *   下载永远停在第 4 步「卡片校验服务器」。matchingId 还负责把这次下载
	 *   与激活码绑定，缺了它即便卡放行，服务器也会拒。
	 */
	api.buildCtxParams1 = function (matchingId, tacHex) {
		var tac = (tacHex && api.isHex(tacHex) && tacHex.length === 8) ? tacHex : '35290611';
		var deviceInfo = tlvHex('A1', tlvHex('80', tac) + 'A100');
		var body = '';
		if (matchingId) {
			body += tlvHex('80', api.bytesToHex(utf8ToBytes(String(matchingId))));
		}
		body += deviceInfo;
		return tlvHex('A0', body);
	};

	api.buildGetEuiccChallenge = function (ch) { return api.buildEs10b(ch, 'BF2E', ''); };
	api.buildGetEuiccInfo1 = function (ch) { return api.buildEs10b(ch, 'BF20', ''); };
	api.buildGetEuiccInfo2 = function (ch) { return api.buildEs10b(ch, 'BF22', ''); };
	api.buildListNotification = function (ch, filterHex) {
		return api.buildEs10b(ch, 'BF28', filterHex || '');
	};
	/* seqNumber 是 0x80 包裹的 1~N 字节整数 */
	api.buildRetrieveNotificationList = function (ch, seqHex) {
		return api.buildEs10b(ch, 'BF2B', tlvHex('A0', tlvHex('80', seqHex || '00')));
	};
	api.buildRemoveNotificationFromList = function (ch, seqHex) {
		return api.buildEs10b(ch, 'BF30', tlvHex('80', seqHex || '00'));
	};

	/*
	 * 从 EUICCInfo2 里解出 extCardResource —— 界面「卡容量」的数据来源。
	 *
	 * 结构与 tag（逐条有出处，不是凭记忆）：
	 *   EUICCInfo2 (BF22)
	 *     └─ 84 <len>               extCardResource（pySim/euicc.py：ExtCardResource tag=0x84）
	 *        ├─ 81 <n> <bytes>      installedApplication  已安装应用数
	 *        ├─ 82 <n> <bytes>      freeNonVolatileMemory 剩余非易失内存（字节）
	 *        └─ 83 <n> <bytes>      freeVolatileMemory    剩余易失内存（字节）
	 *   84 的子字段号取自 ETSI TS 102 226 §8.2.1.7.2（GlobalPlatform GET DATA
	 *   'FF21' 用的是同一套定义：81=已装应用数 / 82=剩余 NV / 83=剩余 RAM），
	 *   与 euicc-go/rsp-dump 的解析顺序一致，也与 lpac 输出的字段名一致。
	 *
	 * ★ 两个内存数是**变长大端整数**（SGP.22 上限 3 字节），不能按固定宽度读。
	 * ★ SGP.22 只规定上报**剩余**内存，**没有「总容量」字段** —— 所以这里不伪造
	 *   「已用 / 总量」，只给剩余量；界面按剩余量展示，别自己脑补分母。
	 * ★ 84 是个「基本型 tag 装着构造内容」的怪编码（pySim 也只能当 GreedyBytes 收），
	 *   个别实现会按构造型 A4 发，两种都认。
	 *
	 * 84 不存在、或三个子字段一个都没有 → 返回 null，调用方按「本卡未上报容量」处理。
	 */
	api.parseExtCardResource = function (info2Hex) {
		function beInt(hex) {
			var v = 0, b;
			for (var i = 0; i < hex.length; i += 2) {
				b = parseInt(hex.substr(i, 2), 16);
				if (isNaN(b)) return NaN;
				v = v * 256 + b;
			}
			return v;
		}
		var blob = api.pickTagValue(info2Hex, '84') || api.pickTagValue(info2Hex, 'A4');
		if (!blob) return null;
		var installed = api.pickTagValue(blob, '81');
		var freeNv = api.pickTagValue(blob, '82');
		var freeV = api.pickTagValue(blob, '83');
		if (!installed && !freeNv && !freeV) return null;
		var out = {};
		if (installed) out.installedApplication = beInt(installed);
		if (freeNv) out.freeNonVolatileMemory = beInt(freeNv);
		if (freeV) out.freeVolatileMemory = beInt(freeV);
		return out;
	};

	/*
	 * 从一段 DER 里取指定 tag 的值。
	 *
	 * ★ 必须**下钻构造 tag**（首字节 bit0x20，如 BF2E / A0 / BF2F）：
	 *   ES10b 的应答几乎都是「构造 tag 包着基本 tag」，例如
	 *   GetEuiccChallenge 返回 BF2E 0A 80 08 <挑战值> —— 挑战值在 BF2E **里面**。
	 *   早先这函数遇到多字节 tag 就整段跳过，于是取挑战值永远得到空串，
	 *   下载在第一步就抛 EUICC_TLV_TRUNCATED（真机表现为「点添加立刻失败」）。
	 * 深度上限 8 层，防畸形 DER 把栈打穿；找不到返回 ''。
	 */
	api.pickTagValue = function (dataHex, tag) {
		var bytes;
		try {
			bytes = api.hexToBytes(dataHex || '');
		} catch (e) {
			return '';
		}
		return pickIn(bytes, 0, bytes.length, String(tag).toUpperCase(), 0);
	};

	function pickIn(bytes, start, end, want, depth) {
		if (depth > 8) return '';
		var i = start;
		while (i + 2 <= end) {
			var first = bytes[i];
			var t, j;
			if ((first & 0x1f) === 0x1f) {
				/* 多字节 tag：续到最高位为 0 的那个字节 */
				j = i + 1;
				while (j < end && (bytes[j] & 0x80)) j++;
				j++;
				t = api.bytesToHex(bytes.slice(i, j)).toUpperCase();
			} else {
				j = i + 1;
				t = hex2(first).toUpperCase();
			}
			if (j >= end) return '';
			var lenByte = bytes[j], len, vs;
			if (lenByte < 0x80) { len = lenByte; vs = j + 1; }
			else if (lenByte === 0x81) { len = bytes[j + 1]; vs = j + 2; }
			else if (lenByte === 0x82) { len = (bytes[j + 1] << 8) | bytes[j + 2]; vs = j + 3; }
			else return '';
			if (len < 0 || vs + len > end) return '';
			if (t === want) return api.bytesToHex(bytes.slice(vs, vs + len));
			if ((first & 0x20) === 0x20) {
				var sub = pickIn(bytes, vs, vs + len, want, depth + 1);
				if (sub) return sub;
			}
			i = vs + len;
		}
		return '';
	}

	/* ---------- ES9+（SM-DP+ 侧）----------
	 * 端点与字段取自 lpac euicc/es9p.c：
	 *   https://<smdp>/gsma/rsp2/es9plus/<function>
	 * 请求头：Content-Type: application/json、X-Admin-Protocol: gsma/rsp/v2.2.2、
	 *        User-Agent: gsma-rsp-lpad
	 * 结构化字段（serverSigned1 / euiccInfo1 / 各类证书与签名）一律 base64 的 DER。
	 */
	api.ES9P_PATHS = {
		initiateAuthentication: '/gsma/rsp2/es9plus/initiateAuthentication',
		authenticateClient: '/gsma/rsp2/es9plus/authenticateClient',
		getBoundProfilePackage: '/gsma/rsp2/es9plus/getBoundProfilePackage',
		handleNotification: '/gsma/rsp2/es9plus/handleNotification',
		cancelSession: '/gsma/rsp2/es9plus/cancelSession'
	};

	api.es9pRequest = function (name, obj) {
		var path = api.ES9P_PATHS[name];
		if (!path) throw makeError('EUICC_BAD_APDU', '未知的 ES9+ 调用：' + name);
		return { path: path, json: JSON.stringify(obj || {}) };
	};

	/*
	 * 下载一个 Profile。
	 *
	 * @param send  (atCmd, opts) => Promise<{success,data,error}>   —— 与其余接口同一个注入点
	 * @param es9p  (host, path, json) => Promise<{status, body}>     —— ES9+ 转发（由 esim.js 注入）
	 * @param opts  { activation, confirmationCode, onStep, log, mss }
	 *
	 * ★ 任何一步失败都 throw 带 code 的 Error，绝不「吞掉当成功」 ——
	 *   Profile 下载是**有外部副作用**的操作（SM-DP+ 会记一次下载订单），
	 *   报假成功的代价比直接报错大得多。
	 */
	api.downloadProfile = function (send, es9p, opts) {
		opts = opts || {};
		var act = opts.activation || {};
		var onStep = opts.onStep || function () { };
		var log = opts.log || function () { };
		var onTx = opts.onTransactionId || function () { };
		var mss = opts.mss || 120;
		var smdp = act.smdp;
		if (!smdp) throw makeError('EUICC_BAD_APDU', '缺少 SM-DP+ 地址');
		if (typeof es9p !== 'function') {
			throw makeError('EUICC_NO_ES9P', '缺少 ES9+ 通道，无法与服务器通信');
		}

		function es9pJson(name, obj) {
			var req = api.es9pRequest(name, obj);
			log('→ ' + name + ' ' + req.path);
			return es9p(smdp, req.path, req.json).then(function (r) {
				var text = (r && r.body) || '';
				log('← ' + name + ' HTTP ' + ((r && r.status) || '?') + ' · ' + text.slice(0, 200));
				if (!r || r.status == null || r.status < 200 || r.status >= 300) {
					throw makeError('EUICC_ES9P_FAILED',
						name + ' 失败（HTTP ' + ((r && r.status) || '无响应') + '）：' + text.slice(0, 200));
				}
				var parsed = null;
				try { parsed = text ? JSON.parse(text) : {}; } catch (e) { parsed = null; }
				if (parsed == null) {
					throw makeError('EUICC_ES9P_FAILED', name + ' 返回的不是 JSON：' + text.slice(0, 200));
				}
				return parsed;
			});
		}

		var tx = null;
		var challenge = '';
		var euiccInfo1 = '';

		return api.withIsdrSession(send, function (ch, sendApdu) {
			function apdu(tag, der, label) {
				return sendApdu(api.buildEs10b(ch, tag, der)).then(function (r) {
					log('卡 ← ' + (label || tag) + ' SW=' + r.sw);
					if (r.sw !== '9000' && r.sw !== '9100') {
						throw makeSwError('EUICC_OP_FAILED', r.sw);
					}
					return r.data || '';
				});
			}

			/*
			 * 长命令分块下发（★ 2026-09-19 真机实测）：
			 *   本模组的 AT+CSIM 单条上限是 **520 个十六进制字符（260 字节）**
			 *   （`AT+CSIM=?` 实报 `(4-520),(cmd)`），而 AuthenticateServer(BF38) /
			 *   PrepareDownload(BF21) 要带服务器证书链，动辄几百字节 —— 一条装不下，
			 *   单条下发会直接撞 csimCommand 的长度上限抛 EUICC_BAD_APDU，
			 *   下载卡在第 4 步。按 ES10b 的分块 STORE DATA 下发即可
			 *   （P1=0x11 中间块 / 0x91 末块，P2 递增；与 BPP 同一套）。
			 *   装得下就仍走单条 —— 少一轮交互，也避免改变既有短命令的行为。
			 */
			function apduAuto(tag, der, label) {
				var single = api.buildEs10b(ch, tag, der || '');
				if (single.length <= 520) return apdu(tag, der, label);

				var chunks = api.buildEs10bChunks(ch, tag, der || '', mss);
				log((label || tag) + ' 超单条上限（' + single.length + ' 字符），分 ' +
					chunks.length + ' 块下发');
				var chain = Promise.resolve('');
				chunks.forEach(function (c, idx) {
					chain = chain.then(function () {
						return sendApdu(c);
					}).then(function (r) {
						log('卡 ← ' + (label || tag) + ' ' + (idx + 1) + '/' +
							chunks.length + ' SW=' + r.sw + ' 数据 ' +
							((r.data || '').length / 2) + ' 字节');
						if (idx === chunks.length - 1) {
							log('  末块原文: ' + (r.data || '(空)'));
						}
						if (r.sw !== '9000' && r.sw !== '9100') {
							throw makeSwError('EUICC_OP_FAILED', r.sw);
						}
						return r.data || '';
					});
				});
				return chain;
			}

			/* ① eUICC 挑战值 —— 服务器要用它证明「这次是这张卡在请求」 */
			onStep(1, '读取 eUICC 挑战值');
			return apdu('BF2E', '', 'GetEuiccChallenge')
				.then(function (data) {
					challenge = api.pickTagValue(data, '80');
					/*
					 * euiccChallenge 是 16 字节（tag 80 后跟 16 字节，32 个十六进制字符），
					 * SGP.22 规定。但这里**不校验长度**：服务器与卡按同一份值做绑定，
					 * 卡给多少就原样透传多少最安全；写死长度只会拦掉正常的卡
					 * （早期写死成 8 字节，结果每张合规卡都在这一步失败、流程走不到 ES9+）。
					 * 只校验非空且偶数，长度异常时记一条 warn 便于定位异常卡。
					 */
					if (!challenge || challenge.length < 2 || challenge.length % 2 !== 0) {
						throw makeError('EUICC_TLV_TRUNCATED', '取不到 eUICC 挑战值（tag 80 缺失或长度异常）');
					}
					if (challenge.length !== 32 && typeof console !== 'undefined' && console.warn) {
						console.warn('[euicc] euiccChallenge 为 ' + (challenge.length / 2) +
							' 字节（SGP.22 规定 16 字节），按原样透传');
					}
					/* ② eUICC 信息（版本 / 支持的算法） */
					onStep(2, '读取 eUICC 信息');
					return apdu('BF20', '', 'GetEuiccInfo1');
				})
				.then(function (data) {
					euiccInfo1 = data;
					if (!euiccInfo1) throw makeError('EUICC_TLV_TRUNCATED', '取不到 EUICCInfo1');

					/* ③ ES9+ initiateAuthentication */
					onStep(3, '联系服务器（1/4）');
					return es9pJson('initiateAuthentication', {
						smdpAddress: smdp,
						euiccChallenge: api.hexToBase64(challenge),
						euiccInfo1: api.hexToBase64(euiccInfo1)
					});
				})
				.then(function (resp) {
				tx = resp.transactionId;
				onTx(tx);
				if (!tx) throw makeError('EUICC_ES9P_FAILED', '服务器没给 transactionId');

					/* ④ 把服务器签名交给卡去验（验的是 CI 证书链，在卡里完成） */
					onStep(4, '卡片校验服务器（2/4）');
					var der = ''
						+ (resp.serverSigned1 ? api.base64ToHex(resp.serverSigned1) : '')
						+ (resp.serverSignature1 ? api.base64ToHex(resp.serverSignature1) : '')
						+ (resp.euiccCiPKIdToBeUsed ? api.base64ToHex(resp.euiccCiPKIdToBeUsed) : '')
						+ (resp.serverCertificate ? api.base64ToHex(resp.serverCertificate) : '');
					/* ctxParams1 必带（见 buildCtxParams1 注释）：缺了它卡回
					   undefinedError(127)，且服务器无法把这次下载与激活码绑定 */
					der += api.buildCtxParams1(act.matchingId, opts.tac);
					return apduAuto('BF38', der, 'AuthenticateServer');
				})
				.then(function (data) {
					/* ⑤ 把卡的应答回给服务器 */
					onStep(5, '服务器校验卡片（3/4）');
					return es9pJson('authenticateClient', {
						transactionId: tx,
						authenticateServerResponse: api.hexToBase64(data)
					});
				})
				.then(function (resp) {
					/* ⑥ 准备下载：确认码哈希只在 ccRequiredFlag 为真时带 */
					onStep(6, '准备下载');
					var ccHash = api.hashConfirmationCode(opts.confirmationCode);
					var der = ''
						+ (resp.smdpSigned2 ? api.base64ToHex(resp.smdpSigned2) : '')
						+ (resp.smdpSignature2 ? api.base64ToHex(resp.smdpSignature2) : '')
						+ (resp.smdpCertificate ? api.base64ToHex(resp.smdpCertificate) : '');
					if (ccHash) der += tlvHex('04', ccHash);
					return apduAuto('BF21', der, 'PrepareDownload');
				})
				.then(function (data) {
					/* ⑦ 取回 BPP（加密的 Profile 包，只有这张卡解得开） */
					onStep(7, '下载 Profile 包（4/4）');
					return es9pJson('getBoundProfilePackage', {
						transactionId: tx,
						prepareDownloadResponse: api.hexToBase64(data)
					});
				})
				.then(function (resp) {
					if (!resp.boundProfilePackage) {
						throw makeError('EUICC_ES9P_FAILED', '服务器没返回 boundProfilePackage');
					}
					/*
					 * ⑧ 装进卡里。
					 *
					 * ★★ 不能再 `buildEs10bChunks(ch,'BF36', bpp, mss)`：
					 *   ① bpp 本身就是 BF36 开头的 BoundProfilePackage，再套一层 BF36
					 *      等于发了个自己都不认识的嵌套包；
					 *   ② 更要命的是那样会把整包当一个逻辑命令连续下发，卡得攒齐
					 *      整包才能解析 → 攒到 8160 字节必然 6A84（四组 mss 对照的
					 *      共同死点）。现在按 BPP 自身的 TLV 结构分段（见
					 *      splitBoundProfilePackage 的注释），每段一条独立命令。
					 */
					var bpp = api.base64ToHex(resp.boundProfilePackage);
					var segs = api.splitBoundProfilePackage(bpp);
					var totalBlocks = 0;
					segs.forEach(function (s) {
						totalBlocks += api.buildEs10bRawChunks(ch, s.hex, mss).length;
					});
					onStep(8, '写入卡片（' + segs.length + ' 段 / ' + totalBlocks + ' 块）');
					log('BPP ' + (bpp.length / 2) + ' 字节，按结构切成 ' + segs.length +
						' 段，共 ' + totalBlocks + ' 块');
					var chain = Promise.resolve('');
					var lastData = '';
					segs.forEach(function (seg, si) {
						var chunks = api.buildEs10bRawChunks(ch, seg.hex, mss);
						chunks.forEach(function (c, idx) {
							chain = chain.then(function () {
								onStep(8, '写入卡片（段 ' + (si + 1) + '/' + segs.length +
									'，块 ' + (idx + 1) + '/' + chunks.length + '）');
								/*
								 * ★ 卡侧处理一段可能要几秒，后端等不到结束码就报
								 *   「模组无响应」。此时不要立刻作废整包 —— 先补取一次
								 *   （见 recoverAfterTimeout 的注释）。
								 */
								return sendApdu(c).catch(function (e) {
									if (!isAtTimeoutError(e)) throw e;
									log('⚠ ' + seg.label + ' ' + (idx + 1) + '/' + chunks.length +
										' 未收到应答（' + (e.message || '') + '），正在向卡补取…');
									return recoverAfterTimeout(send, ch, 1, log);
								});
							}).then(function (r) {
								log('卡 ← ' + seg.label + ' ' + (idx + 1) + '/' +
									chunks.length + ' SW=' + r.sw +
									(r.recovered ? '（补取）' : ''));
								if (r.sw !== '9000' && r.sw !== '9100') {
									var se = makeSwError('EUICC_OP_FAILED', r.sw);
									/* 定位到「第几段」—— 一整包几十块时，只报块号等于没报 */
									se.segment = si + 1;
									se.segmentLabel = seg.label;
									throw se;
								}
								if (r.data) lastData = r.data;
								return r.data || '';
							});
						});
					});
					return chain.then(function () { return lastData; });
				})
				.then(function () {
					/* ⑨ 装完必须把结果回执发给服务器，否则服务器侧这份 Profile
					   一直挂在「未确认」，可能被回收（lpac 的 notification 流程）。 */
					onStep(9, '发送安装回执');
					/* ★ 必须复用当前会话：这里再调 api.processNotifications 会**嵌套开第二条
					   逻辑通道**（withIsdrSession 每次都 open/close）。多数卡只给 1~3 条
					   逻辑通道，且 ISD-R 已被外层会话选中，重复开通道轻则浪费、重则 open
					   失败（6A81）把「本来装成功了」变成「回执发不出去」。 */
					return processNotificationsIn(ch, sendApdu, es9p, { log: log, host: smdp })
						.catch(function (e) {
							/* 回执失败不推翻「已装上」这个事实，但必须让用户知道 */
							log('回执失败：' + ((e && e.message) || e));
							return { sent: 0, failed: true, error: (e && e.message) || String(e) };
						});
				})
				.then(function (notif) {
					onStep(10, '完成');
					return { transactionId: tx, notification: notif || null };
				});
		});
	};

	/*
	 * 处理卡上待发的安装回执：
	 *   ListNotification(BF28) → RetrieveNotificationList(BF2B)
	 *   → ES9+ handleNotification → RemoveNotificationFromList(BF30)
	 * 单独导出是因为：即便下载不是本页做的（比如用别的工具装的），
	 * 卡上也可能攒着没发出去的回执，得有个入口能补发。
	 */
	api.processNotifications = function (send, es9p, opts) {
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return processNotificationsIn(ch, sendApdu, es9p, opts);
		});
	};

	/*
	 * 上者的「会话内」版本：调用方已经在 withIsdrSession 里时用它，
	 * 不要再去开一条新通道（见 downloadProfile 步骤 ⑨ 的注释）。
	 */
	function processNotificationsIn(ch, sendApdu, es9p, opts) {
		opts = opts || {};
		var log = opts.log || function () { };
		var host = opts.host || '';
		return sendApdu(api.buildListNotification(ch))
			.then(function (r) {
				log('卡 ← ListNotification SW=' + r.sw);
				if (r.sw !== '9000') throw makeSwError('EUICC_OP_FAILED', r.sw);
				return api.parseNotifications(r.data || '');
			})
			.then(function (list) {
				if (!list.length) return { sent: 0, total: 0 };
				var chain = Promise.resolve(0);
				list.forEach(function (n) {
					chain = chain.then(function (done) {
						return sendApdu(api.buildRetrieveNotificationList(ch, n.seqHex))
							.then(function (r) {
								if (r.sw !== '9000') throw makeSwError('EUICC_OP_FAILED', r.sw);
									/*
									 * 每条回执发回**它自己的** SM-DP+：
									 * 地址就写在通知里（BF2F 的 0C，见 parseNotifications），
									 * 比调用方猜的 host 准。只有通知里没带时才用 host 兜底。
									 *
									 * 早先这里只看 host，而「处理待发回执」按钮拿不出 host
									 * （用户没在下载，也就没有 SM-DP+ 地址），于是只要卡上真有
									 * 待发回执就必然抛 EUICC_NO_ES9P —— 按钮等于摆设。
									 */
									var target = n.address || host;
									if (!target || typeof es9p !== 'function') {
										throw makeError('EUICC_NO_ES9P', '缺少 ES9+ 通道，回执发不出去');
									}
									var req = api.es9pRequest('handleNotification', {
										pendingNotification: api.hexToBase64(r.data || '')
									});
									return es9p(target, req.path, req.json).then(function (resp) {
									var st = resp && resp.status;
									/* lpac：handleNotification 期望 204，其余 2xx 也认 */
									if (st == null || st < 200 || st >= 300) {
										throw makeError('EUICC_ES9P_FAILED',
											'回执失败（HTTP ' + st + '）');
									}
									return sendApdu(api.buildRemoveNotificationFromList(ch, n.seqHex));
								});
							})
							.then(function () { return done + 1; });
					});
				});
				return chain.then(function (sent) { return { sent: sent, total: list.length }; });
			});
	}

	/* ASCII（SM-DP+ 地址、运营商名这类单字节文本；非 ASCII 会退成 '?'，够定位用） */
	function hexToAscii(hex) {
		if (!hex) return '';
		var b;
		try {
			b = api.hexToBytes(hex);
		} catch (e) {
			return '';
		}
		var s = '';
		for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return s;
	}

	/*
	 * 解析 ListNotification 应答：BF28 → A0 → 若干 BF2F。
	 * 每项取：80=序号、81=操作、0C=SM-DP+ 地址（ASCII，回执要发回这台服务器）。
	 * 只抽这三项，其余不管（这页只需要「有没有待发回执、是哪条、发给谁」）。
	 */
	api.parseNotifications = function (dataHex) {
		var out = [];
		if (!dataHex) return out;
		/* BF2F 在应答里可能出现多次，按字节扫 */
		var bytes = api.hexToBytes(dataHex);
		for (var i = 0; i + 1 < bytes.length; i++) {
			if (bytes[i] !== 0xBF || bytes[i + 1] !== 0x2F) continue;
			var lenByte = bytes[i + 2];
			var vs, len;
			if (lenByte == null) break;
			if (lenByte < 0x80) { len = lenByte; vs = i + 3; }
			else if (lenByte === 0x81) { len = bytes[i + 3]; vs = i + 4; }
			else { len = (bytes[i + 3] << 8) | bytes[i + 4]; vs = i + 5; }
			if (vs + len > bytes.length) break;
			var item = dataHex.substr(vs * 2, len * 2);
			var seq = api.pickTagValue(item, '80');
			var op = api.pickTagValue(item, '81');
			if (seq) {
				/* 操作类型映射（SGP.22 Notification 序号）。数值未核对，未知
				 * 一律显示「操作 <十进制序号>」，绝不编造名称（P04）。 */
				var OP_LABELS = { '01': '安装', '02': '启用', '03': '禁用', '04': '删除' };
				var opNum = parseInt(op, 16);
				var opLabel = OP_LABELS[op] || ('操作 ' + (isNaN(opNum) ? '?' : opNum));
				var iccidHex = api.pickTagValue(item, '5A');
				out.push({
					seqHex: seq,
					seq: parseInt(seq, 16),
					operation: op || '',
					opLabel: opLabel,
					/* 5A 是 ICCID（nibble 已交换）；卡不带就留空（P04/P09） */
					iccid: iccidHex ? api.swapNibbles(iccidHex) : '',
					/* 0C 是 ASCII 的 SM-DP+ 地址；没有就用调用方给的 host 兜底 */
					address: hexToAscii(api.pickTagValue(item, '0C'))
				});
			}
			i = vs + len - 1;
		}
		return out;
	};


	/*
	 * 只读列出卡上待发回执（P02）：只 ListNotification，**绝不** Remove，避免
	 * 「用户只想看一眼有没有待发回执」就被顺手删掉（删除不可逆，删了就永远发不出）。
	 * SW≠9000 按 EUICC_OP_FAILED 抛（带 swText）。
	 */
	api.listNotifications = function (send) {
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return sendApdu(api.buildListNotification(ch)).then(function (r) {
				if (r.sw !== '9000') throw makeSwError('EUICC_OP_FAILED', r.sw);
				return { items: api.parseNotifications(r.data || '') };
			});
		});
	};

	/*
	 * 移除单条待发回执（P04）：**不可逆**，调用方（esim.js）必须二次确认。
	 * seqHex 非法（非 hex，或长度 > 4 个字符）直接抛 EUICC_BAD_APDU，连卡都不下问。
	 */
	api.removeNotification = function (send, seqHex) {
		if (!api.isHex(seqHex) || seqHex.length > 4) {
			throw makeError('EUICC_BAD_APDU', '非法的通知序号：' + seqHex);
		}
		return api.withIsdrSession(send, function (ch, sendApdu) {
			return sendApdu(api.buildRemoveNotificationFromList(ch, seqHex)).then(function (r) {
				if (r.sw !== '9000') throw makeSwError('EUICC_OP_FAILED', r.sw);
				return { sw: r.sw };
			});
		});
	};

	/*
	 * 取消下载会话（P08）：只发 ES9+ cancelSession，**不下发**卡侧 ES10b CancelSession
	 * （tag 未核对，猜错会 6A80/6985，把进行中的下载搞成半死状态）。
	 * tx 空抛 EUICC_BAD_APDU；HTTP 非 2xx 只 log 不抛（best-effort：取消失败不能
	 * 盖掉「用户已取消」这个事实）。
	 */
	api.cancelSession = function (es9p, smdp, tx) {
		if (!tx || typeof es9p !== 'function') {
			throw makeError('EUICC_BAD_APDU', '缺少会话事务号或 ES9+ 通道');
		}
		var req = api.es9pRequest('cancelSession', { transactionId: tx });
		return Promise.resolve(es9p(smdp, req.path, req.json)).then(function (r) {
			var st = (r && r.status);
			if (st == null || st < 200 || st >= 300) {
				if (typeof console !== 'undefined' && console.warn) {
					console.warn('[euicc] 取消会话未成功（HTTP ' + st + '），已忽略');
				}
				return { ok: false, status: st };
			}
			return { ok: true, status: st };
		}).catch(function (e) {
			if (typeof console !== 'undefined' && console.warn) {
				console.warn('[euicc] 取消会话失败：' + ((e && e.message) || e));
			}
			return { ok: false, status: 0 };
		});
	};

	api.ISDR_AID = ISDR_AID;
	api.MAX_ROUNDS = MAX_ROUNDS;
	api.ERR_CODES = ERR_CODES;
	api.es10Result = es10Result;
	api.ES10B_TAGS = ES10B_TAGS;
	api.isFqdn = isFqdn;

	return api;
})();

/*
 * LuCI 工厂：返回 Class 子类并挂到 window.Euicc（视图通过 require 指令拿到全局实例）。
 * 照抄 parse.js:1355-1359。
 */
var EuiccClass = L.Class.extend(Euicc);
if (typeof window !== 'undefined') {
	window.Euicc = new EuiccClass();
}
return EuiccClass;
