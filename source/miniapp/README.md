# HSHH Tuya 小程序

这是 HSHH P0 的 Ray.js 面板，不再是通用 DP 示例页。它提供：

- 文字交互与 MediaKit 语音识别（不可用时明确回退到文字）；
- 作用域明确的“靠近一点”和“邀请抱抱”同意，以及拒绝和醒目的立即停止；
- 默认关闭、用户可暂停的长期记忆，支持确认、纠正和删除；
- JPEG/PNG/WebP 宠物照片选择、9×5 形象包生成进度和真机部署；
- Agent 地址、用户/设备绑定与短时联调令牌配置。令牌不会写入源码或本地持久化。

## 安装与验证

```bash
npm install
npm run typecheck
npm run build
```

产物位于 `dist/tuya/`，也可直接在 TuyaOpen IDE 中打开本项目并预览或上传。
运行时声明了 `MediaKit 3.7.0`。Web/IDE 环境没有该能力时，录音按钮会提示使用
文字输入，不会伪造识别结果。

## 联调配置

在“设置”页填写：

1. Agent URL，例如同一受控局域网中的 `http://192.168.1.20:8787`；
2. 与 Agent `HSHH_PRINCIPAL_USER_ID` 一致的用户 ID；
3. 与 Agent `HSHH_PRINCIPAL_DEVICE_ID`、T5 `HSHH_LAN_ROBOT_ID` 一致的设备 ID；
4. 与 Agent `HSHH_USER_TOKEN` 一致的短时用户令牌。

生产发布时应由涂鸦云函数或受控 HTTPS 网关换取短时会话令牌；不要在小程序包中
硬编码长期 bearer token。设备侧使用不同的 `HSHH_DEVICE_TOKEN`，用户端无法调用
设备来源接口或伪造传感器证据。

## 安全边界

- 面板中的同意只生成短时、单用途的 `approach_short` 或 `invite_hug` 同意证据；
  它不携带 GPIO、PWM、轮速或舵机角度。
- “停止”会请求 Agent 向运动控制器下发高层 `stop`，界面同时提醒使用实体急停；
  网络失败不会被显示为已停止。
- 用户上传原图在后端接收并生成资源后即从临时内存删除；面板在任务创建成功后也
  立即清除 base64 原图状态。
- 记忆默认关闭；删除后为软删除且不再进入 Agent 上下文。

## 本地预览

`src/ty-shim.ts` 和 `src/devices/` 仅为 TuyaOpen IDE/Web 离线预览补齐面板运行环境；
检测到真实 `deviceId` 或 `groupId` 时会使用正常 SmartDeviceModel 初始化路径。业务交互
通过 `src/services/agentApi.ts` 的受认证 HTTP API 完成，不依赖模拟 DP 来声称真机动作。
