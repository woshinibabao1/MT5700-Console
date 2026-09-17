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
		'EUICC_BUSY', 'EUICC_POLICY_DENIED', 'EUICC_OP_FAILED'
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
				text: '使用条件不满足（多半 ISD-R 没选上或通道串了）',
				hint: '关通道重开会话，重试 1 次'
			};
		}
		if (sw === '6A80') {
			return {
				level: 'error',
				text: '下发的数据卡片读不懂（本地 TLV 组装有误）',
				hint: '请勿重试并提 issue'
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
		if (sw === '6E00' || sw === '6D00') {
			return { level: 'fatal', text: '卡片不接受该 CLA / 指令', hint: '固件透传能力受限，本页不可用' };
		}
		return { level: 'fatal', text: '未知卡片错误 SW=' + sw, hint: '不支持此操作' };
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
	 * P2=0x00, Lc=tlv 字节数, DATA=tlv, Le=00。
	 * opts.p1 可覆盖 P1（>254 字节分块时倒数第二块之前用 0x11，本页不触发）。
	 */
	api.storeDataApdu = function (ch, tlv, opts) {
		var p1 = (opts && opts.p1 != null) ? opts.p1 : 0x91;
		var tlvHex = api.bytesToHex(tlv);
		var lc = hex2(tlv.length);
		var head = api.bytesToHex(new Uint8Array([0x80 | (ch & 0x0f), 0xE2, p1, 0x00]));
		return head + lc + tlvHex + '00';
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
			if (a.sw === '6A82') throw makeError('EUICC_NO_EUICC', 'SELECT ISD-R 返回 6A82');
			var info = api.swInfo(a.sw);
			if (info.level === 'fatal') throw makeSwError('EUICC_NO_EUICC', a.sw); /* R08 带人话文案 */
			if (info.level === 'error') throw makeSwError('EUICC_OP_FAILED', a.sw); /* R08 */
			return { data: data, sw: a.sw };
		});
	}

	function doClose(send, channel) {
		if (channel == null) return Promise.resolve();
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
	 * withIsdrSession：开通道 → 校验通道号 → 选 ISD-R → fn(ch, sendApdu) → 强制关通道。
	 * send 注入点：(atCmd) => Promise<{success,data,error}>。
	 * 异常统一带 err.code；finally 语义用 .catch 兜底 close（P10 不重发、关通道必执行）。
	 */
	api.withIsdrSession = function (send, fn) {
		var channel = null;
		var result;

		return Promise.resolve()
			.then(function () {
				return sendAndCollect(send, 0, api.openChannelApdu(), 0, '');
			})
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
				return sendAndCollect(send, ch, api.selectIsdrApdu(ch), 0, '');
			})
			.then(function (sel) {
				if (sel.sw === '6A82') throw makeError('EUICC_NO_EUICC', 'SELECT ISD-R 返回 6A82');
				var info = api.swInfo(sel.sw);
				if (info.level === 'fatal') throw makeSwError('EUICC_NO_EUICC', sel.sw); /* R08 */
				if (info.level === 'error') throw makeSwError('EUICC_OP_FAILED', sel.sw); /* R08 */
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
	api.ISDR_AID = ISDR_AID;
	api.MAX_ROUNDS = MAX_ROUNDS;
	api.ERR_CODES = ERR_CODES;
	api.es10Result = es10Result;

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
