<div align="center">

# MT5700 Console

**鼎桥 MT5700M-CN 5G 模组 · OpenWrt LuCI 管理控制台**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/woshinibabao1/MT5700-Console?label=release)](https://github.com/woshinibabao1/MT5700-Console/releases)
[![OpenWrt](https://img.shields.io/badge/OpenWrt-23.05%20%7C%2024.10%2B-brightgreen)](https://openwrt.org/)

信号 · 短信 · 锁频 · 拨号 —— 常驻在路由器后台，浏览器只是它的操作台。

</div>

---

## 它是什么

一个 LuCI 插件加一个 Rust 常驻服务，把 MT5700M-CN 的 AT 能力搬进 OpenWrt：串口独占、AT 命令队列、URC 事件分发、短信 PDU 收发、定时锁频都在后台完成。

| 项 | 值 |
|:--|:--|
| 包名 | `luci-app-mt5700`（单包，已内含后端二进制） |
| 服务 / 配置 | 服务 `at-webserver` · 二进制 `/usr/bin/at-webserver-rust` · UCI `/etc/config/at-webserver` |
| 链路 | LuCI → rpcd + ucode → Rust（`127.0.0.1:8765`，仅回环）→ 模组 AT |
| 默认连接 | PCUI 串口 `/dev/ttyUSB1`（TCP 备用） |
| 适用 | OpenWrt 23.05（ipk）/ 24.10+（apk）· `x86_64` · `aarch64_cortex-a53` |

> 后端只监听回环，页面经 rpcd 代理，依赖 LuCI 登录态与 ACL。

---

## 安装

从 [Releases](https://github.com/woshinibabao1/MT5700-Console/releases) 下载**与架构匹配**的主包（约 1.2 MB，已含后端）。装错架构是最常见的失败原因，先确认：

```sh
apk --print-arch                  # apk 设备
opkg print-architecture | tail -1 # opkg 设备
```

> 下面示例里的版本号为当前 `2.1.0`，实际以 Release 页面为准。

```sh
# OpenWrt 24.10+
apk add --allow-untrusted ./aarch64_cortex-a53-luci-app-mt5700-2.1.0-r1.apk

# OpenWrt 23.05
opkg install ./aarch64_cortex-a53-luci-app-mt5700_2.1.0_aarch64_cortex-a53.ipk
```

启用并自检：

```sh
uci set at-webserver.config.enabled=1
uci commit at-webserver && service at-webserver restart
ls -l /usr/bin/at-webserver-rust        # 后端应存在
```

浏览器进 LuCI → **移动网络 → MT5700M模块管理**。

> 中文语言包 `luci-i18n-mt5700-zh-cn-*` 可选（noarch，不装也能用）。回环 RPC 用到 busybox 的 `nc`，精简映像先 `which nc` 确认。

---

## 页面

11 个：网络状态 · 网络设置 · 拨号设置 · 定时锁频 · 模组设置 · 模组升级 · 短信中心 · 短信设置 · AT 调试终端 · 通知日志 · 服务配置。

![网络状态](docs/screenshots/01-status.png)

原厂深层能力均已保留：多载波聚合（`^MONSC` / `^MONSSC` / `^HFREQINFO`）、网络拒绝原因（`^REJINFO`）、SIM 状态（`^SIMSQ`）、12 路温度（`^CHIPTEMP`）；长短信按 UDH 自动合并成一条完整消息。

其余页面截图在 [`docs/screenshots/`](docs/screenshots/)，均取自真实设备（IMEI / IMSI / ICCID / 号码已打码）。

---

## 配置

配置在 `/etc/config/at-webserver`（单 section `config` + 扁平键）。常用的几个：

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `enabled` | `1` | 总开关 |
| `connection_type` | `SERIAL` | `SERIAL`=PCUI 串口；`NETWORK`=TCP |
| `serial_port` | `auto` | `auto` 优先探测 ttyUSB1 |
| `autodial_enable` | `1` | 关掉则网口拿不到 IP |
| `wechat_webhook` | 空 | 企业微信机器人通知 |

改完 `uci commit at-webserver && service at-webserver restart`，或在「服务配置」页点「保存并应用」。完整键（通知 / 定时锁频）见随包默认配置文件。

> **连接看门狗已于 2026-09-20（2.3.25）整体移除**：原先它常驻轮询、断网后自动
> 续约 / 复位，但在「卡上没有 Profile → 永远注册不上网」这类注定失败的场景下
> 会持续制造 `ifdown/ifup` churn。断网排查请用「断网排查」页（只读体检，
> 只给建议命令，不自动动手）；网口重枚举时的 DHCP 续约仍由 hotplug 脚本
> `99-mt5700-renew` **事件驱动**地做一次。

### 脚本下发 AT

后端是**裸 TCP newline-JSON**，不是 HTTP —— `curl` / `wget` 一定失败：

```sh
printf '%s\n' '{"id":1,"method":"at","params":{"cmd":"AT+CSQ"}}' | nc 127.0.0.1 8765
```

---

## 排障

**接口拿不到 IP** —— 九成是这两处：

```sh
uci show network.MT5700M | grep auto                 # 期望 auto='1'
printf '%s\n' '{"id":1,"method":"at","params":{"cmd":"AT^SETAUTODIAL?"}}' | nc 127.0.0.1 8765
```

**服务没起来** —— 状态页顶部标签会给出判定（运行中 / 已禁用 / 未安装 / 不可执行 / 未注册 / 已停止）：

```sh
ls -l /etc/init.d/at-webserver                       # 缺执行位会「未注册」：chmod 0755
ubus call service list '{"name":"at-webserver"}'
logread -e at-webserver | tail -30
```

**AT 终端集体无响应** —— 服务刚启动或模组重连时，8 条初始化命令占着通道。排队已用独立的 8 秒预算，偶发时等几秒重试；两类超时文案不同：「等待空闲通道超时」= 命令没发出去，「模组无响应」= 已写入但模组没回。

---

## 开发

```sh
node tests/run-all.js          # 26 个测试文件，全部无需真机
cd src/rust && cargo test      # Rust 侧
```

推 `main` 或打 `v*` 标签会触发 GitHub Actions 云编译（官方 SDK + zig 交叉编译 musl 静态链接），成功后自动发布 Release。`main` 推送用 `Makefile` 里的 `PKG_VERSION` 作版本号，四处需同步（`Makefile` / `src/rust/Cargo.toml` / `Cargo.lock` / `CHANGELOG.md`）—— 用 `python tools/bump-version.py <版本>`。

---

## 许可

[MIT](LICENSE)。衍生自 [LianXia233/luci-app-mt5700](https://github.com/LianXia233/luci-app-mt5700)（MIT），保留原版权声明：

```text
Copyright (c) 2026 LianXia233
Copyright (c) 2026 MT5700 Console contributors
```

AT 行为以厂商《MT5700M-CN 5G 系列模组 AT 命令手册》为准；本项目与设备厂商无隶属关系。
