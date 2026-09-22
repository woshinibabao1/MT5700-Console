'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, Mt5700 */

/**
 * 模组设置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI system/Info.tsx 的全部可操作功能：
 * - 设备信息（ATI / IMEI / 连接模式 AT+CONNECT?）
 * - SIM 卡：槽位切换（SCICHG + HVSST + CFUN 重启）、热插拔（TDSIMHP）、PIN 状态/操作
 * - 飞行模式（CFUN）
 * - 网卡速率（TDPCIELANCFG）、电源管理（TDPMCFG）
 * - NR 能力：载波聚合 / VoNR / DSS（NRRCCAPQRY=3/2/5 + NRRCCAPCFG）
 * - 漫游设置（SYSCFGEX）
 * - 温度保护（THERMAUTOFUN / THERMLD*）
 * - 重启（RESET）、恢复出厂（AT&F）
 *
 * 注意：IMEI 相关命令（AT+CGSN / AT^PHYNUM）完全沿用基准实现，未做任何改动。
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('模组设置', '模组设备信息、SIM、射频与系统控制');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 通用小工具 ---------- */

		function makeSwitch(onChange) {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			input.addEventListener('change', function () { onChange(input.checked, input); });
			wrap.appendChild(input);
			return wrap;
		}

		function atText(res) {
			if (!res) return '';
			if (typeof res.data === 'string') return res.data;
			if (res.data && typeof res.data.raw === 'string') return res.data.raw;
			return String(res.data || '');
		}

		function send(cmd) {
			return AtWs.client.sendCommand(cmd);
		}

		/* ================= 设备信息 ================= */

		var devCard = Mt5700.card('设备信息', '模组型号、固件版本与设备标识');
		var devBody = E('div');
		devCard._body.appendChild(devBody);
		body.appendChild(devCard);

		var dev = { manufacturer: '', model: '', revision: '', imei: '', connectMode: '' };
		/* ^VERSION? 的细节（软件 EXTS / 硬件 EXTH / 存储 / 发布），比 ATI 的 Revision 更全 */
		var ver = null;
		var imeiEl = E('span', { 'class': 'mt5700-mono' }, '—');

		function renderDev() {
			devBody.innerHTML = '';
			devBody.appendChild(Mt5700.table(
				['项目', '值'],
				[
					['制造商', dev.manufacturer || '—'],
					['型号', dev.model || '—'],
					['软件版本', ver && ver.EXTS ? ver.EXTS : (dev.revision || '—')],
					['硬件版本', ver && ver.EXTH ? ver.EXTH : '—'],
					['存储 / 发布', ver ? ((ver.ROMSIZE || '—') + ' / ' + (ver.RDV || '—')) : '—'],
					['IMEI（点击 5 次可修改）', imeiEl],
					['连接模式', dev.connectMode || '—']
				]
			));
		}
		renderDev();

		var imeiClickCount = 0;
		imeiEl.style.cursor = 'pointer';
		imeiEl.addEventListener('click', function () {
			imeiClickCount++;
			if (imeiClickCount >= 5) {
				imeiClickCount = 0;
				Ui.promptModal('修改 IMEI', [
					{ key: 'imei', label: '新 IMEI（15 位数字）', value: dev.imei }
				], function (values) {
					var newImei = (values.imei || '').trim();
					if (!/^\d{15}$/.test(newImei)) { Mt5700.error('IMEI 必须是 15 位数字'); return; }
					Mt5700.confirm('确定将 IMEI 修改为 ' + newImei + '？此操作影响设备合法性，请谨慎。', function () {
						send('AT^PHYNUM=IMEI,' + newImei).then(function (res) {
							if (res.success) {
								Mt5700.success('IMEI 修改成功');
								dev.imei = newImei;
								imeiEl.textContent = newImei;
							} else {
								Mt5700.error('IMEI 修改失败');
							}
						}).catch(function () { Mt5700.error('IMEI 修改失败'); });
					});
				});
			}
		});

		/* ================= SIM 卡 ================= */

		var simCard = Mt5700.card('SIM 卡', '槽位切换、热插拔与 PIN');
		var simBody = E('div');
		simCard._body.appendChild(simBody);
		body.appendChild(simCard);

		var simSqEl = E('span', { 'class': 'mt5700-hint' }, 'SIM 状态：—');
		simBody.appendChild(simSqEl);

		var simSlotSel = Mt5700.select([
			{ label: '外置 SIM', value: '0' },
			{ label: '内置 SIM', value: '1' }
		], '0');
		var simSlotSelProxy = simSlotSel;
		simSlotSelProxy.addEventListener('change', function () {
			handleSimSwitch(parseInt(simSlotSelProxy.value, 10));
		});
		simBody.appendChild(Mt5700.formGroup('SIM 槽位', simSlotSelProxy));

		var hpSwitch = makeSwitch(function (checked, input) { handleSimHotPlug(checked, input); });
		simBody.appendChild(Mt5700.formGroup('SIM 卡热插拔', hpSwitch));
		var hpChk = hpSwitch.querySelector('input');

		/* ================= PIN 码管理 ================= */

		/*
		 * PIN 锁的启用与否（AT+CLCK="SC",2）决定这一整段操作该怎么用：
		 * 卡片头的徽章、提示条文案、以及中间那个按钮是「启用」还是「关闭」
		 * 都由它驱动，所以做成状态驱动而不是四个固定按钮。
		 */
		var pinLockEnabled = null;   /* null = 还没读到 */

		var pinLockBadge = Mt5700.badge('PIN 状态未知', 'neutral');
		var pinCard = Mt5700.card('PIN 码管理', '验证、启用与修改 SIM 卡 PIN 码', pinLockBadge);
		var pinBody = E('div');
		pinCard._body.appendChild(pinBody);
		body.appendChild(pinCard);

		var pinNoticeEl = E('div', { 'class': 'mt5700-notice' }, '正在读取 PIN 状态…');
		pinBody.appendChild(pinNoticeEl);

		function pinInput(placeholder) {
			var el = Mt5700.input('password', placeholder);
			el.setAttribute('autocomplete', 'off');
			el.setAttribute('maxlength', '8');
			return el;
		}

		var pinCurInput = pinInput('请输入 PIN 码');
		var pinNewInput = pinInput('请输入新 PIN 码');
		var pinConfirmInput = pinInput('请再次输入新 PIN 码');

		pinBody.appendChild(Mt5700.formGroup('输入 PIN 码', pinCurInput, '当前 PIN 码，用于验证身份或开启/关闭 PIN 锁'));
		pinBody.appendChild(Mt5700.formGroup('新 PIN 码', pinNewInput, '4-8 位数字'));
		pinBody.appendChild(Mt5700.formGroup('确认新 PIN 码', pinConfirmInput));

		var pinLockBtn = Mt5700.button('启用 PIN 锁', function () { togglePinLock(); }, 'primary');
		pinBody.appendChild(Mt5700.panelActions(
			Mt5700.button('验证 PIN', function () { verifyPin(); }, 'primary'),
			pinLockBtn,
			Mt5700.button('修改 PIN 码', function () { changePin(); }, 'primary')
		));

		/* PUK 解锁是不可逆操作（PUK 只有 10 次机会），单独隔开并二次确认 */
		var pukZone = E('div', { 'class': 'mt5700-danger-zone' });
		pukZone.appendChild(E('div', { 'class': 'mt5700-danger-zone-title' }, '忘记 PIN 码？'));
		pukZone.appendChild(E('p', { 'class': 'mt5700-hint' },
			'如果连续 3 次输入错误 PIN 码，SIM 卡将被锁定，需要使用 PUK 码解锁。'));
		pukZone.appendChild(Mt5700.button('使用 PUK 码解锁', function () { pukUnlock(); }, 'danger'));
		pinBody.appendChild(pukZone);

		function readPin(el) {
			var v = String(el.value || '').trim();
			if (!v) { Mt5700.error('请先填写 PIN 码'); return null; }
			if (!/^\d{4,8}$/.test(v)) { Mt5700.error('PIN 码必须是 4-8 位数字'); return null; }
			return v;
		}

		function clearPinInputs() {
			pinCurInput.value = '';
			pinNewInput.value = '';
			pinConfirmInput.value = '';
		}

		function runPinCmd(cmd, okMsg) {
			return send(cmd).then(function (res) {
				if (res.success) {
					Mt5700.success(okMsg);
					clearPinInputs();
					fetchPinStatus();
				} else {
					Mt5700.error(Ui.atErrorText(res, 'PIN 码操作失败'));
				}
			}).catch(function () { Mt5700.error('PIN 码操作失败'); });
		}

		function verifyPin() {
			var pin = readPin(pinCurInput);
			if (!pin) return;
			runPinCmd('AT+CPIN="' + Parse.sanitizeAtParam(pin) + '"', 'PIN 验证成功');
		}

		function togglePinLock() {
			var pin = readPin(pinCurInput);
			if (!pin) return;
			var turnOn = pinLockEnabled !== true;
			Mt5700.confirm(turnOn
				? '启用后每次开机都需要输入 PIN 码才能使用 SIM 卡功能，确定启用？'
				: '关闭后开机无需输入 PIN 码即可使用 SIM 卡功能，确定关闭？',
				function () {
					runPinCmd('AT+CLCK="SC",' + (turnOn ? 1 : 0) + ',"' + Parse.sanitizeAtParam(pin) + '"',
						turnOn ? 'PIN 锁已启用' : 'PIN 锁已关闭');
				}, turnOn ? '确定启用' : '确定关闭');
		}

		function changePin() {
			var oldPin = readPin(pinCurInput);
			if (!oldPin) return;
			var np = readPin(pinNewInput);
			if (!np) return;
			var cp = readPin(pinConfirmInput);
			if (!cp) return;
			if (np !== cp) { Mt5700.error('两次输入的新 PIN 码不一致'); return; }
			if (np === oldPin) { Mt5700.error('新 PIN 码不能与当前 PIN 码相同'); return; }
			runPinCmd('AT+CPIN="' + Parse.sanitizeAtParam(oldPin) + '","' + Parse.sanitizeAtParam(np) + '"',
				'PIN 码修改成功');
		}

		/*
		 * PUK 解锁：AT+CPIN 的两个参数形式 '<PUK>,<新PIN>'。
		 * PUK 错 10 次卡就永久报废，因此这里除了格式校验还强制二次确认。
		 */
		function pukUnlock() {
			Ui.promptModal('使用 PUK 码解锁', [
				{ key: 'puk', label: 'PUK 码（8 位数字）', type: 'password' },
				{ key: 'pin', label: '新 PIN 码（4-8 位数字）', type: 'password' }
			], function (values) {
				var puk = String(values.puk || '').trim();
				var np = String(values.pin || '').trim();
				if (!/^\d{8}$/.test(puk)) { Mt5700.error('PUK 码必须是 8 位数字'); return; }
				if (!/^\d{4,8}$/.test(np)) { Mt5700.error('新 PIN 码必须是 4-8 位数字'); return; }
				Mt5700.confirm('PUK 码只有 10 次尝试机会，用尽后 SIM 卡将永久报废。确定解锁？',
					function () {
						runPinCmd('AT+CPIN="' + Parse.sanitizeAtParam(puk) + '","' + Parse.sanitizeAtParam(np) + '"',
							'SIM 卡已解锁，PIN 码已重置');
					}, '确定解锁');
			});
		}

		/* 徽章 / 提示条 / 按钮文案随 PIN 状态整体切换 */
		function renderPinState(cpinText, cpinReady, lockEnabled) {
			pinLockEnabled = (lockEnabled == null) ? null : !!lockEnabled;
			pinLockBadge.textContent = pinLockEnabled == null
				? 'PIN 状态未知' : (pinLockEnabled ? 'PIN 已启用' : 'PIN 未启用');
			pinLockBadge.className = 'mt5700-badge mt5700-badge-' +
				(pinLockEnabled == null ? 'neutral' : (pinLockEnabled ? 'success' : 'neutral'));
			pinLockBtn.textContent = pinLockEnabled ? '关闭 PIN 锁' : '启用 PIN 锁';

			var cls = 'mt5700-notice';
			var txt;
			if (cpinText === 'SIM PUK') {
				cls += ' mt5700-notice-danger';
				txt = 'SIM 卡已被锁定，需要使用 PUK 码解锁后才能继续。';
			} else if (cpinText === 'SIM PIN') {
				cls += ' mt5700-notice-warning';
				txt = 'SIM 卡正在等待输入 PIN 码，验证后才能使用短信与电话。';
			} else if (cpinReady) {
				cls += ' mt5700-notice-success';
				txt = pinLockEnabled
					? 'PIN 锁已启用，开机需要输入 PIN 码才能使用 SIM 卡功能。'
					: 'PIN 锁已禁用，开机无需输入 PIN 码即可使用 SIM 卡功能。';
			} else {
				txt = 'PIN 状态未知，请检查 SIM 卡是否插好。';
			}
			pinNoticeEl.className = cls;
			pinNoticeEl.textContent = txt;
		}

		function handleSimSwitch(target) {
			Mt5700.confirm('切换 SIM 卡需要重启射频与模组，确定切换到' + (target === 0 ? '外置' : '内置') + ' SIM 卡？', function () {
				var chain = Promise.resolve();
				chain = chain.then(function () { return send('AT^HVSST=1,0'); });
				chain = chain.then(function () { return send('AT^SCICHG=' + target + ',' + (1 - target)); });
				chain = chain.then(function () { return send('AT^HVSST=1,1'); });
				chain = chain.then(function () { return send('AT+CFUN=0'); });
				chain = chain.then(function () { return send('AT+CFUN=1'); });
				chain.then(function () {
					Mt5700.success('正在切换到' + (target === 0 ? '外置' : '内置') + ' SIM 卡，请等待设备重启…');
				}).catch(function () { Mt5700.error('切换 SIM 卡失败'); });
			});
		}

		function handleSimHotPlug(checked, input) {
			send('AT^TDSIMHP=' + (checked ? '1' : '0')).then(function (res) {
				if (res.success) {
					Mt5700.success((checked ? '开启' : '关闭') + ' SIM 卡热插拔成功');
				} else {
					Mt5700.error((checked ? '开启' : '关闭') + ' SIM 卡热插拔失败');
					if (input) input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('SIM 卡热插拔设置失败'); });
		}

		/*
		 * PIN 有两个互相独立的状态，别混为一谈：
		 *   AT+CPIN?        卡现在解锁了没有（READY / SIM PIN / SIM PUK）—— 决定能不能用
		 *   AT+CLCK="SC",2  PIN 锁开没开（启用 / 未启用）—— 决定开机要不要输
		 * 早先这里用 +CLCK 的结果去覆盖 +CPIN 的显示，卡等输 PIN 时会被写成
		 * READY，正好是谎报「卡已就绪」。两者现在各归各位。
		 */
		function fetchPinStatus() {
			var cpinReady = false;
			var cpinText = '';
			return send('AT+CPIN?').then(function (res) {
				var got = false;
				if (res.success && res.data) {
					/* 原正则 (\w+) 匹配不到空格，'+CPIN: SIM PIN' 只解出 SIM，
					   于是「等输 PIN」被当成未知。*/
					var m = atText(res).match(/\+CPIN:\s*([A-Za-z ]+)/);
					if (m) {
						got = true;
						cpinText = m[1].trim();
						cpinReady = cpinText === 'READY';
					}
				}
				if (!got) { cpinText = ''; cpinReady = false; }
				return send('AT+CLCK="SC",2');
			}).then(function (res) {
				var enabled = null;
				if (res.success && res.data) {
					/*
					 * 兼容三种真实应答，且必须**行锚定**：
					 *   +CLCK: 0              部分固件应答不带 facility
					 *   +CLCK: "SC",0         标准形式
					 *   AT+CLCK="SC",2 ⏎ +CLCK: 1   带命令回显（回显行里也有 ,2）
					 *
					 * 旧写法 /,(\d+)/ 有两个错：
					 *   ① `+CLCK: 0` 里根本没有逗号 → 解不出，状态恒为 null；
					 *   ② 带回显时先撞上**回显行**的 `,2`（查询参数），
					 *      把开关状态恒读成「未启用」—— 表现就是
					 *      「PIN 锁只能启用、永远关不掉」这个历史故障。
					 * 行锚定（前面必须是行首）后，回显行因前面有 `AT` 不再参与匹配。
					 */
					var m = atText(res).match(/(^|[\r\n])[ \t]*\+CLCK:\s*(?:"[^"]*"\s*,\s*)?(\d+)/);
					if (m) enabled = m[2] === '1';
				}
				renderPinState(cpinText, cpinReady, enabled);
			}).catch(function () {
				renderPinState('', false, null);
			});
		}

		/* ================= 飞行模式 ================= */

		var rfCard = Mt5700.card('射频控制', '飞行模式');
		var rfBody = E('div');
		rfCard._body.appendChild(rfBody);
		body.appendChild(rfCard);

		/*
		 * AT+CFUN=0 会立刻关掉射频、数据面中断，恢复可能要重启模组 —— 一次误点
		 * 等于整机断网。这里必须二次确认，且取消时把开关拨回去（用 confirm 的
		 * onCancel，否则界面状态与实际不符）。
		 */
		var airplaneSwitch = makeSwitch(function (checked, input) {
			function apply() {
			send('AT+CFUN=' + (checked ? '0' : '1')).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '飞行模式成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '飞行模式失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('飞行模式设置失败'); input.checked = !checked; });
			}
			if (checked) {
				Mt5700.confirm('开启飞行模式会立即关闭射频、数据连接中断，恢复可能需要重启模组。确定开启？',
					apply, '确定开启', function () { input.checked = false; });
			} else {
				apply();
			}
		});
		rfBody.appendChild(Mt5700.formGroup('飞行模式', airplaneSwitch, '开启后关闭射频，恢复网络连接'));
		var airplaneChk = airplaneSwitch.querySelector('input');

		/* ================= 设备控制 ================= */

		var ctrlCard = Mt5700.card('设备控制', '模组内部控制器、指示灯与 PCIe 网卡配置');
		var ctrlBody = E('div');
		ctrlCard._body.appendChild(ctrlBody);
		body.appendChild(ctrlCard);

		/*
		 * 本卡三项都在写模组的掉电保存区，其中 LED 与网卡 PHY 还要重启模组才生效。
		 * 与拨号页保持同一套交互：先暂存，按「保存并应用」才真正下发 —— 逐项立即
		 * 下发的话，用户连改三项会被弹三次「是否立即重启模组」；顺带也让误触下拉
		 * 不再等于立刻写模组。
		 */
		var ctrlStaged = Mt5700.staged({ onChanged: function () { fetchDeviceControl(); } });

		/* ---------- 1. LED 指示灯（AT^LEDSWITCH，手册 11.12） ---------- */
		/* 本卡里唯一对整机可见的开关：模组自身的指示灯。0=关闭（默认）1=打开。 */
		var ledSwitch = makeSwitch(function (checked) {
			ctrlStaged.set('led', 'LED 指示灯：' + (checked ? '开启' : '关闭'), function () {
				return send('AT^LEDSWITCH=' + (checked ? 1 : 0)).then(function (res) {
					if (!res.success) throw new Error('模组返回失败');
				});
			});
		});
		ctrlBody.appendChild(Mt5700.formGroup('LED 指示灯', ledSwitch,
			'模组自身指示灯的亮灭开关（0 关闭 / 1 打开，出厂默认关闭）；厂商手册标注需重启模组生效'));
		var ledChk = ledSwitch.querySelector('input');

		/* ---------- 2. PCIe 控制器（AT^TDPMCFG，手册 11.16） ---------- */
		/*
		 * 命令是 <mode>,<mode>,<mode>,<mode>：只有 byte[0] 有定义（pcie），其余三位是
		 * 保留位。原实现只发一个参数（AT^TDPMCFG=1），少发的位行为未定义 —— 这里把
		 * 读回的保留位原样回写，只改 byte[0]。
		 */
		var pcieReserved = ['0', '0', '0'];   /* 保留位当前值，读回后覆盖 */
		var pwrSwitch = makeSwitch(function (checked) {
			ctrlStaged.set('pcie-pwr', 'PCIe 控制器：' + (checked ? '开启' : '关闭'), function () {
				var cmd = 'AT^TDPMCFG=' + (checked ? 1 : 0) + ',' + pcieReserved.join(',');
				return send(cmd).then(function (res) {
					if (!res.success) throw new Error('模组返回失败');
				});
			});
		});
		ctrlBody.appendChild(Mt5700.formGroup('PCIe 控制器', pwrSwitch,
			'开启或关闭模组内部 PCIe 控制器供电（手册 11.16，关闭可省一点模组功耗）；'
			+ '本机 5G 模组以 USB 方式供网，此项与上网速率无关，掉电保存'));
		var pwrChk = pwrSwitch.querySelector('input');

		/* ---------- 3. PCIe 网卡 PHY（AT^TDPCIELANCFG，手册 11.19） ---------- */
		/*
		 * 值域**不取 =? 的实报**：本机固件 AT^TDPCIELANCFG=? 自称只支持 (0,1)，
		 * 实测却接受 AT^TDPCIELANCFG=2 并读回 2 —— 自报残缺，不能当值域来源，
		 * 否则界面永远看不到 2.5G 那一档。
		 * 改按手册 11.19（1=RTL8111 1G / 2=RTL8125 2.5G）与厂家 HiGoROS 固件
		 * （只认 1、2，其余判为「无效的网卡配置值」）取 1 / 2，与实测一致。
		 */
		var NIC_VALUES = ['1', '2'];
		var NIC_LABEL = {
			'1': 'RTL8111（1G · 1000Mbps 全双工）',
			'2': 'RTL8125（2.5G · 2500Mbps 全双工）'
		};
		var nicSel = Mt5700.select(NIC_VALUES.map(function (v) {
			return { label: NIC_LABEL[v], value: v };
		}), '1');
		nicSel.addEventListener('change', function () {
			var v = nicSel.value;
			ctrlStaged.set('nic', '网卡速率：' + (NIC_LABEL[v] || v), function () {
				return send('AT^TDPCIELANCFG=' + v).then(function (res) {
					if (!res.success) throw new Error('模组返回失败');
				});
			});
		});
		ctrlBody.appendChild(Mt5700.formGroup('网卡速率', nicSel,
			'模组 PCIe 网口所接的 PHY 型号，决定该口能协商到的速率（1G / 2.5G）；'
			+ '修改后需重启模组才生效'));
		var nicStatus = E('div', { 'class': 'mt5700-hint' }, '网卡速率：读取中…');
		ctrlBody.appendChild(nicStatus);

		var ctrlNote = E('div', { 'class': 'mt5700-hint' },
			'提示：本机 5G 模组以 USB 方式供网（eth2 = CDC-NCM），PCIe 总线上只有 WiFi 芯片、'
			+ '没有网卡；「PCIe 控制器」与「网卡速率」作用于模组 PCIe 侧网口，'
			+ '与 USB 供网这条链路无关。');
		ctrlBody.appendChild(ctrlNote);

		/* LED 与网卡速率要重启才生效，就近给一个入口，免得再跑去「系统控制」 */
		ctrlBody.appendChild(Mt5700.panelActions(
			Mt5700.ghostButton('立即重启模组', function () {
				Mt5700.confirm('确定重启模组？网络将中断约 10~30 秒，模组重启期间本页可能读不到数据。',
					function () {
						send('AT^RESET').then(function (res) {
							if (res.success) Mt5700.success('重启指令已发送');
							else Mt5700.error('重启指令发送失败');
						}).catch(function () { Mt5700.error('重启指令发送失败'); });
					}, '确定重启');
			})
		));

		ctrlBody.appendChild(ctrlStaged.el);

		/* ================= NR 能力 ================= */

		var nrCard = Mt5700.card('NR 能力', '载波聚合、VoNR 与 DSS');
		var nrBody = E('div');
		nrCard._body.appendChild(nrBody);
		body.appendChild(nrCard);

		var caSwitch = makeSwitch(function (checked, input) {
			send('AT^NRRCCAPCFG=3,' + (checked ? 1 : 0)).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '载波聚合成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '载波聚合失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('载波聚合设置失败'); });
		});
		nrBody.appendChild(Mt5700.formGroup('NR 载波聚合', caSwitch,
			'下发 AT^NRRCCAPCFG=3,<0|1>；读回用 AT^NRRCCAPQRY=3（已在本机验证可用）'));
		var caChk = caSwitch.querySelector('input');

		/*
		 * 开关与状态是两件事：开关 = 是否允许聚合；
		 * 实际聚合到几个载波看 ^HFREQINFO（NR 支持多 CC，最多 4 个）。
		 */
		var caStateBox = E('div', { 'class': 'mt5700-hint' },
			'当前载波数与聚合状态见「网络状态 → 载波与聚合」；此处只配置能力开关。');
		nrBody.appendChild(caStateBox);

		var vonrSel = Mt5700.select([
			{ label: '关闭', value: '0' },
			{ label: 'FR1-VoNR', value: '1' },
			{ label: 'FR2-VoNR', value: '2' },
			{ label: 'FR1+FR2-VoNR', value: '3' }
		], '0');
		vonrSel.addEventListener('change', function () {
			send('AT^NRRCCAPCFG=2,' + parseInt(vonrSel.value, 10)).then(function (res) {
				if (res.success) Mt5700.success('VoNR 配置成功');
				else Mt5700.error('VoNR 配置失败');
			}).catch(function () { Mt5700.error('VoNR 配置失败'); });
		});
		nrBody.appendChild(Mt5700.formGroup('VoNR', vonrSel));

		var dssSwitch = makeSwitch(function (checked, input) {
			send('AT^NRRCCAPCFG=5,' + (checked ? 1 : 0) + ',0').then(function (res) {
				if (res.success) Mt5700.success('DSS 配置成功');
				else {
					Mt5700.error('DSS 配置失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('DSS 配置失败'); });
		});
		nrBody.appendChild(Mt5700.formGroup('NR DSS', dssSwitch, 'LTE/NR 动态频谱共享'));
		var dssChk = dssSwitch.querySelector('input');

		function fetchNRCapability() {
			return send('AT^NRRCCAPQRY=3').then(function (res) {
				var v = res.success ? Parse.parseNrrcCapQry(atText(res), 3) : null;
				if (v !== null) caChk.checked = v === 1;
				return send('AT^NRRCCAPQRY=2');
			}).then(function (res) {
				var v = res.success ? Parse.parseNrrcCapQry(atText(res), 2) : null;
				if (v !== null) vonrSel.value = String(v);
				return send('AT^NRRCCAPQRY=5');
			}).then(function (res) {
				var v = res.success ? Parse.parseNrrcCapQry(atText(res), 5) : null;
				if (v !== null) dssChk.checked = v === 1;
			}).catch(function () {
			});
		}

		/* ================= 网络系统配置 SYSCFGEX ================= */

		var sysCard = Mt5700.card('网络系统配置',
			'决定模组用哪些制式、哪些频段去搜网；改错可能导致注册不上网络');
		var sysBody = E('div');
		sysCard._body.appendChild(sysBody);
		body.appendChild(sysCard);

		/*
		 * AT^SYSCFGEX 是「一次性下发整组参数」的接口：acqorder / band / roam /
		 * srvdomain / lteband 必须一起写回，只改一项也会把其余项按当前值重发。
		 * 因此本卡先读回模组原值，**未读回成功前禁止保存**，避免把空值写下去
		 * —— 那会直接把模组设成「不搜任何网络」。
		 */
		var sysCfg = { acqorder: '', band: '', roam: 1, srvdomain: 2, lteband: '' };
		var sysCfgReady = false;
		var sysRanges = { roam: null, srvdomain: null };

		/* ---------- 1. 网络接入顺序 ----------
		 * label 只给「人话」（5G 优先 / 仅 5G…）—— 十六进制码是给排障对 AT 手册用的，
		 * 塞进 label 会让它长得没人愿意读。码值改由两处承载：
		 *   ① 选中后下方 hint 里带出「制式代码 080302（NR → LTE → WDMA）」（见 paintAcq）
		 *   ② 卡片底部只读原始值 sysRaw 会显示模组当前 acqorder
		 * 两者都在，既不丢排障信息，也不把下拉撑成一列十六进制。 */
		var ACQ_OPTIONS = [
			{ value: '080302', label: '5G 优先' },
			{ value: '08', label: '仅 5G' },
			{ value: '0302', label: '4G 优先' },
			{ value: '03', label: '仅 4G' },
			{ value: '0203', label: '3G 优先' },
			{ value: '02', label: '仅 3G' },
			{ value: '99', label: '不修改' }
		];
		var ACQ_DESC = {
			'080302': '有 5G 就用 5G，没有依次回落 4G、3G。绝大多数场景选它。',
			'08': '只搜 5G。5G 覆盖不稳时会持续重搜，甚至无服务。',
			'0302': '优先驻留 4G，无 4G 时落 3G。适合 5G 覆盖差又想保速率的地方。',
			'03': '只搜 4G。信号稳定、耗电较低；离开 4G 覆盖会无服务。',
			'0203': '优先驻留 3G，无 3G 时落 4G。仅在 3G 覆盖优于 4G 的地区有意义。',
			'02': '只搜 3G，速率低，仅供排障使用。',
			'99': '不改动接入顺序，只保存本页其它项。'
		};
		/* 值 → 制式代码原文（手册 13.2.3：08=NR 03=LTE 02=WCDMA） */
		var ACQ_CODE = {
			'080302': 'NR → LTE → WCDMA',
			'08': 'NR',
			'0302': 'LTE → WCDMA',
			'03': 'LTE',
			'0203': 'WCDMA → LTE',
			'02': 'WCDMA',
			'99': '不改动'
		};
		var acqSel = Mt5700.select(ACQ_OPTIONS, '080302');
		var acqHint = E('div', { 'class': 'mt5700-hint' });
		function paintAcq() {
			sysCfg.acqorder = acqSel.value;
			/* 未收录值查不到 ACQ_DESC 时给兜底，别渲染成「制式代码 0801 · （手册 13.2.3）」
			   这种中间空一段、尾巴挂空括号的残句。 */
			var desc = ACQ_DESC[acqSel.value] || '手册未收录该取值，保存即按原样写回';
			acqHint.textContent = '制式代码 ' + acqSel.value
				+ (ACQ_CODE[acqSel.value] ? '（' + ACQ_CODE[acqSel.value] + '）' : '')
				+ ' · ' + desc + '（手册 13.2.3）';
			applySrvConstraint();
		}
		acqSel.addEventListener('change', paintAcq);
		sysBody.appendChild(Mt5700.formGroup('网络接入顺序', acqSel,
			'模组按什么先后顺序搜索网络制式'));
		sysBody.appendChild(acqHint);

		/* ---------- 2. 2G / 3G 频段 ----------
		 * 与「网络接入顺序」同一套路：label 只给中文，十六进制位图码移出选项、
		 * 在选中后的 hint 里带出（码是拿去对 AT 手册 13.2.3 的唯一依据，不能丢）。
		 * 频段名不再手编 —— 交给 Parse.decodeBandMask 按位拆，避免把「+ WCDMA 900」
		 * 误写成「+ WCDMA 1700」这类靠肉眼对位图必然会犯的错。 */
		var BAND_OPTIONS = [
			{ value: '', label: '不修改' },
			{ value: '00680380', label: '自动（推荐）' },
			{ value: '2000000680380', label: '自动 + WCDMA 900' },
			{ value: '3FFFFFFF', label: '全部频段' }
		];
		var bandSel = Mt5700.select(BAND_OPTIONS, '');
		var bandHint = E('div', { 'class': 'mt5700-hint' });
		function paintBand() {
			sysCfg.band = bandSel.value;
			bandHint.textContent = bandSel.value
				? '码 ' + bandSel.value + ' · ' + Parse.decodeBandMask(bandSel.value)
					+ '（位图，改动前先记下卡片底部的只读原始值）'
				: '保持模组当前设置，本项不下发';
		}
		bandSel.addEventListener('change', paintBand);
		sysBody.appendChild(Mt5700.formGroup('2G / 3G 频段', bandSel,
			'GSM / WCDMA 频带位图，一般保持「自动」'));
		sysBody.appendChild(bandHint);

		/* ---------- 3. 4G / LTE 频段 ----------
		 * 紧跟着 2G/3G 放：两者都是「频段位图」，拆开会让同类设置散在卡片两头。 */
		var LTE_OPTIONS = [
			{ value: '', label: '不修改' },
			{ value: '1E200000095', label: '常用（国内三家全覆盖）' },
			{ value: '7FFFFFFFFFFFFFFF', label: '全部频段' }
		];
		var lteSel = Mt5700.select(LTE_OPTIONS, '');
		var lteHint = E('div', { 'class': 'mt5700-hint' });
		function paintLte() {
			sysCfg.lteband = lteSel.value;
			lteHint.textContent = lteSel.value
				? '码 ' + lteSel.value + ' · ' + Parse.decodeLteBandMask(lteSel.value)
					+ (lteSel.value === '7FFFFFFFFFFFFFFF' ? '（会明显增加搜网时间）' : '')
				: '保持模组当前设置，本项不下发';
		}
		lteSel.addEventListener('change', paintLte);
		sysBody.appendChild(Mt5700.formGroup('4G / LTE 频段', lteSel,
			'LTE 频带位图，一般保持「常用」'));
		sysBody.appendChild(lteHint);

		/* ---------- 4. 服务域 ---------- */
		var SRV_DESC = {
			0: '只注册语音网络，无法上网。当前接入制式含 4G / 5G 时模组不允许此值。',
			1: '只注册数据网络，无法接打电话和收发短信。适合纯上网设备。',
			2: '语音与数据同时注册，功能最完整。',
			3: '由网络侧决定注册方式。当前接入制式含 4G / 5G 时模组不允许此值。',
			4: '不改动服务域，只保存本页其它项。'
		};
		var srvSel = Mt5700.select(Parse.srvDomainOptions(), '2');
		var srvHint = E('div', { 'class': 'mt5700-hint' });
		var srvNote = E('div', { 'class': 'mt5700-hint' });
		function paintSrv() {
			sysCfg.srvdomain = parseInt(srvSel.value, 10);
			/* 手册原名（CS_ONLY 等）只出现在这里：它是排障对手册用的，
			   塞进下拉 label 会让「仅语音」变成「0 · 仅语音（CS_ONLY）」这种代号串。 */
			var code = Parse.SRV_DOMAIN_CODE[sysCfg.srvdomain];
			srvHint.textContent = (code ? '服务域 ' + sysCfg.srvdomain + '（' + code + '，手册 13.2.3）· ' : '')
				+ (SRV_DESC[sysCfg.srvdomain] || '');
		}
		srvSel.addEventListener('change', paintSrv);
		sysBody.appendChild(Mt5700.formGroup('服务域', srvSel,
			'注册到语音域、数据域还是两者'));
		sysBody.appendChild(srvHint);
		sysBody.appendChild(srvNote);

		/*
		 * ---------- 5. 漫游（选项按 =? 实测范围动态生成） ----------
		 * 放最后一项：它能提供几档、是「国内 / 国际」还是「整体开关」，
		 * 完全由模组上报的范围决定（手册 13.2.3 两套语义），与前面四项
		 * 「选项固定」的性质不同，插在中间会让整卡顺序看起来没有章法。
		 */
		var roamSel = Mt5700.select(Parse.roamOptions(2), '1');
		var roamHint = E('div', { 'class': 'mt5700-hint' });
		var roamNote = E('div', { 'class': 'mt5700-hint' }, '漫游可选哪些值由模组实报范围决定，读取中…');
		function paintRoam() {
			sysCfg.roam = parseInt(roamSel.value, 10);
			var full = !!(sysRanges.roam && sysRanges.roam.max >= 3);
			var text = (full ? Parse.ROAM_TEXT : Parse.ROAM_TEXT_BASIC)[sysCfg.roam];
			roamHint.textContent = '已选：' + (text || sysCfg.roam)
				+ (full ? '（国内与国际可分别设置）' : '（本机只能整体开关漫游）');
		}
		roamSel.addEventListener('change', paintRoam);
		sysBody.appendChild(Mt5700.formGroup('漫游', roamSel,
			'是否允许接入非归属运营商的网络'));
		sysBody.appendChild(roamHint);
		sysBody.appendChild(roamNote);

		/*
		 * 手册 13.2.3 注 2 的硬约束：设置的模式里含有 L(03) 或 NR(08) 时，
		 * 服务域**不允许**设为 0 或 3。这条只写在文档里，界面不体现的话用户会
		 * 选了之后被模组默默拒绝。这里把约束显性化：禁用对应项，且若当前已选中
		 * 非法值就自动纠正为 2（CS_PS），并说明原因。
		 */
		function setSrvDisabled(v, off) {
			var opt = srvSel.querySelector('option[value="' + v + '"]');
			if (opt) opt.disabled = !!off;
		}
		function applySrvConstraint() {
			var acq = sysCfg.acqorder || '';
			var hasLteOrNr = acq.indexOf('03') >= 0 || acq.indexOf('08') >= 0;
			setSrvDisabled('0', hasLteOrNr);
			setSrvDisabled('3', hasLteOrNr);
			if (hasLteOrNr && (sysCfg.srvdomain === 0 || sysCfg.srvdomain === 3)) {
				srvSel.value = '2';
				paintSrv();
			}
			srvNote.textContent = hasLteOrNr
				? '当前接入顺序包含 4G / 5G，模组不允许「仅语音(0)」与「不限(3)」，已自动禁用。'
				: '';
		}

		/* ---------- 模组当前原始值（只读，便于排障对标） ---------- */
		var sysRaw = E('div', { 'class': 'mt5700-hint' }, '模组当前值：读取中…');

		sysBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存网络配置', function () {
				if (!sysCfgReady) {
					Mt5700.error('尚未读回模组当前参数，请刷新页面后重试');
					return;
				}
				send(Parse.buildSysCfgCommand(sysCfg)).then(function (res) {
					if (res.success) {
						Mt5700.success('网络系统配置已更新，模组将重新搜网');
						return fetchSysCfg();
					}
					Mt5700.error('网络系统配置更新失败');
				}).catch(function () { Mt5700.error('网络系统配置更新失败'); });
			})
		));
		sysBody.appendChild(sysRaw);

		/* 下拉里没有的值（模组被手工写过）→ 补一个选项顶上去，绝不静默改写成预设 */
		function ensureOption(sel, value, label) {
			if (value === '' || value == null) return;
			if (!sel.querySelector('option[value="' + value + '"]')) {
				var o = document.createElement('option');
				o.value = value;
				/* 与新的极简 label 风格保持一致：「当前值 0801（预设未收录）」。
				   ★ 未收录项**必须**带原始十六进制码 —— 它正是要拿去对 AT 手册
				   查的那个值，简化 label 要治的病是「选项太啰嗦」，不是「抹掉排障信息」。 */
				o.textContent = (label || '') + '当前值 ' + value + '（预设未收录）';
				sel.appendChild(o);
			}
			sel.value = value;
		}

		function fetchSysCfg() {
			return send('AT^SYSCFGEX?').then(function (res) {
				var cfg = res.success ? Parse.parseSysCfg(atText(res)) : null;
				if (!cfg) return;                 // 读不到就不放行保存，避免把空值写进模组
				sysCfg = cfg;
				sysCfgReady = true;
				ensureOption(acqSel, sysCfg.acqorder, '');
				ensureOption(bandSel, sysCfg.band, '');
				ensureOption(lteSel, sysCfg.lteband, '');
				ensureOption(roamSel, String(sysCfg.roam), '');
				/* 服务域同样要补项：模组被手工写过 5 之类范围外的值时，
				   直接 sel.value = '5' 在只有 0-4 的下拉里会**静默失败**，
				   界面显示 2 而实际下发 5，等于骗了用户一次。 */
				ensureOption(srvSel, String(sysCfg.srvdomain), '');
				paintAcq();
				paintBand();
				paintLte();
				paintSrv();
				paintRoam();
				sysRaw.textContent = '模组当前值：acqorder=' + sysCfg.acqorder
					+ '，band=' + sysCfg.band + '，roam=' + sysCfg.roam
					+ '，srvdomain=' + sysCfg.srvdomain + '，lteband=' + sysCfg.lteband;
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		/*
		 * 漫游与服务域的**取值范围**来自 AT^SYSCFGEX=?（本机实测 roam (0-2)、
		 * srvdomain (0-4)）。漫游的两套语义由这个范围决定，见 parse.js 的注释：
		 * 写死一套会在另一种固件上把意思显示反。
		 */
		function fetchSysCfgRanges() {
			return send('AT^SYSCFGEX=?').then(function (res) {
				if (!res.success) return;
				sysRanges = Parse.parseSysCfgRanges(atText(res)) || sysRanges;
				if (!sysRanges.roam) return;
				var keep = String(sysCfg.roam);
				roamSel.innerHTML = '';
				Parse.roamOptions(sysRanges.roam.max).forEach(function (o) {
					var el = document.createElement('option');
					el.value = o.value;
					el.textContent = o.label;
					roamSel.appendChild(el);
				});
				if (sysCfgReady) ensureOption(roamSel, keep, '');
				/*
				 * 漫游档位到底齐不齐，由模组说了算，这里必须把「为什么只有 3 档」
				 * 讲清楚 —— 否则用户会以为是本页没做全，实际是本机固件不给。
				 */
				roamNote.textContent = (sysRanges.roam.max >= 3
					? '本机 ^SYSCFGEX=? 实报 roam ' + sysRanges.roam.min + '-' + sysRanges.roam.max
						+ '：NV「漫游特性」已激活，国内漫游与国际漫游可分别设置（4 档齐全）。'
					: '本机 ^SYSCFGEX=? 实报 roam ' + sysRanges.roam.min + '-' + sysRanges.roam.max
						+ '：NV「漫游特性」未激活，模组只支持整体开关漫游，'
						+ '不提供「国内」与「国际」分别设置；固件若上报 0-3，本页会自动换成四档。')
					+ '（手册 13.2.3）';
				paintRoam();
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		/* ================= 温度保护 ================= */

		var thermCard = Mt5700.card('温度保护', '自动温度保护与检测参数（THERM）');
		var thermBody = E('div');
		thermCard._body.appendChild(thermBody);
		body.appendChild(thermCard);

		var thermStatus = E('div', { 'class': 'mt5700-hint' }, '温度保护：—');
		thermBody.appendChild(thermStatus);

		var thermLogsEl = E('div', { 'class': 'mt5700-hint' }, '');
		var thermThresholdsEl = E('div', { 'class': 'mt5700-hint' }, '');

		function thermCmd() {
			return 'AT^THERMAUTOFUN=' + (thermChk.checked ? 1 : 0) + ',' + (thermCaChk.checked ? 1 : 0) + ',' + (thermIntervalInput.value || 5);
		}

		var thermSwitch = makeSwitch(function (checked, input) {
			send(thermCmd()).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '温度保护功能成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '温度保护功能失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('温度保护设置失败'); input.checked = !checked; });
		});
		thermBody.appendChild(Mt5700.formGroup('温度保护功能', thermSwitch));
		var thermChk = thermSwitch.querySelector('input');

		var thermCaSwitch = makeSwitch(function () {});
		thermBody.appendChild(Mt5700.formGroup('高温时关闭 CA/MIMO', thermCaSwitch));
		var thermCaChk = thermCaSwitch.querySelector('input');

		var thermIntervalInput = Mt5700.input('number', '5', '5');
		thermIntervalInput.min = 1;
		/*
		 * 输入防抖：input 事件每敲一个字符就触发一次，直接下发的话输入 "15"
		 * 会先发 'AT^THERMAUTOFUN=x,y,1' 再发 '...,15' —— 前一条是完整无意义的
		 * 写命令，白占一次独占串口。这里停手 600ms 才发，且空值/非法值不发。
		 */
		var thermIntervalTimer = null;
		/*
		 * 本页是否已卸载。防抖回调 600ms 后才真正下发命令，那个时刻页面可能
		 * 早被切走了 —— 没有这个标志，回调会往独占串口发一条谁也不会看的写命令。
		 * 由 page._onDispose 置真（见文件末尾）。
		 */
		var disposed = false;
		thermIntervalInput.addEventListener('input', function () {
			if (thermIntervalTimer) clearTimeout(thermIntervalTimer);
			var n = parseInt(thermIntervalInput.value, 10);
			if (!isFinite(n) || n < 1) return;   /* 正在输入中间态，别下发给模组 */
			thermIntervalTimer = setTimeout(function () {
				thermIntervalTimer = null;
				if (disposed) return;
				send(thermCmd()).then(function (res) {
					if (res.success) Mt5700.success('温度检测间隔设置成功');
					else Mt5700.error('温度检测间隔设置失败');
				}).catch(function () { Mt5700.error('温度检测间隔设置失败'); });
			}, 600);
		});
		thermBody.appendChild(Mt5700.formGroup('检测间隔（秒）', thermIntervalInput));

		thermBody.appendChild(thermLogsEl);
		thermBody.appendChild(thermThresholdsEl);

		function fetchThermConfig() {
			return send('AT^THERMAUTOFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMAUTOFUN:\s*(\d+)\s+(\d+)\s+(\d+)/);
					if (m) {
						thermChk.checked = m[1] === '1';
						thermCaChk.checked = m[2] === '1';
						thermIntervalInput.value = String(m[3]);
					}
				}
				return send('AT^THERMLDLOGSW?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDLOGSW:\s*(\d+)\s+(\d+)/);
					if (m) thermLogsEl.textContent = '热抑制日志开关：' + (m[1] === '1' ? '开' : '关') + '，当前日志等级：' + m[2];
				}
				return send('AT^THERMLDAUTOPARA?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDAUTOPARA:\s*([\d,]+)/);
					if (m) thermThresholdsEl.textContent = '温保阈值参数：' + m[1];
				}
				return send('AT^THERMLDAUTOSTATUS?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^THERMLDAUTOSTATUS:\s*([\d,]+)/);
					if (m) {
						var nums = m[1].split(',').map(Number);
						var levelText = '温度保护状态（1 正常 / 2 一级 / 3 二级 / 4 三级 / 5 四级温保）：' + m[1];
						if (nums.length >= 6) levelText += '，当前等级：' + nums[5];
						thermStatus.textContent = levelText;
					}
				}
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		/* ================= 系统控制 ================= */

		var sysCtrlCard = Mt5700.card('系统控制', '重启与恢复出厂');
		var sysCtrlBody = E('div');
		sysCtrlCard._body.appendChild(sysCtrlBody);
		body.appendChild(sysCtrlCard);

		sysCtrlBody.appendChild(Mt5700.panelActions(
			Mt5700.dangerButton('重启模组', function () {
				Mt5700.confirm('确定重启模组？网络将暂时中断。', function () {
					send('AT^RESET').then(function (res) {
						if (res.success) Mt5700.success('重启指令已发送');
						else Mt5700.error('重启指令发送失败');
					}).catch(function () { Mt5700.error('重启指令发送失败'); });
				});
			}),
			Mt5700.dangerButton('恢复出厂设置', function () {
				Mt5700.confirm('确定恢复出厂设置？所有配置将被清空。', function () {
					send('AT&F').then(function (res) {
						if (res.success) Mt5700.success('恢复出厂设置指令已发送');
						else Mt5700.error('恢复出厂设置指令发送失败');
					}).catch(function () { Mt5700.error('恢复出厂设置指令发送失败'); });
				});
			})
		));

		/* ================= 数据加载 ================= */

		function fetchDeviceInfo() {
			return send('ATI').then(function (res) {
				if (res.success && res.data) {
					var lines = atText(res).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
					lines.forEach(function (l) {
						if (l.indexOf('Manufacturer:') === 0) dev.manufacturer = l.split(':')[1].trim();
						if (l.indexOf('Model:') === 0) dev.model = l.split(':')[1].trim();
						if (l.indexOf('Revision:') === 0) dev.revision = l.split(':')[1].trim();
					});
				}
				return send('AT+CGSN');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/(\d{15})/);
					if (m) { dev.imei = m[1]; imeiEl.textContent = m[1]; }
				}
				return send('AT^VERSION?');
			}).then(function (res) {
				if (res.success && res.data) {
					ver = Parse.parseVersion(String(res.data));
				}
				return send('AT+CONNECT?');
			}).then(function (res) {
				if (res.success && res.data) {
					var lines = atText(res).split(/[\r\n]+/).filter(function (l) { return l.trim(); });
					var connectLine = null;
					for (var i = 0; i < lines.length; i++) {
						if (lines[i].indexOf('+CONNECT:') >= 0) { connectLine = lines[i]; break; }
					}
					if (connectLine) {
						var modeValue = connectLine.split('+CONNECT:')[1].trim();
						if (modeValue === '0') dev.connectMode = '网络连接';
						else if (modeValue === '1') dev.connectMode = '串口连接';
						else dev.connectMode = modeValue;
					}
				}
				renderDev();
			}).catch(function () { renderDev(); });
		}

		function fetchSimConfig() {
			return send('AT^SCICHG?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^SCICHG:\s*(\d+),\s*(\d+)/);
					if (m) simSlotSelProxy.value = String(m[1]);
				}
				return send('AT^TDSIMHP?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^TDSIMHP:\s*(\d+)/);
					if (m) hpChk.checked = m[1] === '1';
				}
				return send('AT^SIMSQ?');
			}).then(function (res) {
				if (res.success && res.data) {
					var sq = Parse.parseSimsq(res.data);
					if (sq) {
						simSqEl.textContent = 'SIM 状态：' + sq.label + (sq.dead ? '（卡已失效，无法恢复）' : '');
					}
				}
				return fetchPinStatus();
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		function fetchAirplane() {
			return send('AT+CFUN?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\+CFUN:\s*(\d+)/);
					if (m) airplaneChk.checked = m[1] === '0';
				}
			}).catch(function () {});
		}

		/*
		 * 回填当前值，再读一次 =? 只为把「固件自称的值域」摆出来 —— 它可能与实际不符
		 * （本机自称 (0,1) 却接受 2），所以只展示、不据此生成选项，也不因读不到而禁用。
		 */
		function fetchNicConfig() {
			return send('AT^TDPCIELANCFG?').then(function (res) {
				var cur = res.success ? atText(res).match(/\^TDPCIELANCFG:\s*(\d+)/) : null;
				if (cur) {
					/* 当前值可能不在基线值域里（固件确实会回 0）就补一项，免得下拉显示空白 */
					ensureOption(nicSel, cur[1], NIC_LABEL[cur[1]] || (cur[1] + '（未收录）'));
					nicSel.value = cur[1];
				}
				return send('AT^TDPCIELANCFG=?');
			}).then(function (res2) {
				var claimed = res2.success ? Parse.parseNicRange(atText(res2)) : null;
				nicStatus.textContent = '网卡速率：当前 ' + nicSel.value
					+ '；固件自称支持 ' + (claimed ? '(' + claimed.join(',') + ')' : '未读到')
					+ '，实测接受 2，故按手册与厂商定义给出 1 / 2。'
					+ '本机模组以 USB 供网，此设置作用于模组 PCIe 侧网口，重启模组后生效。';
			}).catch(function () {
				nicStatus.textContent = '网卡速率：读取模组参数失败（刷新页面可重试）。';
			});
		}

		function fetchDeviceControl() {
			return send('AT^LEDSWITCH?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^LEDSWITCH:\s*(\d+)/);
					if (m && ledChk) ledChk.checked = m[1] === '1';
				}
				return send('AT^TDPMCFG?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^TDPMCFG:\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
					if (m) {
						pwrChk.checked = m[1] === '1';
						pcieReserved = [m[2], m[3], m[4]];
					}
				}
			}).catch(function () {
			}).then(function () {
				/* 前两项读失败也要继续读网卡项，否则那个下拉会一直停在「读取中…」 */
				return fetchNicConfig();
			});
		}

		function loadAll() {
			return Promise.resolve()
				.then(fetchDeviceInfo)
				.then(fetchSimConfig)
				.then(fetchAirplane)
				.then(fetchDeviceControl)
				.then(fetchNRCapability)
				.then(fetchSysCfg)
				.then(fetchSysCfgRanges)
				.then(fetchThermConfig)
				.catch(function () { /* 单项数据失败时保留其余卡片，不打断整页 */ });
		}

		var bottomActions = Mt5700.panelActions(
			Mt5700.primaryButton('刷新', function () { loadAll(); })
		);
		body.appendChild(bottomActions);

		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) { Mt5700.error((e && e.message) || '认证失败'); });
					}
				});
				return;
			}
		}).then(function () {
			loadAll();
		});

		/*
		 * 页面卸载钩子。
		 *
		 * 下面「温度检测间隔」的防抖回调里会读 disposed：防抖是 600ms 后才发命令，
		 * 这个时间点页面很可能已经切走了，此时再往独占串口下发一条写命令纯属
		 * 打扰。同时清掉还没触发的定时器。
		 */
		page._onDispose(function () {
			disposed = true;
			if (thermIntervalTimer) { clearTimeout(thermIntervalTimer); thermIntervalTimer = null; }
		});

		return page;
	}
});
