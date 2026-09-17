'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 网络状态 - 上游原版视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Info.tsx，并按「一个主题一张卡片」重新组织，避免信息重叠：
 *   ① 信号质量     主小区 RSRP/RSRQ/SINR + 调制方式(MCS)，头部放刷新控制
 *   ② 连接状态     注册/运营商/签约速率 + 连接诊断(ENDC/5GC/发射功率/PDP) + IP 与 DNS
 *   ③ 载波与聚合   主小区身份(PLMN/TAC/小区/PCI) + ^HFREQINFO 载波列表 + CA / EN-DC 状态
 *   ④ 速率与流量   实时速率 + 速率曲线 + 累计流量
 *   ⑤ SIM 与设备   SIM 卡、模块标识、5G 模块温度（12 路传感器取最高）
 * 版式：载波与聚合满宽 → 信号质量满宽 → 双列卡区
 * [连接状态 | 右列（SIM 与设备 → 速率与流量）]。
 * 速率与流量位于右列、紧跟 SIM 与设备正下方，不再兜在页面最底部。载波表列与上游快照一致（制式/频段/频点/带宽/PCI/RSRP/RSRQ/SINR/强度）。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络状态', '实时网络信息与信号质量');
		var body = page._body;

		/* ---------- 顶部连接状态条 ----------
		 * 与其它页一致的 at-status-card（AT 服务 / RPC / SIM），不再做读数带。 */
		var connBar = E('div');
		Mt5700.renderConnectionBar(connBar);
		body.appendChild(connBar);

		/* ---------- 面板骨架（按「一个主题一张卡片」组织，避免信息重叠） ---------- */

		/* ① 信号质量：主小区 RSRP/RSRQ/SINR + 信号百分比 + 调制方式(MCS)
		 * 刷新控制（自动刷新 + 手动刷新）归位到这张卡的头部（相关控件按业务归位） */
		var sigExtra = E('div');
		var signalCard = Mt5700.card('信号质量', '主小区信号与调制方式', sigExtra);
		var sigGrid = E('div', { 'class': 'mt5700-metrics' });
		signalCard._body.appendChild(sigGrid);
		var mcsGrid = E('div', { 'class': 'mt5700-metrics mt5700-mt-md' });
		signalCard._body.appendChild(mcsGrid);
		body.appendChild(signalCard);

		/* ② 连接状态：注册 / 运营商 / 签约速率 + 连接诊断 + IP 与 DNS（原三张卡合并） */
		var connCard = Mt5700.card('连接状态', '注册、诊断与地址');
		/* 标题节点留个引用：renderConn 里要把它改成「连接状态 ・ 中国移动」 */
		var connTitleEl = connCard.querySelector('.mt5700-card-title');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		var diagBox = E('div', { 'class': 'mt5700-mt-md' });
		connCard._body.appendChild(diagBox);
		var dhcpBox = E('div', { 'class': 'mt5700-mt-md' });
		connCard._body.appendChild(dhcpBox);

		/* ③ 载波与聚合：^HFREQINFO 载波列表 + 聚合状态（原「载波聚合」+「辅载波信号」合并） */
		var carrierCard = Mt5700.card('载波与聚合', '主小区身份与各载波');
		var carrierBox = E('div');
		carrierCard._body.appendChild(carrierBox);
		body.appendChild(carrierCard);

		/* ④ 速率与流量：实时速率 + 速率曲线 + 收发流量统计（原三张卡合并）
		 * 头部放「实时监测」开关：关掉后停止每秒采样（不再读接口计数器），
		 * 流量统计仍随慢档刷新。 */
		var rateExtra = E('div');
		var rateCard = Mt5700.card('速率与流量', '实时速率与流量统计', rateExtra);
		var speedRow = E('div', { 'class': 'mt5700-speed-row' });
		rateCard._body.appendChild(speedRow);
		var chart = E('div', { 'class': 'mt5700-chart' });
		rateCard._body.appendChild(chart);
		var flowGrid = E('div', { 'class': 'mt5700-metrics mt5700-metrics-flow mt5700-mt-md' });
		rateCard._body.appendChild(flowGrid);

		/* ⑤ SIM 与设备：SIM 卡、模块标识与 5G 模块温度（同一张表铺开，不跳转、不重复） */
		var devCard = Mt5700.card('SIM 与设备', 'SIM、模块标识与模块温度');
		var devBody = E('div');
		devCard._body.appendChild(devBody);

		/* ⑥ 一键诊断：把本页已有的读数翻译成结论与归因。
		   头部徽章给总评，正文先一句「最可能的原因」，再逐项「结论 + 依据与建议」。
		   全部数据来自 state（信号/速率/注册/载波/温度/SIM），**不新增任何串口查询**。 */
		var diagCard = Mt5700.card('一键诊断', '基于本页实测数据，不额外查询模组');
		var diagBody = E('div');
		diagCard._body.appendChild(diagBody);

		/* 版式（「左右要对称」+「SIM 与设备下面的空白要有价值」）：
		     载波与聚合（满宽，表格含逐载波 RSRP/RSRQ/SINR/强度）
		     信号质量（满宽）
		     连接状态 | 右列（SIM 与设备 → 一键诊断）  ← 双列卡区 .mt5700-cards
		     速率与流量（满宽）
		   右列两张卡用 .mt5700-stack 纵向堆叠，把左列的空白补上（实测左右差 ≈ 70px）。
		   之前的「SIM + 速率」右列比左列高一大截，是因为速率卡带着 170px 曲线；
		   换成诊断卡（纯表格，无图形）后高度正好。窄屏单列时按 DOM 顺序降级：
		   连接状态 → SIM 与设备 → 一键诊断 → 速率与流量。 */
		var duoRight = E('div', { 'class': 'mt5700-stack' });
		duoRight.appendChild(devCard);
		duoRight.appendChild(diagCard);
		var duo = E('div', { 'class': 'mt5700-cards' });
		duo.appendChild(connCard);
		duo.appendChild(duoRight);
		body.appendChild(duo);
		body.appendChild(rateCard);
		body.insertBefore(carrierCard, signalCard);

		/* ---------- 状态 ---------- */

		var state = {
			cell: {
				mcc: '', mnc: '', lac: '', cid: '', channel: '', pci: 0,
				rsrp: null, rsrq: null, sinr: null, sysMode: '未知', signalPercent: ''
			},
			carriers: [],
			nrssbid: null,
			monnc: [],
			diag: { endc: null, reg: null, creg: null, cireg: null, rrc: null, cops: null, nrTx: [], addrs: [] },
			/* 12 路传感器温度，键名与 Parse.parseCHIPTEMP 的返回严格一一对应
			   （手册 17.1：sub3G/sub6G/MIMO/TCXO/peri1/peri2/ap1/ap2/modem1/modem2/bbp1/bbp2）。
			   有守卫 tests/ui-contract.test.js 校验两侧键数一致，补字段时别只改一边。 */
			temps: {
				sub3GPA: 0, sub6GPA: 0, mimoPa: 0, tcxo: 0,
				peri1: 0, peri2: 0, ap1: 0, ap2: 0,
				modem1: 0, modem2: 0, bbp1: 0, bbp2: 0
			},
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
			rtDown: 0, rtUp: 0,
			/* 本轮「实时监测」的峰值速率（字节/秒，与 rtDown/rtUp 同单位）。
			   只在采样时单向取 max，关掉监测再打开会归零重新累计。 */
			peakDown: 0, peakUp: 0
		};

		var history = [];
		var HISTORY_POINTS = 60;

		/*
		 * SIM 状态**只有一份码表**，在 parse.js（SIM_STATUS_SHORT / SIM_STATUS_WARN）。
		 * 这里只消费 Parse.simShort() / Parse.simIsWarn()，不再自带一份。
		 */

		/* 号段显示完整值（用户明确要求：本机状态页不打码） */
		function fullNum(v) {
			var t = String(v == null ? '' : v).trim();
			return t || '—';
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

	/* ⑦ 功能归位原则：同一数据不重复查询。
	 * ^NWTIME（网络时间）已整条移除：手册 §13.8.5 与真机实测都表明，网络未下发
	 * EMM/GMM/MM information 时模组固定输出占位符 90/01/06，本机正是如此，界面只能显示假日期。
	 * 随之删掉 maxTemp（^CHIPTEMP 的重复查询）——温度统一由 getTemp 在慢档取一次。 */

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
				renderDeviceInfo(st);
			});
		}

		/*
		 * 「SIM 与设备」一张表铺开：SIM / 标识 与 各路传感器温度。
		 * 温度数据由 getTemp（慢档 30s，AT^CHIPTEMP? 只取一次）写入 state.temps，
		 * 两路数据到齐时都走同一个 renderDevCard，不会互相覆盖。
		 */
		var devState = null;

		function renderDevCard() {
			if (!devBody) return;
			var st = devState;
			if (!st) return;
			devBody.innerHTML = '';
			var simText = Parse.simShort(st.sim);
			// 11（已初始化）**不算**告警：本卡长期停在 1,11，实测短信收发正常，
			// 自愈推卡也推不动它 —— 详见 parse.js 码表注释。
			var warn = Parse.simIsWarn(st.sim);

			var head = E('div', { 'class': 'mt5700-toolbar' });
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' + (warn ? '' : ' is-on') },
				'SIM：' + simText));
			if (st.pin) head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' }, 'PIN：' + st.pin));
			devBody.appendChild(head);

			if (warn) {
				devBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					st.sim === 0 || st.sim === 99
						? '未检测到 SIM 卡：请检查卡是否插好、是否需要换槽位。'
						: 'SIM 未就绪：请检查卡是否插好、是否被 PIN/PUK 锁定。'));
			}

			var note = manualPhoneNote();
			var phone = st.phone ? (st.phone + '（SIM 卡）')
				: (note ? (note + '（手动备注）')
					: '未写入（可在「服务配置」手动备注）');

			var rows = [
				['手机号', phone],
				/* 手机号存储位置原来显示 "ON 0/2"（存储位置 ON、0 条记录、容量 2），
				   既不直观也与上方 SIM 状态重复，已移除；短信与电话能否接入见上方提示。 */
				['SIM 热插拔', st.hotplug == null ? '—' : (st.hotplug ? '已开启' : '已关闭')],
				['IMSI', fullNum(st.imsi)],
				['ICCID', fullNum(st.iccid)],
				['IMEI', fullNum(st.imei)],
				['模块 / 固件', (st.model || '—') + ' / ' + (st.fw || '—')]
			];

			/* 5G 模块温度：12 路传感器取最高（AT^CHIPTEMP?，单位 0.1℃）。
			   明细挂 title，但**只给数值、不给传感器名** —— 名字源在 parse.js
			   按手册修正前长期错标（peri1/peri2/ap1 被标成 ap1/ap2/modem1），
			   现在把名字写进 UI 等于把历史错误固化；等名字稳定后再加不迟（会审 R01）。
			   0 视为「未上报」，既不参与取 max 也不进明细。 */
			var t = state.temps || {};
			var tempVals = Object.keys(t)
				.map(function (k) { return Number(t[k]) || 0; })
				.filter(function (v) { return v > 0; });
			if (tempVals.length) {
				var maxTemp = Math.max.apply(null, tempVals);
				rows.push(['5G模块温度', E('span',
					{ title: '各传感器明细（℃）：' + tempVals.join(' / ') },
					maxTemp + ' ℃')]);
			} else {
				rows.push(['5G模块温度', '—']);
			}

			devBody.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
		}

		function renderDeviceInfo(st) {
			devState = st;
			renderDevCard();
		}

		/* ================= 一键诊断 =================
		 * 目的不是再罗列一遍参数，而是替用户把读数翻译成「结论 + 最可能的原因」。
		 * 全部数据取自 state（信号 / 速率 / 注册 / 载波 / 温度 / SIM），
		 * 不新增任何串口查询——这也是它比「加个探测面板」省的地方。
		 */

		/* 阈值集中放这里，调判定只动这一处。单位都是字段的原生单位：
		   RSRP / SINR / PUSCH 为 dBm / dB，温度 ℃，签约速率 kbps，实测速率字节/秒。 */
		var DIAG_RULES = {
			rsrpGood: -85, rsrpFair: -95,   /* ≥ -85 良好，≥ -95 一般，否则偏差 */
			sinrGood: 15, sinrFair: 8,      /* ≥ 15 良好，≥ 8 一般，否则偏差 */
			puschGood: 15, puschFair: 20,   /* ≤ 15 为佳，≤ 20 偏高，否则过高 */
			tempWarn: 60, tempBad: 75,      /* 60 起告警，75 起降频 */
			rateGood: 60, rateFair: 30      /* 实测峰值占签约的百分比 */
		};

		function diagNum(v) {
			var n = Number(v);
			return isFinite(n) ? n : null;
		}

		function diagSpeed(value, unitMode) {
			var s = splitSpeedUI(value, unitMode);
			return s.value + ' ' + s.unit;
		}

		/*
		 * 组装诊断项，返回 [{ item, level, verdict, detail }]，level 为 bad / warn / ok。
		 * 取不到读数的项**整项跳过**——宁可少一行，也不用「—」凑版面，
		 * 更不能用 0 冒充实测值（0 会被判成「速率 0%」，等于凭空报故障）。
		 */
		function buildDiagnostics() {
			var items = [];
			var cell = state.cell || {};
			var d = state.diag || {};

			/* ① 速率达成：本轮实测峰值 vs 签约 AMBR。
			   峰值只在「实时监测」开着时累计，关着时 peakDown 为 0，该项跳过。 */
			var ambr = diagNum(state.ambrDown);
			var peak = diagNum(state.peakDown);
			if (ambr !== null && ambr > 0 && peak !== null && peak > 0) {
				var pct = Math.round(peak * 8 / (ambr * 1000) * 100);
				var lv = pct >= DIAG_RULES.rateGood ? 'ok' : (pct >= DIAG_RULES.rateFair ? 'warn' : 'bad');
				items.push({
					item: '速率达成', level: lv,
					verdict: lv === 'ok' ? '正常' : (lv === 'warn' ? '一般' : '偏低'),
					detail: '峰值 ' + diagSpeed(peak, 'bytes') + ' / 签约 ' + diagSpeed(ambr, 'kbps')
						+ '（' + pct + '%）' + (lv === 'bad' ? ' · 建议换时段复测' : '')
				});
			}

			/* ② 信号质量 SINR：同样强度下，SINR 直接决定能跑多高的调制阶数 */
			var sinr = diagNum(cell.sinr);
			if (sinr !== null) {
				var sl = sinr >= DIAG_RULES.sinrGood ? 'ok' : (sinr >= DIAG_RULES.sinrFair ? 'warn' : 'bad');
				items.push({
					item: '信号质量', level: sl,
					verdict: sl === 'ok' ? '良好' : (sl === 'warn' ? '一般' : '偏差'),
					detail: 'SINR ' + sinr + ' dB（良好需 ≥ ' + DIAG_RULES.sinrGood + '）'
						+ (sl === 'ok' ? '' : ' · 建议调整摆放位置或朝向')
				});
			}

			/* ③ 上行发射功率 PUSCH：越高说明离基站越远或遮挡越重，是「看着有信号但上不去」的常见线索 */
			var pusch = (d.nrTx && d.nrTx.length) ? diagNum(d.nrTx[0].pusch) : null;
			if (pusch !== null) {
				var pl = pusch <= DIAG_RULES.puschGood ? 'ok' : (pusch <= DIAG_RULES.puschFair ? 'warn' : 'bad');
				items.push({
					item: '发射功率', level: pl,
					verdict: pl === 'ok' ? '正常' : (pl === 'warn' ? '偏高' : '过高'),
					detail: 'PUSCH ' + pusch + ' dBm（≤ ' + DIAG_RULES.puschGood + ' 为佳）'
						+ (pl === 'ok' ? '' : ' · 距基站较远或有遮挡')
				});
			}

			/* ④ 信号强度 RSRP */
			var rsrp = diagNum(cell.rsrp);
			if (rsrp !== null) {
				var rl = rsrp >= DIAG_RULES.rsrpGood ? 'ok' : (rsrp >= DIAG_RULES.rsrpFair ? 'warn' : 'bad');
				items.push({
					item: '信号强度', level: rl,
					verdict: rl === 'ok' ? '良好' : (rl === 'warn' ? '一般' : '偏差'),
					detail: 'RSRP ' + rsrp + ' dBm（≥ ' + DIAG_RULES.rsrpGood + ' 为良好）'
						+ (rl === 'ok' ? '' : ' · 建议挪到靠窗或高处')
				});
			}

			/* ⑤ 网络注册：5GC / EPS / IMS 三处汇总成一行的结论 */
			var regTexts = [];
			/* AT+C5GREG? 的 statText 自带「5GC」字样（如「已注册 5GC」），
			   再拼一次前缀就会显示成「5GC 已注册 5GC」；只在它没写时才补。 */
			if (d.reg && d.reg.statText) {
				regTexts.push(/5G/.test(d.reg.statText) ? d.reg.statText : '5GC ' + d.reg.statText);
			}
			if (d.creg && d.creg.statText) regTexts.push('EPS ' + d.creg.statText);
			if (d.cireg) regTexts.push('IMS ' + (d.cireg.info ? '可用' : '不可用'));
			if (regTexts.length) {
				var regOk = !!(d.reg && /已注册/.test(d.reg.statText));
				items.push({
					item: '网络注册', level: regOk ? 'ok' : 'bad',
					verdict: regOk ? '正常' : '异常',
					detail: regTexts.join(' · ')
				});
			}

			/* ⑥ 载波聚合：只有单个载波时速率上限受限，值得单独提示 */
			var cc = (state.carriers || []).length;
			if (cc > 0) {
				items.push({
					item: '载波聚合', level: cc >= 2 ? 'ok' : 'warn',
					verdict: cc >= 2 ? '已启用' : '未启用',
					detail: cc + ' 个载波' + (cc >= 2 ? '' : ' · 单载波，速率上限受限')
				});
			}

			/* ⑦ 模块温度：12 路取最高，与「SIM 与设备」那一行同源同口径 */
			var t = state.temps || {};
			var tv = Object.keys(t)
				.map(function (k) { return Number(t[k]) || 0; })
				.filter(function (v) { return v > 0; });
			if (tv.length) {
				var mt = Math.max.apply(null, tv);
				var tl = mt < DIAG_RULES.tempWarn ? 'ok' : (mt < DIAG_RULES.tempBad ? 'warn' : 'bad');
				items.push({
					item: '模块温度', level: tl,
					verdict: tl === 'ok' ? '正常' : (tl === 'warn' ? '偏高' : '过高'),
					detail: mt + ' ℃（告警 ' + DIAG_RULES.tempWarn + ' · 降频 ' + DIAG_RULES.tempBad + '）'
						+ (tl === 'ok' ? '' : ' · 注意通风散热')
				});
			}

			/* ⑧ SIM 状态：状态码表只有一份，在 parse.js（simShort / simIsWarn） */
			if (devState) {
				var simWarn = Parse.simIsWarn(devState.sim);
				items.push({
					item: 'SIM 状态', level: simWarn ? 'bad' : 'ok',
					verdict: simWarn ? '异常' : '正常',
					detail: Parse.simShort(devState.sim) + (devState.pin ? ' · PIN ' + devState.pin : '')
				});
			}

			return items;
		}

		/* 总评：按最严重的一项定级 */
		function diagOverall(items) {
			var bad = 0, warn = 0;
			items.forEach(function (it) {
				if (it.level === 'bad') bad++;
				else if (it.level === 'warn') warn++;
			});
			return {
				level: bad ? 'bad' : (warn ? 'warn' : 'ok'),
				bad: bad, warn: warn, total: items.length
			};
		}

		/*
		 * 总体结论：不复述各项，只给「最可能的原因」。
		 * 归因按优先级排：SIM → 温度 → 信号 → 速率。
		 * 其中「信号都正常但速率远低于签约」是最有价值的一条——
		 * 它直接把责任指向基站侧/套餐，而不是让用户怀疑设备坏了。
		 */
		function diagSummary(items) {
			var map = {};
			items.forEach(function (it) { map[it.item] = it; });
			var rate = map['速率达成'], sig = map['信号强度'],
				quality = map['信号质量'], temp = map['模块温度'], sim = map['SIM 状态'];

			if (sim && sim.level === 'bad') {
				return 'SIM 未就绪，这是当前最该解决的一项：请检查卡是否插好、是否被 PIN/PUK 锁定。';
			}
			if (temp && temp.level === 'bad') {
				return '模块温度已进入降频区间，速率下滑很可能是过热保护所致，先解决散热再看速率。';
			}
			if (sig && sig.level === 'bad') {
				return '信号强度是主要短板：先改善接收（挪到靠窗或高处、避开金属遮挡），再谈速率。';
			}
			if (rate && rate.level === 'bad') {
				if ((!sig || sig.level === 'ok') && (!quality || quality.level === 'ok')) {
					return '信号与温度都正常，速率却远低于签约 —— 基站侧拥塞或套餐限速的可能性大于设备故障，建议换时段复测。';
				}
				return '信号与速率都不理想：先按下面各项的建议改善接收，再复测速率。';
			}
			if (rate && rate.level === 'warn') {
				return '整体可用，速率还没跑满签约。若长期如此，按下面各项逐条排查。';
			}
			/*
			 * 没有单一主因、但有需要关注项时（例如只有「载波聚合未启用」），
			 * 不能回一句「各项指标正常」——总评已经显示「一般」，正文却说正常，
			 * 两处自相矛盾。这里点出排序最靠前的那一项 warn。
			 */
			for (var i = 0; i < items.length; i++) {
				if (items[i].level === 'warn') {
					return '整体可用，但「' + items[i].item + '」还没到理想状态：' + items[i].detail + '。';
				}
			}
			return '各项指标正常，未发现需要处理的异常。';
		}

		/*
		 * 注意：本页另有一个 renderDiag()（下方「连接诊断」，渲染进「连接状态」卡）。
		 * 两个都是 function 声明 → 后者提升覆盖前者，曾导致本卡永远空白（真机「一键诊断没有数据」）。
		 * 故本函数必须叫 renderDiagCard，不得改回 renderDiag。
		 */
		function renderDiagCard() {
			if (!diagBody) return;
			diagBody.innerHTML = '';
			var items = buildDiagnostics();
			if (!items.length) {
				diagBody.appendChild(Mt5700.empty('等待数据…（诊断需要信号、速率、温度等至少一项读数）'));
				return;
			}

			/* 按严重程度排序：bad → warn → ok，同级保持原始顺序（有问题的排在最前面） */
			var order = { bad: 0, warn: 1, ok: 2 };
			items.sort(function (a, b) { return order[a.level] - order[b.level]; });

			var ov = diagOverall(items);
			var lvText = { bad: '较差', warn: '一般', ok: '良好' };
			var tail = [];
			if (ov.bad) tail.push(ov.bad + ' 项异常');
			if (ov.warn) tail.push(ov.warn + ' 项需关注');
			var headText = '总体：' + lvText[ov.level] + '　'
				+ (tail.length ? tail.join(' · ') + ' / 共 ' + ov.total + ' 项' : '共 ' + ov.total + ' 项全部正常');

			var box = E('div', { 'class': 'mt5700-diag-summary is-' + ov.level });
			box.appendChild(E('div', { 'class': 'mt5700-diag-summary-head' }, headText));
			box.appendChild(E('div', { 'class': 'mt5700-diag-summary-text' }, diagSummary(items)));
			diagBody.appendChild(box);

			var rows = items.map(function (it) {
				return [
					it.item,
					E('b', { 'class': 'mt5700-diag-verdict is-' + it.level }, it.verdict),
					it.detail
				];
			});
			diagBody.appendChild(Mt5700.table(['检查项', '结论', '依据与建议'], rows, { striped: true }));
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

		/*
		 * 网络制式显示文案：裸值 NR / LTE 改成「代际-制式」写法（5G-NR / 4G-LTE）。
		 *
		 * ★ 这里的「5GA」是启发式判定，不是模组给的：
		 *   手册 13.1 的 AT^SYSINFOEX <sysmode> 合法值只有 0/1/3/5/6/11（11 = NR-5GC），
		 *   真机 AT^MONSC / AT^HCSQ 也只返回裸 "NR" —— 模组**没有任何 5G-Advanced 字段**，
		 *   手册全文检索不到 5G-A / 5GA / Advanced。所以只能按用户约定的规则推断：
		 *   NR 且聚合载波数 ≥ 2 → 5GA-NR，NR 单载波 → 5G-NR。
		 *
		 * 后缀始终跟随真实 sysMode，不会把 LTE 标成 NR；无法识别的制式原样返回裸值
		 * （宁可显示 "NR-5GC" 也不要编一个代际出来）。
		 */
		function systemModeLabel(sysMode, carrierCount) {
			var m = String(sysMode || '').trim().toUpperCase();
			if (m === 'NR' || m === 'NR-5GC' || m === '5G') {
				return (carrierCount >= 2 ? '5GA' : '5G') + '-NR';
			}
			if (m === 'LTE') return '4G-LTE';
			if (m === 'WCDMA') return '3G-WCDMA';
			if (m === 'GSM') return '2G-GSM';
			return m || '—';
		}

		function renderConn() {
			connBody.innerHTML = '';
			/* 卡片标题带上运营商（「连接状态 ・ 中国移动」）。
			   operatorFromCode 拿不到 PLMN 时返回「未知运营商」，这种情况就不拼，
			   免得标题白白变长还看不出意义。 */
			if (connTitleEl) {
				var op = (state.operator && state.operator !== '未知运营商')
					? state.operator : '';
				connTitleEl.textContent = op ? ('连接状态 ・ ' + op) : '连接状态';
			}
			var c = state.cell;
			var ambrD = splitSpeedUI(state.ambrDown, 'kbps');
			var ambrU = splitSpeedUI(state.ambrUp, 'kbps');
			var grid = E('div', { 'class': 'mt5700-metrics' });
			[
				{ label: '网络状态', value: state.networkStatus, color: 'info' },
				/* 制式改成「5GA-NR / 5G-NR / 4G-LTE」写法，判定规则见 systemModeLabel。
				   载波数是 ^HFREQINFO 聚合出来的载波条数（state.carriers）。 */
				{ label: '网络制式', value: systemModeLabel(state.cell.sysMode, state.carriers.length) },
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

			/* PLMN / TAC / 小区 / PCI 已并入「载波与聚合」卡片：那才是描述主小区的地方，
			   而且原表里的「频点」列其实取的是 TAC（0x14225C），标错了，真频点在载波表里。 */
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
					sinr: Mt5700.gauge('SINR', 'dB', 'sinr')
				};
				sigGrid.appendChild(sigGauges.rsrp.el);
				sigGrid.appendChild(sigGauges.rsrq.el);
				sigGrid.appendChild(sigGauges.sinr.el);
			}
			sigGauges.rsrp.set(c.rsrp);
			sigGauges.rsrq.set(c.rsrq);
			sigGauges.sinr.set(c.sinr);
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
		 * 注意 ^HFREQINFO **不含** RSRP/RSRQ/SINR：主载波行的信号取主小区实时值，
		 * 辅载波行尝试用 ^MONSSC / ^CASCELLINFO 按下行频点对上（本固件分别返回
		 * NONE / ERROR，对不上就是「—」）。表格列与上游快照一致：
		 * 制式 / 频段 / ARFCN / 带宽 / PCI / RSRP / RSRQ / SINR / 强度。
		 * 其中 ARFCN 主载波取 ^MONSC 服务小区频点（对得上手机），见 freqCell 注释。
		 */
		function fmtBw(khz) {
			if (khz == null) return '—';
			return khz >= 1000 ? (khz / 1000) + ' MHz' : khz + ' kHz';
		}
		/* 频段列用 3GPP 标识（n41 / B3），比频率描述更好与工参对照 */
		function bandLabel(sysMode, band) {
			if (band == null) return '—';
			return (sysMode === 'LTE' ? 'B' : 'n') + band;
		}
		/*
		 * 频点列 = ARFCN 数值本身，**不附 MHz 换算**。
		 *
		 * 换算值（504990 → 2524.95 MHz）是派生量，行内再放一个数字反而干扰：
		 * ARFCN 才是与工参、锁频配置、手机工程软件对齐的那个值，给一个就够。
		 * 手机里看到 504990、页面也写 504990，一眼就能对上。
		 *
		 * ★ 取值必须区分「服务小区频点」与「载波中心频点」，两者不是一回事：
		 *   - ^MONSC 的 <channel>（手册 13.9.3 注明是 SSB/服务小区 ARFCN），
		 *     与 ^NRSSBID 的服务小区 ARFCN、手机工程软件显示的都是同一个值；
		 *   - ^HFREQINFO 的 <dl_fcn> 是**载波中心**，13.16 注明「与上下行频点可不一致」。
		 *   本机实测 n41：服务小区 524910 vs 载波中心 528960（60 MHz 载波），
		 *   辅载波 SSB 504990 vs 载波中心 513000（100 MHz 载波），相差几十 MHz 属正常。
		 *   此前本列直接取 <dl_fcn>，用户拿手机一对就以为页面算错了。
		 *
		 * 逐行取哪个值由 renderCarriers 内的 ssbFcn(c) 决定（^MONSC 服务小区 →
		 * ^NRSSBID 邻区配对 → 兜底 <dl_fcn>），本函数只负责渲染成裸值。
		 */
		function freqCell(fcn) {
			if (!fcn) return '—';
			return String(fcn);
		}
		function renderCarriers() {
			carrierBox.innerHTML = '';
			var list = state.carriers || [];
			var count = list.length;
			var c0 = state.cell || {};
			var caActive = count > 1;
			var endc = state.diag && state.diag.endc;
			var dcActive = !!(endc && endc.established);
			var badge = !count ? '不可用'
				: caActive ? (count + ' 载波聚合中')
				: dcActive ? 'EN-DC 双连接'
				: '单载波';

			/* 头部与上游快照一致：先「当前载波数：N 个」，再聚合状态徽章 */
			var head = E('div', { 'class': 'mt5700-carrier-head' });
			head.appendChild(E('span', { 'class': 'mt5700-carrier-headline' },
				count ? ('当前载波数：' + count + ' 个') : '当前载波数：—'));
			head.appendChild(E('span', { 'class': 'mt5700-carrier-badge' + (caActive || dcActive ? ' is-on' : '') }, badge));

			/* 主小区身份：PLMN / TAC / 小区标识 / PCI。
			   原来这组信息单独占一张表放在「连接状态」里，而这里说的是同一个主小区，
			   两处各说一半；现在合并到一处。注意不收「频点」——逐载波频点本表已有，
			   原先那张表里的"频点"取值其实是 TAC（实测 0x14225C），是标错的。 */
			var idLine = [];
			if (c0.mcc || c0.mnc) idLine.push('PLMN ' + (c0.mcc || '—') + '/' + (c0.mnc || '—'));
			if (c0.lac) idLine.push('TAC ' + hexToDec(c0.lac));
			if (c0.cid) idLine.push('小区 ' + hexToDec(c0.cid));
			if (c0.pci) idLine.push('PCI ' + c0.pci);
			if (idLine.length) {
				carrierBox.appendChild(E('div', {
					'class': 'mt5700-hint',
					'style': 'margin:0 0 10px'
				}, idLine.join(' · ')));
			}

			/* 聚合总带宽：原页面只有逐载波带宽，没有合计，要自己心算。
			   多载波时把下行/上行带宽各自求和给出，一眼知道聚合了多少频谱。 */
			var sumDl = 0, sumUl = 0, hasUl = false;
			list.forEach(function (c) {
				if (c.dlBwKHz) sumDl += Number(c.dlBwKHz) || 0;
				if (!c.downlinkOnly && c.ulBwKHz) {
					sumUl += Number(c.ulBwKHz) || 0;
					hasUl = true;
				}
			});
			if (count > 1 && sumDl > 0) {
				head.appendChild(E('span', { 'class': 'mt5700-carrier-badge is-on' },
					'下行合计 ' + fmtBw(sumDl) + (hasUl ? ' · 上行合计 ' + fmtBw(sumUl) : '')));
			}
			carrierBox.appendChild(head);

			if (!count) {
				carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' },
					'未读到载波信息。^HFREQINFO? 在 RRC null 态不支持查询，会返回错误。'));
				return;
			}

			/* 强度条：RSRP → 百分比（-120dBm=0%、-70dBm=100%），≥60 绿 / ≥40 黄 / 否则红 */
			function sigBar(rsrp) {
				if (rsrp == null) return document.createTextNode('—');
				var pct = Math.max(0, Math.min(100, Math.round(2 * (Number(rsrp) + 120))));
				var color = pct >= 60 ? 'var(--mt5700-success)'
					: pct >= 40 ? 'var(--mt5700-warning)' : 'var(--mt5700-danger)';
				return E('div', { 'class': 'mt5700-signal-bar' },
					E('div', { 'class': 'mt5700-signal-bar-fill',
						'style': 'width:' + pct + '%;background:' + color }));
			}

			/* ^NRSSBID 邻区按「SSB 频点落在载波下行带宽内」配对；同频有多个邻区时取 RSRP 最强者 */
			function nrssbidMatch(c) {
				var nb = state.nrssbid && state.nrssbid.neighbors;
				if (!nb || !nb.length || c.dlFreqMHz == null || !c.dlBwKHz) return null;
				var halfMHz = c.dlBwKHz / 2000;
				var best = null;
				nb.forEach(function (n) {
					var mhz = Parse.nrArfcnToMHz(n.arfcn);
					if (mhz == null || Math.abs(mhz - c.dlFreqMHz) > halfMHz) return;
					if (!best || (n.rsrp != null && (best.rsrp == null || n.rsrp > best.rsrp))) best = n;
				});
				return best;
			}

			/*
			 * 每个载波行都给 **SSB 频点**——手机工程软件显示的就是它，
			 * 不能拿 ^HFREQINFO 的 <dl_fcn> 顶上（那是载波中心，见 freqCell 注释）。
			 *
			 * 取值优先级：
			 *   1) ^MONSC 的服务小区频点（最权威），前提是它落在该载波的下行带宽内。
			 *      本机实测双载波聚合：^MONSC 报 524910（2624.55 MHz），
			 *      落在 60 MHz 载波（中心 528960 / 2644.8 MHz，带内 2614.8–2674.8）内，
			 *      不落在 100 MHz 载波（中心 513000 / 2565.0 MHz，带内 2515–2615）内
			 *      —— 据此自动认出哪一行是主载波，不依赖 ^HFREQINFO 的行序；
			 *   2) ^NRSSBID 邻区按「SSB 落在载波带宽内」配对（与辅载波信号列同源）。
			 *      本机实测辅载波命中 504990（2524.95 MHz，RSRP -80）；
			 *   3) 都取不到才退回 <dl_fcn>（载波中心），并在提示行明确标注。
			 *
			 * LTE 不参与 1) 和 2)：<channel> 是 EARFCN（各频段偏移不同，没有偏移表，
			 * 不能按 NR 全局栅格换算），^NRSSBID 也只报 NR，故 LTE 行直接用 <dl_fcn>。
			 */
			function ssbFcn(c) {
				if (c.sysMode === 'NR' && c0.channel && c.dlFreqMHz != null && c.dlBwKHz) {
					var m = Parse.nrArfcnToMHz(Number(c0.channel));
					if (m != null && Math.abs(m - c.dlFreqMHz) <= c.dlBwKHz / 2000) {
						return { fcn: Number(c0.channel), from: 'cell' };
					}
				}
				if (c.sysMode !== 'LTE') {
					var nb = nrssbidMatch(c);
					if (nb && nb.arfcn != null) return { fcn: Number(nb.arfcn), from: 'ssbid' };
				}
				return { fcn: c.dlFcn, from: c.dlFcn ? 'center' : 'none' };
			}

			/*
			 * ^NRSSBID 的邻区不带 RSRQ（手册 13.28 的邻区字段只有 PCI/ARFCN/RSRP/SINR
			 * + 波束），而 ^MONNC 报同一小区时是带的。本机实测 4/4 能按
			 * (ARFCN, PCI) 对上，故从这里回填；对不上返回 null 显示「—」，绝不猜值。
			 */
			function monncRsrq(nb) {
				if (!nb || !state.monnc || !state.monnc.length) return null;
				for (var i = 0; i < state.monnc.length; i++) {
					var c = state.monnc[i];
					if (c.rat === 'NR' && c.arfcn === nb.arfcn && c.pci === nb.pci) return c.rsrq;
				}
				return null;
			}

			/*
			 * 信号列数据源：
			 *   主载波  主小区实时值（^MONSC；PCI/TAC 是十六进制，已在解析时换算）
			 *   辅载波  ^NRSSBID 邻区按「SSB 频点落在载波带宽内」配对（无 RSRQ）
			 * 其余数据源（^MONSSC 仅 NSA、^CASCELLINFO 仅 LTE CA）在本机无效，已删除。
			 */
			var usedSsbid = false;
			var centerRows = [];
			var rows = list.map(function (c, i) {
				var sig;
				if (i === 0) {
					sig = { pci: c0.pci || null, rsrp: c0.rsrp, rsrq: c0.rsrq, sinr: c0.sinr };
				} else {
					var nb = nrssbidMatch(c);
					sig = nb ? { pci: nb.pci, rsrp: nb.rsrp, rsrq: monncRsrq(nb), sinr: nb.sinr } : {};
					if (nb) usedSsbid = true;
				}
				/* 见 ssbFcn：取该载波的 SSB 频点，取不到才退回载波中心 */
				var f = ssbFcn(c);
				if (f.from === 'center') centerRows.push(i + 1);
				return [
					c.sysMode || c.kind || '—',
					bandLabel(c.sysMode, c.band),
					freqCell(f.fcn),
					fmtBw(c.dlBwKHz),
					c.downlinkOnly ? '仅下行' : fmtBw(c.ulBwKHz),
					sig.pci != null ? String(sig.pci) : '—',
					sig.rsrp != null ? sig.rsrp + ' dBm' : '—',
					sig.rsrq != null ? sig.rsrq + ' dB' : '—',
					sig.sinr != null ? sig.sinr + ' dB' : '—',
					sigBar(sig.rsrp)
				];
			});
			carrierBox.appendChild(Mt5700.table(
				['制式', '频段', 'ARFCN', '下行带宽', '上行带宽', 'PCI', 'RSRP', 'RSRQ', 'SINR', '强度'],
				rows,
				{ striped: true }
			));

			var hint = '载波聚合要等到有数据业务时才会激活，空闲时通常只报主载波。';
			/*
			 * ARFCN 列逐行给的是该载波的 **SSB 频点**，与手机工程软件一致；
			 * ^HFREQINFO 的 <dl_fcn> 是**载波中心**，在 60/100 MHz 带宽下能差几十 MHz
			 * （本机：SSB 524910 vs 载波中心 528960；SSB 504990 vs 载波中心 513000）。
			 * 不写出来，用户拿手机一对就会以为页面算错了（这是真实报障，发生过两次）。
			 */
			hint += ' ARFCN 列取各载波的 SSB 频点（与手机工程软件一致）；'
				+ '^HFREQINFO 的 <dl_fcn> 是载波中心，仅在测不到 SSB 时兜底显示。';
			if (centerRows.length) {
				hint += ' 第 ' + centerRows.join('、') + ' 载波本轮没测到 SSB 频点，'
					+ '显示的是载波中心，与手机的数值会对不上。';
			}
			if (usedSsbid) {
				hint += ' 辅载波 PCI/RSRP/SINR 来自 ^NRSSBID 邻区测量（按频点配对），'
					+ 'RSRQ 由 ^MONNC 按 ARFCN+PCI 关联回填（^NRSSBID 邻区不带 RSRQ）。';
			} else if (list.length > 1) {
				/*
				 * ^NRSSBID 只报「按波束能量排序的前 4 个」小区，辅载波上的小区
				 * 常常排不进去（本机 9 次采样里只有 1 次命中）。此时整行空白容易被
				 * 误读成「没刷新」，必须把原因写出来。
				 */
				hint += ' 当前 ^NRSSBID 的前 4 强邻区都不在辅载波频带内，故辅载波信号列为空——'
					+ '这是该命令只报 4 个小区的固有局限，不是刷新失败。';
			}
			if (slowFailures.loadSecondary) {
				hint += ' 注意：本轮辅载波数据拉取失败（已保留上一次读数）。';
			}
			carrierBox.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));

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
			if (d.creg) rows.push(['4G(EPS) 注册', d.creg.statText]);
			if (d.cireg) rows.push(['IMS 注册', d.cireg.text + (d.cireg.info ? '（VoLTE/VoNR/IMS 短信可用）' : '（语音/IMS 短信不可用）')]);
			if (d.rrc) rows.push(['RRC 状态', d.rrc.rrcText + (d.rrc.campText ? ' · ' + d.rrc.campText : '')]);
			if (d.cops) {
				var copsTxt = d.cops.modeText + (d.cops.oper ? ' · ' + d.cops.oper : '');
				if (d.cops.actText) copsTxt += ' · ' + d.cops.actText;
				rows.push(['选网模式', copsTxt]);
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
		function renderSpeed() {
			speedRow.innerHTML = '';
			if (!rateOn) {
				speedRow.appendChild(Mt5700.speedBox('↓ 下行', '—'));
				speedRow.appendChild(Mt5700.speedBox('↑ 上行', '—'));
				chart.innerHTML = '';
				chart.appendChild(E('div', { 'class': 'mt5700-hint' },
					'实时速率监测已关闭（不再每秒读取接口计数器）；累计流量统计仍会自动刷新。'));
				return;
			}
			var d = splitSpeedUI(state.rtDown, 'bytes');
			var u = splitSpeedUI(state.rtUp, 'bytes');
			speedRow.appendChild(Mt5700.speedBox('↓ 下行', d.value + ' ' + d.unit));
			speedRow.appendChild(Mt5700.speedBox('↑ 上行', u.value + ' ' + u.unit));
			renderChart();
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
			/* 峰值是「本轮实时监测」内的最大值（关掉监测再开即归零），
			   单位与 rtDown/rtUp、state.peakDown/peakUp 一致（字节/秒），显示同样走 splitSpeedUI。 */
			function peakText(bps) {
				if (!bps) return '—';
				var s = splitSpeedUI(bps, 'bytes');
				return s.value + ' ' + s.unit;
			}
			[
				{ label: '当前会话时长', value: AtWs.formatDuration(f.lastDsTime, false) },
				{ label: '当前下行流量', value: AtWs.formatFlow(f.lastRxFlow) },
				{ label: '当前上行流量', value: AtWs.formatFlow(f.lastTxFlow) },
				{ label: '累计时长', value: AtWs.formatDuration(f.totalDsTime, true) },
				{ label: '累计下行', value: AtWs.formatFlow(f.totalRxFlow) },
				{ label: '累计上行', value: AtWs.formatFlow(f.totalTxFlow) },
				{ label: '峰值下行', value: peakText(state.peakDown) },
				{ label: '峰值上行', value: peakText(state.peakUp) }
			].forEach(function (it) {
				flowGrid.appendChild(Mt5700.metric(it.label, it.value));
			});
		}

		function renderTemp() {
			/* 各路温度已并入「SIM 与设备」卡的那一张表（见 renderDevCard），
			   这里只触发重绘，不再单独占一块磁贴区。 */
			renderDevCard();
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
				/* 信号强度百分比由 PS 状态解析得到（state.cell.signalPercent），
				   之前只存不用 —— 环形仪表给的是 dBm 绝对值，这里补一个直观的百分比。 */
				{ label: '信号强度', value: state.cell.signalPercent || '—' },
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
			}).then(renderConn);
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
			/*
			 * 辅载波/邻区信号已统一由 ^NRSSBID 提供（见 renderCarriers 的 nrssbidMatch）：
			 *   - ^MONSSC 手册注明「非 NSA 返回查询失败」，本机 SA 组网恒回 NONE；
			 *   - ^CASCELLINFO? 仅 LTE CA 有效，本机 NR CA 下恒回 ERROR。
			 * 这两条在本机属于无效功能，已删除查询（每轮省 2 次串口往返），
			 * 其解析函数也从 parse.js 一并移除。
			 */
			return AtWs.client.sendCommand('AT^NRSSBID?').then(function (ssbid) {
				state.nrssbid = ssbid.success && ssbid.data ? Parse.parseNrssbid(String(ssbid.data)) : null;
				/* ^MONNC 只为给 SSB 邻区补 RSRQ（SSB 不含该项）；查不到就整列「—」，
				   不影响辅载波本身的 PCI/RSRP/SINR。 */
				return AtWs.client.sendCommand('AT^MONNC');
			}).then(function (monnc) {
				state.monnc = monnc.success && monnc.data ? Parse.parseMonncAll(String(monnc.data)) : [];
				delete slowFailures.loadSecondary;   /* 成功一轮就抹掉失败留痕 */
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
				/* 不再发 AT^TXPOWER?（LTE/GUL 发射功率）：手册 §13.23 注明仅 GUL 有效，
				   本机 NR SA 下实测 0/3 恒 ERROR，属无效查询。NR 侧用 ^NTXPOWER?。 */
				return AtWs.client.sendCommand('AT^NTXPOWER?');
			}).then(function (ntxp) {
				state.diag.nrTx = ntxp.success && ntxp.data ? Parse.parseNrTxPower(ntxp.data) : [];
				/* 4G(EPS) 注册：SA/NSA 下 LTE 侧的注册状态，与 CGREG(2/3G)、C5GREG(5G) 互补 */
				return AtWs.client.sendCommand('AT+CEREG?');
			}).then(function (creg) {
				state.diag.creg = creg.success && creg.data ? Parse.parseRegStat(String(creg.data), '+CEREG') : null;
				/* IMS 注册：直接决定 VoLTE / VoNR / IMS 短信能不能用 */
				return AtWs.client.sendCommand('AT+CIREG?');
			}).then(function (cireg) {
				state.diag.cireg = cireg.success && cireg.data ? Parse.parseCireg(String(cireg.data)) : null;
				/* RRC 状态：连接态/空闲态 —— 也解释了「空闲时看不到载波聚合」 */
				return AtWs.client.sendCommand('AT^RRCSTAT?');
			}).then(function (rrc) {
				state.diag.rrc = rrc.success && rrc.data ? Parse.parseRrcstat(String(rrc.data)) : null;
				/* 选网模式（+COPS?）：自动还是手动锁了运营商；读命令，安全 */
				return AtWs.client.sendCommand('AT+COPS?');
			}).then(function (cops) {
				state.diag.cops = cops.success && cops.data ? Parse.parseCops(String(cops.data)) : null;
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
		var rateOn = true;

		/* 「实时监测」开关：关闭即停表（不再每秒读接口计数器），重开时重新起基准 */
		function setRateEnabled(on) {
			rateOn = !!on;
			try { localStorage.setItem('mt5700.rateOn', rateOn ? '1' : '0'); } catch (e) {}
			if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
		if (rateOn) {
			rateSample = null;
			/* 重新开始一段监测：峰值随之归零，否则上一轮的尖峰会一直挂着 */
			state.peakDown = 0;
			state.peakUp = 0;
			rateTimer = setInterval(sampleRate, 1000);
			sampleRate();
		}
			renderSpeed();
			/* 峰值随之归零 / 重新起算，「速率达成」这一项要跟着变，
			   否则会一直挂着上一轮的尖峰，或关掉监测后仍显示旧百分比 */
			renderDiagCard();
		}

		var rateChk = E('input', { 'type': 'checkbox' });
		rateChk.addEventListener('change', function () { setRateEnabled(rateChk.checked); });
		rateExtra.appendChild(E('div', { 'class': 'at-autorefresh' },
			E('label', {}, rateChk, document.createTextNode(' 实时监测'))));

		/*
		 * 1Hz 采样，但一次 netRate 往返可能长得多（它的超时是 5s）。
		 * 没有在飞守卫就会多个采样重叠：后一次覆盖 rateSample 之后，先回来的那次
		 * 拿新基准配自己的旧时刻，dt 与字节差不是同一段区间 —— 速率曲线出现
		 * 尖刺，甚至因为差分为负而被抹成 0。重叠期间直接跳过即可，
		 * 下一拍（1 秒后）自然会用最新基准继续，不会丢数据。
		 */
		var rateInFlight = false;
		/* 采样节拍计数：诊断卡依赖峰值速率，但没必要 1Hz 重建表格，用它稀释到 5 秒一次 */
		var diagSampleTick = 0;
		function sampleRate() {
			if (rateInFlight) return Promise.resolve();
			rateInFlight = true;
			var settle = function () { rateInFlight = false; };
			return AtWs.netRate('').then(function (r) {
				settle();
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
					/* 峰值只在本段监测内累计（单位与 rt* 一致：字节/秒） */
					if (state.rtDown > state.peakDown) state.peakDown = state.rtDown;
					if (state.rtUp > state.peakUp) state.peakUp = state.rtUp;
						rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
						renderSpeed();
					/* 峰值变了，「速率达成」这一项的百分比也要跟着走 */
					if (++diagSampleTick % 5 === 0) renderDiagCard();
						return;
					}
					return;
				}
				/* 首拍或设备变更：只记基准，不产生速率 */
				rateSample = { t: now, rx: r.rx_bytes, tx: r.tx_bytes, device: r.device };
			}, function (err) {
				void err;
				/* 请求失败同样要放开守卫，否则速率监测会永久停摆 */
				settle();
				rateSample = null;
				state.rtDown = 0;
				state.rtUp = 0;
				renderSpeed();
			});
		}

		/* 恢复上次的开关状态（默认开） */
		var savedRateOn = '1';
		try { savedRateOn = localStorage.getItem('mt5700.rateOn') || '1'; } catch (e) {}
		rateChk.checked = savedRateOn !== '0';
		setRateEnabled(rateChk.checked);

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
		/*
		 * 在跑的那一轮刷新。
		 *
		 * 原先撞车时直接 `return Promise.resolve()`，于是用户手动点「刷新」
		 * 而自动刷新正好在跑的话，整条 .then 链瞬间走完、一条命令都没发 ——
		 * 界面上按钮按了、转圈都没有，表现为「刷新按钮偶发没反应」。
		 * 现在撞车就复用在跑的那一轮：用户等到的仍是这一轮的真实数据，
		 * 自动刷新之间也依旧互斥，不会叠加着抢独占串口。
		 */
		var fastRunning = null;
		function refreshFast() {
			if (fastRunning) return fastRunning;
			refreshing = true;
			var chain = Promise.resolve();
			/* 只保留「用户盯着看、需要秒级新鲜」的内容：信号与小区信息。
			   注册状态（AT+CGREG?）与模组侧累计流量（AT^DSFLOWQRY）不随秒变化，
			   已移到 30 秒慢档——实时速率另有 1Hz 的网卡计数采样，不受影响。 */
			[updateNetworkInfo]
				.forEach(function (fn) { chain = chain.then(fn); });
			fastRunning = chain.catch(function () { /* 刷新失败保留上一次数据 */ })
				.then(function () { refreshing = false; fastRunning = null; });
			return fastRunning;
		}

		/*
		 * 慢档任务顺序：**辅载波（loadSecondary）排在最前**。
		 * 它过去排在第 9 位，要等前面 8 个函数（十余次串口往返）串行走完才执行，
		 * 首屏进入页面时辅载波读数要空等一轮，表现为「显示缓慢」。
		 * 它只依赖快档已取到的 state.carriers，没有前置依赖，放前面是安全的。
		 */
		var SLOW_TASKS = [loadSecondary, getPSReg, getFlow, getOperator, getAMBR,
			getQCI, getDHCP, getTemp, getMCS, loadDiagnostics];

		/* 慢档各任务的失败记录：逐步兜错后失败不再阻断后续，但要留痕，
		   否则「某一项一直失败」又会退化成看不见的静默问题。 */
		var slowFailures = {};
		var slowRefreshing = false;
		var slowRunning = null;   /* 同 refreshFast：撞车时复用在跑的那一轮 */
		function refreshSlow() {
			if (slowRunning) return slowRunning;
			slowRefreshing = true;
			/*
			 * 串行，但**每个环节各自兜错**。
			 * 过去是 `chain.then(a).then(b)…` 末尾挂一个 catch：任何一步 reject，
			 * 后面全部静默跳过（含 loadSecondary），界面却毫无提示，
			 * 表现为「辅载波读数一直不刷新、像是卡住了」。
			 * 改成逐步兜错后，单点失败只丢那一项，其余照常更新。
			 */
			var chain = Promise.resolve();
			SLOW_TASKS.forEach(function (fn) {
				chain = chain.then(function () {
					return Promise.resolve()
						.then(fn)
						.catch(function (err) { slowFailures[fn.name || '匿名任务'] = err; });
				});
			});
			slowRunning = chain.then(function () {
				slowRefreshing = false;
				slowRunning = null;
				/* 诊断吃的是慢档取到的信号 / 注册 / 载波 / 温度 / SIM，
				   慢档整轮跑完再统一刷一次，避免逐个任务渲染导致的抖动 */
				renderDiagCard();
			});
			return slowRunning;
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
			if (document.hidden) return;   /* 后台标签页不重建定时器（见下方 visibilitychange） */
			var fast = (interval || 5) * 1000;
			timer = setInterval(refreshFast, fast);
			/* 慢档跟随快档倍数，但不少于 30 秒，避免小间隔下把慢档也拉成高频 */
			slowTimer = setInterval(refreshSlow, Math.max(SLOW_MS, fast * 6));
		}
		var ar = Ui.autoRefresh(resetTimers);
		resetTimers(true, 5);

		/*
		 * 标签页不可见时暂停轮询。
		 * 这一页是全插件轮询最密的（2026-09-13 实测稳态 2.60 次/秒，其中 AT 命令 1.73 次/秒），
		 * 而此前没有任何可见性判断——标签页切到后台后仍在全速占串口。
		 * 回到前台立即恢复并补一次刷新，避免看到陈旧读数。
		 */
		var onVisibility = function () {
			if (document.hidden) { resetTimers(false); return; }
			resetTimers(ar.isEnabled(), ar.getInterval());
			refreshAll();
		};
		document.addEventListener('visibilitychange', onVisibility);

		/* 刷新控制归位到「信号质量」卡片头部，不再单独占一行 */
		sigExtra.appendChild(Mt5700.panelActions(
			ar.el,
			Mt5700.primaryButton('刷新', function () { refreshAll(); })
		));

		/* ---------- 初始化 ---------- */

		renderConn();
		renderSignal();
		renderCarriers();
		renderDiag();          /* 连接诊断（渲染进「连接状态」卡内） */
		renderDiagCard();      /* 一键诊断（右列独立卡片） */
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
		}).then(function () {
			refreshAll();
		});

		self._dispose = function () {
			/* 离开页面必须清干净：三个定时器 + 可见性监听 + 只读缓存，
			   否则反复进出会叠加倍轮询。 */
			if (timer) clearInterval(timer);
			if (slowTimer) clearInterval(slowTimer);
			if (rateTimer) clearInterval(rateTimer);
			timer = slowTimer = rateTimer = null;
			if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
			if (AtWs.client && AtWs.client.clearReadCache) AtWs.client.clearReadCache();
		};
		page._onDispose(self._dispose);

		return page;
	}
});
