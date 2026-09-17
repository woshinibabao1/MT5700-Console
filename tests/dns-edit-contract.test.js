#!/usr/bin/env node
/*
 * 自定义 DNS 就地编辑 契约测试（无需真机）
 * ---------------------------------------------------------------------------
 * 背景：用户要「主 DNS / 备 DNS 点一下就能改」。这里钉住几条容易做错的约定：
 *
 *   1) 这两个值原来来自 AT^DHCP?，是**运营商下发的**，改 UCI 不会让它变。
 *      所以显示必须「自定义 ?? 运营商下发」，否则改完界面纹丝不动，
 *      用户会以为没保存成功。
 *   2) 接口名不能写死 MT5700M —— 它来自 at-webserver.config.watch_iface
 *      （跟「服务配置」页同一个），否则改了接口名的机器会写到不存在的 section。
 *   3) ACL 必须放行 network；老版本 ACL 的机器要**静默降级为只读**，
 *      不能报错也不能给一个点了没反应的假按钮。
 *   4) 清空两项 = 删 dns + peerdns 还原 1，彻底交回运营商下发（留兜底）。
 *
 * 运行：node tests/dns-edit-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources',
	'view', 'at-webserver', 'network_status.js');
const ACL = path.join(ROOT, 'root', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-mt5700.json');

const js = fs.readFileSync(JS, 'utf8');
const acl = JSON.parse(fs.readFileSync(ACL, 'utf8'));

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}

function extractFn(s, name) {
	const marker = 'function ' + name + '(';
	const start = s.indexOf(marker);
	if (start < 0) throw new Error('找不到函数 ' + name + '（改名请同步本测试）');
	let depth = 0, begun = false;
	for (let i = start; i < s.length; i++) {
		if (s[i] === '{') { depth++; begun = true; }
		else if (s[i] === '}') { depth--; if (begun && depth === 0) return s.slice(start, i + 1); }
	}
	throw new Error('括号未配平: ' + name);
}

/* ---------- 1. ACL 必须放行 network ---------- */
const rw = acl['luci-app-mt5700'];
ok('ACL read.uci 含 network（读不到就加载不了当前配置）',
	(rw.read.uci || []).indexOf('network') !== -1);
ok('ACL write.uci 含 network（否则 L.uci.set 被拒，保存必失败）',
	(rw.write.uci || []).indexOf('network') !== -1);
ok('ACL write.ubus.uci 仍保留 set/commit/apply（uciSave 依赖）',
	['set', 'commit', 'apply'].every(function (m) {
		return (rw.write.ubus.uci || []).indexOf(m) !== -1;
	}));

/* ---------- 2. 权限不足时静默降级 ---------- */
const loadSrc = extractFn(js, 'loadDnsConfig');
ok('loadDnsConfig 有 catch 兜底（ACL 拒绝时不能抛）', /\.catch\(function \(\) \{/.test(loadSrc));
ok('降级时把 dnsEditable 置 false（不给点了没反应的假按钮）',
	/dnsEditable = false;/.test(loadSrc));
ok('只有 dnsEditable 为真才挂点击', /if \(!dnsEditable\) return wrap;/.test(js));

/* ---------- 3. 接口名不写死 ---------- */
ok('接口名取 at-webserver.config.watch_iface',
	/L\.uci\.get\('at-webserver', 'config', 'watch_iface'\)/.test(js));
ok('拿不到时有 MT5700M 兜底', /var netIface = 'MT5700M';/.test(js));

/* ---------- 4. 显示值：自定义优先于运营商下发 ---------- */
ok('单元格显示取「自定义 ?? 运营商下发」',
	/custom \|\| peerValue \|\| '—'/.test(js));
ok('自定义生效时打「自定义」徽章', /Mt5700\.badge\('自定义'/.test(js));
ok('renderDHCP 的 主/备 DNS 走 dnsCell 而不是裸值',
	/\['主 DNS', dnsCell\(0, v4\.primaryDNS\)\]/.test(js) &&
	/\['备 DNS', dnsCell\(1, v4\.secondaryDNS\)\]/.test(js));

/* ---------- 5. 保存语义 ---------- */
const saveSrc = extractFn(js, 'saveDns');
ok('有自定义值时写 dns 且 peerdns=0（只认用户填的）',
	/L\.uci\.set\(cfg, sec, 'dns', list\)/.test(saveSrc) &&
	/L\.uci\.set\(cfg, sec, 'peerdns', '0'\)/.test(saveSrc));
ok('清空时删除 dns 项（不是写成空串列表）', /L\.uci\.unset\(cfg, sec, 'dns'\)/.test(saveSrc));
ok('清空时 peerdns 还原 1（交回运营商下发，留兜底）',
	/L\.uci\.set\(cfg, sec, 'peerdns', '1'\)/.test(saveSrc));
ok('保存走 AtWs.uci.uciSave（save + apply，标准「保存并应用」链路）',
	/AtWs\.uci\.uciSave\('network'\)/.test(saveSrc));
ok('失败时清 dirty 并提示，不静默', /Mt5700\.error\('保存失败/.test(saveSrc));

/* 保存会断网，必须在界面上写明 —— 不能让人点了个按钮网就断了 */
ok('单元格 title 写明会重连', /点击修改（保存会重新连接网络）/.test(js));
ok('按钮文案写明「保存并应用」', /Mt5700\.primaryButton\('保存并应用'/.test(js));
ok('表下提示写明会断网 + 清空即恢复',
	/重新连接网络（短暂断网）/.test(js) && /留空即恢复运营商下发的 DNS/.test(js));

/* ---------- 6. IPv4 校验真跑一遍 ---------- */
const isIPv4 = new Function(extractFn(js, 'isIPv4') + '\nreturn isIPv4;')();
ok('223.5.5.5 合法', isIPv4('223.5.5.5') === true);
ok('0.0.0.0 合法', isIPv4('0.0.0.0') === true);
ok('255.255.255.255 合法', isIPv4('255.255.255.255') === true);
ok('256.1.1.1 非法（越界）', isIPv4('256.1.1.1') === false);
ok('1.2.3 非法（缺段）', isIPv4('1.2.3') === false);
ok('1.2.3.4.5 非法（多段）', isIPv4('1.2.3.4.5') === false);
ok('带空格的 1.2.3.4 合法（trim）', isIPv4('  1.2.3.4  ') === true);
ok('abc 非法', isIPv4('abc') === false);
ok('空串非法', isIPv4('') === false);
ok('1.2.3.-1 非法', isIPv4('1.2.3.-1') === false);
ok('1.2.3.04 合法（前导零按数值判，不苛刻拒绝）', isIPv4('1.2.3.04') === true);

/* ---------- 7. 页面 require 了 uci ---------- */
ok('network_status.js 显式 require uci（rpc.js 不代劳）',
	/'require uci';/.test(js));

if (fails.length) {
	console.log('✗ ' + fails.length + ' 项断言失败：');
	fails.forEach(function (f) { console.log('  - ' + f); });
	process.exit(1);
}
console.log('  ✓ ' + pass + ' 项断言通过（自定义 DNS 就地编辑）');
