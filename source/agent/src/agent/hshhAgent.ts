import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  query,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { AgentServiceConfig } from "../config.js";
import {
  agentDecisionOutputSchema,
  interactionRequestSchema,
  interactionResponseSchema,
  type AgentDecision,
  type ConsentGrant,
  type DeviceContext,
  type InteractionRequest,
  type InteractionResponse,
} from "../domain/contracts.js";
import { EventContextGateway } from "../gateway/EventContextGateway.js";
import { AvatarMetadataPipeline } from "../mcp/avatarServer.js";
import type {
  HshhDeviceDispatchResult,
  HshhDeviceEffect,
} from "../mcp/deviceServer.js";
import type { FirmwareComponentStatus } from "../mcp/diagnosticsServer.js";
import type { PerceptionAdapter } from "../mcp/perceptionServer.js";
import { buildMultimodalPrompt } from "../multimodal/contextBuilder.js";
import { applyPolicyGate } from "../policy/policyGate.js";
import {
  assertProviderReady,
  hasProviderCredential,
  providerEnvironment,
} from "../provider/providerProfile.js";
import {
  createRuntimePolicy,
  hshhSandboxSettings,
  type RuntimePolicy,
} from "../security/runtimePolicy.js";
import { HshhDatabase, makeConversationKey } from "../store/database.js";
import {
  ensureSessionWorkspace,
  HSHH_RUNTIME_SKILLS,
} from "../workspace/sessionWorkspace.js";
import { createFallbackDecision, type FallbackReason } from "./fallbackAgent.js";
import { KeyedSerialQueue } from "./sessionQueue.js";
import {
  buildSystemPrompt,
  buildTrustedTurnContext,
} from "./systemPrompt.js";
import {
  createHshhToolServers,
  HSHH_AUTO_APPROVED_TOOLS,
} from "./tools.js";

type QueryFactory = typeof query;

export interface HshhAgentDependencies {
  queryFactory?: QueryFactory;
  now?: () => Date;
  projectRoot?: string;
  gateway?: EventContextGateway;
  perceptionAdapter?: PerceptionAdapter;
  avatarPipeline?: AvatarMetadataPipeline;
  firmware?: readonly FirmwareComponentStatus[];
  dispatchDeviceEffect?: (
    effect: HshhDeviceEffect,
  ) => Promise<HshhDeviceDispatchResult>;
  queue?: KeyedSerialQueue;
  /** Test-only compatibility escape hatch; production consent comes from Gateway. */
  trustInlineConsent?: boolean;
}

export interface InteractionRunOptions {
  onSdkEvent?: (event: SDKMessage) => void | Promise<void>;
}

interface RunContext {
  request: InteractionRequest;
  userId?: string;
  conversationKey: string;
  resumeSessionId?: string;
}

export class HshhAgentScopeError extends Error {
  readonly code = "user_device_scope_mismatch";

  constructor() {
    super("The authenticated user is not bound to this device.");
    this.name = "HshhAgentScopeError";
  }
}

const OPTIONAL_PLACEHOLDER_FIELDS = [
  "robot_expression",
  "skill_request",
  "memory_candidate",
  "visual_guidance",
] as const;

const decisionJsonSchema = z.toJSONSchema(agentDecisionOutputSchema, {
  target: "draft-7",
});

export function normalizeAgentDecisionOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized = { ...(value as Record<string, unknown>) };
  for (const field of OPTIONAL_PLACEHOLDER_FIELDS) {
    const candidate = normalized[field];
    if (
      candidate === null ||
      (candidate !== undefined &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        Object.keys(candidate).length === 0)
    ) {
      delete normalized[field];
    }
  }
  if (
    normalized["confirmation_scope"] === null ||
    normalized["confirmation_scope"] === ""
  ) {
    delete normalized["confirmation_scope"];
  }
  return normalized;
}

function structuredOutputCandidate(message: SDKMessage): unknown | undefined {
  if (message.type !== "assistant") return undefined;
  for (const block of message.message.content) {
    if (block.type === "tool_use" && block.name === "StructuredOutput") {
      return block.input;
    }
  }
  return undefined;
}

function oneUserMessage(
  content: SDKUserMessage["message"]["content"],
): AsyncIterable<SDKUserMessage> {
  return (async function* prompt(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  })();
}

function fallbackModeFor(error: unknown, timedOut: boolean): FallbackReason {
  if (timedOut) return "timeout";
  return error instanceof Error && error.name === "AbortError"
    ? "timeout"
    : "agent_error";
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 80) : "UnknownError";
}

function safeUntrustedDeviceContext(
  context: DeviceContext,
  now: Date,
): DeviceContext {
  return {
    device_id: context.device_id,
    ...(context.user_id === undefined ? {} : { user_id: context.user_id }),
    observed_at: now.toISOString(),
    presence: "unknown",
    pose: "unknown",
    battery: "unknown",
    safety_state: "stopped",
  };
}

function withActualActions(
  decision: AgentDecision,
  runtime: RuntimePolicy,
): AgentDecision {
  const result = { ...decision };
  if (runtime.actions.length > 0) {
    result.actions_taken = runtime.actions.map((action) => ({ ...action }));
  } else {
    delete result.actions_taken;
  }
  return result;
}

function createResearchAgentDefinition(): NonNullable<Options["agents"]> {
  return {
    researcher: {
      description:
        "仅在已明确标记 deep_research 的任务中，并行搜索、阅读和比较公开资料。",
      prompt:
        "你是只读研究子代理。只研究公开资料并返回带来源的摘要；不得调用任何 HSHH Device/Memory/Avatar MCP，不得处理用户私密数据，不得做产品或物理动作决策。",
      tools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
      disallowedTools: ["mcp__hshh_device__*", "mcp__hshh_memory__*", "mcp__hshh_avatar__*"],
      maxTurns: 8,
    },
  };
}

/**
 * Build the fixed Claude Agent SDK boundary. Claude Code's full native tool
 * surface remains present; approval and sandbox policy restrict capability.
 */
export function createClaudeOptions(input: {
  config: AgentServiceConfig;
  systemPrompt: string;
  mcpServers: Record<string, McpSdkServerConfigWithInstance>;
  runtimePolicy: RuntimePolicy;
  abortController: AbortController;
  workspace: string;
  taskMode: "companion" | "deep_research";
  resumeSessionId?: string;
}): Options {
  const runtimeHome = join(input.workspace, ".runtime-home");
  const runtimeTmp = join(input.workspace, ".tmp");
  mkdirSync(runtimeHome, { recursive: true });
  mkdirSync(runtimeTmp, { recursive: true });

  return {
    tools: { type: "preset", preset: "claude_code" },
    mcpServers: input.mcpServers,
    strictMcpConfig: true,
    allowedTools: [...HSHH_AUTO_APPROVED_TOOLS],
    permissionMode: "default",
    canUseTool: input.runtimePolicy.canUseTool,
    hooks: input.runtimePolicy.hooks,
    sandbox: hshhSandboxSettings({
      workspaceRoot: input.workspace,
      allowedWebDomains: input.config.allowedWebDomains,
      failIfUnavailable: input.config.sandboxFailClosed,
    }),
    settingSources: ["project"],
    skills: [...HSHH_RUNTIME_SKILLS],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: input.systemPrompt,
    },
    outputFormat: {
      type: "json_schema",
      schema: decisionJsonSchema,
    },
    model: input.config.claudeModel,
    maxTurns: 12,
    includePartialMessages: true,
    cwd: input.workspace,
    abortController: input.abortController,
    persistSession: true,
    env: {
      ...providerEnvironment(input.config.providerProfile),
      HOME: runtimeHome,
      CLAUDE_CONFIG_DIR: join(runtimeHome, ".claude"),
      TMPDIR: runtimeTmp,
    },
    ...(input.taskMode === "deep_research"
      ? { agents: createResearchAgentDefinition() }
      : {}),
    ...(input.resumeSessionId === undefined
      ? {}
      : { resume: input.resumeSessionId }),
  };
}

export class HshhAgent {
  private readonly queryFactory: QueryFactory;
  private readonly now: () => Date;
  private readonly projectRoot: string;
  private readonly gateway: EventContextGateway;
  private readonly perceptionAdapter: PerceptionAdapter | undefined;
  private readonly avatarPipeline: AvatarMetadataPipeline;
  private readonly firmware: readonly FirmwareComponentStatus[] | undefined;
  private readonly dispatchDeviceEffect:
    | ((effect: HshhDeviceEffect) => Promise<HshhDeviceDispatchResult>)
    | undefined;
  private readonly queue: KeyedSerialQueue;
  private readonly trustInlineConsent: boolean;

  constructor(
    private readonly database: HshhDatabase,
    private readonly config: AgentServiceConfig,
    dependencies: HshhAgentDependencies = {},
  ) {
    this.queryFactory = dependencies.queryFactory ?? query;
    this.now = dependencies.now ?? (() => new Date());
    this.projectRoot = dependencies.projectRoot ?? process.cwd();
    this.gateway = dependencies.gateway ?? new EventContextGateway({ now: this.now });
    this.perceptionAdapter = dependencies.perceptionAdapter;
    this.avatarPipeline =
      dependencies.avatarPipeline ?? new AvatarMetadataPipeline({ now: this.now });
    this.firmware = dependencies.firmware;
    this.dispatchDeviceEffect = dependencies.dispatchDeviceEffect;
    this.queue = dependencies.queue ?? new KeyedSerialQueue();
    this.trustInlineConsent = dependencies.trustInlineConsent ?? false;
  }

  async interact(
    input: unknown,
    runOptions: InteractionRunOptions = {},
  ): Promise<InteractionResponse> {
    const parsed = interactionRequestSchema.parse(input);
    const queueKey = makeConversationKey(
      parsed.device_context.user_id ?? "anonymous",
      parsed.device_context.device_id,
    );
    return this.queue.run(queueKey, async () => {
      const request = this.prepareTrustedRequest(parsed);
      return this.runInteraction(request, runOptions);
    });
  }

  private prepareTrustedRequest(request: InteractionRequest): InteractionRequest {
    const submittedContext = request.device_context;
    const gatewayContext = this.gateway.getDeviceContext(submittedContext.device_id);
    const storedContext = this.database.getDeviceContext(submittedContext.device_id);
    const authoritativeContext = gatewayContext ?? storedContext;

    if (
      authoritativeContext?.user_id !== undefined &&
      submittedContext.user_id !== undefined &&
      authoritativeContext.user_id !== submittedContext.user_id
    ) {
      throw new HshhAgentScopeError();
    }

    // Interaction bodies are conversational input, not a trusted sensor path.
    // In the absence of a device-originated snapshot, retain identity only and
    // force a non-actuating context. A fresh Gateway/DB context supplies every
    // safety field used by Device MCP and the final Policy Gate.
    const deviceContext: DeviceContext = authoritativeContext
      ? {
          ...authoritativeContext,
          ...(authoritativeContext.user_id === undefined &&
          submittedContext.user_id !== undefined
            ? { user_id: submittedContext.user_id }
            : {}),
        }
      : safeUntrustedDeviceContext(submittedContext, this.now());
    const stampedContext: DeviceContext = this.config.allowUnsensoredMotion
      ? { ...deviceContext, observed_at: this.now().toISOString() }
      : deviceContext;
    this.database.upsertDeviceContext(stampedContext);
    this.gateway.updateDeviceContext(stampedContext);

    const activeConsent = this.gateway
      .getActiveConsents(
        stampedContext.device_id,
        stampedContext.user_id,
        this.now(),
      )
      .sort((left, right) => Date.parse(right.granted_at) - Date.parse(left.granted_at))[0];
    const trustedConsent: ConsentGrant | undefined = activeConsent
      ? {
          approach: activeConsent.scope === "approach_short",
          hug: activeConsent.scope === "invite_hug",
          token: activeConsent.token,
          scopes: [activeConsent.scope],
          granted_at: activeConsent.granted_at,
          expires_at: activeConsent.expires_at,
        }
      : this.trustInlineConsent
        ? request.consent
        : undefined;

    const generatedContext = this.gateway.getCurrentContext(
      stampedContext.device_id,
      { now: this.now() },
    ).context;
    const submittedMultimodal = request.multimodal_context;
    const multimodalContext =
      generatedContext.evidence.length > 0
        ? generatedContext
        : submittedMultimodal === undefined
          ? generatedContext
          : {
              ...submittedMultimodal,
              // A caller-provided local sensor snapshot never replaces the
              // authoritative device snapshot used by this turn.
              local_sensor_context: stampedContext,
            };
    const trusted: InteractionRequest = {
      ...request,
      device_context: stampedContext,
      multimodal_context: multimodalContext,
    };
    if (trustedConsent) trusted.consent = trustedConsent;
    else delete trusted.consent;
    return trusted;
  }

  private async runInteraction(
    request: InteractionRequest,
    runOptions: InteractionRunOptions,
  ): Promise<InteractionResponse> {
    const runContext = this.prepareRunContext(request);
    if (!hasProviderCredential(this.config.providerProfile)) {
      return this.fallback(runContext, "missing_api_key");
    }
    if (!this.config.providerProfile.verified) {
      return this.fallback(runContext, "provider_unavailable");
    }

    const abortController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.config.agentTimeoutMs);

    try {
      assertProviderReady(this.config.providerProfile);
      const workspace = ensureSessionWorkspace({
        sessionRoot: this.config.sessionRoot,
        skillsRoot: this.config.skillsRoot,
        conversationKey: runContext.conversationKey,
      });
      const runtimePolicy = createRuntimePolicy({
        workspaceRoot: workspace,
        allowedWebDomains: this.config.allowedWebDomains,
        allowDeepResearch: request.task_mode === "deep_research",
        database: this.database,
        ...(runContext.userId === undefined ? {} : { userId: runContext.userId }),
        deviceId: request.device_context.device_id,
        now: this.now,
      });
      const turnRequestId = request.request_id ?? randomUUID();
      const sideEffectExpiresAt = new Date(
        this.now().getTime() + Math.min(this.config.agentTimeoutMs + 30_000, 60_000),
      ).toISOString();
      this.database.recordInteractionEvent({
        event_type:
          runContext.resumeSessionId === undefined
            ? "agent_session_started"
            : "agent_session_resumed",
        occurred_at: this.now().toISOString(),
        ...(runContext.userId === undefined
          ? {}
          : { user_id: runContext.userId }),
        device_id: request.device_context.device_id,
        request_id: turnRequestId,
        payload: {
          provider_id: this.config.providerProfile.providerId,
          ...(runContext.resumeSessionId === undefined
            ? {}
            : { session_id: runContext.resumeSessionId }),
        },
      });
      const mcpServers = createHshhToolServers({
        request,
        requestId: turnRequestId,
        database: this.database,
        gateway: this.gateway,
        avatarPipeline: this.avatarPipeline,
        projectRoot: this.projectRoot,
        ...(this.perceptionAdapter === undefined
          ? {}
          : { perceptionAdapter: this.perceptionAdapter }),
        ...(this.firmware === undefined ? {} : { firmware: this.firmware }),
        ...(this.dispatchDeviceEffect === undefined
          ? {}
          : { dispatchDeviceEffect: this.dispatchDeviceEffect }),
        ...(this.config.allowUnsensoredMotion
          ? { allowUnsensoredMotion: true }
          : {}),
        now: this.now,
      });
      const prompt = buildMultimodalPrompt(request, this.now());
      const taskMode = request.task_mode ?? "companion";
      const memoryEnabled =
        runContext.userId !== undefined &&
        this.database.isMemoryEnabled(runContext.userId);
      const supportsVision = this.config.providerProfile.supportsVision;
      const options = createClaudeOptions({
        config: this.config,
        systemPrompt: buildSystemPrompt(),
        mcpServers,
        runtimePolicy,
        abortController,
        workspace,
        taskMode,
        ...(runContext.resumeSessionId === undefined
          ? {}
          : { resumeSessionId: runContext.resumeSessionId }),
      });

      const imageBlocks = supportsVision
        ? prompt.content.filter((block) => block.type === "image")
        : [];
      const content = [
        {
          type: "text" as const,
          text: `${buildTrustedTurnContext({
            memoryEnabled,
            supportsVision,
            taskMode,
          })}\n\n后端当前时间：${this.now().toISOString()}\n${prompt.text}\n\n本轮受信工具信封（只能原样用于本轮 MCP 参数；只有非空 consent_token 才表示其 scope 对应的短时同意）：${JSON.stringify(
            {
              request_id: turnRequestId,
              actor_user_id: runContext.userId ?? "anonymous",
              device_id: request.device_context.device_id,
              expires_at: sideEffectExpiresAt,
              expected_device_state: request.device_context.safety_state,
              artifact_refs: request.artifact_refs ?? [],
              consent_token: request.consent?.token ?? null,
            },
          )}`,
        },
        ...imageBlocks,
      ] satisfies SDKUserMessage["message"]["content"];

      let result: SDKResultMessage | undefined;
      let lastStructuredOutputCandidate: unknown;
      for await (const message of this.queryFactory({
        prompt: oneUserMessage(content),
        options,
      })) {
        await this.publishSdkEvent(runOptions, message);
        const candidate = structuredOutputCandidate(message);
        if (candidate !== undefined) lastStructuredOutputCandidate = candidate;
        if (message.type === "result") result = message;
      }

      if (!result) throw new Error("Claude Agent returned no result message");
      if (result.subtype !== "success") {
        throw new Error(`Claude Agent failed: ${result.subtype}`);
      }

      const structuredOutput =
        result.structured_output ?? lastStructuredOutputCandidate;
      if (structuredOutput === undefined) {
        throw new Error("Claude Agent returned no structured output");
      }
      const parsedDecision = agentDecisionOutputSchema.parse(
        normalizeAgentDecisionOutput(structuredOutput),
      );
      const decision = withActualActions(
        applyPolicyGate(parsedDecision, request, this.now(), {
          allowUnsensoredMotion: this.config.allowUnsensoredMotion,
        }),
        runtimePolicy,
      );
      this.persistDecision(runContext, decision, "claude");

      this.database.saveAgentSession({
        conversation_key: runContext.conversationKey,
        session_id: result.session_id,
        ...(runContext.userId === undefined
          ? {}
          : { user_id: runContext.userId }),
        device_id: request.device_context.device_id,
      });

      return interactionResponseSchema.parse({
        decision,
        session_id: result.session_id,
        mode: "claude",
      });
    } catch (error) {
      this.database.recordInteractionEvent({
        event_type: timedOut ? "agent_timeout" : "agent_error",
        occurred_at: this.now().toISOString(),
        ...(runContext.userId === undefined
          ? {}
          : { user_id: runContext.userId }),
        device_id: request.device_context.device_id,
        payload: { error_name: safeErrorName(error) },
      });
      return this.fallback(runContext, fallbackModeFor(error, timedOut));
    } finally {
      clearTimeout(timeout);
    }
  }

  private prepareRunContext(request: InteractionRequest): RunContext {
    const userId = request.device_context.user_id;
    const conversationKey = makeConversationKey(
      userId ?? "anonymous",
      request.device_context.device_id,
    );
    const storedSession = this.database.getAgentSession(conversationKey);
    const requestedSession = request.session_id;
    const resumeSessionId =
      requestedSession && storedSession?.session_id === requestedSession
        ? requestedSession
        : storedSession?.session_id;
    return {
      request,
      conversationKey,
      ...(userId === undefined ? {} : { userId }),
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    };
  }

  private async publishSdkEvent(
    options: InteractionRunOptions,
    event: SDKMessage,
  ): Promise<void> {
    if (!options.onSdkEvent) return;
    try {
      await options.onSdkEvent(event);
    } catch {
      // A disconnected stream consumer must never cancel the Agent or safety path.
    }
  }

  private recordProviderFallback(
    runContext: RunContext,
    reasonCode: string,
  ): void {
    this.database.recordInteractionEvent({
      event_type: "provider_profile_fallback",
      occurred_at: this.now().toISOString(),
      ...(runContext.userId === undefined
        ? {}
        : { user_id: runContext.userId }),
      device_id: runContext.request.device_context.device_id,
      payload: {
        provider_id: this.config.providerProfile.providerId,
        reason_code: reasonCode,
      },
    });
  }

  private fallback(
    runContext: RunContext,
    reason: FallbackReason,
  ): InteractionResponse {
    const decision = createFallbackDecision(runContext.request, {
      reason,
      now: this.now(),
    });
    this.persistDecision(runContext, decision, "fallback");
    if (reason !== "missing_api_key") {
      this.recordProviderFallback(runContext, reason);
    }

    return interactionResponseSchema.parse({
      decision,
      ...(runContext.resumeSessionId === undefined
        ? {}
        : { session_id: runContext.resumeSessionId }),
      mode: "fallback",
    });
  }

  private persistDecision(
    runContext: RunContext,
    decision: AgentDecision,
    mode: "claude" | "fallback",
  ): void {
    this.database.recordInteractionEvent({
      event_type: "agent_decision",
      occurred_at: this.now().toISOString(),
      ...(runContext.userId === undefined
        ? {}
        : { user_id: runContext.userId }),
      device_id: runContext.request.device_context.device_id,
      ...(decision.skill_request === undefined
        ? {}
        : { request_id: decision.skill_request.request_id }),
      payload: {
        mode,
        expression: decision.expression,
        emotion_state: decision.emotion.state,
        requested_skill: decision.skill_request?.skill ?? null,
        used_evidence_ids: decision.used_evidence_ids ?? [],
        actions_taken: decision.actions_taken ?? [],
      },
    });
  }
}
