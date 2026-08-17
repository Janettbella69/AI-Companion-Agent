import type {
  AgentDecision,
  EmotionHypothesis,
  InteractionRequest,
} from "../domain/contracts.js";

export type FallbackReason =
  | "missing_api_key"
  | "provider_unavailable"
  | "agent_error"
  | "timeout"
  | "offline";

export interface FallbackOptions {
  reason?: FallbackReason;
  now?: Date;
}

function unknownEmotion(now: Date): EmotionHypothesis {
  return {
    state: "unknown",
    valence: 0,
    arousal: 0.2,
    engagement: 0.35,
    confidence: 0.3,
    evidence: [],
    observed_signals: [],
    user_confirmed: false,
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
  };
}

/**
 * Fixed availability response for a failed Claude Agent SDK run.
 *
 * This deliberately is not a second Agent or a hand-written intent router: it
 * never interprets the transcript, selects a skill, writes memory, or infers an
 * emotion. Emergency stop and release remain local, deterministic device
 * capabilities and do not wait for this cloud response.
 */
export function createFallbackDecision(
  _request: InteractionRequest,
  reasonOrOptions: FallbackReason | FallbackOptions = {},
): AgentDecision {
  const options =
    typeof reasonOrOptions === "string"
      ? { reason: reasonOrOptions }
      : reasonOrOptions;
  const now = options.now ?? new Date();
  const reason = options.reason ?? "offline";

  return {
    reply_text: "我现在连不上云端，先保持不动。停止和释放仍可直接在设备上操作。",
    expression: "sleeping",
    robot_expression: {
      expression: "sleeping",
      intensity: 0.25,
      duration_ms: 5_000,
      reason: `provider_fallback:${reason}`,
    },
    emotion: unknownEmotion(now),
    requires_user_confirmation: false,
    output_modalities: ["speech", "display"],
  };
}

export const buildFallbackDecision = createFallbackDecision;
