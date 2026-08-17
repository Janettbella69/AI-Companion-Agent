# HSHH LAN v1 协议

## 已确认拓扑

```text
                            Tuya Cloud / Agent service
                                      |
                                      v
Tuya T5AI  <---------- 2.4 GHz Wi-Fi LAN ---------->  ESP32-CAM
   |                                                        |
   | 高层 SafeSkill                                         `- 触发式 JPEG
   v
YD-ESP32-23 / ESP32-S3-WROOM-1-N16R8
   `- MX1508、TT 电机、SG90、HC-SR04、BNO055、APDS9960
```

- T5AI：联网、云端 Agent、语音、屏幕、声音与整机协调。
- ESP32-CAM：OV2640 触发式关键帧；P0 不持续上传视频。
- YD-ESP32-23（ESP32-S3-WROOM-1-N16R8）：唯一运动与确定性安全控制器；
  板卡约束与待确认接线见 `docs/esp32-s3-motion-hardware.md`。
- 三块板连接同一个受信任的 2.4 GHz 局域网。优先使用 DHCP 地址保留；可同时发布
  `hshh-camera.local` 和 `hshh-motion.local` 作为 mDNS 名称。

## 安全边界

1. Agent 只能请求 `stop`、`approach_short`、`turn_to_user`、
   `invite_hug`、`release_hug`。
2. LAN 消息不得包含 GPIO、PWM、轮速、电机方向、舵机角度、原始提示词、用户身份或
   consent token。
3. ESP32-S3 必须重新检查命令期限、命令 ID、防重放、姿态、距离、电量、舵机健康和
   当前状态；服务器允许不等于执行器必须执行。
4. `stop` 和 `release_hug` 是逃生动作，不因普通状态或命令期限而拒绝。
5. 运动期间本地安全循环不得依赖 Wi-Fi 调度。控制链路或运动心跳超过 500 ms
   未更新时，ESP32-S3 必须立即停机并保持停止状态。
6. 两个 ESP32 节点使用不同的随机共享密钥；密钥只放在本地未提交配置或设备安全
   存储中。

## 消息认证

请求和响应都带以下头：

```text
X-HSHH-Timestamp: <ISO 8601 UTC>
X-HSHH-Signature: hex(HMAC-SHA256(shared_secret, timestamp + "\n" + exact_body))
```

- 接收端按收到的原始 body 验签，不先重新序列化 JSON。
- 时间与本地可信时钟相差超过 5 秒时拒绝。
- `command_id` 同时作为 `Idempotency-Key`；相同 ID 只能返回原结果，不得二次执行。
- P0 可在受控 WPA2/WPA3 局域网使用 HTTP + HMAC。离开受控网络后应升级为 TLS
  或基于设备证书的通道。

## ESP32-S3 动作接口

### `POST /v1/motion/commands`

请求示例：

```json
{
  "protocol_version": "hshh-lan-v1",
  "target": "motion_controller",
  "command_id": "8a37b6e9-...",
  "robot_id": "robot-1",
  "skill": "approach_short",
  "issued_at": "2026-08-14T20:00:00.000Z",
  "expires_at": "2026-08-14T20:00:01.500Z",
  "expected_device_state": "ready"
}
```

响应示例：

```json
{
  "protocol_version": "hshh-lan-v1",
  "command_id": "8a37b6e9-...",
  "status": "accepted",
  "reason_code": "motion_command_accepted",
  "observed_at": "2026-08-14T20:00:00.080Z",
  "safety_state": "ready",
  "active_skill": "approach_short"
}
```

`status` 只能是 `accepted`、`rejected`、`completed`、`stopped` 或 `failed`。

### 状态与心跳

ESP32-S3 应提供只读状态接口，或由 T5AI 在受信 LAN 上接收状态推送。运动心跳至少包含：

- 当前 `command_id` 与递增序号；
- `safety_state`、`active_skill`、`motion_stopped`；
- 新鲜的 `distance_cm`、姿态、电量和舵机健康状态；
- 单调时钟采样时间。

心跳是状态证明，不延长已经过期的云端命令，也不能绕过本地停止条件。

## ESP32-CAM 触发拍照接口

### `POST /v1/camera/captures`

请求只包含 `capture_id`、`robot_id`、`issued_at`、`expires_at` 和触发原因代码。
成功响应使用 `Content-Type: image/jpeg` 返回一张 OV2640 JPEG，并带：

```text
X-HSHH-Capture-Id
X-HSHH-Observed-At
X-HSHH-Timestamp
X-HSHH-Signature
```

响应签名覆盖时间戳、换行符和 JPEG 原始字节。失败时不得返回旧照片冒充当前关键帧。
T5AI/Agent Gateway 只在存在事件、用户请求或诊断需求时拍摄，并沿用现有 evidence ID、
TTL 和临时图片清理规则。

## 当前实现状态

- Agent 服务已实现 ESP32-S3 动作接口客户端、私网 URL 限制、请求签名、响应验签、
  超时、响应大小限制和命令 ID 校验。
- T5AI 已实现独立 Wi-Fi STA 与签名 HTTP 客户端：启动/重连时先验签读取状态，
  从已认证响应引导 UTC，再发送并确认 `stop`；空闲时每 5 秒验签轮询状态。
  非逃生动作仅在认证链路 ready 时入队，排队超过 1 秒即丢弃。
- 未配置 `HSHH_MOTION_CONTROLLER_URL` 与 `HSHH_MOTION_SHARED_SECRET` 时保持
  fail-closed，动作返回 adapter unavailable。
- ESP32-S3 已实现 HMAC 服务端、严格消息校验、内存防重放、MX1508 驱动、短时刹车、
  500 ms 看门狗和默认 fail-closed 安全门控。传感器尚未确认时只允许停止/释放逃生
  动作；无传感器台架测试仅存在于显式 bench 构建且还需要串口短时解锁。
- ESP32-CAM 已实现独立密钥 HMAC、可信时钟、严格五字段请求、TTL、限频、内存防重放、
  新鲜帧抓拍与 JPEG 原始字节响应签名；不再暴露无鉴权抓拍或兼容动作路由。
- ESP32-S3 的 HC-SR04、BNO055、APDS9960 驱动仍等待用户确认接线引脚，因此保持
  fail-closed，尚未写入或启用。
