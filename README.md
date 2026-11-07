# 奥普 A3-Air 接入苹果家庭

把奥普 A3-Air 浴霸通过 Home Assistant 和 Xiaomi Miot 接入 Apple Home。Homebridge 由 HA 应用托管。配对后，苹果「家庭」里的同一个浴霸配件可控制主照明、小夜灯、取暖、换气、吹风、干燥和铂金除臭，并显示环境温度。

[![把仓库添加到 Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FXiaGuanCheShen%2Faupu-a3-air-homekit)

## 快速安装

需要 **Home Assistant OS**（amd64 或 aarch64），以及已通过 [Xiaomi Miot](https://github.com/al-one/hass-xiaomi-miot) 本地接入 HA 的浴霸。实机验证型号为 `aupu.bhf_light.a3pro2`，商品名称相同的其他型号请先核对。

1. 点上方按钮添加仓库，安装 **奥普 A3-Air · Homebridge**。也可以在「设置 → 应用（旧版称加载项）→ 安装应用 → 仓库」添加本页地址。
2. 在应用「配置」里填写同一浴霸的 `information_entity`（`button.*`）和 `control_entity`（`climate.*`）。[查看查找实体的步骤和模板](aupu_homebridge/DOCS.md#2-查找两个实体)。
3. 启动应用。日志出现 `HA state synchronized` 后，在 iPhone「家庭 → 添加配件」扫描应用日志里的二维码，或输入配对码。核对室温和灯的状态，再打开 **允许控制** 并重启这个应用。

HA 会在首次安装时构建应用，网络需要能访问 GitHub、Docker Hub 和 npm。应用使用 Supervisor 分配的授权。安装者无需另外准备 HA 长期访问令牌，也无需单独维护一台 Homebridge 主机。

## 详细说明

- [从米家接入、实体查找、配对到故障排查](aupu_homebridge/DOCS.md)
- [版本下载](https://github.com/XiaGuanCheShen/aupu-a3-air-homekit/releases)包含 HA 本地应用源码包、独立 Homebridge 插件包和 SHA-256 校验文件。
- [版本记录](aupu_homebridge/CHANGELOG.md)和 [MIT 许可证](LICENSE)。

该型号在 HA OS 和 iOS 27 上已有实机使用记录。实际布局由「家庭」App 决定。仓库包含模拟后端，方便在不接通浴霸控制的情况下体验界面和做回归测试。

## 开发

使用 Node.js 24，在 `aupu_homebridge` 目录运行 `npm ci --ignore-scripts`、`npm test` 和 `npm run smoke`。需要实际构建镜像时运行 `docker build .`。
