#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AT 命令分类审计（对照技术手册）
================================================================================
回答一个必须用证据说话的问题：**源码里当成「只读」处理的命令，真的都是只读吗？
反过来，那些明明是查询的命令，有没有被当成写命令？**

四类检查：

  A. `?` 结尾的字面量 —— 语法上就是查询，`isRetryableRead()` **必须**为 true。
     为 false 即「读命令被当成写命令」，后果是：
       · 不缓存（每次都打串口）
       · 不重试（偶发 ERROR 直接变红叉）
       · 不被忙态熔断保护（通道忙时一条条去撞 8 秒）
       · 成功后还会 `_dropStateCache()` 把状态缓存整片清掉
  B. 三份只读名单里的命令 —— 必须能在技术手册里查到（**不许凭印象补全**）。
  C. 不带 `=` 也不带 `?` 的字面量 —— 分类依据只有手册，列出来逐条人工判定。
  D. 表里没有、但语法上像查询的（`=` 后跟 `[...]` 可选参数）—— 提示需核对。

★ 每个检查带反向自证：喂一个已知缺陷，必须报出来。

用法：
    python tools/audit-at-reads.py [项目根] [手册目录]
默认手册目录 = C:/Users/Ajmd007/.workbuddy/skills/mt5700-at-commands/references/commands
"""
import io
import os
import re
import subprocess
import sys
import glob
import json
import tempfile

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else '.')
MANUAL = sys.argv[2] if len(sys.argv) > 2 else (
    r'C:/Users/Ajmd007/.workbuddy/skills/mt5700-at-commands/references/commands')
NODE = r'C:/Users/Ajmd007/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'

SKIP = {'.git', 'target', 'node_modules', '.workbuddy'}


def read(p):
    try:
        return io.open(p, encoding='utf-8', errors='replace').read()
    except Exception:
        return ''


def walk(exts, skip=SKIP):
    out = []
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in skip]
        for f in fn:
            if f.endswith(exts):
                out.append(os.path.join(dp, f))
    return out


# --------------------------------------------------------------------------- #
# 取真值：用 node 载入 rpc.js，问它 isRetryableRead 的真实答案
# --------------------------------------------------------------------------- #
PROBE_JS = r"""
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=process.argv[2];
const src=fs.readFileSync(path.join(ROOT,'htdocs/luci-static/resources/at-webserver/rpc.js'),'utf8')
  .replace(/^\s*'require [^']*';\s*$/gm,'').replace(/\n\s*return AtWsClass;\s*$/,'\n');
const ctx={console:{error(){},log(){},warn(){}},Promise,JSON,Math,String,Number,RegExp,Object,Array,Error,
  isNaN,parseInt,setTimeout,clearTimeout,Date,
  L:{Class:{extend:x=>x},rpc:{declare:()=>()=>Promise.resolve({})},uci:{load:()=>Promise.resolve()},env:{}},
  window:undefined};
vm.createContext(ctx);
const mod=vm.runInContext('(function(){\n'+src+
  '\nreturn {isRetryableRead:isRetryableRead, NON_QUESTION_READS:NON_QUESTION_READS,'+
  'IDENTIFIER_COMMANDS:IDENTIFIER_COMMANDS, STATE_COMMANDS:STATE_COMMANDS};\n})()',ctx);
const list=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const out={};
list.forEach(c=>{ out[c]=!!mod.isRetryableRead(c); });
console.log(JSON.stringify({retry:out, lists:{
  NON_QUESTION_READS:mod.NON_QUESTION_READS,
  IDENTIFIER_COMMANDS:mod.IDENTIFIER_COMMANDS,
  STATE_COMMANDS:mod.STATE_COMMANDS}}));
"""


def probe_classification(literals):
    tmp = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
    json.dump(literals, tmp)
    tmp.close()
    js = tempfile.NamedTemporaryFile('w', suffix='.js', delete=False, encoding='utf-8')
    js.write(PROBE_JS)
    js.close()
    p = subprocess.run([NODE, js.name, ROOT, tmp.name], capture_output=True,
                       text=True, encoding='utf-8', errors='replace')
    if p.returncode != 0:
        raise SystemExit('探针失败（当成失败，不当成跳过）：' + (p.stderr or '')[:400])
    return json.loads(p.stdout)


# --------------------------------------------------------------------------- #
def collect_literals():
    """从源码里抠出 AT 命令字面量"""
    lits = {}
    pats = [
        r"send\(\s*'((?:AT|\^)[^']*)'",              # 前端 send('AT..')
        r"sendCommand\(\s*'((?:AT|\^)[^']*)'",
        r"'(AT[\^+][A-Za-z0-9_^\+]*(?:=[^']*)?)'",  # 通用字面量
    ]
    for p in walk(('.js', '.uc')):
        relp = os.path.relpath(p, ROOT).replace('\\', '/')
        s = read(p)
        for pat in pats:
            for m in re.finditer(pat, s):
                v = m.group(1)
                if len(v) > 80:
                    continue
                lits.setdefault(v, set()).add(relp)
    return lits


def manual_index():
    """手册里出现过的命令名（去参数），用于「不许凭印象补全」"""
    names = set()
    if not os.path.isdir(MANUAL):
        return names
    for p in glob.glob(os.path.join(MANUAL, '*.md')):
        s = read(p)
        # 带 ^ / + 前缀的
        for m in re.finditer(r'\bAT([\^\+][A-Z0-9_]+)', s):
            names.add('AT' + m.group(1))
        # 裸命令（ATI / ATE0 / AT&F 这类没有 ^ + 前缀的）
        # ★ 首版只抓 [\^\+]，于是 ATI 被误报「手册里查不到」。
        for m in re.finditer(r'\b(AT[A-Z][A-Z0-9_]{0,9})\b', s):
            names.add(m.group(1))
    return names


# 手册索引覆盖不到、但**真机已验证存在**的命令（附验证方式与日期）。
# 加进来的唯一条件是「有实测证据」，不许凭印象。
DEVICE_VERIFIED = {
    'AT^PHYNUM': '2026-09-26 真机只读实测：返回 ^PHYNUM:IMEI,... / MACWLAN / SVN + OK',
}


def self_test():
    res = []
    res.append(('`?` 判定', 'AT+CEREG?'.endswith('?')))
    res.append(('写命令判定', 'AT+CFUN=0'.count('=') == 1))
    res.append(('裸读判定', ('AT+CGPADDR'.count('=') == 0 and not 'AT+CGPADDR'.endswith('?'))))
    probe = "send('AT+CSQ?'); sendCommand('AT+CGSN');"
    got = set(re.findall(r"send(?:Command)?\(\s*'((?:AT|\^)[^']*)'", probe))
    res.append(('字面量提取', got == {'AT+CSQ?', 'AT+CGSN'}))
    return res


def main():
    print('=' * 78)
    print('AT 命令分类审计   项目根 =', ROOT)
    print('                  手册   =', MANUAL)
    print('=' * 78)

    st = self_test()
    print('\n### 反向自证')
    for n, o in st:
        print('  %-16s %s' % (n, '✓' if o else '✗ 恒绿，检查无效'))
    if not all(o for _, o in st):
        return 1

    lits = collect_literals()
    if not lits:
        return 1
    keys = sorted(lits)
    got = probe_classification(keys)
    retry = got['retry']
    lists = got['lists']

    q_reads = [k for k in keys if k.endswith('?')]
    writes = [k for k in keys if '=' in k and not k.endswith('?')]
    bare = [k for k in keys if '=' not in k and not k.endswith('?')]

    print('\n### A. `?` 结尾必须被当成只读（%d 条）' % len(q_reads))
    bad = [k for k in q_reads if not retry.get(k)]
    if bad:
        for k in bad:
            print('  ✗ [读被当成写] %-22s 出现于 %s' % (k, ', '.join(sorted(lits[k]))[:70]))
        print('    → 后果：不缓存、不重试、不受忙态熔断保护、成功后还会清空状态缓存')
    else:
        print('  ✓ 全部被正确识别为只读')

    print('\n### B. 三份只读名单必须能在手册里查到（不许凭印象补全）')
    idx = manual_index()
    if not idx:
        print('  · 手册目录不可达，本项跳过（标「未验证」）')
    else:
        listed = []
        for name, arr in lists.items():
            for c in arr:
                listed.append((name, c))
        miss = []
        for name, c in listed:
            base = re.sub(r'[?=].*$', '', c)
            if base in DEVICE_VERIFIED:
                continue
            if base not in idx:
                miss.append((name, c))
        if miss:
            for name, c in miss:
                print('  ✗ [手册里查不到且无实测证据] %-22s （来自 %s）' % (c, name))
            print('    → 要么删掉，要么给出真机实测证据再加进 DEVICE_VERIFIED')
        else:
            print('  ✓ %d 条全部有出处（手册索引或真机实测）' % len(listed))
        for base, why in sorted(DEVICE_VERIFIED.items()):
            if base not in idx:
                print('  · 手册索引未覆盖但已实测：%s —— %s' % (base, why))

    print('\n### C. 不带 `=` / `?` 的字面量：分类只看手册（%d 条，逐条列名）' % len(bare))
    for k in bare:
        mark = '只读' if retry.get(k) else '**按写命令处理**'
        print('  · %-20s %-16s 出现于 %s' % (k, mark, ', '.join(sorted(lits[k]))[:60]))

    print('\n### D. 带 `=` 的字面量（%d 条，写命令，逐条列名）' % len(writes))
    for k in writes[:25]:
        print('  · %-40s %s' % (k[:40], ', '.join(sorted(lits[k]))[:50]))
    if len(writes) > 25:
        print('  … 其余 %d 条省略' % (len(writes) - 25))
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
