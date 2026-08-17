import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";

import {
  LanCameraAdapter,
  type LanCameraAdapterOptions,
} from "../src/device/lanCameraAdapter.js";
import { loadConfig } from "../src/config.js";

const NOW = new Date("2026-08-15T10:00:00.000Z");
const SECRET = "camera-secret-0123456789abcdef-unique";
const JPEG = Buffer.from("ffd8ffe000104a4649460001ffd9", "hex");

function signedHeaders(
  timestamp: string,
  captureId: string,
  bytes: Buffer,
  secret = SECRET,
): { get(name: string): string | null } {
  const values = new Map<string, string>([
    ["content-type", "image/jpeg"],
    ["content-length", String(bytes.byteLength)],
    ["x-hshh-capture-id", captureId],
    ["x-hshh-observed-at", timestamp],
    ["x-hshh-timestamp", timestamp],
    [
      "x-hshh-signature",
      createHmac("sha256", secret)
        .update(timestamp)
        .update("\n")
        .update(bytes)
        .digest("hex"),
    ],
  ]);
  return { get: (name) => values.get(name.toLowerCase()) ?? null };
}

function adapter(
  fetchImpl: NonNullable<LanCameraAdapterOptions["fetchImpl"]>,
): LanCameraAdapter {
  return new LanCameraAdapter({
    baseUrl: "http://hshh-camera.local",
    sharedSecret: SECRET,
    now: () => new Date(NOW),
    idFactory: () => "capture-test-id",
    fetchImpl,
  });
}

describe("LanCameraAdapter", () => {
  test("sends the strict signed five-field request and accepts a signed JPEG", async () => {
    const camera = adapter(async (url, init) => {
      assert.equal(url.href, "http://hshh-camera.local/v1/camera/captures");
      const request = JSON.parse(init.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(request).sort(), [
        "capture_id",
        "expires_at",
        "issued_at",
        "robot_id",
        "trigger_reason",
      ]);
      assert.equal(request["capture_id"], "capture_capture-test-id");
      assert.equal(request["robot_id"], "robot-1");
      assert.equal(request["trigger_reason"], "presence_event");
      assert.equal(init.headers["idempotency-key"], request["capture_id"]);
      const expected = createHmac("sha256", SECRET)
        .update(NOW.toISOString())
        .update("\n")
        .update(init.body)
        .digest("hex");
      assert.equal(init.headers["x-hshh-signature"], expected);
      return {
        ok: true,
        status: 200,
        headers: signedHeaders(
          NOW.toISOString(),
          "capture_capture-test-id",
          JPEG,
        ),
        arrayBuffer: async () =>
          JPEG.buffer.slice(
            JPEG.byteOffset,
            JPEG.byteOffset + JPEG.byteLength,
          ) as ArrayBuffer,
      };
    });

    const result = await camera.capture("robot-1", "presence_event");
    assert.equal(result.status, "completed");
    if (result.status !== "completed") return;
    assert.equal(result.capture_id, "capture_capture-test-id");
    assert.equal(result.image.source, "esp32_cam");
    assert.equal("base64" in result.image, true);
  });

  test("fails closed on a mismatched response signature or capture ID", async () => {
    const camera = adapter(async () => ({
      ok: true,
      status: 200,
      headers: signedHeaders(
        NOW.toISOString(),
        "another-capture",
        JPEG,
        "wrong-secret-0123456789abcdef-0000",
      ),
      arrayBuffer: async () =>
        JPEG.buffer.slice(
          JPEG.byteOffset,
          JPEG.byteOffset + JPEG.byteLength,
        ) as ArrayBuffer,
    }));
    assert.deepEqual(await camera.capture("robot-1", "diagnostic"), {
      status: "failed",
      reason_code: "camera_response_auth_failed",
    });
  });

  test("accepts only private LAN origins and separate controller secrets", () => {
    assert.throws(
      () =>
        new LanCameraAdapter({
          baseUrl: "https://camera.example.com",
          sharedSecret: SECRET,
        }),
      /private-LAN/u,
    );
    assert.throws(
      () =>
        loadConfig(
          {
            HSHH_CAMERA_URL: "http://hshh-camera.local",
            HSHH_CAMERA_SHARED_SECRET: SECRET,
            HSHH_MOTION_CONTROLLER_URL: "http://hshh-motion.local",
            HSHH_MOTION_SHARED_SECRET: SECRET,
          },
          process.cwd(),
        ),
      /different secrets/u,
    );
  });
});
