import { randomUUID } from "node:crypto";

import type {
  AgentDecision,
  ConsentGrant,
  DeviceContext,
  InteractionRequest,
  MemoryCandidate,
  SafeSkillCommand,
  SkillName,
} from "../domain/contracts.js";

const MIN_APPROACH_DISTANCE_CM = 45;
const EMOTION_CONFIDENCE_THRESHOLD = 0.65;
const MAX_DISTANCE_AGE_MS = 500;
const MAX_DEVICE_CONTEXT_AGE_MS = 5_000;

const SKILL_TTL_MS: Readonly<Record<SkillName, number>> = {
  stop: 1_000,
  approach_short: 1_500,
  turn_to_user: 1_500,
  invite_hug: 2_500,
  release_hug: 1_000,
};

const UNCERTAIN_MEMORY_PATTERNS = [
  /(?:可能|也许|似乎|大概|看起来|推测|猜测)/u,
  /(?:抑郁|焦虑症|双相|诊断|心理疾病)/u,
  /(?:你内心|真实情绪|其实你|正在生气|很悲伤)/u,
  /(?:我的朋友|我朋友|我妈妈|我爸爸|我同事|他患有|她患有)/u,
];

export interface SkillEvaluationInput {
  skill: SkillName;
  context: DeviceContext;
  consent?: ConsentGrant;
  hasConflict?: boolean;
  /**
   * A short, audit-safe reason bound into the approved device command. Never
   * pass hidden reasoning, raw prompts, or model chain-of-thought here.
   */
  reason?: string;
  now?: Date;
  /**
   * Supervised demo without HC-SR04 / BNO055. Skips distance, unknown pose,
   * unknown battery, unknown presence, and the ready-only approach gate.
   * Consent, stop/reject, held/fallen/tilted, low battery, and fault still deny.
   */
  allowUnsensoredMotion?: boolean;
}

export interface PolicyResult {
  allowed: boolean;
  reason: string;
  command?: EnrichedSafeSkillCommand;
}

export type EnrichedSafeSkillCommand = SafeSkillCommand & {
  device_id: string;
  expected_device_state: DeviceContext["safety_state"];
  reason: string;
};

function deny(reason: string): PolicyResult {
  return { allowed: false, reason };
}

function allow(
  skill: SkillName,
  policyReason: string,
  context: DeviceContext,
  now: Date,
  consentToken?: string,
  commandReason?: string,
): PolicyResult {
  return {
    allowed: true,
    reason: policyReason,
    command: createSafeSkillCommand(
      skill,
      context,
      commandReason ?? policyReason,
      now,
      consentToken,
    ),
  };
}

function isFiniteDistance(distanceCm: number | undefined): distanceCm is number {
  return typeof distanceCm === "number" && Number.isFinite(distanceCm);
}

function isMovingSkill(skill: SkillName | undefined): boolean {
  return skill === "approach_short" || skill === "turn_to_user";
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isFreshTimestamp(value: string | undefined, now: Date, maxAgeMs: number): boolean {
  const timestamp = parseTimestamp(value);
  if (timestamp === undefined) {
    return false;
  }
  const age = now.getTime() - timestamp;
  return age >= -1_000 && age <= maxAgeMs;
}

function consentForSkill(
  consent: ConsentGrant | undefined,
  skill: "approach_short" | "invite_hug",
  now: Date,
): { granted: boolean; token?: string } {
  if (!consent) {
    return { granted: false };
  }

  const hasTokenShape =
    typeof consent.token === "string" || Array.isArray(consent.scopes);
  if (hasTokenShape) {
    if (!consent.token?.trim() || !consent.scopes?.includes(skill)) {
      return { granted: false };
    }
    const grantedAt = parseTimestamp(consent.granted_at);
    const expiresAt = parseTimestamp(consent.expires_at);
    if (
      grantedAt === undefined ||
      expiresAt === undefined ||
      grantedAt > now.getTime() + 1_000 ||
      expiresAt <= now.getTime()
    ) {
      return { granted: false };
    }
    return { granted: true, token: consent.token.trim() };
  }

  // Compatibility path for trusted callers that already resolved an explicit
  // voice/text/button event into booleans. Model/VLM output is never read here.
  const granted = skill === "approach_short" ? consent.approach === true : consent.hug === true;
  if (consent.expires_at) {
    const expiresAt = parseTimestamp(consent.expires_at);
    if (expiresAt === undefined || expiresAt <= now.getTime()) {
      return { granted: false };
    }
  }
  return { granted };
}

/**
 * Creates the only command shape allowed to leave the backend. IDs and expiry
 * are always generated here, so model-supplied request IDs and TTLs are ignored.
 */
export function createSafeSkillCommand(
  skill: SkillName,
  context: DeviceContext,
  reason: string,
  now: Date = new Date(),
  consentToken?: string,
): EnrichedSafeSkillCommand {
  const expiresAt = new Date(now.getTime() + SKILL_TTL_MS[skill]).toISOString();
  const normalizedReason = reason.replace(/\s+/gu, " ").trim().slice(0, 160);
  const command = {
    request_id: randomUUID(),
    device_id: context.device_id,
    skill,
    expires_at: expiresAt,
    expected_device_state: context.safety_state,
    reason: normalizedReason || "policy_approved",
    ...(consentToken ? { consent_token: consentToken } : {}),
  };

  return command as EnrichedSafeSkillCommand;
}

/**
 * Server-side motion policy. This function does not read databases, environment
 * variables, or device transports; callers provide a captured device context.
 * The ESP32-S3 must still repeat these checks immediately before actuation.
 */
export function evaluateSkillRequest(input: SkillEvaluationInput): PolicyResult {
  const {
    skill,
    context,
    consent,
    hasConflict = false,
    reason,
    now = new Date(),
    allowUnsensoredMotion = false,
  } = input;

  // Escape actions are unconditional and may pre-empt every other skill.
  if (skill === "stop" || skill === "release_hug") {
    return allow(
      skill,
      "escape_action",
      context,
      now,
      undefined,
      reason ?? "escape_action",
    );
  }

  if (skill === "approach_short" || skill === "invite_hug") {
    if (context.gesture === "stop") {
      return deny("gesture_stop");
    }
    if (context.gesture === "reject") {
      return deny("gesture_reject");
    }
    if (hasConflict) {
      return deny("multimodal_conflict");
    }
  }

  if (
    !allowUnsensoredMotion &&
    !isFreshTimestamp(context.observed_at, now, MAX_DEVICE_CONTEXT_AGE_MS)
  ) {
    return deny("device_context_stale");
  }

  if (context.safety_state === "fault") {
    return deny("device_fault");
  }

  if (context.battery === "low") {
    return deny("battery_low");
  }
  if (!allowUnsensoredMotion && context.battery !== "normal") {
    return deny("battery_unknown");
  }

  if (context.pose === "held") {
    return deny("device_held");
  }
  if (context.pose === "tilted" || context.pose === "fallen") {
    return deny(`unsafe_pose:${context.pose}`);
  }
  if (!allowUnsensoredMotion && context.pose !== "upright") {
    return deny(`unsafe_pose:${context.pose}`);
  }

  if (skill === "approach_short") {
    const approval = consentForSkill(consent, skill, now);
    if (!approval.granted) {
      return deny("approach_consent_required");
    }
    if (context.presence === "absent") {
      return deny("user_presence_required");
    }
    if (!allowUnsensoredMotion && context.presence !== "present") {
      return deny("user_presence_required");
    }
    if (context.safety_state !== "ready") {
      if (!allowUnsensoredMotion || context.safety_state !== "stopped") {
        return deny(`device_not_ready:${context.safety_state}`);
      }
    }
    if (!allowUnsensoredMotion) {
      if (!isFiniteDistance(context.distance_cm)) {
        return deny("distance_unavailable");
      }
      if (context.distance_valid !== true) {
        return deny("distance_invalid");
      }
      if (context.distance_source !== "hc_sr04") {
        return deny("distance_source_untrusted");
      }
      if (!isFreshTimestamp(context.distance_observed_at, now, MAX_DISTANCE_AGE_MS)) {
        return deny("distance_stale");
      }
      if (context.distance_cm <= MIN_APPROACH_DISTANCE_CM) {
        return deny("distance_too_close");
      }
    }

    return allow(
      skill,
      allowUnsensoredMotion ? "unsensored_demo_approach" : "safe_to_approach",
      context,
      now,
      approval.token,
      reason,
    );
  }

  if (skill === "turn_to_user") {
    if (context.presence === "absent") {
      return deny("user_presence_required");
    }
    if (!allowUnsensoredMotion && context.presence !== "present") {
      return deny("user_presence_required");
    }
    if (context.safety_state !== "ready") {
      if (!allowUnsensoredMotion || context.safety_state !== "stopped") {
        return deny(`device_not_ready:${context.safety_state}`);
      }
    }

    return allow(skill, "safe_to_turn", context, now, undefined, reason);
  }

  if (skill === "invite_hug") {
    const approval = consentForSkill(consent, skill, now);
    if (!approval.granted) {
      return deny("hug_consent_required");
    }
    if (isMovingSkill(context.active_skill)) {
      return deny("device_still_moving");
    }
    if (context.safety_state !== "stopped") {
      return deny(`device_not_stopped:${context.safety_state}`);
    }

    return allow(
      skill,
      "safe_to_invite_hug",
      context,
      now,
      approval.token,
      reason,
    );
  }

  return deny("skill_not_allowed");
}

/** Convert low-confidence emotion classification into an explicit unknown. */
export function normalizeLowConfidenceEmotion(decision: AgentDecision): AgentDecision {
  if (decision.emotion.confidence >= EMOTION_CONFIDENCE_THRESHOLD) {
    return decision;
  }

  return {
    ...decision,
    emotion: {
      ...decision.emotion,
      state: "unknown",
    },
  };
}

/**
 * Memory is only eligible when the model marks an explicit/confirmed source.
 * Even eligible memories remain candidates and always require user confirmation.
 */
export function isExplicitMemoryCandidate(candidate: MemoryCandidate): boolean {
  const summary = candidate.summary.trim();
  if (summary.length < 2 || summary.length > 240) {
    return false;
  }
  if (candidate.source !== "explicit_user" && candidate.source !== "confirmed_interaction") {
    return false;
  }

  return !UNCERTAIN_MEMORY_PATTERNS.some((pattern) => pattern.test(summary));
}

function sanitizeMemoryCandidate(
  candidate: MemoryCandidate | undefined,
): MemoryCandidate | undefined {
  if (!candidate || !isExplicitMemoryCandidate(candidate)) {
    return undefined;
  }

  return {
    ...candidate,
    summary: candidate.summary.trim(),
    requires_confirmation: true,
  };
}

function getRequestContext(request: InteractionRequest): DeviceContext {
  return request.device_context;
}

function getRequestConsent(request: InteractionRequest): ConsentGrant | undefined {
  return request.consent;
}

function getValidEvidenceReferences(
  decision: AgentDecision,
  request: InteractionRequest,
  now: Date,
): { allValid: boolean; ids: string[] | undefined } {
  const requestedIds = decision.used_evidence_ids;
  if (!requestedIds) {
    return { allValid: true, ids: undefined };
  }
  const context = request.multimodal_context;
  if (!context) {
    return { allValid: requestedIds.length === 0, ids: [] };
  }

  const evidenceById = new Map(context.evidence.map((item) => [item.evidence_id, item]));
  const validIds = requestedIds.filter((id) => {
    const evidence = evidenceById.get(id);
    if (!evidence) {
      return false;
    }
    const observedAt = parseTimestamp(evidence.observed_at);
    const expiresAt = parseTimestamp(evidence.expires_at);
    return (
      observedAt !== undefined &&
      expiresAt !== undefined &&
      observedAt <= now.getTime() + 1_000 &&
      expiresAt > now.getTime()
    );
  });

  return {
    allValid: validIds.length === requestedIds.length,
    ids: validIds,
  };
}

function hasExplicitEmotionCorrection(transcript: string): boolean {
  return /(?:我没事|我很好|我没有(?:生气|难过|伤心)|别猜我的情绪|你猜错了)/u.test(transcript);
}

export interface PolicyGateOptions {
  allowUnsensoredMotion?: boolean;
}

/**
 * Final trust boundary for model decisions. This revalidates the requested
 * high-level skill against fresh context and replaces all command metadata.
 */
export function applyPolicyGate(
  decision: AgentDecision,
  request: InteractionRequest,
  now: Date = new Date(),
  options: PolicyGateOptions = {},
): AgentDecision {
  let normalized = normalizeLowConfidenceEmotion(decision);
  if (
    request.multimodal_context?.has_conflict === true ||
    hasExplicitEmotionCorrection(request.transcript)
  ) {
    normalized = {
      ...normalized,
      emotion: {
        ...normalized.emotion,
        state: "unknown",
        confidence: Math.min(normalized.emotion.confidence, 0.6),
      },
    };
  }

  const evidenceReferences = getValidEvidenceReferences(normalized, request, now);
  const memoryCandidate = sanitizeMemoryCandidate(normalized.memory_candidate);
  const baseDecision: AgentDecision = {
    ...normalized,
    requires_user_confirmation:
      normalized.requires_user_confirmation || Boolean(memoryCandidate),
  };
  if (memoryCandidate) {
    baseDecision.memory_candidate = memoryCandidate;
    baseDecision.confirmation_scope = "memory";
  } else {
    delete baseDecision.memory_candidate;
  }
  if (!baseDecision.requires_user_confirmation) {
    delete baseDecision.confirmation_scope;
  }
  if (evidenceReferences.ids) {
    baseDecision.used_evidence_ids = evidenceReferences.ids;
  }

  if (!normalized.skill_request) {
    return baseDecision;
  }

  if (
    normalized.skill_request.skill !== "stop" &&
    normalized.skill_request.skill !== "release_hug" &&
    !evidenceReferences.allValid
  ) {
    delete baseDecision.skill_request;
    return baseDecision;
  }

  const requestConsent = getRequestConsent(request);
  const result = evaluateSkillRequest({
    skill: normalized.skill_request.skill,
    context: getRequestContext(request),
    ...(requestConsent ? { consent: requestConsent } : {}),
    hasConflict: request.multimodal_context?.has_conflict ?? false,
    reason: "agent_decision",
    now,
    allowUnsensoredMotion: options.allowUnsensoredMotion === true,
  });

  if (!result.allowed || !result.command) {
    if (
      result.reason === "approach_consent_required" ||
      result.reason === "hug_consent_required"
    ) {
      baseDecision.requires_user_confirmation = true;
      baseDecision.confirmation_scope = normalized.skill_request.skill as
        | "approach_short"
        | "invite_hug";
    }
    delete baseDecision.skill_request;
    return baseDecision;
  }

  return {
    ...baseDecision,
    skill_request: result.command,
  };
}
