import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import {
  MEMORY_KINDS,
  MEMORY_SOURCES,
  deviceSafetyStateSchema,
  type InteractionRequest,
  type MemoryCandidate,
} from "../domain/contracts.js";
import { isExplicitMemoryCandidate } from "../policy/policyGate.js";
import { HshhDatabase } from "../store/database.js";
import {
  mcpResult,
  normalizeReasonCode,
  type HshhToolStatus,
} from "./result.js";

export const HSHH_MEMORY_TOOL_NAMES = [
  "recall_memories",
  "propose_memory",
  "confirm_memory",
  "forget_memory",
  "get_memory_settings",
] as const;

export const HSHH_MEMORY_ALLOWED_TOOLS = HSHH_MEMORY_TOOL_NAMES.map(
  (name) => `mcp__hshh_memory__${name}` as const,
);

export interface HshhMemoryMcpContext {
  request: InteractionRequest;
  requestId: string;
  database: HshhDatabase;
  now?: () => Date;
}

interface MemorySideEffectEnvelope {
  actor_user_id: string;
  user_id: string;
  device_id: string;
  request_id: string;
  expires_at: string;
  expected_device_state: "ready" | "stopped" | "fault";
  reason: string;
}

const readScopeShape = {
  actor_user_id: z.string().trim().min(1).max(128),
  user_id: z.string().trim().min(1).max(128),
  device_id: z.string().trim().min(1).max(128),
};

const memorySideEffectShape = {
  ...readScopeShape,
  request_id: z.string().trim().min(1).max(128),
  expires_at: z.string().datetime({ offset: true }),
  expected_device_state: deviceSafetyStateSchema,
  reason: z.string().trim().min(1).max(160),
};

const MAX_EFFECT_TTL_MS = 300_000;

function scopedUserId(context: HshhMemoryMcpContext): string | undefined {
  return context.request.device_context.user_id;
}

function scopeReason(
  context: HshhMemoryMcpContext,
  actorUserId: string,
  userId: string,
  deviceId: string,
): string | undefined {
  const expectedUserId = scopedUserId(context);
  if (expectedUserId === undefined) return "user_scope_unbound";
  if (actorUserId !== expectedUserId || userId !== expectedUserId) {
    return "user_scope_mismatch";
  }
  if (deviceId !== context.request.device_context.device_id) {
    return "device_scope_mismatch";
  }
  return undefined;
}

function currentSafetyState(context: HshhMemoryMcpContext) {
  return (
    context.database.getDeviceContext(context.request.device_context.device_id) ??
    context.request.device_context
  ).safety_state;
}

function envelopeReason(
  context: HshhMemoryMcpContext,
  input: MemorySideEffectEnvelope,
  now: Date,
): string | undefined {
  if (input.request_id !== context.requestId) return "turn_request_mismatch";
  const scopeFailure = scopeReason(
    context,
    input.actor_user_id,
    input.user_id,
    input.device_id,
  );
  if (scopeFailure !== undefined) return scopeFailure;

  const expiresAt = Date.parse(input.expires_at);
  if (!Number.isFinite(expiresAt)) return "request_expiry_invalid";
  if (expiresAt <= now.getTime()) return "request_expired";
  if (expiresAt - now.getTime() > MAX_EFFECT_TTL_MS) {
    return "request_expiry_too_long";
  }
  if (input.expected_device_state !== currentSafetyState(context)) {
    return "expected_device_state_mismatch";
  }
  return undefined;
}

function replayMemoryResult(
  context: HshhMemoryMcpContext,
  toolName: (typeof HSHH_MEMORY_TOOL_NAMES)[number],
  requestId: string,
) {
  const userId = scopedUserId(context);
  const prior = context.database.listInteractionEvents({
    ...(userId === undefined ? {} : { user_id: userId }),
    device_id: context.request.device_context.device_id,
    event_type: `mcp_memory_${toolName}`,
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

function writeMemoryAudit(
  context: HshhMemoryMcpContext,
  toolName: (typeof HSHH_MEMORY_TOOL_NAMES)[number],
  requestId: string,
  status: HshhToolStatus,
  reasonCode: string,
  detail: Record<string, unknown> = {},
): boolean {
  const userId = scopedUserId(context);
  try {
    context.database.recordInteractionEvent({
      event_type: `mcp_memory_${toolName}`,
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

function rejectAudited(
  context: HshhMemoryMcpContext,
  toolName: (typeof HSHH_MEMORY_TOOL_NAMES)[number],
  requestId: string,
  reasonCode: string,
) {
  writeMemoryAudit(context, toolName, requestId, "rejected", reasonCode);
  return mcpResult("rejected", reasonCode, { request_id: requestId });
}

function completeAudited(
  context: HshhMemoryMcpContext,
  toolName: (typeof HSHH_MEMORY_TOOL_NAMES)[number],
  requestId: string,
  reasonCode: string,
  payload: Record<string, unknown>,
) {
  if (
    !writeMemoryAudit(
      context,
      toolName,
      requestId,
      "completed",
      reasonCode,
      payload,
    )
  ) {
    return mcpResult("failed", "audit_write_failed", { request_id: requestId });
  }
  return mcpResult("completed", reasonCode, {
    request_id: requestId,
    ...payload,
  });
}

export function createHshhMemoryTools(
  context: HshhMemoryMcpContext,
): Array<SdkMcpToolDefinition<any>> {
  const now = context.now ?? (() => new Date());

  const recallMemories = tool(
    "recall_memories",
    "Recall at most five confirmed, active memories for the request-scoped user. Returns no deleted or unconfirmed memory.",
    {
      ...readScopeShape,
      query: z.string().trim().max(300).optional(),
      limit: z.number().int().min(1).max(5).default(5),
    },
    async ({ actor_user_id, user_id, device_id, query, limit }) => {
      const rejected = scopeReason(
        context,
        actor_user_id,
        user_id,
        device_id,
      );
      if (rejected !== undefined) {
        return mcpResult("rejected", rejected, {});
      }
      const enabled = context.database.isMemoryEnabled(user_id);
      const memories = context.database.recallMemories(
        user_id,
        query ?? "",
        limit,
      );
      return mcpResult(
        "completed",
        enabled ? "memories_recalled" : "memory_disabled",
        { user_id, enabled, memories },
      );
    },
    {
      annotations: {
        title: "Recall confirmed memories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const proposeMemory = tool(
    "propose_memory",
    "Persist an unconfirmed candidate only from explicit user or confirmed-interaction facts. Never store emotion guesses, health data, third-party facts, VLM inference, or raw media.",
    {
      ...memorySideEffectShape,
      kind: z.enum(MEMORY_KINDS),
      summary: z.string().trim().min(2).max(240),
      source: z.enum(MEMORY_SOURCES),
      requires_confirmation: z.literal(true),
    },
    async (input) => {
      const scoped = scopeReason(
        context,
        input.actor_user_id,
        input.user_id,
        input.device_id,
      );
      if (scoped !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "propose_memory",
          input.request_id,
          scoped ?? "turn_request_mismatch",
        );
      }
      const replayed = replayMemoryResult(
        context,
        "propose_memory",
        input.request_id,
      );
      if (replayed !== undefined) return replayed;
      const rejected = envelopeReason(context, input, now());
      if (rejected !== undefined) {
        return rejectAudited(context, "propose_memory", input.request_id, rejected);
      }
      const candidate: MemoryCandidate = {
        kind: input.kind,
        summary: input.summary,
        source: input.source,
        requires_confirmation: input.requires_confirmation,
      };
      if (!isExplicitMemoryCandidate(candidate)) {
        return rejectAudited(
          context,
          "propose_memory",
          input.request_id,
          "memory_candidate_not_explicit",
        );
      }
      const saved = context.database.proposeMemory(input.user_id, candidate);
      if (saved === null) {
        return rejectAudited(
          context,
          "propose_memory",
          input.request_id,
          "memory_disabled",
        );
      }
      return completeAudited(
        context,
        "propose_memory",
        input.request_id,
        "memory_proposed",
        {
          candidate_id: saved.id,
          kind: saved.kind,
          confirmed: false,
        },
      );
    },
    {
      annotations: {
        title: "Propose memory candidate",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const confirmMemory = tool(
    "confirm_memory",
    "Confirm one existing request-scoped memory candidate after explicit user confirmation.",
    {
      ...memorySideEffectShape,
      memory_id: z.string().trim().min(1).max(128),
    },
    async (input) => {
      const scoped = scopeReason(
        context,
        input.actor_user_id,
        input.user_id,
        input.device_id,
      );
      if (scoped !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "confirm_memory",
          input.request_id,
          scoped ?? "turn_request_mismatch",
        );
      }
      const replayed = replayMemoryResult(
        context,
        "confirm_memory",
        input.request_id,
      );
      if (replayed !== undefined) return replayed;
      const rejected = envelopeReason(context, input, now());
      if (rejected !== undefined) {
        return rejectAudited(context, "confirm_memory", input.request_id, rejected);
      }
      if (!context.database.isMemoryEnabled(input.user_id)) {
        return rejectAudited(
          context,
          "confirm_memory",
          input.request_id,
          "memory_disabled",
        );
      }
      const existing = context.database.getMemory(input.user_id, input.memory_id);
      if (existing === null) {
        return rejectAudited(
          context,
          "confirm_memory",
          input.request_id,
          "memory_not_found",
        );
      }
      const confirmed = context.database.confirmMemory(
        input.user_id,
        input.memory_id,
      );
      if (confirmed === null) {
        return mcpResult("failed", "memory_confirm_failed", {
          request_id: input.request_id,
        });
      }
      return completeAudited(
        context,
        "confirm_memory",
        input.request_id,
        "memory_confirmed",
        { memory_id: confirmed.id, confirmed: true },
      );
    },
    {
      annotations: {
        title: "Confirm memory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const forgetMemory = tool(
    "forget_memory",
    "Immediately soft-delete one request-scoped memory so it can no longer be recalled.",
    {
      ...memorySideEffectShape,
      memory_id: z.string().trim().min(1).max(128),
    },
    async (input) => {
      const scoped = scopeReason(
        context,
        input.actor_user_id,
        input.user_id,
        input.device_id,
      );
      if (scoped !== undefined || input.request_id !== context.requestId) {
        return rejectAudited(
          context,
          "forget_memory",
          input.request_id,
          scoped ?? "turn_request_mismatch",
        );
      }
      const replayed = replayMemoryResult(
        context,
        "forget_memory",
        input.request_id,
      );
      if (replayed !== undefined) return replayed;
      const rejected = envelopeReason(context, input, now());
      if (rejected !== undefined) {
        return rejectAudited(context, "forget_memory", input.request_id, rejected);
      }
      if (context.database.getMemory(input.user_id, input.memory_id) === null) {
        return rejectAudited(
          context,
          "forget_memory",
          input.request_id,
          "memory_not_found",
        );
      }
      if (!context.database.softDeleteMemory(input.user_id, input.memory_id)) {
        return mcpResult("failed", "memory_forget_failed", {
          request_id: input.request_id,
        });
      }
      return completeAudited(
        context,
        "forget_memory",
        input.request_id,
        "memory_forgotten",
        { memory_id: input.memory_id, deleted: true },
      );
    },
    {
      annotations: {
        title: "Forget memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const getMemorySettings = tool(
    "get_memory_settings",
    "Read whether long-term memory is enabled for the request-scoped user.",
    readScopeShape,
    async ({ actor_user_id, user_id, device_id }) => {
      const rejected = scopeReason(
        context,
        actor_user_id,
        user_id,
        device_id,
      );
      if (rejected !== undefined) {
        return mcpResult("rejected", rejected, {});
      }
      return mcpResult("completed", "memory_settings_read", {
        ...context.database.getMemorySetting(user_id),
      });
    },
    {
      annotations: {
        title: "Read memory settings",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  return [
    recallMemories,
    proposeMemory,
    confirmMemory,
    forgetMemory,
    getMemorySettings,
  ];
}

export function createHshhMemoryServer(
  context: HshhMemoryMcpContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "hshh_memory",
    version: "1.0.0",
    instructions:
      "Request-scoped product memory server. Recall only confirmed active records. Persist only explicit low-sensitivity candidates, require confirmation, and honor deletion immediately.",
    tools: createHshhMemoryTools(context),
  });
}
