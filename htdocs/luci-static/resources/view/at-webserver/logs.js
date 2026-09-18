'use strict';
'require fs';
'require uci';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/mt5700';
/* global L, AtWs, Parse, Mt5700 */

/**
 * 运行日志页
 *
 * 三个视图，来源各不相同、互不重复：
 *   ① 模组拨号  后端内存日志里的拨号过程（自动拨号对齐、PDP/NDIS、AT 初始化、
 *      串口探测、URC 分发）。**这些 syslog 里看不到** —— 稳态日志级别会把 info
 *      级过程日志挡掉，而恰恰它们是排障最需要的。
 *   ② 接口与网络 syslog 里 at-webserver 相关的行（init.d 的 logger 输出：
 *      hotplug、接口拉起、取址结果）。
 *   ③ 通知记录  原有的通知文件（短信 / 来电 / 信号 / 存储）。
 *
 * ★★ 后端能力缺失时的处理（本页最重要的一条）：
 *   ① 依赖 ubus `mt5700.logs`（后端内存日志环形缓冲）。**当前后端还没有这个方法**
 *      （mt5700.uc 只暴露 at / events / netrate / es9p），所以这个视图必然取不到。
 *      取不到时**必须**显示明确的红色提示 + 重试入口，绝不显示成空列表 ——
 *      空列表会被读成「一切正常，只是没日志」，那是最坏的一种误报。
 *   ② 依赖 ubus `log.read`（syslog）。ACL 已补读权限；若设备上的 rpcd 没加载
 *      log 插件，同样在底部注明，不影响其它视图。
 *
 * ★ 安全：日志内容含不可信输入（短信正文、运营商名、APN、URC 原文），
 *   关键词高亮只用 createTextNode + <mark>.textContent，绝不用 innerHTML；
 *   搜索匹配用 String.indexOf，不用 new RegExp(用户输入)。
 */

/* 级别中文化：徽章显示中文，原始标识放 title 便于对照 */
var LEVEL_LABEL = { DBG: '调试', INF: '信息', WRN: '警告', ERR: '错误' };
var LEVEL_VARIANT = { DBG: 'neutral', INF: 'info', WRN: 'warning', ERR: 'danger' };

/* 后端日志行分类：命中拨号的归「模组拨号」，其余归「接口与网络」 */
var DIAL_RE = /自动拨号|拨号|SETAUTODIAL|APN|PDP|CGACT|CGDCONT|NDIS|驻网|注册|CREG|CGREG|C5GREG|COPS|SETMODE|串口|ttyUSB|ttyACM|AT通道|CMEE|CNMI|CMGF|CLIP|模组/i;

function pad(n, w) {
	var s = String(n);
	while (s.length < w) s = '0' + s;
	return s;
}

function fmtClock(ms) {
	var d = new Date(ms || 0);
	return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2);
}

function fmtFull(ms) {
	var d = new Date(ms || 0);
	return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + ' ' + fmtClock(ms);
}

/* 后端内存日志：{ ts, level, msg } */
function entriesFromBackend(list) {
	var out = [];
	for (var i = 0; i < list.length; i++) {
		var e = list[i] || {};
		out.push({
			ts: Number(e.ts) || 0,
			level: String(e.level || 'INF'),
			msg: String(e.msg || '')
		});
	}
	return out;
}

/* syslog 行：只取 init.d 那类（at-webserver: ...），后端 stdout 那类已由内存日志提供，
   两边都收会重复。 */
function entriesFromSyslog(rawList) {
	var out = [];
	for (var i = 0; i < rawList.length; i++) {
		var r = rawList[i] || {};
		var msg = String(r.msg || '');
		if (msg.indexOf('at-webserver') < 0) continue;
		if (msg.indexOf('at-webserver-rust') >= 0) continue;
		var m = msg.match(/^at-webserver(?:\[\d+\])?:\s*([\s\S]*)$/);
		if (!m) continue;
		var text = m[1].trim();
		if (!text) continue;
		var lv = 'INF';
		if (/错误|失败|error/i.test(text)) lv = 'ERR';
		else if (/警告|warn/i.test(text)) lv = 'WRN';
		out.push({ ts: Number(r.time) || Date.now(), level: lv, msg: text });
	}
	return out;
}

return L.view.extend({
	load: function () {
		return L.uci.load('at-webserver').then(function () {
			var logFile = L.uci.get('at-webserver', 'config', 'log_file') || '';
			return { path: logFile || '/tmp/at-notifications.log' };
		}).catch(function () {
			return { path: '/tmp/at-notifications.log' };
		});
	},

	render: function (data) {
		var self = this;
		var page = Mt5700.page('运行日志', '模组拨号 · 接口与网络 · 通知记录');
		var body = page._body;
		var notifyPath = (data && data.path) || '/tmp/at-notifications.log';

		var state = {
			/* ★ 默认落在「接口与网络」而不是「模组拨号」：
			   后者依赖 ubus mt5700.logs，而当前后端（mt5700.uc 只暴露
			   at / events / netrate / es9p）**在现网每一台设备上都取不到**。
			   若把它排在第一并且默认选中，用户点进「运行日志」第一眼就是一个红屏
			   —— 那不是报错，那是本页的常态，不该做成第一印象。
			   三个 Tab 的顺序仍与参考实现一致（模组拨号在前），只是默认不选它。 */
			tab: 'iface',
			level: 'all',      /* all | DBG | INF | WRN | ERR */
			query: '',
			auto: false,       /* ★ 默认关：自动刷新会周期打 ubus，且页面隐藏时纯属浪费 */
			dial: [],
			iface: [],
			notify: '',
			/* 后端能力探测结果：null=还没探过，false=明确不支持，true=可用 */
			backendLogs: null,
			backendErr: '',
			syslogOk: true,
			/* 通知文件读取失败的原因：空串=正常。★ 失败不能写成空内容 ——
			   「读不到」与「文件是空的」在界面上必须能区分开（否则就是误报成功） */
			notifyErr: '',
			loading: false,
			/* 首屏渲染早于第一次取数，此时必须显示「加载中…」而不是「暂无日志」 */
			primed: false
		};

		/* ---------------- 数据通道 ----------------
		 * ★ expect 一律写 {}：LuCI 的 expect 不是「声明要哪些字段」，
		 *   实测写 `expect: { entries: [] }` 只会把字段的**值**返回回来，
		 *   表现为「ubus 直连明明有数据、页面却显示 0 条」这种极难查的现象。 */
		var rpcLogs = L.rpc.declare({
			object: 'mt5700', method: 'logs',
			params: ['since', 'limit'], expect: {}
		});
		var rpcSyslog = L.rpc.declare({
			object: 'log', method: 'read',
			params: ['lines', 'stream', 'oneshot'], expect: {}
		});
		var fileRead = L.rpc.declare({ object: 'file', method: 'read', params: ['path'], expect: {} });
		var fileWrite = L.rpc.declare({ object: 'file', method: 'write', params: ['path', 'data'], expect: {} });

		function readFile(p) {
			if (L.fs && typeof L.fs.read === 'function') return L.fs.read(p);
			return fileRead(p).then(function (r) { return (r && r.data != null) ? r.data : ''; });
		}
		function writeFile(p, content) {
			if (L.fs && typeof L.fs.write === 'function') return L.fs.write(p, content);
			return fileWrite(p, content);
		}

		/* ---------------- 顶部：视图切换 + 工具栏 ---------------- */
		var tabs = Mt5700.segmented([
			{ label: '模组拨号', value: 'dial' },
			{ label: '接口与网络', value: 'iface' },
			{ label: '通知记录', value: 'notify' }
		], state.tab, function (v) { state.tab = v; renderAll(); });
		body.appendChild(tabs.el);

		var levelSel = Mt5700.select([
			{ label: '全部级别', value: 'all' },
			{ label: '仅信息', value: 'INF' },
			{ label: '仅警告', value: 'WRN' },
			{ label: '仅错误', value: 'ERR' }
		], 'all');
		levelSel.addEventListener('change', function () { state.level = levelSel.value; renderList(); });

		var searchInput = Mt5700.input('text', '按关键词过滤，如 拨号 / eth2 / 错误', '');
		searchInput.addEventListener('input', function () {
			state.query = searchInput.value.trim();
			renderList();
		});

		var autoChk = E('input', { 'type': 'checkbox' });
		autoChk.checked = state.auto;
		autoChk.addEventListener('change', function () {
			state.auto = autoChk.checked;
			schedule();
		});

		var toolbar = E('div', { 'class': 'mt5700-panel-actions' });
		toolbar.appendChild(levelSel);
		toolbar.appendChild(searchInput);
		/* 注意：E(tag, attrs, text) 只吃**一个**子节点，传数组会被 String() 序列化成
		   [object HTMLInputElement] —— 多子节点一律 appendChild。 */
		var autoWrap = E('label', { 'class': 'mt5700-checkbox' });
		autoWrap.appendChild(autoChk);
		autoWrap.appendChild(E('span', {}, '自动刷新'));
		toolbar.appendChild(autoWrap);
		toolbar.appendChild(Mt5700.primaryButton('刷新', function () { refresh(true); }));
		toolbar.appendChild(Mt5700.ghostButton('导出', function () { exportLog(); }));
		body.appendChild(toolbar);

		/* ---------------- 主体 ---------------- */
		var hintEl = E('div', { 'class': 'mt5700-hint mt5700-mt-sm' });
		body.appendChild(hintEl);
		/* 复用终端日志的等宽滚动容器，不新造一套日志面板样式 */
		var listEl = E('div', { 'class': 'mt5700-terminal-log mt5700-mt-sm' });
		body.appendChild(listEl);
		var footerEl = E('div', { 'class': 'mt5700-hint mt5700-mt-sm' });
		body.appendChild(footerEl);
		var clearRow = E('div', { 'class': 'mt5700-panel-actions' });
		clearRow.appendChild(Mt5700.dangerButton('清空通知日志', function () { clearNotify(); }));
		body.appendChild(clearRow);

		/* ---------------- 渲染 ---------------- */
		function currentEntries() {
			return state.tab === 'dial' ? state.dial : state.iface;
		}

		function applyFilters(list) {
			var q = state.query.toLowerCase();
			var out = [];
			for (var i = 0; i < list.length; i++) {
				var e = list[i];
				if (state.level !== 'all' && e.level !== state.level) continue;
				if (q && e.msg.toLowerCase().indexOf(q) < 0) continue;
				out.push(e);
			}
			return out;
		}

		/* ★ 必须始终返回 Node：早期实现里「没有搜索词就 return 字符串」，
		   而调用方是 appendChild —— 一旦有日志行要渲染就抛
		   "parameter 1 is not of type 'Node'"，整个列表渲染中断。 */
		function highlight(text) {
			var s = String(text);
			if (!state.query) return document.createTextNode(s);
			var q = state.query.toLowerCase();
			if (s.toLowerCase().indexOf(q) < 0) return document.createTextNode(s);
			var frag = document.createDocumentFragment();
			var rest = s;
			while (true) {
				var idx = rest.toLowerCase().indexOf(q);
				if (idx < 0) { frag.appendChild(document.createTextNode(rest)); break; }
				if (idx > 0) frag.appendChild(document.createTextNode(rest.slice(0, idx)));
				var mk = document.createElement('mark');
				mk.textContent = rest.slice(idx, idx + q.length);
				frag.appendChild(mk);
				rest = rest.slice(idx + q.length);
			}
			return frag;
		}

		function renderRow(e) {
			var lv = e.level || 'INF';
			var row = E('div', { 'class': 'mt5700-logrow' });
			row.appendChild(E('span', { 'class': 'mt5700-logmeta', 'title': fmtFull(e.ts) }, fmtClock(e.ts)));
			row.appendChild(Mt5700.badge(LEVEL_LABEL[lv] || lv, LEVEL_VARIANT[lv] || 'neutral'));
			/* 级别配色复用终端日志既有类，不新造；警告级别靠左侧徽章区分 */
			var msg = E('span', { 'class': 'mt5700-logmsg' + (lv === 'ERR' ? ' mt5700-log-err' : '') });
			msg.appendChild(highlight(e.msg));
			row.appendChild(msg);
			return row;
		}

		function renderList() {
			listEl.innerHTML = '';
			footerEl.textContent = '';

			if (state.tab === 'notify') { renderNotify(); return; }

			/* ★ 后端能力缺失 → 明确报错 + 重试入口，绝不显示空列表。
			   err 原文要带出来：rpcd 拒一个不存在的方法是
			   「Method not found」，ACL 没授权是「Access denied」，
			   两者排查方向完全不同 —— 只写「后端未提供」会把人带偏。 */
			if (state.tab === 'dial' && state.backendLogs === false) {
				listEl.appendChild(Mt5700.errorState(
					'取不到模组拨号日志：' + (state.backendErr || '后端未提供 logs 方法')
					+ '。该视图依赖新版后端的内存日志（ubus mt5700.logs）；'
					+ '若提示权限不足，还需在 ACL 的 mt5700 段补 logs 读权限。'
					+ '接口与网络、通知记录两个视图不受影响。',
					function () { refresh(true); }));
				footerEl.textContent = '数据源不可用';
				return;
			}

			var all = currentEntries();
			var list = applyFilters(all);
			if (!all.length) {
				/* ★ 三种「空」必须说清是哪一种：还没取 / 能力缺失 / 缓冲真的是空的。
				   统一显示「暂无日志」会让用户分不清「该等」还是「该报障」。 */
				var emptyText = !state.primed ? '加载中…'
					: (state.tab === 'dial' ? '后端已提供日志接口，但当前缓冲为空（进程重启后从零累积）'
						: (state.tab === 'iface' ? '没有 at-webserver 相关的 syslog 行' : '暂无日志'));
				listEl.appendChild(Mt5700.empty(emptyText));
			} else if (!list.length) {
				listEl.appendChild(Mt5700.empty('没有匹配的日志（试试清空关键词，或把级别切回「全部级别」）'));
			} else {
				var frag = document.createDocumentFragment();
				/* 只渲染最后 400 行，避免一次插入过多节点导致滚动卡顿 */
				var shown = list.length > 400 ? list.slice(list.length - 400) : list;
				for (var i = 0; i < shown.length; i++) frag.appendChild(renderRow(shown[i]));
				listEl.appendChild(frag);
			}

			var text = '共 ' + all.length + ' 条';
			if (list.length !== all.length) text += '（过滤后 ' + list.length + ' 条）';
			if (list.length > 400) text += '，仅显示最新 400 条';
			/* ★ 两个数据源各自成句：iface 视图的条目一半来自后端内存日志、
			   一半来自 syslog，只怪 syslog 会归错因。 */
			if (state.tab === 'iface') {
				if (state.backendLogs === false) text += ' · 后端日志不可用（模组拨号相关行缺失）';
				if (!state.syslogOk) text += ' · syslog 不可读（rpcd 未加载 log 插件或 ACL 未授权）';
			}
			footerEl.textContent = text;
		}

		/* 通知文件：按搜索词过滤后的行（导出与列表同一口径） */
		function notifyLines() {
			var lines = String(state.notify || '').replace(/\s+$/, '').split('\n')
				.filter(function (l) { return l.trim() !== ''; });
			if (!state.query) return lines;
			var q = state.query.toLowerCase();
			return lines.filter(function (l) { return l.toLowerCase().indexOf(q) >= 0; });
		}

		function renderNotify() {
			/* ★ 读不到文件 ≠ 文件是空的。读失败给红色错误态 + 重试，不降级成空态。 */
			if (state.notifyErr) {
				listEl.appendChild(Mt5700.errorState(
					'读不到通知文件（' + notifyPath + '）：' + state.notifyErr,
					function () { refresh(true); }));
				footerEl.textContent = '数据源不可用';
				return;
			}
			var total = String(state.notify || '').replace(/\s+$/, '').split('\n')
				.filter(function (l) { return l.trim() !== ''; }).length;
			var lines = notifyLines();
			if (!lines.length) {
				listEl.appendChild(Mt5700.empty(state.primed
					? (total ? '没有匹配的通知行（试试清空关键词）'
						: '暂无通知记录（短信、来电、信号变化与存储告警会写入此文件）')
					: '加载中…'));
				footerEl.textContent = '文件：' + notifyPath;
				return;
			}
			var frag = document.createDocumentFragment();
			var shown = lines.length > 400 ? lines.slice(lines.length - 400) : lines;
			for (var i = 0; i < shown.length; i++) {
				var lv = /错误|失败|error/i.test(shown[i]) ? 'ERR'
					: (/警告|warn/i.test(shown[i]) ? 'WRN' : 'INF');
				var row = E('div', { 'class': 'mt5700-logrow' });
				row.appendChild(Mt5700.badge(LEVEL_LABEL[lv] || lv, LEVEL_VARIANT[lv] || 'neutral'));
				var msg = E('span', { 'class': 'mt5700-logmsg' });
				msg.appendChild(highlight(shown[i]));
				row.appendChild(msg);
				frag.appendChild(row);
			}
			listEl.appendChild(frag);
			footerEl.textContent = '共 ' + total + ' 条'
				+ (lines.length !== total ? '（过滤后 ' + lines.length + ' 条）' : '')
				+ ' · 文件：' + notifyPath;
		}

		function renderAll() {
			/* 通知记录是纯文本行，没有级别字段，级别筛选用不上；
			   关键词搜索对三个视图一视同仁（都是文本 indexOf），别只在两个视图生效
			   —— 否则用户切回来会发现列表莫名少一截。 */
			levelSel.disabled = (state.tab === 'notify');
			clearRow.style.display = (state.tab === 'notify') ? '' : 'none';
			var hint = state.tab === 'dial'
				? '后端内存日志里的拨号过程：自动拨号对齐、PDP 与 USB 网卡状态、串口探测、主动上报分发。进程重启后从零开始。'
				: (state.tab === 'iface'
					? 'syslog 中 at-webserver 相关行（init.d 的 logger 输出）：接口拉起、热插拔、DHCP / IPv6 取址结果。'
					: '通知文件内容（短信、来电、信号变化、存储告警）。');
			if (state.tab === 'notify') hint += '（级别筛选只对前两个视图生效）';
			hintEl.textContent = hint;
			renderList();
		}

		/* ---------------- 取数 ---------------- */
		function refresh(manual) {
			if (state.loading) return Promise.resolve();
			state.loading = true;

			/* ★ 必须真串行，不能 Promise.all：
			   后端日志一路会先 `state.iface = []` 再回填，若与 syslog 一路并发，
			   syslog 先返回的结果会被这一句整批抹掉（顺序取决于谁先落地，
			   表现为「接口与网络视图时有时无」这种极难复现的抖动）。 */
			/* ★ 每一步都要记「成没成」：三步各自 catch 掉错误后**必然 resolve**，
			   所以末端不能只看 promise 有没有 reject 就弹成功 —— 一条数据没取到
			   却弹「日志已刷新」正是本项目头号红线（失败不许误报成功）。 */
			var okCount = 0;
			var steps = [
				function () {
					return rpcLogs(0, 1200).then(function (r) {
						var entries = entriesFromBackend((r && r.entries) || []);
						var dial = [], iface = [];
						for (var i = 0; i < entries.length; i++) {
							if (DIAL_RE.test(entries[i].msg)) dial.push(entries[i]);
							else iface.push(entries[i]);
						}
						state.dial = dial;
						state.iface = iface;
						state.backendLogs = true;
						state.backendErr = '';
						okCount++;
					}, function (err) {
						state.backendLogs = false;
						state.backendErr = (err && err.message) || '未知错误';
						state.dial = [];
						state.iface = [];
					});
				},
				function () {
					return rpcSyslog(1500, false, true).then(function (r) {
						var extra = entriesFromSyslog((r && r.log) || []);
						if (extra.length) {
							state.iface = state.iface.concat(extra);
							state.iface.sort(function (a, b) { return a.ts - b.ts; });
						}
						state.syslogOk = true;
						okCount++;
					}, function () {
						state.syslogOk = false;
					});
				},
				function () {
					return readFile(notifyPath).then(function (c) {
						state.notify = c || '';
						state.notifyErr = '';
						okCount++;
					}, function (err) {
						/* ★ 读失败不许写成空内容 —— 那会让界面显示「暂无通知记录」，
						   与「文件真的是空的」无法区分。 */
						state.notify = '';
						state.notifyErr = (err && err.message) || '未知错误';
					});
				}
			];

			return steps.reduce(function (p, step) {
				return p.then(step);
			}, Promise.resolve()).then(function () {
				state.loading = false;
				state.primed = true;
				renderAll();
				if (!manual) return;
				/* 按成功数分级：全成才算成功，一个都没成必须报错 */
				if (okCount === 3) Mt5700.success('日志已刷新');
				else if (okCount === 0) Mt5700.error('刷新失败：三个数据源都没取到（后端日志 / syslog / 通知文件）');
				else Mt5700.warning('只取到 ' + okCount + '/3 个数据源，其余见列表下方说明');
			}, function () {
				state.loading = false;
				state.primed = true;
				renderAll();
			});
		}

		function exportLog() {
			var lines = ['# MT5700 运行日志导出', '# 视图：' + state.tab
				+ '  导出时间：' + fmtFull(Date.now()), ''];
			if (state.tab === 'notify') {
				/* 与前两个视图同一口径：导出**当前过滤结果**，而不是文件全文 */
				lines = lines.concat(notifyLines());
			} else {
				applyFilters(currentEntries()).forEach(function (e) {
					lines.push(fmtFull(e.ts) + ' [' + e.level + '] ' + e.msg);
				});
			}
			try {
				var blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
				var url = URL.createObjectURL(blob);
				var a = E('a', { href: url, download: 'mt5700-log-' + state.tab + '-' + Date.now() + '.txt' });
				document.body.appendChild(a);
				a.click();
				setTimeout(function () {
					document.body.removeChild(a);
					URL.revokeObjectURL(url);
				}, 0);
			} catch (e) {
				Mt5700.error('导出失败：' + ((e && e.message) || '浏览器不支持'));
			}
		}

		function clearNotify() {
			Mt5700.confirm('确定清空通知日志？', function () {
				return writeFile(notifyPath, '').then(function () {
					Mt5700.success('通知日志已清空');
					state.notify = '';
					renderList();
				}).catch(function () {
					return fileWrite(notifyPath, '').then(function () {
						Mt5700.success('通知日志已清空');
						state.notify = '';
						renderList();
					}).catch(function (e2) {
						Mt5700.error('清空失败：' + ((e2 && e2.message) || '未知错误'));
					});
				});
			});
		}

		/* ---------------- 自动刷新（默认关） ---------------- */
		var timer = null;
		function schedule() {
			if (timer) { clearInterval(timer); timer = null; }
			if (!state.auto) return;
			timer = setInterval(function () {
				if (document.hidden) return;   /* 页面不可见时不刷，省设备资源 */
				refresh(false);
			}, 10000);
		}

		/* ★ 首屏必须先置 loading 再渲染：renderAll() 早于第一次取数，
		   否则用户第一眼看到的是「暂无日志」，而其实只是还没取。 */
		state.loading = true;
		renderAll();
		refresh(false);

		self._dispose = function () {
			if (timer) { clearInterval(timer); timer = null; }
		};
		page._onDispose(self._dispose);

		return page;
	}
});
