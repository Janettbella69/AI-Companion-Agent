import { isAbsolute, relative, resolve } from "node:path";

import type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  Options,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";

import type { AgentToolAction } from "../domain/contracts.js";
import { HshhDatabase } from "../store/database.js";

const DEVICE_OR_SECRET_PATTERN =
  /(?:\/dev\/(?:tty|cu\.|serial)|\/var\/run\/docker\.sock|ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|HSHH_(?:DEVICE_TOKEN|CONSENT_SECRET))/iu;
const BASH_NETWORK_PATTERN = /(?:^|[\s;&|])(?:curl|wget|nc|ncat|socat|ssh|scp|telnet)\b/iu;
const DANGEROUS_BASH_PATTERN =
  /(?:^|[\s;&|])(?:sudo|su|mount|umount|launchctl|systemctl|shutdown|reboot|docker|podman)\b/iu;
const PATH_TRAVERSAL_PATTERN = /(?:^|[\s'"=])\.\.(?:\/|\\)/u;
const SECRET_VALUE_PATTERN = /(?:sk-ant-|sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[=:])/iu;

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "Glob", "Grep"]);
const ALWAYS_SAFE_BUILT_INS = new Set([
  "StructuredOutput",
  "ToolSearch",
  "Skill",
  "TaskCreate",
  "TaskUpdate",
  "AskUserQuestion",
]);

export interface RuntimePolicyOptions {
  workspaceRoot: string;
  allowedWebDomains: readonly string[];
  allowDeepResearch: boolean;
  database: HshhDatabase;
  userId?: string;
  deviceId: string;
  now?: () => Date;
}

export interface RuntimePolicy {
  canUseTool: CanUseTool;
  hooks: NonNullable<Options["hooks"]>;
  actions: AgentToolAction[];
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const offset = relative(normalizedRoot, normalizedCandidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function collectPathCandidates(value: unknown, paths: string[] = []): string[] {
  if (typeof value === "string") return paths;
  if (Array.isArray(value)) {
    for (const item of value) collectPathCandidates(item, paths);
    return paths;
  }
  if (!value || typeof value !== "object") return paths;

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === "string" &&
      /(?:^|_)(?:path|file|directory|cwd)$/iu.test(key)
    ) {
      paths.push(item);
    } else {
      collectPathCandidates(item, paths);
    }
  }
  return paths;
}

function hasOutsidePath(input: unknown, workspaceRoot: string): boolean {
  return collectPathCandidates(input).some((candidate) => {
    const absolute = isAbsolute(candidate)
      ? candidate
      : resolve(workspaceRoot, candidate);
    return !isWithin(workspaceRoot, absolute);
  });
}

function privateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) ||
    host.endsWith(".local")
  );
}

function allowedWebFetch(
  input: Record<string, unknown>,
  allowedDomains: readonly string[],
): boolean {
  const rawUrl = input.url;
  if (typeof rawUrl !== "string" || SECRET_VALUE_PATTERN.test(rawUrl)) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || privateOrLocalHost(url.hostname)) return false;
    return allowedDomains.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function bashAllowed(command: unknown, workspaceRoot: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (
    DEVICE_OR_SECRET_PATTERN.test(command) ||
    SECRET_VALUE_PATTERN.test(command) ||
    BASH_NETWORK_PATTERN.test(command) ||
    DANGEROUS_BASH_PATTERN.test(command) ||
    PATH_TRAVERSAL_PATTERN.test(command)
  ) {
    return false;
  }

  const absolutePaths = command.match(/\/(?:[^\s'";&|])+/gu) ?? [];
  return absolutePaths.every((path) => isWithin(workspaceRoot, path));
}

function decision(
  allowed: boolean,
  message: string,
  input?: Record<string, unknown>,
): PermissionResult {
  return allowed
    ? {
        behavior: "allow",
        ...(input === undefined ? {} : { updatedInput: input }),
      }
    : { behavior: "deny", message, interrupt: false };
}

function stableToolStatus(response: unknown): AgentToolAction["status"] {
  if (response && typeof response === "object") {
    const serialized = JSON.stringify(response);
    if (/"status":"stopped"/u.test(serialized)) return "stopped";
    if (/"status":"failed"|"isError":true/u.test(serialized)) return "failed";
    if (/"accepted":false|"status":"rejected"/u.test(serialized)) return "rejected";
    if (/"status":"completed"/u.test(serialized)) return "completed";
  }
  return "accepted";
}

function requestIdFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const candidate = (input as Record<string, unknown>).request_id;
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function evidenceIdsFrom(input: unknown): string[] | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const values = [record["evidence_id"], record["evidence_ids"]]
    .flatMap((value) =>
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [],
    )
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 64);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function createRuntimePolicy(options: RuntimePolicyOptions): RuntimePolicy {
  const workspaceRoot = resolve(options.workspaceRoot);
  const now = options.now ?? (() => new Date());
  const actions: AgentToolAction[] = [];

  const evaluate = (
    toolName: string,
    input: Record<string, unknown>,
  ): PermissionResult => {
    if (DEVICE_OR_SECRET_PATTERN.test(JSON.stringify(input))) {
      return decision(false, "Direct device and secret access is outside the Agent capability boundary.");
    }
    if (FILE_TOOLS.has(toolName)) {
      return decision(
        !hasOutsidePath(input, workspaceRoot),
        "File access is restricted to the current HSHH session workspace.",
      );
    }
    if (toolName === "Bash") {
      return decision(
        bashAllowed(input.command, workspaceRoot),
        "Bash may run only non-networked commands inside the session workspace.",
      );
    }
    if (toolName === "WebFetch") {
      return decision(
        allowedWebFetch(input, options.allowedWebDomains),
        "WebFetch is restricted to the configured public-domain allowlist.",
      );
    }
    if (toolName === "WebSearch") {
      const serialized = JSON.stringify(input);
      return decision(
        !SECRET_VALUE_PATTERN.test(serialized) &&
          !serialized.includes(options.deviceId) &&
          (options.userId === undefined || !serialized.includes(options.userId)),
        "WebSearch input contains a credential or scoped identity.",
      );
    }
    if (toolName === "Agent") {
      return decision(
        options.allowDeepResearch,
        "Subagents are available only for an explicitly authorized deep_research request.",
      );
    }
    if (ALWAYS_SAFE_BUILT_INS.has(toolName)) return decision(true, "allowed");
    if (toolName.startsWith("mcp__hshh_")) return decision(true, "allowed");
    return decision(false, `Tool ${toolName} is outside the HSHH runtime policy.`);
  };

  const canUseTool: CanUseTool = async (toolName, input) => evaluate(toolName, input);

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return { continue: true };
    const toolInput =
      input.tool_input && typeof input.tool_input === "object"
        ? (input.tool_input as Record<string, unknown>)
        : {};
    const result = evaluate(input.tool_name, toolInput);
    if (result.behavior === "allow") return { continue: true };
    options.database.recordInteractionEvent({
      event_type: input.tool_name === "Agent" ? "subagent_denied" : "native_tool_denied",
      occurred_at: now().toISOString(),
      ...(options.userId === undefined ? {} : { user_id: options.userId }),
      device_id: options.deviceId,
      payload: { tool_name: input.tool_name, reason: result.message },
    });
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: result.message,
      },
    };
  };

  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return { continue: true };
    const requestId = requestIdFrom(input.tool_input);
    const evidenceIds = evidenceIdsFrom(input.tool_input);
    const action: AgentToolAction = {
      tool_name: input.tool_name,
      status: stableToolStatus(input.tool_response),
      ...(requestId === undefined ? {} : { request_id: requestId }),
      ...(evidenceIds === undefined ? {} : { used_evidence_ids: evidenceIds }),
    };
    actions.push(action);
    const eventType = input.tool_name === "Skill"
      ? "skill_loaded"
      : input.tool_name.startsWith("mcp__")
        ? action.status === "rejected" || action.status === "failed"
          ? "mcp_tool_rejected"
          : "mcp_tool_called"
        : "native_tool_called";
    options.database.recordInteractionEvent({
      event_type: eventType,
      occurred_at: now().toISOString(),
      ...(options.userId === undefined ? {} : { user_id: options.userId }),
      device_id: options.deviceId,
      ...(action.request_id === undefined ? {} : { request_id: action.request_id }),
      payload: {
        tool_name: input.tool_name,
        status: action.status,
        duration_ms: input.duration_ms ?? null,
        session_id: input.session_id,
        input_fields:
          input.tool_input && typeof input.tool_input === "object"
            ? Object.keys(input.tool_input as Record<string, unknown>)
                .filter((key) => !/(?:token|secret|key|password|base64)/iu.test(key))
                .slice(0, 32)
            : [],
      },
    });
    return { continue: true };
  };

  const hooks: Partial<Record<"PreToolUse" | "PostToolUse", HookCallbackMatcher[]>> = {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
  };

  return { canUseTool, hooks, actions };
}

export function hshhSandboxSettings(input: {
  workspaceRoot: string;
  allowedWebDomains: readonly string[];
  failIfUnavailable: boolean;
}): NonNullable<Options["sandbox"]> {
  return {
    enabled: true,
    failIfUnavailable: input.failIfUnavailable,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [...input.allowedWebDomains],
      deniedDomains: ["localhost", "127.0.0.1", "*.local"],
      strictAllowlist: true,
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      allowWrite: [resolve(input.workspaceRoot)],
      denyWrite: ["/dev", "/etc", "/var/run", "/private/var/run"],
      denyRead: ["/dev", "/etc", "/var/run", "/private/var/run", "~/.ssh", "~/.aws"],
      allowRead: [resolve(input.workspaceRoot)],
    },
    credentials: {
      envVars: [
        { name: "ANTHROPIC_API_KEY", mode: "deny" },
        { name: "ANTHROPIC_AUTH_TOKEN", mode: "deny" },
      ],
      files: [
        { path: "~/.ssh", mode: "deny" },
        { path: "~/.aws", mode: "deny" },
      ],
    },
  };
}
