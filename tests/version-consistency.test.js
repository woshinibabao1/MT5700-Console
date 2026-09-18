#!/usr/bin/env node
'use strict';

/**
 * 版本号一致性测试
 *
 * 起因（2026-09-15，v2.0.2）：升版本号时对 Cargo.lock 做了一次全局字符串替换
 * `version = "2.0.1"` -> `version = "2.0.2"`，结果把第三方依赖 **shlex 2.0.1**
 * 也一并改成了不存在的 2.0.2 —— crates.io 上根本没有这个版本，CI 的 rust-check
 * 9 秒就红：
 *
 *   error: failed to select a version for the requirement `shlex = "^2.0.1"`
 *          (locked to 2.0.2)
 *   candidate versions found which didn't match: 2.0.1, 2.0.0, 1.3.0, ...
 *
 * Cargo.lock 里「我们自己的包」和「别人的依赖」长得一模一样，都是
 * `version = "x.y.z"`，全局替换必然误伤。所以本测试钉两件事：
 *
 *   ① 四处版本号必须一致（Makefile / Cargo.toml / Cargo.lock 主包 / CHANGELOG 顶部）
 *   ② Cargo.lock 中**除主包外**不允许有别的包版本号等于项目版本号
 *      —— 这正是全局替换留下的指纹（真机上 shlex 恰好也是 2.0.1，全局替换就
 *      把它一起改了）。若将来某个依赖真的与本项目同版本号，人工确认后把包名
 *      加进下面的 KNOWN_SAME_VERSION 白名单。
 *
 * 升版本请用 tools/bump-version.py，它会按 [[package]] 块精确定位，只动主包。
 *
 * 用法：node tests/version-consistency.test.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAIN_PKG = 'at-webserver';
/*
 * 确实与本项目同版本号的第三方包（人工确认过 crates.io 上存在）写这里。
 * ★ 写成「包名 → 版本号」而不是名单：名单一旦加过就永久生效，将来这些包
 *   真被全局替换误伤到**别的**版本号也会被放过；绑死版本号则只对得上当时那一版。
 *
 * icu_* 六件套：升到 2.3.0 时被本守卫拦下，经 `git show HEAD:src/rust/Cargo.lock`
 * 核对，这六个在**改动之前**就已经是 2.3.0（icu4x 2.3.0 系列），不是升版误伤。
 * icu_provider（2.3.1）、percent-encoding（2.3.2）同理，都是改动前就已是该版本。
 * 判据用「改动前后是否一致」而不是「查网页」—— lock 是 cargo 从 registry 解析
 * 出来的，里面写了就说明 crates.io 上确有此版本。
 */
const KNOWN_SAME_VERSION = {
	icu_collections: '2.3.0', icu_locale_core: '2.3.0', icu_normalizer: '2.3.0',
	icu_normalizer_data: '2.3.0', icu_properties: '2.3.0', icu_properties_data: '2.3.0',
	icu_provider: '2.3.1',
	'percent-encoding': '2.3.2'
};

let pass = 0;
const fails = [];
function ok(name, cond, hint) {
	if (cond) { pass++; return; }
	fails.push(name + (hint ? ' —— ' + hint : ''));
}

function read(p) {
	return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
}

/* ---- 解析 Cargo.lock：按 [[package]] 块切，拿到 name / version / source ---- */
function parseLockBlocks(text) {
	return text.split(/^\[\[package\]\]$/m).slice(1).map(function (b) {
		const get = function (k) {
			const m = b.match(new RegExp('^' + k + ' = "([^"]*)"', 'm'));
			return m ? m[1] : null;
		};
		return { name: get('name'), version: get('version'), source: get('source') };
	});
}

/* ------------------------------ 读四处版本号 ------------------------------ */
const makefile = read('Makefile');
const cargoToml = read('src/rust/Cargo.toml');
const cargoLock = read('src/rust/Cargo.lock');
const changelog = read('CHANGELOG.md');

const mkV = (makefile.match(/^PKG_VERSION:=(\S+)/m) || [])[1];
const tomlV = (cargoToml.match(/^version = "([^"]+)"/m) || [])[1];

const blocks = parseLockBlocks(cargoLock);
const mainBlocks = blocks.filter(function (b) { return b.name === MAIN_PKG; });
const lockV = mainBlocks.length ? mainBlocks[0].version : null;
const changelogV = (changelog.match(/^## \[([0-9][^\]]*)\]/m) || [])[1];

/* ------------------------------- 断言 ------------------------------------ */
ok('Makefile 里有 PKG_VERSION', !!mkV);
ok('Cargo.toml 里有 version', !!tomlV);
ok('Cargo.lock 里能找到主包 ' + MAIN_PKG, mainBlocks.length > 0);
ok('CHANGELOG 顶部有版本号标题', !!changelogV);

ok('四处版本号都取到了（才谈得上比对）', !!(mkV && tomlV && lockV && changelogV));

if (mkV && tomlV && lockV && changelogV) {
	ok('Makefile PKG_VERSION == Cargo.toml version',
		mkV === tomlV, 'Makefile=' + mkV + ' Cargo.toml=' + tomlV);
	ok('Cargo.toml version == Cargo.lock 主包 version',
		tomlV === lockV, 'Cargo.toml=' + tomlV + ' Cargo.lock=' + lockV);
	ok('CHANGELOG 顶部版本号 == Cargo.toml version',
		changelogV === tomlV, 'CHANGELOG=' + changelogV + ' Cargo.toml=' + tomlV);
	ok('版本号是 x.y.z 三段式 semver',
		/^\d+\.\d+\.\d+$/.test(tomlV), '实际为 ' + tomlV);
}

ok('Cargo.lock 里主包只出现一次（重复块说明合并冲突没处理干净）',
	mainBlocks.length === 1, '实际 ' + mainBlocks.length + ' 个');

/* ★ 核心守卫：全局替换留下的指纹 */
const others = blocks.filter(function (b) {
	return b.name !== MAIN_PKG && b.version === (tomlV || lockV);
});
const unexpected = others.filter(function (b) {
	return KNOWN_SAME_VERSION[b.name] !== b.version;
});
ok('Cargo.lock 中没有别的包被改成与本项目同版本号（升版全局替换的典型误伤）',
	unexpected.length === 0,
	'疑似被误伤：' + unexpected.map(function (b) {
		return b.name + '@' + b.version + (b.source ? '（registry 依赖）' : '');
	}).join('、') + '。确认 crates.io 上确有此版本则加入 KNOWN_SAME_VERSION');

/* Cargo.lock 里凡是 registry 依赖都必须带 source —— 主包（本地路径）除外 */
const noSource = blocks.filter(function (b) {
	return !b.source && b.name !== MAIN_PKG;
});
ok('Cargo.lock 中非主包都带 source（否则是本地包被误加进 lock）',
	noSource.length === 0, noSource.map(function (b) { return b.name; }).join('、'));

/* 每个块都得有 name 和 version，缺一个说明 lock 被改坏了 */
const broken = blocks.filter(function (b) { return !b.name || !b.version; });
ok('Cargo.lock 每个 [[package]] 块都有 name 与 version',
	broken.length === 0, '损坏块 ' + broken.length + ' 个');

console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
	console.log('');
	fails.forEach(function (f, i) { console.log('  ✗ ' + (i + 1) + '. ' + f); });
	process.exit(1);
}
console.log('版本号一致性测试全部通过（Makefile / Cargo.toml / Cargo.lock / CHANGELOG 同步）');
