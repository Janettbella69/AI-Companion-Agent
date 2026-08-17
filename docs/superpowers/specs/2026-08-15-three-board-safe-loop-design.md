# HSHH-robot 三板安全闭环设计

> 日期：2026-08-15  
> 状态：已确认，待实施计划  
> PRD 基线：`docs/HSHH-robot_PRD.md` v0.4  
> 范围：P0 第一阶段垂直切片

## 1. 目标

第一阶段先交付一个“可见、可听、可停止”的真实三板闭环：

1. ESP32-CAM 按事件触发采集 JPEG，并形成可追踪视觉证据。
2. 涂鸦 T5AI 作为唯一设备协调节点，调用云端 Claude Agent。
3. T5AI 在屏幕和扬声器上执行表达，并只向运动板发送高层 SafeSkill。
4. ESP32-S3-N16R8 独立执行舵机与本地安全；任何故障均保持电机停止。

本阶段验证架构与安全原则，不在缺少距离和姿态传感器时解锁自主移动。

## 2. 已冻结的产品原则

- 核心认知路径只使用一个 Claude Agent SDK Agent。
- 生产动作路径固定为 `Agent → T5AI → ESP32-S3`。
- Agent、T5AI 和局域网协议均不得传递 GPIO、PWM、轮速、舵机角度等原始执行器参数。
- ESP32-S3 拥有最终本地安全否决权。
- `stop` 和 `release_hug` 始终是逃生动作。
- 视觉证据不能单独生成靠近或拥抱同意。
- Agent、CAM 或 LAN 失效时，设备仍能显示 basic 表情并执行本地停止/释放。

## 3. 已确认硬件

### 涂鸦 T5AI

- 板型：`sparkleiot-t5ai-dev`
- 角色：云端连接、语音、屏幕、状态机和总协调
- 本阶段外设：
  - `display`：ST7789 240×320 RGB565
  - `audio`：板载麦克风、codec 和扬声器
  - `button`：GPIO8 低有效板载按键
- 不使用：T5 板载摄像头、触控、SD 卡

### ESP32-CAM

- 角色：唯一主视觉节点
- 传感器：OV2640
- 网络：2.4 GHz Wi-Fi LAN
- 模式：事件触发 JPEG；不持续上传视频

### ESP32-S3-N16R8

- 模块：ESP32-S3-WROOM-1-N16R8
- 角色：运动执行和确定性安全
- 已接线：
  - MX1508 + 两个 TT 电机：GPIO10、11、12、13
  - SG90：GPIO17；外部 5 V 供电；与 ESP32 共地
- 未确认：HC-SR04、BNO055、APDS9960
- 约束：自主移动保持关闭；本阶段不得通过软件绕过。

## 4. 系统拓扑

```text
                           Claude Agent service
                                  ^
                                  | HTTPS / AgentDecision
                                  v
ESP32-CAM <-- HMAC LAN --> Tuya T5AI <-- HMAC LAN --> ESP32-S3-N16R8
  JPEG/evidence             sole coordinator          local safety
                              |    |    |
                           display audio button
```

- 两块 ESP32 与 T5AI 处于同一受信任 2.4 GHz LAN。
- T5AI 与两个 ESP32 分别使用不同共享密钥。
- 生产环境删除 Agent 到 ESP32-S3 的直接动作分发。
- 不再依赖板间 UART。

## 5. 组件设计

### 5.1 T5AI 设备输出层

新增独立模块，避免在 `tuya_app_main.c` 写业务逻辑：

- `app_hshh_display`：打开 TDL display、管理 PSRAM framebuffer、播放 9 种 basic 表情。
- `app_hshh_audio`：打开 TDL audio、播放本地提示音、将麦克风帧交给语音上传队列。
- `app_hshh_voice`：使用 VAD 切分语音，经已配置的云端 ASR 得到 transcript，再调用
  Agent `/v1/interactions`；Agent 核心不直接持久化原始 PCM。
- `app_hshh_button`：
  - 单击：仅在屏幕/语音存在未过期邀请时，明确同意该邀请；
  - 双击：拒绝/取消；
  - 长按：本地 `stop` + `release_hug`，不等待云端。
- `app_hshh_effects`：把 `AgentDecision` 映射为状态机命令、表情、声音和 SafeSkill。

入口初始化顺序：

1. TAL 日志、定时器和工作队列；
2. `board_register_hardware()`；
3. display/audio/button；
4. 状态机；
5. CAM、Agent 和 motion LAN 客户端。

任一非安全外设初始化失败时继续进入降级 idle；运动默认保持停止。

### 5.2 Basic 表情资源

- 输入资源：`assets/expressions/<state>/<state>_01.png` 至 `_05.png`，共 9×5 帧。
- 原始资源保持 PNG，不直接把解码后的 6.9 MiB RGB565 全量常驻 SRAM。
- 构建时生成版本化资源包和 manifest；包内帧转换为适合 ST7789 的 RGB565 压缩数据。
- 运行时只在 PSRAM 保留当前帧 framebuffer。
- 帧显示采用屏幕逻辑方向居中适配，不拉伸角色比例。
- 包校验失败时只使用内置 idle basic 帧，不显示损坏资源。

第一阶段只使用 basic 包；宠物定制包沿用相同 manifest/校验接口，在后续 Gate 3 接入。

### 5.3 ESP32-CAM

现有 `/capture` bring-up 接口升级为 `POST /v1/camera/captures`：

- 严格校验 `capture_id`、`robot_id`、`issued_at`、`expires_at`、触发原因和允许字段。
- 请求与 JPEG 响应都使用 HMAC-SHA256。
- 校验 5 秒时钟偏差、TTL、请求大小和防重放。
- UTC 尚未通过 NTP 建立可信状态时，签名接口返回 `controller_not_ready`，不使用启动时刻冒充墙钟。
- 禁止 `/forward`、`/hug` 等兼容动作路由进入生产构建。
- 拍摄失败不得返回旧帧。

T5AI 只在按键、语音、状态机事件或诊断请求时触发拍摄。JPEG 作为临时证据上传 Agent Gateway，使用后释放。

### 5.4 Agent 服务

- 保留 `/v1/device/events` 和 `/v1/interactions`。
- T5AI 作为受认证设备客户端上报音频/视觉/按键事件。
- Agent 返回 `AgentDecision`，但不直接执行 S3 动作。
- 生产启动不再把 Device MCP 绑定到 `LanMotionAdapter`。
- Device MCP 的 SafeSkill 结果改为“交给 T5AI 的请求”；T5AI 重新校验状态、同意和 TTL。
- 表情和声音 effect 由 T5AI adapter 消费，不再发送给 motion adapter。

Agent 决策必须包含 `request_id`、`used_evidence_ids` 和输出通道；缺少必要证据时不得产生动作。

### 5.5 T5AI 状态机与运动桥

新增桥接层把现有状态机与 `app_hshh_lan` 接通：

- CAM `person_detected` 证据 → `APP_HSHH_EVENT_USER_DETECTED`
- 麦克风 VAD → `SPEECH_STARTED` / `SPEECH_ENDED`
- Agent 响应 → `app_hshh_state_apply_command`
- 合法 `INVITE_HUG` → `app_hshh_lan_request_skill(INVITE_HUG)`
- 任意本地停止 → `STOP`，并停止音频播放
- 状态变化 → 表情和提示音

桥接层不允许直接修改执行器。

### 5.6 ESP32-S3

- 安全构建启用 SG90，但不启用无传感器自主移动。
- `invite_hug` 只允许在：
  - 电机已停止；
  - 舵机自检通过；
  - 命令已认证且未重放；
  - T5AI 提供的 expected state 与本地状态一致。
- `release_hug` 和 `stop` 始终可抢占。
- `approach_short`、`turn_to_user` 在 HC-SR04/BNO055 未接入前继续返回 `safety_sensors_unavailable`。

## 6. 关键流程

### 6.1 启动与离线

1. S3 上电先把 MX1508 全部输入拉低。
2. T5AI 初始化屏幕并显示 idle。
3. T5AI 对 S3 执行已认证 status + boot stop。
4. Agent 不可用时，T5AI 保持本地 basic 表情和停止能力。

### 6.2 视觉触发

1. T5AI 触发 ESP32-CAM 拍摄。
2. T5AI 验证响应签名、时间戳、capture ID 和 JPEG 限额。
3. T5AI 上报 `/v1/device/events`，Gateway 返回 `evidence_id`。
4. Agent Perception 对关键帧生成结构化 observation。
5. 只有有效、新鲜且明确检测到人的 observation 可令状态机进入 `NOTICED`；原始 JPEG
   或其他视觉推测不得视为动作同意。

### 6.3 邀请拥抱

1. Agent 提议 `invite_hug`，并要求用户确认。
2. T5AI 通过语音或按键取得短时 hug consent。
3. T5AI 状态机再次检查命令 TTL 与本地状态。
4. T5AI 向 S3 发送 `invite_hug`。
5. S3 在本地确认电机停止和舵机健康后执行 SG90。

本阶段没有 BNO055，因此不能声称已检测“被抱起”，也不进入 PRD 的完整 held 验收。

### 6.4 停止与释放

- T5 长按、用户语音停止、Agent stop、LAN 超时或本地故障均触发 stop。
- 本地长按无需 Agent 在线。
- stop/release 重复调用必须幂等。

## 7. 故障处理

- Agent 超时：显示 confused/sleeping，播放本地提示，停止动作。
- CAM 不可用或签名失败：丢弃证据，不复用旧图，不影响 stop。
- S3 不可用：T5AI 标记 motion unavailable，不生成靠近或拥抱承诺。
- display 失败：继续音频和停止能力。
- audio 失败：继续屏幕和按键；不得伪造已播放语音。
- button 失败：语音仍可用；设备状态明确报告 degraded。
- 资源校验失败：回退内置 idle。

## 8. 安全与隐私

- 共享密钥只存在未提交配置或设备安全存储。
- 日志不得记录原始密钥、完整用户语音、宠物原图或 Agent 原始提示词。
- JPEG 仅短时存在于 T5AI/Agent 临时缓冲区，处理后清理。
- 所有跨板请求都限制大小、TTL、时钟偏差和字段集合。
- ESP32-CAM 视觉事件不能铸造 consent token。

## 9. 第一阶段验收

必须同时满足：

1. T5AI 开机后无需 Agent 即显示 idle basic 表情。
2. 9 种 basic 状态均能显示，5 帧资源均可校验和轮播。
3. 本地提示音和麦克风 VAD 事件可工作。
4. 一段真实语音可经 ASR 形成 transcript，并获得 Agent 回复；ASR 失败时进入本地降级。
5. ESP32-CAM 只能通过签名 capture API 返回新 JPEG；重放和过期请求被拒绝。
6. CAM 证据进入 Gateway 后可追踪到 `evidence_id`，且未检测到人时不进入 `NOTICED`。
7. Agent 决策由 T5AI消费，Agent 无法直接向 S3 发动作。
8. 明确同意后，`invite_hug` 可令 GPIO17 SG90 动作；拒绝时不得动作。
9. T5 长按在 Agent/CAM 断开时仍能 stop + release。
10. 无距离/姿态传感器时，S3 必须拒绝自主移动。
11. T5、CAM、S3 和 Agent 的最小相关测试、构建全部通过。

## 10. 本阶段不包含

- HC-SR04 距离闭环和 25–45 cm 靠近停车；
- BNO055 抱起/倾倒检测；
- APDS9960 手势同意；
- 真实宠物 identity + 9×5 生成；
- Tuya Miniapp 产品体验与完整 DP（但 T5 云端语音所需的基础产品绑定和服务配置属于
  本阶段实施前置条件）；
- PRD Gate 4 的十轮靠近、十轮拥抱和五轮完整多模态验收。

这些能力必须在对应硬件接线确认后，以后续独立规格和测试计划实现。
