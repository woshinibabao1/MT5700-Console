# 前端代码系统性审查报告

- **仓库**：`woshinibabao1/MT5700-Console`（本地 `D:\AI空间\MT5700`）
- **审查基线**：`main @ ea2c855`（本轮提交之前）
- **审查日期**：2026-09-16
- **审查范围**：`htdocs/` 下全部前端代码（7 个共享模块 + 11 个视图 + 1 个 CSS，约 12,600 行），
  外加 `root/usr/share/rpcd/acl.d/` 与 `root/usr/share/luci/menu.d/` 两份权限/菜单声明
- **方法**：
  1. 四路并行子代理分头取证（共享核心 / 视图 A / 视图 B / 横切安全·性能·CSS）；
  2. 主代理对**每一条拟修改项亲自复核源码**（子代理结论不直接采信）；
  3. 每个修改点至少两维交叉验证：静态分析 + 边界推导 + 既有测试兼容 + 技术手册。

> **行号说明**：行号以审查基线快照为准。本轮已改的文件（见下节）行号会偏移，
> 报告中的行号指**改动前**位置，用于定位历史问题。

---

## 一、结论摘要

| 类别 | 数量 | 说明 |
|---|---|---|
| 已在本轮修复 | **5 项** | 见第二节，含 1 项 Critical 安全漏洞 |
| 需人工决策 / 高风险 | **16 项** | 见第三节，未经真机验证或涉及产品取舍，**未改动代码** |

**总体评价**：XSS 面是干净的——全仓库 `innerHTML` 仅用于 `= ''` 清空，渲染一律走
`E()` / `textContent`，没有一处把设备数据或用户输入拼进 HTML。真正的风险集中在
**AT 命令注入**（短信正文那条已修）与**高危 AT 命令缺少二次确认**（未修，需决策）。

---

## 二、已修复（本轮提交）

| # | 严重等级 | 问题 | 提交 |
|---|---|---|---|
| 1 | **Critical** | 短信正文可注入 AT 命令 | `dae5122` |
| 2 | High | 自动刷新 `setInterval()` 不通知调用方，定时器从不重建 | `17da9db` |
| 3 | High | 拨号方式 `0` 被 `\|\|` 悄悄改成 `1` | `23e81bb` |
| 4 | Medium | `AT^SETMODE?` 应答解析恒为 NaN，USB 模式读不回来 | `23e81bb` |
| 5 | Medium | 网卡 PHY 值域上并存两段结论相反的注释 | `8056b19` |

另有 **新增功能 1 项**：自动刷新支持自定义间隔（`17da9db`）。

---

## 三、需人工决策 / 高风险项（未改动）

### 3.1 Critical

#### R1 · 关闭「短信功能」无二次确认 → 关射频 + 清空全部短信

- **分类**：安全 / 高危操作守卫缺失
- **位置**：`htdocs/.../view/at-webserver/sms_settings.js:253-266`（`toggleSMS`），调用点 `mkCheck`
- **触发条件**：误点「短信功能」开关关闭
- **详细描述**：关闭分支的步骤链为
  ```js
  ['AT+CEUS=0', …], ['AT^IMSSWITCH=0,0,0', …],
  ['AT+CFUN=0', 500, '关闭射频'], ['AT+CMGD=1,4', 0, '清空短信']
  ```
  `AT+CFUN=0` 立即关射频（断网），`AT+CMGD=1,4` 删除当前存储里的**全部**短信，
  两者都不可回滚；失败分支只做 `smsOnChk.checked = !enable`，射频已关、短信已删。
  对比：同仓库 `modem_settings.js:357` 的飞行模式（`AT+CFUN=0`）**已加确认弹窗**，
  此处独缺，属守卫未闭合。
- **建议方案**：`mkCheck` 的回调改为
  `Mt5700.confirm('关闭会下发 AT+CFUN=0（立即断网）并清空模组内全部短信，且不可撤销。确定？', …)`，
  取消则先回滚 checkbox。
- **验证方法**：静态确认 `toggleSMS(false)` 路径上出现 `Mt5700.confirm`；
  真机验证需先备份短信（`AT+CMGL=4`），在测试卡上执行。
- **手册参考**：3GPP TS 27.007 §4.1（`+CFUN`）、§3.5（`+CMGD`，`delflag=4` = 删除全部）

#### R2 · rpcd ACL 读段可泄 `websocket_auth_key`，写段过宽

- **分类**：安全 / 权限
- **位置**：`root/usr/share/rpcd/acl.d/luci-app-mt5700.json:5-8`（`read.uci`）、`:44-47`（`read.file`）、`:78-138`（`write`）
- **触发条件**：任何被授予 `luci-app-mt5700` 组的非 root 账号发起读请求
- **详细描述**：`read` 段开放了整个 `at-webserver` UCI 包与 `/etc/config/at-webserver` 文件，
  连接密钥 `websocket_auth_key` 明文可读；`write` 段还开放了 `ubus mt5700: at`
  （任意 AT 命令）、`file.write` 到 `/etc/config/firewall`、以及 `/etc/init.d/at-webserver: exec`
  → 越权改防火墙、重启服务、下发 `AT+CPIN` / `AT+CMGR` 读短信。
- **建议方案**：把 `websocket_auth_key` 拆到独立 UCI section 并从 `read` 段剔除，
  改由后端 ucode 代理附加；写操作收敛到 `mt5700` 自有方法，删除 `write.file` 与 init `exec`。
- **影响**：改动涉及后端与部署包，**必须与后端一并评估**，不宜前端单独改。
- **验证方法**：以非 root 账号 `ubus call` 读取，确认拿不到密钥。
- **手册参考**：OpenWrt rpcd ACL 文档（`ubus`/`uci`/`file` 三类 scope 的最小权限原则）

---

### 3.2 High

#### R3 · PIN 锁状态永远读不回来 → PIN 锁无法关闭

- **分类**：缺陷
- **位置**：`htdocs/.../view/at-webserver/modem_settings.js:340`
- **触发条件**：打开「模组设置」页即触发
- **详细描述**：`var m = atText(res).match(/,(\d+)/)` 依赖应答里**有逗号**。
  按 3GPP TS 27.007 §7.4，`AT+CLCK="SC",2` 的查询响应是 `+CLCK: 0`（**单值、无逗号**），
  正则恒为 null → `pinLockEnabled` 永远 `null` → 徽章恒「PIN 状态未知」；
  而 `togglePinLock` 用 `turnOn = pinLockEnabled !== true`，恒为 true，
  **用户永远只能下发 `AT+CLCK="SC",1`（启用），无法关闭**。
- **为什么没直接改**：本项目不同固件应答格式可能不同（部分固件回带 `<class>`）。
  我未向真机下发该命令确认格式（属你设定的高危禁列），故**不猜格式**。
- **建议方案**：先只读确认应答格式，再改为 `/\+CLCK:[^\d\r\n]*(\d+)/`
  （取 `+CLCK:` 后第一个数字，即标准里的 `<status>`，可同时兼容 `+CLCK: 0` 与 `+CLCK: "SC",0`）。
- **验证方法**：在真机执行 `AT+CLCK="SC",2`（**纯查询，无副作用**）看原始应答；
  再对照 `tests/device-control-contract.test.js` 补断言。
- **手册参考**：3GPP TS 27.007 §7.4 Facility lock（`+CLCK` 响应格式）

#### R4 · 升级完成后的版本复核命中缓存 → 升级成功被报成「失败」

- **分类**：缺陷 / 缓存语义
- **位置**：`htdocs/.../view/at-webserver/upgrade.js:316`（`finishByIdle`）、`:213`（`start`）
- **触发条件**：固件在 10 分钟内升级完成
- **详细描述**：`AT+CGMR` 在 `rpc.js:328` 的 `IDENTIFIER_COMMANDS` 里（TTL 10 分钟）。
  `finishByIdle()` 用 `now !== baseVersion` 判定是否真的升成功，命中缓存时
  `now === baseVersion` → 明明成功却弹「版本未变化」。`start()` 里的 `baseVersion`
  同样可能是陈旧缓存。
- **建议方案**：两处改 `sendCommand('AT+CGMR', { fresh: true })`（`rpc.js:413` 已支持 `opt.fresh`）。
- **为什么没直接改**：升级是**高风险不可逆操作**，改判定逻辑需要真机跑一次完整升级验证，
  静态测试无法覆盖；误改会让「失败」被误报成「成功」，后果比现状更严重。
- **验证方法**：在测试机上跑一次完整升级，对比 `fresh` 前后 `AT+CGMR` 返回值。
- **手册参考**：`rpc.js` 内 `IDENTIFIER_COMMANDS` 的缓存设计注释（TTL 10 分钟）

#### R5 · AT 终端无高危命令守卫

- **分类**：安全 / 高危操作
- **位置**：`htdocs/.../view/at-webserver/terminal.js:70`（`keydown` → 直接 `send()`）
- **触发条件**：在终端页手动输入任意命令回车
- **详细描述**：主输入通道无确认、无黑名单，可直接下发 `AT+CFUN=0/1,1`、`AT^RESET`、
  `AT+CPIN=`、`AT+CLCK`、`AT+CMGD=1,4`。文件头注释只强调「常用命令按钮有二次确认」，
  掩盖了主输入通道的风险。另外历史命令 `savedAtCommands` 明文写入 localStorage，
  可能包含 PIN。
- **建议方案（二选一，需你定）**：
  - **A（守）**：对命中 `/^(AT\+CFUN|AT\^RESET|AT\+CPIN=|AT\+CLCK|AT\+CMGD=1,4|AT\+CPWD)/i`
    的命令强制 confirm；持久化前剔除含 PIN/PUK 的条目。
  - **B（放）**：终端本就是给高级用户裸发 AT 用的，加守卫反而降低可用性 ——
    那就保留现状，但**必须**把「此页可直接下发高危命令、误操作会断网/锁卡」
    写进页面顶部警示，并停止把历史命令落 localStorage。
- **验证方法**：静态确认命中正则的命令走了 confirm。
- **手册参考**：MDN `KeyboardEvent`；本项目红线第 3 条（高危 AT 命令清单）

#### R6 · 「高温时关闭 CA/MIMO」开关是空操作

- **分类**：缺陷 / 状态管理
- **位置**：`htdocs/.../view/at-webserver/modem_settings.js:808`
- **触发条件**：切换该项开关
- **详细描述**：`makeSwitch(function () {})` 回调为空。该值只在主开关或间隔输入触发时
  才被 `thermCmd()` 附带读取，单独切换它**界面已变、设备未变**，且无任何提示。
- **建议方案**：与其它三项一致，接 `ctrlStaged.set('therm-ca', …)`。
- **为什么没直接改**：需要确定该项对应的完整 AT 命令语义（涉及射频行为），
  改错会实际影响设备散热策略，故先报告。
- **验证方法**：静态确认 `staged` 里出现该 key；真机切换后读回确认生效。

---

### 3.3 Medium

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| M1 | `parse.js:801-820`、`sms_center.js:702,764` | 短信**正文 + 号码明文**落 localStorage，最多 1000 条，无过期 | 正文改内存态或 `sessionStorage`；⚠️ 改需同步 `tests/ui-contract.test.js:203` 的断言 |
| M2 | `mt5700.js:578-608` | `Mt5700.autoRefresh` 与 `Ui.autoRefresh`（`ui.js:322`）**两套重复实现**，前者**零调用**是死代码，且返回接口不同（`enabled()` vs `isEnabled()`） | 删除死实现，或让 `network_status.js` 统一走一套 |
| M3 | `ui.js:381-386` vs `mt5700.js:628-648` | 定时器生命周期**两套方案并存**：hashchange 清理 vs "节点是否还在文档里"。`mt5700.js:625-626` 的注释自己写明 hashchange 方案「会把新页面刚注册的定时器误清掉」；唯一使用者是 `network_settings.js:64` | 统一收敛到 `Mt5700.interval(ms, fn, scopeEl)`，废弃 `Ui.interval` |
| M4 | `mt5700.js:97-105`、`666-685` | 节点**从未进入文档**时 `wasInDoc` 恒为 false → 1s 看门狗永不 `clearInterval`，每进一次页面泄漏 1~2 个定时器 | 加最大存活次数兜底，或改 `MutationObserver` |
| M5 | `service.js:650,700,720` | 分步 `setTimeout` 链（1.2s/1s/2s）无在飞守卫、该文件**缺 `self._dispose`** → 离开页面后仍继续调 ubus | 补 `page._onDispose` + `disposed` 标志 |
| M6 | `network_settings.js:245,413` | 锁频的飞行模式序列无**全局**互斥（连点两行会交错下发两套 `CFUN=0/1`），且 15s 邻区轮询会插进 1s 窗口 | 共用一把 `radioBusy` 锁并在锁频期间暂停自动刷新 |
| M7 | `network_settings.js:615-620` | `renderNeighbors()` 抛错时 `neighBusy` 永久为 true → 「扫描邻区」按钮永久 disabled，且 reject 无人接管（MDN: `unhandledrejection`） | 重置移到 `finally` 语义位置 |
| M8 | `modem_settings.js:722,990` | `querySelector('option[value="' + value + '"]')` 拼选择器，`value` 来自模组应答，含引号时抛 `SyntaxError` 并被 `.catch(function(){})` 静默吞掉 | 改用 `CSS.escape()` 或遍历 `options` 比较（MDN: `CSS.escape`） |
| M9 | `parse.js:647-672` | `decodeIncomingPdu` 缺输入校验：非法 hex → `NaN` 参与下标与边界比较（`NaN` 比较恒 false）→ **不返回 null 而返回空壳**，短信列表混入空记录 | 入口校验 `/^[0-9A-Fa-f]+$/` |
| M10 | `parse.js:573` | 注释称「上方另有一个 `var decodeUcs2`（USSD 用）」—— **该函数不存在**（实际是 `decodeUcs2Bytes`，USSD 已整体移除） | 删/改注释。⚠️ `tests/parse-contract.test.js:146` 断言 USSD 函数为 `undefined`，**切勿据这条注释去"补回" USSD** |
| M11 | `upgrade.js:96,485,520` | `sawUpgrade` 只赋值从不读取，注释称「靠这个位区分」→ 死变量 + 注释说谎 | 删变量或真正使用 |
| M12 | `mt5700.css:1949-2443` | 约 **495 行死规则**（`at-*` 移植块，~138 个类名 JS 零引用）；另有 `.at-status-card`/`.mt5700-sms-layout` 等**同优先级重复定义**（改一处不生效） | 整块删除。⚠️ `at-toast-*` / `mt5700-btn-*` / `mt5700-badge-*` 是**运行时拼串生成**，静态 grep 会误判为死规则，删前必须排除 |
| M13 | `mt5700.css:1990-2027,2065,2300,2376` | 直接覆盖 `.cbi-input-*` / `.cbi-button`，并硬编码 `#fff`/`#222`，与 Argon 暗色主题打架 | 改用自有类 + `var(--mt5700-*)` 令牌（该文件已定义令牌） |
| M14 | `sms_center.js:338,466-499` | `refresh()` 无在飞守卫（send/push/partialRetry 三路可并发）；`jobPollers` 只 push 不 splice，页面内单调增长 | 加 in-flight 守卫；任务完成后 splice |
| M15 | `logs.js:122`、`sms_center.js:406-409` | `setInterval(refreshLog, 10000)` 无在飞守卫；未读名单会被一次空列表整体抹掉（新短信到达瞬间正在刷新时触发） | 加 in-flight；仅在 `list.length > 0` 时收敛名单 |

---

### 3.4 Low

- **`compat.js:49`**：直接赋值 `String.prototype.format` → 属性**可枚举**，污染 `for...in`。
  应 `Object.defineProperty(..., { enumerable: false })`（MDN: `Object.defineProperty`）。
- **`network_status.js:1260`**：提示文案明文写「该密钥保存在 UCI at-webserver.websocket.auth_key」，属信息泄露型提示。
- **`service.js:310`**：连接密钥输入框是 `type=text` 明文显示（同站 `Ui.promptModal` 用的是 `password`）——**这条其实可以直接改，待你确认**。
- **`rpc.js:130`**：`self.reconnectAttempts = 0` 死字段，重连实为固定 3s 无退避，注释未反映。
- **`rpc.js:264-268`**：`isErrorText` 正则无 `m` 标志、无锚点，任何含 " error"/"ERROR" 的**正常数据**（短信正文、版本串）会被判失败并触发 3 次重试。
- **`rpc.js:709-713`**：`parseTemperature` 用 `0` 表示「无测量」，而 `parse.js:38-43` 的 `power()` 明确用 `null` 并写了注释说明理由 —— 两处口径冲突，0℃ 与「没测到」不可区分。
- **`modem_settings.js:123-127`**：`simSlotSelProxy = simSlotSel` 无意义别名。
- **重复代码**：三份视图各写一遍 `connect().catch(REQUIRE_AUTH_KEY)…then(loadAll)`（dial / modem / network）；
  `Ui.sendCmd` 与 `AtWs.client.sendCommand` 两套调用并存。

---

## 四、已核查为「非问题」（不必改）

- **XSS**：全仓库 `innerHTML` 仅用于清空，渲染走 `textContent`；无 `outerHTML` / `insertAdjacentHTML` / `document.write`；生产代码无 `eval` / `new Function`。
- **AT 注入（除已修的短信正文外）**：APN / 用户名 / 密码 / PIN / PUK / 短信号码均已过 `Parse.sanitizeAtParam` 或强正则。
- **CSS `!important`**：全文仅 1 处（`mt5700.css:1944`，reduced-motion 覆盖），无滥用；无通配符 `*` 选择器。
- `network_status.js:1271-1281` 的定时器 / 监听器 / 缓存清理完整，是全仓库样板。
- `upgrade.js:273-297` 的递归 `setTimeout` + in-flight 守卫正确。

---

## 五、建议的处置顺序

1. **R1**（误点即断网+删短信）—— 改动小、风险低，建议优先修。
2. **R5**（终端守卫）—— 需要你先定「守还是放」，定了就能改。
3. **R3**（PIN 锁）—— 只需一次真机只读查询确认应答格式，即可安全修。
4. **R2**（rpcd ACL）—— 涉及部署包，需与后端一并评估。
5. **M2 / M3 / M4**（定时器生命周期三套方案）—— 建议一次性收敛，是「反复进出页面轮询成倍叠加」这个历史 bug 的剩余面。
6. **M12 / M13**（CSS 死规则与主题耦合）—— 收益是包体积与可维护性，但删前需排除运行时拼串的类名。
