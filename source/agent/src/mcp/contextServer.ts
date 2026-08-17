import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  EventContextGateway,
  EventContextGatewayError,
  MAX_GATEWAY_WINDOW_MS,
  MIN_GATEWAY_WINDOW_MS,
} from "../gateway/EventContextGateway.js";
import { validateTriggeredImage } from "../multimodal/imagePrompt.js";

export interface HshhContextMcpOptions {
  gateway: EventContextGateway;
  deviceId: string;
  userId?: string;
  now?: () => Date;
}

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(reasonCode: string) {
  const value = { status: "failed", reason_code: reasonCode };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

function deviceScopeError(
  requestedDeviceId: string,
  boundDeviceId: string,
): ReturnType<typeof errorResult> | undefined {
  return requestedDeviceId === boundDeviceId
    ? undefined
    : errorResult("device_scope_mismatch");
}

/** Read-only context capability. It never chooses an action or grants consent. */
export function createHshhContextMcpServer(
  options: HshhContextMcpOptions,
): McpSdkServerConfigWithInstance {
  const now = options.now ?? (() => new Date());

  const getCurrentContext = tool(
    "get_current_context",
    "Read a fresh 5–15 second HSHH context. Stop/reject evidence is ordered first. Returned consent tokens were minted only by the gateway from explicit language/text or confirm gestures; this tool never invents consent.",
    {
      device_id: z.string().trim().min(1).max(128),
      window_ms: z
        .number()
        .int()
        .min(MIN_GATEWAY_WINDOW_MS)
        .max(MAX_GATEWAY_WINDOW_MS)
        .default(10_000),
    },
    async ({ device_id, window_ms }) => {
      const scopeError = deviceScopeError(device_id, options.deviceId);
      if (scopeError) return scopeError;
      try {
        const current = options.gateway.getCurrentContext(device_id, {
          windowMs: window_ms,
          now: now(),
        });
        const activeConsents = options.userId
          ? options.gateway.getActiveConsents(device_id, options.userId, now())
          : current.active_consents;
        return result({
          status: "completed",
          context: current.context,
          active_consents: activeConsents,
          context_generated: current.context_generated,
        });
      } catch (error) {
        return errorResult(
          error instanceof EventContextGatewayError
            ? error.code
            : "context_unavailable",
        );
      }
    },
    {
      annotations: {
        title: "Read current HSHH context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const getDeviceContext = tool(
    "get_device_context",
    "Read the latest structured device state. This is observational state, not permission to move.",
    { device_id: z.string().trim().min(1).max(128) },
    async ({ device_id }) => {
      const scopeError = deviceScopeError(device_id, options.deviceId);
      if (scopeError) return scopeError;
      const context = options.gateway.getDeviceContext(device_id);
      return context
        ? result({ status: "completed", context })
        : errorResult("device_context_not_found");
    },
    {
      annotations: {
        title: "Read latest device state",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: true,
    },
  );

  const getRecentEvents = tool(
    "get_recent_events",
    "Read recent structured event metadata and evidence IDs. Raw image/audio bytes and consent-token internals are never returned here.",
    {
      device_id: z.string().trim().min(1).max(128),
      since: z.string().datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ device_id, since, limit }) => {
      const scopeError = deviceScopeError(device_id, options.deviceId);
      if (scopeError) return scopeError;
      try {
        const events = options.gateway.getRecentEvents(device_id, {
          ...(since === undefined ? {} : { since }),
          limit,
          now: now(),
        });
        return result({ status: "completed", events });
      } catch (error) {
        return errorResult(
          error instanceof EventContextGatewayError
            ? error.code
            : "events_unavailable",
        );
      }
    },
    {
      annotations: {
        title: "Read recent device events",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const getKeyframe = tool(
    "get_keyframe",
    "Return one fresh event-triggered keyframe as an MCP image content block. No continuous video and no expired frame is available.",
    {
      device_id: z.string().trim().min(1).max(128),
      capture_id: z.string().trim().min(1).max(128).optional(),
    },
    async ({ device_id, capture_id }) => {
      const scopeError = deviceScopeError(device_id, options.deviceId);
      if (scopeError) return scopeError;
      const keyframe = options.gateway.getKeyframe(
        device_id,
        capture_id,
        now(),
      );
      if (!keyframe) return errorResult("keyframe_not_found_or_expired");
      const image = validateTriggeredImage(keyframe.image);
      const metadata = {
        status: "completed",
        capture_id: image.captureId,
        evidence_id: keyframe.evidence_id,
        observed_at: image.observedAt,
        expires_at: keyframe.expires_at,
        source: image.source,
        mime: image.mime,
        byte_length: image.byteLength,
      };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(metadata) },
          {
            type: "image" as const,
            data: image.base64,
            mimeType: image.mime,
          },
        ],
        structuredContent: metadata,
      };
    },
    {
      annotations: {
        title: "Read triggered keyframe",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  return createSdkMcpServer({
    name: "hshh_context",
    version: "0.1.0",
    instructions:
      "Read-only HSHH event/context capability. Visual and proximity evidence are never consent. Prefer stop/reject evidence when inputs conflict.",
    tools: [
      getCurrentContext,
      getDeviceContext,
      getRecentEvents,
      getKeyframe,
    ],
  });
}

export const HSHH_CONTEXT_TOOL_NAMES = [
  "mcp__hshh_context__get_current_context",
  "mcp__hshh_context__get_device_context",
  "mcp__hshh_context__get_recent_events",
  "mcp__hshh_context__get_keyframe",
] as const;
