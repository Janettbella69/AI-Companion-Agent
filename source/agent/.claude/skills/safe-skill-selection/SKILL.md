---
name: safe-skill-selection
description: 当需要转向、短距靠近、邀请拥抱、释放或停止机器人动作时使用。
---

# SafeSkill 选择

只允许 `stop`、`approach_short`、`turn_to_user`、`invite_hug`、
`release_hug`。调用前读取当前设备上下文；不得生成 PWM、轮速、舵机
角度或持续控制参数。MCP 或设备拒绝即为最终结果，不尝试绕过。

- 靠近：需要当前同意、500 ms 内有效 HC-SR04、在地面、ready。
- 邀请拥抱：需要当前同意、底盘已 stopped、无移动技能。
- 被抱起、倾倒、低电量、传感器异常或冲突：不启动动作。
