import assert from "node:assert/strict";
import test from "node:test";

import type { HshhAgent } from "../src/agent/hshhAgent.js";
import { DeviceEffectQueue } from "../src/device/deviceEffectQueue.js";
import type { AgentDecision } from "../src/domain/contracts.js";
import { EventContextGateway } from "../src/gateway/EventContextGateway.js";
import { SpeechStore } from "../src/speech/speechStore.js";
import {
  MAX_UTTERANCE_BYTES,
  MIN_UTTERANCE_MS,
  UtterancePipeline,
} from "../src/speech/utterancePipeline.js";

const NOW = new Date("2026-08-16T00:00:00.000Z");
const DEVICE_ID = "robot-1";
const USER_ID = "user-1";
const UTTERANCE_ID = "utt1a2b3c";
const ALLOWED_LOG_KEYS = new Set([
  "utterance_id",
  "pcm_bytes",
  "sample_rate",
  "asr_ms",
  "transcript_preview",
  "tts_bytes",
  "reason_code",
]);

function pcm500ms(fill = 0): Buffer {
  return Buffer.alloc(16000, fill);
}

function fakeSpeech(overrides: {
  transcribePcm?: (input: {
    pcm: Buffer;
    sampleRate: number;
    channels: number;
  }) => Promise<
    { status: "completed"; transcript: string } | { status: "failed"; reason_code: string }
  >;
  synthesizeSpeech?: () => Promise<
    | { status: "completed"; pcm: Buffer; sampleRate: number }
    | { status: "failed"; reason_code: string }
  >;
} = {}) {
  return {
    transcribePcm:
      overrides.transcribePcm ??
      (async () => ({ status: "completed" as const, transcript: "你好" })),
    synthesizeSpeech:
      overrides.synthesizeSpeech ??
      (async () => ({
        status: "completed" as const,
        pcm: Buffer.from([9, 8, 7, 6]),
        sampleRate: 16000,
      })),
  };
}

function baseDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    reply_text: "我在。",
    expression: "happy",
    emotion: {
      state: "unknown",
      valence: 0,
      arousal: 0.2,
      engagement: 0.35,
      confidence: 0.3,
      evidence: [],
      observed_signals: [],
      user_confirmed: false,
      expires_at: "2026-08-16T00:01:00.000Z",
    },
    requires_user_confirmation: false,
    output_modalities: ["speech", "display"],
    ...overrides,
  };
}

function fakeAgent(
  interact: HshhAgent["interact"] = async () => ({
    mode: "fallback",
    decision: baseDecision(),
  }),
): Pick<HshhAgent, "interact"> {
  return { interact };
}

function acceptInput(
  overrides: Partial<{
    deviceId: string;
    userId: string;
    utteranceId: string;
    pcm: Buffer;
    sampleRate: number;
    channels: number;
    format: string;
  }> = {},
) {
  return {
    deviceId: DEVICE_ID,
    userId: USER_ID,
    utteranceId: UTTERANCE_ID,
    pcm: pcm500ms(),
    sampleRate: 16000,
    channels: 1,
    format: "pcm_s16le",
    ...overrides,
  };
}

function createPipeline(options: {
  speech?: ReturnType<typeof fakeSpeech>;
  agent?: ReturnType<typeof fakeAgent>;
  gateway?: EventContextGateway;
  speechStore?: SpeechStore;
  effectQueue?: DeviceEffectQueue;
  log?: (fields: Record<string, string | number | boolean>) => void;
} = {}) {
  const now = () => NOW;
  const gateway = options.gateway ?? new EventContextGateway({ now });
  const speechStore = options.speechStore ?? new SpeechStore({ now });
  const effectQueue = options.effectQueue ?? new DeviceEffectQueue({ now });
  const pipeline = new UtterancePipeline({
    speech: options.speech ?? fakeSpeech(),
    gateway,
    agent: options.agent ?? fakeAgent(),
    speechStore,
    effectQueue,
    now,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return { pipeline, gateway, speechStore, effectQueue };
}

test("happy path queues play_speech and not play_sound", async () => {
  let transcribed: Buffer | undefined;
  const pcm = pcm500ms(0x11);
  const { pipeline, effectQueue, speechStore, gateway } = createPipeline({
    speech: fakeSpeech({
      transcribePcm: async (input) => {
        transcribed = input.pcm;
        return { status: "completed", transcript: "你好" };
      },
    }),
  });
  const accepted = pipeline.accept(acceptInput({ pcm }));
  pcm.fill(0);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.utterance_id, UTTERANCE_ID);
  assert.equal(accepted.expires_at, "2026-08-16T00:00:30.000Z");

  await pipeline.run(accepted.utterance_id);
  assert.equal(transcribed?.[0], 0x11);
  assert.notEqual(transcribed, pcm);

  const listed = effectQueue.list(DEVICE_ID);
  assert.equal(
    listed.some((item) => item.type === "play_speech"),
    true,
  );
  assert.equal(
    listed.some((item) => item.type === "play_sound"),
    false,
  );
  const speechEffect = listed.find((item) => item.type === "play_speech");
  assert.ok(speechEffect && speechEffect.type === "play_speech");
  const clip = speechStore.take(DEVICE_ID, speechEffect.speech_id);
  assert.deepEqual(clip?.pcm, Buffer.from([9, 8, 7, 6]));

  const expression = listed.find((item) => item.type === "set_expression");
  assert.ok(expression && expression.type === "set_expression");
  assert.equal(expression.expression, "happy");
  assert.equal(expression.duration_ms, 3500);
  assert.equal(expression.intensity, 0.75);

  const events = gateway.getRecentEvents(DEVICE_ID);
  assert.equal(events[0]?.event, "speech_transcript");
  assert.equal(events[0]?.source, "t5_microphone");
  assert.equal(events[0]?.payload?.["transcript"], "你好");
  assert.equal(events[0]?.payload?.["media_ref"], UTTERANCE_ID);
  assert.equal(events[0]?.payload?.["summary"], "Transcribed T5 microphone utterance");
});

test("ASR failure queues confused and does not call interact", async () => {
  let interactCalls = 0;
  const { pipeline, effectQueue } = createPipeline({
    speech: fakeSpeech({
      transcribePcm: async () => ({ status: "failed", reason_code: "asr_unavailable" }),
    }),
    agent: fakeAgent(async () => {
      interactCalls += 1;
      throw new Error("interact should not run");
    }),
  });
  const accepted = pipeline.accept(acceptInput());
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  await pipeline.run(accepted.utterance_id);
  assert.equal(interactCalls, 0);
  const listed = effectQueue.list(DEVICE_ID);
  assert.equal(
    listed.some((item) => item.type === "play_sound" && item.sound === "confused"),
    true,
  );
  assert.equal(
    listed.some((item) => item.type === "play_speech"),
    false,
  );

  const next = pipeline.accept(acceptInput({ utteranceId: "utt-next" }));
  assert.equal(next.ok, true);
});

test("second accept while run is in flight returns 409 utterance_in_flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { pipeline } = createPipeline({
    speech: fakeSpeech({
      transcribePcm: async () => {
        await gate;
        return { status: "completed", transcript: "你好" };
      },
    }),
  });
  const first = pipeline.accept(acceptInput());
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const running = pipeline.run(first.utterance_id);
  const second = pipeline.accept(
    acceptInput({ utteranceId: "utt-second", pcm: pcm500ms() }),
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.status, 409);
  assert.equal(second.reason_code, "utterance_in_flight");
  release();
  await running;
  const after = pipeline.accept(acceptInput({ utteranceId: "utt-after" }));
  assert.equal(after.ok, true);
});

test("log objects JSON does not contain the raw PCM byte pattern", async () => {
  const pcm = pcm500ms(0xc3);
  const logs: Array<Record<string, string | number | boolean>> = [];
  const { pipeline } = createPipeline({
    log: (fields) => {
      logs.push({ ...fields });
    },
  });
  const accepted = pipeline.accept(acceptInput({ pcm }));
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  await pipeline.run(accepted.utterance_id);
  assert.ok(logs.length >= 1);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(pcm.toString("hex")), false);
  assert.equal(serialized.includes(pcm.toString("base64")), false);
  for (const entry of logs) {
    for (const key of Object.keys(entry)) {
      assert.equal(ALLOWED_LOG_KEYS.has(key), true, `unexpected log key ${key}`);
    }
    assert.equal(entry["utterance_id"], UTTERANCE_ID);
    assert.equal(entry["pcm_bytes"], 16000);
    assert.equal(entry["sample_rate"], 16000);
  }
});

test("accept rejects invalid headers, oversized audio, and short clips", () => {
  const { pipeline } = createPipeline();
  assert.deepEqual(
    pipeline.accept(acceptInput({ format: "wav" })),
    { ok: false, status: 400, reason_code: "invalid_audio_header" },
  );
  assert.deepEqual(
    pipeline.accept(acceptInput({ channels: 2 })),
    { ok: false, status: 400, reason_code: "invalid_audio_header" },
  );
  assert.deepEqual(
    pipeline.accept(acceptInput({ sampleRate: 44100 })),
    { ok: false, status: 400, reason_code: "invalid_audio_header" },
  );
  assert.equal(MAX_UTTERANCE_BYTES, 512 * 1024);
  assert.equal(MIN_UTTERANCE_MS, 300);
  const oversized = pipeline.accept(
    acceptInput({ pcm: Buffer.alloc(512 * 1024 + 2), utteranceId: "utt-big" }),
  );
  assert.deepEqual(oversized, {
    ok: false,
    status: 413,
    reason_code: "utterance_too_large",
  });
  const tooShort = pipeline.accept(
    acceptInput({ pcm: Buffer.alloc(8000), utteranceId: "utt-short" }),
  );
  assert.deepEqual(tooShort, {
    ok: false,
    status: 400,
    reason_code: "utterance_too_short",
  });
  for (const sampleRate of [8000, 16000, 22050, 24000]) {
    const { pipeline: ratePipeline } = createPipeline();
    const accepted = ratePipeline.accept(
      acceptInput({
        deviceId: `robot-${sampleRate}`,
        utteranceId: `utt-rate-${sampleRate}`,
        sampleRate,
        pcm: pcm500ms(),
      }),
    );
    assert.equal(accepted.ok, true, `sampleRate ${sampleRate}`);
  }
});

test("ingestEvent failure is treated like ASR failure", async () => {
  let interactCalls = 0;
  class RejectingGateway extends EventContextGateway {
    override ingestEvent(): { accepted: false; reason_code: "invalid_event" } {
      return { accepted: false, reason_code: "invalid_event" };
    }
  }
  const { pipeline, effectQueue } = createPipeline({
    gateway: new RejectingGateway({ now: () => NOW }),
    agent: fakeAgent(async () => {
      interactCalls += 1;
      throw new Error("interact should not run");
    }),
  });
  const accepted = pipeline.accept(acceptInput());
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  await pipeline.run(accepted.utterance_id);
  assert.equal(interactCalls, 0);
  assert.equal(
    effectQueue
      .list(DEVICE_ID)
      .some((item) => item.type === "play_sound" && item.sound === "confused"),
    true,
  );
});

test("interact throw queues expression and confused without play_speech", async () => {
  const { pipeline, effectQueue } = createPipeline({
    agent: fakeAgent(async () => {
      throw new Error("agent down");
    }),
  });
  const accepted = pipeline.accept(acceptInput());
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  await pipeline.run(accepted.utterance_id);
  const listed = effectQueue.list(DEVICE_ID);
  assert.equal(
    listed.some((item) => item.type === "set_expression"),
    true,
  );
  assert.equal(
    listed.some((item) => item.type === "play_sound" && item.sound === "confused"),
    true,
  );
  assert.equal(
    listed.some((item) => item.type === "play_speech"),
    false,
  );
});

test("TTS failure queues expression and confused, consent when required", async () => {
  const { pipeline, effectQueue } = createPipeline({
    speech: fakeSpeech({
      synthesizeSpeech: async () => ({
        status: "failed",
        reason_code: "tts_unavailable",
      }),
    }),
    agent: fakeAgent(async () => ({
      mode: "fallback",
      decision: baseDecision({
        reply_text: "靠近一点？",
        expression: "noticed",
        requires_user_confirmation: true,
        confirmation_scope: "approach_short",
      }),
    })),
  });
  const accepted = pipeline.accept(acceptInput());
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  await pipeline.run(accepted.utterance_id);
  const listed = effectQueue.list(DEVICE_ID);
  const expression = listed.find((item) => item.type === "set_expression");
  assert.ok(expression && expression.type === "set_expression");
  assert.equal(expression.expression, "noticed");
  assert.equal(
    listed.some((item) => item.type === "play_sound" && item.sound === "confused"),
    true,
  );
  assert.equal(
    listed.some((item) => item.type === "play_speech"),
    false,
  );
  const consent = listed.find((item) => item.type === "offer_consent");
  assert.ok(consent && consent.type === "offer_consent");
  assert.equal(consent.consent_scope, "approach_short");
});
