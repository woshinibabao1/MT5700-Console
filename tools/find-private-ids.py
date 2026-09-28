#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""防止「真机标识」被再次写回仓库。

背景：本仓库曾把真机的 IMSI / IMEI / ICCID / eUICC EID 直接写进 CHANGELOG、注释
和测试样本里，而仓库要对外开源 —— 这类标识一旦公开就撤不回来。

这个守卫**故意不写任何真值**（写进来等于再泄露一次）。它只按「形状」找候选，
再拿去和 `tools/private-ids-allow.txt` 里**已审阅过的值**比对；不在名单里的就判红。

形状：
  * IMSI / IMEI ：恰好 15 位数字
  * ICCID       ：19~20 位、以 89 开头的数字串（末位允许 F 填充）
  * eUICC EID   ：以 89 开头、共 32 位数字

用法：
    python3 tools/find-private-ids.py            # 检查，有问题退出码 1
    python3 tools/find-private-ids.py --gen      # 用当前状态重新生成 allow 名单
    python3 tools/find-private-ids.py --list     # 只列出候选，不判红

新增测试样本时：确认它是**编造值**后，把该值加进 `tools/private-ids-allow.txt`。
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALLOW_FILE = os.path.join(ROOT, 'tools', 'private-ids-allow.txt')

PATTERNS = [
    ('IMSI/IMEI', re.compile(r'(?<!\d)\d{15}(?!\d)')),
    ('ICCID', re.compile(r'(?<!\d)89\d{17,18}[0-9F](?!\d)')),
    ('EID', re.compile(r'(?<!\d)89\d{30}(?!\d)')),
]

SKIP_EXT = {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.exe', '.o', '.d',
            '.rmeta', '.pem', '.mo', '.lock'}
SKIP_DIR = ('target/', '.git/', '.workbuddy/', 'node_modules/')


def tracked_files():
    out = subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True,
                         text=True, encoding='utf-8', errors='replace').stdout
    return [l.strip() for l in out.splitlines() if l.strip()]


def load_allow():
    if not os.path.exists(ALLOW_FILE):
        return set()
    allow = set()
    with open(ALLOW_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.split('#', 1)[0].strip()
            if line:
                allow.add(line)
    return allow


def scan():
    found = {}
    for rel in tracked_files():
        rp = rel.replace('\\', '/')
        if any(d in rp for d in SKIP_DIR):
            continue
        if os.path.splitext(rp)[1].lower() in SKIP_EXT:
            continue
        try:
            with open(os.path.join(ROOT, rel), 'rb') as f:
                text = f.read().decode('utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, line in enumerate(text.splitlines(), 1):
            for kind, pat in PATTERNS:
                for m in pat.finditer(line):
                    found.setdefault(m.group(0), []).append((rel, lineno, kind))
    return found


def main():
    args = set(sys.argv[1:])
    found = scan()

    if '--gen' in args:
        with open(ALLOW_FILE, 'w', encoding='utf-8') as f:
            f.write('# 已审阅的「非真机」标识值（每行一个，# 起注释）\n')
            f.write('# 由 tools/find-private-ids.py --gen 生成；新增样本请确认是编造值再追加。\n')
            for val in sorted(found):
                kinds = {k for _, _, k in found[val]}
                f.write('%s  # %s, %d 处\n' % (val, '/'.join(sorted(kinds)),
                                              len(found[val])))
        print('已写入 %s（%d 个值）' % (ALLOW_FILE, len(found)))
        return 0

    allow = load_allow()
    bad = {v: locs for v, locs in found.items() if v not in allow}

    if '--list' in args:
        print('候选 %d 个，其中未登记 %d 个' % (len(found), len(bad)))
        for v in sorted(found):
            print('  %s %s' % ('✓' if v in allow else '✗', v))
        return 0

    print('扫描已跟踪文本文件，命中候选 %d 个（已登记 %d）'
          % (len(found), len(found) - len(bad)))
    if not bad:
        print('  ✓ 没有未登记的真机标识')
        return 0

    print('\n★ 发现 %d 个未登记的长数字标识 —— 若不确认是编造值，禁止提交：\n' % len(bad))
    for val in sorted(bad):
        locs = bad[val]
        print('  ✗ %s  （%s）' % (val, locs[0][2]))
        for rel, ln, _ in locs[:4]:
            print('      %s:%d' % (rel, ln))
        if len(locs) > 4:
            print('      … 共 %d 处' % len(locs))
    print('\n确认是编造值 → 追加到 %s；是真机值 → 必须脱敏后重提交。'
          % os.path.relpath(ALLOW_FILE, ROOT))
    return 1


if __name__ == '__main__':
    sys.exit(main())
