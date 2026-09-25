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
    # ★ 再挂三个键（2026-09-24）：VoWiFi 判定的守卫在自己的 vowifi-contract 里。
    #   复用 uc / rpcjs / msjs 会**跑错测试**（它们分别固定跑 exitip-contract、
    #   single-source-contract、device-control-contract）→ 变异生效却没人判红
    #   → 比没守卫更危险（红线 16b）。
    "uc2": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
    "rpcjs2": ATWB / "rpc.js",
    # ★★ 2026-09-24 迁页：VoWiFi 已整块搬到**模组设置**页，它的变异必须跟着改挂
    #   vowifijs（同为 modem_settings.js，但跑 vowifi-contract，不是 device-control）。
    #   原 "nsjs" 键指向 network_status.js 却配 vowifi-contract —— 迁页后这是**跑错
    #   测试**的组合（红线 16b），所以删键而不是留着。
    "vowifijs": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    # 「调用了未定义的函数」守卫（tests/undefined-fn-contract.test.js）也按文件变异。
    "undeffnjs": ATWB.parent / "view" / "at-webserver" / "modem_settings.js",
    # ★ 再挂三个键（2026-09-25 全量审计）：引导收口契约（tests/bootstrap-contract.test.js）
    #   同时守着 mt5700.js 的 connectThen 定义、某个 view 页的用法、以及 ucode 的
    #   -32001 翻译。★ 复用 mt5700js / upgjs / uc2 会**跑错测试**（它们分别跑
    #   esim-contract、read-command-fresh-contract、vowifi-contract）
    #   → 变异生效却没人判红（红线 16b）。
    "corejs": ATWB / "mt5700.js",
    "dialjs": ATWB.parent / "view" / "at-webserver" / "dial.js",
    "uc3": ROOT / "root" / "usr" / "share" / "rpcd" / "ucode" / "mt5700.uc",
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
    "uc2": ROOT / "tests" / "vowifi-contract.test.js",
    "rpcjs2": ROOT / "tests" / "vowifi-contract.test.js",
    "vowifijs": ROOT / "tests" / "vowifi-contract.test.js",
    "undeffnjs": ROOT / "tests" / "undefined-fn-contract.test.js",
    "corejs": ROOT / "tests" / "bootstrap-contract.test.js",
    "dialjs": ROOT / "tests" / "bootstrap-contract.test.js",
    "uc3": ROOT / "tests" / "bootstrap-contract.test.js",
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
        # ★ 断言名随方法改名（epdg → vowifi）同步改名，关键词必须跟着改，
        #   否则变异生效却匹配不到断言 → 显示「被放过」（红线 16b）。
        "VoWiFi 评估全程不许发 AT+CCHO",
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
    # ---------- 2026-09-24 VoWiFi 五道门：EF_DIR / IMPI / AKA 实测能力 ----------
    (
        # ★★ 真机（2026-09-24）：AT+CRSM 读 EF_DIR **不带 path** 一律回
        #   "+CME ERROR: UNKNOWN"，整条身份链直接断在第一步。
        # ★ 锚点唯一性已核：这条命令串全仓只出现 1 次（efDirApps 内）。
        "EF_DIR 读记录不带 path（真机实测：一律 +CME ERROR: UNKNOWN，身份链断在第一步）",
        "uc2",
        "'AT+CRSM=178,' + EF_DIR_ID + ',' + rec + ',4,0,,\"' + EF_DIR_PATH + '\"'",
        "'AT+CRSM=178,' + EF_DIR_ID + ',' + rec + ',4,0,'",
        # ★ 关键词要指向**真的会红的那条断言**：改的是使用处，判红的是
        #   「EF_DIR 用 AT+CRSM=178 读记录」；常量的那条断言不会红（常量没动）。
        "EF_DIR 用 AT+CRSM=178 读记录",
    ),
    (
        # ★ 锚点唯一性已核：`if (sw != '9000') {` 全仓 1 次（efDirApps 内）。
        #   异常状态字（6A88/6A82/6981…）下必须**停**并留痕；删掉这段会一路读到 6 条上限，
        #   把错误应答的内容当 EF_DIR 记录塞进 apps，且不留下任何「读不到」的痕迹。
        # ★ 关键词随断言改名同步（现在是「其它非 9000 状态字要留下 err」）。
        "EF_DIR 不再看异常状态字（一路读到上限，空记录被当应用且不留痕）",
        "uc2",
        "\t\tif (sw != '9000') {\n\t\t\terr = 'ef_dir_sw_' + sw;\n\t\t\tbreak;\n\t\t}",
        "",
        "留下 err",
    ),
    (
        # ★ 锚点唯一性已核：`return decHex2(sw1) + decHex2(sw2);` 全仓 1 次。
        #   CRSM 的 sw 是**十进制**回的（106,131），不转十六进制就判不出 6A83。
        "crsmSw 不再把十进制 sw 转成十六进制（6A83 判不出来）",
        "uc2",
        "return decHex2(sw1) + decHex2(sw2);",
        "return sw1 + sw2;",
        "106,131 解成 6A83",
    ),
    (
        # ★★ 锚点唯一性已核：`if (k == '02') {\n\t\t\treturn 'USIM';\n\t\t}` 全仓 1 次
        #   （appKind 内；uiccAkaAid 里那段变量名是 kind，写法不同）。
        #   真机本卡 EF_DIR 里只有一条 USIM 记录（rec2 起就是 6A83）——
        #   一旦把别的应用也判成 USIM，「卡上没有 ISIM」这类关键事实就没了。
        "appKind 把非 USIM 的 AID 也判成 USIM（应用类型全失真）",
        "uc2",
        "\t\tif (k == '02') {\n\t\t\treturn 'USIM';\n\t\t}",
        "\t\treturn 'USIM';",
        "appKind 认 ISIM",
    ),
    (
        # ★ 锚点唯一性已核：mnc3Of 的补零分支全仓 1 次。
        #   TS 23.003 的 IMS 域名里 MNC 恒三位；不补就会拼出 mnc00.mcc460 这种错域名。
        "MNC 不补零（TS 23.003 的 IMS 域名里 MNC 恒三位）",
        "uc2",
        "\tif (length(mnc) == 3) {\n\t\treturn mnc;\n\t}\n\treturn '0' + mnc;",
        "\treturn mnc;",
        "两位 MNC 补成三位",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次（deriveImpi 内）。
        "IMPI 派生式少拼 ims. 段（EAP-AKA 拿到一个运营商不认的身份）",
        "uc2",
        "return imsi + '@ims.mnc' + mnc3 + '.mcc' + mcc + '.3gppnetwork.org';",
        "return imsi + '@mnc' + mnc3 + '.mcc' + mcc + '.3gppnetwork.org';",
        "拼出真机 IMPI",
    ),
    (
        # ★★★ 本轮最重要的一条。真机实测：AT+CSIM 上限 42 个十六进制字符，
        #   而 USIM AUTHENTICATE 需要 76 —— **发不出去**。
        #   拍成 true 等于凭空宣称「能实测 AKA」，是红线 14 那类空壳能力。
        # ★ 锚点唯一性已核：全仓 1 次。
        "AKA 实测能力拍成「支持」（抹掉 42<76 这条真机事实，宣称能发 AUTHENTICATE）",
        "uc2",
        "return AKA_AUTH_HEX <= CSIM_MAX_HEX;",
        "return true;",
        "本模组不支持 AUTHENTICATE 实测",
    ),
    (
        # ★ 同上：把常量拍大也能让 supported 变 true，是同一条事实的另一条逃逸路径。
        "CSIM 上限常量拍大（AUTHENTICATE 被当成能发出去）",
        "uc2",
        "const CSIM_MAX_HEX = 42;",
        "const CSIM_MAX_HEX = 512;",
        "CSIM 上限常量取真机实测值 42",
    ),
    (
        # ★ 锚点唯一性已核：`ok: (impi != ''),` 全仓 1 次（vowifiFacts 的 identity 门）。
        #   VoWiFi 用的是 IMPI 不是 IMSI —— 省掉这道门等于把「身份都没有」算作通过。
        "identity 门恒绿（不判 IMPI 有没有就放行）",
        "uc2",
        "\t\t\tok: (impi != ''),",
        "\t\t\tok: true,",
        "identity 门独立存在",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   阻断清单的价值在于**逐条点名**：只给一个「不可用」，用户不知道该换卡还是该等运营商。
        "阻断清单丢掉 no_usim_isim（卡上没 USIM/ISIM 这条关键事实不再点名）",
        "uc2",
        "\t\tblockers[length(blockers)] = 'no_usim_isim';",
        "\t\tblockers[length(blockers)] = '';",
        "逐条点名",
    ),
    (
        # ★ 锚点唯一性已核：全仓 1 次。
        #   ePDG 无法判定（两条链路都没结论）时必须说 unknown，不许说「不通」。
        "ePDG 无法判定时总判定仍落 blocked（把「测不出来」说成「不通」）",
        "uc2",
        "\t} else if (ep.verdict == 'unknown') {\n\t\tverdict = 'unknown';",
        "\t} else if (false) {\n\t\tverdict = 'unknown';",
        "ePDG 无法判定时总判定不许说",
    ),
    (
        # ★★ 真机形态 sim✓ identity✓ aka✓ epdg✗ ims✓ 下，「最后一个 ok」会算出 ims_ready，
        #   界面于是同时显示「走到：IMS 已注册」和「VoWiFi 不成立」——自相矛盾。
        # ★ 锚点唯一性已核：`if (!stages[i].ok) {` 全仓 1 次（vowifiFacts 的 phase 循环）。
        "phase 退回「取最后一个 ok 的门」（卡在第 3 道门却报 ims_ready，界面自相矛盾）",
        "uc2",
        "\t\tif (!stages[i].ok) {\n\t\t\tbreak;\n\t\t}\n\t\tphase = PHASE_BY_STAGE[i];",
        "\t\tif (stages[i].ok) {\n\t\t\tphase = PHASE_BY_STAGE[i];\n\t\t}",
        "phase 是「连续通过的前缀」",
    ),
    (
        # ★ 红线 23：AT 通道挂了 = 读不到，不是「卡上没装应用」。
        #   去掉这两处 err，调用方会拿到空 apps 并把一次失败说成「没有 ISIM」。
        # ★ 锚点唯一性已核：`err = 'ef_dir_read_failed';` 全仓 2 次，锚点含上下文只命中第 1 处。
        "EF_DIR 读失败不留 err（一次 AT 失败被当成「卡上没有 ISIM」）",
        "uc2",
        "\t\tif (r == null || !r.success || r.data == null) {\n\t\t\terr = 'ef_dir_read_failed';\n\t\t\tbreak;\n\t\t}",
        "\t\tif (r == null || !r.success || r.data == null) {\n\t\t\tbreak;\n\t\t}",
        "都要留 err",
    ),
    (
        # ★ 6A83 是「记录不存在＝读完了」，是**卡的客观事实**。
        #   删掉这个分支后它会掉进 `sw != '9000'`，于是「读完了」被记成「读不到」。
        "EF_DIR 丢掉 6A83 分支（「读完了」被当成「读不到」）",
        "uc2",
        "\t\tif (sw == '6A83') {\n\t\t\tbreak;",
        "\t\tif (false) {\n\t\t\tbreak;",
        "6A83 就停",
    ),
    (
        # ★ 与上一条相反：给 6A83 也置 err，同样是把「没装应用」说成「读不到」。
        "EF_DIR 给 6A83 也置 err（「卡上没装应用」被说成「读不到」）",
        "uc2",
        "\t\tif (sw == '6A83') {\n\t\t\tbreak;",
        "\t\tif (sw == '6A83') {\n\t\t\terr = 'ef_dir_sw_' + sw;\n\t\t\tbreak;",
        "6A83 分支只 break 不置 err",
    ),
    (
        # ★ 返回体少了 err，调用方拿不到「读不到」这个信息，前端只能显示「没有」。
        "efDirApps 退化成只回 apps（读不到的信息在调用链上丢掉）",
        "uc2",
        "\treturn { apps: apps, err: err };",
        "\treturn apps;",
        "efDirApps 返回 { apps, err }",
    ),
    (
        # 前端：dirError 分支一去掉，「读不到」就又变成「没有 ISIM」。
        "前端不再区分 dirError（读不到又被显示成「没有 ISIM」）",
        "vowifijs",
        "\t\t\t\tif (d.identity.dirError) {",
        "\t\t\t\tif (false) {",
        "读不到 EF_DIR",
    ),
    (
        # ★★ 开关的方向写反：点「开」实际下发的是关 IMS 的命令。
        #   真机后果＝IMS 短信与 VoLTE 语音一起断掉，而界面还显示「已开启」。
        "开关方向写反（点「开」下发的是 AT^IMSSWITCH=0,0,0，直接断掉 IMS）",
        "uc2",
        "return 'AT^IMSSWITCH=' + (enable ? '1,0,0' : '0,0,0');",
        "return 'AT^IMSSWITCH=' + (enable ? '0,0,0' : '1,0,0');",
        "开 = AT^IMSSWITCH=1,0,0",
    ),
    (
        # ★★ 缺 enable 时默认成 0 = 默认「关 IMS」。
        #   任何漏传参数的调用方（含未来的新页面）都会静默断掉 IMS，是有后果的动作。
        "开关缺 enable 时默认成 0（漏传参数＝静默关掉 IMS）",
        "uc2",
        "\t\t\t\tif (v == null) {\n\t\t\t\t\treturn { success: false, error: '缺少 enable 参数（0=关，1=开）' };\n\t\t\t\t}",
        "\t\t\t\tif (v == null) {\n\t\t\t\t\tv = 0;\n\t\t\t\t}",
        "缺 enable 必须报错",
    ),
    (
        # ★★ ePDG 是运营商侧的网元，本机改不了。把它也算进「不能开启」的门禁，
        #   这个开关在本机（中国移动卡）就永远是死的 —— 又回到「空壳开关」。
        "把 epdg_not_published 也算进开启门禁（开关在本机永远是死的）",
        "uc2",
        "if (b == 'sim_unread' || b == 'mnc_ambiguous' || b == 'no_impi' || b == 'no_usim_isim') {",
        "if (b == 'sim_unread' || b == 'mnc_ambiguous' || b == 'no_impi' || b == 'no_usim_isim'"
        " || b == 'epdg_not_published') {",
        "ePDG 没发布不挡开启",
    ),
    (
        # ★ 开启方向的门禁一去掉，本地三门没过也会去下发一条注定失败的命令，
        #   而用户拿到的是一句「下发失败」，不是「为什么开不了」。
        "开启不再过本地门禁（先下发再失败，用户拿不到原因）",
        "uc2",
        "\tif (enable) {\n\t\tlet local = vowifiLocalBlockers(f);",
        "\tif (false) {\n\t\tlet local = vowifiLocalBlockers(f);",
        "只有开启方向设门禁",
    ),
    (
        # ★ ^IMSSWITCH? 不在 rpc.js 的读缓存档 → 落到默认 2500ms 缓存，
        #   不 fresh 会捞到下发前的旧值，把「已生效」误判成「没生效」（R04 同一套约定）。
        "开关回读不再 fresh（读到下发前的旧值，制造假故障）",
        "uc2",
        "{ cmd: 'AT^IMSSWITCH?', fresh: true }",
        "{ cmd: 'AT^IMSSWITCH?' }",
        "回读 ^IMSSWITCH? 必须 fresh",
    ),
    (
        # ★ 开关状态与「VoWiFi 成不成立」是两件事，都要回。
        #   不重跑的话界面只会显示「已开启」，看不到还差 ePDG 这一门。
        "下发后不再重跑五门（开了开关却不说还差什么）",
        "uc2",
        "\tlet after = vowifiFacts();",
        "\tlet after = f;",
        "下发后重跑五门",
    ),
    (
        # ★ 参数表多一个口子，前端就能把别的东西送进 ubus。
        "rpc 给 vowifi_set 多开一个参数（开关的口子被开大）",
        "rpcjs2",
        "\tmethod: 'vowifi_set',\n\tparams: ['enable'],",
        "\tmethod: 'vowifi_set',\n\tparams: ['enable', 'cmd'],",
        "参数只有 enable",
    ),
    (
        # ★ 关 IMS 会断掉 IMS 短信与 VoLTE 语音 —— 必须确认，且取消要把开关拨回去。
        "关 IMS 不再确认（误点一下就断掉短信与 VoLTE）",
        "vowifijs",
        "\t\t\tif (!on) {\n\t\t\t\tMt5700.confirm('关闭会下发 AT^IMSSWITCH=0,0,0，"
        "IMS 短信与 VoLTE 语音会一起断掉。确定关闭？',\n\t\t\t\t\tfunction () { doVowifiSet(0); }, '确定关闭',"
        "\n\t\t\t\t\tfunction () { renderVowifiSwitch(); });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tdoVowifiSet(1);",
        "\t\t\tdoVowifiSet(on ? 1 : 0);",
        "关 IMS 要先确认",
    ),
    (
        # ★★ 同上实测的后端侧：`args: { enable: 0 }` 是整型，字符串/布尔进不了 ucode。
        #   给 enable 补字符串分支＝写一段永远跑不到的代码，还让人误以为类型不敏感。
        "后端又给 enable 补字符串分支（rpcd 挡在前面，这段永远跑不到）",
        "uc2",
        "\t\t\t\tlet enable = -1;\n\t\t\t\tif (v === 1) {",
        "\t\t\t\tlet enable = -1;\n\t\t\t\tif (v === 1 || v === '1') {",
        "后端只认数字 0/1",
    ),
    (
        # ★★ 真机实测（2026-09-24）：`args: { enable: 0 }` 声明整型，传字符串 '1'
        #   被 rpcd 以 code=2（Invalid argument）整包拒掉 —— 点了开关完全没反应，
        #   连 ucode 里的报错都走不到，界面只会显示兜底的「设置失败」。
        "前端给开关传字符串 '1'（被 rpcd 以 Invalid argument 拒，点了没反应）",
        "rpcjs2",
        "\treturn withTimeout(rpcVowifiSet(enable ? 1 : 0), 60000, 'VoWiFi 开关超时')",
        "\treturn withTimeout(rpcVowifiSet(enable ? '1' : '0'), 60000, 'VoWiFi 开关超时')",
        "前端传的是数字 0/1",
    ),
    (
        # ★ 被拒绝时只报「设置失败」，用户不知道该换卡还是该等运营商 ——
        #   正是本轮要治的「点了没反应 / 只给一句失败」。
        "被拒绝时前端只报「设置失败」（不给原因）",
        "vowifijs",
        "\t\t\t\tt.setMsg = '无法开启：' + blockersToText(r.blockers);",
        "\t\t\t\tt.setMsg = '设置失败';",
        "无法开启",
    ),
    (
        # 前端：不发不出去的命令，但**要说清为什么发不出去**，否则用户以为是没实现。
        "前端不再展示 AUTHENTICATE 实测能力（用户看不出为什么没实测）",
        "vowifijs",
        "\t\t\tirows.push(['AUTHENTICATE 实测',",
        "\t\t\tirows.push(['AKA 实测',",
        "前端展示 AUTHENTICATE 实测能力",
    ),
    (
        # 前端：阻断清单少一项，界面就会显示 undefined（测试逐 key 断言覆盖）。
        "前端 BLOCKER_TEXT 少了 epdg_not_published（界面显示 undefined）",
        "vowifijs",
        "\t\t\tepdg_not_published: '运营商未在公网发布 ePDG（这台设备改不了，只能换一张其运营商发布了 ePDG 的卡）',\n",
        "",
        "覆盖了后端阻断项 epdg_not_published",
    ),
    (
        # ★★ 这个变异守的是**守卫本身**：`epdgResultNode` 曾被调用 3 次却从未定义，
        #   语法检查与全部契约测试都放行，只有真机渲染才会炸（而真机前端渲染在本环境
        #   做不了）。现在由 tests/undefined-fn-contract.test.js 静态兜住 —— 这条变异
        #   就是证明它**真能检出**，不是又一个恒绿的摆设。
        "又出现「调用了未定义的函数」（语法合法，只有渲染时才炸）",
        "undeffnjs",
        "\t\trenderVowifi();   /* 出初始态（未评估时不发任何请求） */",
        "\t\trenderVowifi();\n\t\tvar _x = epdgResultNodeGhost({ state: 'x' });",
        "没有「调用了未定义的函数」",
    ),
    (
        # ★ 一旦开放 params，这个登录用户能用的口子就变成「借路由器做任意 DNS 探测」。
        "rpc 声明开放 params（域名由后端拼的口子被打开）",
        "rpcjs2",
        "\tmethod: 'vowifi',\n\tparams: [],",
        "\tmethod: 'vowifi',\n\tparams: ['fqdn'],",
        "rpc 声明不带 params",
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
    (
        # ★★ 2026-09-25 全量审计：这段代码在 10 个页面里各抄过一遍，而它依赖的
        #   REQUIRE_AUTH_KEY **永远不会被抛出**（RPC 模式 connect() 不 reject）。
        #   守卫要防的是「有人照抄老页面把它带回来」，所以变异＝注入死分支。
        "某个页面里加回 REQUIRE_AUTH_KEY 弹窗分支（该错误 RPC 模式下无人抛出）",
        "dialjs",
        "\t\tMt5700.connectThen(function () {\n\t\t\tloadAll();\n\t\t});",
        "\t\tAtWs.client.connect().catch(function (err) {\n"
        "\t\t\tif (err && err.message === 'REQUIRE_AUTH_KEY') {\n"
        "\t\t\t\tUi.promptModal('连接密钥', [{ key: 'key', label: '连接密钥', type: 'password' }], function (v) { });\n"
        "\t\t\t\treturn;\n\t\t\t}\n"
        "\t\t}).then(function () {\n\t\t\tloadAll();\n\t\t});",
        "REQUIRE_AUTH_KEY",
    ),
    (
        # ★ 不等连接成功就跑回调＝没连上就发，必然失败。这条守的是「先等」的语义。
        "connectThen 不再等连接成功就跑回调",
        "corejs",
        "\t\treturn AtWs.client.connect().then(function () {\n"
        "\t\t\tif (typeof onReady === 'function') onReady();\n"
        "\t\t});",
        "\t\tif (typeof onReady === 'function') onReady();\n"
        "\t\treturn AtWs.client.connect();",
        "connectThen",
    ),
    (
        # ★ 后端只回四个字「认证失败」，页面上几十个入口会同时复读，
        #   没有这句翻译用户完全不知道是密钥错了、该去哪儿改。
        "ucode 不再把 -32001 翻成带处置指引的文案（认证失败又只剩四个字）",
        "uc3",
        "\t\t\tif (resp.error.code == RPC_ERR_AUTH_FAILED) {\n"
        "\t\t\t\tmsg = '认证失败：UCI 的 websocket_auth_key 与后端不一致，请到「服务配置」核对';\n"
        "\t\t\t}\n",
        "",
        "-32001",
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
