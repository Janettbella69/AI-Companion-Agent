import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createFallbackDecision } from "../src/agent/fallbackAgent.js";
import type { DeviceContext, InteractionRequest } from "../src/domain/contracts.js";

const NOW = new Date("2026-08-14T18:00:00.000Z");

function context(overrides: Partial<DeviceContext> = {}): DeviceContext {
  return {
    device_id: "t5-demo-1",
    user_id: "user-1",
    observed_at: NOW.toISOString(),
    presence: "present",
    distance_cm: 90,
    distance_source: "hc_sr04",
    distance_observed_at: NOW.toISOString(),
    distance_valid: true,
    pose: "upright",
    battery: "normal",
    safety_state: "ready",
    ...overrides,
  };
}

function request(
  transcript: string,
  overrides: Partial<InteractionRequest> = {},
): InteractionRequest {
  return {
    transcript,
    device_context: context(),
    ...overrides,
  };
}

describe("createFallbackDecision", () => {
  it("never becomes a second intent router or emits cloud side effects", () => {
    const inputs = [
      request("停下", {
        device_context: context({
          pose: "fallen",
          battery: "low",
          safety_state: "fault",
        }),
      }),
      request("马上放开我"),
      request("可以靠近一点", {
        consent: {
          approach: true,
          hug: false,
          token: "trusted-token",
          scopes: ["approach_short"],
          granted_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
        },
      }),
      request("可以抱抱", {
        device_context: context({ safety_state: "stopped" }),
        consent: { approach: false, hug: true },
      }),
      request("我喜欢安静的陪伴"),
      request("你好", { device_context: context({ gesture: "stop" }) }),
    ];

    for (const input of inputs) {
      const result = createFallbackDecision(input, { now: NOW });
      assert.equal(result.skill_request, undefined);
      assert.equal(result.memory_candidate, undefined);
      assert.equal(result.requires_user_confirmation, false);
    }
  });

  it("returns one quiet, non-diagnostic availability response", () => {
    const result = createFallbackDecision(request("我有点累，想静静"), {
      reason: "offline",
      now: NOW,
    });

    assert.match(result.reply_text, /连不上云端/u);
    assert.match(result.reply_text, /停止和释放/u);
    assert.equal(result.expression, "sleeping");
    assert.equal(result.robot_expression?.expression, "sleeping");
    assert.equal(result.emotion.state, "unknown");
    assert.equal(result.emotion.user_confirmed, false);
    assert.deepEqual(result.output_modalities, ["speech", "display"]);
  });

  it("records the provider failure class without exposing error details", () => {
    const result = createFallbackDecision(request("你好"), {
      reason: "agent_error",
      now: NOW,
    });

    assert.equal(
      result.robot_expression?.reason,
      "provider_fallback:agent_error",
    );
    assert.equal(result.reply_text.includes("agent_error"), false);
  });
});
