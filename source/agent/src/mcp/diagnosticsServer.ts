import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { HshhDatabase } from "../store/database.js";

export type DiagnosticStatus = "completed" | "rejected" | "failed";

export interface FirmwareComponentStatus {
  component: "t5" | "esp32_s3" | "agent_service";
  version: string;
  build_id?: string;
  state: "ready" | "offline" | "unknown";
  observed_at: string;
}

export interface HshhDiagnosticsMcpOptions {
  database: HshhDatabase;
  deviceId: string;
  requestId: string;
  firmware?: readonly FirmwareComponentStatus[];
  now?: () => Date;
  idFactory?: () => string;
}

interface DiagnosticResult extends Record<string, unknown> {
  status: DiagnosticStatus;
  reason_code: string;
}

const SENSITIVE_KEY = /(?:api[_-]?key|auth|token|secret|password|wifi|base64|raw[_-]?(?:image|audio)|image[_-]?data|audio[_-]?data|credential)/iu;

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    if (/^data:(?:image|audio)\//iu.test(value)) return "[REDACTED_MEDIA]";
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 64)) {
      output[key] = SENSITIVE_KEY.test(key)
        ? "[REDACTED]"
        : redactValue(item, depth + 1);
    }
    return output;
  }
  return "[UNSUPPORTED]";
}

function mcpResult(value: DiagnosticResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value.status === "failed" ? { isError: true } : {}),
  };
}

function scopeCheck(
  deviceId: string,
  requestId: string,
  options: HshhDiagnosticsMcpOptions,
): DiagnosticResult | undefined {
  if (deviceId !== options.deviceId) {
    return { status: "rejected", reason_code: "device_scope_mismatch" };
  }
  if (requestId !== options.requestId) {
    return { status: "rejected", reason_code: "request_scope_mismatch" };
  }
  return undefined;
}

function firmwareSnapshot(
  options: HshhDiagnosticsMcpOptions,
): FirmwareComponentStatus[] {
  return (options.firmware ?? []).map((item) => structuredClone(item));
}

function structuredLogs(
  options: HshhDiagnosticsMcpOptions,
  limit: number,
  eventType?: string,
  requestId?: string,
) {
  return options.database
    .listInteractionEvents({
      device_id: options.deviceId,
      ...(eventType === undefined ? {} : { event_type: eventType }),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      limit,
    })
    .map((event) => ({
      event_id: event.id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      created_at: event.created_at,
      ...(event.request_id === undefined ? {} : { request_id: event.request_id }),
      ...(event.payload === undefined
        ? {}
        : { payload: redactValue(event.payload) }),
    }));
}

function selfTest(options: HshhDiagnosticsMcpOptions, now: Date): DiagnosticResult {
  try {
    const deviceContext = options.database.getDeviceContext(options.deviceId);
    const activeAsset = options.database.getActivePetAsset(options.deviceId);
    const recentEvents = options.database.listInteractionEvents({
      device_id: options.deviceId,
      limit: 1,
    });
    const checks = [
      {
        check: "database_read",
        status: "pass",
        reason_code: "sqlite_query_succeeded",
      },
      {
        check: "device_context_metadata",
        status: deviceContext ? "pass" : "warn",
        reason_code: deviceContext
          ? "device_context_available"
          : "device_context_not_recorded",
      },
      {
        check: "active_avatar_metadata",
        status: activeAsset ? "pass" : "warn",
        reason_code: activeAsset
          ? "active_avatar_available"
          : "using_basic_or_not_recorded",
      },
      {
        check: "recent_event_metadata",
        status: recentEvents.length > 0 ? "pass" : "warn",
        reason_code:
          recentEvents.length > 0 ? "recent_event_available" : "no_recent_event",
      },
    ];
    return {
      status: "completed",
      reason_code: "read_only_self_test_completed",
      observed_at: now.toISOString(),
      checks,
      safety_note:
        "This self-test reads stored metadata only; it does not access GPIO, serial ports, motors, servos, restart, or flash firmware.",
    };
  } catch {
    return {
      status: "failed",
      reason_code: "read_only_self_test_failed",
      observed_at: now.toISOString(),
    };
  }
}

/** Read-only diagnostic MCP; no tool can flash, reboot, write config, or use GPIO. */
export function createHshhDiagnosticsMcpServer(
  options: HshhDiagnosticsMcpOptions,
): McpSdkServerConfigWithInstance {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const scopedInput = {
    device_id: z.string().trim().min(1).max(128),
    request_id: z.string().trim().min(1).max(128),
  };

  const getLogs = tool(
    "get_logs",
    "Read redacted structured event logs for the request-scoped device. Never returns secrets, credentials, or raw image/audio content.",
    {
      ...scopedInput,
      limit: z.number().int().min(1).max(100).default(20),
      event_type: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[a-z][a-z0-9_]*$/u)
        .optional(),
      filter_request_id: z.string().trim().min(1).max(128).optional(),
    },
    async ({ device_id, request_id, limit, event_type, filter_request_id }) => {
      const scope = scopeCheck(device_id, request_id, options);
      if (scope) return mcpResult(scope);
      try {
        const logs = structuredLogs(
          options,
          limit,
          event_type,
          filter_request_id,
        );
        return mcpResult({
          status: "completed",
          reason_code: "structured_logs_returned",
          logs,
          redacted: true,
        });
      } catch {
        return mcpResult({
          status: "failed",
          reason_code: "log_query_failed",
        });
      }
    },
    {
      annotations: {
        title: "Read redacted structured logs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const runSelfTest = tool(
    "run_self_test",
    "Run a read-only metadata self-test. It never contacts GPIO, serial devices, motors or servos and never restarts or flashes anything.",
    scopedInput,
    async ({ device_id, request_id }) => {
      const scope = scopeCheck(device_id, request_id, options);
      return mcpResult(scope ?? selfTest(options, now()));
    },
    {
      annotations: {
        title: "Run read-only metadata self-test",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const getFirmwareStatus = tool(
    "get_firmware_status",
    "Read host-supplied firmware metadata only. It cannot connect to a serial port, flash, restart, or change firmware.",
    scopedInput,
    async ({ device_id, request_id }) => {
      const scope = scopeCheck(device_id, request_id, options);
      if (scope) return mcpResult(scope);
      const components = firmwareSnapshot(options);
      return mcpResult({
        status: "completed",
        reason_code:
          components.length > 0
            ? "firmware_metadata_returned"
            : "firmware_metadata_unavailable",
        observed_at: now().toISOString(),
        components,
        read_only: true,
      });
    },
    {
      annotations: {
        title: "Read firmware metadata",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  const collectBugBundle = tool(
    "collect_bug_bundle",
    "Collect an in-memory metadata-only bug bundle containing redacted event IDs, read-only self-test results, firmware metadata and active avatar metadata. It creates no file and performs no hardware action.",
    {
      ...scopedInput,
      log_limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ device_id, request_id, log_limit }) => {
      const scope = scopeCheck(device_id, request_id, options);
      if (scope) return mcpResult(scope);
      try {
        const generatedAt = now();
        const logs = structuredLogs(options, log_limit);
        const activeAsset = options.database.getActivePetAsset(device_id);
        const bundle = {
          bundle_id: `bug_${idFactory()}`,
          generated_at: generatedAt.toISOString(),
          device_id,
          request_id,
          log_event_ids: logs.map((log) => log.event_id),
          self_test: selfTest(options, generatedAt),
          firmware: firmwareSnapshot(options),
          active_avatar: activeAsset
            ? {
                asset_id: activeAsset.id,
                pet_id: activeAsset.pet_id,
                asset_version: activeAsset.asset_version,
                checksum_sha256: activeAsset.checksum_sha256,
                status: activeAsset.status,
              }
            : null,
          metadata_only: true,
          redacted: true,
        };
        return mcpResult({
          status: "completed",
          reason_code: "metadata_bug_bundle_collected",
          bundle,
        });
      } catch {
        return mcpResult({
          status: "failed",
          reason_code: "bug_bundle_collection_failed",
        });
      }
    },
    {
      annotations: {
        title: "Collect metadata-only bug bundle",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      alwaysLoad: false,
    },
  );

  return createSdkMcpServer({
    name: "hshh_diagnostics",
    version: "0.1.0",
    instructions:
      "Request-scoped read-only diagnostics. No tool flashes firmware, restarts devices, writes configuration, opens serial ports, or touches GPIO.",
    tools: [getLogs, runSelfTest, getFirmwareStatus, collectBugBundle],
  });
}

export const HSHH_DIAGNOSTICS_TOOL_NAMES = [
  "mcp__hshh_diagnostics__get_logs",
  "mcp__hshh_diagnostics__run_self_test",
  "mcp__hshh_diagnostics__get_firmware_status",
  "mcp__hshh_diagnostics__collect_bug_bundle",
] as const;
