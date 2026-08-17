import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceEvent, ImageObservation } from "../src/domain/contracts.js";
import {
  EventContextGateway,
  EventContextGatewayError,
} from "../src/gateway/EventContextGateway.js";

const START = new Date("2026-08-14T16:00:00.000Z");
const PNG_HEADER_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

function testGateway() {
  let current = new Date(START);
  let sequence = 0;
  const gateway = new EventContextGateway({
    now: () => new Date(current),
    idFactory: () => String(++sequence).padStart(4, "0"),
  });
  return {
    gateway,
    now: () => new Date(current),
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function event(overrides: Partial<DeviceEvent> = {}): DeviceEvent {
  return {
    device_id: "device-1",
    user_id: "user-1",
    event: "user_text",
    source: "web_text",
    occurred_at: START.toISOString(),
    payload: {
      transcript: "你好",
      summary: "用户说：你好",
      confidence: 1,
    },
    ...overrides,
  };
}

test("assigns evidence IDs and builds a bounded current context", () => {
  const { gateway, now } = testGateway();
  const first = gateway.ingestEvent(event());
  assert.equal(first.accepted, true);
  if (first.accepted) {
    assert.match(first.evidence_id, /^ev_/u);
    assert.match(first.event_id, /^evt_/u);
  }

  const current = gateway.getCurrentContext("device-1", {
    windowMs: 5_000,
    now: now(),
  });
  assert.equal(current.context.window_started_at, "2026-08-14T15:59:55.000Z");
  assert.equal(current.context.window_ended_at, START.toISOString());
  assert.equal(current.context.evidence.length, 1);
  assert.equal(current.context.transcript, "你好");
  assert.equal(current.context_generated, true);
  assert.ok(current.context.unavailable_modalities.includes("vision"));

  assert.throws(
    () => gateway.getCurrentContext("device-1", { windowMs: 4_999, now: now() }),
    (error: unknown) =>
      error instanceof EventContextGatewayError && error.code === "invalid_window",
  );
  assert.throws(
    () => gateway.getCurrentContext("device-1", { windowMs: 15_001, now: now() }),
    (error: unknown) =>
      error instanceof EventContextGatewayError && error.code === "invalid_window",
  );
});

test("only explicit language/text or confirmation gestures mint scoped consent", () => {
  const { gateway, now } = testGateway();
  const explicit = gateway.ingestEvent(
    event({
      event: "approach_consent_granted",
      source: "web_text",
      payload: {
        transcript: "可以靠近",
        summary: "用户明确说可以靠近",
        explicit: true,
      },
    }),
  );
  assert.equal(explicit.accepted, true);
  assert.equal(
    explicit.accepted ? explicit.consent?.scope : undefined,
    "approach_short",
  );
  const token = explicit.accepted ? explicit.consent?.token : undefined;
  assert.ok(token);
  assert.ok(
    gateway.validateConsentToken(
      token ?? "",
      "device-1",
      "approach_short",
      "user-1",
      now(),
    ),
  );

  const inferredSpeech = gateway.ingestEvent(
    event({
      event: "hug_consent_granted",
      source: "t5_microphone",
      payload: { transcript: "可能吧", summary: "ASR 文本不含明确标记" },
    }),
  );
  assert.equal(inferredSpeech.accepted, true);
  assert.equal(inferredSpeech.accepted ? inferredSpeech.consent : undefined, undefined);

  const visual = gateway.ingestEvent(
    event({
      event: "approach_consent_granted",
      source: "t5_camera",
      payload: {
        modality: "vision",
        summary: "视觉模型猜测用户愿意靠近",
        explicit: true,
      },
    }),
  );
  assert.equal(visual.accepted, true);
  assert.equal(visual.accepted ? visual.consent : undefined, undefined);
});

test("reject and stop revoke consent, sort first, and mark conflicts", () => {
  const { gateway, now, advance } = testGateway();
  const grant = gateway.ingestEvent(
    event({
      event: "approach_consent_granted",
      payload: {
        transcript: "可以靠近",
        summary: "用户明确允许短距离靠近",
        explicit: true,
      },
    }),
  );
  assert.equal(grant.accepted, true);
  const token = grant.accepted ? grant.consent?.token : undefined;

  advance(100);
  const reject = gateway.ingestEvent(
    event({
      event: "gesture_reject",
      source: "apds9960",
      occurred_at: now().toISOString(),
      payload: { gesture: "reject", summary: "APDS9960 检测到拒绝手势" },
    }),
  );
  assert.equal(reject.accepted, true);
  assert.equal(reject.accepted ? reject.priority : undefined, "reject");
  assert.equal(
    gateway.validateConsentToken(
      token ?? "",
      "device-1",
      "approach_short",
      "user-1",
      now(),
    ),
    undefined,
  );

  advance(100);
  const stop = gateway.ingestEvent(
    event({
      event: "user_stop",
      source: "t5_microphone",
      occurred_at: now().toISOString(),
      payload: { transcript: "停下", summary: "用户明确要求停止" },
    }),
  );
  assert.equal(stop.accepted, true);
  const current = gateway.getCurrentContext("device-1", { now: now() });
  assert.equal(current.active_consents.length, 0);
  assert.equal(current.context.has_conflict, true);
  assert.match(current.context.evidence[0]?.summary ?? "", /停止/u);
  assert.match(current.context.evidence[1]?.summary ?? "", /拒绝/u);
});

test("keeps expired evidence out of current context but available to recent-event audit", () => {
  const { gateway, now } = testGateway();
  const old = gateway.ingestEvent(
    event({ occurred_at: "2026-08-14T15:59:40.000Z" }),
  );
  assert.equal(old.accepted, true);
  const current = gateway.getCurrentContext("device-1", { now: now() });
  assert.equal(current.context.evidence.length, 0);
  assert.equal(gateway.getRecentEvents("device-1", { now: now() }).length, 1);
});

test("updates explicit device context with fresh distance, pose, and gesture facts", () => {
  const { gateway, now, advance } = testGateway();
  gateway.updateDeviceContext({
    device_id: "device-1",
    user_id: "user-1",
    observed_at: START.toISOString(),
    presence: "present",
    pose: "upright",
    battery: "normal",
    safety_state: "ready",
  });
  advance(100);
  gateway.ingestEvent(
    event({
      event: "distance_observed",
      source: "hc_sr04",
      occurred_at: now().toISOString(),
      payload: {
        distance_cm: 62,
        valid: true,
        summary: "HC-SR04 有效距离 62 cm",
      },
    }),
  );
  const context = gateway.getDeviceContext("device-1");
  assert.equal(context?.distance_cm, 62);
  assert.equal(context?.distance_valid, true);
  assert.equal(context?.distance_source, "hc_sr04");
  assert.equal(context?.distance_observed_at, now().toISOString());
});

test("stores only fresh, evidence-bound triggered keyframes in ephemeral memory", () => {
  const { gateway, now, advance } = testGateway();
  const observedAt = now().toISOString();
  const ingested = gateway.ingestEvent(
    event({
      event: "keyframe_captured",
      source: "t5_camera",
      occurred_at: observedAt,
      payload: {
        modality: "vision",
        media_ref: "capture-1",
        summary: "触发式关键帧已采集",
      },
    }),
  );
  assert.equal(ingested.accepted, true);
  const image: ImageObservation = {
    capture_id: "capture-1",
    observed_at: observedAt,
    mime: "image/png",
    source: "t5_camera",
    base64: PNG_HEADER_BASE64,
  };
  gateway.registerKeyframe(
    "device-1",
    ingested.accepted ? ingested.evidence_id : "",
    image,
    now(),
  );
  assert.equal(
    gateway.getKeyframe("device-1", "capture-1", now())?.image.capture_id,
    "capture-1",
  );
  advance(15_001);
  assert.equal(gateway.getKeyframe("device-1", "capture-1", now()), undefined);
});

test("rejects raw media embedded in structured event payloads", () => {
  const { gateway } = testGateway();
  const result = gateway.ingestEvent(
    event({
      event: "keyframe_captured",
      source: "t5_camera",
      payload: {
        modality: "vision",
        media_ref: "capture-1",
        base64: PNG_HEADER_BASE64,
      },
    }),
  );
  assert.deepEqual(result, {
    accepted: false,
    reason_code: "raw_media_not_allowed",
  });
  assert.equal(gateway.getRecentEvents("device-1").length, 0);
});
