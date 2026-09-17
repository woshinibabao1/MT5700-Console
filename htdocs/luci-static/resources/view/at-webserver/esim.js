'use strict';
'require at-webserver/rpc';
'require at-webserver/ui';
'require at-webserver/mt5700';
'require at-webserver/euicc';
/* global L, AtWs, Ui, Mt5700, Euicc */

/**
 * eSIM 管理（eUICC profile 引导态）
 *
 * 纯前端 APDU，经既有 ubus `mt5700.at` 下发（AtWs.client.sendCommand），
 * 零后端改动、零新增二进制、不抢串口、不引入 lpac（见提案 §1.0）。
 * 只做本地管理（读 EID / 列 Profile / 启用 / 禁用 / 删除 / 改昵称），
 * 不做 profile 下载（ES8+/ES9+），下载降级为引导态 G4。
 *
 * 红线：
 *   - P01  只允许 sendCommand，禁止直连串口 / lpac
 *   - P08  四种引导态必须有落地 DOM，禁止白屏 / 假成功
 *   - P09  删除 = confirm + 输入 ICCID 末 4 位；启用/禁用 = 单层 confirm；重命名 = 不确认
 *   - P10  single-flight（busy 标志）+ 卸载复位 + 写操作绝不重试
 *   - P19  禁止行首裸 then（本文件所有 Promise 链均 .then( 形式）
 */

return L.view.extend({
	render: function () {
		var page = Mt5700.page('eSIM 管理', '管理卡槽内 eUICC 卡上的 Profile（启用 / 禁用 / 删除 / 重命名）');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 唯一 AT 出口（P01）：只走 AtWs.client.sendCommand ---------- */
		function send(cmd, opts) {
			return AtWs.client.sendCommand(cmd, opts);
		}

		/* ---------- single-flight：独占串口，写操作绝不重试（P10） ---------- */
		var busy = false;

		/* ---------- 通用小工具 ---------- */

		function atText(res) {
			if (!res) return '';
			if (typeof res.data === 'string') return res.data;
			if (res.data && typeof res.data.raw === 'string') return res.data.raw;
			return String(res.data || '');
		}

		function handleErr(e) {
			var code = e && e.code;
			var msg;
			if (code === 'EUICC_NO_EUICC') {
				msg = '这张卡不是 eUICC，无法管理 Profile';
			} else if (code === 'EUICC_POLICY_DENIED') {
				msg = '该 Profile 的策略禁止此操作（常见于运营商预置 Profile 禁止删除）';
			} else if (code === 'EUICC_BUSY') {
				msg = '卡片工具箱正忙，约 10 秒后重试';
			} else if (code === 'EUICC_NO_CSIM') {
				msg = '当前固件不支持 AT+CSIM，无法与卡通信';
			} else if (code === 'EUICC_NO_CARD') {
				msg = '卡槽内未检测到 SIM 卡（AT 报 NOCARD），请检查插卡';
			} else if (code === 'EUICC_AT_ERROR') {
				/* R05：与「固件不支持 AT+CSIM」区分开 —— 这里明确是 AT 服务未就绪 */
				msg = 'AT 服务未就绪（未连接到调制解调器或无响应），请检查 AT 服务';
			} else if (code === 'EUICC_OP_FAILED' && e.swText) {
				/* R08：优先用 §1.5① 错误矩阵的人话文案 + 提示 */
				msg = e.swText + (e.swHint ? '；' + e.swHint : '');
			} else {
				msg = (e && e.message) || '操作失败';
			}
			Mt5700.error(msg);
		}

		/* ---------- 引导态：G3 无卡（§1.6） ---------- */
		function renderNoCard() {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			var notice = E('div', { 'class': 'mt5700-notice-warning' },
				'卡槽内未检测到 SIM 卡，请插卡后刷新。');
			card._body.appendChild(notice);
			card._body.appendChild(Mt5700.button('刷新', function () { render(); }, 'primary'));
			body.appendChild(card);
		}

		/* ---------- 引导态：G2 AT+CSIM 不可用（§1.6） ---------- */
		function renderNoCsim(p) {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			card._body.appendChild(E('div', { 'class': 'mt5700-notice-danger' },
				'当前固件不支持 AT+CSIM，无法与卡通信。'));
			card._body.appendChild(E('p', { 'class': 'mt5700-hint' }, '实际应答原文（已截断）：'));
			/* R12：原样应答截断到 200 字符，避免把整段 AT 日志塞进 DOM */
			card._body.appendChild(E('div', { 'class': 'mt5700-mono' },
				(p && p.raw) ? String(p.raw).slice(0, 200) : '（无应答）'));
			card._body.appendChild(Mt5700.button('重试', function () { render(); }, 'primary'));
			body.appendChild(card);
		}

		/* ---------- 引导态：G1 非 eUICC（§1.6），同时读 ICCID 作佐证 ---------- */
		function renderNoEuicc() {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			card._body.appendChild(E('div', { 'class': 'mt5700-notice' },
				'卡上没有 eUICC（ISD-R 未找到）。当前卡是普通 USIM，不支持 eSIM profile 管理。'));

			var iccidLine = E('div', { 'class': 'mt5700-hint' }, '正在读取卡槽 ICCID…');
			card._body.appendChild(iccidLine);
			send('AT^ICCID?', { fresh: true }).then(function (r) {
				var m = atText(r).match(/ICCID:\s*([0-9A-Fa-f]+)/);
				iccidLine.textContent = m ? ('卡槽 ICCID：' + m[1]) : '无法读取卡槽 ICCID';
			}).catch(function () {
				iccidLine.textContent = '无法读取卡槽 ICCID';
			});

			var explain = E('div', { 'class': 'mt5700-card' });
			explain.appendChild(E('div', { 'class': 'mt5700-card-header' },
				E('h3', { 'class': 'mt5700-card-title' }, '关于本页')));
			var eb = E('div', { 'class': 'mt5700-card-body' });
			eb.appendChild(E('p', { 'class': 'mt5700-hint' },
				'本页只做卡上已有 Profile 的本地管理。下载并安装新 Profile 需要 lpac 与 HTTPS 后端支持，本设备未提供（见下方说明）。'));
			explain.appendChild(eb);
			card._body.appendChild(explain);

			card._body.appendChild(buildDownloadZone());
			body.appendChild(card);
		}
		function renderError(p) {
			body.innerHTML = '';
			body.appendChild(connBar);
			var card = Mt5700.card('eSIM 管理');
			/* R12：code 是内部诊断码，绝不进用户可见文案；只出中文 + 进 console */
			var code = (p && p.error) || '';
			card._body.appendChild(Mt5700.errorState(
				'读取 eSIM 信息失败，请稍后重试。',
				function () { render(); }));
			body.appendChild(card);
			if (code && typeof console !== 'undefined' && console.warn) {
				console.warn('[esim] 探测错误 code=' + code);
			}
		}

		/* ---------- G4 下载 Profile 需 lpac（恒为 true，不做动态检测，P18） ---------- */
		function buildDownloadZone() {
			var zone = E('div', { 'class': 'mt5700-danger-zone' });
			zone.appendChild(E('div', { 'class': 'mt5700-danger-zone-title' }, '下载并安装新 Profile'));
			zone.appendChild(E('p', { 'class': 'mt5700-hint' },
				'下载并安装新 Profile 需要 lpac 与 HTTPS 后端，本设备未提供；本页只能管理卡上已有的 Profile。'));
			var btn = Mt5700.button('下载', function () { /* disabled，无动作 */ }, 'primary');
			btn.disabled = true;
			btn.title = '下载并安装新 Profile 需要 lpac 与 HTTPS 后端，本设备未提供';
			zone.appendChild(btn);
			return zone;
		}

		/* ---------- 正常态：EID + Profile 表 + 操作 ---------- */
		function renderOk(p) {
			body.innerHTML = '';
			body.appendChild(connBar);

			var headCard = Mt5700.card('eSIM 状态');
			var metrics = E('div', { 'class': 'mt5700-metrics' });
			metrics.appendChild(Mt5700.metric('EID', p.eid || '—'));
			metrics.appendChild(Mt5700.badge('eUICC 已就绪', 'success'));
			headCard._body.appendChild(metrics);
			/* R04：展示疑似通道泄漏提示（若 probe 探测到） */
			if (p.channelNote) {
				headCard._body.appendChild(E('div', { 'class': 'mt5700-notice-warning' }, p.channelNote));
			}
			body.appendChild(headCard);

			var listCard = Mt5700.card('Profile 列表', '启用 / 禁用会触发卡片刷新，期间网络将短暂中断并重注册（约 10~30 秒）');
			listCard._body.appendChild(Mt5700.loading('正在读取 Profile 列表…'));
			body.appendChild(listCard);

			loadProfiles(listCard);
		}

		function loadProfiles(listCard) {
			if (busy) return;
			busy = true;
			Euicc.listProfiles(send).then(function (res) {
				busy = false;
				renderTable(listCard, res.list || []);
			}).catch(function (e) {
				busy = false;
				if (e && e.code === 'EUICC_NO_EUICC') { renderNoEuicc(); return; }
				listCard._body.innerHTML = '';
				listCard._body.appendChild(Mt5700.errorState('读取 Profile 列表失败：' + ((e && e.message) || ''),
					function () { loadProfiles(listCard); }));
			});
		}

		function renderTable(listCard, list) {
			listCard._body.innerHTML = '';
			if (!list.length) {
				listCard._body.appendChild(Mt5700.empty('卡上暂无可管理的 Profile'));
				listCard._body.appendChild(buildDownloadZone());
				return;
			}
			var headers = ['ICCID', '运营商 / 名称', '状态', '昵称', '操作'];
			var rows = list.map(function (p) {
				var name = p.nickname || p.profileName || p.spName || '—';
				var stateCell = p.state === 'enabled'
					? Mt5700.badge('已启用', 'success')
					: Mt5700.badge('已禁用', 'neutral');
				var actions = E('div');
				actions.appendChild(Mt5700.button(
					p.state === 'enabled' ? '禁用' : '启用',
					function () { toggleProfile(p, p.state !== 'enabled'); }, 'primary'));
				actions.appendChild(Mt5700.button('重命名', function () { renameProfile(p); }, 'ghost'));
				actions.appendChild(Mt5700.dangerButton('删除', function () { deleteProfile(p); }));
				return [p.iccid || '—', name, stateCell, p.nickname || '—', actions];
			});
			listCard._body.appendChild(Mt5700.table(headers, rows));
			listCard._body.appendChild(buildDownloadZone());
		}

		/* ---------- P09 确认策略 ---------- */

		function toggleProfile(p, enable) {
			if (busy) return;
			var verb = enable ? '启用' : '禁用';
			Mt5700.confirm('确定' + verb + '该 Profile？操作后网络将短暂中断并重注册（约 10~30 秒）。', function () {
				busy = true;
				var op = enable ? Euicc.enableProfile : Euicc.disableProfile;
				op(send, { kind: 'iccid', hex: p.iccidRaw }, true).then(function () {
					busy = false;
					var note = E('div', { 'class': 'mt5700-notice' },
						verb + '成功，网络将中断并重注册，约 10~30 秒后恢复。');
					body.insertBefore(note, body.firstChild);
					setTimeout(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 8000);
					/* R07：成功后模组正在重注册，CSIM 大概率 +CME ERROR:14 / 无响应。
					 * 延后约 12 秒再刷新；刷新失败保留旧列表，只用提示，不用 errorState 覆盖。 */
					var listCard = findListCard();
					if (listCard) {
						setTimeout(function () {
							if (busy) return; /* 期间用户已发起其它操作则不抢 */
							busy = true;
							Euicc.listProfiles(send).then(function (res) {
								busy = false;
								renderTable(listCard, res.list || []);
							}).catch(function () {
								busy = false;
								/* 保留旧列表，仅提示，不覆盖为 errorState */
								if (!listCard._body.querySelector('.mt5700-notice')) {
									listCard._body.appendChild(E('div', { 'class': 'mt5700-notice' },
										'卡片刷新中，请稍后点击重试'));
								}
							});
						}, 12000);
					}
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			});
		}

		function renameProfile(p) {
			if (busy) return;
			Ui.promptModal('重命名 Profile', [
				{ key: 'name', label: '昵称（≤64 字节，留空清除）', type: 'text', value: p.nickname || '' }
			], function (values) {
				var name = (values.name || '').trim();
				busy = true;
				Euicc.setNickname(send, p.iccidRaw, name).then(function () {
					busy = false;
					var listCard = findListCard();
					if (listCard) loadProfiles(listCard);
				}).catch(function (e) {
					busy = false;
					handleErr(e);
				});
			});
		}

		function deleteProfile(p) {
			if (busy) return;
			/* R09：校验 ISD-P AID 末 4 位（比 ICCID 末 4 位更有约束力，ICCID 已在表中明文可见）。
			 * 若 AID 缺省，回退为要求粘贴完整 ICCID。placeholder 清空，避免把答案直接暴露出来。 */
			var aidTail = (p.aid || '').slice(-4).toUpperCase();
			var needFullIccid = !aidTail;
			var expect = needFullIccid ? (p.iccid || '').toUpperCase() : aidTail;
			Mt5700.confirm('删除 Profile 不可逆，确定删除该 Profile？', function () {
				Ui.promptModal('确认删除', [
					{
						key: 'confirm',
						label: needFullIccid ? '请输入该 Profile 的完整 ICCID' : '请输入该 Profile 的 AID 末 4 位',
						type: 'text',
						placeholder: ''
					}
				], function (values) {
					var input = String(values.confirm || '').trim().toUpperCase();
					if (input !== expect) {
						Mt5700.error('输入不匹配，已取消删除');
						return;
					}
					busy = true;
					Euicc.deleteProfile(send, { kind: 'iccid', hex: p.iccidRaw }).then(function () {
						busy = false;
						var listCard = findListCard();
						if (listCard) loadProfiles(listCard);
					}).catch(function (e) {
						busy = false;
						handleErr(e);
					});
				});
			});
		}

		function findListCard() {
			var cards = body.querySelectorAll('.mt5700-card');
			for (var i = 0; i < cards.length; i++) {
				var title = cards[i].querySelector('.mt5700-card-title');
				if (title && /Profile 列表/.test(title.textContent)) return cards[i];
			}
			return null;
		}

		/* ---------- 入口：先探测引导态，再决定渲染 ---------- */
		function render() {
			body.innerHTML = '';
			body.appendChild(connBar);
			body.appendChild(Mt5700.loading('正在探测 eSIM…'));
			Euicc.probe(send).then(function (p) {
				if (p.state === 'no_card') renderNoCard();
				else if (p.state === 'no_csim') renderNoCsim(p);
				else if (p.state === 'no_euicc') renderNoEuicc();
				else if (p.state === 'error') renderError(p);
				else renderOk(p);
			}).catch(function (e) {
				renderError({ error: (e && e.code) || (e && e.message) || '未知错误' });
			});
		}

		/* ---------- 连接钩子（照抄 modem_settings：先 connect 再加载） ---------- */
		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						AtWs.client.connect(values.key).catch(function (e) {
							Mt5700.error((e && e.message) || '认证失败');
						});
					}
				});
				return;
			}
		}).then(function () {
			render();
		});

		/* ---------- 卸载复位 busy（P10） ---------- */
		page._onDispose(function () {
			busy = false;
		});

		return page;
	}
});
