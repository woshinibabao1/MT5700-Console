#!/usr/bin/env python3
"""守卫有效性验证（红线 16：写了守卫 ≠ 有了守卫）。

做法：对源码 / 契约测试文件施加**故意违反契约**的变异（全部保持语法合法，
避免"语法错误导致崩溃"被误当成"守卫检出了"），跑对应契约测试并断言判红；
随后从备份逐字节还原并复核。

用法：python tools/verify-guards.py
新增守卫时应在上面的 MUTATIONS 里补一条「故意违反」样例。
"""
import os
import pathlib
import shutil
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
    # mt5700.js 再挂一个键：它同时被 single-source 契约守着（信号百分比真源），
    # 而 "mt5700js" 固定跑 esim-contract —— 一份文件两条测试通道，别挂错。
    "mt5700js2": ATWB / "mt5700.js",
    # 同一份 euicc.js 再挂第三个键：tag 白名单守卫走它自己的测试文件。
    "js3": ATWB / "euicc.js",
    # esim.js 再挂一个键：静默 catch 守卫是独立测试文件。
    "esimjs2": ESIM,
    # euicc.js 再挂第四个键：SW 9xxx 分支那组守卫在 euicc-contract 里
    # （「js」键跑的是下载契约测试，别挂错 —— 挂错就是变到别处、守卫恒绿）。
    "js4": ATWB / "euicc.js",
    # shell 脚本也要能变异：C 风格注释那条事故（glob 被当命令执行）守的是 .sh。
    "shell": ROOT / "root" / "usr" / "share" / "mt5700" / "diag-probe.sh",
    "msjs": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    "upgjs": ATWB.parent / "view" / "at-webserver" / "upgrade.js",
    # 测试文件自身也要能被变异：断言签名守卫查的就是测试文件的写法。
    "test2": ROOT / "tests" / "device-control-contract.test.js",
    # 「单一真源」契约（tests/single-source-contract.test.js）覆盖多个文件，
    # 每个被它守着的文件都要能单独变异 —— 一份文件一个键，别混。
    "rpcjs": ATWB / "rpc.js",
    "parsejs": ATWB / "parse.js",
    "termjs": ATWB.parent / "view" / "at-webserver" / "terminal.js",
    "smssetjs": ATWB.parent / "view" / "at-webserver" / "sms_settings.js",
    # Rust 后端也在守卫范围内（事件帧预算）；.rs 不做语法预检，见 syntax_ok。
    "rsrust": ROOT / "src" / "rust" / "src" / "rpcserver.rs",
    # ucode 后端（rpcd 插件）也在守卫范围内：exitip 的 bind 校验是**命令注入面**，
    # 必须能被故意违反并验证守卫判红。.uc 不做语法预检，见 syntax_ok。
    "uc": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    # parse.js 再挂一个键：出口 IP 解析那组守卫在 exitip-contract 里，
    # 而 "parsejs" 固定跑 single-source-contract —— 一份文件两条测试通道，别挂错。
    "parsejs2": ATWB / "parse.js",
    # ★ 再挂两个键（2026-09-24 真机校准）：短信可达性的「承载域 × CS 域」交叉判据
    #   横跨 parse.js（parseCsDomain）与 sms_settings.js（判据表达式），
    #   守卫在自己的 sms-reachability-contract 里。
    #   ★ 复用 parsejs2 / smssetjs 会**跑错测试**（它们分别固定跑 exitip-contract
    #   与 single-source-contract）→ 变异生效但没人判红 → 比没守卫更危险（红线 16b）。
    "parsejs3": ATWB / "parse.js",
    "smssetjs2": ATWB.parent / "view" / "at-webserver" / "sms_settings.js",
    # ★ 再挂三个键（2026-09-24）：ePDG / VoWiFi 判定的守卫在自己的 epdg-contract 里。
    #   复用 uc / rpcjs / msjs 会**跑错测试**（它们分别固定跑 exitip-contract、
    #   single-source-contract、device-control-contract）→ 变异生效却没人判红
    #   → 比没守卫更危险（红线 16b）。
    "uc2": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "rpcjs2": ATWB / "rpc.js",
    "nsjs": ATWB.parent / "view" / "at-webserver" / "network_status.js",
}

# 每个目标改动后该跑哪个契约测试（esim.js / mt5700.css 都归 esim-contract）
TARGET_TEST = {
    "js": ROOT / "tests" / "euicc-download-contract.test.js",
    "test": ROOT / "tests" / "euicc-download-contract.test.js",
    "esimjs": ROOT / "tests" / "esim-contract.test.js",
    "esimcss": ROOT / "tests" / "esim-contract.test.js",
    "js2": ROOT / "tests" / "esim-contract.test.js",
    "mt5700js": ROOT / "tests" / "esim-contract.test.js",
    "mt5700js2": ROOT / "tests" / "single-source-contract.test.js",
    "js3": ROOT / "tests" / "euicc-tag-whitelist-contract.test.js",
    "esimjs2": ROOT / "tests" / "silent-catch-contract.test.js",
    "js4": ROOT / "tests" / "euicc-contract.test.js",
    "shell": ROOT / "tests" / "shell-comment-style-contract.test.js",
    "msjs": ROOT / "tests" / "device-control-contract.test.js",
    "upgjs": ROOT / "tests" / "read-command-fresh-contract.test.js",
    "test2": ROOT / "tests" / "assert-signature-contract.test.js",
    "rpcjs": ROOT / "tests" / "single-source-contract.test.js",
    "parsejs": ROOT / "tests" / "single-source-contract.test.js",
    "termjs": ROOT / "tests" / "single-source-contract.test.js",
    "smssetjs": ROOT / "tests" / "single-source-contract.test.js",
    "rsrust": ROOT / "tests" / "single-source-contract.test.js",
    "uc": ROOT / "tests" / "exitip-contract.test.js",
    "parsejs2": ROOT / "tests" / "exitip-contract.test.js",
    "parsejs3": ROOT / "tests" / "sms-reachability-contract.test.js",
    "smssetjs2": ROOT / "tests" / "sms-reachability-contract.test.js",
    "uc2": ROOT / "tests" / "epdg-contract.test.js",
    "rpcjs2": ROOT / "tests" / "epdg-contract.test.js",
    "nsjs": ROOT / "tests" / "epdg-contract.test.js",
}

def _resolve_node() -> str:
    """定位 node 可执行文件。

    CI（ubuntu）上没有下面那条 Windows 绝对路径，写死会让整个脚本在 CI 上直接崩，
    而崩掉和"判红"从退出码上分不出来（见下面 syntax_ok 那条注释）。
    解析顺序：显式 NODE_BIN → 本机托管 node → PATH 里的 node。
    """
    env = os.environ.get("NODE_BIN")
    if env:
        return env
    managed = pathlib.Path(
        r"C:\Users\Ajmd007\.workbuddy\binaries\node\versions\22.22.2-3\node.exe")
    if managed.exists():
        return str(managed)
    found = shutil.which("node")
    if found:
        return found
    raise SystemExit("找不到 node：请设置 NODE_BIN 环境变量指向 node 可执行文件")


NODE = _resolve_node()

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
        # ★ 回归锚点唯一性已核：euicc.js 里 `if (sw.charAt(0) === '9') {` 只出现 1 次
        #   （变异工具改的是全文件第一次出现，同形多处会变到别处 → 误判守卫恒绿）。
        "去掉 SW 9xxx 分支（9100 掉回兜底被当失败，三处放行判据变死代码）",
        "js4",
        "\t\tif (sw.charAt(0) === '9') {",
        "\t\tif (false) {",
        "91xx 判「成功待 refresh」",
    ),
    (
        # ★ 锚点唯一性已核：mt5700.uc 里 `let bind = safeBindIp(getStr(req.args, 'bind'));`
        #   只出现 1 次（就在 exitip 方法里）—— 变异工具改的是全文件第一次出现。
        "exitip 绕过 bind 校验直接拼进命令行（命令注入面）",
        "uc",
        "let bind = safeBindIp(getStr(req.args, 'bind'));",
        "let bind = getStr(req.args, 'bind');",
        "拼 --interface 之前先过 safeBindIp",
    ),
    (
        # ★ 锚点唯一性已核：parse.js 里 `if (!s) return null;` 只出现 1 次（parseExitIpBody 内）。
        "出口 IP 取不到时返回 0.0.0.0 占位（红线 23：把读不出来伪装成有值）",
        "parsejs2",
        "if (!s) return null;",
        "if (!s) return '0.0.0.0';",
        "空串 → null（不是 0.0.0.0）",
    ),
    (
        # ★ 锚点唯一性已核：sms_settings.js 里 `preferCs && !v.cs.registered`
        #   只出现 1 次（renderReachability 的判据表达式，缩进 3 个 tab）。
        "短信可达性退化成单条件（只看承载域，不交叉 CS 域实测 → 回落 GSM/UMTS 时误报）",
        "smssetjs2",
        "\t\t\telse if (v.cgsms.preferCs && !v.cs.registered) {",
        "\t\t\telse if (v.cgsms.preferCs) {",
        "两个条件在同一个 && 表达式里",
    ),
    (
        # ★ 锚点唯一性已核：parse.js 里 `registered: r.stat === 1 || r.stat === 5`
        #   只出现 1 次（parseCsDomain 内）。
        "CS 域判定丢掉 stat=5（漫游态被当未注册 → 漫游时误报短信不可达）",
        "parsejs3",
        "registered: r.stat === 1 || r.stat === 5",
        "registered: r.stat === 1",
        "stat=5（已注册漫游）→ registered",
    ),
    (
        # ★★ 锚点唯一性已核：mt5700.uc 里 `} else if (posCtl.state != 'available') {`
        #   只出现 1 次（epdgFacts 的总判定处）。
        #   这一条是本功能最容易被写歪的地方：本机 DNS 坏了也会被判成「运营商没发布」。
        "ePDG 丢掉阳性对照门禁（本机 DNS 故障被算到运营商头上）",
        "uc2",
        "\t} else if (posCtl.state != 'available') {",
        "\t} else if (false) {",
        "阳性对照查不到时，verdict 必须退回 unknown",
    ),
    (
        # ★ 锚点唯一性已核：`{ cmd: 'AT+CIMI', fresh: true }` 只出现 1 次。
        #   AT+CIMI 在 STATIC_READS 里缓存 300s，不 fresh 就会拿上一张卡的 IMSI
        #   去拼上一张卡的 ePDG 域名（红线 24 的同型事故）。
        "ePDG 读 IMSI 不 fresh（换卡后 300 秒内拼出上一张卡的 ePDG 域名）",
        "uc2",
        "rpcCall('at', { cmd: 'AT+CIMI', fresh: true })",
        "rpcCall('at', { cmd: 'AT+CIMI' })",
        "AT+CIMI 走 fresh",
    ),
    (
        # ★ 锚点唯一性已核：EPDG_PREFIX 前缀校验只出现 1 次（safeEpdgFqdn 内）。
        "ePDG 域名不校验前缀就拼进命令行（命令注入面）",
        "uc2",
        "\tif (substr(s, 0, length(EPDG_PREFIX)) != EPDG_PREFIX) {",
        "\tif (false) {",
        "前缀不对但长度合规",
    ),
    (
        # ★ 锚点唯一性已核：EPDG_SUFFIX 后缀校验只出现 1 次（safeEpdgFqdn 内）。
        "ePDG 域名只校验前缀不校验后缀（.attacker.example.com 之类能混进命令行）",
        "uc2",
        "\tif (substr(s, length(s) - length(EPDG_SUFFIX)) != EPDG_SUFFIX) {",
        "\tif (false) {",
        "后缀不对但长度合规",
    ),
    (
        # ★ 锚点唯一性已核：`let d = dohLookup(fqdn, EPDG_ECS);` 全仓 1 次（epdgProbe 内）。
        #   真机（2026-09-24）：系统 DNS 对 *.3gppnetwork.org 有通配污染，只看一条路
        #   会把「污染」当「有」、把「本机 DNS 抽风」当「运营商没发布」。
        "ePDG 不再做 DoH 回退（单条链路的结论可能正好说反）",
        "uc2",
        "\tlet d = dohLookup(fqdn, EPDG_ECS);",
        "\tlet d = null;",
        "系统 DNS 没给出 available 时，要换 DoH 再问一次",
    ),
    (
        # ★ 锚点唯一性已核：`url = url + '&edns_client_subnet=' + ecs;` 全仓 1 次。
        #   ePDG 的权威 DNS 常只对归属国的解析器返回地址（参考 VoCat 的地理回退），
        #   不带 ECS 等于白问一趟。
        "ePDG 的 DoH 不带 EDNS Client Subnet（归属国权威 DNS 不给答案）",
        "uc2",
        "\t\turl = url + '&edns_client_subnet=' + ecs;",
        "\t\turl = url;",
        "DoH 要带归属国的 EDNS Client Subnet",
    ),
    (
        # ★ 锚点唯一性已核：`if (r.doh.state == 'unknown') {` 全仓 1 次。
        #   换链路是为了**纠偏**，不是替换：DoH 自己也说不清时不许覆盖系统 DNS 的结论。
        "ePDG 的 DoH 无条件覆盖系统 DNS 结论（换链路从纠偏变成替换）",
        "uc2",
        "\tif (r.doh.state == 'unknown') {",
        "\tif (false) {",
        "只有 DoH 给出**更确定**的结论才覆盖系统 DNS",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   真机：mnc000 明确 NXDOMAIN、mnc00 返回 127.0.0.1（与必然不存在的 mnc999 同值）。
        #   去掉 canonical 优先后，「运营商明确没发布」会被污染的变体搅成「无法判定」。
        "ePDG 丢掉 canonical 优先（被污染的变体把「没发布」搅成「无法判定」）",
        "uc2",
        "\t\tif (canon != null && canon.state == 'not_published') {",
        "\t\tif (false) {",
        "权威域名说 NXDOMAIN 时，被污染的变体不许把结论搅成 unknown",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   覆盖后前端只能看到「最终结论」，看不到「两条路各说了什么」——
        #   而那个不一致正是判污染的根据。
        "ePDG 覆盖系统 DNS 结论时不留原值（页面看不到两条路的对比）",
        "uc2",
        "\tr.sysState = r.state;",
        "\tr.sysState = null;",
        "系统 DNS 的原结论要单独留一份",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次（epdgFacts 内）。
        #   猜成固定 2 位：换一张 3 位 MNC 的卡就会拼出必然 NXDOMAIN 的域名，
        #   把「我拼错了」报成「运营商没发布」。
        "ePDG 的 MNC 长度改成猜（不从卡上 EF_AD 读）",
        "uc2",
        "\tlet mncLen = readMncLength();",
        "\tlet mncLen = 2;",
        "MNC 长度先问卡（EF_AD）",
    ),
    (
        # ★★ 真机事故（2026-09-24）：在页面里发 AT+CCHO 开逻辑通道，通道占上后
        #   AT+CCHC 关不掉（一律 SIM failure），只能重启模组才恢复。
        #   这里变异成「加回一条 CCHO」，反向断言必须把它判红。
        "ePDG/VoWiFi 探测里又出现 AT+CCHO（逻辑通道占上后不可回收）",
        "uc2",
        "\tlet aka = akaEvidence(aidInfo);",
        "\tlet aka = akaEvidence(aidInfo);\n\trpcCall('at', { cmd: 'AT+CCHO=\"A0000000871002\"' });",
        "ePDG/VoWiFi 探测全程不许发 AT+CCHO",
    ),
    (
        # ★★ 真机真踩过这一条（2026-09-24）：去掉这道门禁后，busybox nslookup 开头的
        #   Server/Address 两行（223.5.5.5:53）会被当成解析结果 —— 连必然不存在的
        #   mnc999 都「解析到了地址」，总判定恒为 available，最关键的结论被反过来说。
        # ★ 锚点唯一性已核：下面这段多行锚点在全仓只出现 1 次（nsPickAddrs 内）。
        # ★★ 为什么必须**两道一起拆**（2026-09-24 第 3 次修正）：
        #     只拆 `!seenName` 门禁 → `v != dns + ':53'` 兜底接住，判不出来；
        #     只拆 `v != dns + ':53'` → seenName 门禁接住，也判不出来（放过过一次）。
        #     NXDOMAIN 的输出里只有 Server 段那一行 Address，任一防线单独存在都足以
        #     把它挡掉。两道互为冗余是好事，但**变异必须模拟「两道都失效」**，
        #     否则守卫会显示「能检出」而其实根本没验证到这个失效模式。
        "nslookup 输出不过滤 Server 段（DNS 服务器自己被当成结果 → 任何域名都判「解析到了」）",
        "uc2",
        "\t\tif (!seenName) {\n\t\t\tcontinue;\n\t\t}\n"
        "\t\tif (index(line, 'Address') == 0) {\n"
        "\t\t\tlet k = index(line, ':');\n"
        "\t\t\tif (k >= 0) {\n"
        "\t\t\t\tlet v = trim(substr(line, k + 1));\n"
        "\t\t\t\tif (v != '' && v != dns && v != dns + ':53') {\n"
        "\t\t\t\t\taddrs[length(addrs)] = v;\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n"
        "\t\t}",
        "\t\tif (index(line, 'Address') == 0) {\n"
        "\t\t\tlet k = index(line, ':');\n"
        "\t\t\tif (k >= 0) {\n"
        "\t\t\t\tlet v = trim(substr(line, k + 1));\n"
        "\t\t\t\tif (v != '') {\n"
        "\t\t\t\t\taddrs[length(addrs)] = v;\n"
        "\t\t\t\t}\n"
        "\t\t\t}\n"
        "\t\t}",
        "NXDOMAIN 输出（真机格式）一个地址都不产生",
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
    # ---------- 2026-09-20 全面审计：操作码按位映射 / error 态人话 / 资源与并发 ----------
    (
        "操作码按位映射被废（真实安装回执 81=80 又显示成「操作 128」）",
        "js2",
        "if (opNum & PMO_BITS[bi][0]) opNames.push(PMO_BITS[bi][1]);",
        "if (false) opNames.push(PMO_BITS[bi][1]);",
        "操作码 80",
    ),
    (
        "probe 的 error 态丢掉 SW 矩阵人话（页面又只剩一句「卡片返回了失败状态字」）",
        "js2",
        "sw: e.sw || '', swText: e.swText || '', swHint: e.swHint || ''",
        "sw: '', swText: '', swHint: ''",
        "X1 error.swText",
    ),
    (
        "renderError 丢掉 detail 优先级（swText 到了页面却不展示）",
        "esimjs",
        "'读取 eSIM 信息失败：' + (detail || hint || '请稍后重试。'),",
        "'读取 eSIM 信息失败：' + (hint || '请稍后重试。'),",
        "X2 renderError",
    ),
    (
        "首屏列表 catch 不再识别卡级阻断（阻断时显示裸状态码）",
        "esimjs",
        "走与首屏一致的 blocked 面板（含下一步动作）。 */\n\t\t\t\tif (Euicc.isCardBlockedSw(e && e.sw, e && e.ch)) { renderBlocked({ sw: e.sw }); return; }",
        "走与首屏一致的 blocked 面板（含下一步动作）。 */\n\t\t\t\tif (false) { renderBlocked({ sw: e.sw }); return; }",
        "X3 两处列表读取 catch",
    ),
    (
        "下载日志行数不再封顶（上千行常驻内存）",
        "esimjs",
        "if (lines.length > 160) lines.splice(0, lines.length - 160);",
        "/* no cap */",
        "X4 下载日志行数封顶",
    ),
    (
        "showPendingReceipts 读取期间不置 busy（可与写操作并发开第二条 ISD-R 通道）",
        "esimjs",
        "卡只有 1~3 条，6A81）。 */\n\t\t\tbusy = true;\n\t\t\tEuicc.listNotifications(send).then(function (r) {",
        "卡只有 1~3 条，6A81）。 */\n\t\t\tEuicc.listNotifications(send).then(function (r) {",
        "X5 showPendingReceipts",
    ),
    # ↓ 以下三条守的是「守卫本身是否有效」—— 它们对应的契约测试都是新加的，
    #   新守卫最容易犯的错就是恒绿（看起来在防，其实永远通过）。
    (
        "shell 里写 C 风格注释（会被 glob 展开成根目录文件列表并当命令执行）",
        "shell",
        "#!/bin/sh\n",
        "#!/bin/sh\n/* 兼容老模组的分支 */\n",
        "会被 glob 展开",
    ),
    (
        "向卡发送白名单外的 tag（盲目探测 tag 曾把模组 AT 通道锁死，只能整机断电）",
        "js3",
        "var payload = 'BF2D'",
        "var payload = 'BF99'",
        "白名单外",
    ),
    (
        "扫码逐帧解码的 catch 不再交代为何吞错（又变成「读不出来」=「没有」）",
        "esimjs2",
        "\t" * 9 + "/* 单帧解码失败不打断：继续下一帧，直到识别成功、用户取消或超时。\n"
        + "\t" * 9 + "   这里没有用户可见反馈是刻意的 —— 扫码过程中每一帧都可能失败，\n"
        + "\t" * 9 + "   逐帧提示只会让画面一直闪 */\n",
        "",
        "每个无参数 catch 都有交代",
    ),
    (
        "暂存项 led 的 run 不再 reject（界面会报「已应用」而模组其实没改）",
        "msjs",
        "return send('AT^LEDSWITCH=' + (checked ? 1 : 0)).then(function (res) {\n"
        "\t\t\t\t\tif (!res.success) throw new Error('模组返回失败');\n",
        "return send('AT^LEDSWITCH=' + (checked ? 1 : 0)).then(function (res) {\n",
        "暂存项 led",
    ),
    (
        "finishByIdle 的版本查询去掉 fresh（FOTA 版本复核会读到旧版本）",
        "upgjs",
        "\t\t\tAtWs.client.sendCommand('AT+CGMR', { fresh: true })",
        "\t\t\tAtWs.client.sendCommand('AT+CGMR')",
        "finishByIdle",
    ),
    (
        "删掉 deleteProfile 的二次 busy 拦截（确认框停留期可重入）",
        "esimjs",
        "\t\t\t\t\tif (busy) { Mt5700.error('有操作正在进行'); return; }\n"
        "\t\t\t\t\t/* P17：iccidRaw 为空不下发，避免只弹一句「操作失败」 */",
        "\t\t\t\t\t/* P17：iccidRaw 为空不下发，避免只弹一句「操作失败」 */",
        # ★ expect 必须是测试里**当前的**措辞（2026-09-24 校准）：出口 IP 探测按钮那次
        #   把拦截数从 5 提到 6，测试断言同步改成「恰好 6 处」，这里没跟着改，
        #   于是变异明明被判红（rc=1）却因关键词失配报成「变异被放过」——假警报。
        #   ★ 改拦截数量时必须同步：esim-contract 的断言文案 + 本 expect，两处。
        "恰好 6 处",
    ),
    (
        "把断言写成定义相反的顺序（字符串落进条件位 → 恒为真）",
        "test2",
        "\tok(!!m, '暂存项 ' + key + ' 走 ctrlStaged.set（不逐项立即写模组）');",
        "\tok('暂存项 ' + key + ' 走 ctrlStaged.set（不逐项立即写模组）', !!m);",
        "调用顺序都与自身定义一致",
    ),
    # ---- 以下 8 条守的是 tests/single-source-contract.test.js（「同一件事只有一个家」）----
    (
        "rpc.js 又自己算 -110 量程的信号百分比（两页面显示两个百分比）",
        "rpcjs",
        "\tvar pct = Parse.signalPercent(rsrp);",
        "\tvar pct = Math.round(100 * (rsrp - (-110)) / ((-70) - (-110)));",
        "rpc.js 又开始自己算百分比了",
    ),
    (
        "mt5700.js 又自己算 2*(rsrp+120)（与 parse.js 的公式分家）",
        "mt5700js2",
        "\t\treturn Parse.signalPercent(rsrp);",
        "\t\treturn Math.max(0, Math.min(100, Math.round(2 * (Number(rsrp) + 120))));",
        "mt5700.js 又开始自己算百分比了",
    ),
    (
        "终端页不再查危险 AT（AT+CFUN=0 会直接把 5G 断掉）",
        "termjs",
        "var danger = Parse.atDangerHint(command);",
        "var danger = null;",
        "终端又没有危险指令提示了",
    ),
    (
        "短信设置页不再查危险 AT（不经确认就清空全部短信）",
        "smssetjs",
        "var hint = Parse.atDangerHint(s[0]);",
        "var hint = null;",
        "短信开关又会不经确认就发",
    ),
    (
        "parseRejInfo 缺字段又归 0（「没上报」显示成「CS 域」）",
        "parsejs",
        "var num = function (v) { return numOrNull(unquote(v)); };",
        "var num = function (v) { var n = Number(unquote(v)); return isFinite(n) ? n : 0; };",
        "缺字段又归 0 了",
    ),
    (
        "parse.js 里再抄一份 numOrNull（两份契约迟早不一致）",
        "parsejs",
        "\t/* numOrNull / hexOrNull 已上移到文件顶部的「公共取值工具」，全文件共用一份 */",
        "\tvar numOrNull = function (v) { return Number(v); };",
        "恰好定义一处",
    ),
    (
        "EventBus::since 去掉 budget 参数（500 条事件一次全回撑爆 8192 单帧）",
        "rsrust",
        "fn since(&self, since: u64, budget: usize) -> (u64, Vec<serde_json::Value>) {",
        "fn since(&self, since: u64) -> (u64, Vec<serde_json::Value>) {",
        "since 又没有字节预算了",
    ),
    (
        "events 调用点不再传帧预算",
        "rsrust",
        "self.hub.bus.since(since, EVENT_FRAME_BUDGET)",
        "self.hub.bus.since(since, 0)",
        "events 调用点传入 EVENT_FRAME_BUDGET",
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
       · shell 也不做预检：变异只是插入/删除注释行，不会产生语法错误；
         而 `bash -n` 在 Windows 与 CI 上路径不同，为一条永远合法的变异去
         引入平台分支不值得（真想查可以本地跑 bash -n）。
    """
    if path.suffix == ".css":
        return True
    if path.suffix == ".sh":
        return True
    # Rust 不做预检：本机与 CI 都没有 cargo/编译器，而 `new Function(源码)` 对
    # Rust 语法必然报错。这些变异只改标识符/参数/常量，不会把文件写坏。
    if path.suffix == ".rs":
        return True
    # ucode 不做预检：本机与 CI 都没有 ucode 解释器；而 `new Function(源码)` 对
    # ucode 的顶层写法（对象常量、纯声明式结构）可能误报语法错误。
    # 这些变异只改一个表达式/一个分支，语法上必然仍合法。
    if path.suffix == ".uc":
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
            # ★ 统计口径（2026-09-24 修正）：全仓测试统一用 `'  ✗ '` 前缀输出失败项。
            #   原先这里写 `'\n  ✗'`，会把**第一行**失败漏掉（首行前面没有 '\n'）→
            #   「只被 1 条断言抓住」的变异会显示「判红 0 处」，看着像守卫没生效，
            #   实际是 off-by-one。去掉 '\n' 约束即可；`'  ✗'` 仍足以与汇总行区分
            #   （汇总行是无前导空格的 `'\n✗ N 项断言失败'`）。
            print(f"[{i}] ✓ 变异被断言检出：{name}（判红 {out.count('  ✗')} 处）")
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
