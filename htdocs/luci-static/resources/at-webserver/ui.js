'use strict';
'require baseclass';
'require at-webserver/compat';
'require at-webserver/rpc';
'require at-webserver/parse';
/* global L, AtWs, Parse, baseclass */

/**
 * LuCI 页面公共 UI 辅助。
 *
 * 本文件只留**真有调用点**的入口：弹窗（promptModal）、AT 发送封装
 * （sendCmd / sleep / atErrorText / setFlightMode）与自动刷新（autoRefresh / interval）。
 * 页面骨架与提示（page / card / toast / confirm / empty …）一律走 mt5700.js 那套，
 * 详见下面「死代码清理」的说明 —— 这里曾经并存两套，是"改了没变化"的经典来源。
 */

/* 样式统一由 mt5700.css 提供（mt5700.js 负责注入），本文件不再注入任何样式表。
   所有页面都会 require at-webserver/mt5700，因此 mt5700.css 一定已加载。 */

var Ui = (function () {
	var api = {};

	// 所有按钮都经由此卡口创建。cls 接收视图传入的 cbi-button-* 变体，
	// 通过映射附加 at-btn-* 系列类：外观完全由 mt5700.css 决定，不受 LuCI 主题影响。
	api.button = function (label, cls, onClick) {
		var map = {
			'cbi-button-positive': 'at-btn-primary',
			'cbi-button-negative': 'at-btn-danger',
			'cbi-button-neutral': 'at-btn-neutral',
			'cbi-button-action': 'at-btn-action'
		};
		var extra = (cls || '').split(/\s+/).map(function (c) { return map[c] || ''; }).join(' ');
		var btn = E('button', { 'class': 'at-btn ' + extra + ' ' + (cls || '') }, label);
		btn.addEventListener('click', onClick);
		return btn;
	};

	/*
	 * ★ 死代码清理（2026-09-22 全量审查）：本文件原先还导出 panel / field / kv /
	 *   tag / primaryButton / dangerButton / toast(+success/error/warning/info) /
	 *   confirm / renderConnectionBar / deriveNetworkMode / page / spinner /
	 *   subscribe 共 13 个函数，全仓库 grep 下来**一个调用点都没有** —— 页面实际
	 *   用的是 mt5700.js 那套（Mt5700.page / Mt5700.toast / Mt5700.confirm …）。
	 *   两库并存的结果是：改了 mt5700.js 的 toast 样式，ui.js 那份（用的是旧的
	 *   at-toast 类）纹丝不动，读代码的人还得先判断「该用哪个」。
	 *   现已全部删除；下面只保留**真有调用点**的入口
	 *   （`api.button` 无外部调用点，但 promptModal 内部要用，留在原处）。
	 */


	api.promptModal = function (title, fields, onOk) {
		var mask = E('div', { 'class': 'at-modal-mask' });
		var box = E('div', { 'class': 'at-modal at-modal-wide' });
		var h = E('h4', { 'class': 'at-modal-title' }, title);
		var body = E('div', { 'class': 'at-modal-body' });
		var inputs = {};
		for (var i = 0; i < fields.length; i++) {
			var f = fields[i];
			var row = E('div', { 'class': 'at-field' });
			row.appendChild(E('div', { 'class': 'at-field-label' }, f.label));
			var ctrl = E('div', { 'class': 'at-field-control' });
			var input;
			if (f.type === 'select') {
				input = document.createElement('select');
				input.className = 'cbi-input-select';
				for (var j = 0; j < f.options.length; j++) {
					var opt = document.createElement('option');
					opt.value = String(f.options[j].value);
					opt.textContent = f.options[j].label;
					if (String(f.options[j].value) === String(f.value)) opt.selected = true;
					input.appendChild(opt);
				}
			} else {
				input = document.createElement('input');
				input.type = f.type === 'password' ? 'password' : 'text';
				input.className = 'cbi-input-text';
				if (f.value != null) input.value = String(f.value);
				if (f.placeholder) input.placeholder = f.placeholder;
			}
			ctrl.appendChild(input);
			if (f.hint) ctrl.appendChild(E('div', { 'class': 'at-field-hint' }, f.hint));
			row.appendChild(ctrl);
			body.appendChild(row);
			inputs[f.key] = input;
		}
		var actions = E('div', { 'class': 'at-modal-actions' });
		var cancel = api.button('取消', 'cbi-button-neutral', function () {
			if (mask.parentNode) mask.parentNode.removeChild(mask);
		});
		var ok = api.button('确定', 'cbi-button-positive', function () {
			var values = {};
			for (var key in inputs) values[key] = inputs[key].value;
			if (mask.parentNode) mask.parentNode.removeChild(mask);
			if (onOk) onOk(values);
		});
		actions.appendChild(cancel);
		actions.appendChild(ok);
		box.appendChild(h);
		box.appendChild(body);
		box.appendChild(actions);
		mask.appendChild(box);
		mask.addEventListener('click', function (e) {
			if (e.target === mask && mask.parentNode) mask.parentNode.removeChild(mask);
		});
		document.body.appendChild(mask);
		return mask;
	};

	/* ---------- 连接状态条 ---------- */

	/* ---------- 常用 AT 辅助（等价 modem/atx.ts） ---------- */

	api.sleep = function (ms) {
		return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
	};

	// 原前端发命令前固定等 100ms，保证命令间隔
	api.sendCmd = function (command) {
		return api.sleep(100).then(function () { return AtWs.client.sendCommand(command); });
	};

	// 错误文本还原（等价 atx.ts 的 atErrorText）
	api.atErrorText = function (res, fallback) {
		if (!res || res.success) return fallback;
		var msg = res.error || fallback;
		if (typeof msg === 'string' && msg.indexOf('CME ERROR') >= 0) {
			var code = msg.match(/CME ERROR:\s*(\d+)/);
			if (code) {
				var map = {
					'1': '未指定的错误', '3': '操作不允许', '4': '操作不支持', '10': '模组忙',
					'11': 'PIN 未输入或错误', '13': 'SIM 故障', '14': 'SIM 已满', '21': '无效字符',
					'22': '无效索引', '100': '未知错误', '513': 'SIM 锁定', '515': 'SIM 错误',
					'516': '内存满', '517': '无效内存索引', '518': '内存错误'
				};
				return map[code[1]] || msg;
			}
		}
		return msg;
	};

	// 飞行模式：CFUN=0 开启（关射频），CFUN=1 关闭。返回是否成功。
	api.setFlightMode = function (on) {
		return api.sendCmd('AT+CFUN=' + (on ? '0' : '1')).then(function (res) { return !!res.success; });
	};

	/* ---------- 通用渲染 ---------- */

	/* ---------- 自动刷新（等价原 AutoRefresh 组件） ---------- */

	/*
	 * 自定义间隔的上下限（秒）。
	 *
	 * 下限不能是 0，这不是洁癖：调用方（network_status.js 的 resetTimers）把
	 * interval 直接当 setInterval 的毫秒基数，而按 HTML 标准，定时器延时为 0
	 * 时会被钳到约 4ms（嵌套层级下的最小值）。真落到 0，「自动刷新」就变成
	 * 每 4 毫秒打一次串口 —— AT 通道是独占的，等于把自己打死。
	 * 上限只防手滑多敲几个 0，换来一个永远等不到的刷新。
	 */
	var AR_MIN_SEC = 2;
	var AR_MAX_SEC = 3600;
	var AR_CUSTOM_VALUE = 'custom';

	/*
	 * 把任意输入收敛成合法秒数；解析不出数字返回 null（由调用方保持原值，
	 * 不猜一个数、也不让界面显示与真实间隔不符）。
	 * parseInt 首位非数字即 NaN（MDN: parseInt），故 '' / 'abc' 都会走 null。
	 */
	function clampRefreshSec(value) {
		var n = parseInt(value, 10);
		if (isNaN(n)) return null;
		return Math.min(AR_MAX_SEC, Math.max(AR_MIN_SEC, n));
	}

	// 自动刷新开关 + 间隔（六档预设 + 自定义秒数）。返回 { el, setEnabled, setInterval, getInterval, isEnabled }
	api.autoRefresh = function (onChange) {
		var wrap = E('div', { 'class': 'at-autorefresh' });
		var enabled = true;
		var interval = 5;
		var chk = document.createElement('input');
		chk.type = 'checkbox';
		chk.checked = true;
		var label = E('label', { 'class': 'at-autorefresh-label' }, '自动刷新 ');
		label.insertBefore(chk, label.firstChild);
		var sel = document.createElement('select');
		sel.className = 'cbi-input-select';
		sel.style.width = '110px';
		[3, 5, 10, 15, 30, 60].forEach(function (s) {
			var opt = document.createElement('option');
			opt.value = String(s);
			opt.textContent = s + ' 秒';
			if (s === interval) opt.selected = true;
			sel.appendChild(opt);
		});
		var customOpt = document.createElement('option');
		customOpt.value = AR_CUSTOM_VALUE;
		customOpt.textContent = '自定义…';
		sel.appendChild(customOpt);

		/* 自定义秒数：只在选中「自定义…」时才出现，平时不占版面。
		   用 number 而不是 text：由浏览器先挡掉一批非法输入，
		   真值仍以 clampRefreshSec 为准（type=number 挡不住手敲的 0）。 */
		var custom = document.createElement('input');
		custom.type = 'number';
		custom.className = 'cbi-input-text';
		custom.min = String(AR_MIN_SEC);
		custom.max = String(AR_MAX_SEC);
		custom.step = '1';
		custom.style.width = '72px';
		custom.style.display = 'none';
		custom.title = '自定义刷新间隔，' + AR_MIN_SEC + '~' + AR_MAX_SEC + ' 秒';

		function emit() { if (onChange) onChange(enabled, interval); }

		/* 把 interval 反映到控件上：命中预设就选预设，否则切到「自定义…」并回填秒数。
		   回填是必须的 —— 用户填 1 得到 2，界面必须写 2，否则界面在说谎。 */
		function syncControls() {
			var hit = false;
			for (var i = 0; i < sel.options.length; i++) {
				if (sel.options[i].value === String(interval)) { hit = true; break; }
			}
			if (hit) sel.value = String(interval);
			else { sel.value = AR_CUSTOM_VALUE; custom.value = String(interval); }
			custom.style.display = sel.value === AR_CUSTOM_VALUE ? '' : 'none';
		}

		function applyCustom() {
			var v = clampRefreshSec(custom.value);
			/* 非法输入：回填当前真值即可，不改间隔、不通知调用方 */
			if (v == null) { syncControls(); return; }
			interval = v;
			syncControls();
			emit();
		}

		sel.addEventListener('change', function () {
			if (sel.value === AR_CUSTOM_VALUE) {
				/* 只展开输入框并预填当前值，等用户填完再改间隔 ——
				   选中的瞬间就改会让间隔莫名其妙跳一次 */
				custom.style.display = '';
				custom.value = String(interval);
				custom.focus();
				return;
			}
			interval = parseInt(sel.value, 10);
			custom.style.display = 'none';
			emit();
		});
		/* 用 change（失焦/回车）而不是 input：逐字符通知会不停地重建定时器 */
		custom.addEventListener('change', applyCustom);
		custom.addEventListener('keydown', function (e) {
			if (e.key === 'Enter') { e.preventDefault(); applyCustom(); }
		});
		chk.addEventListener('change', function () {
			enabled = chk.checked;
			emit();
		});
		label.appendChild(sel);
		label.appendChild(custom);
		wrap.appendChild(label);
		return {
			el: wrap,
			setEnabled: function (v) { enabled = !!v; chk.checked = !!v; emit(); },
			setInterval: function (s) {
				/* 非法值直接拒绝，保留当前间隔（不猜值） */
				var v = clampRefreshSec(s);
				if (v == null) return;
				interval = v;
				syncControls();
				emit();
			},
			getInterval: function () { return interval; },
			isEnabled: function () { return enabled; }
		};
	};

	/* ---------- 定时器/订阅生命周期（切页自动清理） ---------- */

	var _hooks = [];

	function _installHashHook() {
		if (_installHashHook._done) return;
		_installHashHook._done = true;
		window.addEventListener('hashchange', function () {
			// 延后一拍，避免同 tick 内先注册又被立刻清掉
			setTimeout(function () {
				var old = _hooks;
				_hooks = [];
				old.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
			}, 0);
		});
	}

	/**
	 * set interval，路由切换（hashchange）时自动 clear。
	 * 返回原 timer id。
	 */
	api.interval = function (ms, fn) {
		_installHashHook();
		var id = setInterval(fn, ms);
		_hooks.push(function () { clearInterval(id); });
		return id;
	};

	return api;
})();

var UiClass = L.Class.extend(Ui);
if (typeof window !== 'undefined') {
	window.Ui = new UiClass();
}
return UiClass;
