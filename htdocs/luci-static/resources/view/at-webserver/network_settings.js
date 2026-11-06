'use strict';
'require at-webserver/rpc';
'require at-webserver/parse';
'require at-webserver/ui';
'require at-webserver/mt5700';
'require at-webserver/schedule_panel';
/* global L, AtWs, Parse, Ui, Mt5700, SchedulePanel */

/**
 * 网络设置 - 新 UI 视觉 + 基准 v1.3.4 功能
 *
 * 等价迁移原 WebUI network/Settings.tsx：LTE/NR 锁频、5G 选项、网络拒绝。
 * 5G 选项（C5GOPTION）、网络拒绝原因（^REJINFO 主动上报）。
 * 锁频应用流程与基准一致：飞行模式 → 下发锁频命令 → 关闭飞行模式 → 重新查询。
 *
 * v2.4.31：「定时锁频」原为独立菜单页（view/at-webserver/schedule.js），
 * 现归并到本页「锁频设置」之后 —— 手动锁频与按时段自动锁频是同一条主题，
 * 拆成两个菜单项只会让人来回跳页。面板实现在 at-webserver/schedule_panel.js。
 */

return L.view.extend({
	render: function () {
		var self = this;
		var page = Mt5700.page('网络设置', 'LTE / NR 锁频、定时编排、5G 选项与网络拒绝');
		var body = page._body;

		var connBar = E('div');
		body.appendChild(connBar);
		Mt5700.renderConnectionBar(connBar);

		/* ---------- 锁频编辑器状态 ---------- */
		var lockState = {
			lteType: 0, lteMobility: 0, lteItems: [{}],
			nrType: 0, nrMobility: 0, nrItems: [{}],
			option5g: null
		};

		/*
		 * 结构：接入模式 → 锁频设置 → 定时锁频 → 邻区扫描 → SSB 信息 → 网络拒绝。
		 * 锁频的 4G/5G 由「制式」分段切换共用一套编辑器（不再并排两块重复表单）。
		 */

		/* ---------- 5G 接入模式设置（放在最上：改完要重启，属于前置决策） ---------- */
		var optCard = Mt5700.card('5G 接入模式设置', '设置前自动切飞行模式；切换后需软重启生效');
		var optBody = E('div');
		optCard._body.appendChild(optBody);
		body.appendChild(optCard);

		/* ---------- 出口 TTL ---------- */
		/*
		 * 为什么需要：5G 模组出来的包每经一次转发 TTL 减 1。部分运营商按 TTL
		 * 判定「共享 / 二手流量」后直接丢包或限速，现场特征是
		 * **客户端 TCP 全超时、但 ICMP 与 DNS 通、路由器自身 TCP 也通**。
		 *
		 * ★ 状态只信后端回的 applied / effective（真的在 nft 链里查到），
		 *   不信本地输入框。配置写成开启、规则却没生效是真实可能发生的
		 *   （fw4 重载失败、链被别的插件清掉），那种情况必须在界面上说出来。
		 */
		var ttlCard = Mt5700.card('出口 TTL',
			'把经路由器转发的包统一成同一个 TTL，规避运营商按 TTL 判定共享流量');
		var ttlBody = E('div');
		ttlCard._body.appendChild(ttlBody);
		/* 同上：排到锁频之后，与 DNS 相邻。 */

		var ttlState = { primed: false };
		var ttlSel = null, ttlInput = null, ttlSaveBtn = null;

		function renderTtl() {
			ttlBody.innerHTML = '';
			ttlSel = null;
			ttlInput = null;

			if (!ttlState.primed) {
				ttlBody.appendChild(E('p', { 'class': 'mt5700-hint' }, '正在读取当前状态…'));
				return;
			}

			var row = E('div', { 'class': 'mt5700-dns-row' });
			row.appendChild(E('label', { 'class': 'mt5700-dns-label' }, '统一 TTL'));
			ttlSel = Mt5700.select([
				{ value: '0', label: '关闭（保持原样）' },
				{ value: '1', label: '开启' }
			], ttlState.enabled ? '1' : '0');
			row.appendChild(ttlSel);
			ttlBody.appendChild(row);

			var row2 = E('div', { 'class': 'mt5700-dns-row' });
			row2.appendChild(E('label', { 'class': 'mt5700-dns-label' }, 'TTL 值'));
			ttlInput = Mt5700.input('text', '1-255，默认 128', String(ttlState.value));
			row2.appendChild(ttlInput);
			ttlBody.appendChild(row2);

			var bar = E('div', { 'class': 'mt5700-action-row mt5700-mt-sm' });
			ttlSaveBtn = Mt5700.primaryButton('保存并应用', commitTtl);
			bar.appendChild(ttlSaveBtn);
			ttlBody.appendChild(bar);

			/* ---- 状态行：把「配置」和「实际」分开说 ---- */
			var cls = 'mt5700-hint mt5700-mt-sm';
			var text;
			if (!ttlState.enabled) {
				text = '当前关闭：转发出去的包保持原 TTL。';
			} else if (ttlState.applied) {
				text = '已生效：实际 TTL ' + ttlState.effective
					+ (ttlState.lan_if ? '，只作用于 ' + ttlState.lan_if + ' 转发出去的流量' : '') + '。';
				cls = 'mt5700-notice mt5700-mt-sm';
			} else {
				/* 最容易被忽略的一种：开关显示开着，规则其实不在 */
				text = '配置已开启，但规则没有生效 —— 点「保存并应用」重新应用一次。';
				cls = 'mt5700-notice-warning mt5700-mt-sm';
			}
			ttlBody.appendChild(E('div', { 'class': cls }, text));

			/* ★ offload 开着 = 这个功能静默失效：已建立的连接走快路径，不经过 netfilter。
			   后端只报告状态、不擅自改配置（关 offload 要重启防火墙，会断所有连接）。 */
			if (ttlState.offload_on) {
				ttlBody.appendChild(E('div', { 'class': 'mt5700-notice-warning mt5700-mt-sm' },
					'检测到软件 / 硬件流量分载（flow offloading）处于开启状态：'
					+ '已建立的连接会绕过本规则，TTL 不会被修改。'
					+ '需要到「网络 → 防火墙」关闭流量分载后重新应用。'));
			}

			ttlBody.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
				'同时设置 IPv4 的 TTL 与 IPv6 的 Hop Limit。'
				+ '规则挂在防火墙的 postrouting 上，防火墙重载后会自动重建，重启也不丢。'));
		}

		function ttlApplyState(r) {
			ttlState = {
				primed: true,
				enabled: r && r.enabled ? 1 : 0,
				value: (r && r.value != null) ? r.value : 128,
				applied: !!(r && r.applied),
				effective: (r && r.effective != null) ? r.effective : null,
				lan_if: (r && r.lan_if) || null,
				offload_on: !!(r && r.offload_on)
			};
			renderTtl();
		}

		function commitTtl() {
			if (!ttlSel || !ttlInput) return;
			var en = ttlSel.value === '1' ? '1' : '0';
			var val = String(ttlInput.value || '').trim();

			if (en === '1') {
				/* 前端先挡一道：明显非法的值不必往返后端。
				   ★ 真正的守门人在后端（ttlValueOk），这里只是省一次网络往返。 */
				if (!/^[0-9]{1,3}$/.test(val) || Number(val) < 1 || Number(val) > 255) {
					Mt5700.error('TTL 必须是 1-255 之间的整数');
					return;
				}
			}

			ttlSaveBtn.disabled = true;
			ttlSel.disabled = true;
			ttlInput.disabled = true;
			Mt5700.info(en === '1' ? '正在应用 TTL ' + val + '…' : '正在关闭 TTL…');

			AtWs.ttl({ action: 'set', enabled: en, value: en === '1' ? val : '' })
				.then(function (r) {
					if (!r || !r.success) {
						Mt5700.error('保存失败：' + ((r && r.error) || '未知错误'));
						ttlApplyState(Object.assign({}, ttlState, { primed: true }));
						return;
					}
					ttlApplyState(r);
					if (en === '1') {
						if (r.applied) {
							Mt5700.info('TTL 已生效：' + r.effective);
						} else {
							Mt5700.error('配置已保存，但规则没有生效 —— 请检查防火墙状态后重试');
						}
					} else {
						Mt5700.info('已关闭 TTL 改写');
					}
				});
		}

		ttlBody.appendChild(E('p', { 'class': 'mt5700-hint' }, '正在读取当前状态…'));
		AtWs.ttl({ action: 'get' }).then(function (r) {
			if (!r || !r.success) {
				ttlState = { primed: true, enabled: 0, value: 128, applied: false, error: r && r.error };
				renderTtl();
				ttlBody.appendChild(E('p', { 'class': 'mt5700-hint mt5700-mt-sm' },
					'读不到 TTL 状态：' + ((r && r.error) || '后端未升级')));
				return;
			}
			ttlApplyState(r);
		});

		/* ---------- 锁频设置（4G / 5G 合并到一处） ---------- */
		var refreshLockBtn = Mt5700.button('刷新锁频状态', function () { fetchCurrent(); });
		var saveLockBtn = Mt5700.primaryButton('保存设置', function () { saveActiveLock(); });
		var lockTools = E('div', { 'class': 'mt5700-toolbar' });
		lockTools.appendChild(refreshLockBtn);
		lockTools.appendChild(saveLockBtn);

		var lockCard = Mt5700.card('锁频设置', '先选制式，再设锁频类型与参数；「保存设置」下发当前制式的配置', lockTools);
		var lockBody = E('div');
		lockCard._body.appendChild(lockBody);
		body.appendChild(lockCard);
		var lockCardSub = lockCard.querySelector('.mt5700-card-subtitle');
		var lockEditorBox = E('div');
		/* 影响预告放在编辑器之前：保存锁频要先切飞行模式，这一步会立刻断网，
		   而卡头说明里一个字都没提。用户点之前就得知道。 */
		lockBody.appendChild(Mt5700.impact(['保存时先切飞行模式再重新驻网：', { b: '当前连接会中断' },
			'；锁到本地区没有的频段就再也连不上，得回本页改回「关闭」或换频段。']));
		lockBody.appendChild(lockEditorBox);

		/* ---------- 定时锁频（v2.4.31 从独立页面并入，实现见 schedule_panel.js） ----------
		 *
		 * 放在「锁频设置」之后是刻意的：手动锁的是「现在锁什么」，
		 * 定时锁的是「几点到几点锁什么」，同一件事的两个时间尺度，隔页反而割裂。
		 * 面板自带「运行状态（含总开关）+ 编排配置」两张卡，本页只负责给它容器。
		 * ★ 它自己的 15s 轮询由 SchedulePanel.dispose() 收，见下方 _dispose。
		 */
		SchedulePanel.render(body);

		/* ---------- 区块顺序：接入与频段 → 出口 → 网络诊断 ----------
		 *
		 * 2026-11-06 重排。原来自定义 DNS 卡与 TTL 卡夹在「5G 接入模式」和
		 * 「锁频设置」之间，把「改怎么连」切成了两段 —— 接入模式与锁频是一件事，
		 * 中间插进两张出口侧的卡，读到第三张时已经忘了第一张在说什么。
		 *
		 * 现在按**功能域连续**排：
		 *   ① 接入与频段：5G 接入模式 → 锁频设置 → 定时锁频
		 *   ② 出口：出口 TTL
		 *   ③ 网络诊断：邻区扫描 → 网络拒绝（只读观测，放最后）
		 * ★ 只改追加顺序，不动任何卡片的定义与内部逻辑，所以事件监听、定时器、
		 *   清理路径全部照旧（它们都按变量闭包，与 DOM 顺序无关）。
		 *
		 * ★ 2026-11-06 晚：自定义 DNS 卡整体下线（用户口径）。
		 *   它是对 network.<iface>.dns + peerdns 的 UCI 写入，保存会触发接口
		 *   重新协商（短暂断网）；同一件事在 LuCI 的「网络 → 接口 → 高级设置」
		 *   本来就能改，本页再放一份等于两处入口两个真相。
		 *   随之清掉：require uci、detectNetIface / isIPv4 / loadDnsConfig /
		 *   saveDns / commitDns / renderDns 六个函数，以及整个
		 *   tests/dns-edit-contract.test.js。
		 * ★ `.mt5700-dns-row` / `.mt5700-dns-label` 两个样式**保留** —— 名字里带
		 *   dns 但实际是通用的「标签 + 输入框」行布局，TTL 卡正在用（删了 TTL
		 *   那两行会塌成上下堆叠）。
		 */
		body.appendChild(ttlCard);

		/* ---------- 邻区扫描（^MONNC + ^NRSSBID 的 SSB 邻区，合并去重） ---------- */
		var neighAutoTimer = null;
		var neighRefreshBtn = Mt5700.primaryButton('扫描邻区', function () { loadNeighbors(); });
		var neighAr = Ui.autoRefresh(function (enabled, interval) {
			if (neighAutoTimer) { clearInterval(neighAutoTimer); neighAutoTimer = null; }
			/* 回调首行查 hidden（同 logs.js:602 范式）：后台标签页仍每 15s 打 3 条 AT
			 * （^MONNC/^NRSSBID?/^MONSC），纯浪费独占串口（2026-10-22 审计）。 */
			if (enabled) neighAutoTimer = Ui.interval(interval * 1000, function () {
				if (document.hidden) return;
				loadNeighbors();
			});
		});
		neighAr.setInterval(15);
		var neighTools = E('div', { 'class': 'mt5700-toolbar' });
		neighTools.appendChild(neighAr.el);
		neighTools.appendChild(neighRefreshBtn);

		var neighCard = Mt5700.card('邻区扫描',
			'服务小区波束与邻区，按强度排序，可就地锁定', neighTools);
		var neighBody = E('div');
		neighCard._body.appendChild(neighBody);
		body.appendChild(neighCard);


		/* ---------- 网络拒绝（手册 13.14 ^REJINFO，模组自发上报） ----------
		 *
		 * 2026-09-18：从「网络状态 → 连接工具」整块迁来，并做成表格。
		 *   它回答的是「为什么注册不上 / PDU 会话建不起来」，与本页的锁频、邻区扫描
		 *   是同一条排查链 —— 锁错频点、锁到没签约的 PLMN，第一条线索就在这里，
		 *   而不是在全是读数的「网络状态」页。
		 *
		 * ★ 只订阅、不下发任何命令：^REJINFO 是模组**自发**上报（手册 13.14），
		 *   既没有读命令也没有设置命令，不占 AT 通道、不会在模组里留下任何状态。
		 *   所以这里不做「开始/停止监听」开关 —— 订阅是纯前端行为，一直挂着即可。
		 */
		var rejectCard = Mt5700.card('网络拒绝',
			'注册 / PDU 会话被拒时的原因，实时更新');
		var rejectBody = E('div');
		rejectCard._body.appendChild(rejectBody);
		body.appendChild(rejectCard);
		var lastReject = null;

		function fmtRejClock(ts) {
			if (!ts) return '—';
			var d = new Date(ts);
			function p(n) { return n < 10 ? '0' + n : String(n); }
			return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
		}

		function renderReject() {
			rejectBody.innerHTML = '';
			if (!lastReject) {
				rejectBody.appendChild(Mt5700.empty('尚无网络拒绝上报'));
				rejectBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					'没被拒绝就不会推 —— 这本身是正常的。注册被拒、PDU 会话建立被拒时，'
					+ '模组会自己推一帧到这里（手册 13.14）。本页只订阅、不下发任何命令。'));
				return;
			}
			var r = lastReject;
			var rows = [
				['时间', fmtRejClock(r.at)],
				['PLMN', r.plmn || '—'],
				['域', r.domainText],
				['制式', r.ratText],
				['拒绝类型', r.rejectTypeText],
				['原因', E('b', { 'class': 'mt5700-diag-verdict is-bad' }, r.causeText)]
			];
			if (r.lac || r.cellId) {
				rows.push(['LAC / 小区', (r.lac || '—') + ' / ' + (r.cellId || '—')]);
			}
			/* 原始原因值常与 cause 相同，只有不一样（模组做过二次映射）时才单列，
			   否则同一行的两个数会让人以为有两个原因。 */
			if (r.originalCause != null && Number(r.originalCause) !== Number(r.cause)) {
				rows.push(['原始原因值', '#' + r.originalCause]);
			}
			if (r.esmCause !== undefined && r.esmCause !== null) {
				rows.push(['ESM 原因', '#' + r.esmCause]);
			}
			rejectBody.appendChild(Mt5700.table(['项目', '值'], rows, { striped: true }));
			rejectBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'以上是模组上报的**最近一次**拒绝原因（原因值 ' + r.cause + '）。'
				+ '常见问题：#7/#8 多为核心网未开通 5G 或未签约该 DNN；'
				+ '#11/#12 多为欠费或区域限制；#15 为小区找不到合适用户。'));
			rejectBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'原因指向 PLMN / 跟踪区时，多半是签约或区域限制，换小区也没用；'
				+ '指向小区或频点时，可用上面「邻区扫描」挑个更强的小区、'
				+ '再用「锁频设置」锁到已确认可用的频点 / PCI。'));
		}
		renderReject();

		var rejectHandler = function (resp) {
			if (!resp || resp.type !== 'urc_data' || !resp.data) return;
			if (resp.data.type === 'REJINFO' && resp.data.parsed) {
				lastReject = resp.data.parsed;
				renderReject();
			}
		};
		AtWs.client.subscribe(rejectHandler);

		/* ---------- 锁频编辑器 ---------- */

		var TYPE_OPTIONS = Parse.LOCK_TYPES;
		var SCS_OPTIONS = Parse.SCS_TYPES;

		function bandOptionsFor(kind) {
			return kind === 'lte' ? Parse.LTE_BANDS : Parse.NR_BANDS;
		}

		/*
		 * 4G / 5G 合并到一处：顶部「制式」分段切换，下面共用同一套
		 * 「锁频类型 + 移动性 + 参数条目」编辑器（原先并排两块重复表单，同一件事写两遍）。
		 * 各自的取值仍按制式分别存在 lockState[kind + 'Type' | 'Mobility' | 'Items']。
		 */
		var LOCK_RATS = [{ label: '4G LTE', value: 'lte' }, { label: '5G NR', value: 'nr' }];
		if (lockState.activeRat !== 'lte' && lockState.activeRat !== 'nr') lockState.activeRat = 'lte';

		function ratLabel(kind) { return kind === 'nr' ? '5G' : '4G'; }

		function renderLockEditor() {
			var kind = lockState.activeRat;
			lockEditorBox.innerHTML = '';

			var ratSeg = Mt5700.segmented(LOCK_RATS, kind, function (v) {
				lockState.activeRat = v;
				renderLockEditor();
			});
			var typeSeg = Mt5700.segmented(TYPE_OPTIONS.map(function (o) {
				return { label: o.label, value: o.value };
			}), lockState[kind + 'Type'], function (v) {
				lockState[kind + 'Type'] = v;
				renderItems();
			});
			/* ★ 2026-11-06：制式与锁频类型都是分段控件、各只占一小段，
			 *   并排一行省掉一整行高度（用户口径「小选项没必要一行一个」）。 */
			lockEditorBox.appendChild(Mt5700.formGrid(
				Mt5700.formGroup('制式', ratSeg.el,
					'两制式分别保存；切换后点「保存设置」只下发当前制式'),
				Mt5700.formGroup('锁频类型', typeSeg.el)
			));

			var mobWrap = E('div');
			lockEditorBox.appendChild(mobWrap);

			var itemsWrap = E('div', { 'class': 'mt5700-lock-items' });
			lockEditorBox.appendChild(itemsWrap);

			var addBtn = Mt5700.button('+ 添加', function () {
				var items = lockState[kind + 'Items'];
				if (items.length >= Parse.MAX_LOCK_ITEMS) {
					Mt5700.warning(ratLabel(kind) + '最多只能锁 ' + Parse.MAX_LOCK_ITEMS + ' 组');
					return;
				}
				items.push({});
				renderItems();
			}, 'ghost');

			function bandSelect(item, onChange) {
				var opts = [{ label: '（未选择）', value: '' }].concat(bandOptionsFor(kind).map(function (b) {
					return { label: b.label, value: String(b.value) };
				}));
				var sel = Mt5700.select(opts, String(item.band == null ? '' : item.band));
				sel.addEventListener('change', function () { onChange(sel.value ? Number(sel.value) : null); });
				return sel;
			}

			function rowFor(item, index) {
				var row = E('div', { 'class': 'mt5700-lock-item' });
				row.appendChild(bandSelect(item, function (v) { item.band = v; }));

				if (lockState[kind + 'Type'] !== 3) {
					var arfcn = Mt5700.input('text', '频点 ARFCN', item.arfcn != null ? String(item.arfcn) : '');
					arfcn.addEventListener('input', function () { item.arfcn = arfcn.value.trim(); });
					row.appendChild(arfcn);

					if (kind === 'nr') {
						var scsOpts = [{ label: '（自动）', value: '' }].concat(SCS_OPTIONS.map(function (o) {
							return { label: o.label, value: String(o.value) };
						}));
						var scs = Mt5700.select(scsOpts, String(item.scs == null ? '' : item.scs));
						scs.addEventListener('change', function () { item.scs = scs.value ? Number(scs.value) : null; });
						row.appendChild(scs);
					}

					var pci = Mt5700.input('text', 'PCI', item.pci != null ? String(item.pci) : '');
					pci.addEventListener('input', function () { item.pci = pci.value.trim(); });
					row.appendChild(pci);
				}

				row.appendChild(Mt5700.button('删除', function () {
					var items = lockState[kind + 'Items'];
					items.splice(index, 1);
					if (!items.length) items.push({});
					renderItems();
				}, 'danger'));
				return row;
			}

			function renderItems() {
				itemsWrap.innerHTML = '';
				mobWrap.innerHTML = '';
				var type = lockState[kind + 'Type'];
				var items = lockState[kind + 'Items'];
				itemsWrap.classList.toggle('is-hidden', type === 0);
				addBtn.style.display = type === 0 ? 'none' : '';

				if (type !== 0) {
					var mobSel = Mt5700.select([
						{ label: '低移动性', value: '0' },
						{ label: '中移动性', value: '1' },
						{ label: '高移动性', value: '2' }
					], String(lockState[kind + 'Mobility']));
					mobSel.addEventListener('change', function () {
						lockState[kind + 'Mobility'] = parseInt(mobSel.value, 10);
					});
					mobWrap.appendChild(Mt5700.formGroup('移动性', mobSel,
						type === 3 ? '锁定 Band 时按组下发频段号' : '锁定频点/小区时按组下发频段、频点与 PCI'));
					for (var i = 0; i < items.length; i++) itemsWrap.appendChild(rowFor(items[i], i));
				} else {
					itemsWrap.appendChild(Mt5700.empty('锁频类型为「关闭」时不需配置参数'));
				}
			}

			lockEditorBox.appendChild(addBtn);
			renderItems();
			updateSaveLabel();
		}

		/* 「保存设置」只下发当前制式（按钮文案随制式变化，避免误以为一次写两制式） */
		function updateSaveLabel() {
			lockCardSub.textContent = '当前制式：' + ratLabel(lockState.activeRat)
				+ '；先选制式，再设锁频类型与参数，「保存设置」只下发当前制式';
		}

		/*
		 * 「关射频 → 干活 → 恢复射频」的括号封装。
		 *
		 * 锁频 / 锁小区 / 切 5G 接入模式三条链路原本各写一遍这三层，而且在各自的
		 * catch 里都是 `Ui.setFlightMode(false).catch(function () {})` ——
		 * **恢复射频失败是彻底静默的**：用户被留在飞行模式里，5G 完全没有网，
		 * 界面却只报「设置失败」，看不出真正的后果是「现在没网了」。
		 *
		 * 收在这里后：正常与异常路径共用同一条恢复逻辑，恢复失败会重试并报警。
		 */

		/*
		 * 恢复射频（关飞行模式）。刚关完射频时模组常还在忙，单次失败很常见，
		 * 故最多重试 3 次；仍失败必须明确告诉用户「现在得手动关飞行模式才有救」，
		 * 不能让 5G 断着而界面一声不吭。
		 */
		function restoreRadio() {
			var attempt = function (n) {
				return Ui.setFlightMode(false).then(function (ok) {
					if (ok || n >= 3) {
						if (!ok) Mt5700.error('恢复射频失败，请手动关闭飞行模式，否则 5G 不会恢复');
						return ok;
					}
					return Ui.sleep(1000).then(function () { return attempt(n + 1); });
				});
			};
			return attempt(1).catch(function () {
				Mt5700.error('恢复射频失败，请手动关闭飞行模式，否则 5G 不会恢复');
			});
		}

		/* work 是「射频已关」之后要做的事，返回 Promise；返回值原样透传给后续 then */
		function withRadioOff(work) {
			var radioOff = false;
			return Ui.setFlightMode(true).then(function (ok) {
				if (!ok) throw new Error('开启飞行模式失败');
				radioOff = true;
				return Ui.sleep(1000);
			}).then(work).then(function (r) {
				return Ui.setFlightMode(false).then(function (off) {
					if (!off) throw new Error('关闭飞行模式失败');
					return r;
				});
			}).catch(function (err) {
				if (radioOff) restoreRadio();
				throw err;
			});
		}

		/* 保存当前制式的锁频配置 */
		function saveActiveLock() {
			if (busy) return;
			var kind = lockState.activeRat;
			var type = lockState[kind + 'Type'];
			var cmd;
			try {
				cmd = type === 0
					? (kind === 'lte' ? 'AT^LTEFREQLOCK=0' : 'AT^NRFREQLOCK=0')
					: Parse.buildLockCommand(kind, type, lockState[kind + 'Mobility'], lockState[kind + 'Items']);
			} catch (err) {
				Mt5700.error(err.message || '锁频参数错误');
				return;
			}
			busy = true;
			saveLockBtn.disabled = true;
			Mt5700.info('正在保存 ' + ratLabel(kind) + ' 锁频（先切飞行模式）…');
			withRadioOff(function () {
				return AtWs.client.sendCommand(cmd).then(function (res) {
					if (!res.success) throw new Error(Ui.atErrorText(res, ratLabel(kind) + ' 锁频设置失败'));
					Mt5700.success(ratLabel(kind) + ' 锁频设置成功');
				});
			}).then(function () {
				Mt5700.info('锁频已保存，等待模组重新驻网…');
				return Ui.sleep(2000);
			}).then(function () {
				return fetchCurrent();
			}).catch(function (err) {
				Mt5700.error((err && err.message) || '保存锁频设置失败');
			}).then(function () {
				busy = false;
				saveLockBtn.disabled = false;
			});
		}


		/* ---------- 锁频响应解析 ---------- */

		function parseLockResponse(raw, prefix) {
			var lines = String(raw).split('\n').map(function (l) { return l.trim(); })
				.filter(function (l) { return l && l.indexOf('OK') < 0 && l.indexOf('AT') !== 0; });
			var head = -1;
			for (var i = 0; i < lines.length; i++) {
				if (lines[i].indexOf(prefix) === 0) { head = i; break; }
			}
			if (head < 0) return null;
			/*
			 * ★ prefix 是拼进正则的，要转义**全部**元字符，不能只处理开头的 `^`。
			 *   原写法 `prefix.replace('^', '\\^')` 只替换第一个 `^`：若 prefix 里出现
			 *   `.` `*` `(` `[` 等，匹配范围会悄悄变宽，甚至因括号不成对直接抛
			 *   SyntaxError（本函数在锁频页读取链路里，抛异常会中断整段解析）。
			 *   与 `parse.js::parseRegStat`、`rpc.js:1146` 保持同一写法 —— 后面那处
			 *   本来就是全量转义，这里只是对齐。
			 *   现有两个调用点传的是字面常量（'^LTEFREQLOCK' / '^NRFREQLOCK'），
			 *   两种情况转义结果相同，所以这是加固、不是修故障。
			 */
			var esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			var typeMatch = lines[head].match(new RegExp(esc + ':\\s*(\\d+)'));
			if (!typeMatch) return null;
			var lockType = Number(typeMatch[1]);
			if (lockType === 0) return { lockType: 0, mobility: 0, items: [{}] };
			var nm = (lines[head + 1] || '0,0').split(',').map(Number);
			var mobility = nm[0], num = nm[1];
			/*
			 * 条目数取自模组应答，必须夹住。
			 * 应答异常（例如 `0,255`）会凭空生成 255 个字段全 undefined 的条目，
			 * 界面上立刻多出 255 行空输入框，且「保存」时会把这些空值一起下发。
			 * 天然上界是「后面还剩几行」—— 一条锁频占一行；再叠一个 32 的硬上限
			 * 兜住任何离谱取值（正常配置远小于此）。
			 */
			var avail = Math.max(0, lines.length - head - 2);
			if (!isFinite(num) || num < 0) num = 0;
			num = Math.min(num, avail, 32);
			var items = [];
			for (var j = 0; j < num; j++) {
				var parts = (lines[head + j + 2] || '').split(',').map(function (v) { return v ? Number(v) : undefined; });
				if (prefix === '^LTEFREQLOCK') {
					items.push({ band: parts[0], arfcn: parts[1] != null ? String(parts[1]) : undefined, pci: parts[2] != null ? String(parts[2]) : undefined });
				} else {
					items.push({ band: parts[0], arfcn: parts[1] != null ? String(parts[1]) : undefined, scs: parts[2], pci: parts[3] != null ? String(parts[3]) : undefined });
				}
			}
			return { lockType: lockType, mobility: mobility, items: items.length ? items : [{}] };
		}

		/* ---------- 应用锁频 ---------- */

		var busy = false;

		/* ---------- 查询当前锁频 ---------- */

		function fetchCurrent() {
			var chain = Promise.resolve();
			chain = chain.then(function () {
				return AtWs.client.sendCommand('AT^LTEFREQLOCK?').then(function (res) {
					if (res.success && res.data) {
						var parsed = parseLockResponse(res.data, '^LTEFREQLOCK');
						if (parsed) {
							lockState.lteType = parsed.lockType;
							lockState.lteMobility = parsed.mobility;
							lockState.lteItems = parsed.items;
						}
					}
				});
			});
			chain = chain.then(function () {
				return AtWs.client.sendCommand('AT^NRFREQLOCK?').then(function (res) {
					if (res.success && res.data) {
						var parsed = parseLockResponse(res.data, '^NRFREQLOCK');
						if (parsed) {
							lockState.nrType = parsed.lockType;
							lockState.nrMobility = parsed.mobility;
							lockState.nrItems = parsed.items;
						}
					}
				});
			});
			chain = chain.then(query5G);
			chain = chain.then(function () {
				// 回填锁频表单（基准：查询后重新渲染）
				renderLockEditor();
			});
			return chain;
		}

		/* ---------- 邻区扫描 / SSB 信息 ---------- */

		var ssb = null;
		var monncCells = [];
		/* 服务小区（^MONSC）：唯一实测的 SCS 来源，见 neighborScs 注释 */
		var servingCell = null;
		var neighBusy = false;

		/*
		 * 邻区 SCS（子载波间隔，15/30/60/120/240 kHz = ^NRFREQLOCK 的 scstype 0~4）。
		 *
		 * 模组**没有任何命令**上报邻区的 SCS —— ^MONNC / ^NRSSBID 都没有该字段
		 * （手册 13.10 的 NR 邻区字段只有 ARFCN/PCI/RSRP/RSRQ/SINR，手册全篇无
		 * 「子载波间隔」一词）。只有 ^MONSC 报**服务小区**的 SCS（第 5 个字段）。
		 *
		 * 因此分两种情况，且必须区分标注，不能混为一谈：
		 *   ① 同频邻区（ARFCN 与服务小区相同）：与服务小区同属一个 NR 载波，
		 *      子载波间隔必然相同 → 可直接用 ^MONSC 的**实测值**。
		 *   ② 异频邻区：只能按 3GPP TS 38.104 Table 5.4.3.3-1 的 SSB SCS 推断
		 *      （n41/n77/n78/n79 → 30 kHz；n28/n1/n3/n5/n8 → 15 kHz；
		 *       FR2 的 n257/258/260/261 → 120 kHz）。这是标准规定的默认值，
		 *      不是实测，故加「*」以示区别。
		 *
		 * 本机交叉验证：^MONSC 实测 SCS=1(30 kHz)，n41 按表推断也是 1 —— 两者一致，
		 * 说明这套推断在本机是准的；但仍保留标注，因为换频段后未必一致。
		 */
		function neighborScs(rat, arfcn) {
			if (rat !== 'NR') return null;
			/* parseMONSC 的频点字段叫 channel（不是 arfcn），注意别写错 */
			if (servingCell && servingCell.scs != null && servingCell.channel != null
				&& String(servingCell.channel) === String(arfcn)) {
				return { scs: servingCell.scs, measured: true };
			}
			var band = Parse.arfcnToBand('NR', arfcn);
			if (band == null) return null;
			return { scs: Parse.getDefaultScsType(band), measured: false };
		}

		function fmtScs(v) {
			if (!v || v.scs == null) return '—';
			var t = (Parse.SCS_TYPES || []).filter(function (o) {
				return Number(o.value) === Number(v.scs);
			})[0];
			var label = t ? t.label : (v.scs + ' kHz');
			return v.measured ? label : label + ' *';
		}

		function lockNeighbor(cell) {
			var band = cell.band != null ? cell.band : Parse.arfcnToBand(cell.rat, cell.arfcn);
			if (band == null) {
				Mt5700.error('无法由 ARFCN ' + cell.arfcn + ' 判断频段，请在锁频设置里手动指定');
				return;
			}
			/*
			 * SCS 是 ^NRFREQLOCK 的必填参数（手册 13.13 的 scstype 0~4）。
			 * 同频邻区直接用 ^MONSC 实测值，比按频段推断更可信；
			 * 拿不到实测才退回 Parse.getDefaultScsType。
			 */
			var scsInfo = neighborScs(cell.rat, cell.arfcn);
			var scs = scsInfo ? scsInfo.scs : Parse.getDefaultScsType(band);
			var kind = cell.rat === 'LTE' ? 'lte' : 'nr';
			var cmd;
			try {
				cmd = Parse.buildLockCommand(kind, 2, 0, [{
					band: band, arfcn: String(cell.arfcn), pci: String(cell.pci), scs: scs
				}]);
			} catch (err) {
				/* ARFCN/PCI 缺失时 buildLockCommand 会抛，异常逃出点击回调就表现为「点了没反应」 */
				Mt5700.error((err && err.message) || '构建锁频命令失败');
				return;
			}
			Mt5700.confirm('确定锁定 ' + cell.rat + ' ' + (kind === 'nr' ? 'n' : 'B') + band
				+ '（ARFCN ' + cell.arfcn + '，PCI ' + cell.pci + '）？', function () {
				withRadioOff(function () {
					return AtWs.client.sendCommand(cmd).then(function (res) {
						if (!res.success) throw new Error(Ui.atErrorText(res, '锁定失败'));
						Mt5700.success('已锁定 ' + cell.rat + ' PCI ' + cell.pci);
					});
				}).then(function () {
					return fetchCurrent();
				}).catch(function (err) {
					Mt5700.error((err && err.message) || '锁定失败');
				});
			}, '确认锁定');
		}

		function renderNeighbors() {
			neighBody.innerHTML = '';
			renderSsbInto(neighBody);
			var merged = [];
			/*
			 * MONNC 索引：^NRSSBID 的邻区**不带 RSRQ**（手册 13.28 的邻区字段只有
			 * PCI/ARFCN/RSRP/SINR + 波束），本机实测 4 个 SSB 邻区全部能按
			 * (ARFCN, PCI) 在 MONNC 里找到同一小区，故从 MONNC 回填 RSRQ。
			 * 注：MONNC 的 PCI 是十六进制、NRSSBID 是十进制，两者在各自解析函数里
			 * 已统一成十进制数值，可直接比较。
			 */
			var byCell = {};
			monncCells.forEach(function (c) {
				var k = c.rat + '|' + c.arfcn + '|' + c.pci;
				byCell[k] = c;
				merged.push({
					rat: c.rat, arfcn: c.arfcn, pci: c.pci,
					rsrp: c.rsrp, rsrq: c.rsrq, sinr: c.sinr, src: 'MONNC'
				});
			});
			if (ssb && ssb.neighbors) {
				ssb.neighbors.forEach(function (n) {
					var k = 'NR|' + n.arfcn + '|' + n.pci;
					if (byCell[k]) {
						/*
						 * 同一小区 MONNC 已列一行，不重复成行；但把 SSB 独有的波束
						 * 挂上去，以及用它补齐 MONNC 缺测的 RSRP/SINR。
						 */
						merged.forEach(function (row) {
							if (row.rat === 'NR' && row.arfcn === n.arfcn && row.pci === n.pci) {
								row.beams = n.beams;
								if (row.rsrp == null) row.rsrp = n.rsrp;
								if (row.sinr == null) row.sinr = n.sinr;
								row.src = 'MONNC+SSB';
							}
						});
						return;
					}
					byCell[k] = n;
					merged.push({
						rat: 'NR', arfcn: n.arfcn, pci: n.pci,
						rsrp: n.rsrp, rsrq: null, sinr: n.sinr, src: 'SSB', beams: n.beams
					});
				});
			}
			/* 按信号强度从大到小排（取不到值的排最后）——最该锁的小区排最前 */
			merged.sort(function (a, b) {
				var ra = (a.rsrp != null ? a.rsrp : -999);
				var rb = (b.rsrp != null ? b.rsrp : -999);
				return rb - ra;
			});
			/*
			 * 模组会为「邻区列表里配置了、但本轮没真正测量」的小区返回填充行：
			 * RSRP/RSRQ/SINR 全是手册 13.10 的无效值（-157/-44/-24），解析后为 null。
			 *
			 * ★ 2026-11-06 改：这些行**照样列出来**。原先只留一行「另有 N 个未测量，
			 *   故未列出——这不是界面丢数据」把行吞掉，用户的第一反应是「你丢了
			 *   我家一半小区」。而那些行并非无用：锁定只需要 ARFCN + PCI，根本不需要
			 *   测量值 —— 吞掉它们等于把可锁的小区一起藏了。现在按强度排在末尾，
			 *   信号三列显示「—」、强度列显示「未测量」，一眼能分辨。
			 */
			neighBody.appendChild(E('div', { 'class': 'mt5700-card-subtitle mt5700-mt-md' },
				'邻区（' + merged.length + ' 个，按信号强度排序）'));
			if (!merged.length) {
				neighBody.appendChild(Mt5700.empty('暂无邻区数据，点击右上「扫描邻区」'));
				renderNeighborHints();
				return;
			}
			var rows = merged.map(function (c) {
				var band = Parse.arfcnToBand(c.rat, c.arfcn);
				var btn = Mt5700.button('锁定', function () { lockNeighbor(c); }, 'secondary');
				btn.disabled = band == null;
				var unmeasured = c.rsrp == null && c.rsrq == null && c.sinr == null;
				return [
					c.rat + (c.src === 'SSB' ? '（SSB）' : ''),
					band != null ? (c.rat === 'NR' ? 'n' + band : 'B' + band) : '—',
					String(c.arfcn),
					fmtScs(neighborScs(c.rat, c.arfcn)),
					String(c.pci),
					c.rsrp != null ? c.rsrp + ' dBm' : '—',
					c.rsrq != null ? c.rsrq + ' dB' : '—',
					c.sinr != null ? c.sinr + ' dB' : '—',
					unmeasured
						? E('span', { 'class': 'mt5700-hint' }, '未测量')
						: Mt5700.rsrpBar(c.rsrp),
					btn
				];
			});
			neighBody.appendChild(Mt5700.table(
				['制式', '频段', 'ARFCN', 'SCS', 'PCI', 'RSRP', 'RSRQ', 'SINR', '强度', '操作'], rows,
				{ striped: true, rowClass: function (i) { return merged[i] && merged[i].rsrp == null
					&& merged[i].rsrq == null && merged[i].sinr == null ? 'mt5700-row-unmeasured' : ''; } }));
			renderNeighborHints();
		}

		/* 表格下方的说明。早退路径（无邻区）也要调用，故抽成函数。
		 *
		 * ★ 2026-11-06：原来这里挂 4 段解说（数据源命令名、飞行模式+PCI 叮嘱、
		 *   SCS 的 3GPP 条款推导、RSRQ 由哪条命令回填）。用户口径「类似的解说太多」
		 *   —— 界面只回答问题「现在能不能用、不能用怎么办」，推导与出处属于 README。
		 *   留下的两条：查询失败（要不要重试）＋ 锁定会断网（做之前得知道）。
		 */
		function renderNeighborHints() {
			var names = { MONNC: '邻区列表', NRSSBID: 'SSB 测量', MONSC: '服务小区' };
			var failed = Object.keys(neighFailures).filter(function (k) { return neighFailures[k]; });
			if (failed.length) {
				neighBody.appendChild(E('div', { 'class': 'mt5700-hint' },
					'本轮没取到：'
					+ failed.map(function (k) { return names[k] || k; }).join('、')
					+ '（相关列显示为空，可重试）'));
			}
			neighBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'锁定会短暂断网：先切飞行模式，下发后自动恢复。'));
			neighBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'SCS 带 * 表示该邻区不报此项，按频段推断。'));
		}

		var neighFailures = {};
		function loadNeighbors() {
			if (neighBusy) return;
			neighBusy = true;
			neighRefreshBtn.disabled = true;
			neighFailures = {};
			/*
			 * 三个数据源彼此独立，逐个兜错：
			 * 过去是 `then(a).then(b).then(c)` 串行 + **链尾单个 catch**，任一条命令
			 * reject 后面的就全部跳过、连 renderNeighbors 都不执行 —— 整张表空白，
			 * 只弹一句「邻区扫描失败」。^NRSSBID 在空闲态/非 NR 组网就会 ERROR，
			 * 一次偶发失败就表现为「数据全丢了」。
			 * 现在：谁失败只丢谁那一部分，其余照常渲染，并在页面上点明是哪一项。
			 */
			var jobs = [
				{ key: 'MONNC', cmd: 'AT^MONNC', apply: function (res) {
					monncCells = res.success && res.data ? Parse.parseMonncAll(String(res.data)) : [];
				} },
				{ key: 'NRSSBID', cmd: 'AT^NRSSBID?', apply: function (res) {
					ssb = res.success && res.data ? Parse.parseNrssbid(String(res.data)) : null;
				} },
				{ key: 'MONSC', cmd: 'AT^MONSC', apply: function (res) {
					/* 只影响同频邻区的实测 SCS；拿不到就整列退回按频段推断 */
					servingCell = (res && res.success && res.data)
						? AtWs.parseMONSC(String(res.data)) : null;
				} }
			];
			var chain = Promise.resolve();
			jobs.forEach(function (job) {
				chain = chain.then(function () {
					return AtWs.client.sendCommand(job.cmd)
						.then(job.apply)
						.catch(function () { neighFailures[job.key] = true; });
				});
			});
			return chain.catch(function () { /* 兜底：下面的渲染无论如何都要跑 */ })
				.then(function () {
					renderNeighbors();
					neighBusy = false;
					neighRefreshBtn.disabled = false;
				});
		}

		/*
		 * SSB 信息：服务小区读数 + 波束强度。
		 * 波束是这张卡的核心信息 —— 用一行紧凑列表呈现，并高亮当前最强波束
		 * （切换/移动时最直观的观察对象）；小区标识与定时提前量一并给出。
		 */
		/* SSB 区块（服务小区读数 + 波束）——并入「邻区扫描」卡的上半部分 */
		function renderSsbInto(host) {
			var ssbBody = E('div');
			host.appendChild(ssbBody);
			ssbBody.innerHTML = '';
			var s = ssb && ssb.serving;
			if (!s) {
				ssbBody.appendChild(Mt5700.empty('暂无 SSB 信息（点击右上「刷新 SSB 信息」）'));
				return;
			}
			var mhz = Parse.nrArfcnToMHz(s.arfcn);
			var beams = (s.beams || []).slice().sort(function (a, b) {
				return (b.rsrp == null ? -999 : b.rsrp) - (a.rsrp == null ? -999 : a.rsrp);
			});
			var best = beams.length ? beams[0] : null;

			/*
			 * 读数区：去掉 TA（时间提前量）—— 本机 ^NRSSBID 的 TA 恒为 -1（无效值），
			 * 且它对固定安装的路由器没有可行动价值；换成 ARFCN，可直接与工参/锁频表单对照。
			 */
			var g = E('div', { 'class': 'mt5700-metrics' });
			g.appendChild(Mt5700.metric('SSB PCI', s.pci != null ? String(s.pci) : '—'));
			g.appendChild(Mt5700.metric('SSB ARFCN', s.arfcn != null ? String(s.arfcn) : '—'));
			g.appendChild(Mt5700.metric('SSB 频率', mhz != null ? (mhz.toFixed(2) + ' MHz') : '—'));
			g.appendChild(Mt5700.metric('RSRP', s.rsrp != null ? s.rsrp + ' dBm' : '—', 'accent'));
			g.appendChild(Mt5700.metric('SINR', s.sinr != null ? s.sinr + ' dB' : '—'));
			ssbBody.appendChild(g);

			ssbBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'小区标识 ' + (s.cid || '—')
				+ (best ? ' · 最强波束 #' + best.id + '（' + best.rsrp + ' dBm）' : '')));

			/*
			 * 波束怎么显示：8 行明细对固定安装的路由器几乎没信息量（这些数一天都不变），
			 * 压缩成「一排迷你条 + 一行数字摘要」，只有要调天线/挪位置时才看：
			 *   · 迷你条按波束号排列，一眼看出强波束集中在哪个方向；
			 *   · 摘要给出最强/次强与其余上限，判断是否只吃到一束（可能偏离主瓣）。
			 */
			if (!beams.length) {
				ssbBody.appendChild(E('div', { 'class': 'mt5700-hint' }, '本次上报不含波束数据。'));
				return;
			}
			var byId = beams.slice().sort(function (a, b) { return a.id - b.id; });
			ssbBody.appendChild(E('div', { 'class': 'mt5700-card-subtitle mt5700-mt-md' },
				'波束分布（基站的分波束方向，' + beams.length + ' 束）'));
			var strip = E('div', { 'class': 'mt5700-beam-strip' });
			byId.forEach(function (b) {
				var pct = Mt5700.signalPercent(b.rsrp);
				var cell = E('div', {
					'class': 'mt5700-beam-cell' + (best && b.id === best.id ? ' is-best' : ''),
					'title': '#' + b.id + ' · ' + (b.rsrp != null ? b.rsrp + ' dBm' : '—')
				});
				cell.style.height = (20 + Math.max(0, pct == null ? 0 : pct) * 0.8) + '%';
				cell.style.background = pct == null ? 'var(--mt5700-border-subtle)'
					: (pct >= 60 ? 'var(--mt5700-success)' : pct >= 40 ? 'var(--mt5700-warning)' : 'var(--mt5700-danger)');
				strip.appendChild(cell);
			});
			ssbBody.appendChild(strip);
			var second = beams[1];
			var rest = beams.slice(2);
			var restMax = rest.length ? Math.max.apply(null, rest.map(function (b) { return b.rsrp == null ? -999 : b.rsrp; })) : null;
			ssbBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'最强 #' + best.id + '（' + best.rsrp + ' dBm）'
				+ (second ? ' · 次强 #' + second.id + '（' + second.rsrp + ' dBm）' : '')
				+ (rest.length ? ' · 其余 ' + rest.length + ' 束 ≤ ' + restMax + ' dBm' : '')));
		}


		/* ---------- 5G 接入模式（可设置，手册 13.17） ----------
		 * AT^C5GOPTION=<nr_sa_support_flag>,<nr_dc_mode>,<5gc_access_mode>
		 * 手册列出的三种受支持组合：
		 *   仅 SA     1,0,1   仅 NSA    0,1,0    SA + NSA   1,1,1
		 * 注意：设置前必须切飞行模式，设置后需软重启才生效（手册 13.17.2）。
		 */

		var ACCESS_MODES = [
			{ label: '仅 SA', value: '101', triple: [1, 0, 1], hint: 'Option 2：NR 独立组网' },
			{ label: '仅 NSA', value: '010', triple: [0, 1, 0], hint: 'Option 3：仅 EN-DC（LTE 锚点 + NR）' },
			{ label: 'SA + NSA', value: '111', triple: [1, 1, 1], hint: 'Option 2+3：两种都允许' }
		];
		var accessInfo = E('div', { 'class': 'mt5700-hint' }, '正在读取当前接入模式…');

		function modeKey(triple) {
			var hit = ACCESS_MODES.filter(function (m) {
				return m.triple[0] === triple[0] && m.triple[1] === triple[1] && m.triple[2] === triple[2];
			})[0];
			return hit ? hit.value : null;
		}

		function renderAccess(triple) {
			optBody.innerHTML = '';
			var seg = Mt5700.segmented(ACCESS_MODES.map(function (m) {
				return { label: m.label, value: m.value };
			}), modeKey(triple), function (v) { setAccessMode(v); });
			optBody.appendChild(Mt5700.formGroup('接入模式', seg.el));
			var cur = modeKey(triple);
			if (!cur) {
				seg.setValue(null);
				accessInfo.textContent = '当前组合不在上述三种之内，选择上方任一模式即可切换。';
			} else {
				var m2 = ACCESS_MODES.filter(function (x) { return x.value === cur; })[0];
				accessInfo.textContent = '当前：' + m2.label + ' · ' + m2.hint;
			}
			optBody.appendChild(accessInfo);
			optBody.appendChild(E('div', { 'class': 'mt5700-hint' },
				'切换会自动切飞行模式；下发成功后需在「模组设置 → 系统控制」软重启模组才生效。'));
		}

		function setAccessMode(value) {
			var m = ACCESS_MODES.filter(function (x) { return x.value === value; })[0];
			if (!m) return;
			Mt5700.confirm('切换 5G 接入模式为「' + m.label + '」？'
				+ '切换期间会短暂断网，且需要软重启才生效。', function () {
				Mt5700.info('正在切换接入模式（先切飞行模式）…');
				withRadioOff(function () {
					return AtWs.client.sendCommand('AT^C5GOPTION=' + m.triple.join(',')).then(function (res) {
						if (!res.success) throw new Error(Ui.atErrorText(res, '接入模式设置失败'));
						Mt5700.success('已切换为「' + m.label + '」，软重启模组后生效');
					});
				}).then(function () {
					return query5G();
				}).catch(function (err) {
					Mt5700.error((err && err.message) || '接入模式设置失败');
					query5G();
				});
			}, '确认切换');
		}

		function query5G() {
			return Ui.sleep(200).then(function () {
				return AtWs.client.sendCommand('AT^C5GOPTION?');
			}).then(function (res) {
				if (res.success && res.data) {
					var m = String(res.data).match(/\^C5GOPTION:\s*(\d+),(\d+),(\d+)/);
					if (m) {
						lockState.option5g = { nr_sa_support_flag: Number(m[1]), nr_dc_mode: Number(m[2]), gc_access_mode: Number(m[3]) };
						renderAccess([Number(m[1]), Number(m[2]), Number(m[3])]);
						return;
					}
				}
				optBody.innerHTML = '';
				optBody.appendChild(Mt5700.empty('暂无 5G 接入模式信息'));
			});
		}


		/* ---------- 初始化 ---------- */

		Mt5700.connectThen(function () {
			renderLockEditor();
			fetchCurrent();
			/* loadNeighbors 自带渲染，原先前面那遍 renderNeighbors() 只画一张空表、
			 * 随即被整体重绘覆盖 —— 每次进页面多一次纯浪费的 DOM 重建
			 * （2026-10-22 审计）。 */
			loadNeighbors();
		});

		self._dispose = function () {
			if (neighAutoTimer) clearInterval(neighAutoTimer);
			AtWs.client.unsubscribe(rejectHandler);
			/* 定时锁频面板自己的 15s 轮询：不清就会在切页后继续抢独占串口 */
			SchedulePanel.dispose();
		};
		page._onDispose(self._dispose);

		return page;
	}
});
