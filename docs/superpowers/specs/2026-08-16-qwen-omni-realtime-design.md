# HSHH 千问 Omni Realtime 全双工语音设计

> 日期：2026-08-16  
> 状态：已确认；待写实施计划  
> 前置：用户已确认方案 1（Agent 双 WebSocket 网关）、会话模式 A（CLI 开关）、工具挂进 Omni、Omni 会话内不跑 Claude Agent SDK 循环  
> PRD 基线：`docs/HSHH-robot_PRD.md` v0.4  
> 相关：`docs/superpowers/specs/2026-08-16-t5-turn-based-voice-design.md`（整句 utterance 保底，本文不取代）  
> 相关：`docs/superpowers/specs/2026-08-15-three-board-safe-loop-design.md`（Policy Gate、本地 stop、S3 否决权不变）

## 1. 目标

在涂鸦 T5AI 上交付一条可演示的 **全双工口语通话**：

1. CLI `hshh_omni start` 打开会话。
2. T5 持续把麦克风 PCM 推给本机 Agent；Agent 转给百炼 Qwen-Omni-Realtime。
3. 模型音频增量经 Agent 回到 T5 扬声器，边下边播。
4. 用户说话可以打断机器人播报。
5. Omni 可调用六个高层工具；Agent 过 Policy Gate 后才 `dispatchDeviceEffect`。口令「结束对话」走 `end_session`。
6. 长按立即停播、停轮，不等云端。
7. CLI `hshh_omni stop`、口令结束、或约 2 分钟空闲则关掉两边会话。

成功标准见 §9。

本阶段不做：摄像头进 Omni、改 S3/CAM 协议、改同意规则、上电常开麦克风、会话中跑 `HshhAgent.interact`。

## 2. 已冻结的产品原则

- 第一刀是可开关的通话，不是上电常开监听。
- 密钥只留在 Agent。T5 固件不得出现百炼 / DashScope API Key。
- 豆包只做视觉，不承担 ASR、TTS、闲聊、Omni。
- Omni 会话内 **不跑 Claude Agent SDK 循环**（不调用 `HshhAgent.interact`）。这是对「核心认知只有一个 SDK Agent」的显式例外，仅限本会话。记忆 MCP、头像、StructuredOutput、研究子代理本刀不进 Omni。
- 工具由 Agent **宿主**执行，走现有 `evaluateSkillRequest` 与 `dispatchDeviceEffect`。Omni 看不到 PWM、轮速、GPIO、舵机角度、设备 URL。
- 语音转写不能单独签发靠近或拥抱同意。无有效令牌时只口头邀请并 `offer_consent`，电机不动。
- `stop` / 长按仍是本地抢占，并通知 Agent 取消当前 Omni 回复、下发 `stop` 技能。
- 会话中真人说话走设备 WS 的 PCM 分片，不走 `play_speech` 整段下载。`play_sound` 仍只表示短提示音。
- 未打开 Omni 时，整句 `POST /v1/device/utterances` 保底仍然有效。
- 日志不得打印完整 PCM、完整 Base64、设备 token 或云端密钥。转写最多记前 40 字。

## 3. 为什么是双 WebSocket 网关

T5 现有 HTTP 客户端适合整句上传，不适合全双工打断。百炼 Omni 只提供 WebSocket / WebRTC，不能塞进现有 Anthropic Messages 循环。

因此：

```text
T5 麦 PCM 16k ──WS──► Agent ──WS──► 百炼 Omni Realtime
T5 喇叭 PCM     ◄──WS── Agent ◄──WS── 模型音频增量

Omni function_call ──► Agent Policy Gate ──► dispatchDeviceEffect
                         ├─ stop / safe_skill（与现网 Qwen Agent 相同：LanMotionAdapter）
                         └─ set_expression / play_sound / offer_consent ──► T5 HTTP effects
function_call_output 再回 Omni，然后 response.create 继续说话
```

T5 用现有设备 Bearer 连局域网；Agent 用 `DASHSCOPE_API_KEY`（若未单独配置，沿用现有 Qwen provider token 回退，与 `UtterancePipeline` 相同）连百炼。

不采用：T5 直连百炼、T5 HTTP 分片冒充双工、Omni 转写后再跑一轮 `HshhAgent.interact`。

## 4. 端到端会话生命周期

| 阶段 | T5 | Agent | 百炼 |
| --- | --- | --- | --- |
| 空闲 | 不推麦流；utterance 保底可用 | 无 Omni 会话 | 无连接 |
| CLI start | 连 `ws://<agent>/v1/device/omni`，发送 `session.start` | 校验 Bearer；每个 `device_id` 同时只一条；再连云端 | 新建 Realtime 会话 |
| 通话 | 持续上行二进制 PCM；播下行 PCM；HTTP 仍轮询 effects | 转发音频；处理工具；idle 计时 | server / semantic VAD、可打断 |
| 用户插话 | 不停上行 | 把云端打断后的新音频下发；丢弃旧播放缓冲 | `interrupt_response` |
| 长按 | 本地 `tdl_audio_play_stop`；发 `barge_in`；结束会话 | 取消当前回复；dispatch `stop`；关云端 | 关闭 |
| CLI stop / 口令结束 / 120s 空闲 | 停上行、停播、关 WS | 关云端 | 关闭 |
| 云端失败 | `confused` 短音，回到空闲 | 关设备 WS，不重试风暴 | — |

空闲计时：距「设备上行 PCM」或「云端音频/文本/工具事件」最近一次的时间。模型正在说话不算空闲。超时默认 120000 ms（`HSHH_OMNI_IDLE_MS`）。

会话中 `POST /v1/device/utterances` 返回 409 `omni_session_active`。第二路设备 WS 同样 409 / 关闭。

## 5. T5 设计

### 5.1 新模块 `app_hshh_omni`

独立于 `app_hshh_voice`（整句缓冲）和 `app_hshh_agent`（HTTP）。职责：

- CLI 打开/关闭会话状态。
- 独立线程跑 WebSocket：连 Agent、发控制 JSON、收发二进制 PCM、处理 ping。
- 麦回调里 **只拷贝** 到上行环形缓冲，禁止在音频回调里做网络。
- 下行环形缓冲按 `tdl_audio` 的 `frame_size` 调用播放。
- 会话期间接管 `app_hshh_audio_set_frame_handler`；结束时交回 voice 模块。
- 会话期间禁止整句 utterance 上传。

需要给 `app_hshh_audio` 增加 **分片播放** 接口（例如 `app_hshh_audio_play_pcm_chunk`）。现有 `app_hshh_audio_play_pcm` 仍用于 cue 和 utterance 整段。

### 5.2 连接与 CLI

- URL：现有 Agent 主机与端口，路径 `/v1/device/omni`。
- 握手：`Authorization: Bearer <HSHH_AGENT_DEVICE_TOKEN>`，与 HTTP 相同。
- 客户端：SDK `websocket_client` 指向局域网 Agent，**不用**涂鸦云 `websocket_transporter`。若该客户端不能对任意主机建连，则在同一套 API 上做局域网封装，不引入第三套协议。
- CLI：`hshh_omni start` / `hshh_omni stop`。不占用单击同意键。
- 连上后必须先收到 `session.started` 再开始持续上行；8 秒内收不到则 `confused`、回到空闲。
- 心跳：Agent 每 15 s ping；T5 连续两次未响应则 Agent 关会话。T5 侧读超时同样结束本地会话。

### 5.3 设备 WS 帧

控制用 **文本 JSON**（字段 snake_case），音频用 **二进制原始 `pcm_s16le`**。方向即语义：T5→Agent 二进制 = 麦；Agent→T5 二进制 = 喇叭。二进制帧无额外头。单帧上限 8 KiB。建议 20–60 ms 一包；回调更大则原样转发，不要再合并超过 60 ms。

T5 → Agent 文本：

```json
{ "type": "session.start", "sample_rate": 16000, "channels": 1, "format": "pcm_s16le" }
{ "type": "session.stop", "reason": "cli" }
{ "type": "barge_in", "reason": "local_stop" }
```

`session.stop.reason`：`cli` | `idle_local` | `local_stop`。  
`barge_in` 在长按路径上发送；随后仍走 `session.stop`。

Agent → T5 文本：

```json
{ "type": "session.started", "session_id": "omni_...", "play_sample_rate": 16000 }
{ "type": "session.ended", "reason_code": "client_stop" }
{ "type": "error", "reason_code": "omni_unavailable" }
```

`reason_code` 闭合集：`client_stop`、`idle_timeout`、`omni_not_configured`、`omni_unavailable`、`omni_unauthorized`、`omni_session_active`、`protocol_error`。

### 5.4 播放与打断

- Agent 向 Omni 申请 16 kHz 输出，与 T5 麦对齐。若云端只给 24 kHz，Agent 重采样后再发；固件不重采样。
- 下行抖动缓冲目标 240 ms（允许 200–400 ms）。积压则丢最旧数据。
- 上行积压超过约 100 ms 则丢最旧，避免越拖越晚。
- 播放期间 **继续上行** 麦克风，依赖板上 AEC 与云端打断。第一刀不做「播报时静音上行」。
- 长按：`app_hshh_audio_stop()` → 清空下行缓冲 → `barge_in` + `session.stop` → 现有 effects 本地停轮通知。不等待云端确认。

### 5.5 与效果队列

现有 `hshh_agent` 工作线程在 Omni 会话中 **继续** `GET /v1/device/effects`。会话中忽略新的 `play_speech`（若仍入队则 ack 并丢弃，避免与 WS 抢喇叭）。`set_expression`、`play_sound`、`offer_consent`、`safe_skill` 转发语义不变。

## 6. Agent 设计

### 6.1 `OmniRealtimeSession`

挂在现有 Node HTTP 服务上（同一端口）。新增 `ws` 依赖做设备 WS 服务端；连百炼可用 Node 22 全局 `WebSocket`。

每个已认证 `device_id` 同时一条会话。升级失败：无 token → 关闭；已有会话 → 关闭并 `omni_session_active`。

设备 WS 打开后：

1. 等待 `session.start`（超时 5 s → `protocol_error`）。
2. 用 `DASHSCOPE_API_KEY` 连接  
   `HSHH_OMNI_WS_URL`（默认 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`）  
   `?model=<HSHH_OMNI_MODEL>`。
3. `session.update`：音频格式、VAD、instructions、tools。`enable_search` 必须为 false（与 tools 互斥）。
4. 向 T5 发 `session.started`。
5. 转发 PCM；处理 function_call；idle 超时则双边关闭。

模型默认 `qwen3.5-omni-flash-realtime`。音色默认 `Chelsie`（`HSHH_OMNI_VOICE` 可改同系列系统音色）。VAD：`semantic_vad`（3.5 系列）；`interrupt_response: true`。打开输入转写，摘要写入 EventContextGateway：`source=t5_microphone`，`media_ref=session_id`，TTL 60 s，不存原始音频。

`instructions`：缩短版 HSHH 人设——短句中文、温和、不诊断；物理动作只通过工具；语音不是同意；被拒时说明要点按键/手势，不得改口绕过。

未配置密钥：设备 WS 立即 `omni_not_configured` 并关闭。

### 6.2 工具：模型只出名字，信封由宿主填

`session.update.tools` 仅这六个。参数禁止出现 `actor_user_id`、`device_id`、`expires_at`、以及任何硬件/URL 字段。

| 工具 | Omni 参数 | 宿主行为 |
| --- | --- | --- |
| `stop` | 无 | 与现网紧急停相同：`createSafeSkillCommand("stop")` + `dispatchDeviceEffect`。不自动挂断通话。 |
| `end_session` | 无 | 口令结束（如「结束对话」）。回 `function_call_output` 成功，允许紧接着的一句话音播完（最多等 `response.done` 或 3 s），然后关双边 WS。关闭前也 dispatch `stop`，避免挂断后轮子还在转。 |
| `request_safe_skill` | `{ "skill": <SAFE_SKILLS> }` | 填当前 principal 信封；`evaluateSkillRequest`；`approach_short` / `invite_hug` 必须已有未过期、作用域匹配的 Gateway 令牌，否则拒绝并 `enqueueConsentOffer`，**不创造令牌** |
| `set_expression` | `{ "expression": <EXPRESSIONS>, "intensity"?: number }` | effect 队列 |
| `play_sound` | `{ "sound": <现有 cue 枚举> }` | effect 队列 |
| `get_skill_status` | 无 | 只读当前 DeviceContext / 运动状态 |

`request_id` 由宿主生成：`omni_<session_id>_<call_id>`，避免与 HTTP 轮次撞车。  
`SAFE_SKILLS` 与 `EXPRESSIONS` 必须与 `source/agent/src/domain/contracts.ts` 同一份枚举。

动作分发 **复用** 现有 `dispatchDeviceEffect`（与 Qwen Agent 相同：`safe_skill` 走 `LanMotionAdapter`，表情/音效走 effect 队列）。本刀不把路径改成「必须经 T5 再转发 S3」，也不把 Omni 接到 S3。

工具结果：`conversation.item.create` `function_call_output`（JSON 字符串，含 `status`、`reason_code`），然后 `response.create`。拒绝也要回，让模型说话，而不是换工具绕过 Gate。未知工具名 → `protocol_error` 类结果，不 dispatch。

### 6.3 音频转发

- 设备上行：校验 `pcm_s16le`、单声道；采样率以 `session.start` 为准，缺省 16000。非 16 kHz 时 Agent 重采样到 Omni 输入 16 kHz。
- 发给 Omni：按 DashScope 事件 `input_audio_buffer.append`（Base64 仅存在于云端帧；日志禁止打印）。
- Omni 下行音频：若 24 kHz，线性重采样到 `play_sample_rate`（与 T5 `session.start.sample_rate` 相同，通常 16000），再以二进制发给 T5。
- 收到云端打断或设备 `barge_in`：清空待发下行队列，并 `response.cancel`（若协议支持）。

PCM 只在进程堆上作环形缓冲，会话结束释放。不写盘。

### 6.4 配置

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 现有 Qwen token 回退 | 云端鉴权 |
| `HSHH_OMNI_MODEL` | `qwen3.5-omni-flash-realtime` | 模型名 |
| `HSHH_OMNI_WS_URL` | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime` | 云端 WS 基址 |
| `HSHH_OMNI_VOICE` | `Chelsie` | 系统音色 |
| `HSHH_OMNI_IDLE_MS` | `120000` | 空闲关会话 |

不把密钥写入固件头文件或会入库的示例（示例文件继续用占位符）。

### 6.5 日志

`HSHH omni {session_id, device_id, event, bytes, sample_rate, tool, reason_code, transcript_preview}`。  
`event` 如 `session_open`、`cloud_open`、`tool_call`、`tool_denied`、`barge_in`、`idle_close`、`cloud_error`。禁止 body dump。

## 7. 失败与降级

| 失败 | T5 | Agent |
| --- | --- | --- |
| 无密钥 | confused，空闲 | `omni_not_configured`，不连云 |
| 云端连不上 / 欠费 / 被踢 | confused，空闲 | `omni_unavailable`，关设备 WS，不重试风暴 |
| 设备 WS 掉线 | 本地停播，空闲 | 关云端会话 |
| 工具拒绝 | 可能听到模型解释；电机不动 | `function_call_output` 带原因码 |
| 无同意的靠近/拥抱 | 邀请按键（`offer_consent`） | Gate 拒绝 |
| 长按 | 立刻静音停轮 | `stop` + 关会话 |
| 协议坏帧 | 结束会话 | `protocol_error` |
| 云端全挂 | basic 表情 + 本地停止 | 无 Omni |

## 8. 明确不做（YAGNI）

- 摄像头 / `input_image_buffer.append` / 连续视频流
- Omni 会话中的 `HshhAgent.interact`、记忆 MCP、头像、StructuredOutput、联网搜索
- 豆包实时语音或豆包 ASR/TTS
- T5 持有百炼密钥，或使用涂鸦云 websocket 作为 Agent 通道
- 上电常开麦克风；`noticed` 自动开会话
- 用转写或 Omni 工具参数伪造同意令牌
- 改 ESP32-S3 / ESP32-CAM 线协议、HMAC、安全状态机
- 把 PWM 等原始执行器参数加入 Omni tools
- 第一刀做播报静音上行或自适应回声消除算法（只用板上 AEC）
- 多设备同时 Omni（实现上按 `device_id` 互斥即可，不测多机）
- 把「结束对话」做成本地离线热词；口令结束只通过 Omni `end_session` 工具

## 9. 验证

### 9.1 Agent（CI，不打真实百炼）

假设备 WS + 假 Omni WS：

- Bearer 拒绝；无密钥 `omni_not_configured`
- 单 `device_id` 互斥
- PCM 上行出现在云端 append；云端音频（含 24 kHz）重采样后回到设备
- idle 超时双边关闭
- `request_safe_skill approach_short` 无同意 → 拒绝 + consent offer，不 dispatch 运动
- `stop` → dispatch `stop`，不关会话
- `end_session` → dispatch `stop`，`response.done` 或 3 s 后关双边
- 未知工具不 dispatch
- 欠费/云端关闭 → 设备收到 `omni_unavailable`
- 日志不含 raw PCM / key / token

然后：`npm run typecheck && npm run test`。

### 9.2 真机验收

1. `hshh_omni start` 后说「你好」，很快听到中文回复；表情可变。
2. 播报中插话：旧语音停，模型改听新话。
3. 说「停下」：Agent dispatch `stop`，喇叭停。
4. 无同意说「过来」：只听到邀请，电机不动。
5. 长按：立刻静音；会话结束或至少取消当前回复并停轮。
6. `hshh_omni stop` 或约 2 分钟空闲：两边 WS 断开，麦不再上传。
7. 会话外 `hshh_audio utterance` 保底仍可用。
8. 日志无 PCM、无 Key、无设备 token。

不把本地 codec VAD 计数当作本功能验收。

## 10. 实施时会改到的地方（预览，不是计划）

- Agent：`OmniRealtimeSession`、PCM 重采样、WS 挂到 `httpServer`、config / `.env.example`、假 WS 测试。可复用 Policy Gate 与 `dispatchDeviceEffect`，不复制一套运动协议。
- T5：`app_hshh_omni.c/.h`、音频分片播放、CLI、长按与 voice 模块的 handler 交接。
- 不改 ESP32-S3 / ESP32-CAM 固件。
- 不把密钥写入 `tuya_config_defaults.h` 或会入库的头文件。

## 11. 规格自检

- 范围闭合：可开关全双工语音 + 六个高层工具（含 `end_session`）；不含视觉进 Omni、不含 SDK 循环。
- 与既有安全一致：密钥在 Agent、Gate 同意规则、本地 stop、S3 最终否决、日志红线。
- 与轮次语音的关系已写明：并存，会话中 409，会话外 utterance 保底。
- 与「单一 SDK Agent」的冲突已写明为例外，不是漏写。
- 接口：路径、帧类型、reason_code、配置项、超时、缓冲、工具参数均已闭合，可拆实施计划。
- 无 TBD / TODO。音色账号不可用时换同系列系统音色，不阻塞写计划。
