# HSHH P0 实现与烧录状态

更新时间：2026-08-15。产品范围以 `HSHH-robot_PRD.md` v0.4 的全部 Must 需求为准。

## 当前结论

软件侧的 Agent、T5、ESP32-CAM、小程序和 ESP32-S3 安全控制骨架已经落入本项目并
通过各自构建/测试。T5 已完成真机烧录、Tuya BLE 手机热点配网、云激活、MQTT 上线
和断电式应用重刷后的自动回连验证。HC-SR04、BNO055、APDS9960 的真实驱动仍被硬件确认门禁锁住：
在模块版本、供电和最终接线确认前，ESP32-S3 默认构建故意返回
`safety_sensors_unavailable`，不会让“代码跑通”冒充“真机安全通过”。

因此目前可以安全烧录并验证屏幕、音频、按钮、相机、Agent、记忆、形象、签名 LAN
以及执行器停止/台架链路；不能在地面宣称已完成 PRD 17.1、17.2、17.6 的物理验收。
2026-08-16 用户决定本轮不做 HC-SR04 / BNO055 / APDS9960：不接线、不写驱动、
不解锁自主靠近。本轮验收收窄为三板安全闭环（看得见、听得见、停得住）。

## P0 功能映射

| 需求组 | 已落地的软件链路 | 真机门禁 |
|---|---|---|
| PROX 主动靠近 | 作用域同意、拒绝优先、SafeSkill 白名单、HMAC/TTL/防重放、启动/断线停止、500 ms 看门狗、MX1508 有界 PWM/刹车 | HC-SR04 与 BNO055 接线和读数未确认，因此默认不放行移动 |
| AVA 宠物外观 | JPEG/PNG/WebP 校验、真实身份图、确定性 9×5 包、原图清除、45 帧校验、T5 双槽原子切换、失败回退 | 需要用至少两张真实宠物图在烧录后的屏幕上验收 |
| AFF 情绪线索 | 结构化粗粒度假设、0.65 门槛、未知/冲突降级、自述与纠正优先、不把推测当同意或记忆 | 需要真实会话场景验收，不做诊断性声称 |
| MEM 长期记忆 | 默认关闭、候选确认、来源/时间、跨 Session SQLite 检索、纠正、软删除、暂停 | 需要按 PRD 17.4 完成五轮跨 Session 演示 |
| HUG 邀请拥抱 | 单用途同意、SG90 语义命令、只张开不夹紧、释放/停止抢占、屏幕和声音反馈 | SG90 机械限位及 BNO055 抱起/放下阈值未实测 |
| CHAR 角色表达 | 9 种×5 帧、短句角色约束、本地语义提示音、静默陪伴、拒绝后本场景不重复邀请 | 需确认扬声器音量和实体交互观感 |
| MM 多模态 | Web/MediaKit 文本语音、T5 VAD、ESP32-CAM 触发关键帧、5–15 秒证据窗口、证据 ID、过期/冲突丢弃、多通道效果 | 环境/动作传感三件套仍未接入 |
| AGT Agent 架构 | Claude Agent SDK 单 Agent、六组 MCP、项目 Skills、Session 恢复、原生工具沙箱、Provider 门禁、Perception 降级 | 生产 Provider 必须单独通过兼容性套件并填写服务端凭据 |

## 已生成的构建产物

- T5AI：`source/embedded/dist/HSHH-robot_1.0.0/HSHH-robot_QIO_1.0.0.bin`
- ESP32-S3 安全构建：`source/esp32-motion/.pio/build/yd_esp32_s3_safe/firmware.bin`
- ESP32-CAM：`source/esp32-cam/.pio/build/ai-thinker-esp32-cam/firmware.bin`
- Tuya 小程序：`source/miniapp/dist/tuya/`

产物只能烧到对应的已确认板卡；每次烧录前重新枚举串口，不能沿用旧的 `/dev/cu.*`。

## 烧录前必须填写但不得提交的配置

1. Agent `.env`：成对的用户/设备 token 与 user/device ID、consent secret、Provider，
   以及可选的 motion/camera URL 和不同的两个 LAN secret。
2. T5 `include/tuya_config_secrets.h`：独立设备 UUID/AuthKey；PID 绑定在
   `tuyaopen.project.ini`。这些值不得写入日志。
3. T5 `include/hshh_lan_secrets.h`：运动/相机主机与不同 secret、Agent 主机、
   device token、绑定 user ID。T5 Wi-Fi 由 Tuya App 通过 BLE 下发；该文件中的
   Wi-Fi 字段只供 ESP32-CAM 共享。
4. ESP32-S3 `include/secrets.h`：相同 Wi-Fi、robot ID 和 motion secret。
5. ESP32-CAM：使用 T5/Agent 对应的 camera secret；不得复用 motion secret。

所有 `user_id`、`device_id`/`robot_id` 必须一致；用户 token 与设备 token 必须不同。

## 当前自动验证结果

```text
Agent:       npm run typecheck && npm test       69/69 passed
MiniApp:     npm run typecheck && npm run build  passed
T5AI:       tos.py build                         passed
T5AI device: flash + BLE netcfg + cloud/MQTT     passed
ESP32-S3:   pio run -e yd_esp32_s3_safe         passed
ESP32-CAM:  pio run -e ai-thinker-esp32-cam     passed
```

这些结果证明代码可构建和软件契约通过，不替代 PRD 第 17 章的碰撞、距离、抱起、机械
限位、断网和多轮真机验收。

## T5 真机验证记录

- 板卡：`SPARKLEIOT_T5AI_DEV`；最终串口：`/dev/cu.usbserial-110`；可靠烧录波特率：
  `230400`。
- 2026-08-16 用户确认的当前串口映射：CAM=`/dev/cu.usbserial-10`，
  T5=`/dev/cu.usbserial-110`，ESP32-S3=`/dev/cu.usbmodem2101`。重新插拔后必须再枚举。
- 最终 QIO 固件 SHA-256：
  `00cc6612c1f80d2cad46aaecb6927444e3c4f09e603e31b06f91dc672cc849b9`。
- 先前的猫脸周期闪烁是故障重启：约 11.5 KB 的头像部署对象进入 8 KB 主线程栈，
  导致 `FAULT`。对象改为在 PSRAM 中按需分配后，重启循环消失。
- 两台手机拓扑已实测成功：手机 A 提供 2.4 GHz 兼容热点，手机 B 运行 Tuya App
  完成 BLE 配网。最终 USB CLI 状态为 `cloud_online`、Wi-Fi link up、activated、MQTT
  connected，`last_iot_error=0`。
- 清理调试追踪并再次烧录应用分区后，设备保留配网与激活数据并自动回连。连续状态采样
  的运行时间从 `31897 ms` 增长到 `45557 ms`，`reset=0`，未再次重启。

## 等待确认的传感器接线

候选方案为：HC-SR04 `TRIG=GPIO18`、`ECHO=GPIO21`（Echo 必须分压/电平转换到
不高于 3.3 V）；BNO055 与 APDS9960 共用 `SDA=GPIO8`、`SCL=GPIO9`；APDS9960
可选 `INT=GPIO47`。收到用户对模块版本、供电和这组接线的明确确认后，才启用真实
驱动、传感器健康状态、25–45 cm 停车与 held/tilted 本地门控。
