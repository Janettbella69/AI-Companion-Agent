# HSHH T5 轮次语音对话设计

> 日期：2026-08-16  
> 状态：已确认；实施计划见 `docs/superpowers/plans/2026-08-16-t5-turn-based-voice.md`  
> 前置：用户已确认模式 A（说一句、听一句）与云端路径（DashScope ASR + 现有 Qwen Agent + DashScope TTS）  
> PRD 基线：`docs/HSHH-robot_PRD.md` v0.4  
> 相关：`docs/superpowers/specs/2026-08-15-three-board-safe-loop-design.md` §5.1 中 `app_hshh_voice` 的描述由本文取代

## 1. 目标

在涂鸦 T5AI 上交付一条可演示的轮次口语闭环：

1. 用户对着 T5 说一句中文。
2. T5 用已有麦克风 PCM + VAD 切出这一句，上传给本机 Agent。
3. Agent 用 DashScope 转成文字，走现有 Qwen Agent 决策。
4. Agent 用 DashScope 把 `reply_text` 合成 PCM。
5. T5 从扬声器播出这句话。
6. 长按停止必须立刻停播，不等云端。

成功标准（第一刀）：对 T5 说「你好」，几秒内听到一句简短中文回复，屏幕表情跟着变；说「停」或长按，正在播放的语音立刻停止。

本阶段不做：全双工打断、豆包语音、T5 直连 DashScope、原始 PCM 落盘、用语音绕过同意策略。

## 2. 已冻结的产品原则

- 轮次对话，不是实时双工。同一时刻只处理一句：听 → 想 → 说。
- 密钥只留在 Agent。T5 固件不得出现 DashScope / 百炼 API Key。
- 主对话模型仍是现有 Qwen Agent（`HSHH_PROVIDER_ID=qwen`）。豆包只做视觉，不承担 ASR/TTS/闲聊。
- `play_sound` 继续只表示语义提示音（noticed / confirm / stop 等短音）。真正说话走新的 `play_speech`。
- `stop` / 长按释放仍是本地抢占：停电机、停扬声器、丢弃未播完的 TTS。
- 转写文字不能单独生成靠近或拥抱同意。ASR 失败不得伪造 transcript 或 consent。
- Agent 与 T5 日志不得打印完整 PCM、完整 Base64、设备 token 或云端密钥。转写最多记截断摘要。

## 3. 为什么 ASR/TTS 放在 Agent

三板安全设计原稿写过「T5 本地切音后自己做云端 ASR，再调 `/v1/interactions`」。第一刀改为 **T5 只传短 PCM，Agent 做 ASR 和 TTS**，原因：

- T5 已有到 Agent 的 Bearer 设备客户端，不必在固件里再塞一套百炼协议和密钥。
- Agent 已有 12 MiB 请求上限、证据网关、Policy Gate 和 effect 队列；语音证据可以复用 `t5_microphone`。
- 文件转写类 ASR 需要公网 URL；短句更适合 Agent 把 PCM 包成 WAV 后走同步 `qwen3-asr-flash`。

T5 仍然是设备协调节点：它切音、上传、拉 effect、播 PCM、本地停。它不持有云端语音密钥。

## 4. 端到端数据流

```text
用户说话
  -> T5 codec PCM + VAD_START/VAD_END
  -> PSRAM 环形缓冲（最长 8s，16-bit PCM）
  -> POST /v1/device/utterances  (device Bearer, raw PCM)
  -> Agent: 包 WAV -> DashScope qwen3-asr-flash
  -> 证据入库 (source=t5_microphone, media_ref=utterance_id, TTL)
  -> 现有 HshhAgent.interact（输入为转写，不是 PCM）
  -> DashScope CosyVoice HTTP TTS (pcm, 与 T5 采样率对齐)
  -> 内存短 TTL 语音块 + effect 队列 play_speech
  -> T5 GET /v1/device/effects
  -> T5 GET /v1/device/speech/{speech_id}
  -> tdl_audio_play 分片播放
```

并发规则：

| 当前状态 | 新的 VAD_START | 长按 / 本地 stop |
| --- | --- | --- |
| idle / listening | 开始缓冲这一句 | 清空缓冲，停播 |
| uploading / thinking | 忽略新语音（可打 listening 表情，不打断当前句） | 取消播放，丢弃未取的 speech |
| speaking | 忽略新语音（第一刀不做 barge-in） | 立即 `tdl_audio_play_stop` |

## 5. T5 设计

### 5.1 新模块 `app_hshh_voice`

独立于 `tuya_app_main.c`。职责：

- 注册为 `app_hshh_audio_set_frame_handler` 的 PCM 消费者。
- VAD_START：打开写入；丢掉上一句未完成缓冲。
- 写入 PCM 到 PSRAM；超过 8s 强制当作 VAD_END。
- VAD_END：冻结缓冲，交给 Agent 线程上传。最短有效句：约 300 ms；更短丢弃。
- 播放：消费 `play_speech`，按 TDL `frame_size` 分片 `tdl_audio_play`。
- 停止：`app_hshh_audio_stop()` 已有，voice 模块必须在本地 stop 路径上调用它。

不在 ISR/音频回调里做 HTTP。只拷贝 PCM；上传仍走现有 `hshh_agent` 工作线程（必要时加大该线程栈，HTTP body 当前 JSON 上限约 1400 字节，语音路径必须用单独的二进制请求）。

### 5.2 VAD 与第一刀保底

硬件 VAD 已接到 `speech_started` / `speech_ended` 事件，但短窗口实测可能 `vad_starts=0`。第一刀按这个顺序：

1. **主路径**：codec VAD_START / VAD_END。
2. **保底**：USB CLI `hshh_audio utterance [ms]`（默认 3000 ms，上限 8000）。录完自动上传。用于 VAD 尚未稳定时的联调，不改变按键同意语义。
3. **不做**：用单击按键当对讲键。单击仍只用于未过期邀请的明确同意。

能量 VAD 若在联调中证明比 CLI 更稳，可在实施计划里作为可选补丁，不作为本设计的成功门槛。

### 5.3 上传协议

`POST /v1/device/utterances`

- `Authorization: Bearer <HSHH_AGENT_DEVICE_TOKEN>`
- `Content-Type: application/octet-stream`
- `X-Hshh-Audio-Format: pcm_s16le`
- `X-Hshh-Sample-Rate: <tdl 报告的采样率，缺省 16000>`
- `X-Hshh-Channels: 1`
- `X-Hshh-Utterance-Id: <设备生成的短 id>`
- Body：原始 PCM，最大 512 KiB（8s × 16 kHz × 2 字节 × 单声道 = 256 KiB，留余量给 24 kHz）

响应 202：`{ "accepted": true, "utterance_id": "...", "expires_at": "..." }`  
过大、过短、未认证：4xx，T5 播放 `confused` 提示音，不重试风暴（最多 1 次）。

现有 `POST /v1/device/events` 的 `speech_started` / `speech_ended` 继续上报，供上下文使用；**转写不走这条 JSON 事件**。

### 5.4 播放协议

现有效果轮询增加一种 effect：

```json
{
  "type": "play_speech",
  "speech_id": "spch_...",
  "request_id": "...",
  "sample_rate": 16000,
  "format": "pcm_s16le",
  "duration_ms": 1800
}
```

T5：`GET /v1/device/speech/{speech_id}`，`Accept: application/octet-stream`，同一 Bearer。取回后按 `frame_size` 播放。取失败则退回 `play_sound=confused`，不把 cue 当成这句话的内容。

`play_sound` 与 `play_speech` 同时到达时：先停 cue，再播 speech。本地 stop 两者都停。

## 6. Agent 设计

### 6.1 新适配器 `DashScopeSpeechAdapter`

Node 内用 HTTPS，不引入 Python SDK，不把密钥写入仓库。

**ASR（同步，适合 ≤8s 短句）**

- 模型：`qwen3-asr-flash`
- 端点：DashScope 北京 multimodal-generation（与百炼文档一致）
- 输入：Agent 把 PCM 加上最小 WAV 头，再以 `data:audio/wav;base64,...` 提交
- 语言提示：`zh`
- 超时：8s
- 空文本 / HTTP 失败 → `status=failed`，`reason_code=asr_unavailable`，不调用 Agent 决策去「猜用户说了什么」

**TTS（一次性 HTTP，非流式）**

- 模型：`cosyvoice-v3-flash`
- 音色：固定一个中文系统音色（默认 `longanyang`；实施时若账号不可用，改同系列可用音色，不在 T5 配置）
- `format=pcm`，`sample_rate` 与 T5 实际上报值对齐（优先 16000）
- 文本：`reply_text`，截断到 200 字（决策合同上限 500，第一刀播短句）
- 超时：8s
- 失败：仍下发表情 + `play_sound`，不假装已经说话

**密钥**

- 新环境变量 `DASHSCOPE_API_KEY`（Agent `.env`，gitignored）
- 不得复用豆包 `ARK` 密钥
- 与 Qwen 对话用的 `ANTHROPIC_AUTH_TOKEN` 可能不是同一把 key；语音调用只使用 `DASHSCOPE_API_KEY`
- 未配置时：utterance 接口返回 503 `speech_not_configured`，T5 走 confused cue

### 6.2 编排，而不是让 T5 调两次云

`POST /v1/device/utterances` 在 Agent 进程内顺序执行：

1. 校验设备身份、大小、采样率、单飞（同一 `device_id` 已有进行中的 utterance 则 409 `utterance_in_flight`）。
2. ASR。
3. 把 transcript 写入 EventContextGateway：`source=t5_microphone`，`media_ref=utterance_id`，短 TTL（建议 60s），**不存原始音频**。
4. 调用现有 `HshhAgent.interact`，用户文本为转写结果；系统提示保持「reply_text 是对用户说的话」。
5. 对 `reply_text` 做 TTS。
6. 语音块进内存表（单设备最多 1 份，TTL 30s，GET 一次后删除）。
7. 入队 `set_expression`（若决策有）+ `play_speech`。`play_sound` 仅在 TTS 失败或明确只要短音时使用。

`HSHH_AGENT_TIMEOUT_MS` 默认 8s，不够覆盖 ASR+LLM+TTS。语音编排使用独立预算：全链路 25s；内部仍按步骤超时。这不放宽运动或视觉路径的 8s 默认值。

### 6.3 与 Perception MCP 的关系

现有 `transcribe_audio` 工具继续存在，供模型显式引用 `audio_ref`。第一刀 **不必** 等模型再调一次 ASR：HTTP 编排层已经转写完成。适配器实现可以：

- 若 `audio_ref` 仍在 TTL 内且已有 transcript，直接返回事实；
- 不再把 Doubao vision adapter 的 `transcribeAudio()` 空实现当成语音通路。

### 6.4 安全与隐私

- 原始 PCM 只在 Agent 堆上存活到 ASR 返回，随后释放。
- 合成 PCM 只为 T5 拉一次播放服务，超时删除。
- 日志字段：`utterance_id`、字节数、采样率、ASR 耗时、transcript 前 40 字、TTS 字节数。禁止 body dump。
- Policy Gate 不变：转写里的「过来抱抱」仍不能代替按钮同意。

## 7. 失败与降级

| 失败 | T5 表现 | Agent |
| --- | --- | --- |
| 无 DASHSCOPE_API_KEY | confused 短音 | 503，不调 Qwen |
| ASR 空/超时 | confused 短音，listening 表情 | 不 interact |
| Qwen 失败 | 已有 fallback 文案若 TTS 成功则播；否则短音 | 走现有 fallbackAgent |
| TTS 失败 | 表情 + confused/confirm 短音 | 决策仍可入队表情 |
| T5 取语音 404 | confused 短音 | TTL 过期视为正常 |
| 本地 stop | 立即静音 | 后续 GET 可 404 |

云端全挂时，设备仍能 basic 表情和本地停止。这与三板安全设计一致。

## 8. 明确不做（YAGNI）

- 全双工、说话打断 TTS（除本地 stop）
- 豆包 ASR/TTS
- T5 上的 DashScope SDK 或密钥
- 异步文件转写 + OSS 公网 URL
- 流式 TTS 边下边播（第一刀整段下载再播，短句足够）
- 小程序 MediaKit 作为 T5 扬声器的替代路径
- 把 utterance 当同意令牌
- 为语音改写运动策略或无传感器行走

## 9. 验证

1. Agent：mock DashScope 的单元测试（ASR 成功/空/超时、TTS 成功/失败、TTL、单飞 409、日志不含 raw audio）。
2. Agent：`npm run typecheck && npm run test`。
3. 真机：`hshh_audio utterance 3000` 说「你好」，确认扬声器有中文回复。
4. 真机：播放中长按，声音立刻停。
5. 若硬件 VAD 可用，再用自然说话走主路径，对比 CLI 保底。

不把「VAD 计数 > 0」当作语音功能的唯一验收；说话能回才算过。

## 10. 实施时会改到的地方（预览，不是计划）

- T5：`app_hshh_voice.c/.h`，`app_hshh_audio` 播放 PCM 流接口，`app_hshh_agent` 二进制 POST/GET，`app_hshh_effects` 消费 `play_speech`，`hshh_audio utterance` CLI。
- Agent：`DashScopeSpeechAdapter`、utterance/speech 路由、effect 类型、config/` .env.example`、测试。
- 不改 ESP32-S3 / ESP32-CAM 运动与视觉协议。
- 不把密钥写入 `tuya_config_defaults.h` 或会入库的头文件。

## 11. 规格自检

- 范围闭合：一条轮次中文对话，含停止；不含双工和豆包语音。
- 与既有架构一致：T5 协调、Agent 持密钥、effect 队列、Policy Gate、本地 stop。
- 与 2026-08-15 §5.1 的差异已写明：ASR/TTS 从「T5 调云」改为「Agent 调云」。
- 接口字段、TTL、大小上限、超时、失败码已给出，可直接拆实施计划。
- 未决项仅音色账号可用性（有后备：换同系列系统音色），不阻塞写计划。
