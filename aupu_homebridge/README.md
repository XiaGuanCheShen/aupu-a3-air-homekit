# 奥普 A3-Air · Homebridge

为 Xiaomi Miot 中的奥普 A3-Air 提供一个多功能 HomeKit 配件，支持真实 HA 后端和模拟模式。

使用 Home Assistant OS 时，请从[项目主页](https://github.com/XiaGuanCheShen/aupu-a3-air-homekit)添加应用仓库，按[安装说明](https://github.com/XiaGuanCheShen/aupu-a3-air-homekit/blob/main/aupu_homebridge/DOCS.md)配置。

已有独立 Homebridge 2.5 的用户可下载 GitHub Release 的 `homebridge-aupu-a3-air-0.3.2.tgz`，在 Homebridge 主机上用 `npm install -g ./homebridge-aupu-a3-air-0.3.2.tgz` 安装。参照包内的 `examples/ha-platform.json`，将平台条目加到 Homebridge 的 `platforms` 数组，替换 HA 地址、两个实体 ID 和 `tokenFile` 的绝对路径。若用环境变量存放令牌，可把 `tokenFile` 替换为 `tokenEnv`，值为变量名。初次使用保留 `readOnly: true`，确认状态后再改为 `false`。
