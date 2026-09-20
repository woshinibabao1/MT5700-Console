#!/usr/bin/env python3
"""扫描工作区里被写成 CRLF 的文本文件（仓库约定是 LF）。

起因：2026-09-20 编辑 euicc.js 时工作区副本变成 CRLF，而测试里
假设 LF 的正则（如用 \\n\\t\\t}\\n 去切 6999 分支的那种）从此匹配不上
→ 反向守卫静默失效（git 侧因 core.autocrlf=input 看不出任何异常）。
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
EXTS = {".js", ".css", ".json", ".md", ".py", ".uc", ".sh", ".htm", ".html"}
SKIP_DIRS = {".git", "node_modules", ".workbuddy"}

rows = []
for p in ROOT.rglob("*"):
    if not p.is_file() or p.suffix.lower() not in EXTS:
        continue
    if any(part in SKIP_DIRS for part in p.parts):
        continue
    try:
        b = p.read_bytes()
    except OSError:
        continue
    crlf = b.count(b"\r\n")
    if crlf:
        rows.append((p.relative_to(ROOT).as_posix(), crlf, b.count(b"\n")))

if not rows:
    print("工作区没有 CRLF 文本文件（全部 LF）")
    sys.exit(0)

print(f"发现 {len(rows)} 个 CRLF 文本文件：")
for n, crlf, lf in sorted(rows):
    tag = "整文件" if crlf == lf else "混合"
    # 与 git 索引比对：索引里若也是 CRLF，说明是仓库既有约定，不算新引入
    try:
        blob = subprocess.run(["git", "show", f"HEAD:{n}"], cwd=ROOT,
                              capture_output=True).stdout
        blob_crlf = blob.count(b"\r\n")
    except Exception:
        blob_crlf = -1
    print(f"  {n}  CRLF={crlf}/{lf}（{tag}），HEAD 中 CRLF={blob_crlf}")
sys.exit(1)
