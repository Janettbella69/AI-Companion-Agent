import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

import type { InteractionRequest } from "../src/domain/contracts.js";
import {
  HSHH_DEVICE_TOOL_NAMES,
  createHshhDeviceServer,
  createHshhDeviceTools,
  type HshhDeviceEffect,
} from "../src/mcp/deviceServer.js";
import {
  HSHH_MEMORY_TOOL_NAMES,
  createHshhMemoryServer,
  createHshhMemoryTools,
} from "../src/mcp/memoryServer.js";
import { HshhDatabase } from "../src/store/database.js";

const NOW = new Date("2026-08-14T20:00:00.000Z");

function createDatabase(): HshhDatabase {
  let nextId = 0;
  return new HshhDatabase(":memory:", {
    now: () => NOW,
    idFactory: () => `mcp-test-${++nextId}`,
  });
}

function interaction(hasConflict = false): InteractionRequest {
  return {
    transcript: "可以靠近一点",
    device_context: {
      device_id: "robot-1",
      user_id: "user-1",
      observed_at: NOW.toISOString(),
      presence: "present",
      distance_cm: 80,
      distance_source: "hc_sr04",
      distance_observed_at: NOW.toISOString(),
      distance_valid: true,
      pose: "upright",
      battery: "normal",
      safety_state: "ready",
    },
    consent: {
      approach: true,
      hug: false,
      token: "consent-1",
      scopes: ["approach_short"],
      granted_at: new Date(NOW.getTime() - 1_000).toISOString(),
      expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    },
    multimodal_context: {
      context_id: "context-1",
      window_started_at: new Date(NOW.getTime() - 5_000).toISOString(),
      window_ended_at: NOW.toISOString(),
      evidence: [],
      unavailable_modalities: [],
      has_conflict: hasConflict,
    },
  };
}

async function callTool(
  tools: Array<SdkMcpToolDefinition<any>>,
  name: string,
  input: Record<string, unknown>,
) {
  const definition = tools.find((candidate) => candidate.name === name);
  assert.ok(definition, `Missing MCP tool ${name}`);
  const result = await definition.handler(input, {});
  assert.ok(result.structuredContent);
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  assert.deepEqual(JSON.parse(text.text), result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function sideEffectEnvelope(requestId: string) {
  return {
    actor_user_id: "user-1",
    device_id: "robot-1",
    request_id: requestId,
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    expected_device_state: "ready",
    reason: "用户明确请求，执行抽象设备能力",
  };
}

function memoryEnvelope(requestId: string) {
  return {
    ...sideEffectEnvelope(requestId),
    user_id: "user-1",
  };
}

describe("hshh_device MCP", () => {
  it("exports exactly five request-scoped semantic tools", () => {
    const database = createDatabase();
    try {
      const context = {
        request: interaction(),
        requestId: "turn-device-tools",
        database,
        now: () => NOW,
      };
      assert.deepEqual(
        createHshhDeviceTools(context).map((item) => item.name),
        HSHH_DEVICE_TOOL_NAMES,
      );
      const server = createHshhDeviceServer(context);
      assert.equal(server.type, "sdk");
      assert.equal(server.name, "hshh_device");
    } finally {
      database.close();
    }
  });

  it("returns matching text and structuredContent and audits effects", async () => {
    const database = createDatabase();
    const effects: HshhDeviceEffect[] = [];
    try {
      const tools = createHshhDeviceTools({
        request: interaction(),
        requestId: "turn-device-effects",
        database,
        now: () => NOW,
        dispatch: async (effect) => {
          effects.push(effect);
          return { status: "completed", reason_code: "simulator_completed" };
        },
      });
      const expression = await callTool(tools, "set_expression", {
        ...sideEffectEnvelope("turn-device-effects"),
        expression: "noticed",
        intensity: 0.6,
        duration_ms: 2_000,
      });
      assert.equal(expression.status, "completed");
      assert.equal(expression.reason_code, "simulator_completed");

      const sound = await callTool(tools, "play_sound", {
        ...sideEffectEnvelope("turn-device-effects"),
        sound: "notice",
      });
      assert.equal(sound.status, "completed");
      assert.equal(effects.length, 2);

      const audits = database.listInteractionEvents({
        device_id: "robot-1",
        event_type: "mcp_device_set_expression",
      });
      assert.equal(audits.length, 1);
      assert.equal(audits[0]?.payload?.status, "completed");
    } finally {
      database.close();
    }
  });

  it("passes multimodal conflict strictly to policy and rejects raw hardware", async () => {
    const database = createDatabase();
    let dispatchCount = 0;
    try {
      const conflicted = createHshhDeviceTools({
        request: interaction(true),
        requestId: "turn-device-conflict",
        database,
        now: () => NOW,
        dispatch: async () => {
          dispatchCount += 1;
          return { status: "accepted", reason_code: "queued" };
        },
      });
      const rejected = await callTool(conflicted, "request_safe_skill", {
        ...sideEffectEnvelope("turn-device-conflict"),
        skill: "approach_short",
        consent_token: "consent-1",
      });
      assert.equal(rejected.status, "rejected");
      assert.equal(rejected.reason_code, "multimodal_conflict");
      assert.equal(dispatchCount, 0);

      const raw = await callTool(conflicted, "set_expression", {
        ...sideEffectEnvelope("turn-device-conflict"),
        expression: "idle",
        intensity: 0.2,
        duration_ms: 1_000,
        pwm: 180,
      });
      assert.equal(raw.status, "rejected");
      assert.equal(raw.reason_code, "raw_hardware_parameters_forbidden");
    } finally {
      database.close();
    }
  });

  it("emits only a policy-authored high-level command and exposes status", async () => {
    const database = createDatabase();
    let delivered: HshhDeviceEffect | undefined;
    try {
      const tools = createHshhDeviceTools({
        request: interaction(),
        requestId: "turn-device-skill",
        database,
        now: () => NOW,
        dispatch: async (effect) => {
          delivered = effect;
          return { status: "accepted", reason_code: "skill_queued" };
        },
      });
      const skill = await callTool(tools, "request_safe_skill", {
        ...sideEffectEnvelope("turn-device-skill"),
        skill: "approach_short",
        consent_token: "consent-1",
      });
      assert.equal(skill.status, "accepted");
      const command = skill.command as Record<string, unknown>;
      assert.equal(command.device_id, "robot-1");
      assert.equal(command.expected_device_state, "ready");
      assert.equal(command.reason, "用户明确请求，执行抽象设备能力");
      assert.equal("pwm" in command, false);
      assert.equal("speed" in command, false);
      assert.equal(delivered?.type, "safe_skill");

      const status = await callTool(tools, "get_skill_status", {
        actor_user_id: "user-1",
        device_id: "robot-1",
      });
      assert.equal(status.status, "completed");
      assert.equal(status.reason_code, "skill_status_read");

      const scopeMismatch = await callTool(tools, "get_skill_status", {
        actor_user_id: "another-user",
        device_id: "robot-1",
      });
      assert.equal(scopeMismatch.reason_code, "user_scope_mismatch");
    } finally {
      database.close();
    }
  });

  it("allows a consented unsensored approach when the idle controller is stopped", async () => {
    const database = createDatabase();
    const request = interaction();
    request.device_context = {
      device_id: "robot-1",
      user_id: "user-1",
      observed_at: NOW.toISOString(),
      presence: "unknown",
      pose: "unknown",
      battery: "unknown",
      safety_state: "stopped",
    };
    try {
      const tools = createHshhDeviceTools({
        request,
        requestId: "turn-unsensored-skill",
        database,
        now: () => NOW,
        allowUnsensoredMotion: true,
        dispatch: async () => ({
          status: "accepted",
          reason_code: "motion_command_accepted",
        }),
      });
      const skill = await callTool(tools, "request_safe_skill", {
        ...sideEffectEnvelope("turn-unsensored-skill"),
        expected_device_state: "stopped",
        skill: "approach_short",
        consent_token: "consent-1",
      });
      assert.equal(skill.status, "accepted");
      const command = skill.command as Record<string, unknown>;
      assert.equal(command.expected_device_state, "stopped");
      assert.equal(command.skill, "approach_short");
    } finally {
      database.close();
    }
  });

  it("keeps stop available during a local fault", async () => {
    const database = createDatabase();
    const request = interaction();
    request.device_context = {
      ...request.device_context,
      pose: "fallen",
      safety_state: "fault",
    };
    try {
      const tools = createHshhDeviceTools({
        request,
        requestId: "turn-device-stop",
        database,
        now: () => NOW,
        dispatch: async () => ({
          status: "accepted",
          reason_code: "local_stop_dispatched",
        }),
      });
      const stopped = await callTool(tools, "stop", {
        ...sideEffectEnvelope("turn-device-stop"),
        expected_device_state: "ready",
      });
      assert.equal(stopped.status, "accepted");
      assert.equal((stopped.command as Record<string, unknown>).skill, "stop");
    } finally {
      database.close();
    }
  });

  it("rejects a side-effect envelope from another turn before dispatch", async () => {
    const database = createDatabase();
    let dispatchCount = 0;
    try {
      const tools = createHshhDeviceTools({
        request: interaction(),
        requestId: "turn-device-bound",
        database,
        now: () => NOW,
        dispatch: async () => {
          dispatchCount += 1;
          return { status: "completed", reason_code: "unexpected_dispatch" };
        },
      });
      const result = await callTool(tools, "set_expression", {
        ...sideEffectEnvelope("another-turn"),
        expression: "noticed",
        intensity: 0.5,
        duration_ms: 1_000,
      });

      assert.equal(result.status, "rejected");
      assert.equal(result.reason_code, "turn_request_mismatch");
      assert.equal(dispatchCount, 0);
    } finally {
      database.close();
    }
  });
});

describe("hshh_memory MCP", () => {
  it("exports five scoped tools and enforces the opt-in lifecycle", async () => {
    const database = createDatabase();
    try {
      const context = {
        request: interaction(),
        requestId: "turn-memory-tools",
        database,
        now: () => NOW,
      };
      const tools = createHshhMemoryTools(context);
      assert.deepEqual(
        tools.map((item) => item.name),
        HSHH_MEMORY_TOOL_NAMES,
      );
      const server = createHshhMemoryServer(context);
      assert.equal(server.name, "hshh_memory");

      const settings = await callTool(tools, "get_memory_settings", {
        actor_user_id: "user-1",
        user_id: "user-1",
        device_id: "robot-1",
      });
      assert.equal(settings.enabled, false);

      const disabledTools = createHshhMemoryTools({
        ...context,
        requestId: "turn-memory-disabled",
      });
      const disabled = await callTool(disabledTools, "propose_memory", {
        ...memoryEnvelope("turn-memory-disabled"),
        kind: "preference",
        summary: "用户累的时候喜欢安静陪伴",
        source: "explicit_user",
        requires_confirmation: true,
      });
      assert.equal(disabled.status, "rejected");
      assert.equal(disabled.reason_code, "memory_disabled");

      database.setMemoryEnabled("user-1", true);
      const proposedTools = createHshhMemoryTools({
        ...context,
        requestId: "turn-memory-propose",
      });
      const proposed = await callTool(proposedTools, "propose_memory", {
        ...memoryEnvelope("turn-memory-propose"),
        kind: "preference",
        summary: "用户累的时候喜欢安静陪伴",
        source: "explicit_user",
        requires_confirmation: true,
      });
      assert.equal(proposed.status, "completed");
      const memoryId = proposed.candidate_id;
      assert.equal(typeof memoryId, "string");

      const beforeConfirm = await callTool(tools, "recall_memories", {
        actor_user_id: "user-1",
        user_id: "user-1",
        device_id: "robot-1",
        limit: 5,
      });
      assert.deepEqual(beforeConfirm.memories, []);

      const confirmTools = createHshhMemoryTools({
        ...context,
        requestId: "turn-memory-confirm",
      });
      const confirmed = await callTool(confirmTools, "confirm_memory", {
        ...memoryEnvelope("turn-memory-confirm"),
        memory_id: memoryId,
      });
      assert.equal(confirmed.reason_code, "memory_confirmed");

      const recalled = await callTool(tools, "recall_memories", {
        actor_user_id: "user-1",
        user_id: "user-1",
        device_id: "robot-1",
        query: "安静",
        limit: 5,
      });
      assert.equal((recalled.memories as unknown[]).length, 1);

      const forgetTools = createHshhMemoryTools({
        ...context,
        requestId: "turn-memory-forget",
      });
      const forgotten = await callTool(forgetTools, "forget_memory", {
        ...memoryEnvelope("turn-memory-forget"),
        memory_id: memoryId,
      });
      assert.equal(forgotten.reason_code, "memory_forgotten");
      assert.deepEqual(database.recallMemories("user-1"), []);

      const audit = database.listInteractionEvents({
        event_type: "mcp_memory_propose_memory",
      });
      assert.equal(audit.length, 2);
      assert.equal("summary" in (audit[0]?.payload ?? {}), false);
    } finally {
      database.close();
    }
  });

  it("rejects inferred memory and cross-user access", async () => {
    const database = createDatabase();
    database.setMemoryEnabled("user-1", true);
    try {
      const tools = createHshhMemoryTools({
        request: interaction(),
        requestId: "turn-memory-inferred",
        database,
        now: () => NOW,
      });
      const inferred = await callTool(tools, "propose_memory", {
        ...memoryEnvelope("turn-memory-inferred"),
        kind: "profile",
        summary: "看起来用户可能患有抑郁",
        source: "explicit_user",
        requires_confirmation: true,
      });
      assert.equal(inferred.reason_code, "memory_candidate_not_explicit");

      const crossUser = await callTool(tools, "recall_memories", {
        actor_user_id: "user-2",
        user_id: "user-2",
        device_id: "robot-1",
        limit: 5,
      });
      assert.equal(crossUser.status, "rejected");
      assert.equal(crossUser.reason_code, "user_scope_mismatch");
    } finally {
      database.close();
    }
  });

  it("rejects a memory mutation from another turn", async () => {
    const database = createDatabase();
    database.setMemoryEnabled("user-1", true);
    try {
      const tools = createHshhMemoryTools({
        request: interaction(),
        requestId: "turn-memory-bound",
        database,
        now: () => NOW,
      });
      const result = await callTool(tools, "propose_memory", {
        ...memoryEnvelope("another-turn"),
        kind: "preference",
        summary: "用户喜欢安静陪伴",
        source: "explicit_user",
        requires_confirmation: true,
      });

      assert.equal(result.status, "rejected");
      assert.equal(result.reason_code, "turn_request_mismatch");
      assert.deepEqual(database.listMemories("user-1"), []);
    } finally {
      database.close();
    }
  });
});
