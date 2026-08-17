import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import sharp from "sharp";
import {
  AvatarMetadataPipeline,
  createHshhAvatarMcpServer,
  HSHH_AVATAR_TOOL_NAMES,
  MAX_AVATAR_SOURCE_BYTES,
  validateAvatarManifest,
  validateDeviceAvatarManifest,
} from "../src/mcp/avatarServer.js";
import {
  createHshhDiagnosticsMcpServer,
  HSHH_DIAGNOSTICS_TOOL_NAMES,
} from "../src/mcp/diagnosticsServer.js";
import { HshhDatabase } from "../src/store/database.js";

const NOW = new Date("2026-08-14T18:00:00.000Z");
const REQUEST_ID = "request-avatar-1";
const DEVICE_ID = "device-1";

function databaseFixture(): HshhDatabase {
  let id = 0;
  return new HshhDatabase(":memory:", {
    now: () => new Date(NOW),
    idFactory: () => `db-${++id}`,
  });
}

function pipelineFixture(): AvatarMetadataPipeline {
  let id = 0;
  return new AvatarMetadataPipeline({
    now: () => new Date(NOW),
    idFactory: () => `pipeline-${++id}`,
    assetRoot: join(tmpdir(), `hshh-avatar-test-${randomUUID()}`),
  });
}

async function withClient<T>(
  server: McpSdkServerConfigWithInstance,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "avatar-diagnostics-test", version: "0.1.0" });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.instance.close();
  }
}

function structured(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function assertMcpEnvelope(response: unknown): Record<string, unknown> {
  const envelope = structured(response);
  const output = structured(envelope["structuredContent"]);
  assert.equal(typeof output["status"], "string");
  assert.equal(typeof output["reason_code"], "string");
  assert.ok(Array.isArray(envelope["content"]));
  assert.ok(
    (envelope["content"] as Array<{ type?: unknown }>).some(
      (block) => block.type === "text",
    ),
  );
  return output;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("hshh_avatar validates metadata, composes exactly 9x5, previews and atomically activates", async () => {
  const database = databaseFixture();
  const pipeline = pipelineFixture();
  const sourceBytes = await sharp({
    create: {
      width: 360,
      height: 480,
      channels: 3,
      background: { r: 120, g: 130, b: 140 },
    },
  }).png().toBuffer();
  const checksum = createHash("sha256").update(sourceBytes).digest("hex");
  const assetRef = pipeline.stageAsset(
    {
      device_id: DEVICE_ID,
      request_id: REQUEST_ID,
      pet_id: "mimi",
      asset_version: "1.0.0",
      mime_type: "image/png",
      byte_length: sourceBytes.byteLength,
      width: 360,
      height: 480,
      header_hex: sourceBytes.subarray(0, 32).toString("hex"),
      checksum_sha256: checksum,
      computed_checksum_sha256: checksum,
    },
    sourceBytes,
  );
  sourceBytes.fill(0);
  const server = createHshhAvatarMcpServer({
    database,
    pipeline,
    deviceId: DEVICE_ID,
    requestId: REQUEST_ID,
  });

  try {
    await withClient(server, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((item) => `mcp__hshh_avatar__${item.name}`).sort(),
        [...HSHH_AVATAR_TOOL_NAMES].sort(),
      );

      const validatedResponse = await client.callTool({
        name: "validate_asset",
        arguments: {
          device_id: DEVICE_ID,
          request_id: REQUEST_ID,
          asset_ref: assetRef,
        },
      });
      const validated = assertMcpEnvelope(validatedResponse);
      assert.equal(validated["status"], "completed");
      assert.equal(validated["reason_code"], "asset_metadata_valid");

      const identityResponse = await client.callTool({
        name: "generate_identity",
        arguments: {
          device_id: DEVICE_ID,
          request_id: REQUEST_ID,
          validation_id: validated["validation_id"],
          pet_type: "cat",
          visible_traits: ["gray fur", "white paws", "round ears"],
        },
      });
      const identity = assertMcpEnvelope(identityResponse);
      assert.equal(identity["reason_code"], "identity_spec_created");
      assert.equal(identity["deterministic_composition"], true);

      const composedResponse = await client.callTool({
        name: "compose_expression_pack",
        arguments: {
          device_id: DEVICE_ID,
          request_id: REQUEST_ID,
          identity_id: identity["identity_id"],
        },
      });
      const composed = assertMcpEnvelope(composedResponse);
      assert.equal(composed["reason_code"], "expression_pack_ready");
      assert.equal(composed["generated_files"], 93);
      assert.equal(composed["original_photo_deleted"], true);
      const asset = structured(composed["asset"]);
      assert.equal(asset["status"], "ready");
      const manifest = structured(asset["manifest"]);
      const manifestValidation = validateAvatarManifest(manifest);
      assert.equal(manifestValidation.valid, true);
      assert.equal(manifestValidation.expression_count, 9);
      assert.equal(manifestValidation.frame_count, 45);
      const deviceValidation = validateDeviceAvatarManifest(
        manifest["device_package"],
      );
      assert.equal(deviceValidation.valid, true);
      assert.equal(deviceValidation.expression_count, 9);
      assert.equal(deviceValidation.frame_count, 45);

      const previewResponse = await client.callTool({
        name: "preview_pack",
        arguments: {
          device_id: DEVICE_ID,
          request_id: REQUEST_ID,
          asset_id: asset["id"],
        },
      });
      const preview = assertMcpEnvelope(previewResponse);
      assert.equal(preview["status"], "completed");
      assert.equal(structured(preview["preview"])["total_frames"], 45);

      const activatedResponse = await client.callTool({
        name: "activate_pack",
        arguments: {
          device_id: DEVICE_ID,
          request_id: REQUEST_ID,
          asset_id: asset["id"],
        },
      });
      const activated = assertMcpEnvelope(activatedResponse);
      assert.equal(activated["reason_code"], "pack_atomically_activated");
      assert.equal(database.getActivePetAsset(DEVICE_ID)?.id, asset["id"]);

      const wrongScopeResponse = await client.callTool({
        name: "preview_pack",
        arguments: {
          device_id: DEVICE_ID,
          request_id: "another-request",
          asset_id: asset["id"],
        },
      });
      assert.equal(
        assertMcpEnvelope(wrongScopeResponse)["reason_code"],
        "request_scope_mismatch",
      );
    });
  } finally {
    database.close();
  }
});

test("avatar validation and activation failures never replace the active package", async () => {
  const database = databaseFixture();
  const pipeline = pipelineFixture();
  const validManifest = {
    schema_version: 1,
    pet_id: "active-pet",
    asset_version: "stable",
    display_mode: "pet",
    width: 240,
    height: 320,
    pixel_format: "RGB565",
    identity: { path: "identity.png", sha256: "1".repeat(64) },
    expressions: Object.fromEntries(
      [
        "idle",
        "noticed",
        "listening",
        "thinking",
        "happy",
        "confused",
        "sad",
        "sleeping",
        "angry",
      ].map((expression) => [
        expression,
        Array.from({ length: 5 }, (_, index) => ({
          path: `expressions/${expression}/${index + 1}.png`,
          sha256: sha256(`${expression}:${index}`),
        })),
      ]),
    ),
  };
  const active = database.createPetAsset({
    device_id: DEVICE_ID,
    pet_id: "active-pet",
    asset_version: "stable",
    manifest: validManifest,
    checksum_sha256: sha256(JSON.stringify(validManifest)),
    status: "ready",
  });
  database.activatePetAsset(DEVICE_ID, active.id);

  const oversizedRef = pipeline.stageAsset({
    device_id: DEVICE_ID,
    request_id: REQUEST_ID,
    pet_id: "new-pet",
    asset_version: "oversized",
    mime_type: "image/png",
    byte_length: MAX_AVATAR_SOURCE_BYTES + 1,
    width: 1024,
    height: 1024,
    header_hex: "89504e470d0a1a0a",
    checksum_sha256: "a".repeat(64),
    computed_checksum_sha256: "a".repeat(64),
  });
  const corruptManifest = {
    schema_version: 1,
    pet_id: "new-pet",
    asset_version: "broken",
    display_mode: "pet",
    width: 240,
    height: 320,
    identity: { path: "identity.png", sha256: "b".repeat(64) },
    expressions: { idle: [] },
  };
  const corrupt = database.createPetAsset({
    device_id: DEVICE_ID,
    pet_id: "new-pet",
    asset_version: "broken",
    manifest: corruptManifest,
    checksum_sha256: sha256(JSON.stringify(corruptManifest)),
    status: "ready",
  });
  const server = createHshhAvatarMcpServer({
    database,
    pipeline,
    deviceId: DEVICE_ID,
    requestId: REQUEST_ID,
  });

  try {
    await withClient(server, async (client) => {
      const oversized = assertMcpEnvelope(
        await client.callTool({
          name: "validate_asset",
          arguments: {
            device_id: DEVICE_ID,
            request_id: REQUEST_ID,
            asset_ref: oversizedRef,
          },
        }),
      );
      assert.equal(oversized["reason_code"], "asset_size_invalid");
      assert.equal(database.getActivePetAsset(DEVICE_ID)?.id, active.id);

      const failedActivation = assertMcpEnvelope(
        await client.callTool({
          name: "activate_pack",
          arguments: {
            device_id: DEVICE_ID,
            request_id: REQUEST_ID,
            asset_id: corrupt.id,
          },
        }),
      );
      assert.equal(failedActivation["status"], "failed");
      assert.equal(failedActivation["active_asset_unchanged"], true);
      assert.equal(database.getActivePetAsset(DEVICE_ID)?.id, active.id);
    });
  } finally {
    database.close();
  }
});

test("hshh_diagnostics exposes four read-only redacted metadata tools", async () => {
  const database = databaseFixture();
  database.upsertDeviceContext({
    device_id: DEVICE_ID,
    observed_at: NOW.toISOString(),
    presence: "present",
    pose: "upright",
    battery: "normal",
    safety_state: "ready",
  });
  database.recordInteractionEvent({
    event_type: "skill_stopped",
    occurred_at: NOW.toISOString(),
    device_id: DEVICE_ID,
    request_id: REQUEST_ID,
    payload: {
      reason: "obstacle",
      api_key: "never-return-this-secret",
      nested: { wifi_password: "also-secret" },
      raw_image_base64: "raw-image-payload",
    },
  });
  let bugId = 0;
  const server = createHshhDiagnosticsMcpServer({
    database,
    deviceId: DEVICE_ID,
    requestId: REQUEST_ID,
    now: () => new Date(NOW),
    idFactory: () => `bundle-${++bugId}`,
    firmware: [
      {
        component: "t5",
        version: "1.0.0",
        build_id: "mock-build",
        state: "ready",
        observed_at: NOW.toISOString(),
      },
      {
        component: "agent_service",
        version: "0.1.0",
        state: "ready",
        observed_at: NOW.toISOString(),
      },
    ],
  });

  try {
    await withClient(server, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools
          .map((item) => `mcp__hshh_diagnostics__${item.name}`)
          .sort(),
        [...HSHH_DIAGNOSTICS_TOOL_NAMES].sort(),
      );
      assert.ok(listed.tools.every((item) => item.annotations?.readOnlyHint === true));
      assert.ok(
        listed.tools.every(
          (item) => !/(?:flash|reboot|restart|gpio)/iu.test(item.name),
        ),
      );

      const logsResponse = await client.callTool({
        name: "get_logs",
        arguments: {
          device_id: DEVICE_ID,
          request_id: REQUEST_ID,
          limit: 10,
        },
      });
      const logs = assertMcpEnvelope(logsResponse);
      assert.equal(logs["reason_code"], "structured_logs_returned");
      const serializedLogs = JSON.stringify(logs);
      assert.doesNotMatch(serializedLogs, /never-return-this-secret|also-secret|raw-image-payload/u);
      assert.match(serializedLogs, /\[REDACTED\]/u);
      assert.match(serializedLogs, /obstacle/u);

      const selfTest = assertMcpEnvelope(
        await client.callTool({
          name: "run_self_test",
          arguments: { device_id: DEVICE_ID, request_id: REQUEST_ID },
        }),
      );
      assert.equal(selfTest["reason_code"], "read_only_self_test_completed");
      assert.match(String(selfTest["safety_note"]), /does not access GPIO/u);

      const firmware = assertMcpEnvelope(
        await client.callTool({
          name: "get_firmware_status",
          arguments: { device_id: DEVICE_ID, request_id: REQUEST_ID },
        }),
      );
      assert.equal(firmware["reason_code"], "firmware_metadata_returned");
      assert.equal((firmware["components"] as unknown[]).length, 2);

      const bugBundle = assertMcpEnvelope(
        await client.callTool({
          name: "collect_bug_bundle",
          arguments: {
            device_id: DEVICE_ID,
            request_id: REQUEST_ID,
            log_limit: 10,
          },
        }),
      );
      assert.equal(bugBundle["reason_code"], "metadata_bug_bundle_collected");
      const bundle = structured(bugBundle["bundle"]);
      assert.equal(bundle["metadata_only"], true);
      assert.equal(bundle["redacted"], true);
      assert.equal("logs" in bundle, false);
      assert.ok(Array.isArray(bundle["log_event_ids"]));
    });
  } finally {
    database.close();
  }
});
