# 安装和使用

## 1. 让 HA 本地读到浴霸

1. 先将浴霸加入米家，确认原厂控制可用。此处验证的 MIoT 型号是 `aupu.bhf_light.a3pro2`。如型号不匹配，先核对协议属性。
2. 通过 HACS 安装 [Xiaomi Miot](https://github.com/al-one/hass-xiaomi-miot/blob/master/README_zh.md)，按 HACS 提示重启 HA，再到「设置 → 设备与服务 → 添加集成」中添加 `Xiaomi Miot`。
3. 用米家账号添加时，选择正确区域，筛选出这台浴霸并选择 **Local**。已有设备局域网 IP 和设备 Token 的用户可以直接用 Xiaomi Miot 的 **Host/Token** 方式。Token 填在 Xiaomi Miot 的设置中。
4. 确认 HA 中浴霸在线，能读出灯和取暖状态。若信息实体的 `updater` 一直为 `cloud`，先把 Xiaomi Miot 切换到本地连接。本应用的状态同步以本地设备读回为准。

HA 与浴霸需要能通过局域网通信。设备账户注册、初次联网或厂商 App 的使用仍取决于米家和设备固件。

## 2. 查找两个实体

打开 HA「设置 → 设备与服务 → Xiaomi Miot → 设备」，点进浴霸。复制这台设备的 **信息按钮**（`button.*`）和**取暖实体**（`climate.*`）的实体 ID。信息按钮的属性中应有 `model: aupu.bhf_light.a3pro2`。若实体处于禁用状态，先在设备页面启用。

也可以在「开发者工具 → 模板」粘贴下方内容。它按 Xiaomi Miot 设备关联查找实体，只读取状态。多台同型号设备时，请选出目标设备对应的一组。

```jinja
{%- for b in states.button if b.attributes.model == 'aupu.bhf_light.a3pro2' and b.entity_id in integration_entities('xiaomi_miot') %}
{%- set id = device_id(b.entity_id) %}
{%- if id %}
{%- for e in device_entities(id) if e.startswith('climate.') and state_attr(e, 'ptc_bath_heater.mode') is number %}
information_entity: {{ b.entity_id }}
control_entity: {{ e }}
{% endfor %}
{%- endif %}
{%- endfor %}
```

## 3. 安装 HA 应用并配对

1. 用[添加仓库链接](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FXiaGuanCheShen%2Faupu-a3-air-homekit)打开你的 HA。安装 **奥普 A3-Air · Homebridge**。首次安装会从网络取构建依赖，支持 `amd64` 和 `aarch64` 的 HA OS。
2. 在应用的「配置」页填写两个 ID。`backend` 保持 `ha`，`allow_control` 先关闭。用 YAML 编辑时可参考下例，替换两个示例实体。

   ```yaml
   backend: ha
   allow_control: false
   information_entity: button.your_aupu_info
   control_entity: climate.your_aupu_heater
   name: 奥普 A3-Air
   primary_service: heater
   include_temperature_sensor: true
   bridge_port: 51863
   ```

3. 保存并启动应用，查看日志。出现 `HA state synchronized` 表示首次设备读取成功。若只是体验界面，把 `backend` 设为 `simulation` 并重启，所有控件使用模拟数据。
4. iPhone 与 HA 保持在可互通的局域网内。在苹果「家庭 → 添加配件」扫应用日志的二维码，也可以在「更多选项」选择 `Aupu A3-Air Bridge` 后输入日志里的配对码。确认配件名称、室温、开关状态。
5. 需要从「家庭」控制时，在 HA 应用打开「允许控制」，保存后重启应用。初次建议先测试主照明。

HA 应用使用 [`SUPERVISOR_TOKEN`](https://contributors.home-assistant.io/apps/guides/communication/) 访问 Core，具有 HA 管理员 API 权限。桥接身份和配对信息保存在应用数据中。请在卸载或迁移前备份，并在分享截图时遮盖二维码与配对码。

## 控制和状态

| 家庭控件 | 浴霸功能 |
| --- | --- |
| 主照明、小夜灯 | 分别开关 |
| AI 恒温取暖 | 取暖模式，设定温度 30–42°C，步长 1°C |
| 换气排风、吹风送风 | 两个独立控件，各有五档。选择其中一个会切换当前工作模式 |
| 干燥、铂金除臭 | 分别进入对应工作模式 |
| 环境温度 | 设备测得的实际温度 |

取暖、换气、吹风、干燥、除臭在浴霸上互斥。切出取暖或干燥时，先关当前模式，等待原厂风机散热结束。桥接以设备的余转倒计时判断可否开始新模式，拒绝的指令需要重新操作。米家和原厂遥控器直接操作浴霸，它们由原厂控制器负责。软件同步基于工作模式及倒计时，设备协议未提供加热元件瞬时功率或风机转速。

桥接收到灯或模式变化时会再向设备读取确认。遥控器的变化会先经过 Xiaomi Miot 的更新周期，因此显示可能稍晚。温度设定和当前室温分开显示。HomeKit 端的配件布局可能随系统版本变化。

## 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 安装一直转圈或构建失败 | 查 HA Supervisor 日志，确认能访问 GitHub、Docker Hub 和 npm。仓库版和本地 ZIP 都需要下载构建依赖。 |
| 启动提示 `HA entity mapping is required` | 填齐同一设备的两个实体 ID 后重启应用。 |
| 有配件，但显示无响应 | 核对日志是否出现 `HA state synchronized`，检查实体 ID、设备在线状态和 Xiaomi Miot 的 Local 连接。 |
| 显示正常但无法控制 | 在应用开启 `allow_control`，保存并重启。散热期间，请等待倒计时结束。 |
| 在 iPhone 上找不到桥接 | 确认 HA 应用已启动，默认 TCP 51863 未被占用，局域网允许 mDNS（UDP 5353），关闭客户端隔离。 |
| 从早期本地版本改用 GitHub 仓库 | 仓库版与 `local_aupu_homebridge` 在 Supervisor 中是两个应用。已有配对的用户可以在原目录更新本地版本；改装仓库版时先停掉旧桥接并备份，仓库版需要单独配对。 |

### 本地应用包

HA 拉取仓库失败时，可以下载 Release 的 `aupu-a3-air-0.3.2-ha-app.zip`。校验 `SHA256SUMS.txt` 后，把 ZIP 里的 `aupu_homebridge` 文件夹解压到 HA 的本地应用目录（Samba 的 `addons` 共享）。目录结构应为 `addons/aupu_homebridge/config.yaml` 和 `addons/aupu_homebridge/Dockerfile`。刷新应用商店，从「本地应用」安装。

升级本地安装时，先备份应用，再把新版源码覆盖到原来的应用目录，在应用商店检查更新。请保留原应用数据目录，配对记录随原应用数据保存。

### 反馈问题

请附上浴霸 MIoT 型号、固件、HA 与 Xiaomi Miot 版本、桥接版本、操作时间，以及能说明现象的日志片段。发布前删除设备 Token、账号、局域网地址、设备标识和配对信息。
