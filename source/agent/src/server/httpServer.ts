import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  HshhAgentScopeError,
  type HshhAgent,
} from "../agent/hshhAgent.js";
import type { AgentServiceConfig } from "../config.js";
import {
  cameraTriggerReasonSchema,
  type LanCameraAdapter,
  type LanCameraCaptureResult,
} from "../device/lanCameraAdapter.js";
import type { DeviceEffectQueue } from "../device/deviceEffectQueue.js";
import type { SpeechStore } from "../speech/speechStore.js";
import {
  MAX_UTTERANCE_BYTES,
  type UtterancePipeline,
} from "../speech/utterancePipeline.js";
import {
  deviceEventSchema,
  imageObservationSchema,
  memorySettingRequestSchema,
  memoryUpdateSchema,
  userFeedbackSchema,
  type AgentDecision,
  type VerifiedVisionGuidance,
} from "../domain/contracts.js";
import {
  EventContextGateway,
  EventContextGatewayError,
} from "../gateway/EventContextGateway.js";
import {
  AvatarMetadataPipeline,
  MAX_AVATAR_SOURCE_BYTES,
  validateDeviceAvatarManifest,
} from "../mcp/avatarServer.js";
import type { HshhDeviceDispatchResult } from "../mcp/deviceServer.js";
import { selectVisionGuidedStep } from "../policy/visionGuidedDemo.js";
import { HshhDatabase, type PetAssetRecord } from "../store/database.js";

const avatarUploadSchema = z
  .object({
    device_id: z.string().trim().min(1).max(128),
    user_id: z.string().trim().min(1).max(128),
    pet_id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/u),
    pet_type: z.enum(["cat", "dog"]),
    visible_traits: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    mime_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    image_base64: z.string().min(1).max(12_000_000),
  })
  .strict();

const deviceEventRequestSchema = z
  .object({
    event: deviceEventSchema,
    keyframe: imageObservationSchema.optional(),
  })
  .strict();

type AvatarJobStatus = "pending" | "ready" | "deploying" | "active" | "failed";

interface AvatarJob {
  job_id: string;
  asset_ref: string;
  device_id: string;
  user_id: string;
  pet_id: string;
  asset_version: string;
  status: AvatarJobStatus;
  created_at: string;
  updated_at: string;
  asset_id?: string;
  reason_code?: string;
}

interface AuthPrincipal {
  userId: string;
  deviceId: string;
  kind: "device" | "user";
}

type CompletedCameraCapture = Extract<
  LanCameraCaptureResult,
  { status: "completed" }
>;

interface RegisteredCameraCapture {
  captureId: string;
  evidenceId: string;
  observedAt: string;
  expiresAt: string;
  requestId: string;
  triggerReason: "presence_event" | "user_request" | "diagnostic";
}

const TRUSTED_DEVICE_SOURCES = new Set([
  "t5_microphone",
  "t5_camera",
  "t5_button",
  "esp32_cam",
  "apds9960",
  "hc_sr04",
  "bno055",
  "grove_imu",
]);

export interface HshhHttpServerOptions {
  config: AgentServiceConfig;
  database: HshhDatabase;
  gateway: EventContextGateway;
  agent: HshhAgent;
  avatarPipeline: AvatarMetadataPipeline;
  cameraAdapter?: LanCameraAdapter;
  effectQueue?: DeviceEffectQueue;
  dispatchEmergencyStop?: (input: {
    userId: string;
    deviceId: string;
    requestId: string;
    occurredAt: string;
  }) => Promise<HshhDeviceDispatchResult>;
  visionGuidedDemo?: {
    maxSteps?: number;
    settleMs?: number;
    dispatchStep: (input: {
      userId: string;
      deviceId: string;
      skill: "approach_short" | "turn_to_user";
      guidance: VerifiedVisionGuidance;
      consentToken?: string;
    }) => Promise<HshhDeviceDispatchResult>;
  };
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  utterancePipeline?: UtterancePipeline;
  speechStore?: SpeechStore;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reasonCode: string,
  ) {
    super(reasonCode);
    this.name = "HttpError";
  }
}

function setCommonHeaders(
  response: ServerResponse,
  config: AgentServiceConfig,
): void {
  response.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  response.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-hshh-audio-format, x-hshh-sample-rate, x-hshh-channels, x-hshh-utterance-id",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(body);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length).trim();
  return token || undefined;
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function assertAuthorized(
  request: IncomingMessage,
  config: AgentServiceConfig,
  kind: "device" | "user",
): AuthPrincipal {
  const expected = kind === "device" ? config.deviceToken : config.userToken;
  if (
    expected === undefined ||
    config.principalUserId === undefined ||
    config.principalDeviceId === undefined
  ) {
    throw new HttpError(503, "authentication_not_configured");
  }
  if (!sameSecret(bearerToken(request), expected)) {
    throw new HttpError(401, "unauthorized");
  }
  return {
    userId: config.principalUserId,
    deviceId: config.principalDeviceId,
    kind,
  };
}

function assertScopedId(
  actual: unknown,
  expected: string,
  reasonCode: string,
): void {
  if (actual !== undefined && actual !== expected) {
    throw new HttpError(403, reasonCode);
  }
}

function scopeInteractionBody(
  body: unknown,
  principal: AuthPrincipal,
  allowDeepResearch: boolean,
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  const context = record["device_context"];
  if (!context || typeof context !== "object" || Array.isArray(context)) return body;
  const deviceContext = context as Record<string, unknown>;
  assertScopedId(
    deviceContext["device_id"],
    principal.deviceId,
    "device_scope_mismatch",
  );
  assertScopedId(
    deviceContext["user_id"],
    principal.userId,
    "user_scope_mismatch",
  );
  if (record["task_mode"] === "deep_research" && !allowDeepResearch) {
    throw new HttpError(403, "deep_research_not_authorized");
  }
  return {
    ...record,
    request_id:
      typeof record["request_id"] === "string"
        ? record["request_id"]
        : `turn_${randomUUID()}`,
    device_context: {
      ...deviceContext,
      device_id: principal.deviceId,
      user_id: principal.userId,
    },
    task_mode: record["task_mode"] === "deep_research" ? "deep_research" : "companion",
  };
}

async function readRawBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new HttpError(413, "request_too_large");
    chunks.push(buffer);
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const raw = await readRawBody(request, maxBytes);
  if (raw.length === 0) throw new HttpError(400, "json_body_required");
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function requestHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  const text = Array.isArray(value) ? value[0] : value;
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveIntegerHeader(
  request: IncomingMessage,
  name: string,
  fallback: number,
): number {
  const raw = requestHeader(request, name);
  if (raw === undefined) return fallback;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new HttpError(400, "invalid_audio_header");
  }
  return Number.parseInt(raw, 10);
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new HttpError(400, "invalid_image_base64");
  }
  const bytes = Buffer.from(value, "base64");
  const normalizedInput = value.replace(/=+$/u, "");
  const normalizedOutput = bytes.toString("base64").replace(/=+$/u, "");
  if (normalizedInput !== normalizedOutput) {
    throw new HttpError(400, "invalid_image_base64");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_SOURCE_BYTES) {
    throw new HttpError(413, "avatar_image_size_invalid");
  }
  return bytes;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function imageDimensions(
  bytes: Buffer,
  mime: "image/jpeg" | "image/png" | "image/webp",
): { width: number; height: number } {
  if (mime === "image/png") {
    if (
      bytes.length < 24 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    ) {
      throw new HttpError(400, "mime_signature_mismatch");
    }
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/jpeg") {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      throw new HttpError(400, "mime_signature_mismatch");
    }
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          height: bytes.readUInt16BE(offset + 5),
          width: bytes.readUInt16BE(offset + 7),
        };
      }
      offset += length + 2;
    }
    throw new HttpError(400, "image_dimensions_unavailable");
  }

  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    throw new HttpError(400, "mime_signature_mismatch");
  }
  const codec = bytes.subarray(12, 16).toString("ascii");
  if (codec === "VP8X") {
    return {
      width: readUInt24LE(bytes, 24) + 1,
      height: readUInt24LE(bytes, 27) + 1,
    };
  }
  if (codec === "VP8 " && bytes.subarray(23, 26).toString("hex") === "9d012a") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (codec === "VP8L" && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return {
      width: (packed & 0x3fff) + 1,
      height: ((packed >>> 14) & 0x3fff) + 1,
    };
  }
  throw new HttpError(400, "image_dimensions_unavailable");
}

function safeSdkEvent(event: SDKMessage): Record<string, unknown> {
  const record = event as unknown as Record<string, unknown>;
  const safe: Record<string, unknown> = { type: event.type };
  for (const key of ["subtype", "session_id", "tool_name", "status", "uuid"]) {
    const value = record[key];
    if (typeof value === "string") safe[key] = value.slice(0, 256);
  }
  if (event.type === "assistant") {
    const message = record["message"];
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>)["content"];
      if (Array.isArray(content)) {
        safe["content"] = content.flatMap((block): Record<string, unknown>[] => {
          if (!block || typeof block !== "object") return [];
          const item = block as Record<string, unknown>;
          if (item["type"] === "text" && typeof item["text"] === "string") {
            return [{ type: "text", text: item["text"].slice(0, 4_000) }];
          }
          if (item["type"] === "tool_use") {
            return [
              {
                type: "tool_use",
                name: typeof item["name"] === "string" ? item["name"] : "unknown",
                id: typeof item["id"] === "string" ? item["id"] : undefined,
              },
            ];
          }
          return [];
        });
      }
    }
  }
  return safe;
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pathId(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const value = pathname.slice(prefix.length);
  return value && !value.includes("/") ? decodeURIComponent(value) : undefined;
}

function publicAvatarJob(job: AvatarJob, database: HshhDatabase) {
  const asset = job.asset_id ? database.getPetAsset(job.asset_id) : null;
  return {
    job_id: job.job_id,
    status: job.status,
    device_id: job.device_id,
    pet_id: job.pet_id,
    asset_version: job.asset_version,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.reason_code === undefined ? {} : { reason_code: job.reason_code }),
    ...(asset === null
      ? {}
      : {
          asset_id: asset.id,
          manifest: asset.manifest,
          checksum_sha256: asset.checksum_sha256,
          active: asset.active,
          manifest_url: `/v1/avatar-packs/${encodeURIComponent(job.job_id)}/files/manifest.json`,
          asset_base_url: `/v1/avatar-packs/${encodeURIComponent(job.job_id)}/files/`,
        }),
  };
}

function deviceAvatarManifest(asset: PetAssetRecord): Record<string, unknown> | undefined {
  const candidate = asset.manifest["device_package"];
  return validateDeviceAvatarManifest(candidate).valid
    ? (candidate as Record<string, unknown>)
    : undefined;
}

function requestedAvatarAsset(
  database: HshhDatabase,
  deviceId: string,
): PetAssetRecord | undefined {
  const events = database.listInteractionEvents({
    device_id: deviceId,
    event_type: "avatar_deployment_requested",
    limit: 100,
  });
  for (const event of events) {
    const assetId = event.payload?.["asset_id"];
    if (typeof assetId !== "string") continue;
    const asset = database.getPetAsset(assetId);
    if (asset?.device_id === deviceId && asset.status === "ready") {
      return asset;
    }
  }
  return undefined;
}

export function createHshhHttpServer(options: HshhHttpServerOptions): Server {
  const now = options.now ?? (() => new Date());
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const avatarJobs = new Map<string, AvatarJob>();
  const lastAutonomousTurn = new Map<string, number>();
  const activeVisionCycles = new Set<string>();
  const visionMaxSteps = options.visionGuidedDemo?.maxSteps ?? 4;
  const visionSettleMs = options.visionGuidedDemo?.settleMs ?? 1_100;
  if (!Number.isInteger(visionMaxSteps) || visionMaxSteps < 1 || visionMaxSteps > 4) {
    throw new RangeError("visionGuidedDemo.maxSteps must be between 1 and 4");
  }
  if (
    !Number.isInteger(visionSettleMs) ||
    visionSettleMs < 1_000 ||
    visionSettleMs > 5_000
  ) {
    throw new RangeError("visionGuidedDemo.settleMs must be between 1000 and 5000");
  }

  function queueDecisionFeedback(input: {
    userId: string;
    deviceId: string;
    requestId: string;
    decision: AgentDecision;
  }): void {
    if (!options.effectQueue) return;
    const expressionResult = options.effectQueue.enqueue({
      type: "set_expression",
      request_id: input.requestId,
      actor_user_id: input.userId,
      device_id: input.deviceId,
      expression: input.decision.expression,
      intensity: 0.75,
      duration_ms: 3_500,
      reason: "render_agent_decision",
    });
    let soundResult: HshhDeviceDispatchResult | undefined;
    let consentOfferResult: HshhDeviceDispatchResult | undefined;
    if (
      input.decision.output_modalities?.includes("sound") ||
      input.decision.output_modalities?.includes("speech")
    ) {
      const sound =
        input.decision.expression === "noticed"
          ? "notice"
          : input.decision.expression === "listening"
            ? "listening"
            : input.decision.expression === "happy"
              ? "success"
              : input.decision.expression === "sleeping"
                ? "sleepy"
                : "confused";
      soundResult = options.effectQueue.enqueue({
        type: "play_sound",
        request_id: input.requestId,
        actor_user_id: input.userId,
        device_id: input.deviceId,
        sound,
        reason: "render_agent_decision",
      });
    }
    if (
      input.decision.requires_user_confirmation &&
      (input.decision.confirmation_scope === "approach_short" ||
        input.decision.confirmation_scope === "invite_hug")
    ) {
      consentOfferResult = options.effectQueue.enqueueConsentOffer({
        requestId: input.requestId,
        deviceId: input.deviceId,
        scope: input.decision.confirmation_scope,
        ttlMs: 10_000,
      });
    }
    options.database.recordInteractionEvent({
      event_type: "decision_feedback_queued",
      occurred_at: now().toISOString(),
      user_id: input.userId,
      device_id: input.deviceId,
      request_id: input.requestId,
      payload: {
        expression: input.decision.expression,
        expression_status: expressionResult.status,
        ...(soundResult === undefined ? {} : { sound_status: soundResult.status }),
        ...(consentOfferResult === undefined
          ? {}
          : { consent_offer_status: consentOfferResult.status }),
      },
    });
  }

  function registerCameraCapture(input: {
    userId: string;
    deviceId: string;
    capture: CompletedCameraCapture;
    triggerReason: "presence_event" | "user_request" | "diagnostic";
  }): RegisteredCameraCapture {
    const event = {
      device_id: input.deviceId,
      user_id: input.userId,
      event: "triggered_keyframe",
      source: "esp32_cam" as const,
      request_id: input.capture.capture_id,
      occurred_at: input.capture.observed_at,
      payload: {
        modality: "vision",
        media_ref: input.capture.capture_id,
        confidence: 1,
        ttl_ms: 15_000,
        summary: "Authenticated event-triggered ESP32-CAM keyframe",
        trigger_reason: input.triggerReason,
      },
    };
    const ingested = options.gateway.ingestEvent(event);
    if (!ingested.accepted) {
      throw new HttpError(422, ingested.reason_code);
    }
    try {
      options.gateway.registerKeyframe(
        input.deviceId,
        ingested.evidence_id,
        input.capture.image,
        now(),
      );
    } catch (error) {
      throw new HttpError(
        422,
        error instanceof EventContextGatewayError
          ? error.code
          : "keyframe_rejected",
      );
    }
    options.database.recordInteractionEvent({
      event_type: "triggered_keyframe_received",
      occurred_at: now().toISOString(),
      user_id: input.userId,
      device_id: input.deviceId,
      request_id: input.capture.capture_id,
      payload: {
        evidence_id: ingested.evidence_id,
        source: "esp32_cam",
        trigger_reason: input.triggerReason,
      },
    });
    return {
      captureId: input.capture.capture_id,
      evidenceId: ingested.evidence_id,
      observedAt: input.capture.observed_at,
      expiresAt: ingested.expires_at,
      requestId: input.capture.capture_id,
      triggerReason: input.triggerReason,
    };
  }

  function visionCycleInterrupted(deviceId: string, startedAt: string): boolean {
    return options.gateway
      .getRecentEvents(deviceId, { since: startedAt, now: now(), limit: 100 })
      .some((event) => event.priority === "stop" || event.priority === "reject");
  }

  function triggerAutonomousPresenceTurn(input: {
    userId: string;
    deviceId: string;
    evidenceId: string;
    requestId: string;
    observedAt: string;
    expiresAt: string;
    triggerReason: "presence_event" | "user_request";
  }): void {
    const triggeredAt = now();
    if (activeVisionCycles.has(input.deviceId)) return;
    const prior = lastAutonomousTurn.get(input.deviceId) ?? 0;
    if (
      input.triggerReason !== "user_request" &&
      triggeredAt.getTime() - prior < 8_000
    ) {
      return;
    }
    lastAutonomousTurn.set(input.deviceId, triggeredAt.getTime());
    activeVisionCycles.add(input.deviceId);
    const persistedContext =
      options.gateway.getDeviceContext(input.deviceId) ??
      options.database.getDeviceContext(input.deviceId);
    const context = persistedContext ?? {
      device_id: input.deviceId,
      user_id: input.userId,
      observed_at: triggeredAt.toISOString(),
      presence: "unknown" as const,
      pose: "unknown" as const,
      battery: "unknown" as const,
      safety_state: "stopped" as const,
    };

    const runCycle = async (): Promise<void> => {
      let current: RegisteredCameraCapture = {
        captureId: input.requestId,
        evidenceId: input.evidenceId,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        requestId: input.requestId,
        triggerReason: input.triggerReason,
      };

      for (let stepIndex = 0; stepIndex < visionMaxSteps; stepIndex += 1) {
        if (visionCycleInterrupted(input.deviceId, triggeredAt.toISOString())) {
          break;
        }
        const turnRequestId = `vision_${current.requestId}`;
        const result = await options.agent.interact({
          request_id: turnRequestId,
          transcript:
            `这是 ESP32-CAM 视觉引导的第 ${stepIndex + 1} 帧。只分析 capture_id=${current.captureId} 对应的最新图片并填写 visual_guidance。` +
            "以正向、非镜像画面的横轴判断单一主要人物位于 left、center、right 或 unknown；不要调用任何物理动作工具，宿主会独立执行安全门。视觉不能生成同意。",
          device_context: {
            ...context,
            user_id: input.userId,
            device_id: input.deviceId,
          },
          task_mode: "companion",
        });
        const approachConsent = options.gateway
          .getActiveConsents(input.deviceId, input.userId, now())
          .filter((consent) => consent.scope === "approach_short")
          .sort(
            (left, right) =>
              Date.parse(right.granted_at) - Date.parse(left.granted_at),
          )[0];
        const selection = selectVisionGuidedStep({
          ...(result.decision.visual_guidance === undefined
            ? {}
            : { guidance: result.decision.visual_guidance }),
          evidence: {
            captureId: current.captureId,
            evidenceId: current.evidenceId,
            observedAt: current.observedAt,
            expiresAt: current.expiresAt,
          },
          hasApproachConsent: approachConsent !== undefined,
          now: now(),
        });
        const feedbackDecision: AgentDecision =
          selection.status === "blocked" &&
          selection.reason_code === "approach_consent_required"
            ? {
                ...result.decision,
                requires_user_confirmation: true,
                confirmation_scope: "approach_short",
              }
            : result.decision;
        if (stepIndex === 0 || selection.reason_code === "approach_consent_required") {
          queueDecisionFeedback({
            userId: input.userId,
            deviceId: input.deviceId,
            requestId: turnRequestId,
            decision: feedbackDecision,
          });
        }
        options.database.recordInteractionEvent({
          event_type: "autonomous_presence_turn_completed",
          occurred_at: now().toISOString(),
          user_id: input.userId,
          device_id: input.deviceId,
          request_id: current.requestId,
          payload: {
            evidence_id: current.evidenceId,
            capture_id: current.captureId,
            mode: result.mode,
            expression: result.decision.expression,
            visual_direction:
              result.decision.visual_guidance?.direction ?? "unknown",
            visual_confidence:
              result.decision.visual_guidance?.confidence ?? 0,
            guidance_status: selection.status,
            guidance_reason_code: selection.reason_code,
            used_evidence_ids: result.decision.used_evidence_ids,
          },
        });

        if (selection.status !== "ready" || !options.visionGuidedDemo) break;
        if (visionCycleInterrupted(input.deviceId, triggeredAt.toISOString())) {
          break;
        }
        const dispatched = await options.visionGuidedDemo.dispatchStep({
          userId: input.userId,
          deviceId: input.deviceId,
          skill: selection.step.skill,
          guidance: selection.step.guidance,
          ...(approachConsent === undefined
            ? {}
            : { consentToken: approachConsent.token }),
        });
        options.database.recordInteractionEvent({
          event_type: "vision_guided_step_dispatched",
          occurred_at: now().toISOString(),
          user_id: input.userId,
          device_id: input.deviceId,
          request_id: current.requestId,
          payload: {
            capture_id: current.captureId,
            evidence_id: current.evidenceId,
            direction: selection.step.guidance.direction,
            skill: selection.step.skill,
            status: dispatched.status,
            reason_code: dispatched.reason_code,
            step_index: stepIndex,
          },
        });
        if (dispatched.status !== "accepted" && dispatched.status !== "completed") {
          break;
        }
        if (stepIndex + 1 >= visionMaxSteps || !options.cameraAdapter) break;

        await sleep(visionSettleMs);
        if (visionCycleInterrupted(input.deviceId, triggeredAt.toISOString())) {
          break;
        }
        const nextCapture = await options.cameraAdapter.capture(
          input.deviceId,
          "presence_event",
        );
        if (nextCapture.status !== "completed") {
          options.database.recordInteractionEvent({
            event_type: "vision_guided_cycle_degraded",
            occurred_at: now().toISOString(),
            user_id: input.userId,
            device_id: input.deviceId,
            request_id: current.requestId,
            payload: { reason_code: nextCapture.reason_code },
          });
          break;
        }
        current = registerCameraCapture({
          userId: input.userId,
          deviceId: input.deviceId,
          capture: nextCapture,
          triggerReason: "presence_event",
        });
      }
    };

    void runCycle()
      .catch(() => {
        options.database.recordInteractionEvent({
          event_type: "autonomous_presence_turn_degraded",
          occurred_at: now().toISOString(),
          user_id: input.userId,
          device_id: input.deviceId,
          request_id: input.requestId,
          payload: {
            evidence_id: input.evidenceId,
            reason_code: "agent_turn_unavailable",
          },
        });
      })
      .finally(() => {
        activeVisionCycles.delete(input.deviceId);
      });
  }

  function triggerExplicitConsentTurn(input: {
    userId: string;
    deviceId: string;
    evidenceId: string;
    requestId: string;
    scope: "approach_short" | "invite_hug";
  }): void {
    const triggeredAt = now();
    const persistedContext =
      options.gateway.getDeviceContext(input.deviceId) ??
      options.database.getDeviceContext(input.deviceId);
    const context = persistedContext ?? {
      device_id: input.deviceId,
      user_id: input.userId,
      observed_at: triggeredAt.toISOString(),
      presence: "unknown" as const,
      pose: "unknown" as const,
      battery: "unknown" as const,
      safety_state: "stopped" as const,
    };
    const turnRequestId = `consent_${input.requestId}`;

    void options.agent
      .interact({
        request_id: turnRequestId,
        transcript:
          input.scope === "approach_short"
            ? "用户刚刚通过受信设备输入明确同意机器人短距离靠近。请读取本轮同意与最新本地安全证据；只有全部门禁通过时才可请求 approach_short，否则说明当前不能移动。"
            : "用户刚刚通过受信设备输入明确同意机器人发出拥抱邀请。请读取本轮同意与最新本地安全证据；只有底盘停止、姿态和舵机门禁通过时才可请求 invite_hug，否则保持静止并说明原因。",
        device_context: {
          ...context,
          user_id: input.userId,
          device_id: input.deviceId,
        },
        task_mode: "companion",
      })
      .then((result) => {
        queueDecisionFeedback({
          userId: input.userId,
          deviceId: input.deviceId,
          requestId: turnRequestId,
          decision: result.decision,
        });
        options.database.recordInteractionEvent({
          event_type: "explicit_consent_turn_completed",
          occurred_at: now().toISOString(),
          user_id: input.userId,
          device_id: input.deviceId,
          request_id: input.requestId,
          payload: {
            scope: input.scope,
            evidence_id: input.evidenceId,
            mode: result.mode,
            skill: result.decision.skill_request?.skill ?? null,
          },
        });
      })
      .catch(() => {
        options.database.recordInteractionEvent({
          event_type: "explicit_consent_turn_degraded",
          occurred_at: now().toISOString(),
          user_id: input.userId,
          device_id: input.deviceId,
          request_id: input.requestId,
          payload: {
            scope: input.scope,
            evidence_id: input.evidenceId,
            reason_code: "agent_turn_unavailable",
          },
        });
      });
  }

  return createServer(async (request, response) => {
    setCommonHeaders(response, options.config);
    try {
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://hshh.local");
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", service: "hshh-agent", version: "0.4.0" });
        return;
      }
      const principal = assertAuthorized(
        request,
        options.config,
        url.pathname.startsWith("/v1/device/") ? "device" : "user",
      );

      const deviceAvatarFileMatch =
        /^\/v1\/device\/avatar-pack\/([^/]+)\/files\/(.+)$/u.exec(url.pathname);
      if (
        request.method === "GET" &&
        deviceAvatarFileMatch?.[1] &&
        deviceAvatarFileMatch[2]
      ) {
        const assetId = decodeURIComponent(deviceAvatarFileMatch[1]);
        const relativePath = decodeURIComponent(deviceAvatarFileMatch[2]);
        const asset = options.database.getPetAsset(assetId);
        if (
          !asset ||
          asset.device_id !== principal.deviceId ||
          (asset.status !== "ready" && asset.status !== "active") ||
          !relativePath.startsWith("device/") ||
          !relativePath.endsWith(".jpg")
        ) {
          throw new HttpError(404, "avatar_file_not_found");
        }
        if (
          !options.avatarPipeline.hasPack(asset.id, principal.deviceId) &&
          !(await options.avatarPipeline.restorePack(asset))
        ) {
          throw new HttpError(409, "avatar_pack_integrity_failed");
        }
        const bytes = await options.avatarPipeline.readPackFile(
          asset.id,
          principal.deviceId,
          relativePath,
        );
        if (!bytes) throw new HttpError(404, "avatar_file_not_found");
        response.statusCode = 200;
        response.setHeader("Content-Type", "image/jpeg");
        response.setHeader("Content-Length", bytes.byteLength);
        response.end(bytes);
        return;
      }

      const deviceAvatarActivateMatch =
        /^\/v1\/device\/avatar-pack\/([^/]+)\/activate$/u.exec(url.pathname);
      if (
        request.method === "POST" &&
        deviceAvatarActivateMatch?.[1]
      ) {
        const assetId = decodeURIComponent(deviceAvatarActivateMatch[1]);
        const parsed = z
          .object({
            manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            files_verified: z.literal(45),
            identity_verified: z.literal(true),
            display_ready: z.literal(true),
          })
          .strict()
          .safeParse(await readJsonBody(request, 1_024));
        if (!parsed.success) {
          throw new HttpError(400, "invalid_avatar_activation_receipt");
        }
        const requested = requestedAvatarAsset(
          options.database,
          principal.deviceId,
        );
        const asset = options.database.getPetAsset(assetId);
        if (
          !asset ||
          asset.device_id !== principal.deviceId ||
          (asset.status !== "ready" && asset.status !== "active") ||
          (asset.status !== "active" && requested?.id !== asset.id)
        ) {
          throw new HttpError(409, "avatar_deployment_not_requested");
        }
        const manifest = deviceAvatarManifest(asset);
        if (!manifest) throw new HttpError(409, "avatar_manifest_invalid");
        const manifestChecksum = createHash("sha256")
          .update(JSON.stringify(manifest))
          .digest("hex");
        if (parsed.data.manifest_sha256 !== manifestChecksum) {
          throw new HttpError(409, "avatar_manifest_checksum_mismatch");
        }
        if (
          !options.avatarPipeline.hasPack(asset.id, principal.deviceId) &&
          !(await options.avatarPipeline.restorePack(asset))
        ) {
          throw new HttpError(409, "avatar_pack_integrity_failed");
        }
        const activated =
          asset.status === "active"
            ? asset
            : options.database.activatePetAsset(principal.deviceId, asset.id);
        if (!activated) throw new HttpError(409, "avatar_activation_failed");
        for (const job of avatarJobs.values()) {
          if (job.asset_id === asset.id && job.device_id === principal.deviceId) {
            job.status = "active";
            job.updated_at = now().toISOString();
          }
        }
        options.database.recordInteractionEvent({
          event_type: "avatar_pack_activated",
          occurred_at: now().toISOString(),
          user_id: principal.userId,
          device_id: principal.deviceId,
          request_id: asset.id,
          payload: {
            asset_id: asset.id,
            files_verified: parsed.data.files_verified,
            identity_verified: parsed.data.identity_verified,
            display_ready: parsed.data.display_ready,
            manifest_sha256: manifestChecksum,
          },
        });
        sendJson(response, 200, {
          activated: true,
          asset_id: asset.id,
          status: "active",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/device/avatar-pack") {
        const asset = requestedAvatarAsset(options.database, principal.deviceId);
        if (!asset) {
          sendJson(response, 200, {
            deployment: null,
            active_asset_id:
              options.database.getActivePetAsset(principal.deviceId)?.id ?? null,
          });
          return;
        }
        const manifest = deviceAvatarManifest(asset);
        if (!manifest) throw new HttpError(409, "avatar_manifest_invalid");
        if (
          !options.avatarPipeline.hasPack(asset.id, principal.deviceId) &&
          !(await options.avatarPipeline.restorePack(asset))
        ) {
          throw new HttpError(409, "avatar_pack_integrity_failed");
        }
        sendJson(response, 200, {
          deployment: {
            asset_id: asset.id,
            pet_id: asset.pet_id,
            asset_version: asset.asset_version,
            manifest,
            manifest_sha256: createHash("sha256")
              .update(JSON.stringify(manifest))
              .digest("hex"),
            asset_base_url: `/v1/device/avatar-pack/${encodeURIComponent(asset.id)}/files/`,
            activation_url: `/v1/device/avatar-pack/${encodeURIComponent(asset.id)}/activate`,
          },
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/device/effects") {
        if (!options.effectQueue) {
          throw new HttpError(503, "effect_queue_unavailable");
        }
        const afterText = url.searchParams.get("after") ?? "0";
        const limitText = url.searchParams.get("limit") ?? "16";
        if (!/^\d{1,10}$/u.test(afterText) || !/^\d{1,2}$/u.test(limitText)) {
          throw new HttpError(400, "invalid_effect_cursor");
        }
        const effects = options.effectQueue.list(
          principal.deviceId,
          Number(afterText),
          Number(limitText),
        );
        sendJson(response, 200, {
          effects,
          next_sequence: effects.at(-1)?.sequence ?? Number(afterText),
        });
        return;
      }

      const effectAckMatch = /^\/v1\/device\/effects\/([^/]+)\/ack$/u.exec(
        url.pathname,
      );
      if (request.method === "POST" && effectAckMatch?.[1]) {
        if (!options.effectQueue) {
          throw new HttpError(503, "effect_queue_unavailable");
        }
        const parsed = z
          .object({
            status: z.enum([
              "accepted",
              "rejected",
              "completed",
              "stopped",
              "failed",
            ]),
            reason_code: z
              .string()
              .trim()
              .min(1)
              .max(128)
              .regex(/^[a-z0-9][a-z0-9_:.-]*$/u),
          })
          .strict()
          .safeParse(await readJsonBody(request, 1_024));
        if (!parsed.success) throw new HttpError(400, "invalid_effect_ack");
        const effectId = decodeURIComponent(effectAckMatch[1]);
        const pending = options.effectQueue.peek(principal.deviceId, effectId);
        if (
          !options.effectQueue.acknowledge(
            principal.deviceId,
            effectId,
            parsed.data,
          )
        ) {
          throw new HttpError(404, "effect_not_found");
        }
        options.database.recordInteractionEvent({
          event_type: "t5_effect_acknowledged",
          occurred_at: now().toISOString(),
          user_id: principal.userId,
          device_id: principal.deviceId,
          payload: {
            effect_id: effectId,
            ...(pending === undefined ? {} : { type: pending.type }),
            status: parsed.data.status,
            reason_code: parsed.data.reason_code,
          },
        });
        sendJson(response, 200, { acknowledged: true, effect_id: effectId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/device/captures") {
        if (!options.cameraAdapter) {
          throw new HttpError(503, "camera_adapter_unavailable");
        }
        const parsed = z
          .object({ trigger_reason: cameraTriggerReasonSchema })
          .strict()
          .safeParse(await readJsonBody(request, 1_024));
        if (!parsed.success) throw new HttpError(400, "invalid_capture_request");
        const captured = await options.cameraAdapter.capture(
          principal.deviceId,
          parsed.data.trigger_reason,
        );
        if (captured.status !== "completed") {
          throw new HttpError(
            captured.status === "rejected" ? 409 : 502,
            captured.reason_code,
          );
        }
        const registered = registerCameraCapture({
          userId: principal.userId,
          deviceId: principal.deviceId,
          capture: captured,
          triggerReason: parsed.data.trigger_reason,
        });
        sendJson(response, 202, {
          accepted: true,
          capture_id: registered.captureId,
          evidence_id: registered.evidenceId,
          observed_at: registered.observedAt,
          expires_at: registered.expiresAt,
        });
        if (parsed.data.trigger_reason !== "diagnostic") {
          triggerAutonomousPresenceTurn({
            userId: principal.userId,
            deviceId: principal.deviceId,
            evidenceId: registered.evidenceId,
            requestId: registered.requestId,
            observedAt: registered.observedAt,
            expiresAt: registered.expiresAt,
            triggerReason: parsed.data.trigger_reason,
          });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/device/utterances") {
        if (options.utterancePipeline === undefined) {
          throw new HttpError(503, "speech_not_configured");
        }
        const pcm = await readRawBody(request, MAX_UTTERANCE_BYTES);
        const accepted = options.utterancePipeline.accept({
          deviceId: principal.deviceId,
          userId: principal.userId,
          utteranceId:
            requestHeader(request, "x-hshh-utterance-id") ??
            `utt_${randomUUID().replace(/-/gu, "").slice(0, 12)}`,
          pcm,
          sampleRate: parsePositiveIntegerHeader(request, "x-hshh-sample-rate", 16_000),
          channels: parsePositiveIntegerHeader(request, "x-hshh-channels", 1),
          format: requestHeader(request, "x-hshh-audio-format") ?? "pcm_s16le",
        });
        if (!accepted.ok) {
          sendJson(response, accepted.status, {
            status: "failed",
            reason_code: accepted.reason_code,
          });
          return;
        }
        response.setHeader("Connection", "close");
        sendJson(response, 202, {
          accepted: true,
          utterance_id: accepted.utterance_id,
          expires_at: accepted.expires_at,
        });
        void options.utterancePipeline.run(accepted.utterance_id).catch(() => {
          options.database.recordInteractionEvent({
            event_type: "utterance_pipeline_failed",
            occurred_at: now().toISOString(),
            user_id: principal.userId,
            device_id: principal.deviceId,
            request_id: accepted.utterance_id,
            payload: { reason_code: "utterance_pipeline_failed" },
          });
        });
        return;
      }

      const speechMatch = /^\/v1\/device\/speech\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && speechMatch?.[1]) {
        const speechId = decodeURIComponent(speechMatch[1]);
        if (
          speechId.length === 0 ||
          speechId.includes("..") ||
          speechId.includes("/")
        ) {
          throw new HttpError(404, "speech_not_found");
        }
        const clip = options.speechStore?.take(principal.deviceId, speechId);
        if (clip === undefined) {
          throw new HttpError(404, "speech_not_found");
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", clip.pcm.byteLength);
        response.setHeader("Connection", "close");
        response.end(clip.pcm);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/device/events") {
        const body = await readJsonBody(request, options.config.maxRequestBytes);
        const wrapped = deviceEventRequestSchema.safeParse(body);
        const direct = deviceEventSchema.safeParse(body);
        if (!wrapped.success && !direct.success) {
          throw new HttpError(400, "invalid_device_event");
        }
        const parsedEvent = wrapped.success
          ? wrapped.data.event
          : direct.success
            ? direct.data
            : undefined;
        if (!parsedEvent) throw new HttpError(400, "invalid_device_event");
        assertScopedId(
          parsedEvent.device_id,
          principal.deviceId,
          "device_scope_mismatch",
        );
        assertScopedId(
          parsedEvent.user_id,
          principal.userId,
          "user_scope_mismatch",
        );
        if (
          parsedEvent.source === undefined ||
          !TRUSTED_DEVICE_SOURCES.has(parsedEvent.source)
        ) {
          throw new HttpError(403, "device_source_not_authorized");
        }
        const event = {
          ...parsedEvent,
          device_id: principal.deviceId,
          user_id: principal.userId,
          request_id: parsedEvent.request_id ?? `event_${randomUUID()}`,
        };
        const keyframe = wrapped.success ? wrapped.data.keyframe : undefined;
        const ingested = options.gateway.ingestEvent(event);
        if (!ingested.accepted) {
          options.database.recordInteractionEvent({
            event_type: "modality_evidence_dropped",
            occurred_at: now().toISOString(),
            user_id: principal.userId,
            device_id: principal.deviceId,
            request_id: event.request_id,
            payload: {
              source: event.source,
              reason_code: ingested.reason_code,
            },
          });
          sendJson(response, 422, ingested);
          return;
        }
        if (keyframe) {
          try {
            options.gateway.registerKeyframe(
              event.device_id,
              ingested.evidence_id,
              keyframe,
              now(),
            );
          } catch (error) {
            throw new HttpError(
              422,
              error instanceof EventContextGatewayError
                ? error.code
                : "keyframe_rejected",
            );
          }
        }
        const context = options.gateway.getDeviceContext(event.device_id);
        if (context) options.database.upsertDeviceContext(context);
        options.database.recordInteractionEvent({
          event_type: "modality_evidence_received",
          occurred_at: now().toISOString(),
          ...(event.user_id === undefined ? {} : { user_id: event.user_id }),
          device_id: event.device_id,
          ...(event.request_id === undefined ? {} : { request_id: event.request_id }),
          payload: {
            event_id: ingested.event_id,
            evidence_id: ingested.evidence_id,
            source: event.source ?? null,
            priority: ingested.priority,
            expires_at: ingested.expires_at,
          },
        });
        sendJson(response, 202, ingested);
        if (
          event.event === "approach_consent_granted" ||
          event.event === "hug_consent_granted"
        ) {
          triggerExplicitConsentTurn({
            userId: principal.userId,
            deviceId: principal.deviceId,
            evidenceId: ingested.evidence_id,
            requestId: event.request_id,
            scope:
              event.event === "approach_consent_granted"
                ? "approach_short"
                : "invite_hug",
          });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/feedback") {
        const parsed = userFeedbackSchema.safeParse(
          await readJsonBody(request, 4_096),
        );
        if (!parsed.success) throw new HttpError(400, "invalid_user_feedback");
        assertScopedId(
          parsed.data.user_id,
          principal.userId,
          "user_scope_mismatch",
        );
        assertScopedId(
          parsed.data.device_id,
          principal.deviceId,
          "device_scope_mismatch",
        );
        if (
          parsed.data.feedback === "accept" &&
          parsed.data.consent_scope === undefined
        ) {
          throw new HttpError(400, "consent_scope_required");
        }
        if (
          parsed.data.feedback !== "accept" &&
          parsed.data.consent_scope !== undefined
        ) {
          throw new HttpError(400, "consent_scope_not_allowed");
        }

        const requestId = parsed.data.request_id ?? `feedback_${randomUUID()}`;
        const eventName =
          parsed.data.feedback === "accept"
            ? parsed.data.consent_scope === "approach_short"
              ? "approach_consent_granted"
              : "hug_consent_granted"
            : parsed.data.feedback === "reject"
              ? "user_reject"
              : parsed.data.feedback === "stop"
                ? "user_stop"
                : "user_correction";
        const summary =
          parsed.data.feedback === "accept"
            ? `Explicit user text consent for ${parsed.data.consent_scope}`
            : parsed.data.feedback === "reject"
              ? "Explicit user text rejection"
              : parsed.data.feedback === "stop"
                ? "Explicit user text stop"
                : "Explicit user correction";
        const ingested = options.gateway.ingestEvent({
          device_id: principal.deviceId,
          user_id: principal.userId,
          event: eventName,
          source: "web_text",
          request_id: requestId,
          occurred_at: parsed.data.occurred_at,
          payload: {
            modality: "speech_text",
            feedback: parsed.data.feedback,
            confidence: 1,
            ttl_ms: 10_000,
            summary,
            ...(parsed.data.detail === undefined
              ? {}
              : { transcript: parsed.data.detail }),
            ...(parsed.data.feedback === "accept"
              ? {
                  explicit: true,
                  consent_scope: parsed.data.consent_scope,
                }
              : {}),
            ...(parsed.data.feedback === "reject"
              ? { rejected: true }
              : {}),
            ...(parsed.data.feedback === "stop" ? { stop: true } : {}),
          },
        });
        if (!ingested.accepted) {
          throw new HttpError(422, ingested.reason_code);
        }

        let motionStop: HshhDeviceDispatchResult | undefined;
        if (parsed.data.feedback === "stop") {
          try {
            motionStop =
              options.dispatchEmergencyStop === undefined
                ? {
                    status: "rejected",
                    reason_code: "motion_adapter_unavailable",
                  }
                : await options.dispatchEmergencyStop({
                    userId: principal.userId,
                    deviceId: principal.deviceId,
                    requestId,
                    occurredAt: parsed.data.occurred_at,
                  });
          } catch {
            motionStop = {
              status: "failed",
              reason_code: "motion_stop_dispatch_failed",
            };
          }
        }
        options.database.recordInteractionEvent({
          event_type: "user_feedback_received",
          occurred_at: now().toISOString(),
          user_id: principal.userId,
          device_id: principal.deviceId,
          request_id: requestId,
          payload: {
            feedback: parsed.data.feedback,
            ...(parsed.data.consent_scope === undefined
              ? {}
              : { consent_scope: parsed.data.consent_scope }),
            evidence_id: ingested.evidence_id,
            ...(motionStop === undefined ? {} : { motion_stop: motionStop }),
          },
        });
        sendJson(response, 202, {
          accepted: true,
          request_id: requestId,
          evidence_id: ingested.evidence_id,
          expires_at: ingested.expires_at,
          ...(ingested.consent === undefined
            ? {}
            : { consent: ingested.consent }),
          ...(motionStop === undefined ? {} : { motion_stop: motionStop }),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/interactions") {
        const scopedInteraction = scopeInteractionBody(
          await readJsonBody(request, options.config.maxRequestBytes),
          principal,
          options.config.allowDeepResearch,
        );
        if (
          !scopedInteraction ||
          typeof scopedInteraction !== "object" ||
          Array.isArray(scopedInteraction)
        ) {
          throw new HttpError(400, "invalid_interaction_request");
        }
        const scopedBody = scopedInteraction as Record<string, unknown>;
        const body = {
          ...scopedBody,
          request_id:
            typeof scopedBody["request_id"] === "string"
              ? scopedBody["request_id"]
              : `interaction_${randomUUID()}`,
        };
        if ((request.headers.accept ?? "").includes("text/event-stream")) {
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          response.setHeader("Connection", "keep-alive");
          writeSse(response, "status", { status: "started" });
          const result = await options.agent.interact(body, {
            onSdkEvent: (event) => writeSse(response, "sdk_event", safeSdkEvent(event)),
          });
          queueDecisionFeedback({
            userId: principal.userId,
            deviceId: principal.deviceId,
            requestId: body.request_id,
            decision: result.decision,
          });
          writeSse(response, "result", result);
          response.end();
          return;
        }
        const result = await options.agent.interact(body);
        queueDecisionFeedback({
          userId: principal.userId,
          deviceId: principal.deviceId,
          requestId: body.request_id,
          decision: result.decision,
        });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/avatar-packs") {
        const parsed = avatarUploadSchema.safeParse(
          await readJsonBody(request, options.config.maxRequestBytes),
        );
        if (!parsed.success) throw new HttpError(400, "invalid_avatar_upload");
        const input = parsed.data;
        assertScopedId(
          input.device_id,
          principal.deviceId,
          "device_scope_mismatch",
        );
        assertScopedId(
          input.user_id,
          principal.userId,
          "user_scope_mismatch",
        );
        const persistedContext =
          options.gateway.getDeviceContext(input.device_id) ??
          options.database.getDeviceContext(input.device_id);
        if (
          persistedContext?.user_id !== undefined &&
          persistedContext.user_id !== input.user_id
        ) {
          throw new HttpError(403, "user_device_scope_mismatch");
        }
        const context = persistedContext ?? {
          device_id: input.device_id,
          user_id: input.user_id,
          observed_at: now().toISOString(),
          presence: "unknown" as const,
          pose: "unknown" as const,
          battery: "unknown" as const,
          safety_state: "stopped" as const,
        };
        const bytes = decodeBase64(input.image_base64);
        const dimensions = imageDimensions(bytes, input.mime_type);
        if (
          dimensions.width < 1 ||
          dimensions.height < 1 ||
          dimensions.width > 8_192 ||
          dimensions.height > 8_192
        ) {
          throw new HttpError(400, "avatar_dimensions_invalid");
        }
        const jobId = `avatar_${randomUUID()}`;
        const assetVersion = `v0.4-${Date.now().toString(36)}`;
        const checksum = createHash("sha256").update(bytes).digest("hex");
        const assetRef = options.avatarPipeline.stageAsset(
          {
            device_id: input.device_id,
            request_id: jobId,
            pet_id: input.pet_id,
            asset_version: assetVersion,
            mime_type: input.mime_type,
            byte_length: bytes.byteLength,
            width: dimensions.width,
            height: dimensions.height,
            header_hex: bytes.subarray(0, 32).toString("hex"),
            checksum_sha256: checksum,
            computed_checksum_sha256: checksum,
          },
          bytes,
        );
        bytes.fill(0);
        const timestamp = now().toISOString();
        const job: AvatarJob = {
          job_id: jobId,
          asset_ref: assetRef,
          device_id: input.device_id,
          user_id: input.user_id,
          pet_id: input.pet_id,
          asset_version: assetVersion,
          status: "pending",
          created_at: timestamp,
          updated_at: timestamp,
        };
        avatarJobs.set(jobId, job);
        options.database.recordInteractionEvent({
          event_type: "avatar_job_started",
          occurred_at: timestamp,
          user_id: input.user_id,
          device_id: input.device_id,
          request_id: jobId,
          payload: { pet_id: input.pet_id, asset_version: assetVersion },
        });

        void (async () => {
          try {
            const validated = options.avatarPipeline.validateAsset(
              assetRef,
              input.device_id,
              jobId,
            );
            if (validated.status !== "completed") {
              throw new Error(validated.reason_code);
            }
            const validationId = validated["validation_id"];
            if (typeof validationId !== "string") {
              throw new Error("avatar_validation_id_missing");
            }
            const identity = options.avatarPipeline.generateIdentity(
              validationId,
              input.device_id,
              jobId,
              input.pet_type,
              input.visible_traits,
            );
            if (identity.status !== "completed") {
              throw new Error(identity.reason_code);
            }
            const identityId = identity["identity_id"];
            if (typeof identityId !== "string") {
              throw new Error("avatar_identity_id_missing");
            }
            const composed = await options.avatarPipeline.composePack(
              identityId,
              input.device_id,
              jobId,
              options.database,
            );
            if (composed.status !== "completed") {
              throw new Error(composed.reason_code);
            }
            const asset = composed["asset"];
            if (
              typeof asset !== "object" ||
              asset === null ||
              !("id" in asset) ||
              typeof asset.id !== "string"
            ) {
              throw new Error("avatar_asset_missing");
            }
            job.asset_id = asset.id;
            job.status = "ready";
            job.updated_at = now().toISOString();
            options.database.recordInteractionEvent({
              event_type: "avatar_pack_ready",
              occurred_at: job.updated_at,
              user_id: input.user_id,
              device_id: input.device_id,
              request_id: jobId,
              payload: { asset_id: asset.id, original_photo_deleted: true },
            });

            // The deterministic image service performs the bytes-heavy work;
            // the same companion Agent still handles the conversational event.
            // Failure to reach the model must not discard a valid local pack.
            try {
              await options.agent.interact({
                request_id: `${jobId}_ready`,
                transcript: `宠物表情资源包已通过校验并完成确定性合成，现在等待用户预览确认。不要自动激活。`,
                device_context: context,
                task_mode: "companion",
              });
            } catch {
              options.database.recordInteractionEvent({
                event_type: "avatar_agent_notification_degraded",
                occurred_at: now().toISOString(),
                user_id: input.user_id,
                device_id: input.device_id,
                request_id: jobId,
                payload: { asset_id: asset.id },
              });
            }
          } catch (error) {
            job.status = "failed";
            job.reason_code =
              error instanceof Error ? error.message.slice(0, 128) : "avatar_pack_failed";
            job.updated_at = now().toISOString();
          }
        })();

        sendJson(response, 202, { job_id: jobId, status: job.status });
        return;
      }

      const avatarFileMatch =
        /^\/v1\/avatar-packs\/([^/]+)\/files\/(.+)$/u.exec(url.pathname);
      if (request.method === "GET" && avatarFileMatch?.[1] && avatarFileMatch[2]) {
        const job = avatarJobs.get(decodeURIComponent(avatarFileMatch[1]));
        if (
          !job ||
          !job.asset_id ||
          job.user_id !== principal.userId ||
          job.device_id !== principal.deviceId
        ) {
          throw new HttpError(404, "avatar_job_not_found");
        }
        const relativePath = decodeURIComponent(avatarFileMatch[2]);
        const bytes = await options.avatarPipeline.readPackFile(
          job.asset_id,
          job.device_id,
          relativePath,
        );
        if (!bytes) throw new HttpError(404, "avatar_file_not_found");
        response.statusCode = 200;
        response.setHeader(
          "Content-Type",
          relativePath.endsWith(".json")
            ? "application/json; charset=utf-8"
            : relativePath.endsWith(".jpg")
              ? "image/jpeg"
              : "image/png",
        );
        response.setHeader("Content-Length", bytes.byteLength);
        response.end(bytes);
        return;
      }

      const avatarActivateMatch =
        /^\/v1\/avatar-packs\/([^/]+)\/activate$/u.exec(url.pathname);
      if (request.method === "POST" && avatarActivateMatch?.[1]) {
        const job = avatarJobs.get(decodeURIComponent(avatarActivateMatch[1]));
        if (
          !job ||
          !job.asset_id ||
          job.user_id !== principal.userId ||
          job.device_id !== principal.deviceId
        ) {
          throw new HttpError(404, "avatar_job_not_found");
        }
        const asset = options.database.getPetAsset(job.asset_id);
        if (!asset || asset.status !== "ready") {
          throw new HttpError(409, "avatar_pack_not_ready");
        }
        options.database.recordInteractionEvent({
          event_type: "avatar_deployment_requested",
          occurred_at: now().toISOString(),
          user_id: job.user_id,
          device_id: job.device_id,
          request_id: job.job_id,
          payload: { asset_id: asset.id },
        });
        job.status = "deploying";
        job.updated_at = now().toISOString();
        options.database.recordInteractionEvent({
          event_type: "avatar_user_confirmation_received",
          occurred_at: job.updated_at,
          user_id: job.user_id,
          device_id: job.device_id,
          request_id: job.job_id,
          payload: { asset_id: asset.id },
        });
        sendJson(response, 202, publicAvatarJob(job, options.database));
        return;
      }

      const avatarJobId = pathId(url.pathname, "/v1/avatar-packs/");
      if (request.method === "GET" && avatarJobId) {
        const job = avatarJobs.get(avatarJobId);
        if (!job) throw new HttpError(404, "avatar_job_not_found");
        if (
          job.user_id !== principal.userId ||
          job.device_id !== principal.deviceId
        ) {
          throw new HttpError(404, "avatar_job_not_found");
        }
        sendJson(response, 200, publicAvatarJob(job, options.database));
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/memories") {
        const requestedUserId = url.searchParams.get("user_id")?.trim();
        assertScopedId(
          requestedUserId,
          principal.userId,
          "user_scope_mismatch",
        );
        const userId = principal.userId;
        sendJson(response, 200, {
          settings: options.database.getMemorySetting(userId),
          memories: options.database.listMemories(userId),
        });
        return;
      }

      const memoryId = pathId(url.pathname, "/v1/memories/");
      if (request.method === "PATCH" && memoryId) {
        const body = await readJsonBody(request, options.config.maxRequestBytes);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new HttpError(400, "invalid_memory_update");
        }
        const { user_id: requestedUserId, ...candidate } = body as Record<string, unknown>;
        assertScopedId(
          requestedUserId,
          principal.userId,
          "user_scope_mismatch",
        );
        const userId = principal.userId;
        const update = memoryUpdateSchema.safeParse(candidate);
        if (!update.success) throw new HttpError(400, "invalid_memory_update");
        const memory = options.database.updateMemory(userId, memoryId, update.data);
        if (!memory) throw new HttpError(404, "memory_not_found_or_disabled");
        options.database.recordInteractionEvent({
          event_type: "memory_updated",
          occurred_at: now().toISOString(),
          user_id: principal.userId,
          device_id: principal.deviceId,
          payload: { memory_id: memoryId },
        });
        sendJson(response, 200, { memory });
        return;
      }

      if (request.method === "DELETE" && memoryId) {
        const requestedUserId = url.searchParams.get("user_id")?.trim();
        assertScopedId(
          requestedUserId,
          principal.userId,
          "user_scope_mismatch",
        );
        const userId = principal.userId;
        const deleted = options.database.softDeleteMemory(userId, memoryId);
        if (!deleted) throw new HttpError(404, "memory_not_found");
        options.database.recordInteractionEvent({
          event_type: "memory_deleted",
          occurred_at: now().toISOString(),
          user_id: principal.userId,
          device_id: principal.deviceId,
          payload: { memory_id: memoryId },
        });
        sendJson(response, 200, { deleted: true, memory_id: memoryId });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/v1/memory-settings") {
        const parsed = memorySettingRequestSchema.safeParse(
          await readJsonBody(request, options.config.maxRequestBytes),
        );
        if (!parsed.success) throw new HttpError(400, "invalid_memory_setting");
        assertScopedId(
          parsed.data.user_id,
          principal.userId,
          "user_scope_mismatch",
        );
        const setting = options.database.setMemoryEnabled(
          principal.userId,
          parsed.data.enabled,
        );
        options.database.recordInteractionEvent({
          event_type: "memory_settings_updated",
          occurred_at: now().toISOString(),
          user_id: principal.userId,
          device_id: principal.deviceId,
          payload: { enabled: parsed.data.enabled },
        });
        sendJson(
          response,
          200,
          setting,
        );
        return;
      }

      throw new HttpError(404, "route_not_found");
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, {
          status: "failed",
          reason_code: error.reasonCode,
        });
        return;
      }
      if (error instanceof HshhAgentScopeError) {
        sendJson(response, 403, {
          status: "failed",
          reason_code: error.code,
        });
        return;
      }
      if (error instanceof z.ZodError) {
        sendJson(response, 400, {
          status: "failed",
          reason_code: "invalid_request",
        });
        return;
      }
      sendJson(response, 500, {
        status: "failed",
        reason_code: "internal_error",
      });
    }
  });
}
