import assert from "node:assert/strict";
import test from "node:test";
import type { DeviceContext, MemoryCandidate } from "../src/domain/contracts.js";
import { HshhDatabase, makeConversationKey } from "../src/store/database.js";

const now = "2026-08-14T20:00:00.000Z";

function createDatabase(): HshhDatabase {
  let nextId = 0;
  return new HshhDatabase(":memory:", {
    now: () => new Date(now),
    idFactory: () => `test-id-${++nextId}`,
  });
}

const quietPreference: MemoryCandidate = {
  kind: "preference",
  summary: "累的时候喜欢安静陪伴",
  source: "explicit_user",
  requires_confirmation: true,
};

test("long-term memory is disabled by default and proposals are not stored", () => {
  const database = createDatabase();
  try {
    assert.deepEqual(database.getMemorySetting("user-1"), {
      user_id: "user-1",
      enabled: false,
    });
    assert.equal(database.proposeMemory("user-1", quietPreference), null);
    assert.deepEqual(database.listMemories("user-1"), []);
  } finally {
    database.close();
  }
});

test("memory follows opt-in, confirmation, correction, recall and soft-delete rules", () => {
  const database = createDatabase();
  try {
    assert.deepEqual(database.setMemoryEnabled("user-1", true), {
      user_id: "user-1",
      enabled: true,
    });

    const preference = database.proposeMemory("user-1", quietPreference);
    assert.ok(preference);
    assert.equal(preference.confirmed, false);
    assert.deepEqual(database.recallMemories("user-1"), []);

    const boundary = database.proposeMemory("user-1", {
      kind: "boundary",
      summary: "不要在我拒绝后继续靠近",
      source: "explicit_user",
      requires_confirmation: true,
    });
    assert.ok(boundary);

    assert.equal(database.confirmMemory("user-1", preference.id)?.confirmed, true);
    assert.equal(database.confirmMemory("user-1", boundary.id)?.confirmed, true);
    assert.deepEqual(
      database.recallMemories("user-1").map((memory) => memory.kind),
      ["boundary", "preference"],
      "boundaries must be injected before ordinary preferences",
    );

    const updated = database.updateMemory("user-1", preference.id, {
      summary: "累的时候只想安静待着",
    });
    assert.equal(updated?.summary, "累的时候只想安静待着");
    assert.equal(
      database.recallMemories("user-1", "安静").some((memory) => memory.id === preference.id),
      true,
    );

    assert.equal(database.softDeleteMemory("user-1", preference.id), true);
    assert.equal(database.getMemory("user-1", preference.id), null);
    assert.equal(database.recallMemories("user-1", "安静").length, 0);
    assert.equal(
      database.getMemory("user-1", preference.id, true)?.deleted_at,
      now,
    );

    database.setMemoryEnabled("user-1", false);
    assert.deepEqual(database.recallMemories("user-1"), []);
    assert.equal(database.proposeMemory("user-1", quietPreference), null);
  } finally {
    database.close();
  }
});

test("device context, agent sessions and interaction events remain separate", () => {
  const database = createDatabase();
  try {
    const currentContext: DeviceContext = {
      device_id: "robot-1",
      user_id: "user-1",
      observed_at: "2026-08-14T19:59:59.000Z",
      presence: "present",
      distance_cm: 72,
      distance_source: "hc_sr04",
      distance_observed_at: "2026-08-14T19:59:59.000Z",
      distance_valid: true,
      gesture: "confirm",
      pose: "upright",
      battery: "normal",
      safety_state: "ready",
    };
    database.upsertDeviceContext(currentContext);

    database.upsertDeviceContext({
      ...currentContext,
      observed_at: "2026-08-14T19:59:00.000Z",
      distance_cm: 99,
    });
    assert.equal(database.getDeviceContext("robot-1")?.distance_cm, 72);

    const conversationKey = makeConversationKey("user-1", "robot-1");
    const session = database.saveAgentSession({
      conversation_key: conversationKey,
      session_id: "claude-session-1",
      user_id: "user-1",
      device_id: "robot-1",
    });
    assert.equal(session.session_id, "claude-session-1");
    assert.deepEqual(database.getAgentSession(conversationKey), session);

    const event = database.recordInteractionEvent({
      user_id: "user-1",
      device_id: "robot-1",
      event_type: "skill_stopped",
      request_id: "request-1",
      occurred_at: "2026-08-14T19:59:59.500Z",
      payload: { reason: "obstacle", distance_cm: 23 },
    });
    assert.equal(event.event_type, "skill_stopped");
    assert.deepEqual(event.payload, { reason: "obstacle", distance_cm: 23 });
    assert.equal(database.listInteractionEvents()[0]?.id, event.id);
    assert.equal(database.getInteractionEvent(event.id)?.id, event.id);

    database.recordInteractionEvent({
      device_id: "robot-2",
      event_type: "presence_detected",
      occurred_at: "2026-08-14T19:59:58.000Z",
    });
    assert.deepEqual(
      database.listInteractionEvents({
        device_id: "robot-1",
        event_type: "skill_stopped",
        request_id: "request-1",
      }).map((item) => item.id),
      [event.id],
    );

    assert.equal(database.listMemories("user-1").length, 0);
    assert.equal(database.deleteAgentSession(conversationKey), true);
    assert.equal(database.getAgentSession(conversationKey), null);
  } finally {
    database.close();
  }
});

test("pet asset metadata supports validation, status changes and atomic activation", () => {
  const database = createDatabase();
  try {
    const first = database.createPetAsset({
      device_id: "robot-1",
      pet_id: "mimi",
      asset_version: "1.0.0",
      manifest: {
        schema_version: 1,
        expressions: ["idle", "noticed", "listening"],
      },
      checksum_sha256: "A".repeat(64),
    });
    assert.equal(first.status, "pending");
    assert.equal(first.active, false);
    assert.equal(first.checksum_sha256, "a".repeat(64));
    assert.equal(database.activatePetAsset("robot-1", first.id), null);

    const readyFirst = database.updatePetAssetStatus(first.id, "ready");
    assert.equal(readyFirst?.status, "ready");
    assert.equal(database.activatePetAsset("robot-1", first.id)?.active, true);
    assert.equal(database.getActivePetAsset("robot-1")?.id, first.id);

    const second = database.createPetAsset({
      device_id: "robot-1",
      pet_id: "mimi",
      asset_version: "1.1.0",
      manifest: { schema_version: 1, asset_version: "1.1.0" },
      checksum_sha256: "b".repeat(64),
      status: "ready",
    });
    assert.equal(database.activatePetAsset("robot-1", second.id)?.status, "active");
    assert.equal(database.getActivePetAsset("robot-1")?.id, second.id);
    assert.equal(database.getPetAsset(first.id)?.status, "ready");
    assert.equal(database.getPetAsset(first.id)?.active, false);
    assert.deepEqual(
      database.listPetAssets("robot-1").map((asset) => asset.id),
      [second.id, first.id],
    );

    const failed = database.createPetAsset({
      device_id: "robot-1",
      pet_id: "mimi",
      asset_version: "broken",
      manifest: { schema_version: 1 },
      checksum_sha256: "c".repeat(64),
      status: "failed",
    });
    assert.equal(database.activatePetAsset("robot-1", failed.id), null);
    assert.throws(
      () =>
        database.createPetAsset({
          device_id: "robot-2",
          pet_id: "mimi",
          asset_version: "invalid-checksum",
          manifest: {},
          checksum_sha256: "not-a-checksum",
        }),
      /checksum_sha256/,
    );
  } finally {
    database.close();
  }
});
