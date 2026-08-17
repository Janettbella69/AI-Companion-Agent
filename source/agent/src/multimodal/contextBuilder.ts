import {
  INPUT_MODALITIES,
  multimodalContextSchema,
  type ImageObservation,
  type InputModality,
  type InteractionRequest,
  type ModalityEvidence,
  type MultimodalContext,
  type VlmObservation,
} from "../domain/contracts.js";
import {
  buildMultimodalPromptContent,
  ImageInputError,
  type PromptContentBlock,
  validateTriggeredImage,
} from "./imagePrompt.js";

export const MIN_CONTEXT_WINDOW_MS = 5_000;
export const MAX_CONTEXT_WINDOW_MS = 15_000;

export type MultimodalContextErrorCode =
  | "invalid_context"
  | "invalid_window"
  | "duplicate_evidence_id"
  | "duplicate_capture_id"
  | "duplicate_vlm_observation_id";

export class MultimodalContextError extends Error {
  readonly code: MultimodalContextErrorCode;

  constructor(code: MultimodalContextErrorCode) {
    super(`Multimodal context rejected: ${code}`);
    this.name = "MultimodalContextError";
    this.code = code;
  }
}

export interface ContextBuilderOptions {
  now?: Date;
  minWindowMs?: number;
  maxWindowMs?: number;
  futureClockSkewMs?: number;
  imageEvidenceToleranceMs?: number;
  maxImageBytes?: number;
}

export interface ContextBuildReport {
  context: MultimodalContext;
  /** Identifier-only diagnostics: safe to log. */
  dropped_evidence_ids: string[];
  dropped_image_capture_ids: string[];
  dropped_vlm_observation_ids: string[];
}

export interface MultimodalPrompt {
  text: string;
  content: PromptContentBlock[];
  acceptedEvidenceIds: string[];
  rejectedEvidenceIds: string[];
  hasImages: boolean;
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function assertUnique(values: readonly string[], code: MultimodalContextErrorCode): void {
  if (new Set(values).size !== values.length) {
    throw new MultimodalContextError(code);
  }
}

function insideCurrentWindow(
  observedAt: string,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
  futureClockSkewMs: number,
): boolean {
  const observedMs = timestamp(observedAt);
  return (
    observedMs >= windowStartMs &&
    observedMs <= windowEndMs &&
    observedMs <= nowMs + futureClockSkewMs
  );
}

function isFreshEvidence(
  evidence: ModalityEvidence,
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
  futureClockSkewMs: number,
): boolean {
  const observedMs = timestamp(evidence.observed_at);
  const expiresMs = timestamp(evidence.expires_at);
  return (
    insideCurrentWindow(
      evidence.observed_at,
      windowStartMs,
      windowEndMs,
      nowMs,
      futureClockSkewMs,
    ) &&
    expiresMs > nowMs &&
    expiresMs > observedMs
  );
}

function visualEvidenceForCapture(
  image: ImageObservation,
  evidence: readonly ModalityEvidence[],
  toleranceMs: number,
): ModalityEvidence | undefined {
  const imageObservedMs = timestamp(image.observed_at);
  return evidence.find(
    (item) =>
      item.modality === "vision" &&
      item.source === image.source &&
      item.media_ref === image.capture_id &&
      Math.abs(timestamp(item.observed_at) - imageObservedMs) <= toleranceMs,
  );
}

function freshVlmObservation(
  observation: VlmObservation,
  evidence: readonly ModalityEvidence[],
  windowStartMs: number,
  windowEndMs: number,
  nowMs: number,
  futureClockSkewMs: number,
): boolean {
  const observedMs = timestamp(observation.observed_at);
  if (
    !insideCurrentWindow(
      observation.observed_at,
      windowStartMs,
      windowEndMs,
      nowMs,
      futureClockSkewMs,
    ) ||
    observedMs + observation.ttl_ms <= nowMs
  ) {
    return false;
  }

  const freshEvidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const hasFreshReferencedEvidence =
    observation.evidence.length > 0 &&
    observation.evidence.every((evidenceId) => freshEvidenceIds.has(evidenceId));
  const hasFreshCaptureEvidence = evidence.some(
    (item) =>
      item.modality === "vision" && item.media_ref === observation.capture_id,
  );

  return hasFreshReferencedEvidence && hasFreshCaptureEvidence;
}

function withUnavailableVision(
  modalities: readonly InputModality[],
): InputModality[] {
  return modalities.includes("vision") ? [...modalities] : [...modalities, "vision"];
}

function parseContext(input: unknown): MultimodalContext {
  const parsed = multimodalContextSchema.safeParse(input);
  if (!parsed.success) {
    // Never attach Zod's input/error tree: it may retain a raw base64 payload.
    throw new MultimodalContextError("invalid_context");
  }
  return parsed.data;
}

/**
 * Builds the current 5–15 second decision context. Expired evidence is removed
 * before the Agent sees it. An image is accepted only when a fresh `vision`
 * evidence record points to its capture_id through `media_ref`.
 *
 * Presence in `image_observations` means an event-triggered still capture. This
 * function intentionally has no continuous video/stream input.
 */
export function buildMultimodalContextWithReport(
  input: unknown,
  options: ContextBuilderOptions = {},
): ContextBuildReport {
  const parsed = parseContext(input);
  const nowMs = (options.now ?? new Date()).getTime();
  const minWindowMs = options.minWindowMs ?? MIN_CONTEXT_WINDOW_MS;
  const maxWindowMs = options.maxWindowMs ?? MAX_CONTEXT_WINDOW_MS;
  const futureClockSkewMs = options.futureClockSkewMs ?? 1_000;
  const imageEvidenceToleranceMs = options.imageEvidenceToleranceMs ?? 1_500;
  const windowStartMs = timestamp(parsed.window_started_at);
  const windowEndMs = timestamp(parsed.window_ended_at);
  const durationMs = windowEndMs - windowStartMs;

  if (
    !Number.isSafeInteger(minWindowMs) ||
    !Number.isSafeInteger(maxWindowMs) ||
    minWindowMs < 0 ||
    maxWindowMs < minWindowMs ||
    durationMs < minWindowMs ||
    durationMs > maxWindowMs ||
    windowEndMs > nowMs + futureClockSkewMs
  ) {
    throw new MultimodalContextError("invalid_window");
  }

  assertUnique(
    parsed.evidence.map((item) => item.evidence_id),
    "duplicate_evidence_id",
  );
  assertUnique(
    (parsed.image_observations ?? []).map((item) => item.capture_id),
    "duplicate_capture_id",
  );
  assertUnique(
    (parsed.vlm_observations ?? []).map((item) => item.observation_id),
    "duplicate_vlm_observation_id",
  );

  const evidence = parsed.evidence.filter((item) =>
    isFreshEvidence(
      item,
      windowStartMs,
      windowEndMs,
      nowMs,
      futureClockSkewMs,
    ),
  );
  const freshEvidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const droppedEvidenceIds = parsed.evidence
    .filter((item) => !freshEvidenceIds.has(item.evidence_id))
    .map((item) => item.evidence_id);

  const acceptedImages: ImageObservation[] = [];
  const droppedImageCaptureIds: string[] = [];
  for (const image of parsed.image_observations ?? []) {
    const isInWindow = insideCurrentWindow(
      image.observed_at,
      windowStartMs,
      windowEndMs,
      nowMs,
      futureClockSkewMs,
    );
    const hasFreshExpiry = visualEvidenceForCapture(
      image,
      evidence,
      imageEvidenceToleranceMs,
    );
    if (!isInWindow || !hasFreshExpiry) {
      droppedImageCaptureIds.push(image.capture_id);
      continue;
    }

    // Invalid encodings/signatures are rejected, not silently downgraded.
    // The exception exposes only a stable code and never the payload.
    validateTriggeredImage(
      image,
      options.maxImageBytes === undefined
        ? {}
        : { maxImageBytes: options.maxImageBytes },
    );
    acceptedImages.push(image);
  }

  const acceptedVlmObservations = (parsed.vlm_observations ?? []).filter(
    (observation) =>
      freshVlmObservation(
        observation,
        evidence,
        windowStartMs,
        windowEndMs,
        nowMs,
        futureClockSkewMs,
      ),
  );
  const acceptedVlmIds = new Set(
    acceptedVlmObservations.map((item) => item.observation_id),
  );
  const droppedVlmObservationIds = (parsed.vlm_observations ?? [])
    .filter((item) => !acceptedVlmIds.has(item.observation_id))
    .map((item) => item.observation_id);

  const receivedVisualInput =
    parsed.evidence.some((item) => item.modality === "vision") ||
    (parsed.image_observations?.length ?? 0) > 0 ||
    (parsed.vlm_observations?.length ?? 0) > 0;
  const hasFreshVisualInput =
    evidence.some((item) => item.modality === "vision") &&
    (acceptedImages.length > 0 || acceptedVlmObservations.length > 0);
  const unavailableModalities =
    receivedVisualInput && !hasFreshVisualInput
      ? withUnavailableVision(parsed.unavailable_modalities)
      : [...parsed.unavailable_modalities];

  const context: MultimodalContext = {
    ...parsed,
    evidence,
    unavailable_modalities: unavailableModalities,
    ...(parsed.image_observations
      ? { image_observations: acceptedImages }
      : {}),
    ...(parsed.vlm_observations
      ? { vlm_observations: acceptedVlmObservations }
      : {}),
  };

  return {
    context,
    dropped_evidence_ids: droppedEvidenceIds,
    dropped_image_capture_ids: droppedImageCaptureIds,
    dropped_vlm_observation_ids: droppedVlmObservationIds,
  };
}

export function buildMultimodalContext(
  input: unknown,
  options: ContextBuilderOptions = {},
): MultimodalContext {
  return buildMultimodalContextWithReport(input, options).context;
}

/** Stable validation entry point used by the HTTP/Agent adapter. */
export function validateMultimodalContext(
  context: unknown,
  now: Date = new Date(),
): MultimodalContext {
  return buildMultimodalContext(context, { now });
}

/**
 * Turns one interaction into an ephemeral prompt payload. The returned `text`
 * contains no base64/data URL; image bytes live only in `content` image blocks.
 */
export function buildMultimodalPrompt(
  request: InteractionRequest,
  now: Date = new Date(),
): MultimodalPrompt {
  const rawContext: MultimodalContext = request.multimodal_context
    ? {
        ...request.multimodal_context,
        transcript: request.transcript,
        local_sensor_context: request.device_context,
      }
    : {
        context_id: `text-only:${request.device_context.device_id}`,
        window_started_at: new Date(
          now.getTime() - MIN_CONTEXT_WINDOW_MS,
        ).toISOString(),
        window_ended_at: now.toISOString(),
        evidence: [],
        unavailable_modalities: [...INPUT_MODALITIES],
        has_conflict: false,
        transcript: request.transcript,
        local_sensor_context: request.device_context,
      };
  const report = buildMultimodalContextWithReport(rawContext, { now });
  const content = buildMultimodalPromptContent(report.context, { now });
  const firstBlock = content[0];
  if (!firstBlock || firstBlock.type !== "text") {
    throw new MultimodalContextError("invalid_context");
  }

  return {
    text: firstBlock.text,
    content,
    acceptedEvidenceIds: report.context.evidence.map(
      (evidence) => evidence.evidence_id,
    ),
    rejectedEvidenceIds: report.dropped_evidence_ids,
    hasImages: content.some((block) => block.type === "image"),
  };
}

export { ImageInputError };
