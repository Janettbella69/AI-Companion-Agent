import assert from "node:assert/strict";
import test from "node:test";

import { DeviceEffectQueue } from "../src/device/deviceEffectQueue.js";
import type { HshhDeviceEffect } from "../src/mcp/deviceServer.js";

test("T5 effect queue is scoped, idempotent, expiring, and never carries motion", () => {
  let nowMs = Date.parse("2026-08-15T00:00:00.000Z");
  let id = 0;
  const queue = new DeviceEffectQueue({
    now: () => new Date(nowMs),
    idFactory: () => `id-${++id}`,
  });
  const expression: HshhDeviceEffect = {
    type: "set_expression",
    request_id: "request-1",
    actor_user_id: "user-1",
    device_id: "robot-1",
    expression: "happy",
    intensity: 0.8,
    duration_ms: 1_200,
    reason: "gentle_feedback",
  };

  assert.equal(queue.enqueue(expression).reason_code, "effect_queued_for_t5");
  assert.equal(queue.enqueue(expression).reason_code, "effect_already_queued");
  assert.equal(queue.list("another-robot").length, 0);
  const listed = queue.list("robot-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.type, "set_expression");
  assert.equal(queue.acknowledge("another-robot", listed[0]!.effect_id, {
    status: "completed",
    reason_code: "wrong_scope",
  }), false);
  assert.equal(queue.acknowledge("robot-1", listed[0]!.effect_id, {
    status: "completed",
    reason_code: "t5_effect_applied",
  }), true);
  assert.equal(queue.list("robot-1").length, 0);

  assert.equal(
    queue.enqueueConsentOffer({
      requestId: "request-consent",
      deviceId: "robot-1",
      scope: "approach_short",
    }).reason_code,
    "consent_offer_queued_for_t5",
  );
  const consent = queue.list("robot-1");
  assert.equal(consent.length, 1);
  assert.equal(consent[0]?.type, "offer_consent");
  if (consent[0]?.type === "offer_consent") {
    assert.equal(consent[0].consent_scope, "approach_short");
  }
  assert.equal(queue.acknowledge("robot-1", consent[0]!.effect_id, {
    status: "completed",
    reason_code: "t5_effect_applied",
  }), true);

  assert.equal(
    queue.enqueue({
      ...expression,
      request_id: "request-2",
      type: "play_sound",
      sound: "success",
    }).status,
    "accepted",
  );
  nowMs += 30_001;
  assert.equal(queue.list("robot-1").length, 0);

  const motion = {
    type: "safe_skill",
    request_id: "request-motion",
    actor_user_id: "user-1",
    device_id: "robot-1",
    command: {},
  } as HshhDeviceEffect;
  assert.equal(queue.enqueue(motion).reason_code, "effect_queue_motion_forbidden");
});

test("effect sequence survives an Agent-style restart past a stale T5 cursor", () => {
  const first = new DeviceEffectQueue({
    now: () => new Date("2026-08-16T00:00:00.000Z"),
    idFactory: () => "a",
  });
  first.enqueue({
    type: "play_sound",
    request_id: "old-1",
    actor_user_id: "user-1",
    device_id: "robot-1",
    sound: "success",
    reason: "boot",
  });
  const staleCursor = first.list("robot-1")[0]!.sequence;
  const restarted = new DeviceEffectQueue({
    now: () => new Date("2026-08-16T00:00:05.000Z"),
    idFactory: () => "b",
  });
  restarted.enqueuePlaySpeech({
    requestId: "turn-1",
    deviceId: "robot-1",
    speechId: "spch_1",
    sampleRate: 16000,
    durationMs: 900,
  });
  const next = restarted.list("robot-1")[0]!.sequence;
  assert.ok(next > staleCursor);
  assert.ok(next >= 1_777_000_000);
});

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
