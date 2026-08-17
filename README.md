# HSHH-robot

HSHH 是可主动靠近、可邀请拥抱、支持宠物照片形象和可控长期记忆的 AI
陪伴宠物。产品与技术基线以 `docs/HSHH-robot_PRD.md` v0.4 为准。
当前构建产物、配置项和真机硬件门禁见 `docs/P0-READINESS.md`。

## 当前工程

```text
source/
├── agent/       TypeScript 后端；唯一核心 Agent 是 Claude Agent SDK
├── embedded/    TuyaOpen/T5 状态机与签名局域网协调客户端
├── esp32-cam/   AI Thinker ESP32-CAM 的签名触发式抓拍固件
├── esp32-motion/ YD-ESP32-23 的 Arduino/C++ 安全运动控制固件
└── miniapp/     Tuya Ray.js 陪伴、记忆、形象与安全控制面板
```

Agent 服务目前包含：

- Claude Code 原生工具预设、项目 Skills、Session/Resume、串行 Session 队列；
- Context、Perception、Device、Memory、Avatar、Diagnostics 六组进程内 MCP；
- 5–15 秒多模态 Gateway、证据 ID、短时同意令牌与冲突优先级；
- SQLite 记忆、事件、设备状态和宠物资源包元数据；
- `canUseTool`、Pre/Post Tool Hooks、工作区/网络沙箱与 Provider Profile；
- `/v1/interactions`、设备事件、宠物资源包及记忆管理 HTTP API；
- T5 设备效果队列、ESP32-CAM 触发式关键帧与双阶段形象激活；
- Agent 不可用时的克制本地兜底。

## 启动 Agent 服务

```bash
cd source/agent
npm install
cp .env.example .env
# 在 .env 中填写服务端 Provider 凭据
npm run typecheck
npm test
npm start
```

核心模型始终通过 `@anthropic-ai/claude-agent-sdk` 启动。Anthropic、DeepSeek、
Kimi、GLM、Qwen 配置只使用各自的 Anthropic 兼容端点；非 Anthropic Profile
默认关闭，必须完成项目兼容性测试后设置 `HSHH_PROVIDER_VERIFIED=true`。

## 构建 T5 固件

先在 TuyaOpen 根目录激活 `tos.py`，再执行：

```bash
cd source/embedded
tos.py build
```

当前状态机已实现命令 TTL/防重放、500 ms 运动心跳、距离新鲜度、姿态、
电量、拥抱停车与舵机健康门控。T5AI 同时实现 ST7789 9×5 表情、麦克风 VAD、
提示音、实体按钮确认/拒绝/急停、Agent 事件/效果客户端，以及经过 45 帧校验后
原子切换的宠物身份资源。T5AI 使用 Tuya BLE 完成手机配网和云激活，并由独立 LAN 任务验签读取
ESP32-S3 状态，以已认证时间初始化 UTC，并在每次启动/重连时发送签名
`stop`。它只暴露高层 SafeSkill，没有猜测或写入任何 GPIO/UART 引脚。
本地配置和启动验证方法见 `source/embedded/README.md`，手机热点步骤见
`docs/TUYA_T5AI_WIFI_SETUP.md`。

ESP32-S3 运动控制器使用独立 PlatformIO 工程：

```bash
cd source/esp32-motion
pio run -e yd_esp32_s3_safe
```

默认安全构建在传感器未接入时拒绝自主运动，并在上电时先将 MX1508 的
GPIO10/11/12/13 全部置低。配置和离地台架测试方法见
`source/esp32-motion/README.md`。

## 局域网三板架构

实物使用 Tuya T5AI、ESP32-CAM 和 YD-ESP32-23（ESP32-S3-WROOM-1-N16R8）。三块板连接同一个
2.4 GHz 局域网：ESP32-CAM 负责触发式视觉，ESP32-S3 独立负责电机、舵机、
传感器与本地安全，T5AI 负责云端、语音、屏幕和高层协调。协议与安全边界见
`docs/lan-protocol.md`，运动控制板资料与候选接线见
`docs/esp32-s3-motion-hardware.md`。

Agent 服务可通过以下成对配置启用 ESP32-S3 LAN 动作适配器：

```bash
HSHH_MOTION_CONTROLLER_URL=http://hshh-motion.local
HSHH_MOTION_SHARED_SECRET=<至少 32 字符的随机密钥>
```

未配置时保持 fail-closed。LAN 只传输高层 SafeSkill，不传 GPIO、PWM、轮速、
舵机角度、用户身份或 consent token。

## 重要边界

- Agent 到 ESP32-S3 的签名 LAN 适配器、ESP32-S3 服务端和 MX1508/SG90 驱动层
  已实现；T5AI 到 ESP32-S3 的签名 LAN 客户端也已实现。默认固件在传感器缺失时
  保持自主运动锁定；未配置适配器时 Device MCP 仍返回
  `device_adapter_unavailable`，不会假装动作已执行。
- Avatar MCP 已完成上传校验、9×5 manifest、校验和与原子激活元数据链路；
  后端会从真实 JPEG/PNG/WebP 生成统一身份图和确定性 9×5 表情包。T5 采用适配
  196 KB 数据分区的双槽身份图与本地确定性覆盖层，全部文件校验成功后才回执激活。
- `.tuyaopen/` 的硬件上下文只描述 T5AI 板；独立 YD-ESP32-23 的已确认接线记录在
  `source/esp32-motion/hardware-confirmed.json`。HC-SR04、BNO055 和 APDS9960
  尚未确认，因此默认固件不会绕过相应安全门控。
- 原始宠物照片、音视频、API Key、Wi-Fi/Tuya 凭据不得提交仓库或写入日志。
