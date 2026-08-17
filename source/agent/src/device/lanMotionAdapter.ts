import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import type {
  HshhDeviceDispatchResult,
  HshhDeviceEffect,
} from "../mcp/deviceServer.js";
import { verifiedVisionGuidanceSchema } from "../domain/contracts.js";

export const HSHH_LAN_PROTOCOL_VERSION = "hshh-lan-v1" as const;

const MAX_RESPONSE_BYTES = 8_192;
const MAX_RESPONSE_CLOCK_SKEW_MS = 5_000;

const lanMotionCommandSchema = z
  .object({
    protocol_version: z.literal(HSHH_LAN_PROTOCOL_VERSION),
    target: z.literal("motion_controller"),
    command_id: z.string().trim().min(1).max(128),
    robot_id: z.string().trim().min(1).max(128),
    skill: z.enum([
      "stop",
      "approach_short",
      "turn_to_user",
      "invite_hug",
      "release_hug",
    ]),
    issued_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    expected_device_state: z.enum(["ready", "stopped", "fault"]),
    vision_guidance: verifiedVisionGuidanceSchema.optional(),
  })
  .strict();

export const lanMotionResponseSchema = z
  .object({
    protocol_version: z.literal(HSHH_LAN_PROTOCOL_VERSION),
    command_id: z.string().trim().min(1).max(128),
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
    observed_at: z.string().datetime({ offset: true }),
    safety_state: z.enum(["ready", "stopped", "fault"]),
    active_skill: z
      .enum([
        "stop",
        "approach_short",
        "turn_to_user",
        "invite_hug",
        "release_hug",
      ])
      .nullable()
      .optional(),
  })
  .strict();

interface FetchHeaders {
  get(name: string): string | null;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  headers: FetchHeaders;
  text(): Promise<string>;
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

export interface LanMotionAdapterOptions {
  baseUrl: string;
  sharedSecret: string;
  timeoutMs?: number;
  now?: () => Date;
  fetchImpl?: FetchImplementation;
}

function isPrivateLanHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host.endsWith(".local")) return true;
  const addressFamily = isIP(host);
  if (addressFamily === 4) {
    if (/^10\./u.test(host) || /^192\.168\./u.test(host)) return true;
    const match = /^172\.(\d{1,2})\./u.exec(host);
    if (match?.[1] !== undefined) {
      const secondOctet = Number(match[1]);
      if (secondOctet >= 16 && secondOctet <= 31) return true;
    }
    return /^169\.254\./u.test(host);
  }
  if (addressFamily !== 6) return false;
  if (host === "::1") return true;

  const firstHextet = Number.parseInt(host.split(":", 1)[0] ?? "", 16);
  return (
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
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
    throw new Error(
      "HSHH_MOTION_CONTROLLER_URL must be a private-LAN HTTP(S) origin",
    );
  }
  url.pathname = "/";
  return url;
}

function signature(secret: string, timestamp: string, body: string): string {
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

function escapeSkill(skill: string): boolean {
  return skill === "stop" || skill === "release_hug";
}

/**
 * Authenticated LAN transport for the ESP32-S3 motion controller.
 *
 * Only policy-authored semantic SafeSkills cross this boundary. User identity,
 * consent tokens, prompts and raw GPIO/PWM/motor values are deliberately absent.
 */
export class LanMotionAdapter {
  private readonly commandUrl: URL;
  private readonly sharedSecret: string;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchImplementation;

  constructor(options: LanMotionAdapterOptions) {
    this.commandUrl = new URL(
      "/v1/motion/commands",
      normalizeBaseUrl(options.baseUrl),
    );
    this.sharedSecret = options.sharedSecret.trim();
    if (this.sharedSecret.length < 32 || this.sharedSecret.length > 512) {
      throw new Error(
        "HSHH_MOTION_SHARED_SECRET must contain between 32 and 512 characters",
      );
    }
    this.timeoutMs = options.timeoutMs ?? 400;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 50 ||
      this.timeoutMs > 2_000
    ) {
      throw new Error("HSHH_MOTION_TIMEOUT_MS must be between 50 and 2000");
    }
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? (fetch as FetchImplementation);
  }

  async dispatch(effect: HshhDeviceEffect): Promise<HshhDeviceDispatchResult> {
    if (effect.type !== "safe_skill") {
      return {
        status: "rejected",
        reason_code: "motion_adapter_effect_unsupported",
      };
    }
    if (effect.command.device_id !== effect.device_id) {
      return { status: "failed", reason_code: "motion_command_scope_invalid" };
    }

    const issuedAt = this.now();
    const expiresAt = Date.parse(effect.command.expires_at);
    if (!Number.isFinite(expiresAt)) {
      return { status: "failed", reason_code: "motion_command_expiry_invalid" };
    }
    if (expiresAt <= issuedAt.getTime() && !escapeSkill(effect.command.skill)) {
      return { status: "rejected", reason_code: "motion_command_expired" };
    }

    const guidance = effect.vision_guidance;
    if (guidance !== undefined) {
      const observedAt = Date.parse(guidance.observed_at);
      if (
        !Number.isFinite(observedAt) ||
        observedAt > issuedAt.getTime() + 1_000 ||
        issuedAt.getTime() - observedAt > 15_000
      ) {
        return { status: "rejected", reason_code: "vision_guidance_expired" };
      }
      const directionMatchesSkill =
        (effect.command.skill === "approach_short" &&
          guidance.direction === "center") ||
        (effect.command.skill === "turn_to_user" &&
          (guidance.direction === "left" || guidance.direction === "right"));
      if (!directionMatchesSkill) {
        return {
          status: "rejected",
          reason_code: "vision_guidance_skill_mismatch",
        };
      }
    }

    const payload = lanMotionCommandSchema.parse({
      protocol_version: HSHH_LAN_PROTOCOL_VERSION,
      target: "motion_controller",
      command_id: effect.command.request_id,
      robot_id: effect.device_id,
      skill: effect.command.skill,
      issued_at: issuedAt.toISOString(),
      expires_at: effect.command.expires_at,
      expected_device_state: effect.command.expected_device_state,
      ...(guidance === undefined ? {} : { vision_guidance: guidance }),
    });
    const body = JSON.stringify(payload);
    const timestamp = issuedAt.toISOString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: FetchResponse;
    try {
      response = await this.fetchImpl(this.commandUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": effect.command.request_id,
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
            ? "motion_transport_timeout"
            : "motion_transport_unavailable",
      };
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return {
        status: "failed",
        reason_code: `motion_http_${Math.max(0, Math.min(999, response.status))}`,
      };
    }

    let responseBody: string;
    try {
      responseBody = await response.text();
    } catch {
      return { status: "failed", reason_code: "motion_response_unreadable" };
    }
    if (Buffer.byteLength(responseBody) > MAX_RESPONSE_BYTES) {
      return { status: "failed", reason_code: "motion_response_too_large" };
    }
    const responseTimestamp = response.headers.get("x-hshh-timestamp");
    const responseTimestampMs = Date.parse(responseTimestamp ?? "");
    if (
      responseTimestamp === null ||
      !Number.isFinite(responseTimestampMs) ||
      Math.abs(issuedAt.getTime() - responseTimestampMs) >
        MAX_RESPONSE_CLOCK_SKEW_MS ||
      !equalHexSignature(
        response.headers.get("x-hshh-signature"),
        signature(this.sharedSecret, responseTimestamp, responseBody),
      )
    ) {
      return { status: "failed", reason_code: "motion_response_auth_failed" };
    }

    let parsed: z.infer<typeof lanMotionResponseSchema>;
    try {
      parsed = lanMotionResponseSchema.parse(JSON.parse(responseBody));
    } catch {
      return { status: "failed", reason_code: "motion_response_invalid" };
    }
    if (parsed.command_id !== effect.command.request_id) {
      return { status: "failed", reason_code: "motion_response_id_mismatch" };
    }
    return { status: parsed.status, reason_code: parsed.reason_code };
  }
}
