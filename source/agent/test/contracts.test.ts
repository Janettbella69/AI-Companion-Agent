import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDecisionSchema,
  emotionHypothesisSchema,
  inputModalitySchema,
  safeSkillRequestSchema,
} from "../src/domain/contracts.js";

const observedAt = "2026-08-14T20:00:00.000Z";
const expiresAt = "2026-08-14T20:02:00.000Z";

test("v0.4 accepts proximity evidence and separates user emotion from robot expression", () => {
  assert.equal(inputModalitySchema.parse("proximity"), "proximity");

  const emotion = emotionHypothesisSchema.parse({
    state: "unknown",
    valence: 0,
    arousal: 0.2,
    engagement: 0.4,
    confidence: 0.55,
    evidence: ["vision", "gesture"],
    observed_signals: ["用户向机器人挥手", "用户没有明确描述情绪"],
    alternative_states: ["positive_low", "unknown"],
    user_confirmed: false,
    expires_at: expiresAt,
  });
  assert.equal(emotion.user_confirmed, false);

  const decision = agentDecisionSchema.parse({
    reply_text: "我看到你啦，要我转过来吗？",
    expression: "noticed",
    robot_expression: {
      expression: "noticed",
      intensity: 0.6,
      duration_ms: 2_000,
      reason: "用温和的注意状态回应挥手",
    },
    emotion,
    actions_taken: [
      {
        tool_name: "mcp__hshh__set_expression",
        request_id: "request-expression-1",
        status: "completed",
        used_evidence_ids: ["gesture-1"],
      },
    ],
    requires_user_confirmation: true,
    used_evidence_ids: ["gesture-1"],
    output_modalities: ["speech", "display"],
  });
  assert.equal(decision.robot_expression?.expression, "noticed");
  assert.equal(decision.actions_taken?.[0]?.status, "completed");
});

test("v0.4 safe skill request binds the reason and expected device state", () => {
  const request = safeSkillRequestSchema.parse({
    request_id: "request-skill-1",
    device_id: "robot-1",
    skill: "approach_short",
    consent_token: "consent-1",
    expires_at: expiresAt,
    expected_device_state: "ready",
    reason: "用户明确同意短距离靠近",
  });
  assert.equal(request.device_id, "robot-1");
  assert.equal(request.expected_device_state, "ready");
  assert.equal(request.reason, "用户明确同意短距离靠近");
});

test("v0.3 decisions remain readable during protocol migration", () => {
  const legacy = agentDecisionSchema.parse({
    reply_text: "我在这里。",
    expression: "idle",
    emotion: {
      state: "unknown",
      valence: 0,
      arousal: 0.2,
      engagement: 0.3,
      confidence: 0.2,
      evidence: [],
      expires_at: expiresAt,
    },
    skill_request: {
      request_id: "legacy-request",
      skill: "stop",
      expires_at: observedAt,
    },
    requires_user_confirmation: false,
  });
  assert.equal(legacy.skill_request?.skill, "stop");
  assert.equal(legacy.robot_expression, undefined);
});
