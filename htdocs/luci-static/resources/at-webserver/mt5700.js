'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/rpc';
'require at-webserver/parse';
/* global L, AtWs, Parse, baseclass */

/**
 * MT5700 LuCI 前端 - Modern Dimensional Layering 组件系统 v2
 * 软极简 + 玻璃拟态材质 + 现代数据看板
 */

// 注入新样式
/*
 * ⚠️ 改 mt5700.css 后必须 bump 这个常量。
 * 它是样式表 URL `.../mt5700.css?v=<版本>` 里唯一的缓存击穿器：固件 squashfs 的
 * 文件 mtime 恒为 1970-01-01，uhttpd 不送 Cache-Control，浏览器按启发式新鲜度
 * 会把该文件缓存到近乎永久。2026-09-16 的教训：开关改成 iOS 几何（44×24 → 51×31）
 * 后，设备上 CSS 内容已经是新的，用户浏览器却还在用旧副本 —— 代码改了界面没变。
 * 守卫：tests/css-cachebust-contract.test.js（mt5700.css 内容指纹一变就必须改这里）。
 */
var MT5700_CSS_VERSION = '5.5.5';
(function () {
	var cssPath = '/luci-static/resources/at-webserver/mt5700.css?v=' + MT5700_CSS_VERSION;
	var links = document.querySelectorAll('link[rel="stylesheet"]');
	for (var i = 0; i < links.length; i++) {
		if (links[i].getAttribute('href') === cssPath) return;
	}
	var link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = cssPath;
	document.head.appendChild(link);
})();

var Mt5700 = (function () {
	var api = {};

	/* ================= 工具函数 ================= */

	// 创建 DOM 元素
	function E(tag, attrs, text) {
		var el = document.createElement(tag);
		if (attrs) {
			for (var k in attrs) {
				if (k === 'class' || k === 'className') {
					el.className = attrs[k];
				} else if (k === 'style') {
					el.style.cssText = attrs[k];
				} else if (k.startsWith('on')) {
					el.addEventListener(k.substring(2).toLowerCase(), attrs[k]);
				} else {
					el.setAttribute(k, attrs[k]);
				}
			}
		}
		// 文本内容：字符串走 textContent，DOM 节点直接挂载（避免被 String() 序列化成 [object HTMLDivElement]）
		if (text != null) {
			if (typeof text === 'object' && text.nodeType) {
				el.appendChild(text);
			} else {
				el.textContent = String(text);
			}
		}
		return el;
	}

	// SVG 创建
	function svgEl(tag, attrs) {
		var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
		if (attrs) {
			for (var k in attrs) {
				el.setAttribute(k, attrs[k]);
			}
		}
		return el;
	}

	/* ================= 页面结构 ================= */

	// 页面容器
	api.page = function (title, subtitle) {
		var node = E('div', { 'class': 'mt5700-page' });
		var h = E('div', { 'class': 'mt5700-page-header' });
		h.appendChild(E('h2', { 'class': 'mt5700-page-title' }, title || ''));
		if (subtitle) h.appendChild(E('p', { 'class': 'mt5700-page-subtitle' }, subtitle));
		node.appendChild(h);
		var body = E('div', { 'class': 'mt5700-page-body' });
		node.appendChild(body);
		node._body = body;

		/*
		 * LuCI 没有页面卸载钩子：各视图给的 self._dispose 全仓库零调用点，
		 * 于是切页只是换掉视图 DOM，定时器与订阅一个都不会停 —— 进几次页面
		 * 就有几个在后台各跑各的，跟用户操作抢独占的 AT 串口。
		 *
		 * 判据用「曾进入文档、现已脱离」这个**转换**，而不是「现在不在文档里」：
		 * 页面刚构建、尚未插入文档的那一瞬也会被判成不在，只认转换可避免误清。
		 */
		var cleanups = [];
		node._onDispose = function (fn) {
			if (typeof fn === 'function') cleanups.push(fn);
		};
		var ownerDoc = node.ownerDocument || document;
		var wasInDoc = false;
		var watchdog = setInterval(function () {
			if (ownerDoc.contains(node)) { wasInDoc = true; return; }
			if (!wasInDoc) return;
			clearInterval(watchdog);
			for (var ci = 0; ci < cleanups.length; ci++) {
				try { cleanups[ci](); } catch (e) { /* 清理失败不能影响其余 */ }
			}
			cleanups.length = 0;
		}, 1000);
		return node;
	};

	/* ================= 卡片 ================= */

	api.card = function (title, subtitle, extra) {
		var card = E('div', { 'class': 'mt5700-card' });
		var header = E('div', { 'class': 'mt5700-card-header' });
		header.appendChild(E('h3', { 'class': 'mt5700-card-title' }, title || ''));
		if (subtitle) header.appendChild(E('p', { 'class': 'mt5700-card-subtitle' }, subtitle));
		if (extra) {
			var ex = E('div', { 'class': 'mt5700-card-extra' });
			ex.appendChild(extra);
			header.appendChild(ex);
		}
		card.appendChild(header);
		var body = E('div', { 'class': 'mt5700-card-body' });
		card.appendChild(body);
		card._body = body;
		return card;
	};

	/* ================= 指标卡片 ================= */

	api.metric = function (label, value, color) {
		var m = E('div', { 'class': 'mt5700-metric' });
		m.appendChild(E('div', { 'class': 'mt5700-metric-label' }, label));
		var v = E('div', { 'class': 'mt5700-metric-value' }, value || '—');
		if (color) v.classList.add(color);
		m.appendChild(v);
		return m;
	};

	/* ================= 分段选择器（单选按钮组） ================= */

	/*
	 * 少量互斥选项（如锁频类型 4 项、接入模式 3 项）用分段按钮而不是下拉：
	 * 全部选项一眼可见、一次点选到位。返回 { el, setValue, getValue }。
	 */
	api.segmented = function (options, value, onChange) {
		var wrap = E('div', { 'class': 'mt5700-segmented' });
		var current = value;
		var btns = [];
		options.forEach(function (opt) {
			var btn = E('button', { 'class': 'mt5700-segmented-btn', 'type': 'button' }, opt.label);
			btn.addEventListener('click', function () {
				if (current === opt.value) return;
				current = opt.value;
				paint();
				if (onChange) onChange(opt.value);
			});
			btns.push({ el: btn, value: opt.value });
			wrap.appendChild(btn);
		});
		function paint() {
			btns.forEach(function (b) {
				b.el.classList.toggle('is-active', b.value === current);
			});
		}
		paint();
		return {
			el: wrap,
			setValue: function (v) { current = v; paint(); },
			getValue: function () { return current; }
		};
	};

	/* ================= 信号强度（RSRP → 条） ================= */

	/* -120dBm=0%、-70dBm=100%，≥60 绿 / ≥40 黄 / 否则红（与载波表同一套判据） */
	api.signalPercent = function (rsrp) {
		if (rsrp == null) return null;
		return Math.max(0, Math.min(100, Math.round(2 * (Number(rsrp) + 120))));
	};

	api.rsrpBar = function (rsrp) {
		if (rsrp == null) return document.createTextNode('—');
		var pct = api.signalPercent(rsrp);
		var color = pct >= 60 ? 'var(--mt5700-success)'
			: pct >= 40 ? 'var(--mt5700-warning)' : 'var(--mt5700-danger)';
		return E('div', { 'class': 'mt5700-signal-bar' },
			E('div', { 'class': 'mt5700-signal-bar-fill',
				'style': 'width:' + pct + '%;background:' + color }));
	};

	
	/* ================= 环形仪表 (Circular Gauge) ================= */

	/*
	 * 信号等级色 (绿→青→琥珀→橙→红) 直接从 CSS 变量读取，
	 * 这样仪表与图表会随浅色 / 深色主题自动切换：
	 * 深色下若沿用浅色的深绿（#0c7a54 之类），在深底上对比度只有 3.7:1，几乎糊在一起。
	 */
	function cssColor(name, fallback) {
		try {
			var v = window.getComputedStyle(document.documentElement).getPropertyValue(name);
			v = (v || '').trim();
			return v || fallback;
		} catch (e) {
			return fallback;
		}
	}

	var GAUGE_COLOR_VARS = {
		exc: '--mt5700-sig-exc', good: '--mt5700-sig-good', fair: '--mt5700-sig-fair',
		poor: '--mt5700-sig-poor', bad: '--mt5700-sig-bad'
	};
	var GAUGE_COLOR_FALLBACK = {
		exc: '#0c7a54', good: '#0b7a70', fair: '#9a5c00', poor: '#c05621', bad: '#c62828'
	};
	function gaugeColor(level) {
		var key = GAUGE_COLOR_VARS[level] ? level : 'fair';
		return cssColor(GAUGE_COLOR_VARS[key], GAUGE_COLOR_FALLBACK[key]);
	}
	var GAUGE_CAPTIONS = { exc: '优秀', good: '良好', fair: '一般', poor: '较差', bad: '极差' };

	/*
	 * 各信号指标使用独立阈值与量程，绝不共用一套 0-100% 算法：
	 *   RSRP (dBm): >=-80 优秀 / >=-90 良好 / >=-100 一般 / >=-110 较差 / 更低 极差
	 *   RSRQ (dB) : >=-10 优秀 / >=-15 良好 / >=-20 一般 / 更低 极差
	 *   SINR (dB) : >=20 优秀 / >=13 良好 / >=5 一般 / 更低 极差
	 * 量程仅用于弧长百分比映射（视觉刻度），等级判定只看阈值。
	 */
	var SIGNAL_SPECS = {
		rsrp: {
			min: -120, max: -70,
			level: function (v) {
				return v >= -80 ? 'exc' : v >= -90 ? 'good' : v >= -100 ? 'fair' : v >= -110 ? 'poor' : 'bad';
			}
		},
		rsrq: {
			min: -20, max: -3,
			level: function (v) {
				return v >= -10 ? 'exc' : v >= -15 ? 'good' : v >= -20 ? 'fair' : 'bad';
			}
		},
		sinr: {
			min: 0, max: 30,
			level: function (v) {
				return v >= 20 ? 'exc' : v >= 13 ? 'good' : v >= 5 ? 'fair' : 'bad';
			}
		},
		/* 信号百分比（0-100）：阈值与 RSRP 分级对齐（-80→75 / -90→50 / -100→25） */
		pct: {
			min: 0, max: 100,
			level: function (v) {
				return v >= 75 ? 'exc' : v >= 50 ? 'good' : v >= 25 ? 'fair' : 'bad';
			}
		}
	};

	// 判定信号等级（kind: rsrp | rsrq | sinr），无法判定时返回 null
	api.signalLevel = function (kind, value) {
		var spec = SIGNAL_SPECS[kind];
		if (!spec || value == null || isNaN(value)) return null;
		return spec.level(value);
	};

	/**
	 * 创建环形仪表。SVG viewBox 缩放自适应容器，DOM 开销固定（1 svg + 2 circle）。
	 * 返回 { el, set(value) }：set(null) 显示占位符并隐藏弧线与等级。
	 */
	api.gauge = function (label, unit, kind) {
		var C = (2 * Math.PI * 42).toFixed(2);

		var root = E('div', { 'class': 'mt5700-gauge' });
		var dial = E('div', { 'class': 'mt5700-gauge-dial' });
		var svg = svgEl('svg', { viewBox: '0 0 100 100', role: 'img' });
		svg.appendChild(svgEl('circle', {
			'class': 'mt5700-gauge-track', cx: 50, cy: 50, r: 42, 'stroke-width': 8
		}));
		var bar = svgEl('circle', {
			'class': 'mt5700-gauge-bar', cx: 50, cy: 50, r: 42, 'stroke-width': 8,
			transform: 'rotate(-90 50 50)',
			'stroke-dasharray': C, 'stroke-dashoffset': C
		});
		svg.appendChild(bar);
		dial.appendChild(svg);

		var center = E('div', { 'class': 'mt5700-gauge-center' });
		var valueEl = E('div', { 'class': 'mt5700-gauge-value' }, '—');
		var unitEl = E('div', { 'class': 'mt5700-gauge-unit' }, unit || '');
		center.appendChild(valueEl);
		center.appendChild(unitEl);
		dial.appendChild(center);
		root.appendChild(dial);

		root.appendChild(E('div', { 'class': 'mt5700-gauge-label' }, label || ''));
		var caption = E('div', { 'class': 'mt5700-gauge-caption' });
		root.appendChild(caption);

		return {
			el: root,
			set: function (value) {
				var spec = SIGNAL_SPECS[kind];
				if (value == null || isNaN(value)) {
					valueEl.textContent = '—';
					bar.setAttribute('stroke-dashoffset', C);
					bar.removeAttribute('stroke');
					caption.textContent = '';
					caption.className = 'mt5700-gauge-caption';
					return;
				}
				valueEl.textContent = String(value);
				var level = spec ? spec.level(value) : 'fair';
				var color = gaugeColor(level);
				var pct = 0;
				if (spec) {
					pct = (value - spec.min) / (spec.max - spec.min);
					pct = Math.max(0, Math.min(1, pct));
				}
				bar.setAttribute('stroke', color);
				bar.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(2));
				caption.textContent = GAUGE_CAPTIONS[level] || '';
				caption.className = 'mt5700-gauge-caption ' + level;
			}
		};
	};

	/* ================= 按钮 ================= */

	api.button = function (label, onClick, variant) {
		variant = variant || 'secondary';
		var btn = E('button', { 'class': 'mt5700-btn mt5700-btn-' + variant }, label);
		if (onClick) btn.addEventListener('click', onClick);
		return btn;
	};

	api.primaryButton = function (label, onClick) {
		return api.button(label, onClick, 'primary');
	};

	api.successButton = function (label, onClick) {
		return api.button(label, onClick, 'success');
	};

	api.dangerButton = function (label, onClick) {
		return api.button(label, onClick, 'danger');
	};

	api.ghostButton = function (label, onClick) {
		return api.button(label, onClick, 'ghost');
	};

	/* ================= 状态标签 ================= */

	api.badge = function (text, variant) {
		variant = variant || 'neutral';
		return E('span', { 'class': 'mt5700-badge mt5700-badge-' + variant }, text);
	};

	/* ================= 连接状态卡片 ================= */
	// 独立 at-status-* 命名空间，样式自包含于 mt5700.css，不依赖 LuCI 主题

	api.renderConnectionBar = function (container) {
		var cl = AtWs.client;

		var card = E('div', { 'class': 'at-status-card is-connecting', 'id': 'at-service-status' });

		// SVG 状态图标（在线/连接中旋转，离线/未知静止）
		var icon = E('div', { 'class': 'at-status-icon' });
		var svg = svgEl('svg', { viewBox: '0 0 32 32', 'aria-hidden': 'true' });
		svg.appendChild(svgEl('circle', { cx: 16, cy: 16, r: 11, 'stroke-dasharray': '5 3' }));
		svg.appendChild(svgEl('circle', { cx: 16, cy: 16, r: 4 }));
		svg.appendChild(svgEl('path', { d: 'M16 5V2' }));
		svg.appendChild(svgEl('path', { d: 'M16 30V27' }));
		icon.appendChild(svg);

		// 主信息：标题（状态点 + 文本）与描述
		var main = E('div', { 'class': 'at-status-main' });
		var title = E('div', { 'class': 'at-status-title' });
		var dot = E('span', { 'class': 'at-status-dot' });
		var text = E('span', { 'class': 'at-status-text' }, '正在连接 AT 服务');
		title.appendChild(dot);
		title.appendChild(text);
		var desc = E('div', { 'class': 'at-status-description' }, '正在建立 AT 服务连接');
		main.appendChild(title);
		main.appendChild(desc);

		// RPC 地址芯片
		var rpcBox = E('div', { 'class': 'at-status-rpc' });
		rpcBox.appendChild(E('span', { 'class': 'at-status-rpc-label' }, 'RPC'));
		var rpcValue = E('span', { 'class': 'at-status-rpc-value' }, '未连接');
		rpcBox.appendChild(rpcValue);

		// SIM 卡状态芯片（AT^SIMSQ?）
		var simBox = E('div', { 'class': 'at-status-rpc at-status-sim' });
		simBox.appendChild(E('span', { 'class': 'at-status-rpc-label' }, 'SIM'));
		var simValue = E('span', { 'class': 'at-status-rpc-value' }, '—');
		simBox.appendChild(simValue);

		card.appendChild(icon);
		card.appendChild(main);
		card.appendChild(rpcBox);
		card.appendChild(simBox);
		container.appendChild(card);

		/*
		 * SIM 卡状态文案与告警判定**只有一份**，在 parse.js 的
		 * SIM_STATUS_SHORT / SIM_STATUS_WARN（消费入口 Parse.simShort / Parse.simIsWarn）。
		 * 这里不许再抄一份码表 —— 之前就是三处各写一份，改文案必漏改。
		 *
		 * 手册 6.6：0 未插卡 / 1 已插卡 / 2 PIN·PUK 锁定 / 3 SIMLOCK
		 *   10 卡文件初始化中 / 11 已初始化（可接入网络）/ 12 就绪（短信与电话可接入）
		 *   98 卡物理失效 / 99 卡已移除 / 100 卡错误
		 *
		 * ★ 11 不再当告警：本卡长期停在 1,11，实测短信收发正常，
		 *   且自愈推卡也推不动它 —— 详见 parse.js 的码表注释。
		 */
		function refreshSimStatus() {
			if (!cl.connected) {
				simValue.textContent = '—';
				simBox.classList.remove('is-warn');
				return;
			}
			cl.sendCommand('AT^SIMSQ?').then(function (res) {
				var txt = res && res.success && res.data
					? (String(res.data).match(/\^SIMSQ:\s*(\d+)\s*,\s*(\d+)/) || null)
					: null;
				if (!txt) {
					simValue.textContent = '未知';
					simBox.classList.remove('is-warn');
					return;
				}
				var st = parseInt(txt[2], 10);
				simValue.textContent = Parse.simShort(st);
				simBox.classList.toggle('is-warn', Parse.simIsWarn(st));
			}).catch(function () {
				simValue.textContent = '未知';
				simBox.classList.remove('is-warn');
			});
		}

		function rpcLabel() {
			var port = cl.port || 8765;
			var host = cl.bind || cl.host || '127.0.0.1';
			if (host === '0.0.0.0' || host === 'localhost') host = '127.0.0.1';
			return host + ':' + port;
		}

		// 后端连接状态 → 卡片四态映射
		var STATES = {
			connected:      { status: 'online',     text: 'AT 服务在线',      desc: 'AT 通信服务运行正常' },
			connecting:     { status: 'connecting', text: '正在连接 AT 服务', desc: '正在建立 AT 服务连接' },
			authenticating: { status: 'connecting', text: '正在连接 AT 服务', desc: '正在验证访问密钥' },
			idle:           { status: 'connecting', text: '正在连接 AT 服务', desc: '正在建立 AT 服务连接' },
			reconnecting:   { status: 'connecting', text: '正在连接 AT 服务', desc: '连接中断，正在重连' },
			disconnected:   { status: 'offline',    text: 'AT 服务离线',      desc: '无法连接 AT 通信服务' },
			error:          { status: 'offline',    text: 'AT 服务离线',      desc: null }
		};

		function apply(state, err) {
			var cfg = STATES[state] || { status: 'unknown', text: 'AT 服务状态未知', desc: '暂时无法获取服务状态' };
			card.classList.remove('is-online', 'is-connecting', 'is-offline', 'is-unknown');
			card.classList.add('is-' + cfg.status);
			text.textContent = cfg.text;
			desc.textContent = (cfg.status === 'offline' && err) ? err : (cfg.desc || '暂时无法获取服务状态');
			rpcValue.textContent = cfg.status === 'online' ? rpcLabel() : '未连接';
			// SIM 状态只在服务在线时有意义
			if (cfg.status === 'online') refreshSimStatus();
			else { simValue.textContent = '—'; simBox.classList.remove('is-warn'); }
		}

		apply('connecting');
		/*
		 * 退订句柄必须拿到手：这个回调是 push 进客户端全局数组的，页面切走后
		 * 照样会被 connect() / 重连触发，闭包还一直攥着本页的 card。
		 * 进十次页面就多十个永不回收的回调，每次状态变化还要全跑一遍。
		 */
		var detachConnState = cl.onConnectionStateChange(apply);
		api.onDetach(card, function () {
			if (detachConnState) detachConnState();
		});

		/*
		 * 兜底发起连接（connect() 幂等：已就绪时直接置 connected 并返回）。
		 *
		 * 背景：通知日志、服务配置两页只画状态卡、从不连接 AT 服务，
		 * 于是卡片永远停在「未连接 / SIM —」。这两页确实不必发 AT 命令，
		 * 但既然状态卡在页面上，就必须反映真实连接状态 —— 与其在每个视图里
		 * 各写一遍 connect()，不如由组件保证：画了这张卡，连接就得建立。
		 */
		if (cl.isReady && cl.isReady()) {
			apply('connected');
		} else {
			cl.connect().catch(function (err) {
				if (err && err.message === 'REQUIRE_AUTH_KEY') {
					apply('error', '需要访问密钥：请在「服务配置」核对 websocket_auth_key');
					return;
				}
			});
		}

		// 定期刷新 SIM 状态（卡插拔、初始化进度都会变）。
		// 传 card 作为作用域：卡片随视图卸载离开文档后，定时器自动停止，
		// 不会在切页后继续占着串口发 AT^SIMSQ?。
		api.interval(15000, refreshSimStatus, card);
		return card;
	};

	/* ================= 模态框 ================= */

	/*
	 * onCancel 是后加的第四个参数，可选：给「点击开关后弹确认」这类场景用，
	 * 取消时把开关拨回去。没有它时，加了确认反而会让界面状态与实际不符。
	 */
	api.confirm = function (message, onOk, okText, onCancel) {
		var mask = E('div', { 'class': 'mt5700-modal-mask' });
		var box = E('div', { 'class': 'mt5700-modal' });
		var text = E('div', { 'class': 'mt5700-modal-body' }, message);
		var actions = E('div', { 'class': 'mt5700-modal-footer' });
		var cancel = api.ghostButton('取消', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onCancel) onCancel();
		});
		var ok = api.primaryButton(okText || '确定', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onOk) onOk();
		});
		actions.appendChild(cancel);
		actions.appendChild(ok);
		box.appendChild(text);
		box.appendChild(actions);
		mask.appendChild(box);
		mask.addEventListener('click', function (e) {
			if (e.target === mask && mask.parentNode) mask.parentNode.removeChild(mask);
		});
		document.body.appendChild(mask);
		return mask;
	};

	/* ================= Toast 通知 ================= */

	api.toast = function (message, type) {
		type = type || 'info';
		var t = E('div', { 'class': 'mt5700-toast mt5700-toast-' + type }, message);
		document.body.appendChild(t);
		setTimeout(function () { t.classList.add('mt5700-toast-hide'); }, 3000);
		setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
	};

	api.success = function (m) { api.toast(m, 'success'); };
	api.error = function (m) { api.toast(m, 'error'); };
	api.warning = function (m) { api.toast(m, 'warning'); };
	api.info = function (m) { api.toast(m, 'info'); };

	/* ================= Loading / Error / Empty ================= */

	api.loading = function (text) {
		var el = E('div', { 'class': 'mt5700-loading' });
		el.appendChild(E('div', { 'class': 'mt5700-spinner' }));
		if (text) el.appendChild(E('div', { 'class': 'mt5700-loading-text' }, text));
		return el;
	};

	api.empty = function (text) {
		var el = E('div', { 'class': 'mt5700-empty' });
		el.appendChild(E('div', { 'class': 'mt5700-empty-text' }, text || '暂无数据'));
		return el;
	};

	api.errorState = function (text, onRetry) {
		var el = E('div', { 'class': 'mt5700-error-state' });
		el.appendChild(E('div', { 'class': 'mt5700-error-text' }, text || '获取数据失败'));
		if (onRetry) {
			el.appendChild(api.primaryButton('重新尝试', onRetry));
		}
		return el;
	};

	/* ================= 自动刷新 ================= */

	api.autoRefresh = function (onChange) {
		var wrap = E('div', { 'class': 'mt5700-autorefresh' });
		var enabled = true;
		var interval = 5;
		var chk = document.createElement('input');
		chk.type = 'checkbox';
		chk.checked = true;
		chk.addEventListener('change', function () {
			enabled = chk.checked;
			if (onChange) onChange(enabled, interval);
		});
		var label = E('label', {}, '自动刷新 ');
		label.insertBefore(chk, label.firstChild);
		var sel = document.createElement('select');
		[3, 5, 10, 15, 30, 60].forEach(function (s) {
			var opt = E('option', { value: String(s) }, s + ' 秒');
			if (s === interval) opt.selected = true;
			sel.appendChild(opt);
		});
		sel.addEventListener('change', function () {
			interval = parseInt(sel.value, 10);
			if (onChange) onChange(enabled, interval);
		});
		label.appendChild(sel);
		wrap.appendChild(label);
		return {
			el: wrap,
			enabled: function () { return enabled; },
			interval: function () { return interval; }
		};
	};

	/* ================= 定时器管理 ================= */

	var _timers = [];

	/**
	 * setInterval 包装：句柄记进 _timers，便于 Mt5700.clearAll() 统一清理。
	 *
	 * 传了 scopeEl 时额外启用「自动停止」：每次触发前先确认这个节点还在文档里，
	 * 不在就清掉自己。
	 *
	 * 为什么需要它：状态卡的 15s SIM 轮询是「画了卡片就起」的，而 LuCI 切页只是
	 * 换掉视图的 DOM，定时器本身不会停 —— 进一次页面多一个，切几次页就有几个
	 * 定时器在后台各发各的 `AT^SIMSQ?`。串口是独占的，这些无人消费的轮询会和
	 * 用户操作抢通道。
	 *
	 * 用「节点是否还在文档里」判断，比监听 hashchange 更稳：不依赖路由实现顺序，
	 * 也不会把新页面刚注册的定时器误清掉。
	 */
	api.interval = function (ms, fn, scopeEl) {
		var stopped = false;
		var id = null;
		var stop = function () {
			if (stopped) return;
			stopped = true;
			if (id !== null) clearInterval(id);
			var i = _timers.indexOf(stop);
			if (i >= 0) _timers.splice(i, 1);
		};
		id = setInterval(function () {
			var doc = scopeEl ? scopeEl.ownerDocument : null;
			if (doc && !doc.contains(scopeEl)) {
				stop();
				return;
			}
			fn();
		}, ms);
		_timers.push(stop);
		return id;
	};

	api.clearAll = function () {
		_timers.slice().forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
		_timers = [];
	};

	/*
	 * 元素离开文档后执行一次 fn（订阅类资源的卸载钩子）。
	 *
	 * 定时器有句柄可清，订阅没有 —— 像「连接状态回调」是一旦 push 就常驻在
	 * 客户端全局数组里的，页面切走后照样会被触发，闭包还一直攥着本页的 DOM。
	 * api.interval 的 scopeEl 解决不了这类资源，故补一个统一的退出钩子。
	 *
	 * 判据沿用 page 的做法：认「曾经进入过文档、现在脱离了」这个**转换**，
	 * 而不是「现在不在文档里」—— 节点刚构建、尚未插入文档的那一瞬本来就不在，
	 * 只认转换才不会把刚建好的页面误清掉。
	 */
	api.onDetach = function (el, fn) {
		if (!el || typeof fn !== 'function') return function () {};
		var doc = el.ownerDocument || document;
		var wasInDoc = false;
		var done = false;
		var id = setInterval(function () {
			if (doc.contains(el)) { wasInDoc = true; return; }
			if (!wasInDoc) return;
			clearInterval(id);
			if (done) return;
			done = true;
			try { fn(); } catch (e) { /* 清理失败不能影响其余 */ }
		}, 1000);
		return function () {
			clearInterval(id);
			if (done) return;
			done = true;
			try { fn(); } catch (e) { /* 同上 */ }
		};
	};

	/* ================= 图表 ================= */

	var _gradSeq = 0;

	/**
	 * 实时速率折线图（v2 视觉版）
	 * - 双折线（下行/上行）+ 下行面积渐变填充
	 * - 悬浮提示（tooltip，L4 浮层），数据格式通过 options.tipFormat(point, index) 定制
	 * - 函数签名与数据格式（[{down, up}, ...]）与 v1 完全兼容，旧调用无需改动
	 */
	api.lineChart = function (data, options) {
		options = options || {};
		var w = options.width || 600;
		var h = options.height || 160;
		var max = options.max || 1;
		// 图表颜色同样跟随主题（深色下用更亮的蓝 / 青，否则深底上几乎看不见）
		var downColor = options.downColor || cssColor('--mt5700-accent', '#2563eb');
		var upColor = options.upColor || cssColor('--mt5700-sig-good', '#0b7a70');

		// 外层容器（tooltip 需要 relative 定位与 L4 浮层）
		var wrap = E('div', { style: 'position:relative;width:100%;height:100%;' });
		var svg = svgEl('svg', {
			viewBox: '0 0 ' + w + ' ' + h,
			preserveAspectRatio: 'none'
		});
		wrap.appendChild(svg);
		var tip = E('div', { 'class': 'mt5700-chart-tip' });
		wrap.appendChild(tip);

		if (!data || !data.length) {
			return wrap;
		}

		// 找最大值（自然取整到 10 的倍数刻度，避免顶格）
		var actualMax = max;
		if (actualMax <= 1) {
			data.forEach(function (p) {
				actualMax = Math.max(actualMax, p.down || 0, p.up || 0);
			});
		}

		// 面积渐变定义
		var gradId = 'mt5700-grad-' + (++_gradSeq);
		var defs = svgEl('defs');
		var grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
		var stop1 = svgEl('stop', { offset: '0%', 'stop-color': downColor, 'stop-opacity': 0.22 });
		var stop2 = svgEl('stop', { offset: '100%', 'stop-color': downColor, 'stop-opacity': 0 });
		grad.appendChild(stop1);
		grad.appendChild(stop2);
		defs.appendChild(grad);
		svg.appendChild(defs);

		// 网格线
		var gridCount = 4;
		for (var i = 0; i <= gridCount; i++) {
			var gy = 10 + (h - 30) * i / gridCount;
			svg.appendChild(svgEl('line', {
				x1: 2, y1: gy, x2: w - 2, y2: gy,
				stroke: cssColor('--mt5700-border-strong', 'rgba(138, 147, 160, 0.4)'),
				'stroke-width': 1
			}));
		}

		var n = data.length;
		function px(j) { return (j / Math.max(1, n - 1)) * (w - 4) + 2; }
		function py(v) { return h - 15 - (v / actualMax) * (h - 30); }

		var downPts = [], upPts = [];
		for (var j = 0; j < n; j++) {
			downPts.push(px(j).toFixed(1) + ',' + py(data[j].down || 0).toFixed(1));
			upPts.push(px(j).toFixed(1) + ',' + py(data[j].up || 0).toFixed(1));
		}

		// 下行面积填充
		if (n > 1) {
			svg.appendChild(svgEl('polygon', {
				fill: 'url(#' + gradId + ')',
				points: downPts.join(' ') + ' ' + px(n - 1).toFixed(1) + ',' + (h - 15) + ' ' + px(0).toFixed(1) + ',' + (h - 15)
			}));
		}

		// 双折线
		if (n > 1) {
			svg.appendChild(svgEl('polyline', {
				fill: 'none', stroke: downColor, 'stroke-width': 2,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				points: downPts.join(' ')
			}));
			svg.appendChild(svgEl('polyline', {
				fill: 'none', stroke: upColor, 'stroke-width': 2,
				'stroke-linejoin': 'round', 'stroke-linecap': 'round',
				points: upPts.join(' ')
			}));
		}

		// 悬浮提示：跟随鼠标取最近采样点
		function fmtDefault(p) {
			function f(v) { return v >= 1e6 ? (v / 1e6).toFixed(2) + ' Mbps' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' Kbps' : Math.round(v) + ' bps'; }
			return '↓ ' + f(p.down || 0) + ' · ↑ ' + f(p.up || 0);
		}
		wrap.addEventListener('mousemove', function (e) {
			var rect = wrap.getBoundingClientRect();
			var ratio = (e.clientX - rect.left) / Math.max(1, rect.width);
			var idx = Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
			var p = data[idx];
			if (!p) return;
			tip.textContent = options.tipFormat ? options.tipFormat(p, idx) : fmtDefault(p);
			var tx = Math.max(60, Math.min(rect.width - 60, px(idx) / w * rect.width));
			tip.style.left = tx + 'px';
			tip.style.top = (Math.max(py(p.down || 0), py(p.up || 0)) / h * rect.height) + 'px';
			tip.classList.add('show');
		});
		wrap.addEventListener('mouseleave', function () {
			tip.classList.remove('show');
		});

		return wrap;
	};

	// 信号强度条
	api.signalBar = function (value, max) {
		max = max || 100;
		var percent = Math.min(100, Math.max(0, (value / max) * 100));
		var color = percent >= 70 ? 'var(--mt5700-success)' :
				percent >= 40 ? 'var(--mt5700-warning)' : 'var(--mt5700-danger)';

		var el = E('div', { 'class': 'mt5700-signal-bar' });
		var bar = E('div', { 'class': 'mt5700-signal-bar-fill' });
		bar.style.width = percent + '%';
		bar.style.background = color;
		el.appendChild(bar);
		return el;
	};

	/* ================= 表格 ================= */

	api.table = function (headers, rows, options) {
		options = options || {};
		var wrapper = E('div', { 'class': 'mt5700-table-wrapper' });
		var table = E('table', { 'class': 'mt5700-table' });
		if (options.striped) table.classList.add('mt5700-table-striped');

		// 表头
		var thead = E('thead');
		var tr = E('tr');
		headers.forEach(function (h) {
			tr.appendChild(E('th', {}, h));
		});
		thead.appendChild(tr);
		table.appendChild(thead);

		// 表体
		var tbody = E('tbody');
		if (!rows || !rows.length) {
			var tr0 = E('tr');
			tr0.appendChild(E('td', { colspan: headers.length, 'class': 'mt5700-empty' }, '暂无数据'));
			tbody.appendChild(tr0);
		} else {
			rows.forEach(function (row) {
				var tr = E('tr');
				row.forEach(function (cell) {
					if (typeof cell === 'object' && cell.nodeType) {
						var td = E('td');
						td.appendChild(cell);
						tr.appendChild(td);
					} else {
						tr.appendChild(E('td', {}, cell || '—'));
					}
				});
				tbody.appendChild(tr);
			});
		}
		table.appendChild(tbody);
		wrapper.appendChild(table);
		return wrapper;
	};

	/* ================= 表单 ================= */

	api.formGroup = function (label, input, hint, required) {
		var group = E('div', { 'class': 'mt5700-form-group' });
		var lbl = E('label', { 'class': 'mt5700-label' + (required ? ' mt5700-label-required' : '') }, label);
		group.appendChild(lbl);
		group.appendChild(input);
		if (hint) group.appendChild(E('div', { 'class': 'mt5700-hint' }, hint));
		return group;
	};

	api.input = function (type, placeholder, value) {
		var input = E('input', { 'class': 'mt5700-input', type: type || 'text' });
		if (placeholder) input.placeholder = placeholder;
		if (value != null) input.value = value;
		return input;
	};

	api.select = function (options, value) {
		var sel = E('select', { 'class': 'mt5700-input mt5700-select' });
		options.forEach(function (opt) {
			var o = E('option', { value: opt.value }, opt.label);
			if (opt.value === value) o.selected = true;
			sel.appendChild(o);
		});
		return sel;
	};

	/* ================= 面板操作区 ================= */

	api.panelActions = function () {
		var el = E('div', { 'class': 'mt5700-panel-actions' });
		for (var i = 0; i < arguments.length; i++) {
			el.appendChild(arguments[i]);
		}
		return el;
	};

	/* ================= 未保存更改（暂存 / 保存并应用 / 撤销） ================= */

	/*
	 * OpenWrt 标准「保存并应用」语义的前端实现：
	 * - 页面修改不立即下发，先调用 staged.set(key, label, run) 暂存
	 * - 同一 key 重复修改自动覆盖（只应用最后一次）
	 * - 悬浮条实时显示未保存项数量，提供「保存并应用」「撤销更改」两个入口
	 * - 应用时逐项执行 run()（返回 Promise），成功/失败后回调刷新实际状态
	 */
	api.staged = function (options) {
		options = options || {};
		var items = []; // { key, label, run }
		var bar = E('div', { 'class': 'mt5700-applybar mt5700-applybar-hidden' });
		var text = E('span', { 'class': 'mt5700-applybar-text' });
		var actions = E('div', { 'class': 'mt5700-applybar-actions' });
		var revertBtn = api.ghostButton('撤销更改', doRevert);
		var applyBtn = api.primaryButton('保存并应用', doApply);
		actions.appendChild(revertBtn);
		actions.appendChild(applyBtn);
		bar.appendChild(text);
		bar.appendChild(actions);

		function refresh() {
			if (items.length) {
				text.textContent = '有 ' + items.length + ' 项未保存的更改';
				bar.classList.remove('mt5700-applybar-hidden');
			} else {
				bar.classList.add('mt5700-applybar-hidden');
			}
		}

		function doApply() {
			if (!items.length) return;
			var queue = items.slice();
			applyBtn.disabled = true;
			revertBtn.disabled = true;
			text.textContent = '正在应用更改（' + queue.length + ' 项）…';
			/*
			 * 逐项执行，且**不让任何一项的失败中断后续项**。
			 *
			 * 早先的写法是 `chain = chain.then(function(){ return it.run(); })`
			 * 串成一条链：只要第 1 项失败（或 reject），链直接跳到末尾的 catch，
			 * 后面所有暂存项**一次都不会执行**，用户只看到一句「应用更改失败」，
			 * 却不知道 APN 改了、USB 模式没改。拨号页正是同时暂存多项的场景。
			 * 这里改为：每项各自 catch，失败记下来，成功的从暂存列表移除；
			 * 全部跑完再按失败数量给出结论。
			 */
			var failed = [];
			var chain = Promise.resolve();
			queue.forEach(function (it) {
				chain = chain.then(function () {
					return Promise.resolve()
						.then(function () { return it.run(); })
						.then(function () {
							/* 成功：从暂存列表移除，避免失败项重跑时它被重复下发 */
							var i = items.indexOf(it);
							if (i >= 0) items.splice(i, 1);
						})
						.catch(function (err) {
							failed.push(it.label + '：' + ((err && err.message) || '失败'));
						});
				});
			});
			return chain.then(function () {
				if (!failed.length) {
					items = [];
					api.success('更改已应用');
				} else if (failed.length === queue.length) {
					api.error('全部 ' + failed.length + ' 项都未应用：' + failed[0]);
				} else {
					api.error('已应用 ' + (queue.length - failed.length) + ' 项，' +
						failed.length + ' 项失败：' + failed.join('；'));
				}
			}).then(function () {
				applyBtn.disabled = false;
				revertBtn.disabled = false;
				refresh();
				/* 成败都重新拉取，让界面与实际状态对齐 */
				if (options.onChanged) options.onChanged();
			});
		}

		function doRevert() {
			api.confirm('确定放弃全部未保存的更改？', function () {
				items = [];
				refresh();
				if (options.onChanged) options.onChanged();
			}, '放弃更改');
		}

		return {
			el: bar,
			/* key 相同的暂存项会被覆盖，避免重复下发同一配置 */
			set: function (key, label, run) {
				for (var i = 0; i < items.length; i++) {
					if (items[i].key === key) {
						items[i].label = label;
						items[i].run = run;
						refresh();
						return;
					}
				}
				items.push({ key: key, label: label, run: run });
				refresh();
			},
			remove: function (key) {
				items = items.filter(function (it) { return it.key !== key; });
				refresh();
			},
			clear: function () { items = []; refresh(); },
			count: function () { return items.length; }
		};
	};

	/* ================= 速率显示 (L3 浮动) ================= */

	api.speedBox = function (label, value) {
		var box = E('div', { 'class': 'mt5700-speed-box' });
		box.appendChild(E('span', { 'class': 'mt5700-speed-label' }, label));
		box.appendChild(E('span', { 'class': 'mt5700-speed-value' }, value));
		return box;
	};

	return api;
})();

// 导出
var Mt5700Class = L.Class.extend(Mt5700);
if (typeof window !== 'undefined') {
	window.Mt5700 = new Mt5700Class();
}
return Mt5700Class;
