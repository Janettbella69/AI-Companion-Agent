import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  EXPRESSIONS,
  SAFE_SKILLS,
  deviceSafetyStateSchema,
  type Expression,
  type InteractionRequest,
  type VerifiedVisionGuidance,
} from "../domain/contracts.js";
import {
  evaluateSkillRequest,
  type EnrichedSafeSkillCommand,
} from "../policy/policyGate.js";
import { HshhDatabase } from "../store/database.js";
import {
  mcpResult,
  normalizeReasonCode,
  type HshhToolStatus,
} from "./result.js";

export const HSHH_SOUND_CUES = [
  "notice",
  "listening",
  "confirm",
  "success",
  "confused",
  "sleepy",
  "stop",
] as const;

export const HSHH_DEVICE_TOOL_NAMES = [
  "set_expression",
  "play_sound",
  "request_safe_skill",
  "get_skill_status",
  "stop",
] as const;

export const HSHH_DEVICE_ALLOWED_TOOLS = HSHH_DEVICE_TOOL_NAMES.map(
  (name) => `mcp__hshh_device__${name}` as const,
);

type SoundCue = (typeof HSHH_SOUND_CUES)[number];

interface SideEffectEnvelope {
  actor_user_id: string;
  device_id: string;
  request_id: string;
  expires_at: string;
  expected_device_state: "ready" | "stopped" | "fault";
  reason: string;
}

export type HshhDeviceEffect =
  | {
      type: "set_expression";
      request_id: string;
      actor_user_id: string;
      device_id: string;
      expression: Expression;
      intensity: number;
      duration_ms: number;
      reason: string;
    }
  | {
      type: "play_sound";
      request_id: string;
      actor_user_id: string;
      device_id: string;
      sound: SoundCue;
      reason: string;
    }
  | {
      type: "safe_skill";
      request_id: string;
      actor_user_id: string;
      device_id: string;
      command: EnrichedSafeSkillCommand;
      vision_guidance?: VerifiedVisionGuidance;
    };

export interface HshhDeviceDispatchResult {
  status: HshhToolStatus;
  reason_code: string;
}

export interface HshhDeviceMcpContext {
  request: InteractionRequest;
  requestId: string;
  database: HshhDatabase;
  now?: () => Date;
  dispatch?: (effect: HshhDeviceEffect) => Promise<HshhDeviceDispatchResult>;
  allowUnsensoredMotion?: boolean;
}

const sideEffectShape = {
  actor_user_id: z.string().trim().min(1).max(128),
  device_id: z.string().trim().min(1).max(128),
  request_id: z.string().trim().min(1).max(128),
  expires_at: z.string().datetime({ offset: true }),
  expected_device_state: deviceSafetyStateSchema,
  reason: z.string().trim().min(1).max(160),
};

const FORBIDDEN_HARDWARE_PARAMETER =
  /(?:^|_)(?:pwm|gpio|pin|motor|wheel|wheel_speed|servo|servo_angle|angle|speed|velocity|torque|voltage|current|duty|frequency|pulse|microseconds|rpm)(?:_|$)/i;
const MAX_EFFECT_TTL_MS = 300_000;

function forbiddenHardwareParameter(input: object): string | undefined {
  return Object.keys(input).find((key) => FORBIDDEN_HARDWARE_PARAMETER.test(key));
}

function scopedUserId(context: HshhDeviceMcpContext): string | undefined {
  return context.request.device_context.user_id;
}

function scopeReason(
  context: HshhDeviceMcpContext,
  actorUserId: string,
  deviceId: string,
): string | undefined {
  const expectedUserId = scopedUserId(context);
  if (expectedUserId === undefined) return "user_scope_unbound";
  if (actorUserId !== expectedUserId) return "user_scope_mismatch";
  if (deviceId !== context.request.device_context.device_id) {
    return "device_scope_mismatch";
  }
  return undefined;
}

function currentDeviceContext(context: HshhDeviceMcpContext) {
  return (
    context.database.getDeviceContext(context.request.device_context.device_id) ??
    context.request.device_context
  );
}

function envelopeReason(
  context: HshhDeviceMcpContext,
  input: SideEffectEnvelope,
  now: Date,
): string | undefined {
  if (input.request_id !== context.requestId) return "turn_request_mismatch";
  const scopeFailure = scopeReason(
    context,
    input.actor_user_id,
    input.device_id,
  );
  if (scopeFailure !== undefined) return scopeFailure;

  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(expiresAt)) return "request_expiry_invalid";
  if (expiresAt <= now.getTime()) return "request_expired";
  if (expiresAt - now.getTime() > MAX_EFFECT_TTL_MS) {
    return "request_expiry_too_long";
  }
  if (input.expected_device_state !== currentDeviceContext(context).safety_state) {
    return "expected_device_state_mismatch";
  }
  return undefined;
}

function replayDeviceResult(
  context: HshhDeviceMcpContext,
  toolName: (typeof HSHH_DEVICE_TOOL_NAMES)[number],
  requestId: string,
) {
  const userId = scopedUserId(context);
  const prior = context.database.listInteractionEvents({
    ...(userId === undefined ? {} : { user_id: userId }),
    device_id: context.request.device_context.device_id,
    event_type: `mcp_device_${toolName}`,
    request_id: requestId,
    limit: 1,
  })[0];
  if (prior === undefined) return undefined;
  const status = prior.payload?.["status"];
  const reasonCode = prior.payload?.["reason_code"];
  if (
    (status !== "accepted" &&
      status !== "rejected" &&
      status !== "completed" &&
      status !== "stopped" &&
      status !== "failed") ||
    typeof reasonCode !== "string"
  ) {
    return mcpResult("failed", "idempotency_record_invalid", {
      request_id: requestId,
    });
  }
  return mcpResult(status, reasonCode, {
    request_id: requestId,
    replayed: true,
  });
}

function writeDeviceAudit(
  context: HshhDeviceMcpContext,
  toolName: (typeof HSHH_DEVICE_TOOL_NAMES)[number],
  requestId: string,
  status: HshhToolStatus,
  reasonCode: string,
  detail: Record<string, unknown> = {},
): boolean {
  const userId = scopedUserId(context);
  try {
    context.database.recordInteractionEvent({
      event_type: `mcp_device_${toolName}`,
      occurred_at: (context.now ?? (() => new Date()))().toISOString(),
      ...(userId === undefined ? {} : { user_id: userId }),
      device_id: context.request.device_context.device_id,
      request_id: requestId,
      payload: {
        tool_name: toolName,
        status,
        reason_code: normalizeReasonCode(reasonCode),
        ...detail,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function dispatch(
  context: HshhDeviceMcpContext,
  effect: HshhDeviceEffect,
): Promise<HshhDeviceDispatchResult> {
  if (context.dispatch === undefined) {
    return { status: "rejected", reason_code: "device_adapter_unavailable" };
  }
  return context.dispatch(effect);
}

async function deliverEffect(
  context: HshhDeviceMcpContext,
  toolName: (typeof HSHH_DEVICE_TOOL_NAMES)[number],
  requestId: string,
  effect: HshhDeviceEffect,
  payload: Record<string, unknown>,
) {
  try {
    const delivered = await dispatch(context, effect);
    if (
      !writeDeviceAudit(
        context,
        toolName,
        requestId,
        delivered.status,
        delivered.reason_code,
        payload,
      )
    ) {
      return mcpResult("failed", "audit_write_failed", { request_id: requestId });
    }
    return mcpResult(delivered.status, delivered.reason_code, {
      request_id: requestId,
      ...payload,
    });
  } catch {
    writeDeviceAudit(
      context,
      toolName,
      requestId,
      "failed",
      "device_dispatch_failed",
      payload,
    );
    return mcpResult("failed", "device_dispatch_failed", {
      request_id: requestId,
    });
  }
}

function rejectAudited(
  context: HshhDeviceMcpContext,
  toolName: (typeof HSHH_DEVICE_TOOL_NAMES)[number],
  requestId: string,
  reasonCode: string,
) {
  writeDeviceAudit(context, toolName, requestId, "rejected", reasonCode);
  return mcpResult("rejected", reasonCode, { request_id: requestId });
}

export function createHshhDeviceTools(
  context: HshhDeviceMcpContext,
): Array<SdkMcpToolDefinition<any>> {
  const now = context.now ?? (() => new Date());

  const setExpression = tool(
    "set_expression",
    "Set a registered robot expression intent. Accepts no GPIO, PWM, servo, motor, or display-driver parameters.",
    {
      ...sideEffectShape,
      expression: z.enum(EXPRESSIONS),
      intensity: z.number().min(0).max(1),
      duration_ms: z.number().int().min(100).max(30_000),
    },
    async (input) => {
      const forbidden = forbiddenHardwareParameter(input);
      if (forbidden !== undefined) {
        return rejectAudited(
          context,
          "set_expression",
          input.request_id,
          "raw_hardware_parameters_forbidden",
        );
      }
      const scopeFailure = scopeReason(
        context,
        input.actor_user_id,
        input.device_id,
      );
      if (scopeFailure !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "set_expression",
          input.request_id,
          scopeFailure ?? "turn_request_mismatch",
        );
      }
      const replayed = replayDeviceResult(
        context,
        "set_expression",
        input.request_id,
      );
      if (replayed !== undefined) return replayed;
      const rejected = envelopeReason(context, input, now());
      if (rejected !== undefined) {
        return rejectAudited(context, "set_expression", input.request_id, rejected);
      }
      return deliverEffect(
        context,
        "set_expression",
        input.request_id,
        {
          type: "set_expression",
          request_id: input.request_id,
          actor_user_id: input.actor_user_id,
          device_id: input.device_id,
          expression: input.expression,
          intensity: input.intensity,
          duration_ms: input.duration_ms,
          reason: input.reason,
        },
        {
          expression: input.expression,
          intensity: input.intensity,
          duration_ms: input.duration_ms,
        },
      );
    },
    {
      annotations: {
        title: "Set robot expression",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const playSound = tool(
    "play_sound",
    "Play one whitelisted semantic sound cue. Does not accept waveforms, frequencies, volume registers, or hardware parameters.",
    {
      ...sideEffectShape,
      sound: z.enum(HSHH_SOUND_CUES),
    },
    async (input) => {
      const forbidden = forbiddenHardwareParameter(input);
      if (forbidden !== undefined) {
        return rejectAudited(
          context,
          "play_sound",
          input.request_id,
          "raw_hardware_parameters_forbidden",
        );
      }
      const scopeFailure = scopeReason(
        context,
        input.actor_user_id,
        input.device_id,
      );
      if (scopeFailure !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "play_sound",
          input.request_id,
          scopeFailure ?? "turn_request_mismatch",
        );
      }
      const replayed = replayDeviceResult(context, "play_sound", input.request_id);
      if (replayed !== undefined) return replayed;
      const rejected = envelopeReason(context, input, now());
      if (rejected !== undefined) {
        return rejectAudited(context, "play_sound", input.request_id, rejected);
      }
      return deliverEffect(
        context,
        "play_sound",
        input.request_id,
        {
          type: "play_sound",
          request_id: input.request_id,
          actor_user_id: input.actor_user_id,
          device_id: input.device_id,
          sound: input.sound,
          reason: input.reason,
        },
        { sound: input.sound },
      );
    },
    {
      annotations: {
        title: "Play robot sound cue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const requestSafeSkill = tool(
    "request_safe_skill",
    "Request one abstract safe skill through the policy gate. Never accepts PWM, speed, wheel, motor, GPIO, or servo parameters. Visual evidence never grants consent.",
    {
      ...sideEffectShape,
      skill: z.enum(SAFE_SKILLS),
      consent_token: z.string().trim().min(1).max(512).optional(),
    },
    async (input) => {
      const forbidden = forbiddenHardwareParameter(input);
      if (forbidden !== undefined) {
        return rejectAudited(
          context,
          "request_safe_skill",
          input.request_id,
          "raw_hardware_parameters_forbidden",
        );
      }
      const scopeFailure = scopeReason(
        context,
        input.actor_user_id,
        input.device_id,
      );
      if (scopeFailure !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "request_safe_skill",
          input.request_id,
          scopeFailure ?? "turn_request_mismatch",
        );
      }
      const replayed = replayDeviceResult(
        context,
        "request_safe_skill",
        input.request_id,
      );
      if (replayed !== undefined) return replayed;
      const rejected = envelopeReason(context, input, now());
      if (rejected !== undefined) {
        return rejectAudited(
          context,
          "request_safe_skill",
          input.request_id,
          rejected,
        );
      }

      if (input.skill === "approach_short" || input.skill === "invite_hug") {
        if (input.consent_token === undefined) {
          return rejectAudited(
            context,
            "request_safe_skill",
            input.request_id,
            "consent_token_required",
          );
        }
        if (input.consent_token !== context.request.consent?.token) {
          return rejectAudited(
            context,
            "request_safe_skill",
            input.request_id,
            "consent_token_mismatch",
          );
        }
      }

      const policy = evaluateSkillRequest({
        skill: input.skill,
        context: currentDeviceContext(context),
        ...(context.request.consent === undefined
          ? {}
          : { consent: context.request.consent }),
        hasConflict: context.request.multimodal_context?.has_conflict === true,
        reason: input.reason,
        now: now(),
        allowUnsensoredMotion: context.allowUnsensoredMotion === true,
      });
      if (!policy.allowed || policy.command === undefined) {
        return rejectAudited(
          context,
          "request_safe_skill",
          input.request_id,
          policy.reason,
        );
      }

      return deliverEffect(
        context,
        "request_safe_skill",
        input.request_id,
        {
          type: "safe_skill",
          request_id: input.request_id,
          actor_user_id: input.actor_user_id,
          device_id: input.device_id,
          command: policy.command,
        },
        { command: policy.command },
      );
    },
    {
      annotations: {
        title: "Request safe robot skill",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const getSkillStatus = tool(
    "get_skill_status",
    "Read the latest abstract skill and safety status for the request-scoped device.",
    {
      actor_user_id: z.string().trim().min(1).max(128),
      device_id: z.string().trim().min(1).max(128),
    },
    async ({ actor_user_id, device_id }) => {
      const rejected = scopeReason(context, actor_user_id, device_id);
      if (rejected !== undefined) {
        return mcpResult("rejected", rejected, {});
      }
      const current = currentDeviceContext(context);
      const lastSkillEvent = context.database
        .listInteractionEvents({ device_id, limit: 20 })
        .find((event) => event.event_type.includes("skill"));
      return mcpResult("completed", "skill_status_read", {
        device_id,
        safety_state: current.safety_state,
        active_skill: current.active_skill ?? null,
        last_event:
          lastSkillEvent === undefined
            ? null
            : {
                event_id: lastSkillEvent.id,
                event_type: lastSkillEvent.event_type,
                occurred_at: lastSkillEvent.occurred_at,
                request_id: lastSkillEvent.request_id ?? null,
              },
      });
    },
    {
      annotations: {
        title: "Read robot skill status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const stop = tool(
    "stop",
    "Request the unconditional abstract stop escape action. Still request-scoped and audited; accepts no raw hardware parameters.",
    sideEffectShape,
    async (input) => {
      const forbidden = forbiddenHardwareParameter(input);
      if (forbidden !== undefined) {
        return rejectAudited(
          context,
          "stop",
          input.request_id,
          "raw_hardware_parameters_forbidden",
        );
      }
      const rejected = scopeReason(
        context,
        input.actor_user_id,
        input.device_id,
      );
      if (rejected !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "stop",
          input.request_id,
          rejected ?? "turn_request_mismatch",
        );
      }
      const replayed = replayDeviceResult(context, "stop", input.request_id);
      if (replayed !== undefined) return replayed;
      const policy = evaluateSkillRequest({
        skill: "stop",
        context: currentDeviceContext(context),
        hasConflict: context.request.multimodal_context?.has_conflict === true,
        reason: input.reason,
        now: now(),
      });
      if (!policy.allowed || policy.command === undefined) {
        return rejectAudited(context, "stop", input.request_id, policy.reason);
      }
      return deliverEffect(
        context,
        "stop",
        input.request_id,
        {
          type: "safe_skill",
          request_id: input.request_id,
          actor_user_id: input.actor_user_id,
          device_id: input.device_id,
          command: policy.command,
        },
        { command: policy.command },
      );
    },
    {
      annotations: {
        title: "Stop robot",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  return [setExpression, playSound, requestSafeSkill, getSkillStatus, stop];
}

export function createHshhDeviceServer(
  context: HshhDeviceMcpContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "hshh_device",
    version: "1.0.0",
    instructions:
      "Request-scoped robot capability server. Use only semantic expression, sound, status, stop, and whitelisted safe-skill tools. Never submit raw hardware parameters.",
    tools: createHshhDeviceTools(context),
  });
}
