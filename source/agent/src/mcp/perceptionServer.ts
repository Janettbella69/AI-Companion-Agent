import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  EvidenceSource,
  ImageObservation,
  ModalityEvidence,
} from "../domain/contracts.js";
import { EventContextGateway } from "../gateway/EventContextGateway.js";

const observationalFactSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(
    (fact) =>
      !/(?:consent(?:_token)?|用户(?:已)?同意|允许机器人|should\s+(?:approach|hug)|执行(?:靠近|拥抱))/iu.test(
        fact,
      ),
    "Perception facts cannot assert consent or prescribe an action",
  );

const completedObservationSchema = z
  .object({
    status: z.literal("completed"),
    reason_code: z.string().trim().min(1).max(80),
    observed_at: z.string().datetime({ offset: true }),
    facts: z.array(observationalFactSchema).min(1).max(16),
    confidence: z.number().min(0).max(1),
    evidence_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(16),
    source: z.enum([
      "t5_microphone",
      "t5_camera",
      "t5_button",
      "esp32_cam",
      "web_text",
      "apds9960",
      "hc_sr04",
      "bno055",
      "grove_imu",
    ]),
    transcript: z.string().trim().min(1).max(8_000).optional(),
  })
  .strict();

const incompleteObservationSchema = z
  .object({
    status: z.enum(["unavailable", "failed"]),
    reason_code: z.string().trim().min(1).max(80),
    observed_at: z.string().datetime({ offset: true }),
    facts: z.array(observationalFactSchema).max(16).default([]),
    confidence: z.number().min(0).max(1).default(0),
    evidence_ids: z
      .array(z.string().trim().min(1).max(128))
      .max(16)
      .default([]),
  })
  .strict();

export const perceptionObservationSchema = z.discriminatedUnion("status", [
  completedObservationSchema,
  incompleteObservationSchema,
]);

export type PerceptionObservation = z.infer<
  typeof perceptionObservationSchema
>;

export interface KeyframeAnalysisInput {
  deviceId: string;
  captureId: string;
  keyframe: ImageObservation;
  evidence: ModalityEvidence;
  now: Date;
}

export interface SensorPerceptionInput {
  deviceId: string;
  evidence: ModalityEvidence[];
  now: Date;
}

export interface AudioTranscriptionInput extends SensorPerceptionInput {
  audioRef: string;
  language?: string;
}

/**
 * Adapter boundary for a VLM/ASR/sensor classifier. It returns observations;
 * it is not an Agent and has no device, memory, consent, or action capability.
 */
export interface PerceptionAdapter {
  analyzeKeyframe(input: KeyframeAnalysisInput): Promise<unknown>;
  detectPose(input: SensorPerceptionInput): Promise<unknown>;
  detectGesture(input: SensorPerceptionInput): Promise<unknown>;
  transcribeAudio(input: AudioTranscriptionInput): Promise<unknown>;
}

export interface SafeMockPerceptionOptions {
  transcripts?: Readonly<Record<string, string>>;
}

function unavailable(reasonCode: string, now: Date): PerceptionObservation {
  return {
    status: "unavailable",
    reason_code: reasonCode,
    observed_at: now.toISOString(),
    facts: [],
    confidence: 0,
    evidence_ids: [],
  };
}

/** Safe deterministic simulator; it never pretends to run a VLM or ASR. */
export class SafeMockPerceptionAdapter implements PerceptionAdapter {
  private readonly transcripts: Readonly<Record<string, string>>;

  constructor(options: SafeMockPerceptionOptions = {}) {
    this.transcripts = options.transcripts ?? {};
  }

  async analyzeKeyframe(
    input: KeyframeAnalysisInput,
  ): Promise<PerceptionObservation> {
    return {
      status: "completed",
      reason_code: "metadata_only_no_vlm",
      observed_at: input.keyframe.observed_at,
      facts: [
        "A fresh event-triggered still keyframe is available.",
        `The capture source is ${input.keyframe.source}.`,
        `The declared media type is ${input.keyframe.mime}.`,
      ],
      confidence: 1,
      evidence_ids: [input.evidence.evidence_id],
      source: input.keyframe.source,
    };
  }

  async detectPose(input: SensorPerceptionInput): Promise<PerceptionObservation> {
    const evidence = input.evidence.find((item) => item.modality === "pose");
    if (!evidence) return unavailable("pose_evidence_not_found", input.now);
    return {
      status: "completed",
      reason_code: "structured_sensor_observation",
      observed_at: evidence.observed_at,
      facts: [evidence.summary],
      confidence: evidence.confidence,
      evidence_ids: [evidence.evidence_id],
      source: evidence.source,
    };
  }

  async detectGesture(
    input: SensorPerceptionInput,
  ): Promise<PerceptionObservation> {
    const evidence = input.evidence.find((item) => item.modality === "gesture");
    if (!evidence) return unavailable("gesture_evidence_not_found", input.now);
    return {
      status: "completed",
      reason_code: "structured_sensor_observation",
      observed_at: evidence.observed_at,
      facts: [evidence.summary],
      confidence: evidence.confidence,
      evidence_ids: [evidence.evidence_id],
      source: evidence.source,
    };
  }

  async transcribeAudio(
    input: AudioTranscriptionInput,
  ): Promise<PerceptionObservation> {
    const transcript = this.transcripts[input.audioRef]?.trim();
    const evidence = input.evidence.find(
      (item) =>
        item.source === "t5_microphone" && item.media_ref === input.audioRef,
    );
    if (!transcript || !evidence) {
      return unavailable("asr_adapter_not_configured", input.now);
    }
    return {
      status: "completed",
      reason_code: "controlled_asr_fixture",
      observed_at: evidence.observed_at,
      facts: ["A controlled audio fixture was transcribed."],
      confidence: evidence.confidence,
      evidence_ids: [evidence.evidence_id],
      source: "t5_microphone",
      transcript,
    };
  }
}

export interface HshhPerceptionMcpOptions {
  gateway: EventContextGateway;
  deviceId: string;
  adapter?: PerceptionAdapter;
  now?: () => Date;
}

function textResult(observation: PerceptionObservation) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(observation) }],
    structuredContent: observation,
  };
}

function scopeError(now: Date): PerceptionObservation {
  return {
    status: "failed",
    reason_code: "device_scope_mismatch",
    observed_at: now.toISOString(),
    facts: [],
    confidence: 0,
    evidence_ids: [],
  };
}

async function safelyRunAdapter(
  operation: () => Promise<unknown>,
  allowedEvidenceIds: ReadonlySet<string>,
  now: Date,
): Promise<PerceptionObservation> {
  try {
    const parsed = perceptionObservationSchema.safeParse(await operation());
    if (!parsed.success) {
      return {
        status: "failed",
        reason_code: "invalid_adapter_result",
        observed_at: now.toISOString(),
        facts: [],
        confidence: 0,
        evidence_ids: [],
      };
    }
    if (
      parsed.data.status === "completed" &&
      parsed.data.evidence_ids.some((id) => !allowedEvidenceIds.has(id))
    ) {
      return {
        status: "failed",
        reason_code: "unknown_evidence_reference",
        observed_at: now.toISOString(),
        facts: [],
        confidence: 0,
        evidence_ids: [],
      };
    }
    return parsed.data;
  } catch {
    return {
      status: "failed",
      reason_code: "adapter_error",
      observed_at: now.toISOString(),
      facts: [],
      confidence: 0,
      evidence_ids: [],
    };
  }
}

function evidenceById(
  evidence: readonly ModalityEvidence[],
  evidenceId: string,
): ModalityEvidence | undefined {
  return evidence.find((item) => item.evidence_id === evidenceId);
}

function evidenceIds(evidence: readonly ModalityEvidence[]): Set<string> {
  return new Set(evidence.map((item) => item.evidence_id));
}

/** Perception capability only: observes; never grants consent or chooses actions. */
export function createHshhPerceptionMcpServer(
  options: HshhPerceptionMcpOptions,
): McpSdkServerConfigWithInstance {
  const now = options.now ?? (() => new Date());
  const adapter = options.adapter ?? new SafeMockPerceptionAdapter();

  const analyzeKeyframe = tool(
    "analyze_keyframe",
    "Analyze one fresh triggered still via the configured VLM adapter. Return observable facts and evidence only; never emotion certainty, consent, memory, or an action decision.",
    {
      device_id: z.string().trim().min(1).max(128),
      capture_id: z.string().trim().min(1).max(128),
    },
    async ({ device_id, capture_id }) => {
      const currentNow = now();
      if (device_id !== options.deviceId) return textResult(scopeError(currentNow));
      const keyframe = options.gateway.getKeyframe(
        device_id,
        capture_id,
        currentNow,
      );
      if (!keyframe) {
        return textResult(unavailable("keyframe_not_found_or_expired", currentNow));
      }
      const current = options.gateway.getCurrentContext(device_id, {
        now: currentNow,
      }).context;
      const evidence = evidenceById(current.evidence, keyframe.evidence_id);
      if (!evidence) {
        return textResult(unavailable("visual_evidence_expired", currentNow));
      }
      return textResult(
        await safelyRunAdapter(
          () =>
            adapter.analyzeKeyframe({
              deviceId: device_id,
              captureId: capture_id,
              keyframe: keyframe.image,
              evidence,
              now: currentNow,
            }),
          new Set([evidence.evidence_id]),
          currentNow,
        ),
      );
    },
    {
      annotations: {
        title: "Analyze triggered keyframe",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const detectPose = tool(
    "detect_pose",
    "Read fresh pose evidence or invoke the configured pose adapter. This reports observed pose only and never chooses a robot skill.",
    { device_id: z.string().trim().min(1).max(128) },
    async ({ device_id }) => {
      const currentNow = now();
      if (device_id !== options.deviceId) return textResult(scopeError(currentNow));
      const evidence = options.gateway.getCurrentContext(device_id, {
        now: currentNow,
      }).context.evidence;
      return textResult(
        await safelyRunAdapter(
          () => adapter.detectPose({ deviceId: device_id, evidence, now: currentNow }),
          evidenceIds(evidence),
          currentNow,
        ),
      );
    },
    {
      annotations: {
        title: "Detect current pose",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const detectGesture = tool(
    "detect_gesture",
    "Read fresh APDS9960 gesture evidence or invoke the configured gesture adapter. A confirm gesture is still only an observation; the gateway separately controls scoped consent tokens.",
    { device_id: z.string().trim().min(1).max(128) },
    async ({ device_id }) => {
      const currentNow = now();
      if (device_id !== options.deviceId) return textResult(scopeError(currentNow));
      const evidence = options.gateway.getCurrentContext(device_id, {
        now: currentNow,
      }).context.evidence;
      return textResult(
        await safelyRunAdapter(
          () =>
            adapter.detectGesture({ deviceId: device_id, evidence, now: currentNow }),
          evidenceIds(evidence),
          currentNow,
        ),
      );
    },
    {
      annotations: {
        title: "Detect current gesture",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const transcribeAudio = tool(
    "transcribe_audio",
    "Transcribe a short server-controlled audio_ref using the configured ASR adapter. Raw audio, consent decisions, emotion labels, and action decisions are outside this tool.",
    {
      device_id: z.string().trim().min(1).max(128),
      audio_ref: z
        .string()
        .trim()
        .min(1)
        .max(128)
        .regex(/^[A-Za-z0-9:_-]+$/u),
      language: z.string().trim().min(2).max(35).optional(),
    },
    async ({ device_id, audio_ref, language }) => {
      const currentNow = now();
      if (device_id !== options.deviceId) return textResult(scopeError(currentNow));
      const evidence = options.gateway.getCurrentContext(device_id, {
        now: currentNow,
      }).context.evidence.filter(
        (item) =>
          item.source === "t5_microphone" && item.media_ref === audio_ref,
      );
      if (evidence.length === 0) {
        return textResult(unavailable("audio_ref_not_found_or_expired", currentNow));
      }
      return textResult(
        await safelyRunAdapter(
          () =>
            adapter.transcribeAudio({
              deviceId: device_id,
              audioRef: audio_ref,
              ...(language === undefined ? {} : { language }),
              evidence,
              now: currentNow,
            }),
          evidenceIds(evidence),
          currentNow,
        ),
      );
    },
    {
      annotations: {
        title: "Transcribe short audio reference",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  return createSdkMcpServer({
    name: "hshh_perception",
    version: "0.1.0",
    instructions:
      "Perception is a narrow observation capability, not an Agent. It cannot grant consent, choose a SafeSkill, write memory, or control hardware.",
    tools: [analyzeKeyframe, detectPose, detectGesture, transcribeAudio],
  });
}

export const HSHH_PERCEPTION_TOOL_NAMES = [
  "mcp__hshh_perception__analyze_keyframe",
  "mcp__hshh_perception__detect_pose",
  "mcp__hshh_perception__detect_gesture",
  "mcp__hshh_perception__transcribe_audio",
] as const;

export type PerceptionEvidenceSource = EvidenceSource;
