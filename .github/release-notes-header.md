## 先按设备架构选包（选错装不上）

Release 里有 **x86_64** 与 **aarch64_cortex-a53** 两套包，架构不匹配时 `apk` 会报：

```
ERROR: unable to select packages:
  luci-app-mt5700-<版本>:
    error: uninstallable
    arch: x86_64          ← 这里的架构不是你设备的
```

**先在设备上确认架构，再下载对应前缀的文件：**

```sh
# apk 设备（OpenWrt 24.10+ / ImmortalWrt 快照）
apk --print-arch
# 老设备（opkg）
opkg print-architecture | tail -1
```

| 设备输出 | 下载哪个 |
| --- | --- |
| `aarch64_cortex-a53`（或 `aarch64`） | `aarch64_cortex-a53-luci-app-mt5700-*.apk` |
| `x86_64` | `x86_64-luci-app-mt5700-*.apk` |

- 后缀 `.apk` → 新包管理器 `apk add --allow-untrusted`；
  `.ipk` → 老版本（23.05 及更早）`opkg install`。
- **`luci-i18n-*` 是中文语言包（noarch）**，装不装都行，装上界面才是中文；
  它与主包没有强版本绑定，两个架构的 i18n 内容相同，取任意一个即可。
- 主包已内含 Rust 后端（约 1.2MB），**不需要**额外安装 `at-webserver`。

---
