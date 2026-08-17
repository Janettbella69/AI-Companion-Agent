import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AgentDecision,
  DeviceContext,
  InteractionRequest,
  MultimodalContext,
  SkillName,
} from "../src/domain/contracts.js";
import {
  applyPolicyGate,
  evaluateSkillRequest,
  isExplicitMemoryCandidate,
  type EnrichedSafeSkillCommand,
} from "../src/policy/policyGate.js";

const NOW = new Date("2026-08-14T18:00:00.000Z");

function context(overrides: Partial<DeviceContext> = {}): DeviceContext {
  return {
    device_id: "t5-demo-1",
    user_id: "user-1",
    observed_at: NOW.toISOString(),
    presence: "present",
    distance_cm: 80,
    distance_source: "hc_sr04",
    distance_observed_at: NOW.toISOString(),
    distance_valid: true,
    pose: "upright",
    battery: "normal",
    safety_state: "ready",
    ...overrides,
  };
}

function decision(skill?: SkillName): AgentDecision {
  const value: AgentDecision = {
    reply_text: "我在这里。",
    expression: "idle",
    emotion: {
      state: "positive_high",
      valence: 0.7,
      arousal: 0.5,
      engagement: 0.5,
      confidence: 0.9,
      evidence: ["vision"],
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    },
    requires_user_confirmation: false,
  };
  if (skill) {
    value.skill_request = {
      request_id: "model-controlled-id",
      skill,
      expires_at: "2099-01-01T00:00:00.000Z",
      consent_token: "model-controlled-consent",
    };
  }
  return value;
}

function request(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    transcript: "你好",
    device_context: context(),
    ...overrides,
  };
}

function visualContext(expiresAt: string): MultimodalContext {
  return {
    context_id: "ctx-1",
    window_started_at: new Date(NOW.getTime() - 5_000).toISOString(),
    window_ended_at: NOW.toISOString(),
    evidence: [
      {
        evidence_id: "vision-1",
        modality: "vision",
        source: "t5_camera",
        observed_at: NOW.toISOString(),
        expires_at: expiresAt,
        confidence: 0.98,
        summary: "画面里的人似乎在点头",
      },
    ],
    unavailable_modalities: [],
    has_conflict: false,
  };
}

describe("evaluateSkillRequest", () => {
  it("always permits stop and release_hug, even during a fault", () => {
    const unsafeContext = context({
      observed_at: "2020-01-01T00:00:00.000Z",
      pose: "fallen",
      battery: "low",
      safety_state: "fault",
    });

    for (const skill of ["stop", "release_hug"] as const) {
      const result = evaluateSkillRequest({ skill, context: unsafeContext, now: NOW });
      assert.equal(result.allowed, true);
      assert.equal(result.command?.skill, skill);
    }
  });

  it("requires explicit consent and a fresh HC-SR04 reading before approach", () => {
    const noConsent = evaluateSkillRequest({
      skill: "approach_short",
      context: context(),
      now: NOW,
    });
    assert.equal(noConsent.allowed, false);
    assert.equal(noConsent.reason, "approach_consent_required");

    const staleDistance = evaluateSkillRequest({
      skill: "approach_short",
      context: context({
        distance_observed_at: new Date(NOW.getTime() - 501).toISOString(),
      }),
      consent: { approach: true, hug: false },
      now: NOW,
    });
    assert.equal(staleDistance.allowed, false);
    assert.equal(staleDistance.reason, "distance_stale");
  });

  it("issues a fresh server command for a valid scoped consent token", () => {
    const result = evaluateSkillRequest({
      skill: "approach_short",
      context: context(),
      consent: {
        approach: true,
        hug: false,
        token: "consent-issued-by-server",
        scopes: ["approach_short"],
        granted_at: new Date(NOW.getTime() - 1_000).toISOString(),
        expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
      },
      reason: "explicit_user_consent",
      now: NOW,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.command?.skill, "approach_short");
    assert.equal(result.command?.consent_token, "consent-issued-by-server");
    assert.notEqual(result.command?.request_id, "model-controlled-id");
    assert.equal(result.command?.device_id, "t5-demo-1");
    assert.equal(result.command?.expected_device_state, "ready");
    assert.equal(result.command?.reason, "explicit_user_consent");
    assert.equal(
      result.command?.expires_at,
      new Date(NOW.getTime() + 1_500).toISOString(),
    );
  });

  it("blocks approach while held, too close, invalid, or low on battery", () => {
    const unsafeCases: DeviceContext[] = [
      context({ pose: "held" }),
      context({ distance_cm: 45 }),
      context({ distance_valid: false }),
      context({ battery: "low" }),
    ];

    for (const unsafeContext of unsafeCases) {
      const result = evaluateSkillRequest({
        skill: "approach_short",
        context: unsafeContext,
        consent: { approach: true, hug: false },
        now: NOW,
      });
      assert.equal(result.allowed, false);
    }
  });

  it("requires hug consent, a stopped device, and no active movement", () => {
    const withoutConsent = evaluateSkillRequest({
      skill: "invite_hug",
      context: context({ safety_state: "stopped" }),
      now: NOW,
    });
    assert.equal(withoutConsent.reason, "hug_consent_required");

    const whileMoving = evaluateSkillRequest({
      skill: "invite_hug",
      context: context({
        active_skill: "approach_short",
        safety_state: "stopped",
      }),
      consent: { approach: false, hug: true },
      now: NOW,
    });
    assert.equal(whileMoving.reason, "device_still_moving");

    const notStopped = evaluateSkillRequest({
      skill: "invite_hug",
      context: context({ safety_state: "ready" }),
      consent: { approach: false, hug: true },
      now: NOW,
    });
    assert.equal(notStopped.reason, "device_not_stopped:ready");

    const accepted = evaluateSkillRequest({
      skill: "invite_hug",
      context: context({ safety_state: "stopped" }),
      consent: { approach: false, hug: true },
      reason: "explicit_hug_consent",
      now: NOW,
    });
    assert.equal(accepted.allowed, true);
    assert.equal(accepted.command?.expected_device_state, "stopped");
    assert.equal(accepted.command?.reason, "explicit_hug_consent");
  });

  it("blocks approach and hug on reject/stop gestures or conflicting evidence", () => {
    for (const gesture of ["reject", "stop"] as const) {
      const approach = evaluateSkillRequest({
        skill: "approach_short",
        context: context({ gesture }),
        consent: { approach: true, hug: false },
        now: NOW,
      });
      assert.equal(approach.allowed, false);
      assert.equal(approach.reason, `gesture_${gesture}`);

      const hug = evaluateSkillRequest({
        skill: "invite_hug",
        context: context({ gesture, safety_state: "stopped" }),
        consent: { approach: false, hug: true },
        now: NOW,
      });
      assert.equal(hug.allowed, false);
      assert.equal(hug.reason, `gesture_${gesture}`);
    }

    for (const skill of ["approach_short", "invite_hug"] as const) {
      const conflict = evaluateSkillRequest({
        skill,
        context: context({
          safety_state: skill === "invite_hug" ? "stopped" : "ready",
        }),
        consent: { approach: true, hug: true },
        hasConflict: true,
        now: NOW,
      });
      assert.equal(conflict.allowed, false);
      assert.equal(conflict.reason, "multimodal_conflict");
    }
  });

  it("allows a consented approach without sensors in supervised unsensored mode", () => {
    const unsensoredContext: DeviceContext = {
      device_id: "t5-demo-1",
      user_id: "user-1",
      observed_at: NOW.toISOString(),
      presence: "unknown",
      pose: "unknown",
      battery: "unknown",
      safety_state: "stopped",
    };

    const noConsent = evaluateSkillRequest({
      skill: "approach_short",
      context: unsensoredContext,
      allowUnsensoredMotion: true,
      now: NOW,
    });
    assert.equal(noConsent.allowed, false);
    assert.equal(noConsent.reason, "approach_consent_required");

    const accepted = evaluateSkillRequest({
      skill: "approach_short",
      context: unsensoredContext,
      consent: { approach: true, hug: false },
      allowUnsensoredMotion: true,
      now: NOW,
    });
    assert.equal(accepted.allowed, true);
    assert.equal(accepted.reason, "unsensored_demo_approach");
    assert.equal(accepted.command?.expected_device_state, "stopped");

    const held = evaluateSkillRequest({
      skill: "approach_short",
      context: { ...unsensoredContext, pose: "held" },
      consent: { approach: true, hug: false },
      allowUnsensoredMotion: true,
      now: NOW,
    });
    assert.equal(held.allowed, false);
    assert.equal(held.reason, "device_held");

    const lowBattery = evaluateSkillRequest({
      skill: "approach_short",
      context: { ...unsensoredContext, battery: "low" },
      consent: { approach: true, hug: false },
      allowUnsensoredMotion: true,
      now: NOW,
    });
    assert.equal(lowBattery.allowed, false);
    assert.equal(lowBattery.reason, "battery_low");
  });
});

describe("applyPolicyGate", () => {
  it("does not treat high-confidence VLM evidence as movement consent", () => {
    const modelDecision = decision("approach_short");
    modelDecision.used_evidence_ids = ["vision-1"];

    const gated = applyPolicyGate(
      modelDecision,
      request({
        multimodal_context: visualContext(
          new Date(NOW.getTime() + 30_000).toISOString(),
        ),
      }),
      NOW,
    );

    assert.equal(gated.skill_request, undefined);
    assert.equal(gated.requires_user_confirmation, true);
    assert.equal(gated.confirmation_scope, "approach_short");
  });

  it("replaces model-controlled command metadata after consent validation", () => {
    const gated = applyPolicyGate(
      decision("approach_short"),
      request({
        transcript: "可以靠近一点",
        consent: {
          approach: true,
          hug: false,
          token: "trusted-token",
          scopes: ["approach_short"],
          granted_at: NOW.toISOString(),
          expires_at: new Date(NOW.getTime() + 30_000).toISOString(),
        },
      }),
      NOW,
    );

    assert.equal(gated.skill_request?.skill, "approach_short");
    assert.notEqual(gated.skill_request?.request_id, "model-controlled-id");
    assert.equal(gated.skill_request?.consent_token, "trusted-token");
    const command = gated.skill_request as EnrichedSafeSkillCommand;
    assert.equal(command.device_id, "t5-demo-1");
    assert.equal(command.expected_device_state, "ready");
    assert.equal(command.reason, "agent_decision");
  });

  it("drops consented approach when multimodal evidence conflicts", () => {
    const conflictedContext = visualContext(
      new Date(NOW.getTime() + 30_000).toISOString(),
    );
    conflictedContext.has_conflict = true;
    const gated = applyPolicyGate(
      decision("approach_short"),
      request({
        transcript: "可以靠近一点",
        consent: { approach: true, hug: false },
        multimodal_context: conflictedContext,
      }),
      NOW,
    );

    assert.equal(gated.skill_request, undefined);
  });

  it("drops skills that cite unknown or expired multimodal evidence", () => {
    const modelDecision = decision("turn_to_user");
    modelDecision.used_evidence_ids = ["vision-1", "unknown-id"];
    const gated = applyPolicyGate(
      modelDecision,
      request({
        multimodal_context: visualContext(
          new Date(NOW.getTime() - 1).toISOString(),
        ),
      }),
      NOW,
    );

    assert.equal(gated.skill_request, undefined);
    assert.deepEqual(gated.used_evidence_ids, []);
  });

  it("turns low-confidence or conflicting emotion into unknown", () => {
    const lowConfidence = decision();
    lowConfidence.emotion.confidence = 0.64;
    assert.equal(
      applyPolicyGate(lowConfidence, request(), NOW).emotion.state,
      "unknown",
    );

    const conflictDecision = decision();
    const conflictedContext = visualContext(
      new Date(NOW.getTime() + 30_000).toISOString(),
    );
    conflictedContext.has_conflict = true;
    assert.equal(
      applyPolicyGate(
        conflictDecision,
        request({ multimodal_context: conflictedContext }),
        NOW,
      ).emotion.state,
      "unknown",
    );
  });

  it("keeps only explicit, confirmable, non-diagnostic memory candidates", () => {
    const valid = decision();
    valid.memory_candidate = {
      kind: "preference",
      summary: "  用户喜欢安静陪伴  ",
      source: "explicit_user",
      requires_confirmation: true,
    };
    const gatedValid = applyPolicyGate(valid, request(), NOW);
    assert.equal(gatedValid.memory_candidate?.summary, "用户喜欢安静陪伴");
    assert.equal(gatedValid.requires_user_confirmation, true);
    assert.equal(gatedValid.confirmation_scope, "memory");

    const unsafe = decision();
    unsafe.memory_candidate = {
      kind: "profile",
      summary: "用户可能患有抑郁症",
      source: "explicit_user",
      requires_confirmation: true,
    };
    assert.equal(applyPolicyGate(unsafe, request(), NOW).memory_candidate, undefined);
    assert.equal(isExplicitMemoryCandidate(unsafe.memory_candidate), false);
  });
});
