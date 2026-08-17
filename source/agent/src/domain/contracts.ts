import { z } from "zod";

export const EMOTION_STATES = [
  "positive_high",
  "positive_low",
  "negative_high",
  "negative_low",
  "unknown",
] as const;

export const EMOTION_EVIDENCE = [
  "self_report",
  "semantics",
  "prosody",
  "vision",
  "visual_scene",
  "gesture",
  "pose",
  "interaction_history",
] as const;

export const SAFE_SKILLS = [
  "stop",
  "approach_short",
  "turn_to_user",
  "invite_hug",
  "release_hug",
] as const;

export const EXPRESSIONS = [
  "idle",
  "noticed",
  "listening",
  "thinking",
  "happy",
  "confused",
  "sad",
  "sleeping",
  "angry",
] as const;

export const MEMORY_KINDS = [
  "preference",
  "boundary",
  "shared_event",
  "profile",
] as const;

export const MEMORY_SOURCES = [
  "explicit_user",
  "confirmed_interaction",
] as const;

export const INPUT_MODALITIES = [
  "speech_text",
  "speech_prosody",
  "vision",
  "gesture",
  "proximity",
  "distance",
  "pose",
] as const;

export const EVIDENCE_SOURCES = [
  "t5_microphone",
  "t5_camera",
  "t5_button",
  "esp32_cam",
  "web_text",
  "apds9960",
  "hc_sr04",
  "bno055",
  "grove_imu",
] as const;

export const TASK_MODES = ["companion", "deep_research"] as const;

export const OUTPUT_MODALITIES = ["speech", "sound", "display", "motion"] as const;

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const USER_DIRECTIONS = ["left", "center", "right", "unknown"] as const;

export const emotionStateSchema = z.enum(EMOTION_STATES);
export const emotionEvidenceSchema = z.enum(EMOTION_EVIDENCE);
export const safeSkillSchema = z.enum(SAFE_SKILLS);
export const expressionSchema = z.enum(EXPRESSIONS);
export const deviceSafetyStateSchema = z.enum(["ready", "stopped", "fault"]);
export const memoryKindSchema = z.enum(MEMORY_KINDS);
export const memorySourceSchema = z.enum(MEMORY_SOURCES);
export const inputModalitySchema = z.enum(INPUT_MODALITIES);
export const evidenceSourceSchema = z.enum(EVIDENCE_SOURCES);
export const taskModeSchema = z.enum(TASK_MODES);
export const outputModalitySchema = z.enum(OUTPUT_MODALITIES);
export const imageMimeTypeSchema = z.enum(IMAGE_MIME_TYPES);
export const userDirectionSchema = z.enum(USER_DIRECTIONS);
export const isoTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .describe("ISO 8601 timestamp with a timezone offset");

const boundedRatioSchema = z.number().min(0).max(1);

export const emotionHypothesisSchema = z
  .object({
    state: emotionStateSchema,
    valence: z.number().min(-1).max(1),
    arousal: boundedRatioSchema,
    engagement: boundedRatioSchema,
    confidence: boundedRatioSchema,
    evidence: z.array(emotionEvidenceSchema).max(EMOTION_EVIDENCE.length),
    // Optional on ingestion for v0.3 clients; every v0.4 emitter should fill it.
    observed_signals: z
      .array(z.string().trim().min(1).max(240))
      .max(32)
      .optional(),
    alternative_states: z.array(emotionStateSchema).max(EMOTION_STATES.length).optional(),
    // Optional on ingestion for v0.3 clients; missing means "not confirmed".
    user_confirmed: z.boolean().optional(),
    expires_at: isoTimestampSchema,
  })
  .strict();

export const robotExpressionIntentSchema = z
  .object({
    expression: expressionSchema,
    intensity: boundedRatioSchema,
    duration_ms: z.number().int().min(0).max(300_000),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export const deviceContextSchema = z
  .object({
    device_id: z.string().trim().min(1).max(128),
    user_id: z.string().trim().min(1).max(128).optional(),
    observed_at: isoTimestampSchema,
    presence: z.enum(["present", "absent", "unknown"]),
    distance_cm: z.number().finite().nonnegative().max(1_000).optional(),
    distance_source: z.literal("hc_sr04").optional(),
    distance_observed_at: isoTimestampSchema.optional(),
    distance_valid: z.boolean().optional(),
    gesture: z.enum(["confirm", "reject", "stop", "unknown"]).optional(),
    pose: z.enum(["upright", "held", "tilted", "fallen", "unknown"]),
    battery: z.enum(["normal", "low", "unknown"]),
    safety_state: deviceSafetyStateSchema,
    active_skill: safeSkillSchema.optional(),
  })
  .strict();

export const modalityEvidenceSchema = z
  .object({
    evidence_id: z.string().trim().min(1).max(128),
    modality: inputModalitySchema,
    source: evidenceSourceSchema,
    observed_at: isoTimestampSchema,
    expires_at: isoTimestampSchema,
    confidence: boundedRatioSchema,
    summary: z.string().trim().min(1).max(500),
    media_ref: z.string().trim().min(1).max(2_048).optional(),
  })
  .strict();

const imageObservationBaseSchema = z.object({
  capture_id: z.string().trim().min(1).max(128),
  observed_at: isoTimestampSchema,
  mime: imageMimeTypeSchema,
  source: z.enum(["t5_camera", "esp32_cam"]),
});

/**
 * Triggered still image only. `url`/`base64` are ephemeral transport fields:
 * never persist or log either value.
 */
export const imageObservationSchema = z.union([
  imageObservationBaseSchema
    .extend({
      url: z.string().url().max(2_048),
    })
    .strict(),
  imageObservationBaseSchema
    .extend({
      base64: z
        .string()
        .min(1)
        .max(12_000_000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
]);

export const vlmObservationSchema = z
  .object({
    observation_id: z.string().trim().min(1).max(128),
    capture_id: z.string().trim().min(1).max(128),
    observed_at: isoTimestampSchema,
    description: z.string().trim().min(1).max(1_000),
    tags: z.array(z.string().trim().min(1).max(80)).max(32),
    scene_cues: z.array(z.string().trim().min(1).max(200)).max(16),
    confidence: boundedRatioSchema,
    evidence: z.array(z.string().trim().min(1).max(128)).max(32),
    ttl_ms: z.number().int().min(1_000).max(300_000),
    model: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

/**
 * Ephemeral VLM observation for a forward-facing ESP32-CAM frame. The host
 * binds it to authenticated evidence before any motion command is authored.
 */
export const visualGuidanceSchema = z
  .object({
    capture_id: z.string().trim().min(1).max(128),
    person_visible: z.boolean(),
    direction: userDirectionSchema,
    confidence: boundedRatioSchema,
  })
  .strict();

export const verifiedVisionGuidanceSchema = z
  .object({
    source: z.literal("esp32_cam"),
    capture_id: z.string().trim().min(1).max(128),
    evidence_id: z.string().trim().min(1).max(128),
    observed_at: isoTimestampSchema,
    direction: z.enum(["left", "center", "right"]),
    confidence_milli: z.number().int().min(800).max(1_000),
  })
  .strict();

export const multimodalContextSchema = z
  .object({
    context_id: z.string().trim().min(1).max(128),
    window_started_at: isoTimestampSchema,
    window_ended_at: isoTimestampSchema,
    evidence: z.array(modalityEvidenceSchema).max(64),
    unavailable_modalities: z
      .array(inputModalitySchema)
      .max(INPUT_MODALITIES.length),
    has_conflict: z.boolean(),
    transcript: z.string().trim().max(8_000).optional(),
    image_observations: z.array(imageObservationSchema).max(4).optional(),
    vlm_observations: z.array(vlmObservationSchema).max(4).optional(),
    local_sensor_context: deviceContextSchema.optional(),
  })
  .strict();

export const memoryCandidateSchema = z
  .object({
    kind: memoryKindSchema,
    summary: z.string().trim().min(1).max(500),
    source: memorySourceSchema,
    requires_confirmation: z.literal(true),
  })
  .strict();

export const safeSkillRequestSchema = z
  .object({
    request_id: z.string().trim().min(1).max(128),
    // Optional only for v0.3 command compatibility. New requests must bind a device.
    device_id: z.string().trim().min(1).max(128).optional(),
    skill: safeSkillSchema,
    consent_token: z.string().trim().min(1).max(512).optional(),
    expires_at: isoTimestampSchema,
    expected_device_state: deviceSafetyStateSchema.optional(),
    // Optional only for v0.3 command compatibility. Never put raw model chain-of-thought here.
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const agentToolActionSchema = z
  .object({
    tool_name: z.string().trim().min(1).max(256),
    request_id: z.string().trim().min(1).max(128).optional(),
    status: z.enum([
      "accepted",
      "rejected",
      "completed",
      "stopped",
      "failed",
    ]),
    used_evidence_ids: z
      .array(z.string().trim().min(1).max(128))
      .max(64)
      .optional(),
  })
  .strict();

export const consentGrantSchema = z
  .object({
    approach: z.boolean().default(false),
    hug: z.boolean().default(false),
    token: z.string().trim().min(1).max(512).optional(),
    scopes: z
      .array(z.enum(["approach_short", "invite_hug"]))
      .min(1)
      .max(2)
      .optional(),
    granted_at: isoTimestampSchema.optional(),
    expires_at: isoTimestampSchema.optional(),
  })
  .strict();

export const agentDecisionSchema = z
  .object({
    reply_text: z.string().trim().min(1).max(500),
    expression: expressionSchema,
    robot_expression: robotExpressionIntentSchema.optional(),
    emotion: emotionHypothesisSchema,
    skill_request: safeSkillRequestSchema.optional(),
    memory_candidate: memoryCandidateSchema.optional(),
    actions_taken: z.array(agentToolActionSchema).max(64).optional(),
    requires_user_confirmation: z.boolean(),
    confirmation_scope: z
      .enum(["approach_short", "invite_hug", "memory"])
      .optional(),
    used_evidence_ids: z
      .array(z.string().trim().min(1).max(128))
      .max(64)
      .optional(),
    output_modalities: z
      .array(outputModalitySchema)
      .max(OUTPUT_MODALITIES.length)
      .optional(),
    visual_guidance: visualGuidanceSchema.optional(),
  })
  .strict();

/**
 * New v0.4 Agent emissions are stricter than the backwards-compatible API
 * reader above: observable signals and confirmation state must be explicit,
 * and any model-proposed skill must carry the complete public command shape.
 * The Policy Gate still replaces all command metadata before execution.
 */
export const emittedEmotionHypothesisSchema = emotionHypothesisSchema.required({
  observed_signals: true,
  user_confirmed: true,
});

export const emittedSafeSkillRequestSchema = safeSkillRequestSchema.required({
  device_id: true,
  reason: true,
});

export const agentDecisionOutputSchema = agentDecisionSchema.extend({
  emotion: emittedEmotionHypothesisSchema,
  skill_request: emittedSafeSkillRequestSchema.optional(),
});

export const interactionRequestSchema = z
  .object({
    request_id: z.string().trim().min(1).max(128).optional(),
    transcript: z.string().trim().min(1).max(8_000),
    device_context: deviceContextSchema,
    session_id: z.string().trim().min(1).max(512).optional(),
    consent: consentGrantSchema.optional(),
    multimodal_context: multimodalContextSchema.optional(),
    locale: z.string().trim().min(2).max(35).optional(),
    task_mode: taskModeSchema.optional(),
    artifact_refs: z
      .array(
        z
          .object({
            kind: z.literal("pet_photo"),
            ref: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9:_-]+$/u),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();

export const interactionResponseSchema = z
  .object({
    decision: agentDecisionSchema,
    session_id: z.string().trim().min(1).max(512).optional(),
    mode: z.enum(["claude", "fallback"]),
  })
  .strict();

export const memorySettingRequestSchema = z
  .object({
    user_id: z.string().trim().min(1).max(128),
    enabled: z.boolean(),
  })
  .strict();

export const memoryUpdateSchema = z
  .object({
    summary: z.string().trim().min(1).max(500).optional(),
    confirmed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (update) => update.summary !== undefined || update.confirmed !== undefined,
    { message: "At least one memory field must be updated" },
  );

export const userFeedbackTypeSchema = z.enum([
  "accept",
  "reject",
  "correction",
  "stop",
]);

export const userFeedbackSchema = z
  .object({
    user_id: z.string().trim().min(1).max(128),
    device_id: z.string().trim().min(1).max(128),
    feedback: userFeedbackTypeSchema,
    consent_scope: z
      .enum(["approach_short", "invite_hug"])
      .optional(),
    request_id: z.string().trim().min(1).max(128).optional(),
    detail: z.string().trim().min(1).max(500).optional(),
    occurred_at: isoTimestampSchema,
  })
  .strict();

export const deviceEventSchema = z
  .object({
    device_id: z.string().trim().min(1).max(128),
    user_id: z.string().trim().min(1).max(128).optional(),
    event: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9_]*$/),
    source: evidenceSourceSchema.optional(),
    request_id: z.string().trim().min(1).max(128).optional(),
    occurred_at: isoTimestampSchema,
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type EmotionState = z.infer<typeof emotionStateSchema>;
export type EmotionEvidence = z.infer<typeof emotionEvidenceSchema>;
export type EmotionHypothesis = z.infer<typeof emotionHypothesisSchema>;
export type RobotExpressionIntent = z.infer<typeof robotExpressionIntentSchema>;
export type SafeSkill = z.infer<typeof safeSkillSchema>;
export type SkillName = SafeSkill;
export type Expression = z.infer<typeof expressionSchema>;
export type DeviceContext = z.infer<typeof deviceContextSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemorySource = z.infer<typeof memorySourceSchema>;
export type InputModality = z.infer<typeof inputModalitySchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type TaskMode = z.infer<typeof taskModeSchema>;
export type OutputModality = z.infer<typeof outputModalitySchema>;
export type ImageMimeType = z.infer<typeof imageMimeTypeSchema>;
export type UserDirection = z.infer<typeof userDirectionSchema>;
export type ModalityEvidence = z.infer<typeof modalityEvidenceSchema>;
export type ImageObservation = z.infer<typeof imageObservationSchema>;
export type VlmObservation = z.infer<typeof vlmObservationSchema>;
export type VisualGuidance = z.infer<typeof visualGuidanceSchema>;
export type VerifiedVisionGuidance = z.infer<
  typeof verifiedVisionGuidanceSchema
>;
export type MultimodalContext = z.infer<typeof multimodalContextSchema>;
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type SafeSkillRequest = z.infer<typeof safeSkillRequestSchema>;
export type SafeSkillCommand = SafeSkillRequest;
export type AgentToolAction = z.infer<typeof agentToolActionSchema>;
export type ConsentGrant = z.infer<typeof consentGrantSchema>;
export type AgentDecision = z.infer<typeof agentDecisionSchema>;
export type InteractionRequest = z.infer<typeof interactionRequestSchema>;
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;
export type MemorySettingRequest = z.infer<typeof memorySettingRequestSchema>;
export type MemoryUpdate = z.infer<typeof memoryUpdateSchema>;
export type UserFeedback = z.infer<typeof userFeedbackSchema>;
export type DeviceEvent = z.infer<typeof deviceEventSchema>;
