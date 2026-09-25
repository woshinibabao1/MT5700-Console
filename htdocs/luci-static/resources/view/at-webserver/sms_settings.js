'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, SmsEncode, Mt5700 */

/**
 * 短信设置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * - IMS 开关（AT^IMSSWITCH? / AT^IMSSWITCH=1,0,0 等）
 * - 短信开关（开启步骤：CEUS=1/IMSSWITCH=1/CFUN=1/CGDCONT=5/CSCA；关闭步骤反向）
 * - 短信中心号码（AT+CSCA? / AT+CSCA="..."）
 * - 存储位置与用量（AT+CMGF=0 + AT+CPMS? / AT+CPMS=...）
 * - 清空全部短信（AT+CMGD=1,4 逐存储）
 * - 本地已发缓存导出/导入/清空
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信设置', '短信功能开关、中心号码与存储管理');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var state = {
			imsOn: false,
			smsOn: false,
			centerNumber: '',
			storage: { mem1: '', used1: 0, total1: 0, mem2: '', used2: 0, total2: 0, mem3: '', used3: 0, total3: 0 },
			cacheCount: 0
		};

		function mkCheck(onChange) {
			var wrap = E('div', { 'class': 'mt5700-switch' });
			var input = E('input', { type: 'checkbox' });
			if (onChange) input.addEventListener('change', function () { onChange(input.checked, input); });
			wrap.appendChild(input);
			return wrap;
		}

		/*
		 * IMS 开关回读（P06）。
		 *
		 * ★ 为什么必须回读：手册《4 呼叫控制命令》4.10 给 AT^IMSSWITCH 列了三条失败条件
		 *   （① 当前存在 IMS 业务；② 语音优选模式为 PS_ONLY 时关闭 LTE 域 IMS；
		 *    ③ 切换 IMS 协议栈对 LTE/UTRAN/GSM 的支持能力失败），而它同时是**掉电保存**
		 *   的命令（同节「属性说明」）—— 一次没真正生效的写入会被记住，界面却报成功。
		 *
		 * ★ 回读必须 { fresh: true }：`AT^IMSSWITCH?` 既不在 rpc.js 的 IDENTIFIER 档
		 *   （10 分钟）也不在 STATE 档，落到**默认 2500ms** 读缓存；而写命令路径只调
		 *   `_dropStateCache()`，清不到它 —— 不 fresh 就会立刻捞出下发前的旧值，
		 *   把「已生效」误判成「未生效」，反向制造假故障。
		 *
		 * ★ 只回不纠（禁止反向再下发）：三条失败条件在回滚那一刻通常仍然成立
		 *   （尤其①「存在 IMS 业务」），反向命令大概率同样失败；且协议栈切换是异步的，
		 *   中途再下发会把开关撬到第三种语义状态。正确做法是**收敛到实测值**
		 *   （调现成的 loadIMS()），并把「已下发但未生效」如实说给用户。
		 */
		function readImsSwitch() {
			return AtWs.client.sendCommand('AT^IMSSWITCH?', { fresh: true }).then(function (res) {
				if (!res.success || !res.data) return null;
				var m = String(res.data).match(/\^IMSSWITCH:\s*(\d+),\s*\d+,\s*\d+/);
				return m ? Number(m[1]) : null;
			}).catch(function () { return null; });
		}

		/* unknown=true 表示回读不到（不许据此断言生效与否，按旧行为放行） */
		function verifyImsSwitch(expect) {
			return readImsSwitch().then(function (actual) {
				if (actual === null) return { ok: true, actual: null, unknown: true };
				return { ok: actual === expect, actual: actual, unknown: false };
			});
		}

		/* ---------- IMS 与短信开关 ---------- */
		var smsCard = Mt5700.card('短信服务', 'IMS 与短信收发开关');
		var smsBody = E('div');
		smsCard._body.appendChild(smsBody);
		body.appendChild(smsCard);

		var imsSwitch = mkCheck(function (checked, input) {
			AtWs.client.sendCommand('AT^IMSSWITCH=' + (checked ? '1,0,0' : '0,0,0')).then(function (res) {
				if (!res.success) {
					Mt5700.error((checked ? '开启' : '关闭') + ' IMS 失败');
					input.checked = !checked;
					return;
				}
				/* R04：这是 AT^IMSSWITCH 的**两条写入口之一**（另一条在短信总开关的序列里），
				 *      两条都必须过同一套回读，否则「从这里改就说成功、从那里改就漏判」。 */
				return verifyImsSwitch(checked ? 1 : 0).then(function (v) {
					if (v.unknown) {
						Mt5700.success((checked ? '开启' : '关闭') + ' IMS 已下发（未能回读确认，请刷新查看）');
						return;
					}
					if (v.ok) {
						Mt5700.success((checked ? '开启' : '关闭') + ' IMS 成功');
						return;
					}
					/* 下发成功但实际没生效 —— 不反向重发，收敛到实测值并如实告知 */
					loadIMS();
					Mt5700.error((checked ? '开启' : '关闭') + ' IMS 已下发但未生效（当前实测值 ' + v.actual +
						'）；手册列出的常见原因是存在进行中的 IMS 业务，或语音优选模式为 PS_ONLY');
				});
			}).catch(function () { Mt5700.error('IMS 设置失败'); loadIMS(); });
		});
		var imsChk = imsSwitch.querySelector('input');
		smsBody.appendChild(Mt5700.formGroup('IMS 短信', imsSwitch, '开启后可收发短信'));

		var smsOnSwitch = mkCheck(function (checked) { toggleSMS(checked); });
		var smsOnChk = smsOnSwitch.querySelector('input');
		smsBody.appendChild(Mt5700.formGroup('短信功能', smsOnSwitch, '开启时按顺序下发 CEUS/IMSSWITCH/CFUN/CGDCONT/CSCA 配置'));

		/*
		 * 短信格式（AT+CMGF）—— 只读展示。
		 *
		 * 发送侧已经两种模式都支持（见 sms_center.js 的 sendPduMode / sendTextMode：
		 * PDU 模式组 PDU，Text 模式下发明文，含中文时临时切 UCS2 字符集），
		 * 所以模组被外部工具切到 Text 也能发出去。
		 *
		 * 这里**不给切换开关**是有意的：接收侧（新短信 URC → AT+CMGR → PDU 解码，
		 * 以及短信列表解析）是按 PDU 实现的，切到 Text 会让「收」这一侧读不出来。
		 * 把当前格式摆出来，是为了排查时一眼能看出模组处在哪种模式。
		 */
		var fmtEl = E('div', { 'class': 'mt5700-hint' }, '短信格式：—');
		smsBody.appendChild(fmtEl);

		/* ---------- 短信中心号码 ---------- */
		var centerCard = Mt5700.card('短信中心号码', '用于发送短信的 SMSC');
		var centerBody = E('div');
		centerCard._body.appendChild(centerBody);
		body.appendChild(centerCard);

		var centerInput = Mt5700.input('text', '+8613800755500', '');
		centerInput.addEventListener('input', function () { state.centerNumber = centerInput.value; });
		centerBody.appendChild(Mt5700.formGroup('中心号码', centerInput));
		centerBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存中心号码', function () {
				var num = centerInput.value.trim();
				if (!num) { Mt5700.error('请输入短信中心号码'); return; }
				AtWs.client.sendCommand('AT+CSCA="' + Parse.sanitizeAtParam(num) + '"').then(function (res) {
					if (res.success) Mt5700.success('短信中心号码已保存');
					else Mt5700.error('保存失败');
				}).catch(function () { Mt5700.error('保存失败'); });
			})
		));

		/* ---------- 存储管理 ---------- */
		var storeCard = Mt5700.card('存储管理', 'SIM 卡短信存储');
		var storeBody = E('div');
		storeCard._body.appendChild(storeBody);
		body.appendChild(storeCard);

		var storageEl = E('div', { 'class': 'mt5700-hint' }, '存储用量：—');
		storeBody.appendChild(storageEl);

		/*
		 * 存储位置的选项**必须由模组自己报**，不能写死。
		 *
		 * 实测（2026-09-18，本机 Hiveton H5000M / MT5700M）：
		 *   AT+CPMS=?  → +CPMS: ("SM","ME"),("SM","ME"),("SM","ME")
		 * 也就是说本机**只认 SM 与 ME**。此前界面里还有第三项「自动（SIM 优先）」= MT，
		 * 而 AT+CPMS="MT","MT","MT" 实发返回 ERROR（success=false）—— 用户选它就
		 * 永远是「保存失败」，且报错不告诉原因，看着就是「这功能坏了」。
		 */
		var STORAGE_LABELS = {
			SM: 'SIM 卡', ME: '模组内存', MT: '全部（SIM + 模组）',
			SR: '状态报告', BM: '广播', TA: '终端适配'
		};
		function storageLabel(v) { return STORAGE_LABELS[v] || v; }

		/* AT+CPMS=? → 取第一段括号里的存储名（三段通常一致，以第一段为准） */
		function parseCpmsSupported(text) {
			var m = String(text || '').match(/\+CPMS:\s*\(([^)]*)\)/);
			if (!m) return [];
			var out = [];
			var re = /"([^"]+)"/g;
			var g;
			while ((g = re.exec(m[1]))) out.push(g[1]);
			return out;
		}

		function setSelectOptions(sel, values, current) {
			sel.innerHTML = '';
			values.forEach(function (v) {
				var o = E('option', { value: v }, storageLabel(v) + '（' + v + '）');
				if (v === current) o.selected = true;
				sel.appendChild(o);
			});
			if (current && values.indexOf(current) < 0 && values.length) sel.value = values[0];
		}

		var locSel = Mt5700.select([], '');
		var locHint = E('div', { 'class': 'mt5700-hint' }, '读取中…');
		storeBody.appendChild(Mt5700.formGroup('存储位置', locSel));
		storeBody.appendChild(locHint);

		storeBody.appendChild(Mt5700.panelActions(
			Mt5700.primaryButton('保存存储位置', function () {
				var loc = locSel.value;
				if (!loc) { Mt5700.error('请先选择存储位置'); return; }
				AtWs.client.sendCommand('AT+CPMS="' + loc + '","' + loc + '","' + loc + '"')
					.then(function (res) {
						if (res.success) {
							Mt5700.success('存储位置已保存：' + storageLabel(loc));
						} else {
							/*
							 * 只弹「保存失败」等于什么都没说：本机实测 MT 不被支持，
							 * 但界面看不出来是「这个选项不行」还是「功能坏了」。
							 * 把模组原话带上，用户才知道该换一个。
							 */
							Mt5700.error('保存失败：' + loc + ' 可能不被支持（'
								+ ((res && res.error) ? res.error : '模组未返回 OK') + '）');
						}
						return loadStorage();
					})
					.catch(function (e) {
						Mt5700.error('保存失败：' + ((e && e.message) || e || '未知错误'));
					});
			}),
			Mt5700.dangerButton('清空全部短信', function () {
				Mt5700.confirm('确定清空全部短信？此操作不可恢复。', function () {
					AtWs.client.sendCommand('AT+CPMS?').then(function (res) {
						var storages = [];
						if (res.success && res.data) {
							/*
							 * 旧正则要求存储名前有逗号，而第一个存储紧跟在 ": " 之后
							 * （+CPMS: "SM",0,50,...），于是 mem1 永远匹配不到 —— SIM 卡上的
							 * 短信一条没删，界面还提示「已清空」。改为先取整行再逐项提取。
							 */
							var line = String(res.data).match(/\+CPMS:\s*(.*)/);
							var m = line ? (line[1].match(/"(\w+)",\d+,\d+/g) || []) : [];
							for (var i = 0; i < m.length; i++) {
								var s = m[i].match(/"(\w+)"/);
								if (s) storages.push(s[1]);
							}
						}
						if (!storages.length) storages = ['SM', 'ME', 'MT'];
						var unique = storages.filter(function (v, i, a) { return a.indexOf(v) === i; });
						var chain = Promise.resolve();
						var cleaned = 0;
						var missed = 0;
						unique.forEach(function (st) {
							chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGF=0'); })
									.then(function () { return AtWs.client.sendCommand('AT+CPMS="' + st + '","' + st + '","' + st + '"'); })
									.then(function () {
									return AtWs.client.sendCommand('AT+CMGD=1,4').then(function (r) {
										if (r && r.success === false) missed++; else cleaned++;
									});
								});
						});
						return chain.then(function () {
							/* 不判成败就报「已清空」，等于把失败也粉饰成成功 */
							if (missed) Mt5700.error('清空 ' + cleaned + ' 个存储成功、' + missed + ' 个失败');
							else Mt5700.success('已清空全部短信');
							/*
							 * 必须等清空完成再回读用量。
							 * 原先 loadStorage() 写在 return 之后 —— 那一行根本执行不到；
							 * 就算执行到，它发的 AT+CMGF=? / AT+CPMS? 也会排在删除命令
							 * 之前，界面显示的还是删除前的占用。
							 */
							return loadStorage();
						});
					}).catch(function () { Mt5700.error('清空短信失败'); });
				});
			})
		));

		/* ---------- 本地已发缓存 ---------- */
		var cacheCard = Mt5700.card('本地已发缓存', '发送记录保存在浏览器本地，可导出/导入/清空');
		var cacheBody = E('div');
		cacheCard._body.appendChild(cacheBody);
		body.appendChild(cacheCard);

		var cacheEl = E('div', { 'class': 'mt5700-hint' }, '缓存条数：0');
		cacheBody.appendChild(cacheEl);

		function exportCache() {
			var messages = Parse.getCachedSentMessages();
			var exportData = { app: 'at-webserver', version: 1, exportedAt: new Date().toISOString(), messages: messages };
			var blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
			var url = URL.createObjectURL(blob);
			var link = document.createElement('a');
			link.href = url;
			link.download = 'sms-cache-export.json';
			link.click();
			URL.revokeObjectURL(url);
			Mt5700.success('已导出 ' + messages.length + ' 条记录');
		}

		function refreshCacheCount() {
			state.cacheCount = Parse.getCachedSentMessages().length;
			cacheEl.textContent = '缓存条数：' + state.cacheCount;
		}

		cacheBody.appendChild(Mt5700.panelActions(
			Mt5700.button('导出缓存', exportCache, 'primary'),
			Mt5700.button('导入缓存', function () {
				var input = document.createElement('input');
				input.type = 'file';
				input.accept = 'application/json';
				input.addEventListener('change', function () {
					var file = input.files && input.files[0];
					if (!file) return;
					var reader = new FileReader();
					reader.onload = function (e) {
						try {
							var data = JSON.parse(String(e.target.result));
							var messages = Array.isArray(data) ? data : (data.messages || []);
							var valid = messages.filter(function (m) {
								return m && typeof m.content === 'string' && typeof m.number === 'string' &&
									typeof m.time === 'string' && (m.type === 'sent' || m.type === 'received');
							});
							if (!valid.length) { Mt5700.error('文件中没有有效的短信记录'); return; }
							/* 导入不走 saveSentMessageToCache，上限与去重都要自己补，
							   否则反复导入能把 localStorage 撑爆（写失败还被吞掉）。*/
							var seen = {};
							var list = Parse.getCachedSentMessages().concat(valid).filter(function (m) {
								var k = (m.time || '') + '|' + (m.number || '') + '|' + (m.content || '');
								if (seen[k]) return false;
								seen[k] = 1;
								return true;
							});
							if (list.length > Parse.MAX_SMS_CACHE) list = list.slice(0, Parse.MAX_SMS_CACHE);
							localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(list));
							Mt5700.success('导入成功，共 ' + valid.length + ' 条');
							refreshCacheCount();
						} catch (err) {
							Mt5700.error('导入失败：文件格式不正确');
						}
					};
					reader.readAsText(file);
				});
				input.click();
			}, 'primary'),
			Mt5700.dangerButton('清空缓存', function () {
				Mt5700.confirm('确定清空本地已发缓存？', function () {
					Parse.clearSentMessageCache();
					Mt5700.success('已清空');
					refreshCacheCount();
				});
			})
		));

		/* ---------- 短信开关步骤 ---------- */

		/*
		 * ★ 这个开关一步到位下发 5 条 AT，其中含 `AT+CFUN=0/1`（动射频：5G WAN 会断）
		 * 和关闭时的 `AT+CMGD=1,4`（**清空存储里的全部短信**）。此前翻一下开关就直接执行，
		 * 没有任何确认 —— 关一次等于把短信全删了，且不可恢复。
		 *
		 * 危险与否由 Parse.atDangerHint 统一判定（与终端页同一张表），这里只负责
		 * 在**执行前**把所有会踩到的危险项列出来让用户确认；取消就把开关拨回去。
		 */
		function toggleSMS(enable) {
			var steps = enable ? [
				['AT+CEUS=1', 1000, '开启 CEUS'],
				['AT^IMSSWITCH=1,0,0', 2000, '开启 IMS'],
				['AT+CFUN=1', 2000, '恢复射频'],
				['AT+CGDCONT=5,"IPV4V6","","",0,0,0,0,1,1,1,,,,,,0,,0,0,0,0', 1000, '配置数据承载'],
				['AT+CSCA="' + Parse.sanitizeAtParam(centerInput.value || '') + '"', 0, '配置中心号码']
			] : [
				['AT+CEUS=0', 500, '关闭 CEUS'],
				['AT^IMSSWITCH=0,0,0', 500, '关闭 IMS'],
				['AT+CFUN=0', 500, '关闭射频'],
				['AT+CMGD=1,4', 0, '清空短信']
			];
			var warnings = [];
			steps.forEach(function (s) {
				if (!s[0]) return;
				var hint = Parse.atDangerHint(s[0]);
				if (hint) warnings.push('· ' + s[2] + '（' + s[0] + '）：' + hint);
			});
			if (warnings.length) {
				Mt5700.confirm((enable ? '开启' : '关闭') + '短信功能会下发以下指令：\n\n'
					+ warnings.join('\n') + '\n\n确定继续？',
					function () { runToggleSteps(enable, steps); },
					'确定执行',
					function () { smsOnChk.checked = !enable; });
				return;
			}
			runToggleSteps(enable, steps);
		}

		function runToggleSteps(enable, steps) {
			smsOnChk.disabled = true;
			var chain = Promise.resolve();
			for (var i = 0; i < steps.length; i++) {
				(function (step) {
					chain = chain.then(function () {
						if (!step[0]) return { success: true };
						return AtWs.client.sendCommand(step[0]).then(function (res) {
							if (!res.success) {
								Mt5700.error('步骤「' + step[2] + '」失败');
								throw new Error(step[2] + ' 失败');
							}
							return Ui.sleep(step[1]);
						});
					});
				})(steps[i]);
			}
			/*
			 * R04：回读窗口必须放在**整串步骤全部结束之后**。
			 *   序列里 `AT^IMSSWITCH=0,0,0` 之后 500ms 就是 `AT+CFUN=0`（关射频）—
			 *   夹在中间回读时 IMS 协议栈正在切换、射频也正在动，读到的值既不能确认
			 *   也不能否认任何结论，只会制造假故障。
			 */
			chain.then(function () {
				return verifyImsSwitch(enable ? 1 : 0);
			}).then(function (v) {
				if (v.unknown || v.ok) {
					Mt5700.success(enable ? '短信功能已开启' : '短信功能已关闭');
					state.smsOn = enable;
					smsOnChk.checked = enable;
				} else {
					/* 序列跑完但 IMS 没到位：不许谎报成功，也不反向重发 —— 收敛到实测值 */
					Mt5700.error((enable ? '开启' : '关闭') + '短信：指令序列已执行，但 IMS 未生效（当前实测值 ' +
						v.actual + '），短信可能仍然不可用');
					loadIMS();
				}
				loadStorage();
				return AtWs.client.sendCommand('AT+CSCA?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CSCA: "([^"]+)"/);
					if (m) { state.centerNumber = m[1]; centerInput.value = m[1]; }
				}
				smsOnChk.disabled = false;
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '操作失败');
				smsOnChk.disabled = false;
				loadIMS();
			});
		}

		/*
		 * ---------- 短信可达性三要素（P07） ----------
		 *
		 * 三条前置缺一不可，而此前它们在**三张不同的卡片里各自孤立展示**，
		 * 没有任何一处把它们合起来判 —— 用户得自己在脑子里做 AND。
		 *
		 *   ① IMS 开关（LTE 域）   AT^IMSSWITCH?     手册 4.10
		 *   ② IMS 注册（含能力值） AT+CIREG?         手册 7.6
		 *   ③ 短信承载域           AT+CGSMS?         手册 7.7
		 *   ④ CS 域注册           AT+CREG?          （2026-09-24 真机校准新增）
		 *
		 *   ★③④ 必须**交叉**判，单看任何一条都会错：
		 *     - 只看③：选了「优先 CS」就报警 → 机器回落 GSM/UMTS 时 CS 域确实存在，
		 *       那时 CGSMS=3 是正确配置，会误报。
		 *     - 只看④：CS 未注册就报警 → CS 域本来就不是短信必经之路（走 IMS 就不需要），
		 *       而且「5G SA 没有 CS 域」是假设不是实测。
		 *     真机实测（中国移动卡）：+CGSMS: 3（优先 CS）+ +CREG: 0,0（CS 未注册）
		 *     + +CEREG: 2,1 / +C5GREG: 2,1（PS 侧正常）+ +CIREG: 1,1（IMS 已注册）
		 *     ——四条合起来才构成「短信被指向了一个不存在的域」的证据链。
		 *
		 * ★ 只读，不下发任何写命令；任一项读不到就如实写「读不到」，不许按乐观值补齐。
		 */
		var reachCard = Mt5700.card('短信可达性', '三项前置 + 承载域/CS 域交叉校验，缺哪条这里指名');
		reachCard._body.appendChild(Mt5700.loading('正在检查…'));
		body.appendChild(reachCard);

		function loadReachability() {
			var v = { ims: null, cireg: null, cgsms: null, cs: null };
			return Promise.resolve()
				.then(function () {
					return readImsSwitch().then(function (n) { v.ims = n; });
				})
				.then(function () {
					return AtWs.client.sendCommand('AT+CIREG?', { fresh: true }).then(function (res) {
						v.cireg = (res.success && res.data) ? Parse.parseCireg(String(res.data)) : null;
					});
				})
				.then(function () {
					return AtWs.client.sendCommand('AT+CGSMS?', { fresh: true }).then(function (res) {
						v.cgsms = (res.success && res.data) ? Parse.parseCgsms(String(res.data)) : null;
					});
				})
				.then(function () {
					/*
					 * ④ CS 域是否**真的**注册（2026-09-24 真机校准新增）。
					 *   没有这一项就只能靠「5G SA 没有 CS 域」这句假设去告警 —— 机器回落
					 *   GSM/UMTS 时 CS 域是存在的，那时 CGSMS=3 反而是正确配置，会误报。
					 */
					return AtWs.client.sendCommand('AT+CREG?', { fresh: true }).then(function (res) {
						v.cs = (res.success && res.data) ? Parse.parseCsDomain(String(res.data)) : null;
					});
				})
				.catch(function () { /* 单项读不到就保持 null，下面如实显示 */ })
				.then(function () { renderReachability(v); });
		}

		function renderReachability(v) {
			var b = reachCard._body;
			b.innerHTML = '';
			var rows = [
				['IMS 开关（LTE 域）', v.ims === null ? '读不到' : (v.ims === 1 ? '已开启' : '已关闭')],
				/*
				 * ★「能力值未上报」是**正常态**，不是故障：手册 7.6 明说只有 <n>=2 时
				 *   URC 才带 ext_info，而真机实测 AT+CIREG? 返回 `+CIREG: 1,1`（n=1）。
				 *   把 n 改成 2 是写命令，且要等下一次注册状态变化才上报 —— 本页不静默下发。
				 *   所以这里如实写「未上报」，绝不倒推出「IMS 短信不可用」。
				 */
				['IMS 注册', !v.cireg ? '读不到' : (v.cireg.text +
					(v.cireg.ext ? ('（能力值 ' + v.cireg.ext + '）') : '（能力值未上报，n=1）'))],
				['短信承载域', !v.cgsms ? '读不到' : v.cgsms.text],
				/* ④ 新增：CS 域实测。真机 +CREG: 0,0 ⇒ 未注册 ⇒ 与「优先 CS」构成冲突 */
				['CS 域注册', !v.cs ? '读不到' : (v.cs.text + '（stat ' + v.cs.stat + '）')]
			];
			var grid = E('div', { 'class': 'mt5700-metrics' });
			rows.forEach(function (r) { grid.appendChild(Mt5700.metric(r[0], r[1])); });
			b.appendChild(grid);

			/* 逐条点名，而不是笼统说「可能不可用」 */
			var bad = [];
			var unknown = [];
			if (v.ims === 0) bad.push('IMS（LTE 域）未开启');
			if (v.ims === null) unknown.push('IMS 开关');
			if (v.cireg) {
				if (v.cireg.info === 0) bad.push('IMS 未注册');
				else if (v.cireg.info === null) unknown.push('IMS 注册状态');
			} else unknown.push('IMS 注册状态');
			/*
			 * ★ 双条件判据（2026-09-24 真机校准）：「选了 CS 优先」**本身不是错**，
			 *   错的是「选了 CS 优先」**且**「CS 域实测未注册」。
			 *
			 *   原实现是单条件 `preferCs` 就报，措辞还写死「5G SA 下没有 CS 域」——那是假设。
			 *   机器回落 GSM/UMTS 时 CS 域确实存在，那时 CGSMS=3 是**正确**配置，会误报。
			 *   ★ CS 域读不到时归入 unknown，不许按「5G 下必然没 CS 域」倒推着报警。
			 */
			if (v.cgsms === null) unknown.push('短信承载域');
			else if (v.cs === null) unknown.push('CS 域注册状态（判不了承载域是否选错）');
			else if (v.cgsms.preferCs && !v.cs.registered) {
				bad.push('短信承载域选了「' + v.cgsms.text + '」，但 CS 域实测未注册（+CREG stat=' +
					v.cs.stat + '）—— 短信被指向了一个当前不存在的域，建议改为「优先 PS 域」');
			}

			if (bad.length) {
				b.appendChild(E('div', { 'class': 'mt5700-notice-warning mt5700-mt-sm' },
					'当前不满足的条件：' + bad.join('；') + '。'));
			} else if (unknown.length) {
				b.appendChild(E('div', { 'class': 'mt5700-notice mt5700-mt-sm' },
					unknown.join('、') + '未能读到，暂不判定可达性（不按乐观值补齐）。'));
			} else {
				b.appendChild(E('div', { 'class': 'mt5700-notice mt5700-mt-sm' },
					'三项前置均满足（IMS 语音与 IMS 短信能力以能力值为准）。'));
			}
		}

		/* ---------- 加载 ---------- */

		function loadIMS() {
			/*
			 * fresh 必给：本命令落在 rpc.js 的默认 2500ms 读缓存档，写命令路径的
			 * _dropStateCache() 清不到它 —— 不 fresh 会读到上一次的旧值（见 readImsSwitch 注释）。
			 */
			return AtWs.client.sendCommand('AT^IMSSWITCH?', { fresh: true }).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^IMSSWITCH:\s*(\d+),\d+,\d+/);
					if (m) {
						imsChk.checked = m[1] === '1';
						if (m[1] === '1') {
							return AtWs.client.sendCommand('AT+CSCA?').then(function (res2) {
								if (res2.success && res2.data) {
									var cm = String(res2.data).match(/\+CSCA: "([^"]+)"/);
									if (cm) { state.centerNumber = cm[1]; centerInput.value = cm[1]; }
								}
								smsOnChk.checked = true;
								state.smsOn = true;
							});
						}
						smsOnChk.checked = false;
						state.smsOn = false;
					}
				}
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		function loadFormat() {
			return AtWs.client.sendCommand('AT+CMGF?').then(function (res) {
				var m = String((res && res.data) || '').match(/\+CMGF:\s*(\d)/);
				var v = m ? m[1] : '';
				var label = v === '1' ? 'Text（明文）' : (v === '0' ? 'PDU（十六进制）' : '未知');
				fmtEl.textContent = '短信格式：' + label + (v ? '　AT+CMGF=' + v : '');
			}).catch(function () { fmtEl.textContent = '短信格式：读取失败'; });
		}

		/* 先问模组支持哪些存储，再据此生成下拉项（MT 之类本机没有的就不会出现） */
		function loadStorageOptions() {
			return AtWs.client.sendCommand('AT+CPMS=?').then(function (res) {
				var list = parseCpmsSupported(res && res.data);
				/* 查询失败时退回最通用的两个，别让下拉框空着 */
				if (!list.length) list = ['SM', 'ME'];
				state.supportedMemory = list;
				setSelectOptions(locSel, list, state.storage ? state.storage.mem1 : list[0]);
				locHint.textContent = '当前支持：' + list.map(storageLabel).join(' / ');
			}).catch(function () {
				state.supportedMemory = ['SM', 'ME'];
				setSelectOptions(locSel, state.supportedMemory, 'SM');
				locHint.textContent = '未能读取支持的存储（AT+CPMS=? 失败），已按 SIM 卡 / 模组内存显示';
			});
		}

		function loadStorage() {
			return AtWs.client.sendCommand('AT+CMGF=0').then(function () {
				return AtWs.client.sendCommand('AT+CPMS?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CPMS: "(\w+)",(\d+),(\d+),"(\w+)",(\d+),(\d+),"(\w+)",(\d+),(\d+)/);
					if (m) {
						state.storage = {
							mem1: m[1], used1: parseInt(m[2], 10), total1: parseInt(m[3], 10),
							mem2: m[4], used2: parseInt(m[5], 10), total2: parseInt(m[6], 10),
							mem3: m[7], used3: parseInt(m[8], 10), total3: parseInt(m[9], 10)
						};
						/*
						 * ★ 必须把下拉框同步成模组**当前真正用的**存储。
						 *   早先这里只刷了用量文本、没管下拉框，于是它永远停在建页面时的
						 *   默认值 'SM' —— 本机实际是 ME，界面却显示 SIM 卡。
						 *   用户点「保存」后就算成功了，看着也像「没保存、又跳回去了」。
						 */
						setSelectOptions(locSel, state.supportedMemory.length
							? state.supportedMemory : ['SM', 'ME'], state.storage.mem1);
						renderStorage();
					}
				}
				/* 只读探测失败：界面保持「—」或原值，下一轮刷新会再试；不弹错是因为一次查询失败不值得打断用户操作 */
			}).catch(function () {});
		}

		function renderStorage() {
			var s = state.storage;
			var text = '存储用量：';
			text += s.mem1 + ' ' + s.used1 + '/' + s.total1;
			if (s.mem2) text += ' · ' + s.mem2 + ' ' + s.used2 + '/' + s.total2;
			if (s.mem3) text += ' · ' + s.mem3 + ' ' + s.used3 + '/' + s.total3;
			storageEl.textContent = text;
			var pct = s.total1 > 0 ? Math.round((s.used1 / s.total1) * 100) : 0;
			var bar = E('div', { 'class': 'mt5700-progress' });
			var fill = E('div', { 'class': 'mt5700-progress-fill' });
			fill.style.width = pct + '%';
			bar.appendChild(fill);
			storageEl.appendChild(bar);
		}

		function loadAll() {
			return Promise.resolve()
				.then(loadIMS)
				// 必须在 loadStorage 之前：后者会下发 AT+CMGF=0，会把它之前读到的格式覆盖掉
				.then(loadFormat)
				.then(loadStorageOptions)
				.then(loadStorage)
				.then(refreshCacheCount)
				.then(loadReachability)
				.catch(function () { /* 单项数据失败时保留其余卡片，不打断整页 */ });
		}

		Mt5700.connectThen(function () {
			loadAll();
		});

		renderStorage();
		refreshCacheCount();

		return page;
	}
});
