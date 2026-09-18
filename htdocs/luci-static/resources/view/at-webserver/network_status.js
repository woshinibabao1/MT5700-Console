'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
'require uci';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 网络状态 - 上游原版视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Info.tsx，并按「一个主题一张卡片」重新组织，避免信息重叠：
 *   ① 信号质量     主小区 RSRP/RSRQ/SINR + 调制方式(MCS)，头部放刷新控制
 *   ② 连接状态     注册/运营商/签约速率 + 一张合并表（连接诊断 + 地址与 DNS）
 *   ③ 载波与聚合   主小区身份(PLMN/TAC/小区/PCI) + ^HFREQINFO 载波列表 + CA / EN-DC 状态
 *   ④ 速率与流量   实时速率 + 速率曲线 + 累计流量（卡头带「实时监测」开关与「清零」）
 *   ⑤ SIM 与设备   SIM 卡、模块标识、5G 模块温度（12 路传感器取最高）
 *   ⑥ 连接工具     ADC 管脚电压 / 连通性自检（都是进页面自动跑一次的只读查询）
 * 版式：载波与聚合满宽 → 信号质量满宽 → 双列卡区
 * [连接状态 | 右列（SIM 与设备 → 连接质量）]。
 *
 * ★ 为什么把「连接诊断 / 地址与 DNS」两张表合成一张（2026-09-18）：
 *   三者的行都是「项目 → 值」，拆三张只是多出两行表头、把同类信息切三刀；
 *   而「CID」「来源」两列又是纯内部概念 —— CID 1/5 用户无从干预，
 *   PDP 与 WAN 本来就是同一个地址，标了来源反而让人以为有两份地址。
 *   合并后按「连接诊断 / 地址与 DNS」两个分组标题行分隔。
 *
 * ★ 为什么把「连接质量」整卡换成「连接工具」（2026-09-18）：
 *   旧卡四项里，会话均速重复「速率与流量」、信号波动重复「信号质量」、
 *   空口丢包是自 PDU 会话建立起累加且模组从不清零的历史账，短信承载域又与主题无关；
 *   它没有独立的问题域，只是「别处不要的边角料」集中营。新卡全部换成能做事的工具。
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

		/* ② 连接状态：注册 / 运营商 / 签约速率 + 一张「连接明细」表。
		 * 连接诊断、地址与 DNS 两张表已合并成一张（见 renderConnDetail）。 */
		var connCard = Mt5700.card('连接状态', '注册、诊断与地址');
		/* 标题节点留个引用：renderConn 里要把它改成「连接状态 ・ 中国移动」 */
		var connTitleEl = connCard.querySelector('.mt5700-card-title');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		/* 合并后只剩一个容器：三张表的行都是「项目 → 值」，分组标题行负责分隔。 */
		var connDetailBox = E('div', { 'class': 'mt5700-mt-md' });
		connCard._body.appendChild(connDetailBox);

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

		/* ⑥ 连接工具：这一页别处全是读数，这里放**能做事的工具** ——
		 * ADC 管脚电压 / 连通性自检。两者都是**只读**查询，进页面自动跑一次并串行排好队，
		 * 按钮退化成「重新读取 / 重新自检」。
		 * ★「流量统计清零」已迁到「速率与流量」卡头：它是个动作按钮，
		 *   和同卡的流量数字放在一起才顺手，不该在「工具」里占一整块。
		 * ★「网络拒绝原因」已迁到「网络设置 → 网络拒绝」，「服务状态监听」已下线
		 *   —— 理由见下方连接工具区的注释。 */
		var toolsCard = Mt5700.card('连接工具', '排查与诊断');
		var toolsBody = E('div');
		toolsCard._body.appendChild(toolsBody);

		/* 版式（「左右要对称」+「SIM 与设备下面的空白要有价值」）：
		     载波与聚合（满宽，表格含逐载波 RSRP/RSRQ/SINR/强度）
		     信号质量（满宽）
		     连接状态 | 右列（SIM 与设备 → 连接质量）  ← 双列卡区 .mt5700-cards
		     速率与流量（满宽）
		   右列两张卡用 .mt5700-stack 纵向堆叠，把左列的空白补上（实测左右差 ≈ 70px）。
		   之前的「SIM + 速率」右列比左列高一大截，是因为速率卡带着 170px 曲线；
		   换成纯表格的卡后高度正好。窄屏单列时按 DOM 顺序降级：
		   连接状态 → SIM 与设备 → 连接质量 → 速率与流量。 */
		var duoRight = E('div', { 'class': 'mt5700-stack' });
		duoRight.appendChild(devCard);
		duoRight.appendChild(toolsCard);
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
			tools: {
				adc: { rows: [], at: 0, busy: false, err: null },
				check: { busy: false, steps: null, at: 0 }
			},
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

		/* ================= 连接工具 =================
		 * 其余卡片全是「读数」，这一张专放**能做事的按钮**。
		 *
		 * ★ 为什么整卡换掉上一版「连接质量」（2026-09-18）：
		 *   旧卡四项里，会话均速重复「速率与流量」、信号波动重复「信号质量」、
		 *   空口丢包是自 PDU 会话建立起累加且模组从不清零的历史账
		 *   （真机 60 秒 4 次采样 17337 纹丝不动，常年显示「正常」），
		 *   短信承载域又与「连接」不是一个话题 —— 它没有独立的问题域，
		 *   只是「别处不要的边角料」集中营。
		 *
		 * ★ 三个工具的手册依据（实测排除掉的候选记在 FRONTEND_REVIEW_REPORT.md）：
		 *   · ADC 管脚电压   手册 11.5   AT^ADCREADEX=<id>，纯读，进页面自动读一次
		 *   · 连通性自检     CPIN → C5GREG → CGACT → NDISSTATQRY → CGPADDR → DHCP 逐层走，
		 *                   同样是纯读，进页面跟在 ADC 之后**串行**跑一次
		 *   · 流量统计清零   手册 16.11  AT^DSFLOWCLR，只清计数器、不断网
		 *
		 * ★★ 两项已迁走 / 下线（2026-09-18，别再搬回来）：
		 *   ①「网络拒绝原因」迁到「网络设置 → 网络拒绝」：它回答的是「为什么注册不上」，
		 *      与锁频、邻区扫描是同一条排查链，放设置页才找得到；^REJINFO 是模组自发
		 *      URC，放哪一页都不占 AT 通道。
		 *   ②「服务状态监听」整块下线：手册只有设置命令 AT^SRVST=<n>、没有读命令，
		 *      想看状态就得先开周期上报再等模组推 —— 正是 2.2.1 那类「页面进出自带写
		 *      命令、页面被强杀后上报常驻模组」的风险源，而收益只是「掉网时多一行记录」，
		 *      不值得为它占一条独占通道。
		 *
		 * ★★★ 安全底线（2.2.1 事故的硬教训，写在这里防回退）：
		 *   上一版为做「卡不卡」，让页面**进入时自动下发** AT^PDCPDATAINFO=1,5000
		 *   开周期上报、离开时才关。页面被强杀后上报永久常驻模组，与 1Hz 的 AT
		 *   轮询争抢同一条 AT 通道，真机事件队列积压 106 帧，只能重启服务才停。
		 *   因此：**本卡任何功能都不许在模组里留下常驻状态**。ADC / 自检 / 清零
		 *   都是一次性读或写；将来若要再加「开上报 → 等推送」型功能，必须同时满足
		 *   ① 默认关、只能手动开；② 到点定时器强制关；③ 关不掉就显式报警 + 重试入口
		 *   —— 悄悄留下一个常驻上报，比测不到严重得多。
		 *   守卫：tests/connection-tools-contract.test.js
		 */

		/* ADC 管脚 id：手册 11.5 明写「不同产品的 ADC 管脚的数量不同」，
		   所以逐个试、第一条失败就停，不预设数量。 */
		var ADC_PIN_IDS = [0, 1, 2, 3, 4];

		/* ★ 页面已卸载标记。进页面自动跑的「ADC → 自检」链一共 11 条只读查询，
		   用户反复进出时，前一次的链还在独占的 AT 通道上排队（2.2.1 事故的形态：
		   虽是只读、不留下常驻状态，但排队本身会让整页读数变慢）。
		   _dispose 里置 true，链内每一步开头检查，让已发起的链尽快自然终止。 */
		var disposed = false;

		/* 工具块外壳：标题 + 右侧按钮，结果区由调用方 append */
		function toolBlock(title, btn) {
			var box = E('div', { 'class': 'mt5700-mt-md' });
			var bar = E('div', { 'class': 'mt5700-toolbar' });
			bar.appendChild(E('span', { 'class': 'mt5700-badge mt5700-badge-neutral' }, title));
			if (btn) bar.appendChild(btn);
			box.appendChild(bar);
			return box;
		}

		function renderTools() {
			if (!toolsBody) return;
			toolsBody.innerHTML = '';
			toolsBody.appendChild(buildAdcBlock());
			toolsBody.appendChild(buildCheckBlock());
		}

		/* ---------- ① ADC 管脚电压（手册 11.5） ----------
		 * 进页面自动读一次（见底部初始化），结果一行铺开，不用先点按钮；
		 * 按钮只是「再读一次」。5 条只读查询，失败即停，不会在模组里留下任何状态。 */

		function buildAdcBlock() {
			var t = state.tools.adc;
			var btn = Mt5700.ghostButton(t.busy ? '读取中…' : (t.rows.length ? '重新读取' : '读取'), readAdcPins);
			var box = toolBlock('ADC 管脚电压', btn);

			if (t.rows.length) {
				/* 值直接排进标题那一行：原先是「表头 + N 行 + 两行说明」，
				   3 个管脚要吃掉 6 行高度；现在整块只有 2 行。
				   管脚一律从 0 连续编号（逐个试、第一条失败即停），
				   所以「ADC0 ADC1 ADC2」本身就是顺序，表头是重复信息。 */
				var vals = E('span', { 'class': 'mt5700-readouts' });
				t.rows.forEach(function (r) {
					var chip = E('span', { 'class': 'mt5700-readout' });
					chip.appendChild(E('span', { 'class': 'mt5700-readout-name' }, 'ADC' + r.id));
					chip.appendChild(E('span', { 'class': 'mt5700-readout-value' }, String(r.value)));
					vals.appendChild(chip);
				});
				vals.appendChild(E('span', { 'class': 'mt5700-readout-unit' }, 'mV'));
				box.firstChild.insertBefore(vals, btn);
				box.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'手册未说明各管脚接的是什么 —— 只给原始电平，不解读、不设阈值。'));
			} else if (t.err) {
				box.appendChild(Mt5700.empty(t.err));
			} else {
				box.appendChild(E('p', { 'class': 'mt5700-hint' },
					t.busy ? '正在读取各 ADC 管脚…' : '进页面自动读取；没出结果时点右侧按钮再读一次。'));
			}
			return box;
		}

		function readAdcPins() {
			var t = state.tools.adc;
			/* ★ 必须返回 Promise：入口是 readAdcPins().then(runSelfCheck)，
			   busy 时 return undefined 会让调用方抛 TypeError，被吞进没人 catch 的
			   rejected promise —— 表现为「自检静默不跑，页面上没有任何提示」。 */
			if (t.busy) return Promise.resolve();
			t.busy = true; t.err = null; t.rows = [];
			renderTools();
			var stopped = false;
			var chain = Promise.resolve();
			ADC_PIN_IDS.forEach(function (id) {
				chain = chain.then(function () {
					if (stopped || disposed) return;
					return AtWs.client.sendCommand('AT^ADCREADEX=' + id).then(function (res) {
						var v = (res && res.success) ? Parse.parseAdcValue(String(res.data || '')) : null;
						/* 第一条取不到就停：说明这个 id 不存在，后面也不用问了 */
						if (v == null) { stopped = true; return; }
						t.rows.push({ id: id, value: v });
					});
				});
			});
			return chain.catch(function (e) { t.err = (e && e.message) || '读取失败'; })
				.then(function () {
					t.busy = false; t.at = Date.now();
					if (!t.rows.length && !t.err) t.err = '模组未返回任何 ADC 管脚值（该型号可能不支持 ^ADCREADEX）';
					if (!disposed) renderTools();
				});
		}

		/* ---------- ② 连通性自检向导 ---------- */

		/*
		 * 逐层走一遍「拿到网」的每一步，卡住就停在那一步。
		 * 判据全部来自手册中该命令的取值定义，不猜：
		 *   CPIN        手册 6.x  <code> = READY 才就绪
		 *   C5GREG      手册 7.x  <stat> 1=已注册 5=已注册(漫游) 3=注册被拒
		 *   CGACT       手册 7.x  <state> 1=已激活
		 *   NDISSTATQRY 手册 16.4 <stat> 1=已连接
		 *   CGPADDR     手册 7.x  有地址才算拿到
		 *   DHCP        手册 16.x 第 3 个字段是网关（十六进制 IP）
		 */
		function checkSteps() {
			return [
				{
					name: 'SIM 就绪', cmd: 'AT+CPIN?',
					judge: function (data) {
						var m = String(data).match(/CPIN:\s*(\S+)/);
						var v = m ? m[1] : '';
						if (v === 'READY') return { level: 'ok', text: 'READY' };
						if (!v) return { level: 'bad', text: '取不到 SIM 状态（卡没插好或没识别）' };
						return { level: 'bad', text: 'SIM 未就绪：' + v };
					}
				},
				{
					name: '网络注册', cmd: 'AT+C5GREG?',
					judge: function (data) {
						var r = Parse.parseRegStat(String(data), '+C5GREG');
						if (!r) return { level: 'bad', text: '取不到注册状态' };
						if (r.stat === 1 || r.stat === 5) return { level: 'ok', text: r.statText };
						if (r.stat === 3) return { level: 'bad', text: '注册被拒绝 —— 看「网络设置 → 网络拒绝」' };
						return { level: 'warn', text: r.statText + '（还没注册上，先看信号与 SIM）' };
					}
				},
				{
					name: 'PDP 上下文激活', cmd: 'AT+CGACT?',
					judge: function (data) {
						var active = [];
						AtWs.extractATDataMultiline(String(data), '+CGACT').forEach(function (row) {
							var p = row.split(',');
							if (p[1] && p[1].trim() === '1' && Number(p[0]) > 0) active.push(Number(p[0]));
						});
						if (!active.length) return { level: 'bad', text: '没有任何已激活的 PDP 上下文（多为 APN 不对）' };
						return { level: 'ok', text: '已激活 CID ' + active.join(' / ') };
					}
				},
				{
					name: '拨号连接', cmd: 'AT^NDISSTATQRY?',
					judge: function (data) {
						var rows = AtWs.extractATDataMultiline(String(data), '^NDISSTATQRY');
						if (!rows.length) return { level: 'bad', text: '模组未返回连接状态' };
						var connected = [];
						rows.forEach(function (row) {
							var p = row.split(',');
							if (p.length >= 2 && p[1].trim() === '1') connected.push(p[0].trim());
						});
						if (!connected.length) return { level: 'bad', text: '未连接（stat=0）—— 拨号没起来或已断开' };
						return { level: 'ok', text: '已连接 CID ' + connected.join(' / ') };
					}
				},
				{
					name: '拿到 IP 地址', cmd: 'AT+CGPADDR',
					judge: function (data) {
						var list = (Parse.parseCgpaddr(String(data)) || [])
							.filter(function (a) { return a && a.address; });
						if (!list.length) return { level: 'bad', text: 'PDP 已激活但没拿到地址 —— 多为 APN 或运营商侧问题' };
						return {
							level: 'ok',
							text: list.map(function (a) { return a.address; }).join(' / ')
						};
					}
				},
				{
					name: '网关与 DNS', cmd: 'AT^DHCP?',
					judge: function (data) {
						var str = AtWs.extractATData(String(data), '^DHCP');
						if (!str) return { level: 'warn', text: '取不到 DHCP 下发的网关/DNS（不影响上网本身）' };
						var d = str.split(',');
						if (d.length < 6) return { level: 'warn', text: '返回字段不足，无法判断' };
						var gw = AtWs.hexToIP(d[2].trim());
						if (!gw || gw === '0.0.0.0') return { level: 'bad', text: '网关为空 —— 有地址但没有出口' };
						return { level: 'ok', text: '网关 ' + gw + ' · DNS ' + AtWs.hexToIP(d[4].trim()) };
					}
				}
			];
		}

		function buildCheckBlock() {
			var t = state.tools.check;
			var btn = Mt5700.ghostButton(t.busy ? '检查中…' : (t.steps ? '重新自检' : '开始自检'), runSelfCheck);
			var box = toolBlock('连通性自检', btn);
			if (!t.steps) {
				box.appendChild(E('p', { 'class': 'mt5700-hint' },
					'按 SIM → 注册 → PDP → 拨号 → 取址 → 网关 逐层查一遍，'
					+ '卡在哪一步就直接告诉你。只读查询，不改任何设置。'));
				return box;
			}
			/* 结论摘要插进标题行（与 ADC 同一写法），6 步明细**始终**铺开在下面 ——
			   原来做成「默认折叠 + 点按钮展开」，但结论只有一句「卡在第 N 步」，
			   不给明细等于没说清卡在哪、为什么，还得再点一次才看得到，
			   比一张固定表格多一道没有收益的交互。 */
			var failed = null;
			for (var i = 0; i < t.steps.length; i++) {
				if (t.steps[i].level === 'bad') { failed = t.steps[i]; break; }
			}
			var summaryText = failed
				? ('卡在第 ' + (t.steps.indexOf(failed) + 1) + ' 步：' + failed.name)
				: '六步全部通过';
			/* 用现成 badge 而不是 .mt5700-diag-summary：后者是给块级结论用的
			   （padding 12px + margin-bottom 12px），塞进标题行会把整行撑高。 */
			box.firstChild.insertBefore(
				Mt5700.badge(summaryText, failed ? 'danger' : 'success'), btn);
			box.appendChild(Mt5700.table(['步骤', '结果', '说明'],
				t.steps.map(function (s) {
					return [
						s.name,
						E('b', { 'class': 'mt5700-diag-verdict is-' + (s.level || 'ok') },
							s.level === 'ok' ? '通过' : (s.level === 'warn' ? '存疑' : '未通过')),
						s.text
					];
				}), { striped: true }));
			return box;
		}

		function runSelfCheck() {
			var t = state.tools.check;
			if (t.busy) return;
			t.busy = true; t.steps = [];
			renderTools();
			var steps = checkSteps();
			var chain = Promise.resolve();
			steps.forEach(function (s) {
				chain = chain.then(function () {
					if (disposed) return;
					/* 已经卡在某一步就没必要继续往下查了 */
					for (var i = 0; i < t.steps.length; i++) {
						if (t.steps[i].level === 'bad') return;
					}
					return AtWs.client.sendCommand(s.cmd).then(function (res) {
						var data = (res && res.success) ? String(res.data || '') : '';
						var r = s.judge(data) || {};
						t.steps.push({
							name: s.name,
							level: r.level || 'warn',
							text: r.text || '（无法判断）'
						});
					}).catch(function (e) {
						t.steps.push({
							name: s.name, level: 'bad',
							text: '查询失败：' + ((e && e.message) || '模组无响应')
						});
					}).then(renderTools);
				});
			});
			return chain.then(function () {
				t.busy = false; t.at = Date.now();
				if (!disposed) renderTools();
			});
		}

		/*
		 * ③ 流量统计清零（手册 16.11 ^DSFLOWCLR）
		 * 入口挂在「速率与流量」卡头的「实时监测」开关后面（见下方 rateExtra 填充处），
		 * 不占独立卡片：它是个动作按钮，和同一张卡的流量数字放在一起才顺手。
		 * ★ 不可逆操作，必须走 Mt5700.confirm 二次确认。
		 */

		function clearFlowStats() {
			Mt5700.confirm('清零流量统计？本次与累计的流量、连接时长都会归零，且无法恢复。'
				+ '只清统计计数器、不会断网（手册 16.11 ^DSFLOWCLR）。'
				+ '适合核对套餐周期，或测某个应用耗了多少流量。', function () {
				return AtWs.client.sendCommand('AT^DSFLOWCLR').then(function (res) {
					if (!res || !res.success) {
						Mt5700.error('清零失败：' + ((res && res.error) || '模组未响应'));
						return;
					}
					Mt5700.success('已清零');
					/* 峰值是「本轮实时监测」的极值，计数既然归零，峰值也该跟着归零，
					   否则界面会同时出现「累计流量 0」和「峰值下行 300 Mbps」这种
					   自相矛盾的画面。速率曲线（history）不跟着清 —— 它是速率维度
					   的连续采样，清了只会让图空一大段，没有额外信息量。 */
					state.peakDown = 0;
					state.peakUp = 0;
					/* ★ 成功与失败都要重绘：
					   失败时把 state.flow 置空，让格子显示成「—」——
					   计数其实已经归零了，只是没读回来；若照旧显示旧数字，
					   用户会以为「没清成功」，那是比直接报错更糟的误读。 */
					return getFlow().then(renderFlow, function () {
						state.flow = {};
						renderFlow();
					});
				});
			}, '确认清零');
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

		/* ---------- 连接明细（连接诊断 + 地址与 DNS，两张表合并） ----------
		 *
		 * 三张表的行本来都是「项目 → 值」，拆开只是多出两行表头、把同类信息切三刀。
		 * 合并后按分组标题行分隔，并砍掉两列：
		 *   - CID  ：PDP 上下文编号（本机 1=IPv4、5=IPv6），用户无从干预；
		 *   - 来源 ：AT+CGPADDR 与 AT^DHCP? 给的是**同一个地址**，标了来源反而
		 *            让人以为有两份地址（2026-09-18 实测两者完全相同）。
		 */

		function buildDiagRows() {
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
			return rows;
		}

		/* 地址去重：三个来源会给**同一个地址**：
		 *   ① AT+CGPADDR  PDP 上下文地址（CID 1 → IPv4，CID 5 → IPv6）
		 *   ② AT^DHCP?    运营商 DHCP 下发的 IPv4（本机与 CID 1 完全相同）
		 *   ③ AT^DHCPV6?  IPv6 地址/前缀（本机该命令直接 ERROR，取不到）
		 * 按（类型 + 地址）做键合并，一行只留一个地址。 */
		function addrKey(family, addr) {
			var v = String(addr == null ? '' : addr).trim().toLowerCase();
			return v ? (family + '|' + v) : '';
		}

		function buildAddrList() {
			var map = {};
			var order = [];
			function add(addr, family, cid) {
				var key = addrKey(family, addr);
				if (!key) return;
				var e = map[key];
				if (!e) {
					e = map[key] = { address: String(addr).trim(), family: family, cids: [] };
					order.push(e);
				}
				if (cid != null && e.cids.indexOf(cid) < 0) e.cids.push(cid);
			}
			(state.diag.addrs || []).forEach(function (a) { add(a.address, a.family, a.cid); });
			if (state.dhcpv4 && state.dhcpv4.ipv4Address) add(state.dhcpv4.ipv4Address, 'IPv4', null);
			if (state.dhcpv6 && state.dhcpv6.ipv6Address) add(state.dhcpv6.ipv6Address, 'IPv6', null);

			order.sort(function (a, b) {
				if (a.family !== b.family) return a.family === 'IPv4' ? -1 : 1;
				var ac = a.cids.length ? a.cids[0] : 99;
				var bc = b.cids.length ? b.cids[0] : 99;
				return ac - bc;
			});
			return order;
		}

		function buildAddrRows() {
			return buildAddrList().map(function (e) {
				/* 类型并进项目名（「IPv4 地址」），不再单独占一列 */
				return [e.family + ' 地址', e.address];
			});
		}

		function buildDhcpRows() {
			var rows = [];
			var v4 = state.dhcpv4, v6 = state.dhcpv6;
			if (v4) {
				/* IPv4/IPv6 地址本身不在这里重复：已并进上方「地址」分组 */
				rows.push(['子网掩码', v4.subnetMask]);
				rows.push(['网关', v4.gateway]);
				rows.push(['DHCP 服务器', v4.dhcpServer]);
				rows.push(['主 DNS', dnsCell(0, v4.primaryDNS)]);
				rows.push(['备 DNS', dnsCell(1, v4.secondaryDNS)]);
			}
			if (v6) {
				rows.push(['IPv6 前缀', v6.netmask]);
				rows.push(['IPv6 网关', v6.gateway]);
				rows.push(['IPv6 DNS', v6.primaryDNS + ' / ' + v6.secondaryDNS]);
			}
			if (state.ipv6Cap) rows.push(['IPv6 支持', state.ipv6Cap.description]);
			return rows;
		}

		function renderConnDetail() {
			if (!connDetailBox) return;
			connDetailBox.innerHTML = '';
			var rows = [];
			function pushGroup(title, list) {
				if (!list.length) return;   /* 整组没数据就别留一个空标题 */
				rows.push({ group: title });
				list.forEach(function (r) { rows.push(r); });
			}
			pushGroup('连接诊断', buildDiagRows());
			pushGroup('地址与 DNS', buildAddrRows().concat(buildDhcpRows()));
			if (!rows.length) {
				connDetailBox.appendChild(E('div', { 'class': 'mt5700-hint' }, '暂无连接明细数据。'));
				return;
			}
			connDetailBox.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
			if (dnsEditable) {
				connDetailBox.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'点击「主 DNS / 备 DNS」可修改，写入 network.' + netIface +
					'.dns 并重新连接网络（短暂断网）；两项都留空即恢复运营商下发的 DNS。'));
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

		/*
		 * ★ 图表宽度缓存（性能）：
		 *   renderChart() 每秒被 renderSpeed() 调一次。原实现是
		 *   `chart.innerHTML = ''` 之后立刻读 `chart.clientWidth` —— 按 MDN 对
		 *   「强制同步布局（forced synchronous layout / layout thrashing）」的说明，
		 *   读取 clientWidth 这类布局属性会迫使浏览器**立刻**完成挂起的样式重算与布局，
		 *   而上一行刚把子树作废。于是每秒都在「作废布局 → 马上算回来」，是教科书式的
		 *   反向优化；1Hz 下它还会和页面其它重绘抢主线程。
		 *   失效源用 ResizeObserver 而不是 window.resize：容器宽度还会因为
		 *   垂直滚动条出现/消失、断点切换、侧栏折叠而变化，这些**不一定**派发
		 *   window resize（只认 resize 等于把「宽度只随窗口变化」当成了既定事实）。
		 *   不支持 RO 的老浏览器退回 resize，功能不打折。
		 */
		var chartWidth = 0;
		var chartRO = null;
		var onResize = function () { chartWidth = 0; };
		if (typeof ResizeObserver === 'function') {
			chartRO = new ResizeObserver(onResize);
			chartRO.observe(chart);
		} else {
			window.addEventListener('resize', onResize);
		}

		function renderChart() {
			/* 不可见时不做重建：切后台那一刻在飞的 netRate 回来后仍会走到这里，
			   在看不见的页面里做一次完整子树重建纯属浪费。 */
			if (document.hidden) return;
			chart.innerHTML = '';
			if (!history.length) {
				chart.appendChild(Mt5700.empty('等待数据…'));
				return;
			}
			/* 只在缓存未命中时读一次布局属性。还没上屏时 clientWidth 为 0，
			   此时**不缓存**（免得把兜底的 600 当成真实宽度记住），
			   上屏后由 RO 的首次回调让它失效、下一拍重新量准。 */
			if (!chartWidth) {
				var measured = chart.clientWidth;
				if (measured) chartWidth = measured;
			}
			chart.appendChild(Mt5700.lineChart(history, {
				width: chartWidth || 600,
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
			var f = state.flow || {};
			/* 取不到时统一显示「—」而不是「NaN」：
			   清零成功后若重读失败，state.flow 会被置空，此时若照旧渲染旧数字，
			   用户会以为「没清成功」—— 那才是误报。
			   （AtWs.formatFlow(undefined) 会算出 "NaN TB"，所以必须在这一层挡掉。） */
			function durText(v, showDays) { return v == null ? '—' : AtWs.formatDuration(v, showDays); }
			function flowText(v) { return v == null ? '—' : AtWs.formatFlow(v); }
			/* 峰值是「本轮实时监测」内的最大值（关掉监测再开即归零），
			   单位与 rtDown/rtUp、state.peakDown/peakUp 一致（字节/秒），显示同样走 splitSpeedUI。 */
			function peakText(bps) {
				if (!bps) return '—';
				var s = splitSpeedUI(bps, 'bytes');
				return s.value + ' ' + s.unit;
			}
			[
				{ label: '当前会话时长', value: durText(f.lastDsTime, false) },
				{ label: '当前下行流量', value: flowText(f.lastRxFlow) },
				{ label: '当前上行流量', value: flowText(f.lastTxFlow) },
				{ label: '累计时长', value: durText(f.totalDsTime, true) },
				{ label: '累计下行', value: flowText(f.totalRxFlow) },
				{ label: '累计上行', value: flowText(f.totalTxFlow) },
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

		/* ---------- 自定义 DNS（UCI network.<iface>.dns） ----------
		 *
		 * ★ 必须先分清两个「DNS」来源，否则改完会发现界面没变化：
		 *   ① 表格里的「主/备 DNS」原本来自 AT^DHCP? —— 那是**运营商通过 DHCP 下发的**，
		 *      模组自己报的，改 UCI 不会让它变。
		 *   ② 真正能改的是 UCI 里 network.<iface>.dns 的静态项，由 netifd 写入
		 *      /tmp/resolv.conf.d/resolv.conf.auto，优先级高于运营商下发的。
		 *   所以显示值取「自定义 ?? 运营商下发」，改完显示立刻跟着自定义项走。
		 *
		 * 接口名不写死：取 at-webserver.config.watch_iface（与「服务配置」页同一个），
		 * 拿不到才回退 MT5700M。
		 *
		 * 权限：rpcd ACL 的 uci 读写白名单必须含 network，否则 L.uci.load 会被拒。
		 * 被拒时这里**静默降级为只读**（dnsEditable=false），页面其余部分照常工作 ——
		 * 老版本 ACL 的机器上不会出现报错或空白。
		 */
		var netIface = 'MT5700M';
		var dnsCustom = [];      /* UCI 已配置的自定义 DNS：[主, 备] */
		var dnsEditable = false; /* ACL 允许写 network 才为 true */

		function isIPv4(v) {
			var p = String(v).trim().split('.');
			if (p.length !== 4) return false;
			for (var i = 0; i < 4; i++) {
				if (!/^\d{1,3}$/.test(p[i])) return false;
				var n = parseInt(p[i], 10);
				if (isNaN(n) || n < 0 || n > 255) return false;
			}
			return true;
		}

		function loadDnsConfig() {
			if (!L.uci || !L.uci.load) return Promise.resolve();
			return L.uci.load('network').then(function () {
				/* at-webserver 只用来取接口名，失败也不影响主流程 */
				return L.uci.load('at-webserver').catch(function () { });
			}).then(function () {
				var iface = L.uci.get('at-webserver', 'config', 'watch_iface');
				if (iface) netIface = String(iface).trim() || netIface;
				var dns = L.uci.get('network', netIface, 'dns');
				dnsCustom = Array.isArray(dns) ? dns.slice(0, 2)
					: (dns ? String(dns).split(/\s+/).filter(Boolean).slice(0, 2) : []);
				dnsEditable = true;
			}).catch(function () {
				dnsEditable = false;
				dnsCustom = [];
			});
		}

		/* 保存自定义 DNS：写 UCI → save → apply。
		 * apply 会触发 netifd reload，接口重新协商（**短暂断网**），
		 * 所以按钮文案直接写明「会重连」，不另加确认弹窗（用户偏好少拦一层）。
		 * 两项都清空 = 删掉 dns 项并把 peerdns 还原成 1，彻底交回运营商下发。 */
		function saveDns(list) {
			var cfg = 'network', sec = netIface;
			if (list.length) {
				L.uci.set(cfg, sec, 'dns', list);
				/* peerdns=0：只认用户填的，避免「主/备」语义被下发的 DNS 冲淡 */
				L.uci.set(cfg, sec, 'peerdns', '0');
			} else {
				if (L.uci.unset) L.uci.unset(cfg, sec, 'dns');
				else L.uci.set(cfg, sec, 'dns', '');
				L.uci.set(cfg, sec, 'peerdns', '1');
			}
			AtWs.uci.markDirty();
			return AtWs.uci.uciSave('network').then(function () {
				dnsCustom = list;
				AtWs.uci.clearDirty();
				Mt5700.info('已保存并应用，网络正在重连');
			}, function (err) {
				AtWs.uci.clearDirty();
				Mt5700.error('保存失败：' + ((err && err.message) || '未知错误'));
				throw err;
			});
		}

		/* 单元格：常态显示值（自定义优先）＋「自定义」徽章；可编辑时点击变输入框 */
		function dnsCell(idx, peerValue) {
			var custom = dnsCustom[idx] || '';
			var wrap = E('span', { 'class': 'mt5700-dns-cell' });
			wrap.appendChild(E('span', { 'class': 'mt5700-dns-value' }, custom || peerValue || '—'));
			if (custom) wrap.appendChild(Mt5700.badge('自定义', 'primary'));
			if (!dnsEditable) return wrap;   /* 老版本 ACL：只读，不给点击假象 */
			wrap.classList.add('is-editable');
			wrap.title = '点击修改（保存会重新连接网络）';
			wrap.addEventListener('click', function () {
				startDnsEdit(wrap, idx, custom || '');
			});
			return wrap;
		}

		function startDnsEdit(cell, idx, current) {
			var form = E('span', { 'class': 'mt5700-dns-edit' });
			var input = Mt5700.input('text', current);
			input.value = current;
			input.setAttribute('placeholder', '留空=恢复自动');
			input.style.width = '132px';

			var finish = function () { renderConnDetail(); };
			var commit = function () {
				var v = input.value.trim();
				if (v && !isIPv4(v)) {
					Mt5700.error('请填 IPv4 地址，例如 223.5.5.5（留空表示恢复运营商下发）');
					return;
				}
				var next = dnsCustom.slice();
				next[idx] = v;
				var list = next.filter(Boolean);   /* 主空备非空时，备自动前提 */
				input.disabled = true;
				saveDns(list).then(finish, finish);
			};

			input.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
				else if (ev.key === 'Escape') { ev.preventDefault(); finish(); }
			});
			form.appendChild(input);
			form.appendChild(Mt5700.primaryButton('保存并应用', commit));
			form.appendChild(Mt5700.ghostButton('取消', finish));
			cell.parentNode.replaceChild(form, cell);
			input.focus();
			input.select();
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
			/* ★ attempts: 1 —— 实测（2026-09-18，走 8765 与前端同一通道）23 条只读命令里
			   AT^DHCPV6? 是**唯一恒定失败**的一条（本机本来就没有 IPv6），
			   其余 22 条全部 OK。它是「确定性失败」而不是「偶发 ERROR」，
			   默认 3 次重试 + 200/400ms 退避纯属白跑：每轮慢档刷新要多吃约 1.5s 串口时间，
			   而且这条命令排在链里，会把它后面所有读数一起推后。
			   降到 1 次不改变任何界面语义 —— 失败仍由 slowFailures 静默兜住；
			   将来真开通 IPv6 时，1 次尝试照样能成功（成功路径本来就不依赖重试）。 */
			return AtWs.client.sendCommand('AT^DHCPV6?', { attempts: 1 }).then(function (v6) {
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
				/* 地址表吃 dhcpv4/dhcpv6，DHCP 拿到新值后要跟着重绘（它与 PDP 地址去重合并） */
			}).then(function () {
				renderConnDetail();
			});
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
				renderConnDetail();
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

		/* 「实时监测」开关：关闭即停表（不再每秒读接口计数器），重开时重新起基准。
		   ★ 页面在**后台标签页**里打开时（`document.hidden === true`，例如 Ctrl+点击
		   新标签页）不起表：看不见的时候每秒读一次网卡计数器是纯浪费，
		   回到前台由 onVisibility 补起 —— 那里同样会丢弃旧基准。 */
		function setRateEnabled(on) {
			rateOn = !!on;
			try { localStorage.setItem('mt5700.rateOn', rateOn ? '1' : '0'); } catch (e) {}
			if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
			if (rateOn && !document.hidden) {
				rateSample = null;
				/* 重新开始一段监测：峰值随之归零，否则上一轮的尖峰会一直挂着 */
				state.peakDown = 0;
				state.peakUp = 0;
				rateTimer = setInterval(sampleRate, 1000);
				sampleRate();
			}
			renderSpeed();
		}

		var rateChk = E('input', { 'type': 'checkbox' });
		rateChk.addEventListener('change', function () { setRateEnabled(rateChk.checked); });
		/* ★ E(tag, attrs, text) 只挂载第 3 个参数，第 4 个起会被**静默丢弃**
		   （它是全站共用 helper，改成变参影响面太大，footgun 已记在
		   FRONTEND_REVIEW_REPORT.md）。所以 label 必须分两步建 ——
		   原来写成 E('label', {}, rateChk, document.createTextNode(' 实时监测'))，
		   「实时监测」这四个字从来就没显示过，只剩一个光秃秃的勾选框。 */
		var rateLabel = E('label', {}, rateChk);
		rateLabel.appendChild(document.createTextNode(' 实时监测'));
		/* 流量清零归位到这张卡：它清的就是本卡的流量统计，与速率/流量同一问题域，
		   放在「连接工具」里要跨卡找。
		   ★ 容器用 .mt5700-toolbar（mt5700.css:2590）而不是 .at-autorefresh：
		   后者是 Ui.autoRefresh 的私有类（ui.js:347），自带 margin 6px/10px 与
		   硬编码 #555（无深色变体），放进卡头会把这一排顶高、暗色下发灰；
		   而且它没有 flex-wrap，窄屏两个子元素不换行而是直接溢出。
		   .mt5700-toolbar 是 flex + gap + wrap，且「网络设置」页已在用它做卡头
		   工具条（mt5700.css:2742 的注释承认该用法）—— 零新增样式。 */
		var flowClearBtn = Mt5700.dangerButton('清零流量', clearFlowStats);
		flowClearBtn.title = '把本次与累计流量、连接时长全部归零（AT^DSFLOWCLR，手册 16.11）';
		var rateBar = E('div', { 'class': 'mt5700-toolbar' });
		rateBar.appendChild(rateLabel);
		rateBar.appendChild(flowClearBtn);
		rateExtra.appendChild(rateBar);

		/*
		 * 1Hz 采样，但一次 netRate 往返可能长得多（它的超时是 5s）。
		 * 没有在飞守卫就会多个采样重叠：后一次覆盖 rateSample 之后，先回来的那次
		 * 拿新基准配自己的旧时刻，dt 与字节差不是同一段区间 —— 速率曲线出现
		 * 尖刺，甚至因为差分为负而被抹成 0。重叠期间直接跳过即可，
		 * 下一拍（1 秒后）自然会用最新基准继续，不会丢数据。
		 */
		var rateInFlight = false;
		function sampleRate() {
			/* 不可见时不采样：定时器已停，这里挡的是「切后台瞬间在飞的那一次」。 */
			if (document.hidden) return Promise.resolve();
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
			if (document.hidden) {
				/* ★ 1Hz 的速率采样也要停：页面看不见时每秒读一次接口计数器是纯浪费，
				   而它又是唯一不受 resetTimers 管辖的定时器。 */
				if (rateTimer) { clearInterval(rateTimer); rateTimer = null; }
				resetTimers(false);
				return;
			}
			resetTimers(ar.isEnabled(), ar.getInterval());
			refreshAll();
			if (rateOn && !rateTimer) {
				/* ★ 显式的语义决定：1Hz 速率采样只受「实时监测」开关管辖，
				   不受「自动刷新」开关约束 —— 前者是这张卡自己的开关（用户勾了
				   就是要看实时曲线），后者管的是读数类轮询。且它走的是 ubus
				   netrate（读接口计数器），**不占 AT 串口**，与红线里的
				   「AT 通道独占」不是一回事，所以不跟着 ar.isEnabled() 一起停。 */
				/* ★ 回到前台必须丢弃旧基准：否则 dt 等于整段隐藏时长，
				   字节差除以一个巨大的 dt 会落出一个被摊薄的假谷值，
				   还会污染峰值判定（峰值只升不降，假谷值虽不抬峰值，
				   但曲线上会留一段平躺的怪台阶）。 */
				rateSample = null;
				rateTimer = setInterval(sampleRate, 1000);
				sampleRate();
			}
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
		renderConnDetail();    /* 连接明细：诊断 + 地址与 DNS（一张表） */
		renderTools();   /* 连接工具（右列独立卡片） */
		renderSpeed();
		renderFlow();
		renderTemp();
		renderMCS();

		/* 自定义 DNS 是 UCI 侧的静态配置，跟 AT 无关，单独加载；
		   拿到后重绘一次，让「主/备 DNS」显示成自定义值并带上「自定义」徽章。
		   ACL 不含 network 时静默降级为只读，不影响上面任何渲染。 */
		loadDnsConfig().then(renderConnDetail);

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
			/* ADC 自动读一次：结果直接铺在「连接工具」里，不必先点按钮。
			   5 条只读查询、失败即停，不会在模组里留下任何状态（安全底线的例外批准项）。
			   ★ 自检排在 ADC 之后**串行**跑，不并发：两者都是只读查询，同时发起会让
			   11 条命令一起挤在 AT 通道上排队。串行后总体耗时略长，但不会放大排队。 */
			readAdcPins().then(runSelfCheck).catch(function () { /* 两条链内部都已各自兜错 */ });
		});

		self._dispose = function () {
			/* 离开页面必须清干净：三个定时器 + 可见性监听 + 只读缓存，
			   否则反复进出会叠加倍轮询。
			   disposed 同时让已发起的「ADC → 自检」链尽快停下（见其声明处注释）。
			   （本页已无任何常驻上报开关，不需要再做「关不掉就报警」的收尾） */
			disposed = true;
			if (timer) clearInterval(timer);
			if (slowTimer) clearInterval(slowTimer);
			if (rateTimer) clearInterval(rateTimer);
			timer = slowTimer = rateTimer = null;
			if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
			if (chartRO) { chartRO.disconnect(); chartRO = null; }
			else if (onResize) { window.removeEventListener('resize', onResize); }
			onResize = null;
			if (AtWs.client && AtWs.client.clearReadCache) AtWs.client.clearReadCache();
		};
		page._onDispose(self._dispose);

		return page;
	}
});
