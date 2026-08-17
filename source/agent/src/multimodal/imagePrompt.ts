import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ImageMimeType,
  ImageObservation,
  ModalityEvidence,
  MultimodalContext,
  VlmObservation,
} from "../domain/contracts.js";

export const DEFAULT_MAX_TRIGGERED_IMAGE_BYTES = 4 * 1024 * 1024;

const MAX_CONFIGURABLE_IMAGE_BYTES = 8 * 1024 * 1024;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/u;
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

export type ImageInputErrorCode =
  | "unsupported_mime"
  | "remote_url_not_allowed"
  | "invalid_data_url"
  | "invalid_base64"
  | "image_too_large"
  | "mime_mismatch"
  | "invalid_file_signature"
  | "expired_visual_evidence";

/**
 * Deliberately carries only a stable code. Raw image data and data URLs must
 * never appear in logs, error messages, or persistence records.
 */
export class ImageInputError extends Error {
  readonly code: ImageInputErrorCode;

  constructor(code: ImageInputErrorCode) {
    super(`Triggered image rejected: ${code}`);
    this.name = "ImageInputError";
    this.code = code;
  }
}

export interface PromptTextBlock {
  type: "text";
  text: string;
}

export interface PromptImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: ImageMimeType;
    data: string;
  };
}

export type PromptContentBlock = PromptTextBlock | PromptImageBlock;

export interface ValidatedTriggeredImage {
  captureId: string;
  observedAt: string;
  source: ImageObservation["source"];
  mime: ImageMimeType;
  byteLength: number;
  /** Ephemeral. Do not log or persist. */
  base64: string;
}

export interface ImagePromptOptions {
  now?: Date;
  maxImageBytes?: number;
  imageEvidenceToleranceMs?: number;
}

function configuredMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? DEFAULT_MAX_TRIGGERED_IMAGE_BYTES;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > MAX_CONFIGURABLE_IMAGE_BYTES
  ) {
    throw new RangeError(
      `maxImageBytes must be an integer between 1 and ${MAX_CONFIGURABLE_IMAGE_BYTES}`,
    );
  }
  return maxBytes;
}

function decodeCanonicalBase64(base64: string, maxBytes: number): Buffer {
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !BASE64_BODY.test(base64)
  ) {
    throw new ImageInputError("invalid_base64");
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const estimatedBytes = (base64.length / 4) * 3 - padding;
  if (estimatedBytes > maxBytes) {
    throw new ImageInputError("image_too_large");
  }

  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== estimatedBytes || bytes.toString("base64") !== base64) {
    throw new ImageInputError("invalid_base64");
  }
  return bytes;
}

function hasExpectedSignature(bytes: Buffer, mime: ImageMimeType): boolean {
  switch (mime) {
    case "image/jpeg":
      return (
        bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      );
    case "image/png":
      return (
        bytes.length >= 8 &&
        bytes.subarray(0, 8).equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        )
      );
    case "image/webp":
      return (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
        bytes.subarray(8, 12).toString("ascii") === "WEBP"
      );
  }
}

function ephemeralImagePayload(observation: ImageObservation): {
  mime: ImageMimeType;
  base64: string;
} {
  if (
    "base64" in observation &&
    typeof observation.base64 === "string"
  ) {
    return { mime: observation.mime, base64: observation.base64 };
  }

  if (!("url" in observation) || !observation.url.startsWith("data:")) {
    throw new ImageInputError("remote_url_not_allowed");
  }

  const match = DATA_URL.exec(observation.url);
  if (!match?.[1] || !match[2]) {
    throw new ImageInputError("invalid_data_url");
  }
  if (match[1] !== observation.mime) {
    throw new ImageInputError("mime_mismatch");
  }
  return { mime: observation.mime, base64: match[2] };
}

/**
 * Validates one event-triggered still image. HTTP(S) URLs are intentionally
 * rejected so this layer never becomes an SSRF-capable fetcher.
 */
export function validateTriggeredImage(
  observation: ImageObservation,
  options: Pick<ImagePromptOptions, "maxImageBytes"> = {},
): ValidatedTriggeredImage {
  if (
    observation.mime !== "image/jpeg" &&
    observation.mime !== "image/png" &&
    observation.mime !== "image/webp"
  ) {
    throw new ImageInputError("unsupported_mime");
  }
  const maxBytes = configuredMaxBytes(options.maxImageBytes);
  const payload = ephemeralImagePayload(observation);
  const bytes = decodeCanonicalBase64(payload.base64, maxBytes);

  if (!hasExpectedSignature(bytes, payload.mime)) {
    throw new ImageInputError("invalid_file_signature");
  }

  return {
    captureId: observation.capture_id,
    observedAt: observation.observed_at,
    source: observation.source,
    mime: payload.mime,
    byteLength: bytes.length,
    base64: payload.base64,
  };
}

function timestamp(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function currentEvidence(
  context: MultimodalContext,
  nowMs: number,
  futureClockSkewMs: number,
): ModalityEvidence[] {
  const windowStartMs = timestamp(context.window_started_at);
  const windowEndMs = timestamp(context.window_ended_at);
  if (windowStartMs === undefined || windowEndMs === undefined) {
    return [];
  }
  return context.evidence.filter((evidence) => {
    const observedAt = timestamp(evidence.observed_at);
    const expiresAt = timestamp(evidence.expires_at);
    return (
      observedAt !== undefined &&
      expiresAt !== undefined &&
      observedAt >= windowStartMs &&
      observedAt <= windowEndMs &&
      observedAt <= nowMs + futureClockSkewMs &&
      expiresAt > nowMs &&
      expiresAt > observedAt
    );
  });
}

function matchingFreshVisualEvidence(
  evidence: readonly ModalityEvidence[],
  image: ImageObservation,
  toleranceMs: number,
): ModalityEvidence | undefined {
  const imageObservedAt = timestamp(image.observed_at);
  if (imageObservedAt === undefined) {
    return undefined;
  }

  return evidence.find((item) => {
    const observedAt = timestamp(item.observed_at);
    return (
      item.modality === "vision" &&
      item.source === image.source &&
      item.media_ref === image.capture_id &&
      observedAt !== undefined &&
      Math.abs(observedAt - imageObservedAt) <= toleranceMs
    );
  });
}

function freshVlmObservation(
  observation: VlmObservation,
  evidence: readonly ModalityEvidence[],
  context: MultimodalContext,
  nowMs: number,
  futureClockSkewMs: number,
): boolean {
  const observedAt = timestamp(observation.observed_at);
  const windowStartMs = timestamp(context.window_started_at);
  const windowEndMs = timestamp(context.window_ended_at);
  if (
    observedAt === undefined ||
    windowStartMs === undefined ||
    windowEndMs === undefined ||
    observedAt < windowStartMs ||
    observedAt > windowEndMs ||
    observedAt > nowMs + futureClockSkewMs ||
    observedAt + observation.ttl_ms <= nowMs
  ) {
    return false;
  }
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  return (
    observation.evidence.length > 0 &&
    observation.evidence.every((evidenceId) => evidenceIds.has(evidenceId)) &&
    evidence.some(
      (item) =>
        item.modality === "vision" &&
        item.media_ref === observation.capture_id,
    )
  );
}

function promptSafeContext(
  context: MultimodalContext,
  evidence: readonly ModalityEvidence[],
  nowMs: number,
  futureClockSkewMs: number,
): object {
  return {
    context_id: context.context_id,
    window_started_at: context.window_started_at,
    window_ended_at: context.window_ended_at,
    transcript: context.transcript,
    evidence: evidence.map(({ media_ref: _ephemeralMediaRef, ...item }) =>
      item,
    ),
    unavailable_modalities: context.unavailable_modalities,
    has_conflict: context.has_conflict,
    image_observations: context.image_observations?.map((image) => ({
      capture_id: image.capture_id,
      observed_at: image.observed_at,
      mime: image.mime,
      source: image.source,
    })),
    vlm_observations: context.vlm_observations
      ?.filter((observation) =>
        freshVlmObservation(
          observation,
          evidence,
          context,
          nowMs,
          futureClockSkewMs,
        ),
      )
      .map(({ model: _model, ...observation }) => observation),
    local_sensor_context: context.local_sensor_context,
  };
}

/**
 * Produces Anthropic-compatible text + base64 image blocks. Raw image payloads
 * appear only in image blocks and are excluded from the serialized text block.
 */
export function buildMultimodalPromptContent(
  context: MultimodalContext,
  options: ImagePromptOptions = {},
): PromptContentBlock[] {
  const nowMs = (options.now ?? new Date()).getTime();
  const toleranceMs = options.imageEvidenceToleranceMs ?? 1_500;
  const evidence = currentEvidence(context, nowMs, toleranceMs);
  const images = (context.image_observations ?? []).map((observation) => {
    if (!matchingFreshVisualEvidence(evidence, observation, toleranceMs)) {
      throw new ImageInputError("expired_visual_evidence");
    }
    return validateTriggeredImage(observation, options);
  });

  const text: PromptTextBlock = {
    type: "text",
    text: [
      "这是一次短时、触发式多模态观察，不是连续监控。",
      "视觉图片与 VLM 描述都只是弱证据：只能辅助判断存在和场景，不得断言身份、情绪或内心状态。",
      "视觉、距离、历史偏好以及 VLM 线索都不能构成或替代 approach_short / invite_hug 的明确同意，也不得据此生成 consent_token。",
      "用户明确的停止、拒绝、自述和纠正优先。证据冲突或不足时保持静止，输出 unknown 或请求澄清。",
      `当前结构化上下文（已移除原始图片和短期媒体引用）：${JSON.stringify(promptSafeContext(context, evidence, nowMs, toleranceMs))}`,
    ].join("\n"),
  };

  return [
    text,
    ...images.map<PromptImageBlock>((image) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mime,
        data: image.base64,
      },
    })),
  ];
}

/** Exact SDKUserMessage shape accepted by query({ prompt: AsyncIterable }). */
export function buildMultimodalUserMessage(
  context: MultimodalContext,
  options: ImagePromptOptions = {},
): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: buildMultimodalPromptContent(context, options),
    },
    parent_tool_use_id: null,
  };
}

export async function* oneMessagePrompt(
  message: SDKUserMessage,
): AsyncGenerator<SDKUserMessage> {
  yield message;
}
