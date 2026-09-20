#!/usr/bin/env python3
"""守卫有效性验证（红线 16：写了守卫 ≠ 有了守卫）。

做法：对源码 / 契约测试文件施加**故意违反契约**的变异（全部保持语法合法，
避免"语法错误导致崩溃"被误当成"守卫检出了"），跑对应契约测试并断言判红；
随后从备份逐字节还原并复核。

用法：python tools/verify-guards.py
新增守卫时应在上面的 MUTATIONS 里补一条「故意违反」样例。
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
ATWB = ROOT / "htdocs" / "luci-static" / "resources" / "at-webserver"
ESIM = ROOT / "htdocs" / "luci-static" / "resources" / "view" / "at-webserver" / "esim.js"

TARGETS = {
    "js": ATWB / "euicc.js",
    "esimjs": ESIM,
    "esimcss": ATWB / "mt5700.css",
    "test": ROOT / "tests" / "euicc-download-contract.test.js",
    # euicc.js 的**同一份文件**再挂一个键：卡级阻断那组守卫在 esim-contract 里，
    # 而 "js" 键固定跑下载契约测试。一份文件两条测试通道，别把守卫挂错测试上。
    "js2": ATWB / "euicc.js",
    # mt5700.js 是**全站共用**组件（errorState 的按钮文案默认值就在这里），
    # 也要能被变异、被还原 —— 单独挂键，别和 euicc.js 混。
    "mt5700js": ATWB / "mt5700.js",
}

# 每个目标改动后该跑哪个契约测试（esim.js / mt5700.css 都归 esim-contract）
TARGET_TEST = {
    "js": ROOT / "tests" / "euicc-download-contract.test.js",
    "test": ROOT / "tests" / "euicc-download-contract.test.js",
    "esimjs": ROOT / "tests" / "esim-contract.test.js",
    "esimcss": ROOT / "tests" / "esim-contract.test.js",
    "js2": ROOT / "tests" / "esim-contract.test.js",
    "mt5700js": ROOT / "tests" / "esim-contract.test.js",
}

NODE = r"C:\Users\Ajmd007\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"

ORIG = {k: v.read_bytes() for k, v in TARGETS.items()}

# (名字, 目标, 旧片段, 新片段, 期望被点名的断言关键词)
MUTATIONS = [
    (
        "超时后立刻向卡敲门（2026-09-20 那个把整包打死的旧 bug）",
        "js",
        "(cut > 0 ? em.slice(0, cut) : em)",
        "(handshakeKnock(send, ch, api.getResponseApdu(ch, 0)), "
        "cut > 0 ? em.slice(0, cut) : em)",
        "不许出现任何卡侧 APDU",
    ),
    (
        "接回函数在拿到迟到回包之前就去敲卡",
        "js",
        "\t\tvar ps = [];",
        "\t\tvar _probe = api.getResponseApdu(ch, 0);\n"
        "\t\tsendAndCollect(send, ch, _probe, 0, '');\n"
        "\t\tvar ps = [];",
        "不发任何卡侧 APDU",
    ),
    (
        "去掉时间窗（退化成只靠轮数上限）",
        "js",
        "if (attempt > maxPolls || Date.now() >= opts.deadline) {",
        "if (attempt > maxPolls) {",
        "时间窗过期后立刻抛错",
    ),
    (
        "末块不再给长窗（和普通块一样）",
        "js",
        "var LATE_FINAL_WINDOW_MS = 90000;",
        "var LATE_FINAL_WINDOW_MS = 1000;",
        "时间窗是显式的毫秒常量",
    ),
    (
        "日志不再说清「不碰卡」",
        "js",
        "改为只发普通 AT 等模组吐回包（不碰卡）",
        "正在恢复",
        "改为只发普通 AT 等回包",
    ),
    (
        "接回结果不标出来（和正常回执长得一样）",
        "js",
        "r.recovered ? '（接回模组迟到的应答）' : ''",
        "''",
        "接回结果在日志里标出来",
    ),
    (
        "轮询漏传 fresh（真机上被 rpc.js 只读缓存吃掉，永远接不回来）",
        "js",
        "send('AT', { fresh: true })",
        "send('AT')",
        "缓存",
    ),
    (
        "往 asyncTests 里 push 裸函数（Promise.all 会放行 → 检查恒绿）",
        "test",
        "/* ---------- 汇总 ---------- */",
        "asyncTests.push(function () { ok('永远不会执行', false); });\n\n"
        "/* ---------- 汇总 ---------- */",
        "每一项都是 Promise",
    ),
    # ---------- 2026-09-20 eSIM 页 UI 重排的形态守卫 ----------
    (
        "EID 退回成 metric 大数字格（32 位标识符被大字号折行、无法逐位核对）",
        "esimjs",
        "E('div', { 'class': 'mt5700-esim-idvalue' }, p.eid",
        "E('div', { 'class': 'mt5700-mono' }, p.eid",
        "EID 用等宽标识块",
    ),
    (
        "EID 块在 CSS 里丢掉等宽字体（只留类名，界面悄悄退回比例字体）",
        "esimcss",
        ".mt5700-esim-idvalue {\n  margin-top: 2px;\n  font-family: var(--mt5700-font-mono);",
        ".mt5700-esim-idvalue {\n  margin-top: 2px;\n  font-family: var(--mt5700-font-sans);",
        "在 CSS 里确实是等宽",
    ),
    (
        "ICCID 丢掉行卡等宽类（长卡号变回比例字体）",
        "esimjs",
        "E('span', { 'class': 'mt5700-esim-row-iccid' }",
        "E('span', { 'class': 'mt5700-mono' }",
        "ICCID 用行卡等宽类展示",
    ),
    (
        "昵称顶替官方名（同一张卡在不同地方叫法不一致）",
        "esimjs",
        "var name = p.profileName || p.spName || ''",
        "var name = p.profileName || p.spName || p.nickname",
        "昵称不顶替官方名",
    ),
    (
        "通路徽章不再由 p.transport 决定（固定报「正常」，下载失败时误导）",
        "esimjs",
        "p.transport === 'cgla' ? '下载通路正常' : '下载通路受限'",
        "'下载通路正常'",
        "通路徽章由 p.transport 决定",
    ),
    (
        "行卡「已启用」色条类名被改掉（CSS 侧应当场判红）",
        "esimcss",
        ".mt5700-esim-row.is-on::before",
        ".mt5700-esim-row.is-enabled::before",
        "行卡与「已启用」色条",
    ),
    # ---------- 2026-09-20 卡级阻断（基本通道全 6985）的状态分流守卫 ----------
    (
        "卡级阻断不再单独报（SW 混回 EUICC_OP_FAILED，页面又变成一句「读取失败」）",
        "js2",
        "if (api.isCardBlockedSw(e.sw, e.ch)) return { state: 'blocked', sw: e.sw };",
        "if (false) return { state: 'blocked', sw: e.sw };",
        "基本通道 6985 → state=blocked",
    ),
    (
        "异常不再带 SW / 通道号（判定失去依据，阻断态判不出来）",
        "js2",
        "se.sw = a.sw;\n\t\t\tse.ch = ch;",
        "se.sw = '';\n\t\t\tse.ch = null;",
        "基本通道 6985 → state=blocked",
    ),
    (
        "阻断判据丢掉「基本通道」这一半（逻辑通道 6985 也误报成阻断）",
        "js2",
        "\t\treturn sw === '6985' && ch === 0;",
        "\t\treturn sw === '6985';",
        "阻断判据必须限定基本通道",
    ),
    (
        "阻断判据丢掉 6999 这一半（本机实际命中的那条路径 → 又退回「读取失败」）",
        "js2",
        "\t\tif (sw === '6999') return true;",
        "\t\tif (false) return true;",
        "CGLA 通路 6999",
    ),
    (
        "把被推翻的「M2M eUICC / 厂家锁卡」结论写回 6985 文案",
        "js2",
        "text: '卡片拒绝了该操作（6985：使用条件不满足）',",
        "text: '这张是 M2M eUICC（SGP.02）或被厂家锁卡',",
        "不再把 6985 的成因写成 M2M",
    ),
    (
        "阻断面板不再被状态分流调用（新增状态直接掉进兜底分支）",
        "esimjs",
        "p.state === 'blocked') renderBlocked(p);",
        "false) renderBlocked(p);",
        "renderBlocked 且被状态分流调用",
    ),
    (
        "阻断面板文案丢掉下一步动作（只说失败，用户不知道要重启模组）",
        "esimjs",
        "反复操作不会改变结果",
        "请稍后重新进入本页",
        "给出下一步",
    ),
    # ---------- 2026-09-20 阻断面板的文案 / 按钮形态（本轮真踩过的两个坑） ----------
    (
        "阻断面板正文写进 Markdown 星号（errorState 只渲染纯文本 → 界面原样显示星号）",
        "esimjs",
        "卡片对基本通道上的每一条命令都回 ",
        "卡片对基本通道上的**所有**命令都回 ",
        "不含 Markdown 星号",
    ),
    (
        "阻断面板按钮退回默认「重新尝试」（正文说反复操作无意义，按钮自相矛盾）",
        "esimjs",
        "function () { render(); },\n\t\t\t\t'重新探测'));",
        "function () { render(); },\n\t\t\t\t'重新尝试'));",
        "按钮文案是「重新探测」",
    ),
    (
        "errorState 的默认按钮文案被改（全站共用组件，一改所有页面跟着变）",
        "mt5700js",
        "api.primaryButton(retryText || '重新尝试', onRetry)",
        "api.primaryButton(retryText || '再来一次', onRetry)",
        "默认仍是「重新尝试」",
    ),
    (
        "阻断面板按 6985 一句写死（6999 路径下等于陈述没发生过的事实）",
        "esimjs",
        "var why = (sw === '6999')",
        "var why = (false)",
        "按 SW 分文案",
    ),
]


def run_test(tgt):
    test = TARGET_TEST[tgt]
    p = subprocess.run([NODE, str(test)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def syntax_ok(path):
    """语法预检：确认变异本身没把文件写坏，否则"判红"可能只是崩了。

    两种文件需要两条路，别混用：
      · tests/ 下的契约测试是 CommonJS（首行还有 #! shebang）→ node --check 直接可用；
      · LuCI 的 view / require 模块顶层常是 `return L.view.extend({...})`，在 CommonJS
        里属非法 return，--check 必然报错 → 包一层 new Function()（函数体内 return 合法，
        仍能抓出真的语法错误）。
        ★ 注意 new Function 不认 shebang，所以测试文件不能走这条路。
      · CSS 不做预检（改的是属性值 / 选择器，不会产生解析错误）。
    """
    if path.suffix == ".css":
        return True
    if "tests" in path.parts:
        args = [NODE, "--check", str(path)]
    else:
        args = [NODE, "-e",
                "new Function(require('fs').readFileSync(process.argv[1],'utf8'));",
                str(path)]
    p = subprocess.run(args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode == 0


def restore_all():
    for k, path in TARGETS.items():
        path.write_bytes(ORIG[k])


def main():
    for tgt in ("js", "esimjs", "js2", "mt5700js"):
        rc0, out0 = run_test(tgt)
        print("基线[%s]:" % tgt, "绿色（0 失败）" if rc0 == 0 else "红！先修基线再验证守卫")
        if rc0 != 0:
            print(out0)
            return 1

    bad = 0
    for i, (name, tgt, old, new, key) in enumerate(MUTATIONS, 1):
        path = TARGETS[tgt]
        text = ORIG[tgt].decode("utf-8")
        if text.count(old) != 1:
            print(f"[{i}] ✗ 变异锚点不唯一/找不到（出现 {text.count(old)} 次）：{name}")
            bad += 1
            continue
        path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="")
        # ↑ newline="" 是关键：Windows 上 write_text 默认把 \n 翻成 \r\n，
        #   会把整个文件变成 CRLF。仓库约定 LF，而测试全靠「读源码 + 假设 LF 的正则」，
        #   一旦变 CRLF，那种正则静默匹配不上、反向守卫直接失效
        #   （2026-09-20 真踩过，见 tests/line-endings-contract.test.js）。
        # 先确认变异本身语法合法 —— 否则"判红"可能只是崩了
        if not syntax_ok(path):
            print(f"[{i}] ✗ 变异后语法非法，无法归因：{name}")
            restore_all()
            bad += 1
            continue
        rc, out = run_test(tgt)
        hit = key in out
        if rc != 0 and hit and "异步用例异常" not in out:
            print(f"[{i}] ✓ 变异被断言检出：{name}（判红 {out.count(chr(10) + '  ✗')} 处）")
        else:
            print(f"[{i}] ✗ 变异被放过：{name}（rc={rc}, 关键词命中={hit}）")
            bad += 1
        restore_all()

    same = all(TARGETS[k].read_bytes() == ORIG[k] for k in TARGETS)
    print("还原复核:", "逐字节一致" if same else "*** 不一致！***")
    rc, _ = run_test("esimjs")
    print("还原后基线:", "绿色" if rc == 0 else "红！")
    return 1 if (bad or rc != 0 or not same) else 0


if __name__ == "__main__":
    sys.exit(main())
