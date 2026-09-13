'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

/**
 * 服务配置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 合并旧版 LuCI config.js 的全部功能 + 新增项：
 * - connection_type / network_host / network_port / serial_port / baud_rate
 * - websocket_host / websocket_port / websocket_auth_key
 * - 通知开关：notify_*（来电/短信/信号/内存满/WebHook URL 与企业微信）
 * - 保存后通过 ubus 重载服务（等价 /etc/init.d/at-webserver reload）
 *
 * 状态判定说明（修复「未运行」误报）：
 * procd 的 service.list 只反映「已注册实例」，当 init 脚本缺失（例如被 overlay
 * 白化）或服务从未被拉起时，它返回的是空对象——这与「服务配置为禁用」在界面上
 * 无法区分，且不给出任何原因。本页改为多源交叉判定：
 *   1) 已注册实例的 running/pid（procd 权威状态）
 *   2) 二进制是否存在且可执行（file.stat）
 *   3) 配置是否启用（UCI enabled）
 *   4) 监听端口是否有进程在听（间接佐证，避免仅凭配置误判）
 * 并区分「运行中」/「已停止」/「未注册」/「未安装」/「已禁用」五种语义，
 * 给出对应的修复建议。
 */

var SERVICE = 'at-webserver';
var BINARY = '/usr/bin/at-webserver-rust';

/**
 * 由多源状态推导服务状态标签、颜色与原因提示。
 * 优先级：运行中 > 本次已停止 > 已禁用 > 未安装 > 未注册 > 已停止
 */
function resolveStatus(state) {
	var running = !!state.running;
	var registered = !!state.registered;
	var binExists = !!state.binExists;
	var enabled = state.enabled === '1';

	if (running) {
		return { label: '运行中', variant: 'success', pid: state.pid || null, hint: '' };
	}
	/*
	 * 用户刚点过「停止服务」。
	 * 必须排在其他分支之前：init 脚本 stop 后 procd 会注销实例，registered 变成
	 * false，若按常规判定会落到「未注册」，并把「init 脚本缺失/被 overlay 覆盖」
	 * 这个错误原因甩给用户——而实际只是他刚亲手停掉的。
	 */
	if (state.userStopped) {
		return {
			label: '已停止', variant: 'neutral', pid: null,
			hint: '服务由你在本页手动停止，所有 AT 功能（状态、短信、网络信息）当前不可用。' +
				'需要恢复请点击右上角「重载服务」。'
		};
	}
	if (!enabled) {
		return {
			label: '已禁用', variant: 'neutral', pid: null,
			hint: '配置中 enabled=0，服务被刻意关闭。需要启动请在下方勾选后保存，或执行 uci set at-webserver.config.enabled=1。'
		};
	}
	if (!binExists) {
		return {
			label: '未安装', variant: 'danger', pid: null,
			hint: '未找到可执行文件 ' + BINARY + '，后端可能未安装或安装不完整。请重新安装 luci-app-mt5700。'
		};
	}
	if (!state.binExec) {
		return {
			label: '不可执行', variant: 'danger', pid: null,
			hint: BINARY + ' 缺少可执行权限。请执行 chmod 0755 ' + BINARY + ' 后重试。'
		};
	}
	if (!registered) {
		return {
			label: '未注册', variant: 'warning', pid: null,
			hint: '进程未运行，且 procd 中不存在 at-webserver 实例——通常是 /etc/init.d/at-webserver ' +
				'缺失或被 overlay 覆盖（例如存在白化字符设备），导致服务从未被拉起。' +
				'请检查该脚本是否存在，然后点击「重载服务」或执行 /etc/init.d/at-webserver start。'
		};
	}
	return {
		label: '已停止', variant: 'danger', pid: null,
		hint: '实例已在 procd 注册但进程未运行，可能启动失败或被反复重启。请查看系统日志（logread -e at-webserver）后重载服务。'
	};
}

return L.view.extend({
	load: function () {
		var listSerial = L.rpc.declare({
			object: 'file',
			method: 'list',
			params: ['path'],
			expect: { entries: [] }
		});
		var statBinary = L.rpc.declare({
			object: 'file',
			method: 'stat',
			params: ['path'],
			expect: {}
		});
		var serviceList = L.rpc.declare({
			object: 'service',
			method: 'list',
			params: ['name'],
			expect: { '': {} }
		});
		return Promise.all([
			L.uci.load(SERVICE),
			serviceList(SERVICE).catch(function () { return {}; }),
			listSerial('/dev').catch(function () { return { entries: [] }; }),
			statBinary(BINARY).catch(function () { return null; })
		]).then(function (res) {
			var raw = res[2];
			var entries = [];
			if (Array.isArray(raw)) {
				entries = raw;
			} else if (raw && Array.isArray(raw.entries)) {
				entries = raw.entries;
			} else if (raw && typeof raw === 'object') {
				// 某些 rpcd 返回 { name: type } 映射
				Object.keys(raw).forEach(function (k) {
					var v = raw[k];
					if (v && typeof v === 'object') {
						entries.push(Object.assign({ name: k }, v));
					} else {
						entries.push({ name: k, type: String(v || '') });
					}
				});
			}
			var serials = [];
			entries.forEach(function (e) {
				var name = e && (e.name || e.path || '');
				if (!name) return;
				name = String(name).replace(/^\/dev\//, '');
				if (/^(ttyUSB|ttyACM|ttyAMA|ttyS)\d+/.test(name)) {
					serials.push('/dev/' + name);
				}
			});
			serials = serials.filter(function (p, i, a) { return a.indexOf(p) === i; });
			serials.sort();

			/* ---------- 服务状态多源判定 ---------- */
			var svc = (res[1] && res[1][SERVICE]) || {};
			var registered = !!(res[1] && res[1][SERVICE]);
			var found = false;
			var pid = null;
			if (svc.instances) {
				Object.keys(svc.instances).forEach(function (k) {
					var it = svc.instances[k] || {};
					if (it.running || it.pid) {
						found = true;
						if (!pid && it.pid) pid = it.pid;
					}
				});
			}
			if (!found && (svc.running || svc.pid)) {
				found = true;
				pid = svc.pid || null;
			}

			var st = res[3];
			// rpcd file.stat 返回 {type:'file', mode:0755, ...}；失败时返回 null
			var binExists = !!(st && (st.type || st.mode !== undefined));
			var binExec = binExists && !!(st.mode & parseInt('0111', 8));

			var enabled = L.uci.get(SERVICE, 'config', 'enabled');
			enabled = enabled === null || enabled === undefined ? '1' : String(enabled);

			return {
				service: svc,
				running: found,
				registered: registered,
				pid: pid,
				binExists: binExists,
				binExec: binExec,
				enabled: enabled,
				serials: serials
			};
		});
	},

	render: function (data) {
		var self = this;
		var page = Mt5700.page('服务配置', 'AT 服务与通知设置（保存后自动重载）');
		var body = page._body;

		/* 顶部 AT 服务状态卡（与其余页面一致） */
		var connBar = E('div');
		Mt5700.renderConnectionBar(connBar);
		body.appendChild(connBar);

		var state = data || {};

		/* ---------- 服务状态判定（五态） ---------- */
		var status = resolveStatus(state);

		/* 服务操作按钮归位到卡片头部 */
		var reloadBtn = Mt5700.button('重载服务', function () { reloadService(); }, 'primary');
		var restartBtn = Mt5700.button('重启服务', function () { restartService(); }, 'primary');
		var stopBtn = Mt5700.button('停止服务', function () { stopService(); }, 'danger');
		var actions = Mt5700.panelActions(reloadBtn, restartBtn, stopBtn);

		var statusCard = Mt5700.card('服务状态', '后端进程、监听端口与安装状态', actions);
		var statusBody = E('div');
		statusCard._body.appendChild(statusBody);
		body.appendChild(statusCard);

		var statusRow = E('div', { 'class': 'mt5700-inline' });
		statusBody.appendChild(statusRow);

		// 非「运行中」时给出可读的原因与建议，避免只有一个红色标签。
		// 提示节点常驻并由 renderStatus 统一更新：状态变化后（停止/重载）文案要跟着变，
		// 否则会停留在上一次的旧原因上。
		var statusHint = E('div', { 'class': 'mt5700-hint' });
		statusHint.style.display = 'none';
		statusBody.appendChild(statusHint);

		function renderStatus(st) {
			statusRow.innerHTML = '';
			statusRow.appendChild(Mt5700.badge(st.label, st.variant));
			if (st.pid) statusRow.appendChild(Mt5700.badge('PID ' + st.pid, 'neutral'));
			statusHint.textContent = st.hint || '';
			statusHint.style.display = st.hint ? '' : 'none';
			// 只在真的跑着的时候才允许点「停止服务」
			stopBtn.disabled = !state.running;
		}
		renderStatus(status);

		/* ---------- 连接配置 ---------- */
		var connCard = Mt5700.card('调制解调器连接', '后端连接模组的通道');
		var connBody = E('div');
		connCard._body.appendChild(connBody);
		body.appendChild(connCard);

		var connTypeSel = Mt5700.select([
			{ label: 'PCUI 串口（默认，优先 /dev/ttyUSB1）', value: 'SERIAL' },
			{ label: '网络连接（TCP，备用）', value: 'NETWORK' }
		], 'SERIAL');
		connBody.appendChild(Mt5700.formGroup('连接类型', connTypeSel));

		var hostInput = Mt5700.input('text', '192.168.8.1', '');
		connBody.appendChild(Mt5700.formGroup('网络主机', hostInput));

		var netPortInput = Mt5700.input('number', '20249', '');
		netPortInput.min = 1;
		netPortInput.max = 65535;
		connBody.appendChild(Mt5700.formGroup('网络端口', netPortInput, '模组 TCP 端口，默认 20249'));

		/* 串口：下拉 + 自定义；选项来自系统 /dev 识别结果 */
		var serialSel = Mt5700.select([], '');
		function fillSerialOptions(current) {
			while (serialSel.firstChild) serialSel.removeChild(serialSel.firstChild);
			function add(v, label) {
				var o = E('option', { value: v }, label || v);
				serialSel.appendChild(o);
			}
			add('auto', '自动探测（优先 /dev/ttyUSB1 PCUI）');
			(state.serials || []).forEach(function (p) {
				var hint = p === '/dev/ttyUSB1' ? '（PCUI 推荐）' : '';
				add(p, p + hint);
			});
			add('__custom__', '自定义路径…');
			if (current) {
				var exists = false;
				for (var i = 0; i < serialSel.options.length; i++) {
					if (serialSel.options[i].value === current) { exists = true; break; }
				}
				if (!exists && current !== '__custom__') {
					add(current, current + '（当前配置）');
				}
				serialSel.value = current;
			}
		}
		var serialCustom = Mt5700.input('text', '例如 /dev/ttyUSB2', '');
		serialCustom.style.display = 'none';
		serialSel.addEventListener('change', function () {
			serialCustom.style.display = serialSel.value === '__custom__' ? '' : 'none';
		});
		connBody.appendChild(Mt5700.formGroup('串口设备', serialSel, '列出系统已识别的 ttyUSB/ttyACM/ttyS 设备'));
		connBody.appendChild(Mt5700.formGroup('自定义串口路径', serialCustom, '仅在选择「自定义路径」时生效'));

		var baudInput = Mt5700.input('number', '115200', '');
		connBody.appendChild(Mt5700.formGroup('波特率', baudInput));

		/* ---------- RPC 服务 ---------- */
		var wsCard = Mt5700.card('RPC 服务', 'LuCI 经 rpcd/ucode 代理连接后端使用的端口、监听范围与密钥');
		var wsBody = E('div');
		wsCard._body.appendChild(wsBody);
		body.appendChild(wsCard);

		/* 监听地址已移除：与下方「监听范围」功能重叠（RPC 只会是 127.0.0.1 或 0.0.0.0） */
		var wsPortInput = Mt5700.input('number', '8765', '');
		wsPortInput.min = 1;
		wsPortInput.max = 65535;
		wsBody.appendChild(Mt5700.formGroup('RPC 端口', wsPortInput, '默认 8765'));

		var wsBindSel = Mt5700.select([
			{ label: '仅本机（127.0.0.1，经 rpcd 代理）', value: '127.0.0.1' },
			{ label: '所有接口（0.0.0.0，可被外部访问）', value: '0.0.0.0' }
		], '127.0.0.1');
		wsBody.appendChild(Mt5700.formGroup('RPC 监听范围', wsBindSel, '对外监听时请务必设置认证密钥'));

		var phoneNoteInput = Mt5700.input('text', '例如 13800138000', '');
		wsBody.appendChild(Mt5700.formGroup('本机号码备注', phoneNoteInput,
			'SIM 卡未写入 MSISDN 时（AT+CNUM 返回 not found），用于「网络状态 / 设备信息」显示'));

		var authKeyInput = Mt5700.input('text', '留空表示无需认证', '');
		wsBody.appendChild(Mt5700.formGroup('认证密钥', authKeyInput, 'ucode 代理自动附带该密钥；LuCI 登录态由 rpcd 会话保证'));

		/* ---------- 通知配置 ---------- */
		var notifCard = Mt5700.card('通知', '事件通知与 WebHook');
		var notifBody = E('div');
		notifCard._body.appendChild(notifBody);
		body.appendChild(notifCard);

		function mkCheck() {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			wrap.appendChild(input);
			return { wrap: wrap, input: input };
		}

		var notifyCalls = mkCheck();
		var notifySms = mkCheck();
		var notifySignal = mkCheck();
		var notifyMem = mkCheck();

		notifBody.appendChild(Mt5700.formGroup('来电通知', notifyCalls.wrap));
		notifBody.appendChild(Mt5700.formGroup('新短信通知', notifySms.wrap));
		notifBody.appendChild(Mt5700.formGroup('信号变化通知', notifySignal.wrap));
		notifBody.appendChild(Mt5700.formGroup('短信存储满通知', notifyMem.wrap));

		var webhookInput = Mt5700.input('text', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx', '');
		notifBody.appendChild(Mt5700.formGroup('企业微信 WebHook', webhookInput, '通知将推送到该 WebHook 地址'));

		/* ---------- 连接看门狗 ---------- */
		var wdCard = Mt5700.card('连接看门狗',
			'模组掉线或 DHCP 租约失效时自动续约，避免「路由能进但完全没网」');
		var wdBody = E('div');
		wdCard._body.appendChild(wdBody);
		body.appendChild(wdCard);

		var wdSwitch = E('div', { 'class': 'mt5700-switch' });
		var wdChk = E('input', { type: 'checkbox' });
		wdSwitch.appendChild(wdChk);
		wdBody.appendChild(Mt5700.formGroup('启用看门狗', wdSwitch,
			'默认开启。先看接口是否 up，再探测下方「默认网关」，异常时自动续约 DHCP，不会主动复位模组'));

		var wdIfaceInput = Mt5700.input('text', 'MT5700M');
		wdBody.appendChild(Mt5700.formGroup('监控接口', wdIfaceInput,
			'netifd 里的逻辑接口名，默认 MT5700M。改这里之后，复位命令里的接口名要一起改'));

		var wdDevInput = Mt5700.input('text', 'eth2');
		wdBody.appendChild(Mt5700.formGroup('网口设备', wdDevInput,
			'模组的 USB 网口，默认 eth2。用于推断默认网关与查邻居状态'));

		/* 连通性探测目标（界面名沿用用户习惯的「默认网关」）。 */
		var WATCH_GATEWAY_DEFAULT = '119.29.29.29';
		var wdGwInput = Mt5700.input('text', WATCH_GATEWAY_DEFAULT);
		wdBody.appendChild(Mt5700.formGroup('默认网关（探测目标）', wdGwInput,
			'默认 119.29.29.29 —— 腾讯 DNS / DNSPod。看门狗用 ICMP 探测它来判断「到底有没有网」，' +
			'这是最贴近实际上网体验的判据。刻意用 IP 不用域名：本机有过 DNS 劫持，' +
			'域名探测会被本地解析器误导。填 none 则不做 ICMP 探测，改为自动推断默认网关并查其邻居状态。'));

		var wdIntervalInput = Mt5700.input('number', '60', '');
		wdBody.appendChild(Mt5700.formGroup('检查间隔（秒）', wdIntervalInput, '下限 15 秒，默认 60'));

		var wdThresholdInput = Mt5700.input('number', '3', '');
		wdBody.appendChild(Mt5700.formGroup('连续异常阈值', wdThresholdInput,
			'连续异常达到该次数后才触发下方的复位动作'));

		var wdResetSwitch = E('div', { 'class': 'mt5700-switch' });
		var wdResetChk = E('input', { type: 'checkbox' });
		wdResetSwitch.appendChild(wdResetChk);
		wdBody.appendChild(Mt5700.formGroup('达阈值时执行复位', wdResetSwitch,
			'连续异常达到阈值后，按下方命令逐条下发（最后手段，会短暂断网）'));

		/* 复位命令：多行、自定义、按顺序执行。
		 * 两类命令**按行首自动分流**（与 watchdog.sh::is_at_cmd 同一口径）：
		 *   行首 AT / at → 经本机 RPC 下发给模组，并校验应答里的 success；
		 *   其余任意行   → 本机 shell 执行（带 30s 超时）。
		 * 默认值是纯 shell 的「重拉 MT5700M 接口」：ifdown → sleep 2 → ifup。
		 * 刻意没把 AT+CFUN=1,1 放进默认值——协议栈复位会让 eth2 数据面挂死，
		 * 本机实测的故障（USB 重枚举后 DHCP 租约失效）重拉接口就能恢复，不必动模组。 */
		var WATCH_RESET_CMDS_DEFAULT = 'ifdown MT5700M\nsleep 2\nifup MT5700M';
		var wdCmdsArea = E('textarea', { 'class': 'mt5700-input', 'rows': '4',
			'placeholder': 'ifdown MT5700M\nsleep 2\nifup MT5700M' });
		wdCmdsArea.style.width = '100%';
		wdCmdsArea.style.fontFamily = 'var(--mt5700-font-mono)';
		wdCmdsArea.style.minHeight = '84px';
		wdBody.appendChild(Mt5700.formGroup('复位命令（每行一条，按顺序执行）', wdCmdsArea,
			'行首是 AT / at 的行当 AT 指令下发给模组（ATE0、ATI、AT+CFUN=1,1、AT^HVSST=1,0…都算）；' +
			'其余行作为本机 shell 命令执行（ifdown MT5700M、sleep 2、ifup MT5700M）。' +
			'空行与 # 开头的行会被忽略，每条之间间隔 1 秒；' +
			'AT 指令会校验模组应答，回 ERROR 会被记进日志而不是当成成功。' +
			'注意 AT 复位会让数据面短暂中断，想加协议栈级兜底再补 AT+CFUN=1,1。'));

		wdBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'看门狗每轮都会重新读取配置，保存后最多一个检查间隔即生效，无需重启服务。' +
			'查看它的处置记录：SSH 执行 logread -e mt5700-watchdog，' +
			'或查看日志文件 /tmp/at-notifications.log 里带 [watchdog] 的行。'));

		/* ---------- SIM 卡状态自愈 ---------- */
		var simHealCard = Mt5700.card('SIM 卡状态自愈',
			'USB 网口模式下卡状态不是 12 时，自动用 HVSST 推一次');
		var simHealBody = E('div');
		simHealCard._body.appendChild(simHealBody);
		body.appendChild(simHealCard);

		var shSwitch = E('div', { 'class': 'mt5700-switch' });
		var shChk = E('input', { type: 'checkbox' });
		shSwitch.appendChild(shChk);
		simHealBody.appendChild(Mt5700.formGroup('启用 SIM 卡状态自愈', shSwitch,
			'默认开启。判定条件：AT^SETMODE? 为 4（USB 网口模式）且 AT^SIMSQ? 不是 12 —— ' +
			'本卡实测长期停在 1,11（网络可用，但短信与电话未接入）。' +
			'命中时按 AT^HVSST=1,0 → 等待 3 秒 → AT^HVSST=1,1 推一手。'));

		simHealBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'★ 每次开机最多执行一次：服务重启、模组反复重连都不会重跑，' +
			'只有设备重启（清空 /tmp 标记）后才重新获得一次机会；' +
			'卡已就绪、非 USB 网口模式、卡不在位或已失效时都不消耗这次机会。' +
			'所有 AT 指令一律由后端服务下发，界面与看门狗都不直接碰串口。' +
			'处置记录：SSH 执行 logread -e at-webserver | grep "SIM 自愈"。'));

		/* ---------- 载入 UCI（单 section `config` + 扁平键，与 Rust/ucode 一致） ---------- */
		var get = function (key, def) {
			var v = L.uci.get('at-webserver', 'config', key);
			return v == null || v === '' ? def : v;
		};
		connTypeSel.value = String(get('connection_type', 'SERIAL'));
		hostInput.value = String(get('network_host', '192.168.8.1'));
		netPortInput.value = String(get('network_port', '20249'));
		fillSerialOptions(String(get('serial_port', 'auto')));
		baudInput.value = String(get('serial_baudrate', '115200'));
		wsPortInput.value = String(get('websocket_port', '8765'));
		phoneNoteInput.value = String(get('phone_note', ''));
		var bindCur = get('websocket_bind', '');
		if (!bindCur) {
			bindCur = get('websocket_allow_wan', '0') === '1' ? '0.0.0.0' : '127.0.0.1';
		}
		wsBindSel.value = bindCur === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
		authKeyInput.value = String(get('websocket_auth_key', ''));
		notifyCalls.input.checked = get('notify_call', '1') === '1';
		notifySms.input.checked = get('notify_sms', '1') === '1';
		notifySignal.input.checked = get('notify_signal', '1') === '1';
		notifyMem.input.checked = get('notify_memory_full', '1') === '1';
		webhookInput.value = String(get('wechat_webhook', ''));
		/* 连接看门狗（此前这排控件已渲染但没接 UCI：既读不到当前配置，改了也存不下去） */
		wdChk.checked = get('watch_enabled', '1') === '1';
		wdIntervalInput.value = String(get('watch_interval', '60'));
		wdThresholdInput.value = String(get('watch_fail_threshold', '3'));
		wdResetChk.checked = get('watch_reset_modem', '0') === '1';
		wdIfaceInput.value = String(get('watch_iface', 'MT5700M'));
		wdDevInput.value = String(get('watch_device', 'eth2'));
		/* 探测目标要读**原始值**：config_get 是 `:-` 语义，空值与未设置都会落回默认，
		 * 所以这里也把空值一并按默认值展示（与保存侧一致），但用户显式填的 none 要原样保留。 */
		var gwRaw = L.uci.get('at-webserver', 'config', 'watch_gateway');
		wdGwInput.value = (gwRaw == null || String(gwRaw) === '')
			? WATCH_GATEWAY_DEFAULT : String(gwRaw);
		shChk.checked = get('sim_heal_enable', '1') === '1';
		/* UCI 里以字面 \n 存多行命令，这里还原成换行显示 */
		wdCmdsArea.value = String(get('watch_reset_cmds', WATCH_RESET_CMDS_DEFAULT)).replace(/\\n/g, '\n');

		/* ---------- 保存（OpenWrt 标准「保存并应用」流程） ----------
		 *
		 * 修复（问题一）：
		 *  - 变更先只写 UCI 内存，页面立刻标记「未保存更改」，离开时浏览器会拦截；
		 *  - 点击「保存并应用」才走 changes → save → apply 完整链路，apply 成功即
		 *    代表 procd reload trigger 已生效（at-webserver 有 procd_add_reload_trigger）；
		 *  - 无待应用变更（ubus NO_DATA）视为成功，不再误报「保存失败」。
		 */
		var saveStatus = E('span', { 'class': 'mt5700-hint' }, '');
		var saveBtn = Mt5700.primaryButton('保存并应用', function () {
			var set = function (key, value) {
				L.uci.set('at-webserver', 'config', key, value);
			};
			set('connection_type', connTypeSel.value);
			set('network_host', hostInput.value.trim() || '192.168.8.1');
			set('phone_note', phoneNoteInput.value.trim());
			set('network_port', String(parseInt(netPortInput.value, 10) || 20249));
			var serialVal = serialSel.value;
			if (serialVal === '__custom__') {
				serialVal = serialCustom.value.trim() || 'auto';
			}
			set('serial_port', serialVal || 'auto');
			set('serial_baudrate', String(parseInt(baudInput.value, 10) || 115200));
			set('websocket_port', String(parseInt(wsPortInput.value, 10) || 8765));
			var bind = wsBindSel.value === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
			set('websocket_bind', bind);
			set('websocket_allow_wan', bind === '0.0.0.0' ? '1' : '0');
			set('websocket_auth_key', authKeyInput.value.trim());
			set('notify_call', notifyCalls.input.checked ? '1' : '0');
			set('notify_sms', notifySms.input.checked ? '1' : '0');
			set('notify_signal', notifySignal.input.checked ? '1' : '0');
			set('notify_memory_full', notifyMem.input.checked ? '1' : '0');
			set('wechat_webhook', webhookInput.value.trim());
			/* 看门狗：间隔下限 15 秒（与 watchdog.sh 一致），阈值至少 1 次 */
			set('watch_enabled', wdChk.checked ? '1' : '0');
			set('watch_interval', String(Math.max(15, parseInt(wdIntervalInput.value, 10) || 60)));
			set('watch_fail_threshold', String(Math.max(1, parseInt(wdThresholdInput.value, 10) || 3)));
			set('watch_reset_modem', wdResetChk.checked ? '1' : '0');
			set('watch_iface', wdIfaceInput.value.trim() || 'MT5700M');
			set('watch_device', wdDevInput.value.trim() || 'eth2');
			/* 空白视为「用默认值」——config_get 本来就分不出空值和未设置，统一成显式默认值。 */
			var gwVal = wdGwInput.value.trim();
			set('watch_gateway', gwVal === '' ? WATCH_GATEWAY_DEFAULT : gwVal);
			set('sim_heal_enable', shChk.checked ? '1' : '0');
			/* 多行 → 字面 \n（UCI 值不能带真实换行），看门狗侧只翻译 \n、不动其它反斜杠。
			 * 逐行去首尾空白 + 丢掉空行 + 用字面 \n 连接；**不做反斜杠转义**——
			 * 命令里合法出现的反斜杠要原样保留。
			 * （旧实现用 /^\s*|\s*$/g，少了 m 标志，只能裁整串首尾，行首空白没裁掉。） */
			var wdCmdLines = wdCmdsArea.value.replace(/\r\n?/g, '\n').split('\n')
				.map(function (x) { return x.replace(/^\s+|\s+$/g, ''); })
				.filter(function (x) { return x !== ''; });
			set('watch_reset_cmds', wdCmdLines.join('\\n'));

			// 写内存后立刻标脏，未点保存就离开会被浏览器拦截
			AtWs.uci.markDirty();
			saveBtn.disabled = true;
			saveStatus.textContent = '正在保存并应用…';

			AtWs.uci.uciSave(SERVICE).then(function (res) {
				AtWs.uci.clearDirty();
				if (res.appliedSkipped) {
					saveStatus.textContent = '配置已应用（无待处理的变更）';
				} else {
					saveStatus.textContent = '配置已保存并应用';
				}
				Mt5700.success('配置已保存并应用');
				return reloadService();
			}).catch(function (err) {
				var msg = (err && err.message) || '未知错误';
				saveStatus.textContent = '保存失败：' + msg;
				Mt5700.error('保存失败：' + msg);
			}).then(function () {
				saveBtn.disabled = false;
			});
		});

		var bottomActions = Mt5700.panelActions(saveBtn, saveStatus);
		body.appendChild(bottomActions);

		// 任何表单控件变更都标记为「未保存」，与 CBI 表单行为对齐
		page.addEventListener('change', function () { AtWs.uci.markDirty(); });
		page.addEventListener('input', function () { AtWs.uci.markDirty(); });

		/* ---------- 服务操作（经 ubus service set，避免 init.d/firewall 阻塞） ---------- */
		var rpcServiceSet = L.rpc.declare({
			object: 'service',
			method: 'set',
			params: ['name', 'instances']
		});
		var rpcServiceDelete = L.rpc.declare({
			object: 'service',
			method: 'delete',
			params: ['name']
		});
		var rpcServiceList = L.rpc.declare({
			object: 'service',
			method: 'list',
			params: ['name'],
			expect: { '': {} }
		});
		/*
		 * 执行 /etc/init.d/at-webserver <action>（rpcd file.exec，ACL 已授权该脚本 exec）。
		 *
		 * 停止必须走 init 脚本而不是直接杀进程：stop_service() 会删 pidfile、清理本服务
		 * 添加的防火墙规则，且刻意「不 killall」——killall 会被 procd 记成崩溃，攒满
		 * respawn 重试次数后 procd 将永久放弃拉起（见 init 脚本里的「严重警告二」）。
		 *
		 * 不用 luci.setInitAction：真机 rpcd 的 luci 对象里根本没这个方法
		 * （ubus -v list luci 只有 getInitList / setPassword 等），调了必失败。
		 * 也不用 rc.init：它的 ACL 尚未开放，file.exec 这条已经是现成授权。
		 */
		var rpcFileExec = L.rpc.declare({
			object: 'file',
			method: 'exec',
			params: ['command', 'params'],
			expect: { code: 0, stdout: '', stderr: '' }
		});

		// 直接经 ubus 注册并拉起实例。即使 /etc/init.d/at-webserver 缺失
		// （overlay 白化等），这条路径依然能把服务跑起来。
		//
		// ★ 传参必须用位置参数。LuCI 的 rpc.declare 只在 options.params 是「对象」
		//   时才支持命名参数；本文件用的是数组 ['name','instances']，此时它按
		//   params 数组顺序取 arguments，写成 rpcServiceSet({name:.., instances:..})
		//   会把整个对象塞进 name 字段——调用不报错，但 ubus 侧什么都做不了。
		function startViaUbus() {
			return rpcServiceSet(SERVICE, {
				instance1: {
					command: [BINARY],
					respawn: ['3600', '5', '5'],
					stdout: true,
					stderr: true
				}
			});
		}

		// 拉取当前实例状态，用于操作后复核，避免「提示成功但实际没起来」
		function fetchRunning() {
			return rpcServiceList(SERVICE).catch(function () { return {}; }).then(function (resp) {
				var svc = (resp && resp[SERVICE]) || {};
				var running = false;
				var pid = null;
				if (svc.instances) {
					Object.keys(svc.instances).forEach(function (k) {
						var it = svc.instances[k] || {};
						if (it.running || it.pid) {
							running = true;
							if (!pid && it.pid) pid = it.pid;
						}
					});
				}
				return { running: running, pid: pid };
			});
		}

		function refreshStatus() {
			return Promise.all([
				rpcServiceList(SERVICE).catch(function () { return {}; }),
				L.uci.load(SERVICE)
			]).then(function (res) {
				var svc = (res[0] && res[0][SERVICE]) || {};
				var found = false;
				var pid = null;
				if (svc.instances) {
					Object.keys(svc.instances).forEach(function (k) {
						var it = svc.instances[k] || {};
						if (it.running || it.pid) {
							found = true;
							if (!pid && it.pid) pid = it.pid;
						}
					});
				}
				var en = L.uci.get(SERVICE, 'config', 'enabled');
				state.running = found;
				state.pid = pid;
				state.registered = !!(res[0] && res[0][SERVICE]);
				state.enabled = (en === null || en === undefined) ? '1' : String(en);

				var st = resolveStatus(state);
				renderStatus(st);
			});
		}

		function reloadService() {
			reloadBtn.disabled = true;
			return rpcServiceDelete(SERVICE).catch(function () {
				/* 实例可能不存在，删除失败不致命 */
			}).then(function () {
				return startViaUbus();
			}).then(function () {
				// 等 procd 完成拉起，再复核一次真实状态
				return new Promise(function (resolve) { window.setTimeout(resolve, 1200); });
			}).then(function () {
				return fetchRunning();
			}).then(function (st) {
				if (st.running) {
					// 无论此前是手动停止还是崩溃，能起来就不该再显示「已手动停止」的提示
					state.userStopped = false;
					Mt5700.success('服务已重载' + (st.pid ? '（PID ' + st.pid + '）' : ''));
				} else {
					Mt5700.warning('已下发启动指令，但未检测到运行中的进程，请查看系统日志确认原因');
				}
				return refreshStatus();
			}).catch(function (err) {
				Mt5700.error('重载失败：' + ((err && err.message) || '未知错误'));
			}).then(function () {
				reloadBtn.disabled = false;
			});
		}

		function restartService() {
			Mt5700.confirm('确定重启 AT 服务？现有 RPC 调用将短暂中断。', function () {
				restartBtn.disabled = true;
				reloadService().then(function () {
					restartBtn.disabled = false;
				});
			});
		}

		/*
		 * 停止服务。三步走，每步都允许失败、都往控制台留痕（便于 F12 排查）：
		 *   1) /etc/init.d/at-webserver stop（file.exec）—— 正规路径：stop_service()
		 *      删 pidfile、清防火墙规则，随后 rc.common 会 ubus service delete 掉实例。
		 *   2) ubus service.delete —— 保险。init stop 若因实例名没匹配上而没杀掉进程，
		 *      这一步兜底注销实例（delete 是注销，不会被 procd 记成崩溃）。
		 *   3) 轮询复核最多 12 秒 —— procd 的 term_timeout 是 5 秒，从发 SIGTERM 到
		 *      进程真正消失有延迟。固定等待（曾设 1 秒）会把「正在退出」误判成
		 *      「没停掉」，这是本功能第一版的真实 bug：明明停了却报失败。
		 *
		 * 注意：rc.common 会把 init 脚本命令行里 stop 之后的参数当成 instance 名，
		 * 拼进 ubus service delete 的 instance 字段。所以 params 只能是 ['stop']，
		 * 多传一个参数就会 delete 到不存在的实例、进程原地不动。
		 *
		 * 绝不用 killall：会被 procd 记成崩溃，攒满 respawn 重试后永久不再拉起
		 * （见 init 脚本里的「严重警告二」）。
		 */
		function waitUntilStopped(maxMs) {
			var deadline = Date.now() + maxMs;
			function step() {
				return fetchRunning().then(function (st) {
					if (!st.running || Date.now() >= deadline) return st;
					return new Promise(function (resolve) { window.setTimeout(resolve, 1000); }).then(step);
				});
			}
			return step();
		}

		function stopService() {
			Mt5700.confirm('确定停止 AT 服务？停止后所有页面的 AT 功能（状态、短信、网络信息）' +
				'将立即不可用，并会清理由本服务添加的防火墙规则。需要恢复时点击「重载服务」。', function () {
				stopBtn.disabled = true;
				var tried = [];
				rpcFileExec('/etc/init.d/' + SERVICE, ['stop'])
					.then(function (res) {
						tried.push('init stop（返回 ' + JSON.stringify(res || {}) + '）');
					})
					.catch(function (err) {
						tried.push('init stop 调用失败');
					})
					.then(function () {
						// stop_service 内含一次 firewall reload，等它跑完再复核
						return new Promise(function (resolve) { window.setTimeout(resolve, 2000); });
					})
					.then(fetchRunning)
					.then(function (st) {
						if (!st.running) return st;
						return rpcServiceDelete(SERVICE)
							.then(function () { tried.push('service.delete'); })
							.catch(function (err) {
								tried.push('service.delete 失败');
							})
							.then(function () { return waitUntilStopped(12000); });
					})
					.then(function (st) {
						state.userStopped = !st.running;
						if (st.running) {
							Mt5700.error('停止失败：进程仍在运行（PID ' + (st.pid || '未知') + '）。' +
								'已尝试：' + (tried.join('、') || '无') + '。请查看系统日志 logread -e at-webserver');
						} else {
							Mt5700.success('AT 服务已停止。需要恢复时点击「重载服务」。');
						}
						return refreshStatus();
					})
					.catch(function (err) {
						Mt5700.error('停止失败：' + ((err && err.message) || '未知错误'));
					})
					.then(function () {
						stopBtn.disabled = false;
						// 由真实状态决定按钮可用性（停止后应自动置灰）
						renderStatus(resolveStatus(state));
					});
			}, '停止服务');
		}

		return page;
	}
});
