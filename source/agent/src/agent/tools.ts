import type {
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

import type { InteractionRequest } from "../domain/contracts.js";
import type { EventContextGateway } from "../gateway/EventContextGateway.js";
import {
  createHshhAvatarMcpServer,
  HSHH_AVATAR_TOOL_NAMES,
  type AvatarMetadataPipeline,
} from "../mcp/avatarServer.js";
import {
  createHshhContextMcpServer,
  HSHH_CONTEXT_TOOL_NAMES,
} from "../mcp/contextServer.js";
import {
  createHshhDeviceServer,
  type HshhDeviceDispatchResult,
  type HshhDeviceEffect,
} from "../mcp/deviceServer.js";
import {
  createHshhDiagnosticsMcpServer,
  HSHH_DIAGNOSTICS_TOOL_NAMES,
  type FirmwareComponentStatus,
} from "../mcp/diagnosticsServer.js";
import { createHshhMemoryServer } from "../mcp/memoryServer.js";
import {
  createHshhPerceptionMcpServer,
  HSHH_PERCEPTION_TOOL_NAMES,
  type PerceptionAdapter,
} from "../mcp/perceptionServer.js";
import type { HshhDatabase } from "../store/database.js";

export interface HshhToolContext {
  request: InteractionRequest;
  requestId: string;
  database: HshhDatabase;
  gateway: EventContextGateway;
  avatarPipeline: AvatarMetadataPipeline;
  projectRoot: string;
  perceptionAdapter?: PerceptionAdapter;
  firmware?: readonly FirmwareComponentStatus[];
  allowUnsensoredMotion?: boolean;
  dispatchDeviceEffect?: (
    effect: HshhDeviceEffect,
  ) => Promise<HshhDeviceDispatchResult>;
  now?: () => Date;
}

export type HshhMcpServers = Record<
  | "hshh_context"
  | "hshh_device"
  | "hshh_memory"
  | "hshh_perception"
  | "hshh_avatar"
  | "hshh_diagnostics",
  McpSdkServerConfigWithInstance
>;

/** Build all six request-scoped MCP capabilities; no workflow order is encoded. */
export function createHshhToolServers(
  context: HshhToolContext,
): HshhMcpServers {
  const deviceId = context.request.device_context.device_id;
  const userId = context.request.device_context.user_id;
  return {
    hshh_context: createHshhContextMcpServer({
      gateway: context.gateway,
      deviceId,
      ...(userId === undefined ? {} : { userId }),
      ...(context.now === undefined ? {} : { now: context.now }),
    }),
    hshh_device: createHshhDeviceServer({
      request: context.request,
      requestId: context.requestId,
      database: context.database,
      ...(context.now === undefined ? {} : { now: context.now }),
      ...(context.dispatchDeviceEffect === undefined
        ? {}
        : { dispatch: context.dispatchDeviceEffect }),
      ...(context.allowUnsensoredMotion === true
        ? { allowUnsensoredMotion: true }
        : {}),
    }),
    hshh_memory: createHshhMemoryServer({
      request: context.request,
      requestId: context.requestId,
      database: context.database,
      ...(context.now === undefined ? {} : { now: context.now }),
    }),
    hshh_perception: createHshhPerceptionMcpServer({
      gateway: context.gateway,
      deviceId,
      ...(context.perceptionAdapter === undefined
        ? {}
        : { adapter: context.perceptionAdapter }),
      ...(context.now === undefined ? {} : { now: context.now }),
    }),
    hshh_avatar: createHshhAvatarMcpServer({
      database: context.database,
      pipeline: context.avatarPipeline,
      deviceId,
      requestId: context.requestId,
    }),
    hshh_diagnostics: createHshhDiagnosticsMcpServer({
      database: context.database,
      deviceId,
      requestId: context.requestId,
      ...(context.firmware === undefined ? {} : { firmware: context.firmware }),
      ...(context.now === undefined ? {} : { now: context.now }),
    }),
  };
}

/**
 * Auto-approved capabilities still pass through PreToolUse and the process
 * sandbox. Side-effecting MCP tools are intentionally omitted and reach the
 * request-scoped `canUseTool` policy before their own service-side gate.
 */
export const HSHH_AUTO_APPROVED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
  "ToolSearch",
  "Skill",
  "StructuredOutput",
  "AskUserQuestion",
  "TaskCreate",
  "TaskUpdate",
  ...HSHH_CONTEXT_TOOL_NAMES,
  ...HSHH_PERCEPTION_TOOL_NAMES,
  "mcp__hshh_device__get_skill_status",
  "mcp__hshh_memory__recall_memories",
  "mcp__hshh_memory__get_memory_settings",
  "mcp__hshh_avatar__validate_asset",
  "mcp__hshh_avatar__preview_pack",
  ...HSHH_DIAGNOSTICS_TOOL_NAMES,
] as const;

export { HSHH_AVATAR_TOOL_NAMES };
