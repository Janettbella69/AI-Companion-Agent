import type {
  SafeSkill,
  VerifiedVisionGuidance,
  VisualGuidance,
} from "../domain/contracts.js";

export const MIN_VISION_GUIDANCE_CONFIDENCE = 0.8;
export const MAX_VISION_GUIDANCE_AGE_MS = 15_000;

export interface VisionEvidenceBinding {
  captureId: string;
  evidenceId: string;
  observedAt: string;
  expiresAt: string;
}

export interface VisionGuidedStep {
  skill: Extract<SafeSkill, "approach_short" | "turn_to_user">;
  guidance: VerifiedVisionGuidance;
}

export type VisionGuidedStepSelection =
  | { status: "ready"; reason_code: "vision_step_ready"; step: VisionGuidedStep }
  | {
      status: "blocked";
      reason_code:
        | "visual_guidance_missing"
        | "visual_guidance_capture_mismatch"
        | "visual_guidance_target_unclear"
        | "visual_guidance_low_confidence"
        | "visual_evidence_invalid"
        | "visual_evidence_expired"
        | "approach_consent_required";
    };

export function selectVisionGuidedStep(input: {
  guidance?: VisualGuidance;
  evidence: VisionEvidenceBinding;
  hasApproachConsent: boolean;
  now?: Date;
}): VisionGuidedStepSelection {
  const now = input.now ?? new Date();
  const guidance = input.guidance;
  if (!guidance) {
    return { status: "blocked", reason_code: "visual_guidance_missing" };
  }
  if (guidance.capture_id !== input.evidence.captureId) {
    return {
      status: "blocked",
      reason_code: "visual_guidance_capture_mismatch",
    };
  }
  if (!guidance.person_visible || guidance.direction === "unknown") {
    return {
      status: "blocked",
      reason_code: "visual_guidance_target_unclear",
    };
  }
  if (guidance.confidence < MIN_VISION_GUIDANCE_CONFIDENCE) {
    return {
      status: "blocked",
      reason_code: "visual_guidance_low_confidence",
    };
  }

  const observedAtMs = Date.parse(input.evidence.observedAt);
  const expiresAtMs = Date.parse(input.evidence.expiresAt);
  if (
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= observedAtMs ||
    observedAtMs > now.getTime() + 1_000
  ) {
    return { status: "blocked", reason_code: "visual_evidence_invalid" };
  }
  if (
    expiresAtMs <= now.getTime() ||
    now.getTime() - observedAtMs > MAX_VISION_GUIDANCE_AGE_MS
  ) {
    return { status: "blocked", reason_code: "visual_evidence_expired" };
  }
  if (guidance.direction === "center" && !input.hasApproachConsent) {
    return { status: "blocked", reason_code: "approach_consent_required" };
  }

  return {
    status: "ready",
    reason_code: "vision_step_ready",
    step: {
      skill:
        guidance.direction === "center" ? "approach_short" : "turn_to_user",
      guidance: {
        source: "esp32_cam",
        capture_id: input.evidence.captureId,
        evidence_id: input.evidence.evidenceId,
        observed_at: input.evidence.observedAt,
        direction: guidance.direction,
        confidence_milli: Math.round(guidance.confidence * 1_000),
      },
    },
  };
}
