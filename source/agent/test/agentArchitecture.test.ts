import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import {
  createClaudeOptions,
  HshhAgent,
  normalizeAgentDecisionOutput,
} from "../src/agent/hshhAgent.js";
import { createHshhToolServers } from "../src/agent/tools.js";
import { loadConfig } from "../src/config.js";
import type { InteractionRequest } from "../src/domain/contracts.js";
import { EventContextGateway } from "../src/gateway/EventContextGateway.js";
import { AvatarMetadataPipeline } from "../src/mcp/avatarServer.js";
import { createRuntimePolicy } from "../src/security/runtimePolicy.js";
import { HshhDatabase } from "../src/store/database.js";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const projectRoot = resolve(import.meta.dirname, "..");

function request(): InteractionRequest {
  return {
    request_id: "turn-1",
    transcript: "你好，陪我待一会儿。",
    device_context: {
      device_id: "robot-1",
      user_id: "user-1",
      observed_at: NOW.toISOString(),
      presence: "present",
      pose: "upright",
      battery: "normal",
      safety_state: "ready",
    },
  };
}

function config(root: string) {
  return loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_API_KEY: "test-only-key",
      ANTHROPIC_MODEL: "sonnet",
      HSHH_PROVIDER_VERIFIED: "true",
      HSHH_SESSION_ROOT: join(root, "sessions"),
      HSHH_SKILLS_ROOT: join(projectRoot, ".claude", "skills"),
      HSHH_DATABASE_PATH: ":memory:",
      HSHH_SANDBOX_FAIL_CLOSED: "true",
    },
    projectRoot,
  );
}

test("Agent options preserve Claude Code native tools and exactly six scoped MCP servers", async () => {
  const root = mkdtempSync(join(tmpdir(), "hshh-agent-options-"));
  const database = new HshhDatabase(":memory:", { now: () => NOW });
  try {
    const workspace = join(root, "workspace");
    const gateway = new EventContextGateway({ now: () => NOW });
    gateway.updateDeviceContext(request().device_context);
    const runtime = createRuntimePolicy({
      workspaceRoot: workspace,
      allowedWebDomains: ["code.claude.com"],
      allowDeepResearch: false,
      database,
      userId: "user-1",
      deviceId: "robot-1",
      now: () => NOW,
    });
    const mcpServers = createHshhToolServers({
      request: request(),
      requestId: "turn-1",
      database,
      gateway,
      avatarPipeline: new AvatarMetadataPipeline({ now: () => NOW }),
      projectRoot,
      now: () => NOW,
    });
    const options = createClaudeOptions({
      config: config(root),
      systemPrompt: "HSHH test constitution",
      mcpServers,
      runtimePolicy: runtime,
      abortController: new AbortController(),
      workspace,
      taskMode: "companion",
    });

    assert.deepEqual(options.tools, { type: "preset", preset: "claude_code" });
    assert.deepEqual(Object.keys(options.mcpServers ?? {}).sort(), [
      "hshh_avatar",
      "hshh_context",
      "hshh_device",
      "hshh_diagnostics",
      "hshh_memory",
      "hshh_perception",
    ]);
    assert.equal(options.permissionMode, "default");
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(options.settingSources, ["project"]);
    assert.ok(Array.isArray(options.skills));
    assert.ok(options.allowedTools?.includes("Read"));
    assert.ok(options.allowedTools?.includes("Bash"));
    assert.ok(options.allowedTools?.includes("StructuredOutput"));
    assert.equal(options.agents, undefined);
    assert.equal(options.env?.["HSHH_DEVICE_TOKEN"], undefined);

    const permissionOptions = {
      signal: new AbortController().signal,
      toolUseID: "tool-use-1",
      requestId: "permission-1",
    };
    assert.equal(
      (await runtime.canUseTool("StructuredOutput", {}, permissionOptions))
        ?.behavior,
      "allow",
    );
    assert.equal(
      (
        await runtime.canUseTool(
          "Write",
          { file_path: join(workspace, "report.md"), content: "ok" },
          permissionOptions,
        )
      )?.behavior,
      "allow",
    );
    assert.equal(
      (
        await runtime.canUseTool(
          "Write",
          { file_path: "/tmp/outside.md", content: "no" },
          permissionOptions,
        )
      )?.behavior,
      "deny",
    );
    assert.equal(
      (
        await runtime.canUseTool(
          "Bash",
          { command: "python -c 'open(\"/dev/ttyUSB0\")'" },
          permissionOptions,
        )
      )?.behavior,
      "deny",
    );
    assert.equal(
      (await runtime.canUseTool("Agent", {}, permissionOptions))?.behavior,
      "deny",
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes provider placeholders before strict decision validation", () => {
  assert.deepEqual(
    normalizeAgentDecisionOutput({
      reply_text: "你好。",
      robot_expression: null,
      skill_request: {},
      memory_candidate: null,
      confirmation_scope: "",
      visual_guidance: null,
      used_evidence_ids: [],
    }),
    {
      reply_text: "你好。",
      used_evidence_ids: [],
    },
  );
});

test("recovers a valid compatible-provider StructuredOutput tool candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "hshh-agent-provider-output-"));
  const database = new HshhDatabase(":memory:", { now: () => NOW });
  const candidate = {
    reply_text: "你好，我在。",
    expression: "listening",
    robot_expression: null,
    emotion: {
      state: "unknown",
      valence: 0,
      arousal: 0.2,
      engagement: 0.4,
      confidence: 0.3,
      evidence: ["semantics"],
      observed_signals: ["用户主动打招呼"],
      alternative_states: [],
      user_confirmed: false,
      expires_at: "2026-08-14T12:02:00.000Z",
    },
    skill_request: null,
    memory_candidate: null,
    actions_taken: [],
    requires_user_confirmation: false,
    confirmation_scope: "",
    used_evidence_ids: [],
    output_modalities: ["speech", "display"],
    visual_guidance: null,
  };
  const fakeQuery = (() =>
    (async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-provider-output",
              name: "StructuredOutput",
              input: candidate,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "session-provider-output",
        uuid: "00000000-0000-4000-8000-000000000010",
      } as unknown as SDKMessage;
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 5,
        duration_api_ms: 4,
        is_error: false,
        num_turns: 1,
        result: "",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        uuid: "00000000-0000-4000-8000-000000000011",
        session_id: "session-provider-output",
      } as unknown as SDKMessage;
    })()) as unknown as typeof query;

  try {
    const agent = new HshhAgent(database, config(root), {
      queryFactory: fakeQuery,
      now: () => NOW,
      projectRoot,
      gateway: new EventContextGateway({ now: () => NOW }),
      avatarPipeline: new AvatarMetadataPipeline({ now: () => NOW }),
    });
    const response = await agent.interact(request());
    assert.equal(response.mode, "claude");
    assert.equal(response.decision.reply_text, "你好，我在。");
    assert.equal(response.decision.robot_expression, undefined);
    assert.equal(response.decision.skill_request, undefined);
    assert.equal(response.decision.confirmation_scope, undefined);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("one recoverable SDK Agent session produces the structured v0.4 decision", async () => {
  const root = mkdtempSync(join(tmpdir(), "hshh-agent-run-"));
  const database = new HshhDatabase(":memory:", { now: () => NOW });
  let capturedOptions: Options | undefined;
  const structuredOutput = {
    reply_text: "我在这里，陪你待一会儿。",
    expression: "idle",
    robot_expression: {
      expression: "idle",
      intensity: 0.3,
      duration_ms: 2_000,
      reason: "安静陪伴的角色表达",
    },
    emotion: {
      state: "unknown",
      valence: 0,
      arousal: 0.2,
      engagement: 0.4,
      confidence: 0.3,
      evidence: ["semantics"],
      observed_signals: ["用户请求陪伴"],
      user_confirmed: false,
      expires_at: "2026-08-14T12:02:00.000Z",
    },
    requires_user_confirmation: false,
    used_evidence_ids: [],
    output_modalities: ["speech", "display"],
  };
  const fakeQuery = ((input: { options?: Options }) => {
    capturedOptions = input.options;
    return (async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: "result",
        subtype: "success",
        duration_ms: 5,
        duration_api_ms: 4,
        is_error: false,
        num_turns: 1,
        result: JSON.stringify(structuredOutput),
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        structured_output: structuredOutput,
        uuid: "00000000-0000-4000-8000-000000000001",
        session_id: "session-1",
      } as unknown as SDKMessage;
    })() as ReturnType<typeof query>;
  }) as typeof query;

  try {
    const gateway = new EventContextGateway({ now: () => NOW });
    const agent = new HshhAgent(database, config(root), {
      queryFactory: fakeQuery,
      now: () => NOW,
      projectRoot,
      gateway,
      avatarPipeline: new AvatarMetadataPipeline({ now: () => NOW }),
    });
    const response = await agent.interact(request());
    assert.equal(response.mode, "claude");
    assert.equal(response.session_id, "session-1");
    assert.equal(response.decision.emotion.state, "unknown");
    assert.deepEqual(response.decision.output_modalities, ["speech", "display"]);
    assert.equal(capturedOptions?.tools && !Array.isArray(capturedOptions.tools)
      ? capturedOptions.tools.preset
      : undefined, "claude_code");
    assert.equal(Object.keys(capturedOptions?.mcpServers ?? {}).length, 6);
    assert.equal(
      database.getAgentSession("user-1:robot-1")?.session_id,
      "session-1",
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
