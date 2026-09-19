#!/usr/bin/env node
/*
 * eSIM 二维码录入契约测试（纯 Node / mock，绝不向真机下发任何 AT）
 * ---------------------------------------------------------------------------
 * 存在的理由：2026-09-19 用户反馈「eSIM 不能传图片、不能扫码」。根因不是 UI 没做，
 * 而是**两条录入路径都被同一个前置条件卡死**：识别只依赖 window.BarcodeDetector，
 * 而该 API 只在安全上下文（https / localhost）提供 —— 用 http://192.168.x.x 打开
 * 路由器时它是 undefined，于是「扫描二维码」直接显示「当前环境不支持」，
 * 「上传图片」也一样，功能等于没有。
 *
 * 修复方向：把「能不能识别」和「用哪种实现」解耦 —— 原生可用就用原生，
 * 否则一律退回内置的 jsQR（纯 JS，任何协议下都能解）。
 *
 * 这里钉死五件事（每条都配**反向验证**：把改动前的旧实现 / 退化实现喂给同一个
 * 检查函数必须判红，否则守卫等于没写 —— 2026-09-18 的 findMultiArgECalls 教训）：
 *   A. jsQR 真的落地、许可齐全、未被裁剪
 *   B. UMD 在没有 module / exports / define 的浏览器环境里把自身挂到全局 jsQR
 *   C. 真实形态的激活码二维码能解出原文（内嵌点阵，测试零外部依赖）
 *   D. 空白 / 噪声图不得误判成二维码
 *   E. esim.js 的录入路径不再被 BarcodeDetector 卡死，且图片/拍照/粘贴三条路都在
 *
 * 运行：node tests/esim-qr-decode-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ATDIR = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'at-webserver');
const JSQR_JS = path.join(ATDIR, 'jsqr.js');
const LICENSE = path.join(ATDIR, 'jsQR-LICENSE.txt');
const ESIM_JS = path.join(ROOT, 'htdocs', 'luci-static', 'resources', 'view', 'at-webserver', 'esim.js');

let pass = 0;
const fails = [];
function ok(label, cond, extra) {
	if (cond) { pass++; return; }
	fails.push(label + (extra ? '  → ' + extra : ''));
}
function eq(label, got, want) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { pass++; return; }
	fails.push(label + '\n      实际: ' + g + '\n      期望: ' + w);
}

/* ------------------------------------------------------------------ A ---- */

ok('A1 jsqr.js 已落地', fs.existsSync(JSQR_JS));
const jsqrSrc = fs.existsSync(JSQR_JS) ? fs.readFileSync(JSQR_JS, 'utf8') : '';
ok('A2 jsqr.js 标注了来源与 Apache-2.0 许可',
	/jsQR/.test(jsqrSrc) && /Apache-2\.0/.test(jsqrSrc));
ok('A3 同目录带许可全文 jsQR-LICENSE.txt',
	fs.existsSync(LICENSE) && fs.readFileSync(LICENSE, 'utf8').length > 5000);
/* 裁剪掉 ShiftJIS 表会让 Kanji 模式解码异常，所以要求体积够大；
   反向：一个几十 KB 的"精简版"必须判红。 */
ok('A4 库未被裁剪（体积 > 200KB）', jsqrSrc.length > 200000, '实际 ' + jsqrSrc.length + ' 字节');

/* ------------------------------------------------------------------ B ---- */

/*
 * 模拟浏览器全局：只有 self / window，**没有 module / exports / define**，
 * 这正是 LuCI 前端脚本的运行形态（LuCI 的 require 会把模块源塞进同一个函数体）。
 * 反向：如果这里挂不上全局，页面上 jsQR 就是 undefined，图片识别会静默失败。
 */
const sandbox = { Math: Math, Date: Date, Uint8ClampedArray: Uint8ClampedArray, console: console };
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
let jsQR = null;
try {
	vm.runInContext(jsqrSrc, sandbox, { timeout: 5000 });
	jsQR = sandbox.jsQR;
} catch (e) {
	fails.push('B0 执行 jsqr.js 抛异常: ' + (e && e.message || e));
}
ok('B1 无 module/exports/define 时仍挂到全局 jsQR', typeof jsQR === 'function');
ok('B2 self.jsQR 与 window.jsQR 是同一个对象', sandbox.self.jsQR === sandbox.window.jsQR);

/* ------------------------------------------------------------------ C ---- */

/*
 * 真实形态的激活码二维码：由 qrcode@1.5.4（纠错等级 M）生成的 29×29 点阵，
 * 生成方式见 .workbuddy/tmp/gen_qr_fixture.js。内嵌在这里是为了让**本测试零外部依赖**
 * （CI / 别人机器上没有 qrcode 包也能跑），而不是为了省事。
 */
const FIX = {
	text: 'LPA:1$smdp.example.com$MATCHING-ID',
	size: 29,
	bits: '1111111011100111001000111111110000010101001001101101000001101110100100100011111010111011011101011001011001010101110110111010000100101011101011101100000100110110111001010000011111111010101010101010111111100000000110100011100000000000101101110100110100101010010110110110110100111010101110100000011110110001001111000000100010010001001000011011111011011011101101001011010101111100100011100000010101000100110110001000101011010111101111010101000000010100010110000000100100111010101000110001001010100010001011001001010000100110001010001010111111011100001101100101000111011100000010101000010100110111011100111111110100000000011000000000110001110111111110111010111010101011100100000101011111011011000111101011101000010000101111111111010111010110101001101111101100101110101000110011010011100011000001001100010111111011011111111110110110011000010101100'
};

/* 渲染成 jsQR 要的 RGBA：4 模块静区 + scale 倍放大 */
function renderQr(scale) {
	const q = 4;
	const w = (FIX.size + q * 2) * scale;
	const buf = new Uint8ClampedArray(w * w * 4);
	for (let i = 0; i < buf.length; i++) buf[i] = 255;
	for (let r = 0; r < FIX.size; r++) {
		for (let c = 0; c < FIX.size; c++) {
			if (FIX.bits[r * FIX.size + c] !== '1') continue;
			for (let dy = 0; dy < scale; dy++) {
				for (let dx = 0; dx < scale; dx++) {
					const o = (((r + q) * scale + dy) * w + (c + q) * scale + dx) * 4;
					buf[o] = buf[o + 1] = buf[o + 2] = 0;
				}
			}
		}
	}
	return { data: buf, width: w, height: w };
}

if (typeof jsQR === 'function') {
	eq('C1 夹具点阵尺寸自洽', FIX.bits.length, FIX.size * FIX.size);
	[8, 4].forEach(function (scale) {
		const img = renderQr(scale);
		let got = null;
		try { got = jsQR(img.data, img.width, img.height); } catch (e) { /* 下面判红 */ }
		ok('C2 放大 ' + scale + ' 倍时能解出激活码原文',
			!!got && got.data === FIX.text, got ? String(got.data) : 'null');
	});
	/* 反向：点阵被大面积破坏后不应再解出原文 ——
	   证明上面的通过不是"这个库永远返回同一串"。
	   注意只翻数据区（9..20），别动三个角的定位图形。
	   （纠错等级 M 能修掉约 15% 的码字，所以只翻 10 个点是修得回来的，
	     一开始翻少了反而验证不出来 —— 这本身就是一次"守卫自检"。） */
	(function () {
		const broken = FIX.bits.split('');
		for (let r = 9; r <= 20; r++) {
			for (let c = 9; c <= 20; c++) {
				const i = r * FIX.size + c;
				broken[i] = broken[i] === '1' ? '0' : '1';
			}
		}
		const save = FIX.bits;
		FIX.bits = broken.join('');
		const img = renderQr(8);
		let got = null;
		try { got = jsQR(img.data, img.width, img.height); } catch (e) { got = null; }
		FIX.bits = save;
		ok('★ 反向C 点阵被篡改后不再解出原文（证明 C2 不是恒真）',
			!got || got.data !== FIX.text);
	})();
}

/* ------------------------------------------------------------------ D ---- */

if (typeof jsQR === 'function') {
	const blank = new Uint8ClampedArray(200 * 200 * 4);
	for (let i = 0; i < blank.length; i++) blank[i] = 255;
	let b = 'throw';
	try { b = jsQR(blank, 200, 200); } catch (e) { b = 'throw'; }
	ok('D1 纯白图返回 null（不误判、不抛异常）', b === null, String(b));

	/* 伪随机噪声（固定种子，保证可复现） */
	const noise = new Uint8ClampedArray(160 * 160 * 4);
	let seed = 20260919;
	for (let i = 0; i < noise.length; i += 4) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		const v = seed % 256;
		noise[i] = noise[i + 1] = noise[i + 2] = v;
		noise[i + 3] = 255;
	}
	let n = 'throw';
	try { n = jsQR(noise, 160, 160); } catch (e) { n = 'throw'; }
	ok('D2 噪声图不抛异常', n !== 'throw');
	ok('D3 噪声图不会凭空解出激活码', !n || n.data !== FIX.text, n ? String(n.data) : 'null');
}

/* ------------------------------------------------------------------ E ---- */

const esimSrc = fs.existsSync(ESIM_JS) ? fs.readFileSync(ESIM_JS, 'utf8') : '';

/* E1：不再把整条路堵死在 BarcodeDetector 上。
   反向：改动前那两句「当前环境不支持…」只要还在，就必须判红。 */
function hasNativeOnlyDeadEnd(s) {
	return /当前环境不支持扫码/.test(s) || /当前环境不支持识别二维码图片/.test(s);
}
ok('E1 不再出现「当前环境不支持扫码/识别图片」这类死路文案',
	hasNativeOnlyDeadEnd(esimSrc) === false);
ok('★ 反向E1 旧实现的死路文案必须被检出', hasNativeOnlyDeadEnd(
	"inputBox.appendChild(E('div', { 'class': 'mt5700-notice-warning' }, '当前环境不支持扫码，请改用「粘贴激活码」或「手动填写」。'));"
) === true);

/* E2：内置解码器存在，且在原生不可用时顶上 */
function hasBuiltinFallback(s) {
	return /function jsQrText/.test(s)
		&& /function decodeQr\b/.test(s)
		&& /hasBarcodeDetector\(\)\)\s*return\s*jsQrText\(img\)/.test(s);
}
ok('E2 原生不可用时退回内置 jsQR', hasBuiltinFallback(esimSrc));
ok('★ 反向E2 只剩原生实现时必须判红',
	hasBuiltinFallback('function decodeQr() { return new window.BarcodeDetector(); }') === false);

/* E3：jsQR 是按需 <script> 注入，不能走 LuCI 的 require
   （require 要求模块 return 一个 Class，而 jsQR 是只挂全局的 UMD 包） */
function loadsJsQrProperly(s) {
	return /'require at-webserver\/jsqr'/.test(s) === false
		&& /function loadJsQr/.test(s)
		&& /\/luci-static\/resources\/at-webserver\/jsqr\.js/.test(s);
}
ok('E3 jsQR 按需注入、不走 LuCI require', loadsJsQrProperly(esimSrc));
ok('★ 反向E3 写成 require 时必须判红',
	loadsJsQrProperly("'require at-webserver/jsqr';\nfunction loadJsQr() {}") === false);
ok('★ 反向E3-b 路径写错（resources/view/...）时必须判红',
	loadsJsQrProperly(esimSrc.replace('/luci-static/resources/at-webserver/jsqr.js',
		'/luci-static/resources/view/at-webserver/jsqr.js')) === false);

/* E4：图片录入必须支持 选择 / 拖放 / 粘贴 三条路 */
function hasImagePaths(s) {
	return /function buildImagePicker/.test(s)
		&& /addEventListener\('drop'/.test(s)
		&& /type': 'file'/.test(s)
		&& /pasteHandler\s*=\s*pick/.test(s)
		&& /function bindPasteOnce/.test(s);
}
ok('E4 图片支持 选择 / 拖放 / 粘贴', hasImagePaths(esimSrc));
ok('★ 反向E4 只有 file input（老实现）时必须判红',
	hasImagePaths("var file = E('input', { 'class': 'mt5700-input', 'type': 'file', 'accept': 'image/*' });") === false);

/* E5：没有摄像头（http）时「扫码」降级成拍照，而不是直接不可用。
   <input capture> 由系统相机接管，不需要网页摄像头权限。 */
function hasCaptureFallback(s) {
	return /function hasCamera/.test(s)
		&& /capture: true/.test(s)
		&& /setAttribute\('capture', 'environment'\)/.test(s);
}
ok('E5 无摄像头时降级为拍照识别', hasCaptureFallback(esimSrc));
ok('★ 反向E5 拿掉 capture 时必须判红',
	hasCaptureFallback(esimSrc.replace("file.setAttribute('capture', 'environment');", '')) === false);

/* E6：识别结果一律过 parseActivationCode 校验，不合法的也要落地给用户看（P08） */
function validatesDecoded(s) {
	return /function applyQrText/.test(s)
		&& /Euicc\.parseActivationCode\(t\)/.test(s)
		&& /codeInput\.value = t/.test(s);
}
ok('E6 识别结果过激活码校验且填回输入框', validatesDecoded(esimSrc));
ok('★ 反向E6 识别后直接跳过校验时必须判红',
	validatesDecoded(esimSrc.replace('var p = Euicc.parseActivationCode(t);', 'var p = { ok: true };')) === false);

/* E7：多尺度重试（小码在高倍降采样下会糊） */
ok('E7 内置多尺度重试', /function decodeQrTry/.test(esimSrc) && /\[1000, 2000\]/.test(esimSrc));

/* E8：切模式 / 关向导时解绑粘贴，避免旧 handler 指向已销毁的 DOM */
function unbindsPaste(s) {
	return /pasteHandler = null/.test(s) && /if \(!tip\.parentNode\)/.test(s);
}
ok('E8 粘贴 handler 会被解绑 / 会自检 DOM 是否还活着', unbindsPaste(esimSrc));
ok('★ 反向E8 从不解绑时必须判红',
	unbindsPaste(esimSrc.replace(/pasteHandler = null/g, '')) === false);

/* E9：P19 —— 禁止「行首裸 then」（.then 顶格会被 ASI 切断成两条语句） */
function noBareThen(s) {
	return !/(^|\n)\.then\(/.test(s);
}
ok('E9 无顶格裸 .then', noBareThen(esimSrc));
ok('★ 反向E9 顶格 .then 必须判红', noBareThen('foo()\n.then(function () {})\n') === false);

/* ---------- 收尾 ---------- */

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('eSIM 二维码录入契约测试全部通过');
