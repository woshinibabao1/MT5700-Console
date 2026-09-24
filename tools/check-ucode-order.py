#!/usr/bin/env python3
"""扫 mt5700.uc 里「函数定义在调用之后」的情况。

★★ 为什么需要它（2026-09-24 真机事故）：
    ucode **不做函数提升**。定义在调用之后时，`ucode -c` 编译**照样通过**，
    部署到设备也看不出来，只有真跑才炸：
        Type error: left-hand side is not a function
    而 rpcd 只会把异常吞成一句 `Command failed: ... (Unknown error)`，
    日志里什么都没有 —— 页面上就是一个莫名其妙的失败。

    本次出问题的两处：`atFirstNumber`（ePDG 探测）和 `es9pToolAvailable`
    （**出口 IP 探测，意味着那个功能在真机上一直是坏的**）。

★ 用法：改完 ucode 就跑一次；非零退出码表示有倒置。
"""
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(ROOT, "root", "usr", "share", "rpcd", "ucode", "mt5700.uc")


def main(path=TARGET):
    lines = io.open(path, encoding="utf-8", newline="").read().split("\n")

    defs = {}
    for i, line in enumerate(lines):
        m = re.match(r"^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", line)
        if m:
            defs[m.group(1)] = i + 1

    bad = []
    for name, dline in sorted(defs.items(), key=lambda kv: kv[1]):
        for i, line in enumerate(lines):
            if i + 1 == dline:
                continue
            s = line.strip()
            if s.startswith("/*") or s.startswith("*") or s.startswith("//"):
                continue
            if re.search(r"(?<![A-Za-z0-9_.])" + re.escape(name) + r"\s*\(", line):
                if i + 1 < dline:
                    bad.append((name, i + 1, dline, s[:70]))
                break

    if not bad:
        print("OK：%d 个函数，没有「调用早于定义」" % len(defs))
        return 0
    print("!! 有 %d 个函数在定义之前就被调用（ucode 不提升函数，真跑会炸）：" % len(bad))
    for name, use, d, txt in bad:
        print("   %-22s 用@%-5d 定义@%-5d | %s" % (name, use, d, txt))
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else TARGET))
