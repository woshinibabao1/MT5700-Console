'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/smsEncode';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Ui, SmsEncode, Mt5700 */

/**
 * 短信中心 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * - 联系人聚合（按号码分组，按最后消息时间排序）
 * - 会话视图（聊天样式）、发送（自动编码 PDU + 长短信分片）
 * - 新短信推送实时更新（new_sms）
 * - 单条删除 / 批量删除、存储量显示
 * - 缓存已发消息到 localStorage
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('短信中心', '收发短信与联系人会话');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		var state = {
			contacts: [],        // [{ number, lastMessage, lastTime, unreadCount, messages: [] }]
			selectedContact: '',
			messages: [],        // 当前联系人消息
			storage: { used: 0, total: 0 }
		};

		/* ---------- 布局 ---------- */
		var layout = E('div', { 'class': 'mt5700-sms-layout' });
		body.appendChild(layout);

		// 左：联系人
		var left = E('div', { 'class': 'mt5700-sms-list' });
		var leftHead = E('div', { 'class': 'mt5700-sms-list-header' });
		var storageEl = E('div', { 'class': 'mt5700-hint' }, '存储：—');
		leftHead.appendChild(storageEl);
		left.appendChild(leftHead);
		var contactList = E('div', { 'class': 'mt5700-sms-list-body' });
		left.appendChild(contactList);
		var newContactWrap = E('div', { 'class': 'mt5700-sms-input' });
		newContactWrap.appendChild(Mt5700.primaryButton('+ 新短信', function () {
			Ui.promptModal('新短信', [
				{ key: 'number', label: '收件人号码', placeholder: '请输入 5-19 位手机号码' }
			], function (values) {
				var num = (values.number || '').trim();
				if (!num) { Mt5700.warning('请输入联系人号码'); return; }
				if (!Parse.isValidPhoneNumber(num)) { Mt5700.warning('请输入正确的 5-19 位手机号码'); return; }
				state.selectedContact = num;
				state.messages = [];
				renderContacts();
				renderConversation();
			});
		}));
		left.appendChild(newContactWrap);
		layout.appendChild(left);

		// 右：会话
		var right = E('div', { 'class': 'mt5700-sms-detail' });
		var convHead = E('div', { 'class': 'mt5700-sms-detail-header' }, '请选择联系人');
		right.appendChild(convHead);
		var convBody = E('div', { 'class': 'mt5700-sms-detail-body' });
		right.appendChild(convBody);

		var inputWrap = E('div', { 'class': 'mt5700-sms-input' });
		var msgInput = E('textarea', {
			'class': 'mt5700-input',
			rows: '3',
			placeholder: '输入短信内容，回车发送（Shift+Enter 换行）'
		});
		msgInput.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
		});
		var hintEl = E('div', { 'class': 'mt5700-hint' }, '');
		inputWrap.appendChild(msgInput);
		inputWrap.appendChild(hintEl);

		var sendBtn = Mt5700.primaryButton('发送', function () { send(); });
		inputWrap.appendChild(Mt5700.panelActions(
			sendBtn,
			Mt5700.dangerButton('批量删除', function () { batchDelete(); })
		));
		right.appendChild(inputWrap);
		layout.appendChild(right);

		/* ---------- 渲染 ---------- */

		function normalizeNumber(n) { return Parse.normalizePhoneNumber(n); }

		/* ---------- 未读标记 ---------- */
		/*
		 * 为什么不能只依赖模组的状态位：鼎桥 AT 手册 9.8 / 9.10 写明，本模组的
		 * +CMGL 与 +CMGR 读取成功后都会把「收到的未读短信」置为「已读」。
		 * 而服务端收到 +CMTI 后会立刻 AT+CMGR 取内容用于通知，前端每次刷新又是一次
		 * AT+CMGL=4 —— 短信往往还没等用户看到，状态就已经被读成「已读」了。
		 * 实测也印证：真机 17 条短信的 <stat> 全是 1，一条未读都没有。
		 *
		 * 所以这里以「号码」为键自行记录未读，两个来源取并集：
		 *   A. 新短信推送：短信刚到达、用户还没点开，必然是未读；
		 *   B. 列表里仍带着未读状态（<stat>=0）的短信：服务未运行期间到达的情形。
		 *
		 * 用号码而不是 index 做键：短信删除后存储位置会被复用，用 index 会张冠李戴。
		 */
		var UNREAD_KEY = 'mt5700_sms_unread_numbers';
		var unreadNumbers = (function () {
			try {
				var arr = JSON.parse(localStorage.getItem(UNREAD_KEY) || '[]');
				return Array.isArray(arr) ? arr.filter(function (x) { return typeof x === 'string'; }) : [];
			} catch (e) { return []; }
		})();

		function saveUnread() {
			try { localStorage.setItem(UNREAD_KEY, JSON.stringify(unreadNumbers.slice(-200))); } catch (e) {}
		}

		function markUnread(num) {
			num = normalizeNumber(num || '');
			if (!num || unreadNumbers.indexOf(num) >= 0) return;
			unreadNumbers.push(num);
			saveUnread();
		}

		function clearUnread(num) {
			num = normalizeNumber(num || '');
			var i = unreadNumbers.indexOf(num);
			if (i >= 0) { unreadNumbers.splice(i, 1); saveUnread(); }
			/*
			 * 同时清掉内存里这些短信自带的未读标记。否则同一次会话内再调
			 * buildContacts 时，来源 B 会依据仍是 true 的 msg.unread 把它们标回未读，
			 * 表现为「点开了，未读徽章却又冒出来」。
			 */
			for (var ci = 0; ci < state.contacts.length; ci++) {
				if (state.contacts[ci].number !== num) continue;
				var c = state.contacts[ci];
				var msgs = c.messages;
				for (var mi = 0; mi < msgs.length; mi++) msgs[mi].unread = false;
				/*
				 * 会话自己缓存的未读数也要一起清零。renderContacts 读的是 c.unread，
				 * 它是 buildContacts 时算好的；只清名单和 msg.unread 的话，
				 * 徽章会一直留在屏幕上（真机实测到过：名单已空，徽章还在）。
				 */
				c.unreadCount = 0;
				c.unread = false;
			}
		}

		function isUnread(num) {
			return unreadNumbers.indexOf(normalizeNumber(num || '')) >= 0;
		}

		// 长短信拼接：把同一发件人、同一拼接引用号的各段合并为一条完整消息
		function mergeConcatenated(list) {
			var groups = {};
			var result = [];
			for (var i = 0; i < list.length; i++) {
				var m = list[i];
				if (m && m.type === 'received' && m.isConcatenated && m.concatenatedRef != null && m.concatenatedSeq != null) {
					var key = (m.number || '') + '|' + m.concatenatedRef;
					if (!groups[key]) groups[key] = [];
					groups[key].push(m);
				} else {
					result.push(m);
				}
			}
			for (var k in groups) {
				var parts = groups[k];
				parts.sort(function (a, b) { return (a.concatenatedSeq || 0) - (b.concatenatedSeq || 0); });
				var full = '';
				for (var j = 0; j < parts.length; j++) full += (parts[j].content || '');
				var first = parts[0];
				var last = parts[parts.length - 1];
				var idxs = [];
				for (var p = 0; p < parts.length; p++) if (parts[p].index != null) idxs.push(parts[p].index);
				result.push({
					index: first.index,
					partIndices: idxs,
					content: full,
					number: first.number,
					time: last.time,
					type: 'received',
					isConcatenated: false,
					concatenatedRef: first.concatenatedRef,
					concatenatedTotal: undefined,
					concatenatedSeq: undefined,
					partsCount: parts.length,
					partsExpected: first.concatenatedTotal
				});
			}
			return result;
		}

		function renderStorage() {
			storageEl.textContent = '存储：' + state.storage.used + ' / ' + state.storage.total;
		}

		function renderContacts() {
			contactList.innerHTML = '';
			if (!state.contacts.length) {
				contactList.appendChild(Mt5700.empty('暂无短信'));
			}
			for (var i = 0; i < state.contacts.length; i++) {
				var c = state.contacts[i];
				var item = E('div', {
					'class': 'mt5700-sms-item' + (c.number === state.selectedContact ? ' active' : '')
				});
				var numEl = E('div', { 'class': 'mt5700-sms-item-number' }, c.number);
				if (c.unread) {
					numEl.appendChild(document.createTextNode(' '));
					numEl.appendChild(Mt5700.badge(
						c.unreadCount > 1 ? ('未读 ' + c.unreadCount) : '未读', 'info'));
				}
				item.appendChild(numEl);
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, c.lastMessage || ''));
				item.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, c.lastTime || ''));
				item.addEventListener('click', function (num) {
					return function () { selectContact(num); };
				}(c.number));
				contactList.appendChild(item);
			}
		}

		function renderConversation() {
			convHead.innerHTML = '';
			convHead.appendChild(E('div', { 'class': 'mt5700-sms-item-number' },
				state.selectedContact ? '与 ' + state.selectedContact + ' 的会话' : '请选择联系人'));
			convBody.innerHTML = '';
			if (!state.messages.length) {
				convBody.appendChild(Mt5700.empty('暂无消息，输入内容发送'));
			}
			for (var i = 0; i < state.messages.length; i++) {
				var m = state.messages[i];
				var isSent = m.type === 'sent';
				var bubble = E('div', { 'class': 'mt5700-sms-bubble ' + (isSent ? 'mt5700-sms-bubble-sent' : 'mt5700-sms-bubble-recv') });
				bubble.appendChild(E('div', {}, m.content || '(空消息)'));
				bubble.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' }, m.time || ''));
				if (m.partsExpected != null && m.partsCount != null && m.partsCount < m.partsExpected) {
					bubble.appendChild(E('div', { 'class': 'mt5700-sms-item-preview' },
						'长短信已合并 ' + m.partsCount + '/' + m.partsExpected + ' 段（部分缺失）'));
				}
				var del = Mt5700.button('删除', function (mm) {
					return function () {
						Mt5700.confirm('确定删除该短信？', function () { deleteMessage(mm); });
					};
				}(m), 'danger');
				del.className = 'mt5700-btn mt5700-btn-danger mt5700-sms-del';
				bubble.appendChild(del);
				convBody.appendChild(bubble);
			}
			convBody.scrollTop = convBody.scrollHeight;
		}

		function renderHint() {
			var text = msgInput.value.trim();
			if (!text) { hintEl.textContent = ''; return; }
			var stats = SmsEncode.messageStats(text);
			var parts = stats.encoding === 'UCS2' ? '含中文等字符，按 UCS2 编码' : '纯 ASCII，按 GSM 7bit 编码';
			hintEl.textContent = stats.chars + ' 字 · ' + parts + (stats.parts > 1 ? ' · 将拆成 ' + stats.parts + ' 条' : '');
		}
		msgInput.addEventListener('input', renderHint);

		/* ---------- 数据 ---------- */

		function refreshStorage() {
			/* 注意：命令是 AT+CPMS?（标准 3GPP）。此前误写成 AT^CPMS?，
			   而本模组并不支持 ^CPMS，导致短信存储用量一直是空的。 */
			return AtWs.client.sendCommand('AT+CPMS?').then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\+CPMS: "\w+",(\d+),(\d+)/);
					if (m) {
						state.storage = { used: parseInt(m[1], 10), total: parseInt(m[2], 10) };
						renderStorage();
					}
				}
			}).catch(function () {});
		}

		function refresh() {
			return AtWs.client.sendCommand('AT+CMGL=4').then(function (res) {
				if (!res.success) {
					if (res.error && String(res.error).indexOf('CME ERROR') >= 0) {
						Mt5700.warning('短信功能可能未开启，请到「短信设置」开启');
					} else {
						Mt5700.error(String(res.error || '获取短信列表失败'));
					}
					return;
				}
				var raw = typeof res.data === 'string' ? res.data : '';
				var parsed = (raw && raw !== 'OK' && raw !== 'NO SMS') ? Parse.parseCMGL(raw) : [];
				var cached = Parse.getCachedSentMessages();
				buildContacts(parsed.concat(cached));
			}).catch(function () {
				Mt5700.error('获取短信列表失败');
			});
		}

		function buildContacts(list) {
			list = mergeConcatenated(list);
			var map = {};
			for (var i = 0; i < list.length; i++) {
				var msg = list[i];
				var num = normalizeNumber(msg.number);
				if (!num) continue;
				// 来源 B：列表里确实还带着未读状态（<stat>=0）的短信
				if (msg.unread) markUnread(num);
				if (!map[num]) {
					map[num] = { number: num, lastMessage: msg.content, lastTime: msg.time, unreadCount: 0, messages: [] };
				}
				map[num].messages.push(msg);
				var t = Parse.parseMessageTime(msg.time).getTime();
				if (t >= Parse.parseMessageTime(map[num].lastTime).getTime()) {
					map[num].lastMessage = msg.content;
					map[num].lastTime = msg.time;
				}
			}
			var list2 = [];
			for (var key in map) {
				var c = map[key];
				c.messages.sort(function (a, b) {
					return Parse.parseMessageTime(a.time).getTime() - Parse.parseMessageTime(b.time).getTime();
				});
				/*
				 * 未读数优先按短信自身的状态位统计；一条都没标时，若该号码被新短信
				 * 推送标过未读，至少算 1 条（那种情况只知道号码、不知道具体哪几条）。
				 */
				var unreadN = 0;
				for (var mi = 0; mi < c.messages.length; mi++) {
					if (c.messages[mi].unread) unreadN++;
				}
				c.unreadCount = unreadN || (isUnread(c.number) ? 1 : 0);
				c.unread = c.unreadCount > 0;
				list2.push(c);
			}

			// 短信删掉后把它的号码从未读名单里摘掉，避免名单无界增长
			var known = {};
			for (var k2 in map) known[k2] = 1;
			var kept = unreadNumbers.filter(function (n) { return known[n]; });
			if (kept.length !== unreadNumbers.length) { unreadNumbers = kept; saveUnread(); }
			list2.sort(function (a, b) {
				return Parse.parseMessageTime(b.lastTime).getTime() - Parse.parseMessageTime(a.lastTime).getTime();
			});
			state.contacts = list2;
			if (state.selectedContact) {
				var sel = null;
				for (var j = 0; j < list2.length; j++) {
					if (normalizeNumber(list2[j].number) === normalizeNumber(state.selectedContact)) { sel = list2[j]; break; }
				}
				state.messages = sel ? sel.messages : [];
			}
			renderContacts();
			renderConversation();
		}

		function selectContact(num) {
			state.selectedContact = num;
			clearUnread(num);        // 打开会话即视为已读
			state.messages = [];
			for (var i = 0; i < state.contacts.length; i++) {
				if (normalizeNumber(state.contacts[i].number) === normalizeNumber(num)) {
					state.messages = state.contacts[i].messages;
					break;
				}
			}
			renderContacts();
			renderConversation();
		}

		/* ---------- 发送 ---------- */

		function nowTimeStr() {
			var d = new Date();
			var pad = function (n) { return String(n).padStart(2, '0'); };
			return pad(d.getFullYear() % 100) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
				',' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
		}

		/*
		 * 轮询后台短信任务结果。
		 * 后端把 AT+CMGS 转入独立任务后立刻返回受理，这里按 ~350ms 轮询
		 * AT+SMSJOB?，直到任务结束或超时（默认 20s）。
		 * 注意：轮询走的是短信专用查询命令，不会被「发送中」的忙状态挡住。
		 */
		function waitSmsJob(timeoutMs) {
			var deadline = Date.now() + (timeoutMs || 20000);
			return new Promise(function (resolve, reject) {
				var tick = function () {
					AtWs.client.sendCommand('AT+SMSJOB?').then(function (res) {
						var st = null;
						try { st = JSON.parse(String(res && res.data ? res.data : '{}')); }
						catch (e) { st = null; }
						if (!st || typeof st.running !== 'boolean') {
							reject(new Error('无法获取短信任务状态'));
							return;
						}
						if (st.running) {
							if (Date.now() > deadline) { reject(new Error('等待模组确认超时')); return; }
							setTimeout(tick, 350);
							return;
						}
						if (st.ok) resolve(st.message || '发送成功');
						else reject(new Error(st.message || '发送失败'));
					}).catch(function (err) {
						reject(new Error(String((err && err.message) || err || '查询任务状态失败')));
					});
				};
				setTimeout(tick, 300);
			});
		}

		/* 解析 AT+CMGF? 的应答：0 = PDU，1 = Text；取不到按 PDU 处理 */
		function parseCmgf(res) {
			var m = String((res && res.data) || '').match(/\+CMGF:\s*(\d)/);
			return m ? parseInt(m[1], 10) : 0;
		}

		/*
		 * 提交一条短信命令并取结果（PDU / Text 两种模式共用）。
		 *
		 * 后端会把 AT+CMGS 转入独立任务、先回 SMS_ACCEPTED，这里再轮询
		 * AT+SMSJOB? 拿最终结果；旧后端是同步返回，此时必须看到 +CMGS / OK
		 * 才算成功 —— 只回显命令而没有 +CMGS，说明模组没接受数据，不能报成功。
		 */
		function submitSms(cmd) {
			return AtWs.client.sendCommand(cmd).then(function (res) {
				if (!res || res.success === false) {
					throw new Error(String((res && res.error) || '发送失败'));
				}
				var txt = String(res.data == null ? '' : res.data);
				if (/\bERROR\b/i.test(txt)) {
					throw new Error('模组返回错误：' + txt.replace(/\s+/g, ' ').trim());
				}
				if (txt.indexOf('SMS_ACCEPTED') >= 0) {
					return waitSmsJob();
				}
				if (!/(\+CMGS:|\bOK\b)/.test(txt)) {
					throw new Error('模组未确认短信提交（无 +CMGS/OK 应答，短信未发出）');
				}
				return txt;
			});
		}

		/*
		 * PDU 模式（AT+CMGF=0）发送。
		 * 命令形态见 SmsEncode.buildPduSendCommand 的注释：命令与 PDU 之间必须用
		 * 字面 "\r" 分隔，整条命令只在末尾有一个回车（由后端补）。
		 */
		function sendPduMode(target, content) {
			return AtWs.client.sendCommand('AT+CMGF?')
				.then(function (res) {
					if (parseCmgf(res) === 1) {
						return AtWs.client.sendCommand('AT+CMGF=0');
					}
					return { success: true };
				})
				.then(function () { return AtWs.client.sendCommand('AT+CSCA?'); })
				.then(function (res) {
					var smsc = '';
					if (res.success && res.data) {
						var m = String(res.data).match(/\+CSCA: "([^"]+)"/);
						if (m) smsc = m[1];
					}
					/*
					 * 保留号码开头的 '+'：TP-DA 的类型字节（TOA）要靠它区分
					 * 0x91（国际号码，带国家码）与 0x81（国内/未知）。
					 * 编码器内部自己会过滤非数字字符，不需要在这里预处理。
					 */
					var parts = SmsEncode.buildSubmitParts({ smsc: smsc, destination: target, message: content });
					var c = Promise.resolve();
					for (var i = 0; i < parts.length; i++) {
						c = c.then(function (part) {
							return submitSms(SmsEncode.buildPduSendCommand(part));
						}.bind(null, parts[i]));
					}
					return c;
				});
		}

		/*
		 * Text 模式（AT+CMGF=1）发送。
		 *  - 纯 ASCII 且不超过 160 字符：直接下发明文；
		 *  - 含中文：临时切 AT+CSCS="UCS2"，号码与正文都写成 UCS2 十六进制，
		 *    发完立刻切回 IRA（字符集是全局设置，不恢复会让整条 AT 通道的
		 *    应答都变成 UCS2 编码，其它页面集体读不出来）；
		 *  - 超长：Text 模式没有分片语法（拼接头只能自己写 PDU），
		 *    降级为 PDU 模式发送，发完再切回 Text。
		 */
		function sendTextMode(target, content) {
			var ucs2 = SmsEncode.usesUcs2(content);
			var limit = ucs2 ? SmsEncode.TEXT_MAX_UCS2 : SmsEncode.TEXT_MAX_ASCII;
			if (content.length > limit) {
				return AtWs.client.sendCommand('AT+CMGF=0')
					.then(function () { return sendPduMode(target, content); })
					.then(function (r) {
						return AtWs.client.sendCommand('AT+CMGF=1')
							.then(function () { return r; }, function () { return r; });
					});
			}

			var plan = SmsEncode.buildTextSendCommand({ destination: target, message: content });
			var restore = function () {
				var c = Promise.resolve();
				(plan.post || []).forEach(function (cmd) {
					c = c.then(function () { return AtWs.client.sendCommand(cmd); });
				});
				return c;
			};
			var run = Promise.resolve();
			(plan.pre || []).forEach(function (cmd) {
				run = run.then(function () { return AtWs.client.sendCommand(cmd); });
			});
			run = run.then(function () { return submitSms(plan.cmd); });
			// 成功失败都要恢复现场
			return run.then(
				function (r) { return restore().then(function () { return r; }, function () { return r; }); },
				function (e) { return restore().then(function () { throw e; }, function () { throw e; }); }
			);
		}

		function send(explicitTarget) {
			var content = msgInput.value.trim();
			if (!content) { Mt5700.warning('请输入短信内容'); return; }
			var target = (explicitTarget || '').trim() || state.selectedContact || '';
			if (!target) { Mt5700.warning('请输入联系人号码'); return; }
			if (!Parse.isValidPhoneNumber(target)) { Mt5700.warning('请输入正确的 5-19 位手机号码'); return; }

			sendBtn.disabled = true;
			/*
			 * 跟随模组当前的短信格式，而不是强扭成 PDU：
			 * 模组可能正被别的工具（或用户自己）设在 Text 模式，强行切换会改动
			 * 别人的现场；两种模式我们都支持，按当前模式构造命令即可。
			 */
			var chain = AtWs.client.sendCommand('AT+CMGF?')
				.then(function (res) {
					return (parseCmgf(res) === 1)
						? sendTextMode(target, content)
						: sendPduMode(target, content);
				});

			chain.then(function (lastRes) {
				if (lastRes && lastRes.success === false) throw new Error(String(lastRes.error || '发送失败'));
				var sent = {
					index: -Date.now(),
					content: content,
					number: target,
					time: nowTimeStr(),
					type: 'sent'
				};
				Parse.saveSentMessageToCache(sent);
				state.messages.push(sent);
				msgInput.value = '';
				renderHint();
				renderConversation();
				Mt5700.success('发送成功');
				refresh();
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '发送失败');
			}).then(function () { sendBtn.disabled = false; });
		}

		/* ---------- 删除 ---------- */

		function deleteMessage(msg) {
			var storedIndices = (msg.partIndices && msg.partIndices.length)
				? msg.partIndices
				: (msg.index != null && msg.index >= 0 ? [msg.index] : []);
			if (storedIndices.length) {
				var chain = Promise.resolve();
				storedIndices.forEach(function (ix) {
					if (ix != null && ix >= 0) {
						chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGD=' + ix); });
					}
				});
				chain.then(function () { Mt5700.success('删除成功'); refresh(); })
					.catch(function () { Mt5700.error('删除失败'); });
			} else {
				// 缓存中的已发消息
				var updated = Parse.getCachedSentMessages().filter(function (m) { return m.index !== msg.index; });
				try { localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(updated)); } catch (e) {}
				Mt5700.success('删除成功');
				refresh();
			}
		}

		function batchDelete() {
			var mask = E('div', { 'class': 'mt5700-modal-mask' });
			var box = E('div', { 'class': 'mt5700-modal' });
			box.appendChild(E('div', { 'class': 'mt5700-modal-title' }, '批量删除短信'));
			var listEl = E('div', { 'class': 'mt5700-agree-list' });
			var checked = [];
			for (var i = 0; i < state.messages.length; i++) {
				var m = state.messages[i];
				var row = E('label', { 'class': 'mt5700-inline' });
				var chk = E('input', { type: 'checkbox' });
				(function (msg, cb) {
					cb.addEventListener('change', function () {
						var idx = checked.indexOf(msg);
						if (cb.checked && idx < 0) checked.push(msg);
						if (!cb.checked && idx >= 0) checked.splice(idx, 1);
					});
				})(m, chk);
				row.appendChild(chk);
				row.appendChild(E('span', { 'class': 'mt5700-hint' },
					(m.type === 'sent' ? '[发] ' : '[收] ') + (m.number || '') + '：' + (m.content || '').slice(0, 30)));
				listEl.appendChild(row);
			}
			if (!state.messages.length) listEl.appendChild(Mt5700.empty('当前会话没有可删除的短信'));
			var actions = E('div', { 'class': 'mt5700-modal-footer' });
			actions.appendChild(Mt5700.ghostButton('取消', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
			}));
			actions.appendChild(Mt5700.dangerButton('删除所选', function () {
				if (mask.parentNode) mask.parentNode.removeChild(mask);
				if (!checked.length) { Mt5700.warning('请先选择要删除的短信'); return; }
				var chain = Promise.resolve();
				checked.forEach(function (m) {
					var idxs = (m.partIndices && m.partIndices.length)
						? m.partIndices
						: (m.index != null && m.index >= 0 ? [m.index] : []);
					idxs.forEach(function (ix) {
						if (ix != null && ix >= 0) {
							chain = chain.then(function () { return AtWs.client.sendCommand('AT+CMGD=' + ix); });
						}
					});
				});
				chain.then(function () {
					var cachedIds = checked.filter(function (m) { return m.index < 0; }).map(function (m) { return m.index; });
					if (cachedIds.length) {
						var updated = Parse.getCachedSentMessages().filter(function (m) { return cachedIds.indexOf(m.index) < 0; });
						try { localStorage.setItem(Parse.SMS_CACHE_KEY, JSON.stringify(updated)); } catch (e) {}
					}
					Mt5700.success('成功删除 ' + checked.length + ' 条短信');
					refresh();
				}).catch(function () { Mt5700.error('批量删除失败'); });
			}));
			box.appendChild(listEl);
			box.appendChild(actions);
			mask.appendChild(box);
			mask.addEventListener('click', function (e) {
				if (e.target === mask && mask.parentNode) mask.parentNode.removeChild(mask);
			});
			document.body.appendChild(mask);
		}

		/* ---------- 新短信推送 ---------- */

		var newSmsHandler = function (resp) {
			if (!resp || resp.type !== 'new_sms' || !resp.data) return;
			var d = resp.data;
			var msg = {
				index: d.index != null ? d.index : -Date.now(),
				content: d.content || '',
				number: normalizeNumber(d.sender || d.number || ''),
				time: d.time || nowTimeStr(),
				type: 'received',
				isConcatenated: d.isComplete === false ? true : false
			};
			// 完整消息直接进列表；长短信由服务端拼接后推送（isComplete=true）
			if (d.isComplete !== false) {
				markUnread(msg.number);   // 刚到达、用户尚未点开 → 未读
				buildContacts(state.contacts.reduce(function (acc, c) { return acc.concat(c.messages); }, []).concat([msg]));
				Mt5700.info('收到来自 ' + msg.number + ' 的新短信');
			}
		};
		AtWs.client.subscribe(newSmsHandler);

		self._dispose = function () { AtWs.client.unsubscribe(newSmsHandler); };

		/* ---------- 初始化 ---------- */

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
			refreshStorage();
			refresh();
		});

		renderStorage();
		renderContacts();
		renderConversation();

		return page;
	}
});
