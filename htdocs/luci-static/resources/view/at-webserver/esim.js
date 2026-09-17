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
 * 零新增二进制、不抢串口、不引入 lpac（见提案 §1.0）。
 * 本地管理（读 EID / 列 Profile / 启用 / 禁用 / 删除 / 改昵称）全部在前端完成。
 *
 * 下载新 Profile（2026-09-18 补齐）：
 *   - APDU 那一半（ES10b）本页自己拼，经 AT+CSIM 下发；
 *   - HTTPS 那一半（ES9+）浏览器做不了（SM-DP+ 不发 CORS 头），
 *     经新增的 ubus `mt5700.es9p` 由路由器上的 curl 代发一次 POST。
 *   录入支持：粘贴激活码 / 摄像头扫码 / 二维码图片 / 手动填 SM-DP+ 与匹配码，
 *   四条路都收口到 Euicc.parseActivationCode 校验。
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

		/*
		 * 卸载清理清单（V01）：
		 * 启用/禁用成功后会挂 8s 提示与 12s 延迟刷新，扫码还会占着摄像头。
		 * 页面切走时这些定时器/流还在跑 —— 轻则往已卸载的 DOM 里写，
		 * 重则让摄像头指示灯一直亮着。这里统一登记，_onDispose 一次性清掉。
		 */
		var cleanups = [];
		function later(fn, ms) {
			var t = setTimeout(function () {
				var i = cleanups.indexOf(t);
				if (i >= 0) cleanups.splice(i, 1);
				fn();
			}, ms);
			cleanups.push(t);
			return t;
		}

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
			} else if (code === 'EUICC_NO_ES9P') {
				msg = '设备侧缺少 ES9+ 通道（rpcd 没有 mt5700.es9p 或设备上没有 curl）'
					+ '，无法与运营商服务器通信';
			} else if (code === 'EUICC_ES9P_FAILED') {
				/* 服务器侧的失败原因必须原样带出来：不同运营商的报错差得很远，
				   统一成一句「下载失败」等于让用户无从下手。 */
				msg = (e && e.message) || '运营商服务器返回失败';
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

			card._body.appendChild(buildAddZone());
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

		/* ---------- ES9+ 通道（后端转发） ----------
		 * 浏览器直连运营商的 SM-DP+ 会被 CORS 拦掉（SM-DP+ 不发 CORS 头），
		 * 所以 HTTPS 那一半由路由器代发（ubus mt5700.es9p → curl）；
		 * APDU 那一半仍在浏览器侧经 AT+CSIM 完成。
		 * 这里把它包成 Euicc 需要的形状：(host, path, json) => Promise<{status, body}>。
		 */
		function es9pSend(host, path, json) {
			return AtWs.es9p(host, path, json).then(function (r) {
				if (!r || !r.success) {
					var e = new Error((r && r.error) || '服务器请求失败');
					e.code = 'EUICC_ES9P_FAILED';
					throw e;
				}
				return { status: r.status, body: r.body };
			});
		}

		/*
		 * 通道可用性只问一次：老固件的 rpcd 里没有 mt5700.es9p 这个 ubus 方法，
		 * 那时 L.rpc.declare 会直接被拒 —— 必须给出「设备侧缺通道」的明确说明，
		 * 而不是让「添加」按钮点了没反应。
		 */
		var es9pState = { asked: false, available: false, error: '' };
		function probeEs9p(cb) {
			if (es9pState.asked) { cb(); return; }
			es9pState.asked = true;
			AtWs.es9pAvailable().then(function (r) {
				es9pState.available = !!(r && r.available);
				es9pState.error = (r && r.error) || '';
			}, function () {
				es9pState.available = false;
				es9pState.error = '探测失败';
			}).then(function () { cb(); });
		}

		/* ---------- 添加 Profile（二维码 / 激活码 / 手动参数） ----------
		 *
		 * 三种录入方式都收口到同一个 parseActivationCode，差别只在「怎么把码弄进来」：
		 *   粘贴激活码 —— 最稳，任何环境都能用；
		 *   扫描 / 图片 —— 走浏览器原生 BarcodeDetector，只有在**安全上下文**
		 *                  （https 或 localhost）才存在；LuCI 是 http://192.168.x.x，
		 *                  所以这两项在大多数机器上不可用，届时按钮会被禁用并说明原因，
		 *                  绝不给一个点了没反应的假按钮。
		 *   手动填写   —— 运营商只给了 SM-DP+ 与匹配码（没有二维码）时的兜底。
		 */
		function buildAddZone() {
			var zone = E('div', { 'class': 'mt5700-mt-md' });
			zone.appendChild(E('div', { 'class': 'mt5700-danger-zone-title' }, '添加 Profile'));

			if (!es9pState.available) {
				zone.appendChild(E('p', { 'class': 'mt5700-hint' },
					'下载新 Profile 需要路由器能访问运营商的 SM-DP+ 服务器（ES9+ 通道）。'
					+ '当前不可用：' + (es9pState.error || '未探测到 mt5700.es9p 方法')
					+ '。请确认插件已升级到含该方法的版本、且设备上存在 curl。'));
				var off = Mt5700.button('添加 Profile', function () { }, 'primary');
				off.disabled = true;
				zone.appendChild(off);
				return zone;
			}

			zone.appendChild(E('p', { 'class': 'mt5700-hint' },
				'用运营商给的二维码或激活码下载并写入新 Profile。'
				+ '下载过程要与运营商服务器通信，期间请保持网络畅通、不要断电。'));
			var host = E('div', { 'class': 'mt5700-mt-sm' });
			zone.appendChild(host);
			zone.appendChild(E('div', { 'class': 'mt5700-mt-sm' },
				Mt5700.button('添加 Profile', function () { openAddWizard(host); }, 'primary'),
				document.createTextNode(' '),
				Mt5700.ghostButton('处理待发回执', function () { processNotifications(); })));
			zone.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
				'「处理待发回执」用于补发卡上没发出去的安装结果：'
				+ '装完 Profile 后卡会生成一条回执，服务器收不到就会一直挂着未确认。'));
			return zone;
		}

		function hasBarcodeDetector() {
			return (typeof window !== 'undefined') && !!window.BarcodeDetector;
		}

		function openAddWizard(host) {
			host.innerHTML = '';
			var box = E('div', { 'class': 'mt5700-card' });
			box.appendChild(E('div', { 'class': 'mt5700-card-header' },
				E('h3', { 'class': 'mt5700-card-title' }, '添加 Profile')));
			var b = E('div', { 'class': 'mt5700-card-body' });
			box.appendChild(b);
			host.appendChild(box);

			var mode = 'code';
			var stream = null;      /* 扫码用的摄像头流，关向导时必须停掉 */
			var scanTimer = null;

			var seg = Mt5700.segmented([
				{ label: '粘贴激活码', value: 'code' },
				{ label: '扫描二维码', value: 'scan' },
				{ label: '上传图片', value: 'image' },
				{ label: '手动填写', value: 'manual' }
			], mode, function (v) { stopScan(); mode = v; paintInput(); });
			b.appendChild(seg.el);
			if (!hasBarcodeDetector()) {
				b.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'本浏览器没有二维码识别能力（BarcodeDetector 只在 https 或 localhost 下提供）。'
					+ '用 https 访问路由器即可启用扫码，或直接粘贴激活码 / 手动填写。'));
			}

			var inputBox = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(inputBox);
			var preview = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(preview);
			var ccBox = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(ccBox);
			var actions = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(actions);
			var logBox = E('div', { 'class': 'mt5700-mt-sm' });
			b.appendChild(logBox);

			/* 三种模式下「当前这份激活码」的统一取法 */
			var codeInput = null, smdpInput = null, midInput = null, oidInput = null;
			var ccInput = null, ccChk = null;

			function currentCode() {
				if (mode === 'manual') {
					var o = {
						smdp: (smdpInput && smdpInput.value) || '',
						matchingId: (midInput && midInput.value) || '',
						oid: (oidInput && oidInput.value) || ''
					};
					if (ccChk && ccChk.checked) o.confirmationCodeRequired = true;
					return Euicc.buildActivationCode(o);
				}
				return (codeInput && codeInput.value) || '';
			}

			function showPreview() {
				preview.innerHTML = '';
				var p = Euicc.parseActivationCode(currentCode());
				if (!currentCode()) return;
				if (!p.ok) {
					preview.appendChild(E('div', { 'class': 'mt5700-notice-warning' }, p.error));
					renderCc(p);
					return;
				}
				var rows = [
					['SM-DP+ 服务器', p.smdp],
					['匹配码', p.matchingId]
				];
				if (p.oid) rows.push(['OID', p.oid]);
				rows.push(['确认码', p.confirmationCodeRequired === true ? '必填'
					: (p.confirmationCodeRequired === false ? '不需要' : '服务器未声明')]);
				preview.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
				renderCc(p);
			}

			function renderCc(p) {
				ccBox.innerHTML = '';
				var need = p.ok && p.confirmationCodeRequired !== false;
				if (!need) return;
				ccInput = Mt5700.input('text', '确认码（区分大小写）');
				ccInput.type = 'password';
				ccBox.appendChild(Mt5700.formGroup('确认码', ccInput,
					p.confirmationCodeRequired === true
						? '该激活码声明需要确认码，必填'
						: '若运营商要求则填写；留空表示不发送确认码'));
			}

			function stopScan() {
				if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
				if (stream) {
					try {
						stream.getTracks().forEach(function (t) { t.stop(); });
					} catch (e) { /* 停不掉就算了，页面卸载时浏览器也会回收 */ }
					stream = null;
				}
			}
			cleanups.push(stopScan);

			function paintInput() {
				inputBox.innerHTML = '';
				preview.innerHTML = '';
				ccBox.innerHTML = '';
				ccInput = null;

				if (mode === 'code') {
					codeInput = E('textarea', {
						'class': 'mt5700-input', 'rows': 3,
						'placeholder': 'LPA:1$smdp.example.com$MATCHING-ID'
					});
					codeInput.style.width = '100%';
					codeInput.addEventListener('input', showPreview);
					inputBox.appendChild(Mt5700.formGroup('激活码', codeInput,
						'运营商给的二维码扫出来就是这串；也可以直接粘贴。'));
					return;
				}

				if (mode === 'scan') {
					if (!hasBarcodeDetector()) {
						inputBox.appendChild(E('div', { 'class': 'mt5700-notice-warning' },
							'当前环境不支持扫码，请改用「粘贴激活码」或「手动填写」。'));
						return;
					}
					var video = E('video');
					video.style.width = '100%';
					video.style.maxWidth = '360px';
					video.setAttribute('playsinline', '');
					inputBox.appendChild(video);
					var tip = E('p', { 'class': 'mt5700-hint' }, '正在启动摄像头…');
					inputBox.appendChild(tip);
					codeInput = Mt5700.input('text', '扫码结果');
					codeInput.addEventListener('input', showPreview);
					inputBox.appendChild(Mt5700.formGroup('扫码结果', codeInput, '也可手动修正'));

					navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
						.then(function (s) {
							stream = s;
							video.srcObject = s;
							video.play();
							var det = new window.BarcodeDetector({ formats: ['qr_code'] });
							tip.textContent = '把运营商的二维码对准摄像头…';
							(function loop() {
								scanTimer = setTimeout(function () {
									if (!stream) return;
									det.detect(video).then(function (codes) {
										if (codes && codes.length) {
											codeInput.value = String(codes[0].rawValue || '');
											tip.textContent = '已识别，确认无误后点「开始下载」。';
											stopScan();
											showPreview();
											return;
										}
										if (stream) loop();
									}).catch(function () { if (stream) loop(); });
								}, 300);
							})();
						}).catch(function (e) {
							tip.textContent = '摄像头启动失败：' + ((e && e.message) || '无权限或不支持')
								+ '（请改用「粘贴激活码」或「上传图片」）';
						});
					return;
				}

				if (mode === 'image') {
					if (!hasBarcodeDetector()) {
						inputBox.appendChild(E('div', { 'class': 'mt5700-notice-warning' },
							'当前环境不支持识别二维码图片，请改用「粘贴激活码」或「手动填写」。'));
						return;
					}
					var file = E('input', { 'class': 'mt5700-input', 'type': 'file', 'accept': 'image/*' });
					var tip = E('p', { 'class': 'mt5700-hint' }, '选择运营商给的二维码截图。');
					inputBox.appendChild(Mt5700.formGroup('二维码图片', file, '图片只在本机解码，不上传'));
					codeInput = Mt5700.input('text', '识别结果');
					codeInput.addEventListener('input', showPreview);
					inputBox.appendChild(Mt5700.formGroup('识别结果', codeInput, '也可手动修正'));
					file.addEventListener('change', function () {
						if (!file.files || !file.files[0]) return;
						var det = new window.BarcodeDetector({ formats: ['qr_code'] });
						tip.textContent = '识别中…';
						/* 优先用 ImageBitmap（解码更稳），失败了退回 <img> */
						var bitmap = null;
						Promise.resolve()
							.then(function () {
								if (typeof createImageBitmap === 'function') {
									return createImageBitmap(file.files[0]).then(function (bm) {
										bitmap = bm;
										return bm;
									});
								}
								return null;
							})
							.then(function (src) { return det.detect(src || file.files[0]); })
							.then(function (codes) {
								if (bitmap && bitmap.close) bitmap.close();
								if (!codes || !codes.length) {
									tip.textContent = '这张图里没识别到二维码，换一张或改用「粘贴激活码」。';
									return;
								}
								codeInput.value = String(codes[0].rawValue || '');
								tip.textContent = '已识别，确认无误后点「开始下载」。';
								showPreview();
							}).catch(function (e) {
								tip.textContent = '识别失败：' + ((e && e.message) || '不支持的图片');
							});
					});
					inputBox.appendChild(tip);
					return;
				}

				/* manual */
				smdpInput = Mt5700.input('text', 'smdp.example.com');
				midInput = Mt5700.input('text', 'MATCHING-ID');
				oidInput = Mt5700.input('text', '可留空');
				ccChk = E('input', { 'type': 'checkbox' });
				var sync = function () { showPreview(); };
				smdpInput.addEventListener('input', sync);
				midInput.addEventListener('input', sync);
				oidInput.addEventListener('input', sync);
				inputBox.appendChild(Mt5700.formGroup('SM-DP+ 服务器', smdpInput, '运营商给的下载服务器域名'));
				inputBox.appendChild(Mt5700.formGroup('匹配码', midInput, 'Activation Code / Matching ID'));
				inputBox.appendChild(Mt5700.formGroup('OID', oidInput, '多数运营商不需要'));
				inputBox.appendChild(E('label', { 'class': 'mt5700-hint' },
					ccChk, document.createTextNode(' 该运营商要求确认码')));
			}

			function start() {
				if (busy) return;
				var p = Euicc.parseActivationCode(currentCode());
				if (!p.ok) { Mt5700.error(p.error); return; }
				var cc = (ccInput && ccInput.value) ? ccInput.value.trim() : '';
				if (p.confirmationCodeRequired === true && !cc) {
					Mt5700.error('该激活码要求填写确认码');
					return;
				}
				Mt5700.confirm('开始从 ' + p.smdp + ' 下载并写入新 Profile？'
					+ '写入过程中不要断电或断开网络。', function () {
						runDownload(p, cc);
					}, '开始下载');
			}

			function runDownload(p, cc) {
				busy = true;
				actions.innerHTML = '';
				logBox.innerHTML = '';
				var stepEl = E('div', { 'class': 'mt5700-notice' }, '准备中…');
				logBox.appendChild(stepEl);
				var pre = E('div', { 'class': 'mt5700-mono' });
				logBox.appendChild(pre);
				var lines = [];
				function log(s) {
					lines.push(String(s));
					pre.textContent = lines.slice(-40).join('\n');
				}
				Euicc.downloadProfile(send, es9pSend, {
					activation: p,
					confirmationCode: cc,
					onStep: function (n, text) {
						stepEl.textContent = '步骤 ' + n + '/10：' + text;
					},
					log: log
				}).then(function (r) {
					busy = false;
					stepEl.textContent = '下载完成。';
					Mt5700.success('Profile 已写入，正在刷新列表…');
					var listCard = findListCard();
					if (listCard) later(function () { loadProfiles(listCard); }, 3000);
					else later(function () { render(); }, 3000);
				}).catch(function (e) {
					busy = false;
					stepEl.textContent = '下载失败：' + ((e && e.message) || '未知错误');
					handleErr(e);
				});
			}

			paintInput();
			actions.appendChild(Mt5700.primaryButton('开始下载', function () { start(); }));
			actions.appendChild(document.createTextNode(' '));
			actions.appendChild(Mt5700.ghostButton('取消', function () {
				stopScan();
				host.innerHTML = '';
			}));
		}

		/* 补发卡上攒着的安装回执（用别的工具装了 Profile 时也需要这一步） */
		function processNotifications() {
			if (busy) return;
			busy = true;
			Euicc.processNotifications(send, es9pSend, {
				log: function (s) {
					if (typeof console !== 'undefined' && console.info) console.info('[esim] ' + s);
				}
			}).then(function (r) {
				busy = false;
				if (!r.total) { Mt5700.info('卡上没有待发的回执'); return; }
				Mt5700.success('已发出 ' + r.sent + '/' + r.total + ' 条回执');
			}).catch(function (e) {
				busy = false;
				handleErr(e);
			});
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
				listCard._body.appendChild(buildAddZone());
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
			listCard._body.appendChild(buildAddZone());
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
					later(function () { if (note.parentNode) note.parentNode.removeChild(note); }, 8000);
					/* R07：成功后模组正在重注册，CSIM 大概率 +CME ERROR:14 / 无响应。
					 * 延后约 12 秒再刷新；刷新失败保留旧列表，只用提示，不用 errorState 覆盖。 */
					var listCard = findListCard();
					if (listCard) {
						later(function () {
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
				/* 「添加」区要用到 ES9+ 通道的可用性，先问一次再渲染，
				   否则那块区域会先画出来再变一次，观感是闪一下。 */
				probeEs9p(function () {
					if (p.state === 'no_card') renderNoCard();
					else if (p.state === 'no_csim') renderNoCsim(p);
					else if (p.state === 'no_euicc') renderNoEuicc();
					else if (p.state === 'error') renderError(p);
					else renderOk(p);
				});
			}).catch(function (e) {
				renderError({ error: (e && e.code) || (e && e.message) || '未知错误' });
			});
		}

		/* ---------- 连接钩子（照抄 modem_settings：先 connect 再加载） ---------- */
		AtWs.client.connect().catch(function (err) {
			if (err && err.message === 'REQUIRE_AUTH_KEY') {
				Ui.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (values) {
					if (values.key) {
						/* ★ 认证成功后必须自己重渲染一次：外层那个 .then(render)
						   在认证弹窗弹出时就已经跑过了（跑在未认证状态下，
						   探测必然失败），不补这一次页面会一直停在错误态。 */
						AtWs.client.connect(values.key).then(function () {
							render();
						}).catch(function (e) {
							Mt5700.error((e && e.message) || '认证失败');
						});
					}
				});
				return;
			}
		}).then(function () {
			render();
		});

		/* ---------- 卸载复位 busy + 清理定时器/摄像头（P10 / V01） ---------- */
		page._onDispose(function () {
			busy = false;
			cleanups.forEach(function (c) {
				if (typeof c === 'function') { try { c(); } catch (e) { } }
				else clearTimeout(c);
			});
			cleanups.length = 0;
		});

		return page;
	}
});
