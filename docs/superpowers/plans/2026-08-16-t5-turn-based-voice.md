# T5 Turn-Based Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让涂鸦 T5AI 说一句中文、听到一句中文回复：T5 上传短 PCM，Agent 用 DashScope ASR + 现有 Qwen + DashScope TTS，再经 effect 队列把 PCM 播出来；长按立即停播。

**Architecture:** T5 只做切音、上传、拉 effect、播 PCM 和本地 stop。ASR/TTS 密钥与编排留在 Agent。`POST /v1/device/utterances` 校验后立刻 202，后台顺序执行 ASR → 证据入库 → `HshhAgent.interact` → TTS → 内存语音块 + `play_speech`。T5 已有的 effects 轮询负责取回并播放。不要让 T5 同步等完 25s 云端链路（现有 HTTP 超时只有 3500ms）。

**Tech Stack:** Node 22 + TypeScript（`source/agent`，`node --import tsx --test`）、DashScope HTTPS（`qwen3-asr-flash`、`cosyvoice-v3-flash`）、TuyaOpen T5AI C（`tdl_audio`、`http_client_interface`、PSRAM 缓冲）。

## Global Constraints

- Spec：`docs/superpowers/specs/2026-08-16-t5-turn-based-voice-design.md`
- 密钥只在 Agent `.env` 的 `DASHSCOPE_API_KEY`；不得写入 T5 固件、`tuya_config_defaults.h`、会入库的头文件或日志
- 不得复用豆包 `HSHH_DOUBAO_API_KEY`；不得把 `ANTHROPIC_AUTH_TOKEN` 当成语音 key
- 主对话仍走现有 Qwen Agent；豆包只做视觉
- `play_sound` 只表示短提示音；真人说话走 `play_speech`
- 转写不能单独生成靠近/拥抱同意；ASR 失败不得伪造 transcript
- 禁止日志打印完整 PCM、Base64、device token、DashScope key；转写最多 40 字
- 不改 ESP32-S3 / ESP32-CAM 运动与视觉协议，不改 Policy Gate 同意规则
- 第一刀不做全双工 barge-in、不做 T5 直连百炼、不做 PCM 落盘
- T5 单击按键仍只用于未过期邀请的同意，不对讲
- Agent 工作目录：`projects/HSHH-robot/source/agent`。验证：`npm run typecheck && npm run test`
- T5 工作目录：`projects/HSHH-robot/source/embedded`。构建：在 TuyaOpenSDK 环境 `export.sh` 后 `cd source/embedded && tos.py build`。烧录端口 `/dev/cu.usbserial-110`，`tos.py flash -p /dev/cu.usbserial-110 -b 230400`
- 现有 Agent JSON HTTP 超时 `HSHH_AGENT_HTTP_TIMEOUT_MS=3500`、响应上限 `HSHH_AGENT_MAX_RESPONSE_BYTES=12288`。语音下载必须用更大缓冲（512 KiB）和更长超时（8000ms），不要把 JSON 路径也放到 512 KiB
- 未配置 `DASHSCOPE_API_KEY` 时 utterance 返回 503 `speech_not_configured`
- 用户未明确要求 git commit 时，跳过各任务的 Commit 步骤

## File Structure

Agent（先做，curl 即可测通）：

- Create: `source/agent/src/speech/pcmWav.ts` — PCM s16le → 最小 WAV
- Create: `source/agent/src/speech/dashscopeSpeechAdapter.ts` — ASR + TTS HTTPS
- Create: `source/agent/src/speech/speechStore.ts` — 单设备一份 PCM，TTL 30s，GET 一次删除
- Create: `source/agent/src/speech/utterancePipeline.ts` — 单飞、ASR、证据、interact、TTS、入队
- Modify: `source/agent/src/config.ts`、`source/agent/.env.example`
- Modify: `source/agent/src/device/deviceEffectQueue.ts` — `enqueuePlaySpeech`
- Modify: `source/agent/src/server/httpServer.ts` — `POST /v1/device/utterances`、`GET /v1/device/speech/:id`
- Modify: `source/agent/src/index.ts` — 接线
- Test: `source/agent/test/pcmWav.test.ts`、`dashscopeSpeechAdapter.test.ts`、`speechStore.test.ts`、`utterancePipeline.test.ts`，并扩展 `deviceEffectQueue.test.ts`、`httpServer.test.ts`

T5（Agent 测通后再做）：

- Create: `source/embedded/include/app_hshh_voice.h`、`source/embedded/src/app_hshh_voice.c`
- Modify: `app_hshh_audio.c/.h` — `play_pcm`、采样率查询
- Modify: `app_hshh_agent.c/.h` — 二进制 POST/GET、上传就绪句、应用 `play_speech`
- Modify: `app_hshh_effects.c` — 本地 stop 清语音缓冲
- Modify: `app_hshh_provisioning.c` — `hshh_audio utterance [ms]`
- Modify: `app_hshh_lan_config.h` — 语音专用超时/响应上限
- `CMakeLists.txt` 已 `aux_source_directory(src)`，新 `.c` 会自动编入

不改：`perceptionServer.ts` 的 `transcribe_audio` MCP（编排层已转写；第一刀不需要模型再调一次 ASR）、运动/视觉适配器。

---

### Task 1: WAV 封装与语音配置

**Files:**
- Create: `projects/HSHH-robot/source/agent/src/speech/pcmWav.ts`
- Create: `projects/HSHH-robot/source/agent/test/pcmWav.test.ts`
- Modify: `projects/HSHH-robot/source/agent/src/config.ts`
- Modify: `projects/HSHH-robot/source/agent/.env.example`

**Interfaces:**
- Consumes: 现有 `loadConfig(env, cwd)`、`optionalSecret`
- Produces:
  - `wrapPcmS16LeAsWav(pcm: Buffer, sampleRate: number, channels?: number): Buffer`
  - `AgentServiceConfig.dashscopeApiKey?: string`
  - `AgentServiceConfig.dashscopeBaseUrl: string`（默认 `https://dashscope.aliyuncs.com/api/v1`）

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { wrapPcmS16LeAsWav } from "../src/speech/pcmWav.js";
import { loadConfig } from "../src/config.js";

test("wrapPcmS16LeAsWav writes a 44-byte header and preserves PCM", () => {
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const wav = wrapPcmS16LeAsWav(pcm, 16000, 1);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("loadConfig reads DASHSCOPE_API_KEY without using the Doubao key", () => {
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      DASHSCOPE_API_KEY: "sk-speech-test",
      HSHH_DOUBAO_API_KEY: "ark-not-for-speech",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  assert.equal(config.dashscopeApiKey, "sk-speech-test");
  assert.equal(config.dashscopeBaseUrl, "https://dashscope.aliyuncs.com/api/v1");
  assert.equal(config.doubaoVisionApiKey, "ark-not-for-speech");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/pcmWav.test.ts`

Expected: FAIL，模块不存在或 `dashscopeApiKey` 不在 config 上。

- [ ] **Step 3: Write minimal implementation**

`pcmWav.ts`：标准 PCM WAV 头（`RIFF`/`WAVE`/`fmt `/`data`），`bits=16`，`blockAlign = channels * 2`，`byteRate = sampleRate * blockAlign`。`sampleRate` 非法（非 8000/16000/22050/24000）或 `channels !== 1` 时抛 `RangeError`。

`config.ts`：在 `AgentServiceConfig` 增加可选 `dashscopeApiKey` 与必填 `dashscopeBaseUrl`。`loadConfig` 里：

```ts
dashscopeBaseUrl:
  env.HSHH_DASHSCOPE_BASE_URL?.trim() ||
  "https://dashscope.aliyuncs.com/api/v1",
```

之后 `const dashscopeApiKey = optionalSecret(env.DASHSCOPE_API_KEY)`，有值才赋给 `config.dashscopeApiKey`。不要从 `ANTHROPIC_AUTH_TOKEN` 或 `HSHH_DOUBAO_API_KEY` 回填。

`.env.example` 追加（不要填写真实 key）：

```
# DashScope speech (ASR/TTS) for T5 turn-based voice. Never copy into firmware.
# Do not reuse HSHH_DOUBAO_API_KEY or ANTHROPIC_AUTH_TOKEN.
DASHSCOPE_API_KEY=
# HSHH_DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/api/v1
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/pcmWav.test.ts && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add source/agent/src/speech/pcmWav.ts source/agent/test/pcmWav.test.ts source/agent/src/config.ts source/agent/.env.example
git commit -m "$(cat <<'EOF'
feat: add PCM WAV wrapper and DashScope speech config

EOF
)"
```

仅在用户要求提交时执行。

---

### Task 2: DashScope ASR/TTS 适配器

**Files:**
- Create: `projects/HSHH-robot/source/agent/src/speech/dashscopeSpeechAdapter.ts`
- Create: `projects/HSHH-robot/source/agent/test/dashscopeSpeechAdapter.test.ts`

**Interfaces:**
- Consumes: `wrapPcmS16LeAsWav`；`fetchImpl?: typeof fetch`
- Produces:

```ts
export type SpeechTranscribeResult =
  | { status: "completed"; transcript: string }
  | { status: "failed"; reason_code: string };

export type SpeechSynthesizeResult =
  | { status: "completed"; pcm: Buffer; sampleRate: number }
  | { status: "failed"; reason_code: string };

export class DashScopeSpeechAdapter {
  constructor(options: {
    apiKey: string;
    baseUrl: string;
    timeoutMs?: number;
    asrModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  });
  transcribePcm(input: {
    pcm: Buffer;
    sampleRate: number;
    channels: number;
  }): Promise<SpeechTranscribeResult>;
  synthesizeSpeech(input: {
    text: string;
    sampleRate: number;
  }): Promise<SpeechSynthesizeResult>;
}
```

默认：`timeoutMs=8000`，`asrModel="qwen3-asr-flash"`，`ttsModel="cosyvoice-v3-flash"`，`ttsVoice="longanyang"`。

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DashScopeSpeechAdapter } from "../src/speech/dashscopeSpeechAdapter.js";

test("transcribePcm sends WAV data URI and returns transcript", async () => {
  const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
  const adapter = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers,
      });
      return new Response(
        JSON.stringify({
          output: { choices: [{ message: { content: [{ text: "你好" }] } }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const pcm = Buffer.alloc(32000, 1);
  const result = await adapter.transcribePcm({ pcm, sampleRate: 16000, channels: 1 });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.transcript, "你好");
  assert.match(calls[0]!.url, /multimodal-generation\/generation$/u);
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer sk-test");
  const audio = (calls[0]!.body as { input: { messages: Array<{ content: Array<{ audio: string }> }> } })
    .input.messages[0]!.content[0]!.audio;
  assert.match(audio, /^data:audio\/wav;base64,/u);
  assert.equal(JSON.stringify(calls[0]!.body).includes(pcm.toString("hex")), false);
});

test("transcribePcm maps empty text and HTTP errors to asr_unavailable", async () => {
  const empty = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ text: "  " }] } }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.deepEqual(await empty.transcribePcm({ pcm: Buffer.alloc(32000), sampleRate: 16000, channels: 1 }), {
    status: "failed",
    reason_code: "asr_unavailable",
  });
  const httpFail = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(
    (await httpFail.transcribePcm({ pcm: Buffer.alloc(32000), sampleRate: 16000, channels: 1 })).status,
    "failed",
  );
});

test("synthesizeSpeech requests pcm and returns bytes", async () => {
  const pcm = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const adapter = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async (input, init) => {
      assert.match(String(input), /audio\/tts\/SpeechSynthesizer$/u);
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: { text: string; voice: string; format: string; sample_rate: number };
      };
      assert.equal(body.model, "cosyvoice-v3-flash");
      assert.equal(body.input.voice, "longanyang");
      assert.equal(body.input.format, "pcm");
      assert.equal(body.input.sample_rate, 16000);
      assert.equal(body.input.text, "你好");
      return new Response(pcm, { status: 200, headers: { "content-type": "application/octet-stream" } });
    },
  });
  const result = await adapter.synthesizeSpeech({ text: "你好", sampleRate: 16000 });
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.deepEqual(result.pcm, pcm);
    assert.equal(result.sampleRate, 16000);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/dashscopeSpeechAdapter.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: Write minimal implementation**

ASR：`POST {baseUrl}/services/aigc/multimodal-generation/generation`，JSON：

```json
{
  "model": "qwen3-asr-flash",
  "input": {
    "messages": [
      {
        "role": "user",
        "content": [{ "audio": "data:audio/wav;base64,..." }]
      }
    ]
  },
  "parameters": { "asr_options": { "enable_itn": true, "language": "zh" } }
}
```

从 `output.choices[0].message.content` 里找 `text`，也容忍 `output.text` 字符串。trim 后为空 → `asr_unavailable`。`AbortError` → `asr_unavailable`。`fetch` 用 `AbortSignal.timeout(timeoutMs)`。

TTS：`POST {baseUrl}/services/audio/tts/SpeechSynthesizer`，body：

```json
{
  "model": "cosyvoice-v3-flash",
  "input": {
    "text": "<截断到 200 字>",
    "voice": "longanyang",
    "format": "pcm",
    "sample_rate": 16000
  }
}
```

响应处理顺序：

1. `content-type` 含 `octet-stream` / `audio` → 用 body 当 PCM
2. JSON 里 `output.audio.url` → 再 GET 该 URL（仍带 Bearer）
3. JSON 里 `output.audio.data` 或 `output.audio` 字符串且像 base64 → decode
4. 否则 `tts_unavailable`

空 PCM → `tts_unavailable`。文本先 `trim`，再 `slice(0, 200)`。

`Authorization: Bearer <apiKey>`。不要把 PCM 或 data URI 写入任何 log 参数。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/dashscopeSpeechAdapter.test.ts test/pcmWav.test.ts && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/agent/src/speech/dashscopeSpeechAdapter.ts source/agent/test/dashscopeSpeechAdapter.test.ts
git commit -m "$(cat <<'EOF'
feat: add DashScope ASR and TTS adapter

EOF
)"
```

---

### Task 3: 短 TTL 语音内存表

**Files:**
- Create: `projects/HSHH-robot/source/agent/src/speech/speechStore.ts`
- Create: `projects/HSHH-robot/source/agent/test/speechStore.test.ts`

**Interfaces:**
- Produces:

```ts
export class SpeechStore {
  constructor(options?: { now?: () => Date; ttlMs?: number; idFactory?: () => string });
  put(input: {
    deviceId: string;
    pcm: Buffer;
    sampleRate: number;
  }): { speech_id: string; expires_at: string; duration_ms: number };
  take(deviceId: string, speechId: string): { pcm: Buffer; sampleRate: number } | undefined;
}
```

默认 `ttlMs=30_000`。`duration_ms = Math.round((pcm.byteLength / 2 / sampleRate) * 1000)`。同一 `deviceId` `put` 时丢掉旧块。`take` 命中后删除（一次性）。过期 `take` 返回 `undefined`。

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { SpeechStore } from "../src/speech/speechStore.js";

test("SpeechStore keeps one clip per device, expires, and consumes on take", () => {
  let nowMs = Date.parse("2026-08-16T00:00:00.000Z");
  const store = new SpeechStore({
    now: () => new Date(nowMs),
    ttlMs: 30_000,
    idFactory: () => "aaaa",
  });
  const first = store.put({
    deviceId: "robot-1",
    pcm: Buffer.alloc(32000),
    sampleRate: 16000,
  });
  assert.equal(first.speech_id, "spch_aaaa");
  assert.equal(first.duration_ms, 1000);
  store.put({ deviceId: "robot-1", pcm: Buffer.from([1, 2]), sampleRate: 16000 });
  assert.equal(store.take("robot-1", first.speech_id), undefined);
  const second = store.put({
    deviceId: "robot-1",
    pcm: Buffer.from([3, 4]),
    sampleRate: 16000,
  });
  assert.deepEqual(store.take("other", second.speech_id), undefined);
  assert.deepEqual(store.take("robot-1", second.speech_id)?.pcm, Buffer.from([3, 4]));
  assert.equal(store.take("robot-1", second.speech_id), undefined);
  const third = store.put({
    deviceId: "robot-1",
    pcm: Buffer.from([5, 6]),
    sampleRate: 16000,
  });
  nowMs += 30_001;
  assert.equal(store.take("robot-1", third.speech_id), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/speechStore.test.ts`

Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

内存 `Map<string, { speechId, pcm, sampleRate, expiresAtMs }>`，key 为 `deviceId`。`speech_id` 前缀 `spch_`。`take` 先比 device 再比 id，再比 TTL。不要把 `pcm` 拷进异常消息。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/speechStore.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/agent/src/speech/speechStore.ts source/agent/test/speechStore.test.ts
git commit -m "$(cat <<'EOF'
feat: add ephemeral TTS speech store

EOF
)"
```

---

### Task 4: effect 队列增加 `play_speech`

**Files:**
- Modify: `projects/HSHH-robot/source/agent/src/device/deviceEffectQueue.ts`
- Modify: `projects/HSHH-robot/source/agent/test/deviceEffectQueue.test.ts`

**Interfaces:**
- Consumes: 现有 `enqueue` / `list` / `acknowledge`
- Produces: `T5DeviceEffect` 增加：

```ts
| {
    effect_id: string;
    sequence: number;
    request_id: string;
    device_id: string;
    type: "play_speech";
    speech_id: string;
    sample_rate: number;
    format: "pcm_s16le";
    duration_ms: number;
    created_at: string;
    expires_at: string;
  }
```

以及：

```ts
enqueuePlaySpeech(input: {
  requestId: string;
  deviceId: string;
  speechId: string;
  sampleRate: number;
  durationMs: number;
}): HshhDeviceDispatchResult
```

成功 `reason_code: "speech_queued_for_t5"`。重复 `(deviceId, requestId, type=play_speech)` → `effect_already_queued`。不要把 `play_speech` 放进 Device MCP 工具列表（模型不发 PCM）。

- [ ] **Step 1: Extend the existing test**

在 `deviceEffectQueue.test.ts` 末尾增加：

```ts
test("play_speech is queued without motion parameters", () => {
  const queue = new DeviceEffectQueue({
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    idFactory: () => "speech",
  });
  assert.equal(
    queue.enqueuePlaySpeech({
      requestId: "turn-1",
      deviceId: "robot-1",
      speechId: "spch_1",
      sampleRate: 16000,
      durationMs: 900,
    }).reason_code,
    "speech_queued_for_t5",
  );
  const listed = queue.list("robot-1");
  assert.equal(listed[0]?.type, "play_speech");
  if (listed[0]?.type === "play_speech") {
    assert.equal(listed[0].speech_id, "spch_1");
    assert.equal(listed[0].format, "pcm_s16le");
    assert.equal(listed[0].sample_rate, 16000);
  }
  assert.equal(
    JSON.stringify(listed).includes("pwm"),
    false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/deviceEffectQueue.test.ts`

Expected: FAIL，`enqueuePlaySpeech` 不存在。

- [ ] **Step 3: Write minimal implementation**

仿 `enqueueConsentOffer`：cleanup、查重、满队列 `effect_queue_full`、`sequence += 1`、`expires_at = now + 30_000`。`enqueue()` 的 `set_expression`/`play_sound` 分支保持不变；不要把 `play_speech` 塞进 `HshhDeviceEffect` MCP 联合类型，除非为了 list 类型需要——队列类型 `T5DeviceEffect` 独立扩展即可。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/deviceEffectQueue.test.ts && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/agent/src/device/deviceEffectQueue.ts source/agent/test/deviceEffectQueue.test.ts
git commit -m "$(cat <<'EOF'
feat: queue play_speech effects for T5 playback

EOF
)"
```

---

### Task 5: Utterance 编排（ASR → Qwen → TTS）

**Files:**
- Create: `projects/HSHH-robot/source/agent/src/speech/utterancePipeline.ts`
- Create: `projects/HSHH-robot/source/agent/test/utterancePipeline.test.ts`

**Interfaces:**
- Consumes: `DashScopeSpeechAdapter` 的两个方法（测试里用 fake）、`EventContextGateway.ingestEvent`、`HshhAgent.interact`、`SpeechStore.put`、`DeviceEffectQueue`
- Produces:

```ts
export const MAX_UTTERANCE_BYTES = 512 * 1024;
export const MIN_UTTERANCE_MS = 300;

export class UtterancePipeline {
  constructor(options: {
    speech: Pick<DashScopeSpeechAdapter, "transcribePcm" | "synthesizeSpeech">;
    gateway: EventContextGateway;
    agent: Pick<HshhAgent, "interact">;
    speechStore: SpeechStore;
    effectQueue: DeviceEffectQueue;
    now?: () => Date;
    log?: (fields: Record<string, string | number | boolean>) => void;
  });
  accept(input: {
    deviceId: string;
    userId: string;
    utteranceId: string;
    pcm: Buffer;
    sampleRate: number;
    channels: number;
    format: string;
  }): { ok: true; utterance_id: string; expires_at: string } | { ok: false; status: number; reason_code: string };
  run(utteranceId: string): Promise<void>;
}
```

`accept` 规则：

| 条件 | status | reason_code |
| --- | --- | --- |
| 已有进行中的同一 device | 409 | `utterance_in_flight` |
| `format !== "pcm_s16le"` 或 channels !== 1 或采样率非法 | 400 | `invalid_audio_header` |
| 字节数 > 512 KiB | 413 | `utterance_too_large` |
| 时长 < 300ms（`pcm.length / 2 / sampleRate < 0.3`） | 400 | `utterance_too_short` |
| 否则 | ok | 单飞标记打开，PCM 拷进 job |

`run` 顺序：

1. ASR；失败则 `enqueue play_sound=confused`，清单飞，**不** `interact`
2. `gateway.ingestEvent({ event: "speech_transcript", source: "t5_microphone", device_id, user_id, occurred_at, payload: { transcript, media_ref: utteranceId, confidence: 1, summary: "Transcribed T5 microphone utterance" } })`。payload 禁止任何 raw audio 键
3. `agent.interact({ request_id: utteranceId, transcript, locale: "zh-CN", device_context: { device_id, user_id, observed_at, presence: "unknown", pose: "unknown", battery: "unknown", safety_state: "stopped" } })`。Gateway/DB 里若已有权威 context，`HshhAgent` 会自己覆盖
4. TTS `reply_text`；成功则 `speechStore.put` + `enqueuePlaySpeech` + `enqueue set_expression`（用决策的 expression，duration_ms 3500）。**不要**调用现有 `queueDecisionFeedback`（它会在 `speech` 模态时再塞 `play_sound`）
5. TTS 失败：仍 `enqueue set_expression`，再 `play_sound=confused`
6. 若 `requires_user_confirmation` 且 scope 为 approach/hug：`enqueueConsentOffer`（与现网一致）
7. `log` 只允许：`utterance_id`、`pcm_bytes`、`sample_rate`、`asr_ms`、`transcript_preview`（前 40 字）、`tts_bytes`、`reason_code`。测试断言 log 对象的 JSON 不含原始 PCM 字节模式
8. `finally` 清单飞

- [ ] **Step 1: Write the failing tests**

覆盖：happy path 入队 `play_speech` 且无 `play_sound`；ASR 失败不调用 `interact`；第二句 `accept` 在 `run` 未完成时 409；log 不含 PCM。

Fake speech：

```ts
const speech = {
  transcribePcm: async () => ({ status: "completed" as const, transcript: "你好" }),
  synthesizeSpeech: async () => ({
    status: "completed" as const,
    pcm: Buffer.from([9, 8, 7, 6]),
    sampleRate: 16000,
  }),
};
```

Fake agent：

```ts
const agent = {
  interact: async () => ({
    mode: "fallback" as const,
    decision: {
      reply_text: "我在。",
      expression: "happy" as const,
      emotion: { label: "neutral" as const, intensity: 0.2, evidence: [] },
      requires_user_confirmation: false,
      output_modalities: ["speech", "display"] as const,
    },
  }),
};
```

`device_context` 字段以 `InteractionRequest` 为准；若 `emotion` schema 在测试里 parse 失败，改成与 `agentArchitecture.test.ts` 相同的合法 decision 形状，或让 fake 返回已经满足 `agentDecisionSchema` 的对象。本任务 fake 不走 `HshhAgent` 真身，pipeline 只读 `decision.reply_text` / `expression` / `requires_user_confirmation` / `confirmation_scope`。

PCM 用 `Buffer.alloc(16000)`（16 kHz 单声道 16-bit 约 500ms）。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/utterancePipeline.test.ts`

Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

`accept` 把 job 放进 `Map<deviceId, job>`。`run` 用 deviceId 找到 job。ingest 失败当作 ASR 失败同样 confused cue。`interact` 抛错：走表情 + confused，不假装说过话。

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/utterancePipeline.test.ts test/speechStore.test.ts test/deviceEffectQueue.test.ts && npm run typecheck`

Expected: PASS。

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/agent/src/speech/utterancePipeline.ts source/agent/test/utterancePipeline.test.ts
git commit -m "$(cat <<'EOF'
feat: orchestrate utterance ASR, reply, and TTS

EOF
)"
```

---

### Task 6: HTTP 路由并接到进程

**Files:**
- Modify: `projects/HSHH-robot/source/agent/src/server/httpServer.ts`
- Modify: `projects/HSHH-robot/source/agent/src/index.ts`
- Modify: `projects/HSHH-robot/source/agent/test/httpServer.test.ts`

**Interfaces:**
- Consumes: `UtterancePipeline.accept` / `run`，`SpeechStore.take`
- Produces:
  - `POST /v1/device/utterances`（device Bearer）
  - `GET /v1/device/speech/:speechId`（device Bearer）
  - `HshhHttpServerOptions.utterancePipeline?`、`speechStore?`

请求头：`X-Hshh-Audio-Format`、`X-Hshh-Sample-Rate`、`X-Hshh-Channels`、`X-Hshh-Utterance-Id`。缺省：`pcm_s16le`、`16000`、`1`、服务端生成 `utt_` + uuid。

`accept` 成功后 **立刻** `202 { accepted: true, utterance_id, expires_at }`，然后 `void options.utterancePipeline.run(utterance_id).catch(...)`。不要在 HTTP 里 await 完整 ASR+LLM+TTS。

无 pipeline / 无 key：`503 speech_not_configured`。

GET speech：无 store 或 miss → `404 speech_not_found`。命中 → `200`，`Content-Type: application/octet-stream`，`Content-Length`，body 为 PCM。`Access-Control-Allow-Headers` 加上 `x-hshh-audio-format, x-hshh-sample-rate, x-hshh-channels, x-hshh-utterance-id`。

读取 body：抽出 `readRawBody(request, maxBytes)`（可从 `readJsonBody` 拆出共用循环），utterance 上限 `MAX_UTTERANCE_BYTES`，不要用 12MiB 的 JSON 上限去收 PCM。

`index.ts`：若 `config.dashscopeApiKey` 存在，构造 adapter + store + pipeline 并传入 HTTP server。

- [ ] **Step 1: Extend HTTP tests**

给 `invoke` 增加可选 `rawBody: Buffer` 与 `headers: Record<string, string>`。新增用例：

1. 无 pipeline：device POST `/v1/device/utterances` → 503 `speech_not_configured`
2. 有 pipeline：500ms PCM + 合法头 → 202，`accepted: true`；随后 `await pipeline.run`（测试可直接拿同一 pipeline 实例）后 GET `/v1/device/speech/{id}` 返回 PCM
3. 第二路并发 POST 同一 device → 409（在 `run` 里插入永不 resolve 的 ASR fake）

构造 server 时传入真实 `UtterancePipeline` + fake speech/agent，与 Task 5 相同。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd projects/HSHH-robot/source/agent && node --import tsx --test test/httpServer.test.ts`

Expected: FAIL，路径 404 或 503 与新用例不符。

- [ ] **Step 3: Write minimal implementation**

在 `createHshhHttpServer` 的路由表里、`/v1/device/events` 附近加入 utterances 与 speech GET。鉴权用现有 `assertAuthorized(..., "device")`。`speechId` 从路径 decode，拒绝 `/` 与 `..`。

`index.ts` 接线示例：

```ts
const speechStore = new SpeechStore({ now });
const utterancePipeline =
  config.dashscopeApiKey === undefined
    ? undefined
    : new UtterancePipeline({
        speech: new DashScopeSpeechAdapter({
          apiKey: config.dashscopeApiKey,
          baseUrl: config.dashscopeBaseUrl,
        }),
        gateway,
        agent,
        speechStore,
        effectQueue,
        now,
      });
```

把 `utterancePipeline` 与 `speechStore` 传入 `createHshhHttpServer`。

- [ ] **Step 4: Run Agent verification**

Run: `cd projects/HSHH-robot/source/agent && npm run typecheck && npm run test`

Expected: 全部 PASS（当前基线含语音新测试）。

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/agent/src/server/httpServer.ts source/agent/src/index.ts source/agent/test/httpServer.test.ts
git commit -m "$(cat <<'EOF'
feat: accept T5 utterances and serve TTS PCM

EOF
)"
```

Agent 阶段到此可用 curl 验证（需 `.env` 里已有 `DASHSCOPE_API_KEY`，且 Agent 已重启）：

```bash
# 16 kHz 静音约 0.5s；真人测试请换成实际录音
python3 -c 'import sys; sys.stdout.buffer.write(b"\x00\x00"*8000)' > /tmp/hshh-utt.pcm
curl --interface en0 -sS -D - -X POST "http://127.0.0.1:8787/v1/device/utterances" \
  -H "Authorization: Bearer <device-token>" \
  -H "Content-Type: application/octet-stream" \
  -H "X-Hshh-Audio-Format: pcm_s16le" \
  -H "X-Hshh-Sample-Rate: 16000" \
  -H "X-Hshh-Channels: 1" \
  -H "X-Hshh-Utterance-Id: utt-curl-1" \
  --data-binary @/tmp/hshh-utt.pcm
# 等数秒后
curl --interface en0 -sS "http://127.0.0.1:8787/v1/device/effects?after=0" \
  -H "Authorization: Bearer <device-token>"
```

不要把 token 写进仓库或计划执行日志。真人说话的 PCM 才能得到非空 ASR；静音应走 confused cue，这算 ASR 失败路径验证。

---

### Task 7: T5 PCM 播放与句缓冲

**Files:**
- Modify: `projects/HSHH-robot/source/embedded/include/app_hshh_audio.h`
- Modify: `projects/HSHH-robot/source/embedded/src/app_hshh_audio.c`
- Create: `projects/HSHH-robot/source/embedded/include/app_hshh_voice.h`
- Create: `projects/HSHH-robot/source/embedded/src/app_hshh_voice.c`
- Modify: `projects/HSHH-robot/source/embedded/src/tuya_app_main.c`（在 `app_hshh_effects_init` 成功后 `app_hshh_voice_init`）

**Interfaces:**
- Consumes: `app_hshh_audio_set_frame_handler`、`tdl_audio_play` / `tdl_audio_play_stop`、`tal_psram_malloc`（`ENABLE_EXT_RAM`）否则 `tal_malloc`
- Produces:

```c
OPERATE_RET app_hshh_audio_play_pcm(const uint8_t *data, uint32_t length);
uint32_t app_hshh_audio_get_sample_rate(void);
uint32_t app_hshh_audio_get_frame_size(void);

typedef enum {
    APP_HSHH_VOICE_IDLE = 0,
    APP_HSHH_VOICE_CAPTURING,
    APP_HSHH_VOICE_READY,
    APP_HSHH_VOICE_UPLOADING,
    APP_HSHH_VOICE_SPEAKING,
} app_hshh_voice_state_t;

OPERATE_RET app_hshh_voice_init(void);
void app_hshh_voice_on_vad(bool started);
void app_hshh_voice_stop(void);
OPERATE_RET app_hshh_voice_start_timed_capture(uint32_t duration_ms);
bool app_hshh_voice_take_ready(const uint8_t **data, uint32_t *length, char utterance_id[33], uint32_t *sample_rate);
void app_hshh_voice_release(void);
void app_hshh_voice_set_speaking(bool speaking);
app_hshh_voice_state_t app_hshh_voice_get_state(void);
```

约束：最大缓冲 512 KiB；最短句 300ms；最长 8000ms（到时强制 READY）。音频回调里只 `memcpy`，禁止 HTTP。`IDLE`/`CAPTURING` 才响应新的 VAD_START；`UPLOADING`/`SPEAKING` 忽略新 VAD。`stop`：停播、丢缓冲、回 IDLE。

- [ ] **Step 1: T5 无单元测试框架；本任务的“红灯”是缺符号无法链接**

新增头文件与空实现会导致后续 agent 调用失败。直接按 Step 3 实现，用编译当验证。

- [ ] **Step 2: Implement audio helpers**

`app_hshh_audio_play_pcm`：按 `frame_size`（0 则 640）循环 `tdl_audio_play`，与 `play_cue` 相同。`get_sample_rate`：`s_info.sample_rate == 0 ? 16000 : s_info.sample_rate`。

- [ ] **Step 3: Implement voice buffer**

`app_hshh_voice_init`：分配 512 KiB PSRAM，`app_hshh_audio_set_frame_handler` 写环形/线性缓冲（线性足够：write_offset 到 cap 即当 VAD_END）。VAD_START 清 offset 并 CAPTURING。PCM 回调：仅 CAPTURING 时追加。`start_timed_capture`：进入 CAPTURING，记录 `deadline_ms`；`app_hshh_effects_tick` 或 voice 在 PCM 回调里若超时则 READY。utterance_id：`utt` + 8 位毫秒十六进制，保证 `[A-Za-z0-9_-]`、长度 ≤ 32。

`take_ready`：仅 READY 时把状态改 UPLOADING 并给出指针（零拷贝）。`release` 回 IDLE。

在 `app_hshh_effects_tick` 里，VAD 事件现有逻辑保留（`speech_started`/`ended` 事件）；同时调用 `app_hshh_voice_on_vad`。本地 stop 已有 `app_hshh_audio_stop()`，再加 `app_hshh_voice_stop()`。

- [ ] **Step 4: Build**

Run: 在已 `source` TuyaOpenSDK `export.sh` 的环境中 `cd projects/HSHH-robot/source/embedded && tos.py build`

Expected: 编译成功。不要在本任务烧录，除非后续任务需要。

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/embedded/include/app_hshh_audio.h source/embedded/src/app_hshh_audio.c \
  source/embedded/include/app_hshh_voice.h source/embedded/src/app_hshh_voice.c \
  source/embedded/src/tuya_app_main.c source/embedded/src/app_hshh_effects.c
git commit -m "$(cat <<'EOF'
feat: buffer T5 microphone utterances in PSRAM

EOF
)"
```

---

### Task 8: T5 上传、拉语音、CLI 保底

**Files:**
- Modify: `projects/HSHH-robot/source/embedded/include/app_hshh_lan_config.h`
- Modify: `projects/HSHH-robot/source/embedded/include/app_hshh_agent.h`
- Modify: `projects/HSHH-robot/source/embedded/src/app_hshh_agent.c`
- Modify: `projects/HSHH-robot/source/embedded/src/app_hshh_provisioning.c`
- Modify: `projects/HSHH-robot/source/embedded/src/app_hshh_effects.c`（若 Task 7 未改完 stop）

**Interfaces:**
- Consumes: `app_hshh_voice_take_ready` / `release` / `start_timed_capture` / `set_speaking`、`app_hshh_audio_play_pcm`
- Produces: 设备侧闭环

配置新增（只影响语音路径）：

```c
#define HSHH_AGENT_SPEECH_TIMEOUT_MS     8000u
#define HSHH_AGENT_SPEECH_MAX_BYTES      (512u * 1024u)
#define HSHH_AGENT_UTTERANCES_PATH       "/v1/device/utterances"
```

`HSHH_AGENT_HTTP_TIMEOUT_MS` 与 `HSHH_AGENT_MAX_RESPONSE_BYTES` **保持** 3500 / 12288，供 JSON 事件/effects。

Agent 线程栈改为 `1024u * 24u`。增加 pending 位 `HSHH_AGENT_PENDING_UTTERANCE`。worker 在 poll effects 之外：若 `take_ready` 成功则 POST PCM。

二进制 POST：自定义 headers（Authorization、Content-Type `application/octet-stream`、四条 `X-Hshh-*`），`timeout_ms = HSHH_AGENT_SPEECH_TIMEOUT_MS`。202 视为成功并 `release`。4xx/失败：`release`，`app_hshh_effects_queue_sound(APP_HSHH_AUDIO_CUE_CONFUSED)`，最多再置一次 pending（用静态 `retried` 标志，成功或第二次失败后清零）。日志只打 `bytes` 与 `status`，不打 token、不打 PCM。

`play_speech`：解析 `speech_id`（长度 8–80，字符 `A-Za-z0-9_-`）、`sample_rate`、`format == pcm_s16le`。先 `app_hshh_audio_stop()`，`GET /v1/device/speech/{id}`，`Accept: application/octet-stream`，响应上限 `HSHH_AGENT_SPEECH_MAX_BYTES`。成功则 `app_hshh_voice_set_speaking(true)`，`play_pcm`，然后 `set_speaking(false)`。失败 confused cue。与 `play_sound` 同时到达时按 effect `sequence` 执行；pipeline 在 TTS 成功时不会再发 cue。

CLI：`hshh_audio utterance [ms]`，默认 3000，范围 300–8000，调用 `app_hshh_voice_start_timed_capture`。help 改为 `status|reset|tone|volume|utterance`。echo 不得包含 PCM。

- [ ] **Step 1: Implement HTTP helpers and effect branch**

在 `app_hshh_apply_effect` 的 `offer_consent` 之后增加 `play_speech` 分支。`speech_id` 拼进 path 时做长度检查，防止溢出 `HSHH_AGENT_PATH_BYTES`。

- [ ] **Step 2: Implement worker upload**

```c
const uint8_t *pcm = NULL;
uint32_t length = 0u;
char utterance_id[33];
uint32_t sample_rate = 16000u;
if (app_hshh_voice_take_ready(&pcm, &length, utterance_id, &sample_rate)) {
    OPERATE_RET rt = app_hshh_post_utterance(pcm, length, utterance_id, sample_rate);
    app_hshh_voice_release();
    if (rt != OPRT_OK) {
        (void)app_hshh_effects_queue_sound(APP_HSHH_AUDIO_CUE_CONFUSED);
    }
}
```

POST 期间 voice 已是 UPLOADING，新 VAD 会被忽略。

- [ ] **Step 3: CLI**

`audio_diagnostics_command` 增加 `utterance` 分支。`strtoul` 解析可选时长。

- [ ] **Step 4: Build**

Run: `cd projects/HSHH-robot/source/embedded && tos.py build`

Expected: 成功。然后烧录 T5（确认端口是 T5 的 `/dev/cu.usbserial-110`，不要误刷 CAM）：

`tos.py flash -p /dev/cu.usbserial-110 -b 230400`

- [ ] **Step 5: Commit**（仅用户要求时）

```bash
git add source/embedded/include/app_hshh_lan_config.h source/embedded/include/app_hshh_agent.h \
  source/embedded/src/app_hshh_agent.c source/embedded/src/app_hshh_provisioning.c \
  source/embedded/src/app_hshh_effects.c
git commit -m "$(cat <<'EOF'
feat: upload T5 utterances and play Agent speech

EOF
)"
```

---

### Task 9: 真机验收

**Files:** 不改代码，除非验收暴露出缺 TTL/停播/VAD 的小补丁（补丁仍须遵守 Global Constraints）。

**Interfaces:** 消费 Task 6–8 的全部接口。

- [ ] **Step 1: Restart Agent with speech key**

确认 `projects/HSHH-robot/source/agent/.env` 有 `DASHSCOPE_API_KEY`（人工粘贴，不要用工具把 key 打到聊天或日志）。重启 `npm start`。`GET http://127.0.0.1:8787/health`（或现有根路径）应仍返回服务 ok。

- [ ] **Step 2: CLI 保底路径**

USB 115200，DTR/RTS false，端口 `/dev/cu.usbserial-110`：

```
hshh_audio utterance 3000
```

对着 T5 说「你好」。期望：数秒内扬声器出现中文回复，屏幕表情变化。`hshh_audio status` 的 `pcm_frames` 应增加。UART 不得出现 token 或 PCM hex dump。

- [ ] **Step 3: 停止**

在播放中长按。期望：声音立刻停，不需要等云端。随后 effects 里未取的 speech 404 可接受。

- [ ] **Step 4: 可选 VAD 主路径**

若 `vad_starts`/`vad_ends` 在自然说话后增加，再不用 CLI 说一句「你好」，确认同样能回复。VAD 仍为 0 不算失败；CLI 能回就算第一刀过关。

- [ ] **Step 5: 回归 Agent 测试**

Run: `cd projects/HSHH-robot/source/agent && npm run typecheck && npm run test`

Expected: PASS。不要声称 PRD 17.x 运动验收因语音而满足。

---

## Self-review

1. Spec coverage：轮次对话、密钥在 Agent、DashScope ASR/TTS、Qwen interact、play_speech、202 后台编排、512 KiB、300ms/8s、CLI utterance、VAD 忽略忙态、长按停播、失败 confused、不伪造同意、不改 S3/CAM、不把 transcribe 再做一遍 MCP——均有对应任务。语音 HTTP 超时从现网 3.5s/12KiB 拆出，避免 TTS 下载被砍掉。
2. Placeholder scan：无 TBD；测试与实现都有具体函数名和错误码。
3. Type consistency：`speech_id` / `spch_`、`utterance_id`、`pcm_s16le`、`enqueuePlaySpeech`、`SpeechStore.take`、`UtterancePipeline.accept/run` 前后任务一致。
