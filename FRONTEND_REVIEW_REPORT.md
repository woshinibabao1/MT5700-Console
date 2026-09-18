# 全仓代码系统性审查报告（前端 + 后端）

- **仓库**：`woshinibabao1/MT5700-Console`（本地 `D:\AI空间\MT5700`）
- **第一轮**：2026-09-17，基线 `main @ 12506c1`（版本 2.0.7），已修复 5 项（F1–F5）
- **第二轮（增量）**：2026-09-18，基线 `main @ 26f6507`（版本 2.1.4），已修复 7 项（R1–R7）、新增 4 条待决项（H23–H26）
- **行号**：未注明轮次的条目以第一轮基线为准；R/H23+ 条目见各自小节标注的位置
- **审查范围**：**全部代码**，共 71 个文件 / 30,109 行
  - 前端 JS 16,178 行（11 个视图 + 6 个共享模块 + 1 个 CSS）
  - Rust 后端 5,739 行（`src/rust/src/*.rs` 14 个文件）
  - Shell / 系统集成 987 行（watchdog、init.d、hotplug、rpcd ucode、ACL）
  - 测试 3,968 行（21 个测试文件）+ 构建脚本与 CI
- **方法**（agent-council 四角色会审）：
  1. **四路并行分诊**：视图层 / 共享模块+CSS / Rust 后端+系统集成 / 测试+构建工程，
     各自只读取证并写入独立草稿（`.workbuddy/tmp/council/scan-*.md`），共 55 条；
  2. **Proposer 汇总去重** → 36 条并定级；
  3. **Reviewer 逐条复核 P0、查误报、查红线冲突**（推翻 1 条定级、校正 2 处证据、补 5 条漏项）；
  4. **主控亲自复核**：每条拟修改项都打开源码核对行号与前提，并实跑验证，子代理结论不直接采信。
- **红线（全程遵守）**：未向真机下发任何 AT 指令、未连接 `192.168.10.1`、未占用 `/dev/ttyUSB1`、
  未触碰 PIN；所有测试均为静态断言或本地沙箱执行。

> **行号说明**：报告中的行号以基线 `12506c1` 为准。本轮已修改的文件行号会偏移，
> 已修项在「第零节」标注了对应提交，请以提交内容为准。

---

## 零、本轮已修复并验证（5 项，均已提交）

| # | 等级 | 问题 | 位置（基线行号） | 提交 |
|---|---|---|---|---|
| F1 | **高** | watchdog 的 `nc -w 5` 让**所有 AT 复位指令从未真正下发** | `root/usr/share/mt5700/watchdog.sh:290,292` | `3a49f99` |
| F2 | 中 | `isErrorText` 把应答正文里的 "error" 判成命令失败 | `htdocs/.../at-webserver/rpc.js:264-268` | `8508417` |
| F3 | 中 | `+CLCK` 正则失配 → **PIN 锁只能启用、永远关不掉** | `htdocs/.../view/at-webserver/modem_settings.js:340` | `8534173` |
| F4 | 中 | 升级页密钥错误只报错不弹框 → **升级页永久锁死**；FOTA 进度查询缺 catch | `htdocs/.../view/at-webserver/upgrade.js:569-577`、`447-462` | `78479af` |
| F5 | 中 | `ok(..., true)` **字面量恒真**的假断言（看着有覆盖其实零覆盖） | `tests/dial-contract.test.js:159` | `07223e0` |

### 第二轮（2026-09-18，基线 `26f6507`，版本 2.1.4 → 2.2.0）已修复并验证（7 项）

| # | 等级 | 问题 | 位置 | 提交 |
|---|---|---|---|---|
| R1 | **高** | **短信存储位置「配置无法保存」**：界面给了本机不支持的 `MT` 选项，且下拉框从不回写模组当前值，保存成功也看着像没保存 | `view/at-webserver/sms_settings.js:112-126`、`335-351` | `d6ef8ed` |
| R2 | **高** | eSIM 下载第一步就死：`pickTagValue` 遇到构造 tag（`BF2E`）整段跳过，取不到里面的挑战值 → 抛 `EUICC_TLV_TRUNCATED` | `at-webserver/euicc.js` `pickTagValue` | `5eea613` |
| R3 | 中 | eSIM 下载里**嵌套** `withIsdrSession` → 再开一条逻辑通道（ISD-R 已被外层选中，卡上通常只有 1~3 条通道） | `euicc.js` `downloadProfile` 步骤 ⑨ | `5eea613` |
| R4 | 中 | `hexToBase64('')` 抛 `EUICC_BAD_HEX`：空串代表零字节，不该判非法 | `euicc.js` | `5eea613` |
| R5 | 中 | 「处理待发回执」按钮**必然失败**：它拿不到 host，而目标地址其实写在通知里（`BF2F` 的 `0C`） | `euicc.js` / `view/.../esim.js` | `5eea613` |
| R6 | **中（安全）** | ES9+ 转发的临时文件名**可预测**（`/tmp/mt5700-es9p-<tag>-<秒>.tmp`），`/tmp` 是 1777 → 本地用户可预先放符号链接，让 `fs.open`/`curl -o` 以 root 覆盖任意文件。改用 `mktemp`（`O_EXCL` + 0600） | `root/usr/share/rpcd/ucode/mt5700.uc` | 本轮 |
| R7 | 低 | 连接状态三张表重复展示同一地址（实测 CID 1 与 `AT^DHCP` 都是 `10.117.101.195`），CID / 来源两列无信息量 | `view/at-webserver/network_status.js` | `9f946f2` |

**R1 的真机取证**（这是本轮唯一上机实测的项，Hiveton H5000M / MT5700M，经 8765 RPC）：

```
AT+CPMS?              → +CPMS: "ME",4,300,"ME",4,300,"ME",4,300
AT+CPMS=?             → +CPMS: ("SM","ME"),("SM","ME"),("SM","ME")     ← 根本没有 MT
AT+CPMS="SM","SM","SM"→ +CPMS: 10,50,10,50,10,50  OK                    ← 界面选项可写
AT+CPMS="MT","MT","MT"→ ERROR（success=false）                          ← 复现用户现象
AT+CPMS="ME","ME","ME"→ +CPMS: 4,300,...  OK                            ← 已恢复原值
```

**新增守卫测试**（共 +155 项断言，全部通过）：

| 测试文件 | 项数 | 钉住什么 |
|---|---|---|
| `tests/euicc-download-contract.test.js`（新） | 76 | SHA-256 标准向量、base64 往返、域名白名单（SSRF 面）、激活码正反例、TLV 长/短格式、分块可原样拼回、ES9+ 五个端点、下载全流程（成功 + 4 类失败路径）、回执按通知自带地址发、**全程只开一次逻辑通道** |
| `tests/connection-quality-contract.test.js`（新） | 79 | 三表合并后的解析 / 地址去重 / 均速与波动 / 丢包增量 / 页面接线 |
| `tests/euicc-contract.test.js`（扩充） | 63 | 错误码集合双向全等（含新增 `EUICC_NO_ES9P` / `EUICC_ES9P_FAILED`） |

**验证**：`node tests/run-all.js` → 全部测试文件通过（30 个文件 + 语法检查，19 个 JS 零语法错误）；
`ucode -c` 在真机上校验 `mt5700.uc` → `SYNTAX_OK`。

**新增/扩充的守卫测试**（共 +38 项断言，全部通过）：

| 测试文件 | 项数 | 钉住什么 |
|---|---|---|
| `tests/watchdog-nc-contract.test.js`（新） | 6 | watchdog 的 `nc` 不得带 `-w`、必须被 `timeout` 包裹、无 nc 时 return 1 |
| `tests/at-error-text-contract.test.js`（新） | 16 | 真实载入 `isErrorText` 跑 12 条样本：正文含 error 不误判、6 类真错误必识别 |
| `tests/clck-parse-contract.test.js`（新） | 12 | 从源码**取出真实正则**跑 6 条样本 + 静态约束 |
| `tests/upgrade-poll.test.js`（扩充） | +4 | 密钥必须弹框、`AT^FOTADLQ` 必须有 catch |
| `tests/dial-contract.test.js`（改造） | +1 真实 | 恒真断言换成「CGACT 报 0 → active === false」 |

**验证方式**：`node tests/run-all.js` → **全部测试文件通过**（21 个文件 + 语法检查）；
`tests/syntax-check.js` → 17 个 JS 文件语法错误 0 个。
F5 额外做了**变异测试**：把新断言的 `=== false` 改成 `=== null` 后退出码为 1，
证明它真的在起作用，不是又一条恒真。

---

## 一、结论摘要

| 类别 | 数量 | 处置 |
|---|---|---|
| 已修复并验证（第一轮 F1–F5） | 5 | 见第零节 |
| 已修复并验证（第二轮 R1–R7） | 7 | 见第零节 |
| **需人工决策 / 高风险（未改动）** | **26** | 见第二节 H1–H26 |
| 确认误报（不改） | 1 | 见第三节 |
| 定级被下调 | 1 | 见第四节 |

**总体评价**：

- **XSS 面是干净的** —— 全仓库 `innerHTML` 仅用于 `= ''` 清空，渲染一律走 `E()` / `textContent`；
  无 `outerHTML` / `insertAdjacentHTML` / `document.write`；生产代码无 `eval` / `new Function`。
- **最贵的一类风险不是 XSS，是「独占资源的并发与破坏性命令」**：串口由 Rust 服务独占，
  任何一次「幽灵命令 / 重复下发 / 射频关了没恢复」的代价都是用户断网，且日志里查不到报错。
  （H1、H6、H14 都属这一类。）
- **唯一一条真实的安全提权链**是 H2（rpcd ACL）—— 但要说清楚：本应用**本来**就通过
  `write.ubus.mt5700: ["at"]` 授权调用方执行任意 AT（含 `AT+CFUN=` / `AT^RESET`），
  H2 描述的是「**从 AT 权限再往上到 root shell / 对外监听**」，不是从无到有的提权。

---

## 二、需人工决策 / 高风险项（未改动代码）

### H1 · 关闭「短信功能」会下发 `AT+CFUN=0` + `AT+CMGD=1,4`，且无自恢复 —— 一次误点即断网并清空全部短信

- **分类**：缺陷（破坏性命令） · **等级**：**严重**
- **位置**：`htdocs/.../view/at-webserver/sms_settings.js:253-266`（`CFUN=0` 在 264、`CMGD=1,4` 在 265；链尾 282-283 直接提示成功）
- **触发条件**：开关初值由 `loadIMS()`（303-310）按 `AT^IMSSWITCH?` 回填 —— IMS 开着就显示「短信开」，
  用户随手一拨即走这条破坏链。
- **影响范围**：`AT+CFUN=0` 关射频（**断网**）；`AT+CMGD=1,4` 删全部短信（**不可恢复**）。链尾没有 `AT+CFUN=1`。
- **建议方案**（三选一，**需你拍产品语义**）：
  - **A**：链尾补 `['AT+CFUN=1', 2000, '恢复射频']`，并把 `CMGD` 摘到已有二次确认的「清空全部短信」按钮。
    副作用：新增一条 `AT+CFUN=1` 下发（行为变更）；「关短信顺带清短信」这个既有语义消失。
  - **B**：只摘 `CMGD`，保留 `CFUN=0` —— **不推荐**，断网这个主伤害还在。
  - **C（会审推荐）**：把 `AT+CFUN=0` 与 `AT+CMGD=1,4` **一起从关闭链摘掉**，只留 `AT+CEUS=0` + `AT^IMSSWITCH=0,0,0`。
    关短信**没有必须关自身射频的物理需求**（不像飞行模式），删掉 CFUN=0 比事后补 CFUN=1 更彻底，
    也没有「先断后恢复」的窗口，且不新增任何 AT。
- **验证方法**：真机上先记录 IMS 状态 → 关闭开关 → 确认（a）仍能上网（b）短信仍在（c）`AT^IMSSWITCH?` 已变 0。
  静态侧：新增契约测试断言关闭链数组里不得出现 `CFUN=0` / `CMGD=1,4`。
- **手册参考**：3GPP TS 27.007 §7.9（`+CFUN`）、§3.5.4（`+CMGD` del=4 含义）；
  《MT5700M-CN AT 命令手册》第 12 章（本地知识库 `~/.workbuddy/skills/mt5700-at-commands`）。
- **说明**：**不加确认弹窗**这条你已裁定，本报告不再讨论。

### H2 · rpcd ACL 授权面过宽：可从 AT 权限升级到 root shell / 对外监听

- **分类**：安全 · **等级**：**严重**
- **位置**：`root/usr/share/rpcd/acl.d/luci-app-mt5700.json`
  - `5-8`：read.uci 含 `at-webserver` → 可读到 `root/etc/config/at-webserver:24` 的 `websocket_auth_key`
    （`44-47` 的 read.file 也可直接读该文件）
  - `125`：write.file 给 `/etc/init.d/at-webserver` 的 `exec`
  - `119-123`：write.file 给 `/etc/config/firewall`（配合 `95-101` 的 `service set/restart`、`102-111` 的 `uci commit/apply`）
  - 配合 `root/usr/share/mt5700/watchdog.sh:342-350,381`（`run_sh_cmd` → `/bin/sh -c "$1"`，命令取自 UCI `watch_reset_cmds`）
- **触发条件**：任何持有该 ACL 的 LuCI 会话被劫持，或任何能写 UCI `at-webserver` 包的调用方。
- **影响范围**：读走 8765 访问密钥；经 `watch_reset_cmds` 以 root 执行任意命令；
  **且存在第二条更稳的链**：写一条 firewall rule 把 8765 暴露到 WAN → `ubus call service restart firewall`
  （这条绕开了「新版 rpcd 是否还支持 `file.exec`」的版本不确定性）。
- **建议方案**（需决策粒度）：① `exec` 是否直接删（**先查「重启服务」按钮的调用点是否依赖它**）；
  ② firewall 写权限是否一并收掉；③ `websocket_auth_key` 是留在 UCI（接受本 ACL 可读）还是移到 0600 文件。
- **验证方法**：**必须真机/容器实测**——起一个受限会话，实测 `ubus call file exec` 与
  `ubus call uci set ...firewall` 是否被拒。仅 `grep -c '"exec"' acl.json` 是**伪劣验证**：
  改完必然为 0，只证明你删了那行，不证明威胁消失（firewall 那条还在）。
- **手册参考**：OpenWrt rpcd ACL 文档（ubus/uci/file 三段权限模型）；`ubus` 官方 wiki。

### H3 · 改「拨号方式」会悄悄把 `settings.enable` 写成 1，与「请先关闭自动拨号」的提示自相矛盾

- **分类**：缺陷 · **等级**：高
- **位置**：`htdocs/.../view/at-webserver/dial.js:472-481`（473 拦截、475 下发、477 夹带）
- **影响**：用户只是想改拨号方式，结果自动拨号被打开。
- **建议方案**：`AT^SETAUTODIAL=` 第一个参数用 `(settings.enable != null ? settings.enable : 0)`；
  成功回调只更新 `settings.dialMode`，不碰 `enable`。
- **⚠ 前置条件**：**必须先核对模组手册，确认 `AT^SETAUTODIAL` 第 1 个参数允许为 0**。
  在确认前不要改 —— 否则可能把「悄悄开自动拨号」变成「完全改不动」。
- **手册参考**：《MT5700M-CN AT 命令手册》16.18（`^SETAUTODIAL`），举例即 `AT^SETAUTODIAL=1,0`（第 1 位为 enable）。
  **手册语法里写作 `^SETAUTODAIL:`（少一个 I），举例却是 `SETAUTODIAL:`** —— 以举例为准（本仓 `dial.js` 已兼容两种拼写，有测试钉住）。

### H4 · `panic = "abort"` 配名为 `safe_*` 却无 `catch_unwind` 的空壳包装

- **分类**：缺陷/架构 · **等级**：高
- **位置**：`src/rust/Cargo.toml:22`；`src/rust/src/schedule.rs:176-178`；`src/rust/src/urc.rs:100-102`
- **触发条件**：任何 panic（unwrap / 越界 / 锁中毒）→ `abort()` → 守护进程直接死；procd respawn 攒满阈值后**永久放弃拉起**。
- **建议方案**：**不能只改 Cargo.toml 一行** —— 改成 `unwind` 只是不再调 `abort()`，但 `safe_tick` 里没有
  `catch_unwind`，panic 会沿 tokio task 往上冒，主流程仍在 join 上等，进程多半还是会退出。
  要做得三件一起：真正的 `catch_unwind` 包层 + 失败后的重启/退避策略 + procd `respawn` 阈值放宽。
- **需要你拍的是**：**要不要为守护进程引入重启治理**这个架构选择，以及瘦身版 ABI 能否接受 unwind 的体积代价。
- **验证方法**：注入一个必 panic 的分支，确认进程存活且后续 tick 继续（本地 `cargo test` 可覆盖 `catch_unwind` 本身）。
- **手册参考**：Rust Reference「panic runtime / abort vs unwind」；`std::panic::catch_unwind` 文档；
  procd `respawn` 参数（OpenWrt procd 文档）。

### H5 · 8765 默认空密钥即跳过认证；`allow_insecure=1` 可一键变 0.0.0.0 无认证监听

- **分类**：安全 · **等级**：高
- **位置**：`src/rust/src/config.rs:316-341`；`src/rust/src/rpcserver.rs:318-322`；`root/etc/config/at-webserver:22-24`
- **现状（会审核实过，别夸大）**：默认绑 **127.0.0.1**（不是 0.0.0.0），且有「对外 + 无密钥 → 回退回环」兜底；
  `auth_key` 出厂为空时直接跳过校验，仅靠回环与 rpcd 会话保护；密钥在 TCP 上明文传输。
- **建议方案**：非回环监听（bind ≠ 127.0.0.1 或 `allow_wan` / `allow_insecure`）时**强制要求 auth_key 非空**，
  否则拒绝启动；`allow_insecure` 启动时打 error 级日志。
- **需你拍**：是否接受「对外监听必须先配密钥」这个启动期硬约束（会影响现有部署流程）。
- **手册参考**：RFC 6335 / 端口绑定惯例；OpenWrt UCI 配置文档。

### H6 · 三处飞行模式切换只有 1/3 有串行守卫，交错执行可能把设备留在射频关闭态

- **分类**：缺陷 · **等级**：高
- **位置**：`htdocs/.../view/at-webserver/network_settings.js:246`（有 busy 标志）、`439`、`749`（裸奔）
- **触发条件**：两处流程交错（例如一个正在等 `CFUN=0` 生效，另一个已经开始跑自己的恢复逻辑）。
- **影响**：**设备被留在 `CFUN=0`**，只能重启模组恢复 —— 本仓最贵的一类故障。
- **建议方案**：三处收敛到同一串行队列；恢复射频前判断「是否还有别的流程在等射频关闭」。
- **需你拍**：统一互斥与恢复语义（谁负责最终 `CFUN=1`）。
- **手册参考**：3GPP TS 27.007 §7.9。

### H7 · Windows/无 `sh` 环境下 `watchdog-routing.test.sh` 被静默跳过，仍打印 PASS

- **分类**：测试质量 · **等级**：高
- **位置**：`tests/watchdog-routing.test.js:189-200`（probe 失败只 log，不碰 fail 计数）→ 落到 `203-205` 打印 PASS 并 `exit(0)`
- **实测**：本机（Windows，无可用 `sh`）约 40 条行为断言**一条都不跑**，run-all 依然显示 PASS。
- **建议方案**：skip 计为 fail（或至少独立退出码 + 汇总 WARN），并在 CI 补一条必跑 `.sh` 的 Linux job。
- **需你拍**：要「CI 严格 + 本地严格」还是「CI 严格 + 本地 WARN」—— 前者会让每个 Windows 开发者的 run-all 永久变红。

### H8 · CI 只跑 `cargo check --all-targets`，4 个 `#[cfg(test)]` 模块从未被执行

- **分类**：工程 · **等级**：高
- **位置**：`.github/workflows/build-openwrt.yml:44-46`；对照 `src/rust/src/atclient.rs:827`、`pdu.rs:256`、`urc.rs:677`、`smsclean.rs:198`
- **本轮为什么没直接改**：本机**没有 cargo**，无法验证 `cargo test` 是否全绿；
  在无法验证的前提下改 CI 属于「可能把绿灯改成红灯」的负优化，故只出报告。
- **建议方案**：改为 `cargo test --all-targets`（含 check），或 check 之后追加一条 test step。
- **验证方法**：CI 日志出现 `running N tests` / `test result: ok`；本地有工具链时 `cd src/rust && cargo test --all-targets`。

### H9 · 短信全文与号码明文落 localStorage，且写入口三份重复、无 TTL

- **分类**：安全/架构 · **等级**：中
- **位置**：`htdocs/.../view/at-webserver/sms_center.js:112-122,658`；`sms_settings.js:224-230`；
  `parse.js:800-824`（`saveSentMessageToCache` **零调用点**，死代码）
- **建议方案**：技术侧（收敛写入口 / 容量降到 200 并加 TTL / 配额失败要提示）可立刻做；
  **默认策略（是否「退出即清」）是产品决策**。
- **手册参考**：MDN `Window.localStorage`（同源持久、无过期机制，不适合存敏感明文）。

### H10 · 短信列表四条刷新路径并发互覆盖

- **分类**：缺陷 · **等级**：中
- **位置**：`htdocs/.../view/at-webserver/sms_center.js:338-355,786-813,328-336`
- **影响**：新短信到达 / 发送后 / 删除后 / 分段补齐四条路径并发，后回来的覆盖先回来的 →
  「弹了提示，列表里却没有」。
- **建议方案**：`refresh()` 加 in-flight 守卫（撞车排队重跑）；`newSmsHandler` 标 dirty 后触发 refresh，不自行 merge。
- **需你拍**：未读语义（标脏期间的新短信要不要算已读）。

### H11 · `Mt5700.*` 与 `Ui.*` 两套组件库 + 两套 CSS 体系 + 两套定时器清理机制

- **分类**：架构 · **等级**：中（但影响面最大）
- **位置**：`mt5700.js` / `ui.js` 全文；`mt5700.css:1-2004` vs `2005-2692`；清理见 `mt5700.js:105,679` vs `ui.js:449-489`
- **建议方案**：确立 `Ui.*` + `.at-*` 为唯一体系，`Mt5700` 只留 gauge / lineChart / staged。
- **本轮不改**：涉及 11 个视图文件全量回归，且 `.mt5700-switch` 是全站全局组件，收益远小于风险。等独立重构窗口。

### H12 · 跨文件复制粘贴的 N 份实现，且**已经出现改漏**

- **分类**：架构 · **等级**：中
- **位置**：连接密钥样板 8 份（`dial.js:670-683`、`modem_settings.js:1039-1050`、`sms_center.js:829-841`、
  `sms_settings.js:378-389`、`network_settings.js:790-804`、`schedule.js:366-381`、`terminal.js:210-221`、
  `upgrade.js:569-577`）；开关工厂 4 份；锁频条目编辑器 2 份；信号百分比 2 套（`mt5700.js:184` vs `rpc.js:690`）；
  `sleep_ctx` 2 份（`atclient.rs:815` / `schedule.rs:711`）
- **已发生的改漏**：`upgrade.js` 那份退化成只报错不弹框（即本轮 F4）。
- **建议方案**：抽 `AtWs.connectWithAuth()` / `Mt5700.switch()` / `Mt5700.lockItemEditor()` /
  `AtWs.calculateSignalPercent()`，并加静态契约测试钉住「不得再新增第 9 份样板」。
- **注意**：要改就**一次改齐 8 处**，只改一处会破坏全局一致性。

### H13 · 禁用时段的 LTE/NR 字段跳过校验却照样落盘

- **分类**：缺陷 · **等级**：中
- **位置**：`src/rust/src/schedconfig.rs:268-274`（validate 跳过）、`293-302`（uci_entries 全量写）
- **影响**：`enabled=false` 的时段里是脏值，启用后直接进 `AT^LTEFREQLOCK`。
- **建议方案**：validate 与落盘范围对齐（要么校验全部时段，要么只落盘已启用时段）。

### H14 · 并发三件套：无 single-flight、事件轮询无锁且 seq 可回退、超时不取消底层命令

- **分类**：缺陷 · **等级**：中（叠加后可达高）
- **位置**：`rpc.js:410-452`（缓存无 in-flight 去重）、`rpc.js:156-207`（1.5s 轮询 vs 6s 超时，无锁）、
  `rpc.js:51-58`（`withTimeout` 只 reject 前端 Promise，底层命令照跑）
- **影响**：并发的同一读命令全部穿透（串行发 N 次往返）；后发先回把 `eventSeq` 回退覆盖；
  超时后重试 = **幽灵命令**（重复发短信 / 锁频重复生效）。
- **建议方案**：① 加 `_inflight[key]` 复用 Promise；② 轮询加 `_polling` 布尔锁且 `if (seq > self.eventSeq)` 才赋值；
  ③ `.finally(clearTimeout)`，重试仅对「确证为 ERROR 行」生效（依赖 F2 已修的 `isErrorText`）。
- **需你拍**：③ 改变重试语义，可能影响现有超时表现。

### H15 · 信号百分比两套口径（-120 起点 vs -110 起点）

- **分类**：缺陷 · **等级**：中
- **位置**：`mt5700.js:184-187` vs `rpc.js:690-694`；调用点 `network_settings.js:679`、`network_status.js:949`
- **影响**：同一 RSRP 两处显示 20% / 0%。
- **需你拍**：哪个口径对，保留一份。

### H16 · 频带掩码用 `parseInt(hex)` + Number 运算（≥2^53 低位被吞）；`nrArfcnToMHz` 缺 FR2 段

- **分类**：缺陷 · **等级**：中
- **位置**：`htdocs/.../at-webserver/parse.js:256-292`（掩码）、`parse.js:1079-1083`（ARFCN）
- **影响**：`7FFFFFFFFFFFFF` 只解出 B56；毫米波频段算错最高 59 GHz。
- **建议方案**：掩码改 BigInt（或按 hex 字符串从低位逐字符取 bit）；ARFCN 补
  `2016667~3279165 → 24250.08 + (n-2016667)*0.06`，以上 `+(n-3279165)*0.12`。
- **手册参考**：**3GPP TS 38.104 Table 5.4.2.1-1**（NR-ARFCN 的 FR1/FR2 分段与偏移量）；
  3GPP TS 38.101-2（FR2 频段范围）。

### H17 · 「认证密钥」输入框唯独这一处 `type:'text'` 明文显示

- **分类**：安全 · **等级**：中
- **位置**：`htdocs/.../view/at-webserver/service.js:310-311`
- **建议方案**：改 `Mt5700.input('password', ...)` 并加显示/隐藏切换，与另外 7 处对齐。

### H18 · README 版本号滞后 4 个版本（8 处仍是 2.0.3），且无守卫

- **分类**：工程 · **等级**：低（会审已将其从 P1 下调）
- **位置**：`README.md:15,95,101,234,293,333,334,339`；对照 `Makefile:21`
- **建议方案**：让 `tools/bump-version.py` 顺带同步 README，或在 `tests/version-consistency.test.js` 加一条静态断言。

### H19 · 测试工程杂物（6 小项）

- **分类**：工程 · **等级**：低—中
- **位置**：`tests/mock-modem/run-e2e.sh:14-17`（硬编码 `/home/user`）、`.gitignore:5-6`（`tests/mock-modem/uci` 符号链接产物）、
  `tests/run-all.js:43-45`（计数正则覆盖不全，7 个文件显示 `-`）、
  `tests/mock-modem/e2e-test.js:92,210`（两处 `check(..., true)` 恒真，但该文件**被 run-all 有意排除**，不污染 CI）、
  `tests/sms-concurrency-contract.test.js:211`、`tests/render-refresh-contract.test.js:124-126`（断言正则过宽/带尾逗号致漏判）、
  `tests/watchdog-routing.test.sh:64`（用 sed 按行抽函数，脆弱）、
  `scripts/sdk-build.sh:212,228-238`（「内含后端」校验在 apk 上退化为体积判定）
- **建议方案**：逐条小改；其中**统一 `tests/_harness.js` 的 `report(pass, fail)`** 是根治手段 ——
  目前各文件断言助手签名不统一（`ok(name,cond)` / `ok(cond,name)` / `ok(name)` 三种并存），
  「写错一次参数顺序就得到一个恒真断言」必然会再发生（F5 就是这么来的）。

### H20 · 后端工程杂物

- **分类**：工程 · **等级**：低—中
- **位置**：`rpcserver.rs:227-247`（无连接数上限与 idle timeout）、`main.rs:197-205,219`（RPC bind 失败仍 exit 0）、
  `main.rs:149`（启动日志硬编码 `127.0.0.1`）、`schedule.rs:443,466`（重复打同一条日志）、
  `root/etc/hotplug.d/net/99-mt5700-renew:17`（硬编码 eth2，与 UCI `watch_device` 不一致）、
  `atclient.rs:815` 与 `schedule.rs:711`（`sleep_ctx` 两份同名实现）、
  `rpcserver.rs:694-703`（扫频流式回调 `try_lock` 抢不到就**静默丢小区**）
- **建议方案**：逐条小改；扫频那条建议改无锁计数 + 丢行打点（丢小区会让邻区列表缺项，且没有任何日志）。

### H21 · UCI 并发写竞态

- **分类**：缺陷 · **等级**：中
- **位置**：`root/etc/init.d/at-webserver:25,378`（无条件 commit）；`src/rust/src/schedconfig.rs:313-328`（31 次 set 的长 staging 窗口）
- **建议方案**：改 `uci batch` 一次提交；init.d 的 start/reload 不再 commit `at-webserver`。

### H22 · `getAMBR` 用 `throw 'done'` 控流 + 成功路径清 `activeCid`；`state.operator` 取了从不渲染

- **分类**：缺陷/性能 · **等级**：低—中
- **位置**：`htdocs/.../view/at-webserver/network_status.js:773-822`（getAMBR）、`763-771,106`（operator）
- **影响**：真实异常被当「未找到」吞掉；成功反而清缓存导致下一轮必重新查；
  `AT^EONS=2` 每 30s 白打一次（结果从不渲染）。
- **建议方案**：改 `{ok:true}` 哨兵；成功分支保留 `activeCid`；运营商要么补显示（挪到 60s 档）要么连函数一起删。

---

### H23 · 固件下载只接受 `http://` 明文，且**没有校验和 / 签名校验**

- **分类**：安全（传输 + 完整性） · **等级**：**高**（取决于模组能力，需人工确认）
- **位置**：`htdocs/luci-static/resources/view/at-webserver/upgrade.js:513`（`if (url.indexOf('http://') !== 0) { 报错 }`）、`:551`（`AT^FOTAOEMDL="<url>"`）
- **触发条件**：用户在升级页填写固件地址；地址由模组自己去下载。
- **影响**：同一广播域内的攻击者可劫持下载（ARP/DNS 欺骗）替换固件镜像；链路无任何
  完整性校验，装的是不是运营商那份无从判断。路由器最终跑什么固件完全取决于这一跳。
- **为什么不直接改成 https**：需要先确认 `AT^FOTAOEMDL` 是否支持 `https://`。
  手册未查到明确说明，本机也没有可用于验证的 FOTA 地址。**建议先上机试一条 https URL**，
  若模组支持就把白名单收紧为 https only；若不支持，至少要在界面上明示「明文下载、无校验」，
  并让用户自己承担。
- **验证方法**：`AT^FOTAOEMDL="https://..."` 看返回 OK 还是 ERROR；再用 `AT^FOTASTATE?` 看是否进 11/13。

### H24 · 18 处 `.catch(function () {})` 空吞异常，其中 3 处会把失败伪装成「没变化」

- **分类**：可维护性 / 缺陷 · **等级**：**中**
- **位置**：`upgrade.js:477`（`AT^FOTADL=1` 续传失败）、`sms_settings.js:372/423`、
  `schedule.js:375/391`、`modem_settings.js:755/783/884/976/985`、`network_settings.js:280/455/764`、
  `network_status.js:1169`、`sms_center.js:309`、`rpc.js:168`、`ui.js:238`
- **影响**：多数是为了「单项失败不打断整页」，这个意图合理；但**没有任何一处留下痕迹**，
  真出问题时日志里一片空白。其中 `upgrade.js:477` 最值得警惕：续传命令失败被静默吞掉，
  界面会一直停在 31（挂起），用户只能干等。
- **建议**：统一成一个 `quietFail(label)` 小工具，至少 `console.warn` 一行；
  `upgrade.js:477` 那种有实际后果的应该把失败次数计出来，超过阈值就提示用户。

### H25 · `Parse.parseFastdorm` 已成死代码

- **分类**：可维护性 · **等级**：**低**
- **位置**：`htdocs/luci-static/resources/at-webserver/parse.js:180-198`
- **背景**：R7 把「空口健康」卡换成「连接质量」时去掉了 `^FASTDORM` 查询（它只是复述一个
  用户改不了也无需改的模组开关，每轮白搭一次串口往返）。解析器随之没有调用方了。
- **建议**：删掉 `parseFastdorm` 及其测试引用；若日后要恢复「快速休眠」展示，
  直接从 git 历史取回即可。

### H26 · `serial_linux.rs:207-208` 两处 `.expect()` 可 panic

- **分类**：缺陷（健壮性） · **等级**：**低**
- **位置**：`src/rust/src/serial_linux.rs:207`（`self.reader.take().expect("SerialTransport reader missing")`）、`:208`
- **触发条件**：`reader` / `writer` 已被取走时再次调用。属内部不变量，正常流程不会触发。
- **影响**：一旦触发就是 `panic` —— 而 `Cargo.toml` 里配的是 `panic = "abort"`，
  服务直接退出、`/dev/ttyUSB1` 释放，前端所有页面一起失去响应（靠 watchdog 拉起）。
- **建议**：改成返回 `Err(...)`，让调用方决定；顺带说明为何此处不变量成立。
- **注**：`pdu.rs` / `urc.rs` / `atclient.rs:991-1020` 里的 `unwrap`/`expect` 都在
  `#[cfg(test)]` 内，不算风险；但这也意味着 CI 只跑 `cargo check` 时它们从未真正执行（见 H8）。

---

## 三、确认误报（不改）

| 项 | 结论 |
|---|---|
| 「短信两步下发：第二步被 `st.running` 挡回」（`rpcserver.rs:448-459,489-494`） | **误报**。前端是**单步**下发：`smsEncode.js:291` 的 `DATA_SEP = '\r'` 把命令与 PDU 拼成**一条**字符串（`smsEncode.js:357,363`），`sms_center.js:604` 只调一次 `submitSms`；且 `atclient.rs:702-708` 已处理 `"> "` 提示符不 notify。不存在「第二步被挡」的场景，改它反而会破坏现有的单步 + `SMS_ACCEPTED` 轮询流程。 |

---

## 四、定级被下调的项

| 项 | 原定级 | 下调后 | 理由 |
|---|---|---|---|
| `isErrorText` 假阳性（F2） | P0 | **P1（已作为便宜修复实施）** | 内核属实，但会审**证伪了两处放大说辞**：① `AT+CMGL=4` 不满足 `isRetryableRead` 任何判据（`rpc.js:252-261`），`maxAttempts=1`，**不存在「重试 3 次」**；② 触发需处于 Text 模式（CMGF=1），而本仓在 `atclient.rs:310-313`、`smsclean.rs:127`、`sms_settings.js:336`、`sms_center.js:541,544,584` **全程强锁 PDU 模式**，PDU 下正文是十六进制、不含英文单词。所以它**不是「每次刷新都会中」**，负担不了 P0 权重 —— 但改窄是严格更优，已实施。 |

---

## 五、与上一轮报告（2026-09-16，仅前端）的对照

| 上轮编号 | 问题 | 本轮状态 |
|---|---|---|
| R1 | 关闭短信功能无确认弹窗（CFUN=0 + CMGD） | **维持你的决定不加弹窗**；缓解方案转为 H1 待你选 A/B/C |
| R2 | rpcd ACL 的 read 段可泄 `websocket_auth_key` | **仍未修**，本轮升级为 H2，并补出第二条更稳的提权链（firewall + service restart） |
| R3 | `+CLCK` 正则失配，PIN 锁只能启用无法关闭 | **本轮已修**（F3），用的是正则兼容两种应答格式 + 行锚定，**未向真机下发任何 AT** |
| M2/M3/M4 | 定时器生命周期三套方案 | 已收敛（本轮未发现新增泄漏；`api.interval` 的 scopeEl 机制有效） |
| M12/M13 | CSS 死规则与主题耦合 | 仍未处理，并入 H11（两套 CSS 体系）统一考虑 |

---

## 六、手册与技术依据索引

| 依据 | 用于 |
|---|---|
| 3GPP TS 27.007 §7.9 / §3.5.4 | `+CFUN` / `+CMGD` / `+CLCK` / `+CME ERROR` 语义（H1、H6、F3） |
| 3GPP TS 23.040 | 短信 PDU 编解码（F2 相关路径；`pdu.rs` / `smsEncode.js`） |
| 3GPP TS 38.104 Table 5.4.2.1-1 | NR-ARFCN 的 FR1/FR2 分段（H16） |
| 《MT5700M-CN AT 命令手册》16.18 | `AT^SETAUTODIAL` 参数与拼写差异（H3） |
| BusyBox `nc` 用法（v1.38 精简版无 `-w`） | F1（并在 CHANGELOG:1276、`mt5700.uc:324` 有本机实测记录） |
| MDN `String.prototype.match` / `Promise` / `localStorage` | F2、F3、F4、H9 |
| Rust Reference（panic runtime）+ `std::panic::catch_unwind` | H4 |
| OpenWrt rpcd ACL / procd respawn / UCI 文档 | H2、H4、H21 |

---

## 七、未验证声明（诚实边界）

本报告的**已修项**全部经过本机实跑验证（21 个测试文件全绿 + 语法检查 0 错误 + F5 变异测试）。
但以下**没有**验证，请勿据本报告认为它们已安全：

1. **第一轮没有一项经过真机验证** —— 红线禁止当轮连设备/发 AT。H1、H6、H13、H20 涉及真实下发行为，
   上线前必须在真机上按各自「验证方法」跑一遍。
   第二轮**只有 R1 上了真机**（`AT+CPMS` 系列，只读查询 + 可回滚的写入，见第零节取证），
   其余仍为静态分析 + 本地测试。
2. **Rust 侧没有本地编译验证** —— 本机无 cargo，H4、H8、H13、H20、H21、H26 均为静态分析结论。
3. **H2 的安全结论未做实测** —— 需要在容器/真机起受限会话验证，见「验证方法」。
4. **eSIM 下载链路（第二轮新增）没有真 eUICC 可跑** —— 本机是普通 USIM
   （`SELECT ISD-R` 返回 `6A82`），因此 `downloadProfile` 的十步流程只有 mock 级验证：
   协议骨架、APDU 分块、失败路径都钉住了，但**真实 SM-DP+ 的字段名与卡侧状态字未经实测**。
   已知不确定点：① `EUICCInfo1` 是否要带 `BF20` 头一起 base64 给服务器；
   ② `PrepareDownload` 里确认码哈希的 tag 与位置；③ BPP 分片的 P2 是否需从 1 起。
   缓解：整条链路的服务器原话与 APDU 状态字都原样写进日志，一旦对不上能立刻定位，不会静默失败。
5. 会审中**子代理给出的行号约 1/5 有偏差**，Proposer 抽查 21 条校正了 6 条；
   本报告的行号虽经主控复核，仍建议以「函数名/符号名」为主、行号为辅。

---

## 八、「连接工具」候选筛选：实测排除项（2026-09-18，版本 2.3.0）

为「连接质量」整卡换血而做的两轮筛选（238 条手册命令差集 → 上机只读实测）。
**以下候选已实测排除，日后别再重复劳动**：

| 候选 | 排除依据 |
|---|---|
| `AT^CGMTU` MTU | 真机 `AT^CGMTU=1` → `1,0,0,0`，**网侧根本没配 MTU**，全 0 无意义 |
| `AT^PHYCOMCFG` | 改 PA 发射功率，属射频 → 红线（不改模组射频）排除 |
| `AT^FREQLOCK` | 真机 `0,"01"` / `0,"02"` 是 **GSM/WCDMA 锁频**，本机 5G SA 用不上；且 network_settings 已有锁频 |
| 日志导出三兄弟 `^MDON` / `^LOGCATSWITCH` | 手册明写「需配合工具」，取不回来 |
| `AT^DSFLOWRPT`（2 秒一次速率上报） | 后端 `urc.rs` 未解析，要用须改 Rust 重编译 |
| `AT^LCELLINFO` / `AT^TRANSMODE` | 本机 NR 主模，直接 ERROR |
| `AT^ADCREADEX` 的「解读」 | 手册只说管脚数量不同、**未定义每个管脚接什么**，故只给裸值不解读 |
| `AT^CGCATT`（CS/PS 附着） | 与「连接状态」卡已有信息重复 |
| `+CCLK`（模组时钟） | 无网络授时时是占位值，会显示假时间（与已删的 `^NWTIME` 同理） |

**最终落地的六项**及手册依据见 CHANGELOG 2.3.0 条目。

**未经实测的部分**：`^REJINFO` 与 `^SRVST` 的上报内容**无法主动触发**（要等模组真的被拒 /
服务状态真的变化）。已验证的是：命令能开能关（`AT^SRVST=1` / `=0` 均返 OK）、
前端解析与事件通道已接线；但**端到端的「真的推了一帧并被卡片收到」尚未在真机上观察到**。
