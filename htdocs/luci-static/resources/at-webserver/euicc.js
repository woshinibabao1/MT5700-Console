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
	 * AT+CSIM 单条响应能带回的**最大数据字节数**。
	 *
	 * ★ 2026-09-19 真机实测（H5000M / MT5700）：这是**模组固件**的硬上限，不是我们
	 *   或卡的限制，已经用四条独立证据钉死：
	 *     ① ES10b.AuthenticateServer 的响应 TLV 声明 1631 字节，实收恰好 256 字节；
	 *     ② 响应里 SW=9000（不是 61xx），也就是说模组自己认为「已经给完了」；
	 *     ③ 截断后立刻补发 81C0000000 / 81C00000FF / 81C0000080 / 81C0000001
	 *        四种 GET RESPONSE，全部 0 字节（9000 / 6700）—— 卡上没有残留；
	 *     ④ 重发末块回 6A86，卡不会重吐一次响应。
	 *   （AT+CCHO / AT+CGLA / AT+CRSM / AT+CLAC 该模组全部不支持，AT+CSIM 是唯一
	 *     APDU 通路；STORE DATA 带 Le 的 case 4 无论 Le 取何值都被 AT 层拒。）
	 *
	 * 后果：完整 Profile 下载在本设备上走不通 —— AuthenticateServer 的响应必然
	 * 超过 256 字节。读取 / 启用 / 禁用 / 删除这类短响应操作不受影响。
	 */
	var CSIM_MAX_RESPONSE_BYTES = 256;

	/* 通道号记录（R04）：检测通道泄漏。每次 open 成功更新；若本次通道号比上次大，
	 * 记下疑似泄漏提示，交由上层（probe → esim.js）展示，避免悄然累积到第 20 次后 open 失败。 */
	var lastChannel = 0;
	var channelLeakNote = '';

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
		return { level: 'fatal', text: '未知卡片错误 SW=' + sw, hint: '不支持此操作' };
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

	/* 带人话文案的 SW 错误（R08）：把 §1.5① 错误矩阵的 text/hint 挂到 err 上，
	 * 让上层 handleErr 优先展示，而不是把裸 SW（如 6A80）直接 toast 给用户。 */
	function makeSwError(code, sw) {
		var info = api.swInfo(sw);
		var e = makeError(code, sw);
		e.swText = info.text;
		e.swHint = info.hint;
		return e;
	}

	/* ============ 会话：open → select → fn → close（P03/P04/P05） ============ */

	/*
	 * sendApdu 发送一条 APDU 并自动处理 61xx 取余（GET RESPONSE 循环，MAX_ROUNDS 闸）。
	 * 返回 { data, sw }，data 为拼接完整的响应数据（不含 SW）。
	 */
	function sendAndCollect(send, ch, apdu, round, acc) {
		return send(api.csimCommand(apdu)).then(function (res) {
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
			var a = api.parseCsimAnswer(res && res.data);
			if (!a) throw makeError('EUICC_AT_ERROR', '无法解析 CSIM 应答');
			if (a.hasMore) {
				if (round + 1 >= MAX_ROUNDS) {
					throw makeError('EUICC_TLV_TRUNCATED', 'GET RESPONSE 超过 ' + MAX_ROUNDS + ' 轮');
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
			if (want > 0 && got < want && (got % CSIM_MAX_RESPONSE_BYTES) === 0) {
				throw makeError('EUICC_CSIM_TRUNCATED',
					'这条响应需要 ' + want + ' 字节，但模组只回传了 ' + got +
					' 字节（AT+CSIM 单条响应上限 256 字节，且卡上没有残留可再取）。' +
					'本设备无法完成 Profile 下载；读取 Profile、启用 / 禁用 / 删除等' +
					'短响应操作不受影响。');
			}
			if (a.sw === '6A82') throw makeError('EUICC_NO_EUICC', 'SELECT ISD-R 返回 6A82');
		var info = api.swInfo(a.sw);
		/* R08 带人话文案。channelUnsupported 供 withIsdrSession 判定是否回退基本通道 ——
		   不能靠 err.code 区分，因为 6881 与其它操作失败共用 EUICC_OP_FAILED。 */
		if (info.level === 'fatal' || info.level === 'error') {
			var se = makeSwError(info.level === 'fatal' ? 'EUICC_NO_EUICC' : 'EUICC_OP_FAILED', a.sw);
			se.swInfo = info;
			if (api.isChannelUnsupportedSw(a.sw)) se.channelUnsupported = true;
			throw se;
		}
		return { data: data, sw: a.sw };
		});
	}

	function doClose(send, channel) {
		/* ★ 基本通道（channel === 0）不 close：它没有「关闭」的概念，
		   而 0070800000 会把基本通道一起关掉，可能打断模组 SIM 驱动自己的操作。 */
		if (channel == null || channel === 0) return Promise.resolve();
		return send(api.csimCommand(api.closeChannelApdu(channel)))
			.then(function (res) {
				var a = api.parseCsimAnswer(res && res.data);
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
				if (sel.sw === '6A82') throw makeError('EUICC_NO_EUICC', 'SELECT ISD-R 返回 6A82');
				return sel;
			})
			.then(function () {
				return sendAndCollect(send, ch, api.buildGetEid(ch), 0, '');
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

		/* 第一步：尝试逻辑通道。隔离性最好 —— 不占用基本通道的当前选择，
		   不会打断模组 SIM 驱动自己的操作。 */
		var opened = sendAndCollect(send, 0, api.openChannelApdu(), 0, '')
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

		function pingOn(ch) {
			return selectAndPing(send, ch).catch(function (e) {
				/* 逻辑通道撞 6881 / 6A81 → 回退基本通道（ch=0）。
				   除 EUICC_NO_CHANNEL / channelUnsupported 之外的错误（如 6A82 不是 eUICC、
				   AT 服务未就绪）都**不**回退，直接抛，避免把真实病因换成一次无效重试。 */
				if (ch !== 0 && e && (e.code === 'EUICC_NO_CHANNEL' || e.channelUnsupported === true)) {
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
				/* open 本身就失败 → 直接走基本通道。AT 服务未就绪之类不回退。 */
				if (e && e.code === 'EUICC_NO_CHANNEL') {
					channel = 0;
					return selectAndPing(send, 0);
				}
				throw e;
			})
			.then(function () {
				return fn(channel, function (apdu) {
					return sendAndCollect(send, channel, apdu, 0, '');
				});
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
				return api.withIsdrSession(send, function (ch, sendApdu) {
					return sendApdu(api.buildGetEid(ch)).then(function (r2) {
						return { eid: parseEid(r2.data) };
					});
				}).then(function (info) {
					/* R04：把疑似通道泄漏提示一并带回，交给 esim.js 展示。 */
					return { state: 'ok', eid: info.eid, channelNote: channelLeakNote };
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
	 * ★ 未经真机验证的部分：本机当前是普通 USIM（SELECT ISD-R 返回 6A82），
	 *   下面的下载链路没有真 eUICC 可跑。所有 SM-DP+ 应答与 APDU 状态字
	 *   都会原样写进 opts.log 交给界面展示，一旦协议细节对不上能立刻定位，
	 *   不会静默失败。已知不确定点记在 FRONTEND_REVIEW_REPORT.md。
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
	 *   BF38 AuthenticateServer
	 *   BF21 PrepareDownload（内含 0x04 = hashCC，仅确认码必需时带）
	 *   BF36 LoadBoundProfilePackage（按 BF23 / A0 / A1 / A2 / A3 逐段下发）
	 *   BF28 ListNotification / BF2B RetrieveNotificationList / BF30 RemoveNotificationFromList
	 *
	 * 传输层一律是 STORE DATA：CLA=0x80|ch, INS=0xE2。
	 * 分块时非末块 P1=0x11、末块 P1=0x91，P2 递增（lpac euicc/euicc.c es10x_command_iter）。
	 */
	var ES10B_TAGS = ['BF2E', 'BF20', 'BF38', 'BF21', 'BF36', 'BF28', 'BF2B', 'BF30'];

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
	api.buildEs10bChunks = function (ch, tag, derHex, mss) {
		var limit = (mss > 0 && mss <= 240) ? mss : 120;
		var full = tlvHex(tag, derHex || '');
		var chunks = [];
		for (var i = 0; i < full.length; i += limit * 2) {
			chunks.push(full.substr(i, limit * 2));
		}
		return chunks.map(function (c, idx) {
			var last = idx === chunks.length - 1;
			return api.storeDataApdu(ch, api.hexToBytes(c), {
				p1: last ? 0x91 : 0x11, p2: idx & 0xff
			});
		});
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
					/* ⑧ 装进卡里：整包按 BF36 分块下发 */
					var bpp = api.base64ToHex(resp.boundProfilePackage);
					var chunks = api.buildEs10bChunks(ch, 'BF36', bpp, mss);
					onStep(8, '写入卡片（' + chunks.length + ' 块）');
					log('BPP ' + (bpp.length / 2) + ' 字节，分 ' + chunks.length + ' 块下发');
					var chain = Promise.resolve('');
					chunks.forEach(function (c, idx) {
						chain = chain.then(function () {
							onStep(8, '写入卡片（' + (idx + 1) + '/' + chunks.length + '）');
							return sendApdu(c);
						}).then(function (r) {
							log('卡 ← BPP ' + (idx + 1) + '/' + chunks.length + ' SW=' + r.sw);
							if (r.sw !== '9000' && r.sw !== '9100') {
								throw makeSwError('EUICC_OP_FAILED', r.sw);
							}
							return r.data || '';
						});
					});
					return chain;
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
