import { randomUUID } from "node:crypto";
import {
  INPUT_MODALITIES,
  deviceContextSchema,
  deviceEventSchema,
  type DeviceContext,
  type DeviceEvent,
  type EvidenceSource,
  type ImageObservation,
  type InputModality,
  type ModalityEvidence,
  type MultimodalContext,
} from "../domain/contracts.js";
import { validateTriggeredImage } from "../multimodal/imagePrompt.js";

export const MIN_GATEWAY_WINDOW_MS = 5_000;
export const MAX_GATEWAY_WINDOW_MS = 15_000;

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_RETENTION_MS = 5 * 60_000;
const DEFAULT_CONSENT_TTL_MS = 10_000;

const MODALITY_TTL_CAP_MS: Readonly<Record<InputModality, number>> = {
  speech_text: 15_000,
  speech_prosody: 10_000,
  vision: 15_000,
  gesture: 5_000,
  proximity: 2_000,
  distance: 500,
  pose: 2_000,
};

const STOP_EVENTS = new Set([
  "stop",
  "user_stop",
  "gesture_stop",
  "emergency_stop",
  "obstacle_stop",
  "local_stop",
]);
const REJECT_EVENTS = new Set([
  "reject",
  "user_reject",
  "gesture_reject",
  "consent_denied",
  "approach_consent_denied",
  "hug_consent_denied",
]);
const CONSENT_EVENTS = new Set([
  "consent_granted",
  "approach_consent_granted",
  "hug_consent_granted",
  "gesture_confirm",
]);
const RAW_MEDIA_KEY = /(?:base64|data_?url|raw_?(?:image|audio)|image_?data|audio_?data|bytes)/iu;

export type ConsentScope = "approach_short" | "invite_hug";
export type EventPriority = "stop" | "reject" | "explicit" | "normal";

export type GatewayReasonCode =
  | "invalid_event"
  | "missing_source"
  | "stale_event"
  | "future_event"
  | "raw_media_not_allowed"
  | "invalid_payload"
  | "invalid_sensor_reading"
  | "invalid_window"
  | "device_scope_mismatch"
  | "evidence_not_found"
  | "expired_evidence"
  | "keyframe_mismatch";

export class EventContextGatewayError extends Error {
  readonly code: GatewayReasonCode;

  constructor(code: GatewayReasonCode) {
    super(`Event/context gateway rejected input: ${code}`);
    this.name = "EventContextGatewayError";
    this.code = code;
  }
}

export interface EventContextGatewayOptions {
  now?: () => Date;
  idFactory?: () => string;
  defaultWindowMs?: number;
  retentionMs?: number;
  consentTtlMs?: number;
  futureClockSkewMs?: number;
}

export interface GatewayEventRecord {
  event_id: string;
  evidence_id: string;
  device_id: string;
  user_id?: string;
  event: string;
  source: EvidenceSource;
  modality: InputModality;
  observed_at: string;
  received_at: string;
  expires_at: string;
  priority: EventPriority;
  summary: string;
  confidence: number;
  media_ref?: string;
  payload?: Record<string, unknown>;
  consent_scope?: ConsentScope;
}

export interface ConsentTokenRecord {
  token: string;
  device_id: string;
  user_id?: string;
  scope: ConsentScope;
  evidence_id: string;
  granted_at: string;
  expires_at: string;
}

interface StoredConsentToken extends ConsentTokenRecord {
  revoked_at?: string;
  revoke_reason?: "stop" | "reject";
}

interface StoredKeyframe {
  device_id: string;
  evidence_id: string;
  expires_at: string;
  image: ImageObservation;
}

export interface IngestedEvent {
  accepted: true;
  event_id: string;
  evidence_id: string;
  expires_at: string;
  priority: EventPriority;
  consent?: ConsentTokenRecord;
}

export interface RejectedEvent {
  accepted: false;
  reason_code: GatewayReasonCode;
}

export type IngestEventResult = IngestedEvent | RejectedEvent;

export interface CurrentContextResult {
  context: MultimodalContext;
  active_consents: ConsentTokenRecord[];
  context_generated: true;
}

export interface CurrentContextOptions {
  windowMs?: number;
  now?: Date;
}

export interface RecentEventOptions {
  since?: string;
  limit?: number;
  now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizePayloadValue(value: unknown, depth: number): unknown {
  if (depth > 4) {
    throw new EventContextGatewayError("invalid_payload");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string" && value.startsWith("data:image/")) {
      throw new EventContextGatewayError("raw_media_not_allowed");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) {
      throw new EventContextGatewayError("invalid_payload");
    }
    return value.map((item) => sanitizePayloadValue(item, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 64) {
      throw new EventContextGatewayError("invalid_payload");
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      if (RAW_MEDIA_KEY.test(key)) {
        throw new EventContextGatewayError("raw_media_not_allowed");
      }
      if (item !== undefined) {
        sanitized[key] = sanitizePayloadValue(item, depth + 1);
      }
    }
    return sanitized;
  }
  throw new EventContextGatewayError("invalid_payload");
}

function sanitizePayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (payload === undefined) {
    return undefined;
  }
  return sanitizePayloadValue(payload, 0) as Record<string, unknown>;
}

function stringField(
  payload: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function numberField(
  payload: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanField(
  payload: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function modalityFromEvent(
  event: DeviceEvent,
  payload: Record<string, unknown> | undefined,
): InputModality | undefined {
  const declared = stringField(payload, "modality");
  const inferred: InputModality | undefined = (() => {
    switch (event.source) {
    case "t5_microphone":
      return event.event.includes("prosody") ? "speech_prosody" : "speech_text";
    case "web_text":
      return "speech_text";
    case "t5_camera":
    case "esp32_cam":
      return "vision";
    case "t5_button":
    case "apds9960":
      return "gesture";
    case "hc_sr04":
      return "distance";
    case "bno055":
    case "grove_imu":
      return "pose";
    case undefined:
      return undefined;
    }
  })();
  if (
    inferred === undefined ||
    (declared !== undefined && declared !== inferred)
  ) {
    return undefined;
  }
  return inferred;
}

function priorityOf(
  eventName: string,
  payload: Record<string, unknown> | undefined,
): EventPriority {
  const gesture = stringField(payload, "gesture");
  const feedback = stringField(payload, "feedback");
  if (
    STOP_EVENTS.has(eventName) ||
    gesture === "stop" ||
    feedback === "stop" ||
    booleanField(payload, "stop") === true
  ) {
    return "stop";
  }
  if (
    REJECT_EVENTS.has(eventName) ||
    gesture === "reject" ||
    feedback === "reject" ||
    booleanField(payload, "rejected") === true
  ) {
    return "reject";
  }
  if (CONSENT_EVENTS.has(eventName) || booleanField(payload, "explicit") === true) {
    return "explicit";
  }
  return "normal";
}

function consentScopeOf(
  event: DeviceEvent,
  payload: Record<string, unknown> | undefined,
): ConsentScope | undefined {
  let scope: ConsentScope | undefined;
  if (event.event === "approach_consent_granted") {
    scope = "approach_short";
  } else if (event.event === "hug_consent_granted") {
    scope = "invite_hug";
  } else {
    const declared = stringField(payload, "consent_scope");
    if (declared === "approach_short" || declared === "invite_hug") {
      scope = declared;
    }
  }
  if (!scope || !CONSENT_EVENTS.has(event.event)) {
    return undefined;
  }

  // Only a trusted explicit language/text event or an APDS9960 confirmation
  // gesture may mint consent. Vision, distance, pose and history never can.
  if (event.source === "t5_microphone" || event.source === "web_text") {
    return booleanField(payload, "explicit") === true ? scope : undefined;
  }
  if (event.source === "apds9960") {
    const gesture = stringField(payload, "gesture");
    return event.event === "gesture_confirm" || gesture === "confirm"
      ? scope
      : undefined;
  }
  if (event.source === "t5_button") {
    return booleanField(payload, "explicit") === true ? scope : undefined;
  }
  return undefined;
}

function eventSummary(
  event: DeviceEvent,
  payload: Record<string, unknown> | undefined,
): string {
  const supplied = stringField(payload, "summary");
  if (supplied) {
    return supplied.slice(0, 500);
  }
  return `${event.event} observed by ${event.source ?? "unknown_source"}`;
}

function priorityRank(priority: EventPriority): number {
  switch (priority) {
    case "stop":
      return 0;
    case "reject":
      return 1;
    case "explicit":
      return 2;
    case "normal":
      return 3;
  }
}

function toEvidence(record: GatewayEventRecord): ModalityEvidence {
  return {
    evidence_id: record.evidence_id,
    modality: record.modality,
    source: record.source,
    observed_at: record.observed_at,
    expires_at: record.expires_at,
    confidence: record.confidence,
    summary: record.summary,
    ...(record.media_ref === undefined ? {} : { media_ref: record.media_ref }),
  };
}

function cloneEvent(record: GatewayEventRecord): GatewayEventRecord {
  return structuredClone(record);
}

function cloneConsent(record: ConsentTokenRecord): ConsentTokenRecord {
  return { ...record };
}

export class EventContextGateway {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly defaultWindowMs: number;
  private readonly retentionMs: number;
  private readonly consentTtlMs: number;
  private readonly futureClockSkewMs: number;
  private readonly events: GatewayEventRecord[] = [];
  private readonly deviceContexts = new Map<string, DeviceContext>();
  private readonly consentTokens = new Map<string, StoredConsentToken>();
  private readonly keyframes = new Map<string, StoredKeyframe>();

  constructor(options: EventContextGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.defaultWindowMs = options.defaultWindowMs ?? DEFAULT_WINDOW_MS;
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.consentTtlMs = options.consentTtlMs ?? DEFAULT_CONSENT_TTL_MS;
    this.futureClockSkewMs = options.futureClockSkewMs ?? 1_000;
    this.assertWindow(this.defaultWindowMs);
    if (
      !Number.isSafeInteger(this.retentionMs) ||
      this.retentionMs < MAX_GATEWAY_WINDOW_MS ||
      !Number.isSafeInteger(this.consentTtlMs) ||
      this.consentTtlMs < 1_000 ||
      this.consentTtlMs > MAX_GATEWAY_WINDOW_MS
    ) {
      throw new EventContextGatewayError("invalid_window");
    }
  }

  ingestEvent(input: unknown): IngestEventResult {
    const parsed = deviceEventSchema.safeParse(input);
    if (!parsed.success) {
      return { accepted: false, reason_code: "invalid_event" };
    }
    const event = parsed.data;
    if (!event.source) {
      return { accepted: false, reason_code: "missing_source" };
    }

    let payload: Record<string, unknown> | undefined;
    try {
      payload = sanitizePayload(event.payload);
    } catch (error) {
      if (error instanceof EventContextGatewayError) {
        return { accepted: false, reason_code: error.code };
      }
      return { accepted: false, reason_code: "invalid_payload" };
    }

    const modality = modalityFromEvent(event, payload);
    if (!modality) {
      return { accepted: false, reason_code: "missing_source" };
    }
    if (event.source === "hc_sr04") {
      const distance = numberField(payload, "distance_cm");
      const valid = booleanField(payload, "valid");
      if (distance === undefined || distance < 0 || distance > 1_000 || valid === undefined) {
        return { accepted: false, reason_code: "invalid_payload" };
      }
      if (!valid) {
        return { accepted: false, reason_code: "invalid_sensor_reading" };
      }
    }
    const receivedAt = this.now();
    const observedMs = Date.parse(event.occurred_at);
    if (observedMs > receivedAt.getTime() + this.futureClockSkewMs) {
      return { accepted: false, reason_code: "future_event" };
    }
    if (observedMs < receivedAt.getTime() - this.retentionMs) {
      return { accepted: false, reason_code: "stale_event" };
    }

    this.cleanup(receivedAt);
    const priority = priorityOf(event.event, payload);
    const ttlRequested = numberField(payload, "ttl_ms");
    const ttlCap =
      priority === "stop" || priority === "reject"
        ? MAX_GATEWAY_WINDOW_MS
        : MODALITY_TTL_CAP_MS[modality];
    const ttlMs =
      ttlRequested === undefined
        ? ttlCap
        : Math.max(100, Math.min(ttlCap, Math.trunc(ttlRequested)));
    const confidenceRequested = numberField(payload, "confidence");
    const confidence =
      confidenceRequested === undefined
        ? 1
        : Math.max(0, Math.min(1, confidenceRequested));
    const consentScope = consentScopeOf(event, payload);
    const mediaRef = stringField(payload, "media_ref");
    const evidenceId = `ev_${this.idFactory()}`;
    const record: GatewayEventRecord = {
      event_id: `evt_${this.idFactory()}`,
      evidence_id: evidenceId,
      device_id: event.device_id,
      ...(event.user_id === undefined ? {} : { user_id: event.user_id }),
      event: event.event,
      source: event.source,
      modality,
      observed_at: event.occurred_at,
      received_at: receivedAt.toISOString(),
      expires_at: new Date(observedMs + ttlMs).toISOString(),
      priority,
      summary: eventSummary(event, payload),
      confidence,
      ...(mediaRef === undefined ? {} : { media_ref: mediaRef }),
      ...(payload === undefined ? {} : { payload }),
      ...(consentScope === undefined ? {} : { consent_scope: consentScope }),
    };
    this.events.push(record);
    this.updateDeviceContextFromEvent(record);

    if (priority === "stop" || priority === "reject") {
      this.revokeConsentFor(
        event.device_id,
        event.user_id,
        priority,
        receivedAt,
      );
    }

    const consent =
      consentScope &&
      event.user_id !== undefined &&
      Date.parse(record.expires_at) > receivedAt.getTime()
      ? this.issueConsent(record, consentScope, receivedAt)
      : undefined;
    return {
      accepted: true,
      event_id: record.event_id,
      evidence_id: record.evidence_id,
      expires_at: record.expires_at,
      priority,
      ...(consent === undefined ? {} : { consent }),
    };
  }

  updateDeviceContext(context: DeviceContext): DeviceContext {
    const parsed = deviceContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new EventContextGatewayError("invalid_payload");
    }
    this.deviceContexts.set(parsed.data.device_id, structuredClone(parsed.data));
    return structuredClone(parsed.data);
  }

  getDeviceContext(deviceId: string): DeviceContext | undefined {
    const current = this.deviceContexts.get(deviceId);
    return current ? structuredClone(current) : undefined;
  }

  getCurrentContext(
    deviceId: string,
    options: CurrentContextOptions = {},
  ): CurrentContextResult {
    const now = options.now ?? this.now();
    const windowMs = options.windowMs ?? this.defaultWindowMs;
    this.assertWindow(windowMs);
    this.cleanup(now);
    const windowStartMs = now.getTime() - windowMs;
    const records = this.events
      .filter((record) => {
        const observedMs = Date.parse(record.observed_at);
        return (
          record.device_id === deviceId &&
          observedMs >= windowStartMs &&
          observedMs <= now.getTime() + this.futureClockSkewMs &&
          Date.parse(record.expires_at) > now.getTime()
        );
      })
      .sort((left, right) => {
        const priorityDelta = priorityRank(left.priority) - priorityRank(right.priority);
        return priorityDelta !== 0
          ? priorityDelta
          : Date.parse(right.observed_at) - Date.parse(left.observed_at);
      });
    const available = new Set(records.map((record) => record.modality));
    const hasPositiveConsent = records.some(
      (record) => record.consent_scope !== undefined,
    );
    const hasRejectOrStop = records.some(
      (record) => record.priority === "reject" || record.priority === "stop",
    );
    const transcriptRecord = records
      .filter((record) => record.modality === "speech_text")
      .sort(
        (left, right) =>
          Date.parse(right.observed_at) - Date.parse(left.observed_at),
      )[0];
    const transcript =
      stringField(transcriptRecord?.payload, "transcript") ??
      stringField(transcriptRecord?.payload, "text");
    const deviceContext = this.getDeviceContext(deviceId);
    const currentEvidenceIds = new Set(records.map((record) => record.evidence_id));
    const imageObservations = [...this.keyframes.values()]
      .filter(
        (keyframe) =>
          keyframe.device_id === deviceId &&
          currentEvidenceIds.has(keyframe.evidence_id) &&
          Date.parse(keyframe.expires_at) > now.getTime(),
      )
      .sort(
        (left, right) =>
          Date.parse(left.image.observed_at) - Date.parse(right.image.observed_at),
      )
      .slice(-4)
      .map((keyframe) => structuredClone(keyframe.image));
    const context: MultimodalContext = {
      context_id: `ctx_${this.idFactory()}`,
      window_started_at: new Date(windowStartMs).toISOString(),
      window_ended_at: now.toISOString(),
      evidence: records.map(toEvidence),
      unavailable_modalities: INPUT_MODALITIES.filter(
        (modality) => !available.has(modality),
      ),
      has_conflict: hasPositiveConsent && hasRejectOrStop,
      ...(transcript === undefined ? {} : { transcript }),
      ...(imageObservations.length === 0
        ? {}
        : { image_observations: imageObservations }),
      ...(deviceContext === undefined
        ? {}
        : { local_sensor_context: deviceContext }),
    };
    return {
      context,
      active_consents: this.getActiveConsents(deviceId, undefined, now),
      context_generated: true,
    };
  }

  getRecentEvents(
    deviceId: string,
    options: RecentEventOptions = {},
  ): GatewayEventRecord[] {
    const now = options.now ?? this.now();
    this.cleanup(now);
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new EventContextGatewayError("invalid_payload");
    }
    const sinceMs = options.since
      ? Date.parse(options.since)
      : now.getTime() - this.retentionMs;
    if (!Number.isFinite(sinceMs)) {
      throw new EventContextGatewayError("invalid_payload");
    }
    return this.events
      .filter(
        (record) =>
          record.device_id === deviceId &&
          Date.parse(record.observed_at) >= sinceMs,
      )
      .sort(
        (left, right) =>
          Date.parse(right.observed_at) - Date.parse(left.observed_at),
      )
      .slice(0, limit)
      .map(cloneEvent);
  }

  registerKeyframe(
    deviceId: string,
    evidenceId: string,
    image: ImageObservation,
    now: Date = this.now(),
  ): void {
    validateTriggeredImage(image);
    this.cleanup(now);
    const evidence = this.events.find(
      (record) =>
        record.device_id === deviceId && record.evidence_id === evidenceId,
    );
    if (!evidence) {
      throw new EventContextGatewayError("evidence_not_found");
    }
    if (Date.parse(evidence.expires_at) <= now.getTime()) {
      throw new EventContextGatewayError("expired_evidence");
    }
    if (
      evidence.modality !== "vision" ||
      evidence.source !== image.source ||
      evidence.media_ref !== image.capture_id ||
      Math.abs(
        Date.parse(evidence.observed_at) - Date.parse(image.observed_at),
      ) > 1_500
    ) {
      throw new EventContextGatewayError("keyframe_mismatch");
    }
    this.keyframes.set(image.capture_id, {
      device_id: deviceId,
      evidence_id: evidenceId,
      expires_at: evidence.expires_at,
      image: structuredClone(image),
    });
  }

  getKeyframe(
    deviceId: string,
    captureId?: string,
    now: Date = this.now(),
  ): { evidence_id: string; expires_at: string; image: ImageObservation } | undefined {
    this.cleanup(now);
    const candidates = [...this.keyframes.values()]
      .filter(
        (item) =>
          item.device_id === deviceId &&
          (captureId === undefined || item.image.capture_id === captureId),
      )
      .sort(
        (left, right) =>
          Date.parse(right.image.observed_at) -
          Date.parse(left.image.observed_at),
      );
    const keyframe = candidates[0];
    return keyframe
      ? {
          evidence_id: keyframe.evidence_id,
          expires_at: keyframe.expires_at,
          image: structuredClone(keyframe.image),
        }
      : undefined;
  }

  getActiveConsents(
    deviceId: string,
    userId?: string,
    now: Date = this.now(),
  ): ConsentTokenRecord[] {
    this.cleanup(now);
    return [...this.consentTokens.values()]
      .filter(
        (record) =>
          record.device_id === deviceId &&
          record.revoked_at === undefined &&
          Date.parse(record.expires_at) > now.getTime() &&
          (userId === undefined ||
            record.user_id === undefined ||
            record.user_id === userId),
      )
      .map(cloneConsent);
  }

  validateConsentToken(
    token: string,
    deviceId: string,
    scope: ConsentScope,
    userId?: string,
    now: Date = this.now(),
  ): ConsentTokenRecord | undefined {
    const record = this.consentTokens.get(token);
    if (
      !record ||
      record.revoked_at !== undefined ||
      record.device_id !== deviceId ||
      record.scope !== scope ||
      Date.parse(record.expires_at) <= now.getTime() ||
      (userId !== undefined &&
        record.user_id !== undefined &&
        record.user_id !== userId)
    ) {
      return undefined;
    }
    return cloneConsent(record);
  }

  private assertWindow(windowMs: number): void {
    if (
      !Number.isSafeInteger(windowMs) ||
      windowMs < MIN_GATEWAY_WINDOW_MS ||
      windowMs > MAX_GATEWAY_WINDOW_MS
    ) {
      throw new EventContextGatewayError("invalid_window");
    }
  }

  private issueConsent(
    event: GatewayEventRecord,
    scope: ConsentScope,
    now: Date,
  ): ConsentTokenRecord {
    const token = `consent_${this.idFactory()}`;
    const expiresAt = new Date(
      Math.min(
        Date.parse(event.expires_at),
        now.getTime() + this.consentTtlMs,
      ),
    ).toISOString();
    const record: StoredConsentToken = {
      token,
      device_id: event.device_id,
      ...(event.user_id === undefined ? {} : { user_id: event.user_id }),
      scope,
      evidence_id: event.evidence_id,
      granted_at: now.toISOString(),
      expires_at: expiresAt,
    };
    this.consentTokens.set(token, record);
    return cloneConsent(record);
  }

  private revokeConsentFor(
    deviceId: string,
    userId: string | undefined,
    reason: "stop" | "reject",
    now: Date,
  ): void {
    for (const record of this.consentTokens.values()) {
      if (
        record.device_id === deviceId &&
        (userId === undefined ||
          record.user_id === undefined ||
          record.user_id === userId)
      ) {
        record.revoked_at = now.toISOString();
        record.revoke_reason = reason;
      }
    }
  }

  private updateDeviceContextFromEvent(record: GatewayEventRecord): void {
    const payloadContext = record.payload?.["device_context"];
    if (payloadContext !== undefined) {
      const parsed = deviceContextSchema.safeParse(payloadContext);
      if (parsed.success && parsed.data.device_id === record.device_id) {
        this.deviceContexts.set(record.device_id, structuredClone(parsed.data));
      }
      return;
    }

    const current = this.deviceContexts.get(record.device_id);
    if (!current) {
      return;
    }
    const next: DeviceContext = {
      ...current,
      observed_at: record.observed_at,
    };
    if (record.modality === "distance") {
      const distance = numberField(record.payload, "distance_cm");
      const valid = booleanField(record.payload, "valid");
      if (distance !== undefined && distance >= 0 && distance <= 1_000) {
        next.distance_cm = distance;
        next.distance_source = "hc_sr04";
        next.distance_observed_at = record.observed_at;
      }
      if (valid !== undefined) {
        next.distance_valid = valid;
      }
    } else if (record.modality === "gesture") {
      const gesture = stringField(record.payload, "gesture");
      if (
        gesture === "confirm" ||
        gesture === "reject" ||
        gesture === "stop" ||
        gesture === "unknown"
      ) {
        next.gesture = gesture;
      }
    } else if (record.modality === "pose") {
      const pose = stringField(record.payload, "pose");
      if (
        pose === "upright" ||
        pose === "held" ||
        pose === "tilted" ||
        pose === "fallen" ||
        pose === "unknown"
      ) {
        next.pose = pose;
      }
    }
    this.deviceContexts.set(record.device_id, next);
  }

  private cleanup(now: Date): void {
    const cutoff = now.getTime() - this.retentionMs;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index];
      if (event && Date.parse(event.observed_at) < cutoff) {
        this.events.splice(index, 1);
      }
    }
    for (const [token, consent] of this.consentTokens) {
      if (Date.parse(consent.expires_at) <= now.getTime()) {
        this.consentTokens.delete(token);
      }
    }
    for (const [captureId, keyframe] of this.keyframes) {
      if (Date.parse(keyframe.expires_at) <= now.getTime()) {
        this.keyframes.delete(captureId);
      }
    }
  }
}
