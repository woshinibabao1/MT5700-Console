#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
精准升版本号（Makefile / Cargo.toml / Cargo.lock / CHANGELOG 顶部占位）。

为什么需要它
------------
2026-09-15 升 v2.0.2 时用了全局字符串替换，把 Cargo.lock 里第三方依赖
`shlex 2.0.1` 也改成了 crates.io 上不存在的 2.0.2，CI 的 rust-check 直接红：

    error: failed to select a version for the requirement `shlex = "^2.0.1"`
           (locked to 2.0.2)

Cargo.lock 里主包和依赖长得一模一样（都是 `version = "x.y.z"`），
任何 `str.replace('version = "旧"', 'version = "新"')` 都必然误伤。
本脚本按 `[[package]]` 块精确定位，只改主包那一个块。

用法
----
    python tools/bump-version.py 2.0.3            # 改三处并自检
    python tools/bump-version.py 2.0.3 --check    # 只检查一致性，不改文件
    python tools/bump-version.py 2.0.3 --changelog  # 顺带在 CHANGELOG 顶部补标题

CHANGELOG 的条目正文需要人工写，脚本只补 `## [版本] - 日期` 标题（--changelog 时）。
"""

import io
import os
import re
import sys
from datetime import date

ROOT = os.environ.get('MT5700_ROOT') or \
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_PKG = 'at-webserver'
SEMVER = re.compile(r'^\d+\.\d+\.\d+$')

MAKEFILE = 'Makefile'
TOML = os.path.join('src', 'rust', 'Cargo.toml')
LOCK = os.path.join('src', 'rust', 'Cargo.lock')
CHANGELOG = 'CHANGELOG.md'


def _load(rel):
    """读文件，返回 (文本, 是否 CRLF)。统一按 \n 处理，写回时还原换行风格。"""
    p = os.path.join(ROOT, rel)
    with io.open(p, 'rb') as f:
        raw = f.read()
    crlf = raw.count(b'\r\n') > (raw.count(b'\n') - raw.count(b'\r\n'))
    return raw.decode('utf-8').replace('\r\n', '\n'), crlf


def _save(rel, text, crlf):
    p = os.path.join(ROOT, rel)
    out = text.replace('\n', '\r\n') if crlf else text
    with io.open(p, 'wb') as f:
        f.write(out.encode('utf-8'))
    return out


def read_version():
    mk, _ = _load(MAKEFILE)
    toml, _ = _load(TOML)
    lock, _ = _load(LOCK)
    mkV = (re.search(r'^PKG_VERSION:=(\S+)', mk, re.M) or [None, None])[1]
    tomlV = (re.search(r'^version = "([^"]+)"', toml, re.M) or [None, None])[1]
    lockV = lock_version(lock)
    return mkV, tomlV, lockV


def lock_version(lock_text):
    """取主包块（且仅主包块）的 version。"""
    for blk in lock_text.split('[[package]]')[1:]:
        if re.search(r'^name = "%s"$' % re.escape(MAIN_PKG), blk, re.M):
            m = re.search(r'^version = "([^"]+)"', blk, re.M)
            return m.group(1) if m else None
    return None


def bump_lock(lock_text, old, new):
    """只改主包块的 version；命中不到或多处命中都直接抛错。"""
    blocks = lock_text.split('[[package]]')
    hit = 0
    for i, blk in enumerate(blocks):
        if re.search(r'^name = "%s"$' % re.escape(MAIN_PKG), blk, re.M):
            cur = re.search(r'^version = "([^"]+)"', blk, re.M)
            if not cur:
                raise SystemExit('主包块里找不到 version')
            if cur.group(1) not in (old, new):
                raise SystemExit(
                    '主包版本是 %s，与 --from 指定的 %s 不符，拒绝改（是不是填错了？）'
                    % (cur.group(1), old))
            blocks[i] = re.sub(r'^version = "[^"]+"',
                               'version = "%s"' % new, blk, count=1, flags=re.M)
            hit += 1
    if hit != 1:
        raise SystemExit('主包块命中 %d 个（期望 1），lock 文件可能被改坏了' % hit)
    return '[[package]]'.join(blocks)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    flags = set(a for a in sys.argv[1:] if a.startswith('-'))
    if not args:
        mkV, tomlV, lockV = read_version()
        if '--check' in flags:
            # 只体检：CI / 提交前跑，别输出一大段文档
            same = mkV == tomlV == lockV
            print('%s：Makefile=%s Cargo.toml=%s Cargo.lock=%s'
                  % ('一致' if same else '不一致', mkV, tomlV, lockV))
            raise SystemExit(0 if same else 1)
        print(__doc__)
        print('当前版本：Makefile=%s Cargo.toml=%s Cargo.lock=%s' % (mkV, tomlV, lockV))
        raise SystemExit(0 if mkV == tomlV == lockV else 1)

    new = args[0].lstrip('v')
    if not SEMVER.match(new):
        raise SystemExit('版本号必须是 x.y.z 三段式，收到：%s' % new)

    mkV, tomlV, lockV = read_version()
    if not (mkV == tomlV == lockV):
        raise SystemExit('三处版本本来就不一致（%s / %s / %s），先人工对齐'
                         % (mkV, tomlV, lockV))

    if '--check' in flags:
        print('一致：%s（--check，未改动）' % mkV)
        return

    old = mkV
    if old == new:
        raise SystemExit('新版本号与当前相同（%s）' % old)

    # Makefile
    mk, mk_crlf = _load(MAKEFILE)
    mk2, n = re.subn(r'^PKG_VERSION:=\S+', 'PKG_VERSION:=%s' % new, mk, count=1, flags=re.M)
    if n != 1:
        raise SystemExit('Makefile 里 PKG_VERSION 没找到或不唯一')
    _save(MAKEFILE, mk2, mk_crlf)

    # Cargo.toml（只有主包有 version，取第一个即可）
    toml_text, toml_crlf = _load(TOML)
    toml2, n = re.subn(r'^version = "[^"]+"', 'version = "%s"' % new, toml_text,
                       count=1, flags=re.M)
    if n != 1:
        raise SystemExit('Cargo.toml 里 version 没找到')
    _save(TOML, toml2, toml_crlf)

    # Cargo.lock（★ 只动主包块）
    lock_text, lock_crlf = _load(LOCK)
    lock2 = bump_lock(lock_text, old, new)
    """
    ★ 校验的正确姿势是「改动前后计数差 1」，而不是「新版本号只出现 1 次」。
      后者会把「某个依赖的版本号恰好和目标版本相同」当成误伤 —— 2026-09-18 升
      2.3.0 时就被这个自检拦下：lock 里有 6 个依赖本身就叫 2.3.0，脚本直接中止。
      真正的语义是：只有主包那一行从 old 变成 new，其余一行都不许动。
    """
    before = lock_text.count('version = "%s"' % new)
    after = lock2.count('version = "%s"' % new)
    if after != before + 1:
        raise SystemExit(
            'lock 里新版本号从 %d 处变成 %d 处（期望 +1），中止（疑似误伤依赖）'
            % (before, after))
    _save(LOCK, lock2, lock_crlf)

    # CHANGELOG：只在要求时补标题，正文必须人工写
    if '--changelog' in flags:
        cl, cl_crlf = _load(CHANGELOG)
        head = '## [%s] - %s' % (new, date.today().isoformat())
        if not re.search(r'^## \[%s\]' % re.escape(new), cl, re.M):
            anchor = re.search(r'^## \[', cl, re.M)
            if anchor:
                cl = cl[:anchor.start()] + head + '\n\n' + cl[anchor.start():]
            else:
                cl = cl.rstrip() + '\n\n' + head + '\n'
            _save(CHANGELOG, cl, cl_crlf)
            print('CHANGELOG：已插入 %s（条目正文请自行补写）' % head)

    # 自检
    a, b, c = read_version()
    if not (a == b == c == new):
        raise SystemExit('自检失败：%s / %s / %s' % (a, b, c))
    print('%s -> %s 完成（Makefile / Cargo.toml / Cargo.lock 三处，lock 仅改主包）'
          % (old, new))
    print('下一步：补 CHANGELOG 条目 -> node tests/run-all.js -> 提交')


if __name__ == '__main__':
    main()
