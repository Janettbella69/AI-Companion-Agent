import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import type { ImageObservation } from "../domain/contracts.js";

const MAX_JPEG_BYTES = 512 * 1024;
const MAX_CLOCK_SKEW_MS = 5_000;
const CAPTURE_TTL_MS = 5_000;

export const cameraTriggerReasonSchema = z.enum([
  "presence_event",
  "user_request",
  "diagnostic",
]);

type CameraTriggerReason = z.infer<typeof cameraTriggerReasonSchema>;

interface FetchHeaders {
  get(name: string): string | null;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: FetchHeaders;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchImplementation = (
  url: URL,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface LanCameraAdapterOptions {
  baseUrl: string;
  sharedSecret: string;
  timeoutMs?: number;
  now?: () => Date;
  idFactory?: () => string;
  fetchImpl?: FetchImplementation;
}

export type LanCameraCaptureResult =
  | {
      status: "completed";
      reason_code: "camera_capture_completed";
      capture_id: string;
      observed_at: string;
      image: ImageObservation;
    }
  | {
      status: "failed" | "rejected";
      reason_code: string;
    };

function isPrivateLanHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host.endsWith(".local")) return true;
  const family = isIP(host);
  if (family === 4) {
    if (/^10\./u.test(host) || /^192\.168\./u.test(host)) return true;
    const match = /^172\.(\d{1,2})\./u.exec(host);
    if (match?.[1]) {
      const second = Number(match[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return /^169\.254\./u.test(host);
  }
  if (family !== 6) return false;
  if (host === "::1") return true;
  const first = Number.parseInt(host.split(":", 1)[0] ?? "", 16);
  return (
    (first >= 0xfc00 && first <= 0xfdff) ||
    (first >= 0xfe80 && first <= 0xfebf)
  );
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !isPrivateLanHostname(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("HSHH_CAMERA_URL must be a private-LAN HTTP(S) origin");
  }
  url.pathname = "/";
  return url;
}

function signature(
  secret: string,
  timestamp: string,
  body: string | Uint8Array,
): string {
  return createHmac("sha256", secret)
    .update(timestamp)
    .update("\n")
    .update(body)
    .digest("hex");
}

function equalHexSignature(actual: string | null, expected: string): boolean {
  if (actual === null || !/^[a-f0-9]{64}$/u.test(actual)) return false;
  const actualBytes = Buffer.from(actual, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function isJpeg(bytes: Buffer): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[bytes.byteLength - 2] === 0xff &&
    bytes[bytes.byteLength - 1] === 0xd9
  );
}

/** Signed, event-triggered still-image transport for the ESP32-CAM. */
export class LanCameraAdapter {
  private readonly captureUrl: URL;
  private readonly sharedSecret: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: LanCameraAdapterOptions) {
    this.captureUrl = new URL(
      "/v1/camera/captures",
      normalizeBaseUrl(options.baseUrl),
    );
    this.sharedSecret = options.sharedSecret.trim();
    if (this.sharedSecret.length < 32 || this.sharedSecret.length > 512) {
      throw new Error(
        "HSHH_CAMERA_SHARED_SECRET must contain between 32 and 512 characters",
      );
    }
    this.timeoutMs = options.timeoutMs ?? 1_500;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 5_000
    ) {
      throw new Error("HSHH_CAMERA_TIMEOUT_MS must be between 100 and 5000");
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.fetchImpl = options.fetchImpl ?? (fetch as FetchImplementation);
  }

  async capture(
    robotId: string,
    reason: CameraTriggerReason,
  ): Promise<LanCameraCaptureResult> {
    const triggerReason = cameraTriggerReasonSchema.parse(reason);
    const issuedAt = this.now();
    const captureId = `capture_${this.idFactory()}`;
    const payload = {
      capture_id: captureId,
      robot_id: robotId,
      issued_at: issuedAt.toISOString(),
      expires_at: new Date(issuedAt.getTime() + CAPTURE_TTL_MS).toISOString(),
      trigger_reason: triggerReason,
    };
    const body = JSON.stringify(payload);
    const timestamp = issuedAt.toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: FetchResponse;
    try {
      response = await this.fetchImpl(this.captureUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "image/jpeg",
          "idempotency-key": captureId,
          "x-hshh-timestamp": timestamp,
          "x-hshh-signature": signature(this.sharedSecret, timestamp, body),
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      return {
        status: "failed",
        reason_code:
          error instanceof Error && error.name === "AbortError"
            ? "camera_transport_timeout"
            : "camera_transport_unavailable",
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        status: response.status === 409 || response.status === 429
          ? "rejected"
          : "failed",
        reason_code: `camera_http_${Math.max(0, Math.min(999, response.status))}`,
      };
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      !contentType?.startsWith("image/jpeg") ||
      (Number.isFinite(declaredLength) && declaredLength > MAX_JPEG_BYTES)
    ) {
      return { status: "failed", reason_code: "camera_response_invalid" };
    }

    let bytes: Buffer;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch {
      return { status: "failed", reason_code: "camera_response_unreadable" };
    }
    if (bytes.byteLength > MAX_JPEG_BYTES || !isJpeg(bytes)) {
      bytes.fill(0);
      return { status: "failed", reason_code: "camera_jpeg_invalid" };
    }

    const responseTimestamp = response.headers.get("x-hshh-timestamp");
    const observedAt = response.headers.get("x-hshh-observed-at");
    const responseTimestampMs = Date.parse(responseTimestamp ?? "");
    const observedAtMs = Date.parse(observedAt ?? "");
    const captureHeader = response.headers.get("x-hshh-capture-id");
    if (
      responseTimestamp === null ||
      observedAt === null ||
      captureHeader !== captureId ||
      !Number.isFinite(responseTimestampMs) ||
      !Number.isFinite(observedAtMs) ||
      Math.abs(this.now().getTime() - responseTimestampMs) > MAX_CLOCK_SKEW_MS ||
      Math.abs(observedAtMs - responseTimestampMs) > MAX_CLOCK_SKEW_MS ||
      !equalHexSignature(
        response.headers.get("x-hshh-signature"),
        signature(this.sharedSecret, responseTimestamp, bytes),
      )
    ) {
      bytes.fill(0);
      return { status: "failed", reason_code: "camera_response_auth_failed" };
    }

    const base64 = bytes.toString("base64");
    bytes.fill(0);
    return {
      status: "completed",
      reason_code: "camera_capture_completed",
      capture_id: captureId,
      observed_at: observedAt,
      image: {
        capture_id: captureId,
        observed_at: observedAt,
        mime: "image/jpeg",
        source: "esp32_cam",
        base64,
      },
    };
  }
}
