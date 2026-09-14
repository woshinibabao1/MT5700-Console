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

		var simStatusRow = E('div', { 'class': 'mt5700-inline' });
		var simSqEl = E('span', { 'class': 'mt5700-hint' }, 'SIM 状态：—');
		var pinStatusEl = E('span', { 'class': 'mt5700-hint' }, 'PIN 状态：—');
		simStatusRow.appendChild(simSqEl);
		simStatusRow.appendChild(pinStatusEl);
		simBody.appendChild(simStatusRow);

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

		var pinOps = Mt5700.panelActions(
			Mt5700.button('输入 PIN', function () { pinModal('verify'); }, 'primary'),
			Mt5700.button('修改 PIN', function () { pinModal('change'); }, 'primary'),
			Mt5700.button('禁用 PIN', function () { pinModal('disable'); }, 'primary'),
			Mt5700.button('启用 PIN', function () { pinModal('enable'); }, 'primary')
		);
		simBody.appendChild(pinOps);

		function pinModal(op) {
			var titles = { verify: '输入 PIN', change: '修改 PIN', disable: '禁用 PIN', enable: '启用 PIN' };
			var fields = [];
			if (op === 'change') {
				fields.push({ key: 'old', label: '当前 PIN', type: 'password' });
				fields.push({ key: 'new', label: '新 PIN', type: 'password' });
				fields.push({ key: 'confirm', label: '确认新 PIN', type: 'password' });
			} else {
				fields.push({ key: 'pin', label: 'PIN', type: 'password' });
			}
			Ui.promptModal(titles[op], fields, function (values) {
				var cmd;
				if (op === 'verify') cmd = 'AT+CPIN="' + Parse.sanitizeAtParam(values.pin) + '"';
				else if (op === 'change') {
					if (values['new'] !== values.confirm) { Mt5700.error('两次输入的 PIN 码不一致'); return; }
					cmd = 'AT+CPIN="' + Parse.sanitizeAtParam(values.old) + '","' + Parse.sanitizeAtParam(values['new']) + '"';
				} else if (op === 'disable') cmd = 'AT+CLCK="SC",0,"' + Parse.sanitizeAtParam(values.pin) + '"';
				else cmd = 'AT+CLCK="SC",1,"' + Parse.sanitizeAtParam(values.pin) + '"';
				send(cmd).then(function (res) {
					if (res.success) {
						Mt5700.success('操作成功');
						fetchPinStatus();
					} else {
						Mt5700.error(Ui.atErrorText(res, 'PIN 码操作失败'));
					}
				}).catch(function () { Mt5700.error('PIN 码操作失败'); });
			});
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

		function fetchPinStatus() {
			return send('AT+CPIN?').then(function (res) {
				var ready = false;
				var got = false;
				if (res.success && res.data) {
					/* 原正则 (\w+) 匹配不到空格，'+CPIN: SIM PIN' 只解出 SIM，
					   于是「等输 PIN」被当成未知、再被下面的兜底硬写成 READY。*/
					var m = atText(res).match(/\+CPIN:\s*([A-Za-z ]+)/);
					if (m) {
						got = true;
						var st = m[1].trim();
						ready = st === 'READY';
						pinStatusEl.textContent = 'PIN 状态：' + st;
					}
				}
				/*
				 * 不能把非 READY 一律写成 READY：卡等着输 PIN（SIM PIN）/ 被锁（SIM PUK）
				 * 时 ready 为 false，硬写成 READY 会让界面谎报「卡已就绪」，用户看到
				 * 「卡插着却上不了网」而无从下手。取不到应答时才显示未知。
				 */
				if (!got) pinStatusEl.textContent = 'PIN 状态：未知';
				return send('AT+CLCK="SC",2');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/,(\d+)/);
					if (m) {
						var enabled = m[1] === '1';
						pinStatusEl.textContent = 'PIN 状态：READY，' + (enabled ? '已启用' : '未启用');
					}
				}
			}).catch(function () {});
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
			}).catch(function () { Mt5700.error('飞行模式设置失败'); });
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

		var ctrlCard = Mt5700.card('设备控制', '网卡速率与电源管理');
		var ctrlBody = E('div');
		ctrlCard._body.appendChild(ctrlBody);
		body.appendChild(ctrlCard);

		var nicSel = Mt5700.select([
			{ label: '自动协商', value: '0' },
			{ label: '1000Mbps 全双工', value: '1' },
			{ label: '100Mbps 全双工', value: '2' },
			{ label: '10Mbps 全双工', value: '3' }
		], '0');
		nicSel.addEventListener('change', function () { handleSetNic(parseInt(nicSel.value, 10)); });
		ctrlBody.appendChild(Mt5700.formGroup('网卡速率', nicSel));

		var pwrSwitch = makeSwitch(function (checked, input) {
			send('AT^TDPMCFG=' + (checked ? '1' : '0')).then(function (res) {
				if (res.success) Mt5700.success((checked ? '开启' : '关闭') + '电源管理成功');
				else {
					Mt5700.error((checked ? '开启' : '关闭') + '电源管理失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('电源管理设置失败'); });
		});
		ctrlBody.appendChild(Mt5700.formGroup('电源管理', pwrSwitch, '开启后模组在无业务时进入低功耗'));

		/* LED 指示灯（AT^LEDSWITCH，手册 11.12；0=关闭 1=打开，设置后需重启生效） */
		var ledSwitch = makeSwitch(function (checked, input) {
			send('AT^LEDSWITCH=' + (checked ? 1 : 0)).then(function (res) {
				if (res.success) Mt5700.success('LED 指示灯已' + (checked ? '开启' : '关闭') + '，重启模组后生效');
				else {
					Mt5700.error('LED 设置失败');
					input.checked = !checked;
				}
			}).catch(function () { Mt5700.error('LED 设置失败'); input.checked = !checked; });
		});
		ctrlBody.appendChild(Mt5700.formGroup('LED 指示灯', ledSwitch, '模组指示灯亮灭；厂商手册标注设置后需重启生效'));
		var pwrChk = pwrSwitch.querySelector('input');
		var ledChk = ledSwitch.querySelector('input');

		function handleSetNic(value) {
			send('AT^TDPCIELANCFG=' + value).then(function (res) {
				if (!res.success) { Mt5700.error('网卡速率设置失败'); return; }
				Mt5700.success('网卡速率设置成功，重启后生效');
				Mt5700.confirm('是否立即重启模组使配置生效？', function () {
					send('AT^RESET').then(function (r) {
						if (r.success) Mt5700.success('重启指令已发送');
						else Mt5700.error('重启指令发送失败');
					});
				}, '立即重启');
			}).catch(function () { Mt5700.error('网卡速率设置失败'); });
		}

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

		/* ---------- 1. 网络接入顺序 ---------- */
		var ACQ_OPTIONS = [
			{ value: '080302', label: '080302 · 5G 优先，逐级回落（NR→LTE→WCDMA）' },
			{ value: '08', label: '08 · 仅 5G' },
			{ value: '0302', label: '0302 · 4G 优先，可回落 3G' },
			{ value: '03', label: '03 · 仅 4G' },
			{ value: '0203', label: '0203 · 3G 优先，可回落 4G' },
			{ value: '02', label: '02 · 仅 3G' },
			{ value: '99', label: '99 · 不修改（只保存本页其它项）' }
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
		var acqSel = Mt5700.select(ACQ_OPTIONS, '080302');
		var acqHint = E('div', { 'class': 'mt5700-hint' });
		function paintAcq() {
			sysCfg.acqorder = acqSel.value;
			acqHint.textContent = (ACQ_DESC[acqSel.value] || '')
				+ '（制式代码：08=NR 03=LTE 02=WCDMA，手册 13.2.3）';
			applySrvConstraint();
		}
		acqSel.addEventListener('change', paintAcq);
		sysBody.appendChild(Mt5700.formGroup('网络接入顺序', acqSel,
			'模组按什么先后顺序搜索网络制式'));
		sysBody.appendChild(acqHint);

		/* ---------- 2. 2G / 3G 频段 ---------- */
		var BAND_OPTIONS = [
			{ value: '', label: '不修改（保持模组当前设置）' },
			{ value: '00680380', label: '00680380 · 自动（由模组按运营商选择）' },
			{ value: '3FFFFFFF', label: '3FFFFFFF · 全部频段（GSM / WCDMA 全频段）' },
			{ value: '2000000680380', label: '2000000680380 · WCDMA 900 + 1700 + 自动' }
		];
		var bandSel = Mt5700.select(BAND_OPTIONS, '');
		bandSel.addEventListener('change', function () { sysCfg.band = bandSel.value; });
		sysBody.appendChild(Mt5700.formGroup('2G / 3G 频段', bandSel,
			'十六进制位图，一般保持「自动」即可'));
		sysBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'这是位图不是数字，手改极易出错；需要精确控制时用下面的只读原始值对照 AT 手册。'));

		/* ---------- 3. 漫游（选项按 =? 实测范围动态生成） ---------- */
		var roamSel = Mt5700.select(Parse.roamOptions(2), '1');
		var roamHint = E('div', { 'class': 'mt5700-hint' });
		var roamNote = E('div', { 'class': 'mt5700-hint' });
		function paintRoam() {
			sysCfg.roam = parseInt(roamSel.value, 10);
			var table = (sysRanges.roam && sysRanges.roam.max >= 3) ? Parse.ROAM_TEXT : Parse.ROAM_TEXT_BASIC;
			roamHint.textContent = '解读：' + (table[sysCfg.roam] || sysCfg.roam);
		}
		roamSel.addEventListener('change', paintRoam);
		sysBody.appendChild(Mt5700.formGroup('漫游', roamSel,
			'是否允许接入非归属运营商的网络'));
		sysBody.appendChild(roamHint);
		sysBody.appendChild(roamNote);

		/* ---------- 4. 服务域 ---------- */
		var SRV_DESC = {
			0: '只注册语音网络，无法上网。当前接入制式含 4G / 5G 时模组不允许此值。',
			1: '只注册数据网络，无法接打电话和收发短信。适合纯上网设备。',
			2: '语音与数据同时注册，功能最完整。',
			3: '由网络侧决定注册方式。当前接入制式含 4G / 5G 时模组不允许此值。',
			4: '不改动服务域，只保存本页其它项。'
		};
		var srvSel = Mt5700.select([
			{ label: '0 · 仅语音（CS_ONLY）', value: '0' },
			{ label: '1 · 仅数据（PS_ONLY）', value: '1' },
			{ label: '2 · 语音 + 数据（CS_PS）', value: '2' },
			{ label: '3 · 不限（ANY）', value: '3' },
			{ label: '4 · 不修改', value: '4' }
		], '2');
		var srvHint = E('div', { 'class': 'mt5700-hint' });
		var srvNote = E('div', { 'class': 'mt5700-hint' });
		function paintSrv() {
			sysCfg.srvdomain = parseInt(srvSel.value, 10);
			srvHint.textContent = SRV_DESC[sysCfg.srvdomain] || '';
		}
		srvSel.addEventListener('change', paintSrv);
		sysBody.appendChild(Mt5700.formGroup('服务域', srvSel,
			'注册到语音域、数据域还是两者'));
		sysBody.appendChild(srvHint);
		sysBody.appendChild(srvNote);

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

		/* ---------- 5. 4G / LTE 频段 ---------- */
		var LTE_OPTIONS = [
			{ value: '', label: '不修改（保持模组当前设置）' },
			{ value: '1E200000095', label: '1E200000095 · 常用（BC1/3/5/8/34/38/39/40/41）' },
			{ value: '7FFFFFFFFFFFFFFF', label: '7FFFFFFFFFFFFFFF · 全部 LTE 频段' }
		];
		var lteSel = Mt5700.select(LTE_OPTIONS, '');
		lteSel.addEventListener('change', function () { sysCfg.lteband = lteSel.value; });
		sysBody.appendChild(Mt5700.formGroup('4G / LTE 频段', lteSel,
			'十六进制位图；改为「全部」会明显增加搜网时间'));
		sysBody.appendChild(E('div', { 'class': 'mt5700-hint' },
			'本机读回值 1E200000095 即 BC1+BC3+BC5+BC8+BC34+BC38+BC39+BC40+BC41 的叠加。'));

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
				o.textContent = (label || '') + value + ' · 当前值（预设未收录）';
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
				srvSel.value = String(sysCfg.srvdomain);
				paintAcq();
				paintRoam();
				paintSrv();
				sysRaw.textContent = '模组当前值：acqorder=' + sysCfg.acqorder
					+ '，band=' + sysCfg.band + '，roam=' + sysCfg.roam
					+ '，srvdomain=' + sysCfg.srvdomain + '，lteband=' + sysCfg.lteband;
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
				roamNote.textContent = '本机 ^SYSCFGEX=? 实报范围 roam ' + sysRanges.roam.min
					+ '-' + sysRanges.roam.max + '，故按「'
					+ (sysRanges.roam.max >= 3 ? '国内 / 国际' : '支持 / 不支持')
					+ '」语义显示；服务域范围 '
					+ (sysRanges.srvdomain ? sysRanges.srvdomain.min + '-' + sysRanges.srvdomain.max : '未知') + '。';
				paintRoam();
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
			}).catch(function () { Mt5700.error('温度保护设置失败'); });
		});
		thermBody.appendChild(Mt5700.formGroup('温度保护功能', thermSwitch));
		var thermChk = thermSwitch.querySelector('input');

		var thermCaSwitch = makeSwitch(function () {});
		thermBody.appendChild(Mt5700.formGroup('高温时关闭 CA/MIMO', thermCaSwitch));
		var thermCaChk = thermCaSwitch.querySelector('input');

		var thermIntervalInput = Mt5700.input('number', '5', '5');
		thermIntervalInput.min = 1;
		thermIntervalInput.addEventListener('input', function () {
			send(thermCmd()).then(function (res) {
				if (res.success) Mt5700.success('温度检测间隔设置成功');
				else Mt5700.error('温度检测间隔设置失败');
			}).catch(function () { Mt5700.error('温度检测间隔设置失败'); });
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

		function fetchDeviceControl() {
			return send('AT^TDPCIELANCFG?').then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^TDPCIELANCFG:\s*(\d+)/);
					if (m) nicSel.value = String(m[1]);
				}
				return send('AT^TDPMCFG?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^TDPMCFG:\s*(\d+)/);
					if (m) pwrChk.checked = m[1] === '1';
				}
				return send('AT^LEDSWITCH?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = atText(res).match(/\^LEDSWITCH:\s*(\d+)/);
					if (m && ledChk) ledChk.checked = m[1] === '1';
				}
			}).catch(function () {});
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

		return page;
	}
});
