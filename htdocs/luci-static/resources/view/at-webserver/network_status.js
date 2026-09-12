'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 网络状态 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Info.tsx，并按「一个主题一张卡片」重新组织，避免信息重叠：
 *   ① 信号质量     主小区 RSRP/RSRQ/SINR + 信号百分比 + 调制方式(MCS)
 *   ② 连接状态     注册/运营商/签约速率 + 连接诊断(ENDC/5GC/发射功率/PDP) + IP 与 DNS
 *   ③ 载波与聚合   ^HFREQINFO 载波列表（每载波 7 字段）+ CA / EN-DC 状态
 *   ④ 速率与流量   实时速率 + 速率曲线 + 累计流量
 *   ⑤ SIM 与设备   SIM 卡、模块标识、网络时间、各路温度
 * 原「载波聚合」与「辅载波信号」、原「实时速率/速率曲线/流量统计」、
 * 原「连接诊断/IP 与 DNS」、原「模组温度」均已合并进上述卡片。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络状态', '实时网络信息与信号质量');
		var body = page._body;

		/* ---------- 顶部状态条（页面唯一的"记忆点"）----------
		 * 原来是三块竖着叠：连接状态卡 / 刷新工具条 / 各卡里的读数磁贴，要滚动才看得全。
		 * 现在合成一条满宽状态条：
		 *   上行：连接状态（左） + 自动刷新与「刷新」按钮（右）
		 *   下行：7 项关键读数，横向铺满
		 * 分块由 CSS 的 grid 行列指定，DOM 顺序不影响观感。
		 */
		var topbar = E('div', { 'class': 'mt5700-topbar' });
		var topStatus = E('div', { 'class': 'mt5700-topbar-status' });
		topbar.appendChild(topStatus);
		Mt5700.renderConnectionBar(topStatus);

		/* 读数带：元素一次建好，之后只改文字（不重建 DOM，避免每秒刷新时抖动） */
		var strip = (function () {
			var el = E('div', { 'class': 'mt5700-strip' });
			var refs = {};
			[['信号', 'sig'], ['运营商', 'op'], ['制式', 'mode'], ['载波', 'cc'],
			 ['下行', 'down'], ['上行', 'up'], ['温度', 'temp']].forEach(function (it) {
				var box = E('div', { 'class': 'mt5700-strip-item' });
				var v = E('div', { 'class': 'mt5700-strip-value' }, '—');
				box.appendChild(v);
				box.appendChild(E('div', { 'class': 'mt5700-strip-label' }, it[0]));
				el.appendChild(box);
				refs[it[1]] = v;
			});
			return { el: el, refs: refs };
		})();
		topbar.appendChild(strip.el);
		body.appendChild(topbar);

		/* ---------- 面板骨架（按「一个主题一张卡片」组织，避免信息重叠） ---------- */

		/* ① 信号质量：主小区 RSRP/RSRQ/SINR + 信号百分比 + 调制方式(MCS) */
		var signalCard = Mt5700.card('信号质量', '主小区 RSRP / RSRQ / SINR、信号百分比与调制方式');
		var sigGrid = E('div', { 'class': 'mt5700-metrics' });
		signalCard._body.appendChild(sigGrid);
		var mcsGrid = E('div', { 'class': 'mt5700-metrics mt5700-mt-md' });
		signalCard._body.appendChild(mcsGrid);
		body.appendChild(signalCard);

		/* ② 连接状态：注册 / 运营商 / 签约速率 + 连接诊断 + IP 与 DNS（原三张卡合并） */
		var connCard = Mt5700.card('连接状态', '网络注册、运营商、连接诊断与 IP / DNS');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		var diagBox = E('div', { 'class': 'mt5700-mt-md' });
		connCard._body.appendChild(diagBox);
		var dhcpBox = E('div', { 'class': 'mt5700-mt-md' });
		connCard._body.appendChild(dhcpBox);
		body.appendChild(connCard);

		/* ③ 载波与聚合：^HFREQINFO 载波列表 + 聚合状态（原「载波聚合」+「辅载波信号」合并） */
		var carrierCard = Mt5700.card('载波与聚合', 'AT^HFREQINFO 上报的载波，每载波 7 个字段');
		var carrierBox = E('div');
		carrierCard._body.appendChild(carrierBox);
		body.appendChild(carrierCard);

		/* ④ 速率与流量：实时速率 + 速率曲线 + 收发流量统计（原三张卡合并） */
		var rateCard = Mt5700.card('速率与流量', '接口实时速率（每秒采样）、速率曲线与流量统计');
		var speedRow = E('div', { 'class': 'mt5700-speed-row' });
		rateCard._body.appendChild(speedRow);
		var chart = E('div', { 'class': 'mt5700-chart' });
		rateCard._body.appendChild(chart);
		var flowGrid = E('div', { 'class': 'mt5700-metrics mt5700-mt-md' });
		rateCard._body.appendChild(flowGrid);
		body.appendChild(rateCard);

		/* ⑤ SIM 与设备：SIM 卡、模块标识、网络时间与各路温度 */
		var devCard = Mt5700.card('SIM 与设备', 'SIM 卡、模块标识、网络时间与温度（60 秒节流刷新）');
		var devBody = E('div');
		devCard._body.appendChild(devBody);
		var tempGrid = E('div', { 'class': 'mt5700-metrics mt5700-mt-md' });
		devCard._body.appendChild(tempGrid);
		body.appendChild(devCard);

		/* 顺序与配对（与原版顺序一致，也让宽屏双列的两列高度接近）：
		     信号质量（满宽）
		     连接状态 | SIM 与设备
		     载波与聚合 | 速率与流量
		   原先 SIM 与设备排在最后，双列时右侧会空出一大片。 */
		body.insertBefore(devCard, carrierCard);

		/* ---------- 状态 ---------- */

		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: 0,
				rsrp: null, rsrq: null, sinr: null, sysMode: '未知', signalPercent: ''
			},
			carriers: [],
			secondaryNR: [], secondaryLTE: [],
			diag: { endc: null, reg: null, tx: null, nrTx: [], addrs: [] },
			temps: { sub3GPA: 0, sub6GPA: 0, mimoPa: 0, tcxo: 0, ap1: 0, ap2: 0, modem1: 0 },
			flow: { lastDsTime: 0, lastTxFlow: 0, lastRxFlow: 0, totalDsTime: 0, totalTxFlow: 0, totalRxFlow: 0 },
			dhcpv4: null, dhcpv6: null, ipv6Cap: null,
			uplinkMCS: null, downlinkMCS: null,
			activeCid: null,
			networkStatus: '等待状态中',
			operator: '未知运营商',
			apn: '未知',
			qci: '未知',
			/*
			 * 两个面板的数据源与单位都不同，必须各自独立存放，不可共用：
			 *   - ambrDown / ambrUp：签约速率，AT^DSAMBR，单位 kbps（本身即比特）
			 *   - rtDown  / rtUp  ：实时速率，OpenWrt 接口统计采样差分，单位字节/秒
			 * 共用同一组变量会导致两面板互相覆盖、数值与语义双双错乱。
			 */
			ambrDown: 0, ambrUp: 0,
			rtDown: 0, rtUp: 0
		};

		var history = [];
		var HISTORY_POINTS = 60;

		var SIM_STATE = {
			0: ['未插卡', true], 1: ['已插卡', true], 2: ['PIN 锁定', true], 3: ['SIM 锁定', true],
			10: ['初始化中', true],
			11: ['已初始化 · 可接入网络（短信/电话本未接入）', true],
			12: ['就绪 · 短信与电话本可接入', false],
			98: ['卡失效', true], 99: ['已移除', true], 100: ['卡错误', true]
		};

		/* 敏感号段打码：只保留前 4 位与后 4 位 */
		function maskNum(v) {
			var t = String(v == null ? '' : v).replace(/[^0-9]/g, '');
			if (!t) return '—';
			if (t.length <= 8) return t;
			return t.slice(0, 4) + ' **** ' + t.slice(-4);
		}

		function firstValueLine(data) {
			var lines = String(data == null ? '' : data).split('\n');
			for (var i = 0; i < lines.length; i++) {
				var t = lines[i].replace(/\s+/g, ' ').trim();
				if (!t || t === 'OK') continue;
				return t;
			}
			return '';
		}

		function manualPhoneNote() {
			try { return String(L.uci.get('at-webserver', 'config', 'phone_note') || '').trim(); }
			catch (e) { return ''; }
		}

		/* ^NWTIME: 26/09/12,17:18:47+32,00 —— 时区以 15 分钟为单位（+32 → UTC+8） */
		function parseNetTime(txt) {
			var m = String(txt == null ? '' : txt).match(
				/(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-]\d+)/);
			if (!m) return null;
			var qh = parseInt(m[7], 10) / 4;
			var tz = (qh >= 0 ? '+' : '-') + String(Math.floor(Math.abs(qh))).padStart(2, '0') + ':00';
			return '20' + m[1] + '-' + m[2] + '-' + m[3] + ' ' +
				m[4] + ':' + m[5] + ':' + m[6] + ' (UTC' + tz + ')';
		}

		function maxTemp(txt) {
			var nums = String(txt == null ? '' : txt).match(/\d+/g);
			var vals = nums ? nums.map(function (v) { return parseInt(v, 10); })
				.filter(function (v) { return v > 0; }) : [];
			return vals.length ? (Math.max.apply(Math, vals) / 10).toFixed(1) + ' °C' : null;
		}

		var _devInfoAt = 0;

		function loadDeviceInfo(force) {
			// 设备信息变化很慢：首次加载与每 60s 刷新一次，避免每轮都打十几条查询
			var now = Date.now();
			if (!force && _devInfoAt && now - _devInfoAt < 60000) return;
			_devInfoAt = now;

			var st = {};
			var q = function (cmd) {
				return AtWs.client.sendCommand(cmd).catch(function () { return { success: false }; });
			};
			return q('AT^SIMSQ?').then(function (r) {
				var m = String(r && r.data ? r.data : '').match(/SIMSQ:\s*(\d+)\s*,\s*(\d+)/);
				st.sim = m ? parseInt(m[2], 10) : null;
				return q('AT+CPIN?');
			}).then(function (r) {
				st.pin = (String(r && r.data ? r.data : '').match(/CPIN:\s*(\S+)/) || [])[1] || '';
				return q('AT+CNUM');
			}).then(function (r) {
				var m = String(r && r.data ? r.data : '').match(/"([+\d]{5,20})"/);
				st.phone = m ? m[1] : '';
				return q('AT+CPBS?');
			}).then(function (r) {
				var m = String(r && r.data ? r.data : '').match(/CPBS:\s*"?(\w+)"?\s*,\s*(\d+)\s*,\s*(\d+)/);
				st.pb = m ? (m[1] + ' ' + m[2] + '/' + m[3]) : '';
				return q('AT^TDSIMHP?');
			}).then(function (r) {
				var m = String(r && r.data ? r.data : '').match(/TDSIMHP:\s*(\d+)/);
				st.hotplug = m ? parseInt(m[1], 10) : null;
				return q('AT+CIMI');
			}).then(function (r) {
				st.imsi = (String(r && r.data ? r.data : '').match(/\d{10,}/) || [''])[0];
				return q('AT^ICCID?');
			}).then(function (r) {
				st.iccid = (String(r && r.data ? r.data : '').match(/ICCID:\s*([0-9A-Fa-f]+)/) || [])[1] || '';
				return q('AT+CGMM');
			}).then(function (r) {
				st.model = firstValueLine(r && r.data);
				return q('AT+CGMR');
			}).then(function (r) {
				st.fw = firstValueLine(r && r.data);
				return q('AT+CGSN');
			}).then(function (r) {
				st.imei = (String(r && r.data ? r.data : '').match(/\d{10,}/) || [''])[0];
				return q('AT^NWTIME?');
			}).then(function (r) {
				st.time = parseNetTime(r && r.data);
				return q('AT^CHIPTEMP?');
			}).then(function (r) {
				st.temp = maxTemp(r && r.data);
				return q('AT^HFREQINFO?');
			}).then(function (r) {
				var mm = String(r && r.data ? r.data : '').match(/HFREQINFO:\s*([\d,]+)/);
				var cc = 0;
				if (mm) {
					var parts = mm[1].split(',').filter(function (x) { return x !== ''; });
					cc = Math.max(0, Math.floor((parts.length - 2) / 7));
				}
				st.cc = cc;
				return q('AT^NRRCCAPQRY=3');
			}).then(function (r) {
				st.ca = (String(r && r.data ? r.data : '').match(/NRRCCAPQRY:\s*3,(\d+)/) || [])[1];
				renderDeviceInfo(st);
			});
		}

		function renderDeviceInfo(st) {
			if (!devBody) return;
			devBody.innerHTML = '';
			var simRow = SIM_STATE[st.sim];
			var simText = simRow ? simRow[0] : (st.sim == null ? '未知' : ('状态 ' + st.sim));
			var warn = simRow ? simRow[1] : true;

			var head = E('div', { 'class': 'mt5700-toolbar' });
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' + (warn ? '' : ' is-on') },
				'SIM：' + simText));
			if (st.pin) head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' }, 'PIN：' + st.pin));
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' },
				'载波：' + (st.cc ? (st.cc + ' 个' + (st.cc > 1 ? '（聚合中）' : '（单载波）')) : '—')));
			if (st.ca != null) head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' },
				'CA 能力：' + (st.ca === '1' ? '已开启' : '已关闭')));
			devBody.appendChild(head);

			if (warn) {
				devBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					'尚未到「就绪」：AT^SIMSQ? 返回 12 才表示「短信与电话本可以接入」；' +
					'长期停在 11「已初始化」时短信可能发不出去。'));
			}

			var note = manualPhoneNote();
			var phone = st.phone ? (maskNum(st.phone) + '（SIM 卡）')
				: (note ? (maskNum(note) + '（手动备注）')
					: '未写入（AT+CNUM → not found，可在「服务配置」手动备注）');

			devBody.appendChild(Mt5700.table(['项目', '值'], [
				['手机号', phone],
				/* 「电话本」原显示 "ON 0/2"（存储位置 ON、0 条记录、容量 2），既不直观
				   也与上方 SIM 状态重复，已移除；电话本能否接入见该行提示。 */
				['SIM 热插拔', st.hotplug == null ? '—' : (st.hotplug ? '已开启' : '已关闭')],
				['IMSI', maskNum(st.imsi)],
				['ICCID', maskNum(st.iccid)],
				['IMEI', maskNum(st.imei)],
				['模块 / 固件', (st.model || '—') + ' / ' + (st.fw || '—')],
				['网络时间', st.time || '—']
			], { striped: true }));
			/* 温度不在此处重复：下方 tempGrid 会逐路列出 ^CHIPTEMP 的各传感器值 */
		}

		/* ---------- 渲染 ---------- */

		function dash(v, unit) { return v == null ? '—' : v + unit; }

		/*
		 * AT+C5GREG? 的 <tac> 与 <ci> 是十六进制字符串（实测 "14225C" / "0000000C027F5065"），
		 * 直接显示不易与运营商工参对照，这里统一转成十进制。
		 * 非十六进制（或超出 JS 安全整数范围的超长值）原样返回。
		 */
		function hexToDec(v) {
			if (v == null) return '';
			var s = String(v).trim().replace(/^0[xX]/, '').replace(/^0+/, '');
			if (!s || !/^[0-9a-fA-F]+$/.test(s) || s.length > 13) return String(v);
			return String(parseInt(s, 16));
		}

		function renderConn() {
			connBody.innerHTML = '';
			var c = state.cell;
			var ambrD = splitSpeedUI(state.ambrDown, 'kbps');
			var ambrU = splitSpeedUI(state.ambrUp, 'kbps');
			var grid = E('div', { 'class': 'mt5700-metrics' });
			[
				{ label: '网络状态', value: state.networkStatus, color: 'info' },
				{ label: '运营商', value: state.operator },
				{ label: '网络模式', value: c.sysMode || '未知' },
				/* 信号强度不在此重复：上方环形仪表与顶部状态条已各有一处 */
				{ label: 'APN', value: state.apn },
				{ label: 'QCI', value: state.qci },
				/* 连接状态面板展示的是签约速率（AT^DSAMBR），不是瞬时速率 */
				{ label: '下行速率（签约）', value: ambrD.value + ' ' + ambrD.unit },
				{ label: '上行速率（签约）', value: ambrU.value + ' ' + ambrU.unit }
			].forEach(function (it) {
				grid.appendChild(Mt5700.metric(it.label, it.value, it.color));
			});
			connBody.appendChild(grid);

			connBody.appendChild(Mt5700.table(
				['PLMN', 'TAC / 小区', 'PCI / 频点'],
				[[(c.mcc || '—') + ' / ' + (c.mnc || '—'),
					/* ^MONSSC 的 lac/cid 与频点同为十六进制字符串（实测 "C027F5065"、"14225C"），
					   与 +C5GREG 的 tac/ci 同源；统一转十进制，便于与运营商工参对照。 */
					(hexToDec(c.lac) || '—') + ' / ' + (hexToDec(c.cid) || '—'),
					(c.pci || '—') + ' / ' + (hexToDec(c.channel) || '—')]]
			));
		}

		/* 环形仪表实例只创建一次，之后每次刷新仅更新数值与弧线 */
		var sigGauges = null;

		function renderSignal() {
			var c = state.cell;
			if (!sigGauges) {
				sigGrid.innerHTML = '';
				sigGauges = {
					rsrp: Mt5700.gauge('RSRP', 'dBm', 'rsrp'),
					rsrq: Mt5700.gauge('RSRQ', 'dB', 'rsrq'),
					sinr: Mt5700.gauge('SINR', 'dB', 'sinr'),
					pct: Mt5700.gauge('信号百分比', '%', 'pct')
				};
				sigGrid.appendChild(sigGauges.rsrp.el);
				sigGrid.appendChild(sigGauges.rsrq.el);
				sigGrid.appendChild(sigGauges.sinr.el);
				sigGrid.appendChild(sigGauges.pct.el);
			}
			sigGauges.rsrp.set(c.rsrp);
			sigGauges.rsrq.set(c.rsrq);
			sigGauges.sinr.set(c.sinr);
			var pct = parseInt(c.signalPercent, 10);
			sigGauges.pct.set(isNaN(pct) ? null : pct);
		}

		/*
		 * 载波与聚合（原「载波聚合」+「辅载波信号」两张卡片合并）
		 *
		 * 数据来源：^HFREQINFO（手册 13.16），NR 支持多 CC（最多 4 个），LTE 只报主小区。
		 *   count     = 上报的载波数
		 *   caActive  = 载波数 > 1，即真正的载波聚合
		 *   dcActive  = ^LENDC? 报 EN-DC 双连接已建立
		 * 三者分开表达，避免把「EN-DC 双连接」与「NR 载波聚合」混为一谈。
		 *
		 * 注意 ^HFREQINFO **不含** RSRP/RSRQ/SINR，按载波的信号质量需要 ^MONSSC /
		 * ^CASCELLINFO；本固件分别返回 NONE / ERROR，所以表格不设信号列（避免整列「—」），
		 * 信号质量统一看顶部「信号质量」卡片。
		 */
		/* 频率已是 MHz（parseHFREQINFO 已换算），不要再除 1000 */
		function fmtMHz(v) {
			return v == null ? '—' : v.toFixed(1) + ' MHz';
		}
		function fmtBw(khz) {
			if (khz == null) return '—';
			return khz >= 1000 ? (khz / 1000) + ' MHz' : khz + ' kHz';
		}
		/* 频段列用 3GPP 标识（n41 / B3），比频率描述更好与工参对照 */
		function bandLabel(sysMode, band) {
			if (band == null) return '—';
			return (sysMode === 'LTE' ? 'B' : 'n') + band;
		}

		function renderCarriers() {
			carrierBox.innerHTML = '';
			var list = state.carriers || [];
			var count = list.length;
			var caActive = count > 1;
			var endc = state.diag && state.diag.endc;
			var dcActive = !!(endc && endc.established);
			var badge = !count ? '不可用'
				: caActive ? (count + ' 载波聚合中')
				: dcActive ? 'EN-DC 双连接'
				: '单载波';
			var headline = !count ? '—'
				: caActive ? (count + 'CA')
				: dcActive ? (endc.mode || 'EN-DC')
				: (list[0].band != null ? AtWs.bandName(list[0].sysMode || list[0].kind, list[0].band) : '单载波');

			var head = E('div', { 'class': 'mt5700-carrier-head' });
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' + (caActive || dcActive ? ' is-on' : '') }, badge));
			head.appendChild(E('span', { 'class': 'mt5700-carrier-headline' }, headline));
			carrierBox.appendChild(head);

			if (!count) {
				carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' },
					'未读到载波信息。^HFREQINFO? 在 RRC null 态不支持查询，会返回错误。'));
				return;
			}

			var rows = list.map(function (c, i) {
				return [
					i === 0 ? '主载波' : ('辅载波 ' + i),
					c.sysMode || c.kind || '—',
					bandLabel(c.sysMode, c.band),
					c.dlFcn ? (c.dlFcn + ' · ' + fmtMHz(c.dlFreqMHz)) : '—',
					fmtBw(c.dlBwKHz),
					c.downlinkOnly ? '—（仅下行）'
						: (c.ulFcn ? (c.ulFcn + ' · ' + fmtMHz(c.ulFreqMHz)) : '—'),
					c.downlinkOnly ? '—' : fmtBw(c.ulBwKHz)
				];
			});
			carrierBox.appendChild(Mt5700.table(
				['载波', '制式', '频段', '下行频点', '下行带宽', '上行频点', '上行带宽'],
				rows,
				{ striped: true }
			));

			var hint = '载波数取自 ^HFREQINFO（NR 多 CC，最多 4 个）；'
				+ '载波聚合需在 RRC 连接态（有数据业务）才会激活，空闲态通常只报主载波。';
			if (!(state.secondaryNR || []).length && !(state.secondaryLTE || []).length) {
				hint += ' 本固件不提供按载波的信号质量（^MONSSC 返回 '
					+ (state.monsscRaw || 'NONE') + '、^CASCELLINFO 不被支持），'
					+ '故本表不含信号列，信号质量请看「信号质量」卡片。';
			}
			carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));

			/*
			 * 若 ^MONSSC / ^CASCELLINFO 真的报回了辅小区，就把它们按下行频点对到载波上
			 * 单独列出来（信息不丢）；对不上的也一并列出。
			 */
			var nr = state.secondaryNR || [];
			var lte = state.secondaryLTE || [];
			if (!nr.length && !lte.length) return;
			var extraRows = [];
			list.forEach(function (c, i) {
				var sig = Parse.carrierSignalFor(
					{ sysMode: c.sysMode, dlFcn: String(c.dlFcn) }, nr, lte);
				if (sig) {
					extraRows.push([
						i === 0 ? '主载波' : ('辅载波 ' + i),
						String(sig.pci != null ? sig.pci : '—'),
						dash(sig.rsrp, ' dBm'), dash(sig.rsrq, ' dB'),
						sig.sinr != null ? dash(sig.sinr, ' dB') : dash(sig.rssi, ' dBm'),
						sig.measType || '—'
					]);
				}
			});
			var orphan = Parse.unmatchedSecondaries(
				list.map(function (c) { return { sysMode: c.sysMode, dlFcn: String(c.dlFcn) }; }), nr, lte);
			orphan.nr.forEach(function (c) {
				extraRows.push(['未匹配 · NR', String(c.pci), dash(c.rsrp, ' dBm'), dash(c.rsrq, ' dB'),
					dash(c.sinr, ' dB'), '^MONSSC']);
			});
			orphan.lte.forEach(function (c) {
				extraRows.push(['未匹配 · LTE B' + c.band, String(c.pci), dash(c.rsrp, ' dBm'),
					dash(c.rsrq, ' dB'), dash(c.rssi, ' dBm'), '^CASCELLINFO']);
			});
			if (extraRows.length) {
				carrierBox.appendChild(E('div', { 'class': 'mt5700-card-subtitle mt5700-mt-md' },
					'按载波信号质量（来自 ^MONSSC / ^CASCELLINFO）'));
				carrierBox.appendChild(Mt5700.table(
					['载波', 'PCI', 'RSRP', 'RSRQ', 'SINR/RSSI', '测量'], extraRows, { striped: true }));
			}
		}

		/* ---------- 连接诊断（已并入「连接状态」卡片，见 renderDiag） ---------- */

		function renderDiag() {
			diagBox.innerHTML = '';
			var d = state.diag;
			var endcTag = '不适用';
			if (d.endc) {
				if (d.endc.established) endcTag = '已建立';
				else if (!d.endc.available) endcTag = '小区不支持';
				else if (!d.endc.plmnAvailable) endcTag = '运营商未开通';
				else if (d.endc.restricted) endcTag = '网络侧受限';
				else endcTag = '支持但未建立';
			}
			var regVal = d.reg ? (d.reg.statText + (d.reg.act ? ' · ' + d.reg.act : '')) : '未注册 5GC';
			var rows = [
				['ENDC 双连接', endcTag],
				['5G 核心网注册', regVal],
				/* TAC / 小区 / PCI / 频点 已在「注册与运营商」表里给出，此处不再重复 */
				['网络切片', d.reg && d.reg.nssai ? d.reg.nssai : '—']
			].filter(function (r) {
				/* 取不到数据的项直接不显示：一排「—」「不适用」只占版面、没有信息量 */
				return r[1] && r[1] !== '—' && r[1] !== '不适用';
			});
			/*
			 * AT^TXPOWER? 在部分固件不被支持（实测 V200R001C20B025 连续 6 次全回 ERROR）。
			 * 拿不到数据时直接隐藏这几行，而不是显示一排「—」占版面。
			 */
			if (d.tx) {
				rows.push(['LTE PUSCH / PUCCH', dash(d.tx.pusch, ' dBm') + ' / ' + dash(d.tx.pucch, ' dBm')]);
				rows.push(['LTE SRS / PRACH', dash(d.tx.srs, ' dBm') + ' / ' + dash(d.tx.prach, ' dBm')]);
				if (d.tx.total != null) rows.push(['2G/3G 总功率', dash(d.tx.total, ' dBm')]);
			}
			(d.nrTx || []).forEach(function (c, i) {
				rows.push(['NR CC' + (i + 1) + ' PUSCH', dash(c.pusch, ' dBm') + (c.freq ? ' · ' + (c.freq / 1000).toFixed(1) + ' MHz' : '')]);
			});
			diagBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
			if (d.addrs && d.addrs.length) {
				diagBox.appendChild(E('div', { 'class': 'mt5700-hint' }, 'PDP 地址：'));
				var ul = E('ul', { 'class': 'mt5700-agree-list' });
				d.addrs.forEach(function (a) {
					ul.appendChild(E('li', {}, 'CID ' + a.cid + ' · ' + a.family + '：' + a.address));
				});
				diagBox.appendChild(ul);
			} else {
				diagBox.appendChild(E('div', { 'class': 'mt5700-hint' }, '没有已激活的 PDP 上下文地址。'));
			}
		}

		/*
		 * 两个面板的渲染互相独立，各自只认自己的数据源：
		 *   - renderConn()  连「连接状态」面板，取签约速率（kbps）
		 *   - renderSpeed() 连「实时速率」面板，取接口实时速率（字节/秒）
		 * 早期版本两者共用一组变量，导致签约速率会盖掉实时速率、反之亦然。
		 */
		/* 刷新顶部读数带：只改文字，不重建节点 */
		function renderStrip() {
			var r = strip.refs, c = state.cell || {}, t = state.temps || {};
			r.sig.textContent = c.signalPercent ? (c.signalPercent + '%')
				: (c.rsrp != null ? c.rsrp + ' dBm' : '—');
			r.op.textContent = state.operator || '—';
			r.mode.textContent = c.sysMode || '—';
			r.cc.textContent = (state.carriers && state.carriers.length)
				? (state.carriers.length + ' 载波') : '—';
			var d = splitSpeedUI(state.rtDown, 'bytes');
			var u = splitSpeedUI(state.rtUp, 'bytes');
			r.down.textContent = d.value + ' ' + d.unit;
			r.up.textContent = u.value + ' ' + u.unit;
			var mx = 0;
			['sub3GPA', 'sub6GPA', 'mimoPa', 'tcxo', 'ap1', 'ap2', 'modem1'].forEach(function (k) {
				var v = Number(t[k]) || 0;
				if (v > mx) mx = v;
			});
			r.temp.textContent = mx ? (mx + ' ℃') : '—';
		}

		function renderSpeed() {
			speedRow.innerHTML = '';
			var d = splitSpeedUI(state.rtDown, 'bytes');
			var u = splitSpeedUI(state.rtUp, 'bytes');
			speedRow.appendChild(Mt5700.speedBox('↓ 下行', d.value + ' ' + d.unit));
			speedRow.appendChild(Mt5700.speedBox('↑ 上行', u.value + ' ' + u.unit));
			renderChart();
			renderStrip();
		}

		/*
		 * 把速率值格式化为 {value, unit}。
		 * unitMode：
		 *   'kbps'  —— 输入单位是 kbps（比特），直接乘 1000 得 bps（签约速率）；
		 *   'bytes' —— 输入单位是字节/秒，乘 8 得 bps（接口实时速率）。
		 */
		function splitSpeedUI(value, unitMode) {
			var bits = (unitMode === 'kbps') ? (value * 1000) : (value * 8);
			if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Gbps' };
			if (bits >= 1e6) return { value: (bits / 1e6).toFixed(2), unit: 'Mbps' };
			if (bits >= 1e3) return { value: (bits / 1e3).toFixed(2), unit: 'Kbps' };
			return { value: String(Math.round(bits)), unit: 'bps' };
		}

		function renderChart() {
			chart.innerHTML = '';
			if (!history.length) {
				chart.appendChild(Mt5700.empty('等待数据…'));
				return;
			}
			chart.appendChild(Mt5700.lineChart(history, {
				width: chart.clientWidth || 600,
				height: 140,
				tipFormat: function (p) {
					var d = splitSpeedUI(p.down || 0, 'bytes');
					var u = splitSpeedUI(p.up || 0, 'bytes');
					return '↓ ' + d.value + ' ' + d.unit + ' · ↑ ' + u.value + ' ' + u.unit;
				}
			}));
		}

		function renderFlow() {
			flowGrid.innerHTML = '';
			var f = state.flow;
			[
				{ label: '当前会话时长', value: AtWs.formatDuration(f.lastDsTime, false) },
				{ label: '当前下行流量', value: AtWs.formatFlow(f.lastRxFlow) },
				{ label: '当前上行流量', value: AtWs.formatFlow(f.lastTxFlow) },
				{ label: '累计时长', value: AtWs.formatDuration(f.totalDsTime, true) },
				{ label: '累计下行', value: AtWs.formatFlow(f.totalRxFlow) },
				{ label: '累计上行', value: AtWs.formatFlow(f.totalTxFlow) }
			].forEach(function (it) {
				flowGrid.appendChild(Mt5700.metric(it.label, it.value));
			});
		}

		function renderTemp() {
			tempGrid.innerHTML = '';
			var t = state.temps;
			var items = [
				{ label: 'Sub3G PA', value: t.sub3GPA }, { label: 'Sub6G PA', value: t.sub6GPA },
				{ label: 'MIMO PA', value: t.mimoPa }, { label: 'TCXO', value: t.tcxo },
				{ label: 'AP1', value: t.ap1 }, { label: 'AP2', value: t.ap2 }, { label: 'Modem1', value: t.modem1 }
			].filter(function (it) { return it.value; });

			if (!items.length) {
				tempGrid.appendChild(Mt5700.metric('温度', '—'));
				return;
			}
			/*
			 * 原来 7 路传感器各占一个磁贴，一屏全是温度数字，真正的信息只有「最高那一路」。
			 * 现在：最高温单独成磁贴（判断是否过热看的就是它），其余收成一行细字备查。
			 */
			items.sort(function (a, b) { return Number(b.value) - Number(a.value); });
			var top = Number(items[0].value);
			tempGrid.appendChild(Mt5700.metric(
				'最高温 · ' + items[0].label, items[0].value + ' ℃',
				top >= 75 ? 'danger' : (top >= 65 ? 'warning' : null)));

			if (items.length > 1) {
				tempGrid.appendChild(E('div', {
					'class': 'mt5700-hint',
					'style': 'grid-column:1/-1;margin-top:6px'
				}, '其他传感器：' + items.slice(1).map(function (it) {
					return it.label + ' ' + it.value + ' ℃';
				}).join(' · ')));
			}
		}

		function renderDHCP() {
			dhcpBox.innerHTML = '';
			var rows = [];
			var v4 = state.dhcpv4, v6 = state.dhcpv6;
			if (v4) {
				rows.push(['IPv4 地址', v4.ipv4Address]);
				rows.push(['子网掩码', v4.subnetMask]);
				rows.push(['网关', v4.gateway]);
				rows.push(['DHCP 服务器', v4.dhcpServer]);
				rows.push(['主 DNS', v4.primaryDNS]);
				rows.push(['备 DNS', v4.secondaryDNS]);
			}
			if (v6) {
				rows.push(['IPv6 地址', v6.ipv6Address]);
				rows.push(['IPv6 前缀', v6.netmask]);
				rows.push(['IPv6 网关', v6.gateway]);
				rows.push(['IPv6 DNS', v6.primaryDNS + ' / ' + v6.secondaryDNS]);
			}
			if (state.ipv6Cap) rows.push(['IPv6 支持', state.ipv6Cap.description]);
			if (!rows.length) rows.push(['信息', '暂无数据']);
			dhcpBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
		}

		/* 调制方式展示：256QAM MCS 27 · 1 层（大小写与格式固定） */
		function mcsDisplay(m) {
			if (!m || m.mcs == null) return '—';
			var mod = Parse.mcsModulation(m.mcs);
			var txt = (mod ? mod + ' ' : '') + 'MCS ' + m.mcs;
			if (m.rank) txt += ' · ' + m.rank + ' 层';
			return txt;
		}

		function renderMCS() {
			mcsGrid.innerHTML = '';
			var dl = state.downlinkMCS, ul = state.uplinkMCS;
			[
				{ label: '下行调制', value: mcsDisplay(dl) },
				{ label: '上行调制', value: mcsDisplay(ul) }
			].forEach(function (it) {
				mcsGrid.appendChild(Mt5700.metric(it.label, it.value));
			});
		}

		/* ---------- 数据获取 ---------- */

		function resolveActiveCid(force) {
			if (!force && state.activeCid !== null) return Promise.resolve(state.activeCid);
			return AtWs.client.sendCommand('AT+CGACT?').then(function (res) {
				if (!res.success || !res.data) return state.activeCid;
				var active = [];
				AtWs.extractATDataMultiline(res.data, '+CGACT').forEach(function (row) {
					var p = row.split(',');
					if (p[1] && p[1].trim() === '1' && Number(p[0]) > 0) active.push(Number(p[0]));
				});
				state.activeCid = active.length ? Math.min.apply(null, active) : null;
				return state.activeCid;
			});
		}

		function getPSReg() {
			return AtWs.client.sendCommand('AT+CGREG?').then(function (res) {
				if (res.success && res.data) {
					var stat = null;
					AtWs.extractATDataMultiline(res.data, '+CGREG').forEach(function (row) {
						var p = row.split(',');
						if (p.length >= 2) stat = p[1].trim();
					});
					state.networkStatus = AtWs.psRegText(stat);
				}
			});
		}

		function getOperator() {
			return AtWs.client.sendCommand('AT^EONS=2').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^EONS');
					var code = str ? (str.split(',')[1] || '').trim().replace(/"/g, '') : '';
					state.operator = AtWs.operatorFromCode(code);
				}
			});
		}

		function getAMBR() {
			return resolveActiveCid().then(function (cid) {
				var candidates = [];
				if (cid && cid > 0) candidates.push(cid);
				candidates.push(1);
				var unique = candidates.filter(function (v, i, a) { return a.indexOf(v) === i; });
				var chain = Promise.resolve();
				unique.forEach(function (candidate) {
					chain = chain.then(function () {
						return AtWs.client.sendCommand('AT^DSAMBR=' + candidate).then(function (res) {
							if (!res.success || !res.data) return;
							var str = AtWs.extractATData(res.data, '^DSAMBR');
							if (!str) return;
							var parts = str.split(',');
							/*
							 * 手册 16.17 节：^DSAMBR: <cid>,<DlApnAmbr>,<UlApnAmbr>
							 *   DlApnAmbr / UlApnAmbr 均为 kbps（不是 bps、更不是字节）。
							 * 故此处保留 kbps 原值，并把单位口径标记为 'kbps'，
							 * 由 splitSpeedUI 按 kbps→bps（×1000）换算，
							 * 绝不能再走字节口径的 ×8（那会把 102.4 Mbps 显示成 819 bps）。
							 */
							if (parts.length >= 3) {
								state.ambrDown = parseInt(parts[1], 10) || 0;
								state.ambrUp = parseInt(parts[2], 10) || 0;
							}
							/*
							 * 第 4 个字段（索引 3）在手册标准格式中并不存在，
							 * 属部分固件版本的扩展字段且语义为 APN 字符串。
							 * 仅当它确实是「带引号的字符串」时才采信；若是纯数字
							 * （其他固件可能在此处返回计数值）则忽略，避免把数字当 APN。
							 */
							if (parts.length >= 4) {
								var apnRaw = parts[3].trim();
								if (/^".*"$/.test(apnRaw) || /^'.*'$/.test(apnRaw)) {
									state.apn = apnRaw.replace(/^["']|["']$/g, '') || '未知';
								}
							}
							throw 'done';
						}).catch(function (e) {
							if (e === 'done') return Promise.reject('break');
							return Promise.resolve();
						});
					});
				});
				return chain.catch(function (e) {
					if (e === 'break') { /* 已找到 */ }
					state.activeCid = null;
				}).then(renderConn);
			});
		}

		function getQCI() {
			return resolveActiveCid().then(function (cid) {
				return AtWs.client.sendCommand('AT+CGEQOSRDP').then(function (res) {
					if ((!res.success || !res.data) && cid) return AtWs.client.sendCommand('AT+CGEQOSRDP=' + cid);
					return res;
				}).then(function (res) {
					if (!res.success || !res.data) return;
					var rows = AtWs.extractATDataMultiline(res.data, '+CGEQOSRDP');
					var row = null;
					if (cid !== null) {
						for (var i = 0; i < rows.length; i++) {
							if (Number(rows[i].split(',')[0]) === cid) { row = rows[i]; break; }
						}
					}
					if (!row && rows.length) row = rows[0];
					if (row) state.qci = AtWs.qciLabel(row.split(',')[1] ? row.split(',')[1].trim() : '');
				});
			});
		}

		function getDHCP() {
			return AtWs.client.sendCommand('AT^DHCPV6?').then(function (v6) {
				if (v6.success && v6.data) {
					var str = AtWs.extractATData(v6.data, '^DHCPV6');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.dhcpv6 = {
								ipv6Address: d[0].trim(), netmask: d[1].trim(), gateway: d[2].trim(),
								dhcpServer: d[3].trim(), primaryDNS: d[4].trim(), secondaryDNS: d[5].trim()
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^DHCP?');
			}).then(function (v4) {
				if (v4.success && v4.data) {
					var str = AtWs.extractATData(v4.data, '^DHCP');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.dhcpv4 = {
								ipv4Address: AtWs.hexToIP(d[0].trim()), subnetMask: AtWs.hexToIP(d[1].trim()),
								gateway: AtWs.hexToIP(d[2].trim()), dhcpServer: AtWs.hexToIP(d[3].trim()),
								primaryDNS: AtWs.hexToIP(d[4].trim()), secondaryDNS: AtWs.hexToIP(d[5].trim())
							};
						}
					}
				}
				return AtWs.client.sendCommand('AT^IPV6CAP?');
			}).then(function (cap) {
				if (cap.success && cap.data) {
					var str = AtWs.extractATData(cap.data, '^IPV6CAP');
					if (str) {
						var value = parseInt(str.trim(), 10);
						if (!isNaN(value)) state.ipv6Cap = { capValue: value, description: Parse.ipv6CapDescription(value) };
					}
				}
			}).then(renderDHCP);
		}

		function getFlow() {
			return AtWs.client.sendCommand('AT^DSFLOWQRY').then(function (res) {
				if (res.success && res.data) {
					var str = AtWs.extractATData(res.data, '^DSFLOWQRY');
					if (str) {
						var d = str.split(',');
						if (d.length >= 6) {
							state.flow = {
								lastDsTime: AtWs.parseHexValue(d[0]), lastTxFlow: AtWs.parseHexValue(d[1]),
								lastRxFlow: AtWs.parseHexValue(d[2]), totalDsTime: AtWs.parseHexValue(d[3]),
								totalTxFlow: AtWs.parseHexValue(d[4]), totalRxFlow: AtWs.parseHexValue(d[5])
							};
							renderFlow();
						}
					}
				}
			});
		}

		function getTemp() {
			return AtWs.client.sendCommand('AT^CHIPTEMP?').then(function (res) {
				if (res.success && res.data) {
					var parsed = Parse.parseCHIPTEMP(res.data);
					if (parsed) { state.temps = parsed; renderTemp(); }
				}
			});
		}

		function getMCS() {
			return AtWs.client.sendCommand('AT^MCS=1').then(function (dl) {
				if (dl.success && dl.data) state.downlinkMCS = Parse.parseMCS(dl.data);
				return AtWs.client.sendCommand('AT^MCS=0');
			}).then(function (ul) {
				if (ul.success && ul.data) state.uplinkMCS = Parse.parseMCS(ul.data);
				renderMCS();
		loadDeviceInfo();
			});
		}

		function updateNetworkInfo() {
			var carriers = [];
			return AtWs.client.sendCommand('AT^MONSC').then(function (monsc) {
				var serving = monsc.success && monsc.data ? AtWs.parseMONSC(monsc.data) : null;
				return AtWs.client.sendCommand('AT^HFREQINFO?').then(function (hfreq) {
					carriers = hfreq.success && hfreq.data ? AtWs.parseHFREQINFO(hfreq.data) : [];
					if (!carriers.length) return AtWs.client.sendCommand('AT^HCSQ?').then(function (hcsq) {
						var hcsqData = hcsq.success && hcsq.data ? AtWs.parseHCSQ(hcsq.data) : null;
						if (hcsqData) {
							state.cell.rsrp = hcsqData.rsrp;
							state.cell.rsrq = hcsqData.rsrq;
							state.cell.sinr = hcsqData.sinr;
						}
						return null;
					});
					return null;
				}).then(function () {
					if (serving) {
						state.cell.mcc = serving.mcc; state.cell.mnc = serving.mnc;
						state.cell.lac = serving.lac; state.cell.cid = serving.cid;
						state.cell.channel = serving.channel; state.cell.pci = serving.pci;
						state.cell.rsrp = serving.rsrp != null ? serving.rsrp : state.cell.rsrp;
						state.cell.rsrq = serving.rsrq != null ? serving.rsrq : state.cell.rsrq;
						state.cell.sinr = serving.sinr != null ? serving.sinr : state.cell.sinr;
						state.cell.sysMode = serving.sysMode || state.cell.sysMode;
						state.cell.signalPercent = serving.signalPercent || '';
					}
					/*
					 * ^HFREQINFO 解析结果原样带过来（parseHFREQINFO 已按手册
					 * 每载波 7 字段解好），只把 band 归一为数字。
					 */
					state.carriers = carriers.map(function (c) {
						return {
							index: c.index, kind: c.kind, sysMode: c.sysMode,
							band: c.band ? Number(c.band) : null,
							dlFcn: c.dlFcn, dlFreqMHz: c.dlFreqMHz, dlBwKHz: c.dlBwKHz,
							ulFcn: c.ulFcn, ulFreqMHz: c.ulFreqMHz, ulBwKHz: c.ulBwKHz,
							downlinkOnly: !!c.downlinkOnly
						};
					});
					renderSignal();
					renderCarriers();
					renderConn();
				});
			});
		}

		function loadSecondary() {
			return AtWs.client.sendCommand('AT^MONSSC').then(function (monssc) {
				state.monsscRaw = monssc.success && monssc.data
					? (String(monssc.data).match(/\^MONSSC:\s*([^\r\n]*)/) || [null, 'NONE'])[1].trim()
					: 'NONE';
				state.secondaryNR = monssc.success && monssc.data ? Parse.parseMonsscAll(String(monssc.data)) : [];
				return AtWs.client.sendCommand('AT^CASCELLINFO?');
			}).then(function (cascell) {
				state.secondaryLTE = cascell.success && cascell.data ? Parse.parseCascellAll(String(cascell.data)) : [];
				renderCarriers();
			});
		}

		function loadDiagnostics() {
			// 这几条都可能因为「当前不是那个组网」而失败，属于正常情况，静默处理
			return AtWs.client.sendCommand('AT^LENDC?').then(function (lendc) {
				state.diag.endc = lendc.success && lendc.data ? Parse.parseLendc(lendc.data) : null;
				return AtWs.client.sendCommand('AT+C5GREG?');
			}).then(function (c5g) {
				state.diag.reg = c5g.success && c5g.data ? Parse.parseC5greg(c5g.data) : null;
				return AtWs.client.sendCommand('AT^TXPOWER?');
			}).then(function (txp) {
				state.diag.tx = txp.success && txp.data ? Parse.parseTxPower(txp.data) : null;
				return AtWs.client.sendCommand('AT^NTXPOWER?');
			}).then(function (ntxp) {
				state.diag.nrTx = ntxp.success && ntxp.data ? Parse.parseNrTxPower(ntxp.data) : [];
				return AtWs.client.sendCommand('AT+CGPADDR');
			}).then(function (pdp) {
				state.diag.addrs = pdp.success && pdp.data ? Parse.parseCgpaddr(pdp.data) : [];
				renderDiag();
			});
		}

		/* ---------- 实时速率（OpenWrt 接口统计采样） ---------- */

		/*
		 * 实时速率取自承载 5G 流量的网络接口累计字节数，按「两次采样差 ÷ 时间差」计算。
		 *
		 * 为什么不再用 PDCP：
		 *   PDCP 方案需要后端持续向模组下发 AT 命令订阅上报，既独占 AT 通道，
		 *   又会在用户手动发 AT 命令时产生干扰，直接影响模组工作。
		 *   接口统计是内核维护的计数器，读它不产生任何 AT 流量。
		 *
		 * 采样时序：用本机 Date.now() 做时间基准（与 RPC 往返无关），
		 * 避免 rpcd 与浏览器时钟不同源引入抖动。
		 */
		var rateSample = null;
		var rateTimer = null;

		function sampleRate() {
			return AtWs.netRate('').then(function (r) {
				if (!r.success) {
					/* 失败时清空基准，下次采样重新起算，避免用过期基准算出离谱速率 */
					rateSample = null;
					state.rtDown = 0;
					state.rtUp = 0;
					renderSpeed();
					return;
				}
				var now = Date.now();
				if (rateSample && rateSample.device === r.device) {
					var dt = (now - rateSample.t) / 1000;
					/* 间隔过短（<0.2s）时差分噪声大，跳过本次并保留原基准 */
					if (dt >= 0.2) {
						var drx = r.rx_bytes - rateSample.rx;
						var dtx = r.tx_bytes - rateSample.tx;
						/*
						 * 计数器回绕或接口重置会产生负差，此时不能输出负值，
						 * 直接以 0 处理并重置基准，下一拍即可恢复。
						 */
						state.rtDown = drx >= 0 ? drx / dt : 0;
						state.rtUp = dtx >= 0 ? dtx / dt : 0;
						history.push({ down: state.rtDown, up: state.rtUp });
						if (history.length > HISTORY_POINTS) history = history.slice(history.length - HISTORY_POINTS);
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeed();
						return;
					}
					return;
				}
				/* 首拍或设备变更：只记基准，不产生速率 */
				rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
			});
		}

		rateTimer = setInterval(sampleRate, 1000);
		sampleRate();

		/* ---------- 刷新（分级） ----------
		 *
		 * 串口是独占资源，实测「每 5 秒把所有项目轮一遍」会稳定产生 ~5.5 次 AT 往返/秒，
		 * 已接近 115200 波特率下串口的吞吐上限，既拖慢界面也让模组持续被打扰。
		 * 因此按数据变化速度分档，只按需要快的项目走快档：
		 *
		 *   快档 5s  ：注册状态、实时流量、信号与载波
		 *   慢档 30s ：运营商、签约速率(AMBR)、QCI、DHCP/IP、温度、MCS、
		 *              辅载波查询、连接诊断(ENDC/5GC/发射功率/PDP)
		 *   超慢 60s ：SIM 与设备信息（loadDeviceInfo 自带 60s 节流）
		 *
		 * 运营商 / 签约速率 / QCI 都是「会话级」静态值，注册成功后基本不变，
		 * 放到快档纯属浪费串口往返，因此归入慢档。
		 *
		 * 另外 rpc.js 的只读缓存（2.5s TTL）会吃掉同一轮里重复的查询
		 * （例如 ^HFREQINFO? 同时被「载波与聚合」和「SIM 与设备」用到）。
		 */
		var FAST_MS = 5000;
		var SLOW_MS = 30000;

		var refreshing = false;
		function refreshFast() {
			if (refreshing) return Promise.resolve();
			refreshing = true;
			var chain = Promise.resolve();
			[getPSReg, getFlow, updateNetworkInfo]
				.forEach(function (fn) { chain = chain.then(fn); });
			return chain.catch(function (err) {
				console.warn('快速刷新失败', err);
			}).then(function () { refreshing = false; });
		}

		var slowRefreshing = false;
		function refreshSlow() {
			if (slowRefreshing) return Promise.resolve();
			slowRefreshing = true;
			var chain = Promise.resolve();
			[getOperator, getAMBR, getQCI, getDHCP, getTemp, getMCS, loadSecondary, loadDiagnostics]
				.forEach(function (fn) { chain = chain.then(fn); });
			return chain.catch(function (err) {
				console.warn('慢速刷新失败', err);
			}).then(function () { slowRefreshing = false; });
		}

		/* 手动点「刷新」时全量拉一次（含设备信息，绕过 60s 节流） */
		function refreshAll() {
			loadDeviceInfo(true);
			return refreshFast().then(refreshSlow);
		}

		/* ---------- 自动刷新 ---------- */

		var timer = null, slowTimer = null;
		function resetTimers(enabled, interval) {
			if (timer) { clearInterval(timer); timer = null; }
			if (slowTimer) { clearInterval(slowTimer); slowTimer = null; }
			if (!enabled) return;
			var fast = (interval || 5) * 1000;
			timer = setInterval(refreshFast, fast);
			/* 慢档跟随快档倍数，但不少于 30 秒，避免小间隔下把慢档也拉成高频 */
			slowTimer = setInterval(refreshSlow, Math.max(SLOW_MS, fast * 6));
		}
		var ar = Ui.autoRefresh(resetTimers);
		resetTimers(true, 5);

		var extra = Mt5700.panelActions(
			ar.el,
			Mt5700.primaryButton('刷新', function () { refreshAll(); })
		);
		// 放到页面顶部（连接状态条之后），避免在页面末尾单独占一整行
		/* 刷新控制并入状态条右上角，不再单独占一整行 */
		topbar.insertBefore(extra, strip.el);

		/* ---------- 初始化 ---------- */

		renderConn();
		renderSignal();
		renderCarriers();
		renderDiag();
		renderSpeed();
		renderFlow();
		renderTemp();
		renderDHCP();
		renderMCS();

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [
					{ key: 'key', label: '连接密钥', type: 'password', hint: '该密钥保存在 UCI at-webserver.websocket.auth_key' }
				], function (values) {
					if (!values.key) return;
					AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
				});
				return;
			}
			if (err) console.warn('连接失败', err);
		}).then(function () {
			refreshAll();
		});

		self._dispose = function () {
			/* 离开页面必须清干净：三个定时器 + 只读缓存，否则反复进出会叠加倍轮询 */
			if (timer) clearInterval(timer);
			if (slowTimer) clearInterval(slowTimer);
			if (rateTimer) clearInterval(rateTimer);
			timer = slowTimer = rateTimer = null;
			if (AtWs.client && AtWs.client.clearReadCache) AtWs.client.clearReadCache();
		};

		return page;
	}
});
