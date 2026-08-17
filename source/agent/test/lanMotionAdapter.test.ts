import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";
import {
  HSHH_LAN_PROTOCOL_VERSION,
  LanMotionAdapter,
} from "../src/device/lanMotionAdapter.js";
import type { HshhDeviceEffect } from "../src/mcp/deviceServer.js";

const NOW = new Date("2026-08-14T20:00:00.000Z");
const SECRET = "test-only-motion-secret-32-bytes-minimum";

function sign(timestamp: string, body: string): string {
  return createHmac("sha256", SECRET)
    .update(timestamp)
    .update("\n")
    .update(body)
    .digest("hex");
}

function headers(values: Record<string, string>) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    get(name: string): string | null {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

function safeSkillEffect(
  skill: "stop" | "approach_short" = "approach_short",
  expiresAt = new Date(NOW.getTime() + 1_000).toISOString(),
): HshhDeviceEffect {
  return {
    type: "safe_skill",
    request_id: "turn-1",
    actor_user_id: "user-1",
    device_id: "robot-1",
    command: {
      request_id: "command-1",
      device_id: "robot-1",
      skill,
      consent_token: "must-not-cross-lan-boundary",
      expires_at: expiresAt,
      expected_device_state: "ready",
      reason: "private user wording must not cross the LAN boundary",
    },
  };
}

function signedResponse(
  body: Record<string, unknown>,
  timestamp = NOW.toISOString(),
) {
  const serialized = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: headers({
      "x-hshh-timestamp": timestamp,
      "x-hshh-signature": sign(timestamp, serialized),
    }),
    async text(): Promise<string> {
      return serialized;
    },
  };
}

describe("LanMotionAdapter", () => {
  it("sends only a signed semantic command to the ESP32-S3", async () => {
    let calls = 0;
    const adapter = new LanMotionAdapter({
      baseUrl: "http://hshh-motion.local",
      sharedSecret: SECRET,
      now: () => NOW,
      fetchImpl: async (url, init) => {
        calls += 1;
        assert.equal(url.toString(), "http://hshh-motion.local/v1/motion/commands");
        assert.equal(init.method, "POST");
        assert.equal(
          init.headers["x-hshh-signature"],
          sign(init.headers["x-hshh-timestamp"]!, init.body),
        );
        assert.equal(init.headers["idempotency-key"], "command-1");

        const request = JSON.parse(init.body) as Record<string, unknown>;
        assert.deepEqual(Object.keys(request).sort(), [
          "command_id",
          "expected_device_state",
          "expires_at",
          "issued_at",
          "protocol_version",
          "robot_id",
          "skill",
          "target",
        ]);
        assert.equal(request["skill"], "approach_short");
        assert.equal("consent_token" in request, false);
        assert.equal("actor_user_id" in request, false);
        assert.equal("reason" in request, false);
        assert.equal("gpio" in request, false);
        assert.equal("pwm" in request, false);

        return signedResponse({
          protocol_version: HSHH_LAN_PROTOCOL_VERSION,
          command_id: "command-1",
          status: "accepted",
          reason_code: "motion_command_accepted",
          observed_at: NOW.toISOString(),
          safety_state: "ready",
          active_skill: "approach_short",
        });
      },
    });

    assert.deepEqual(await adapter.dispatch(safeSkillEffect()), {
      status: "accepted",
      reason_code: "motion_command_accepted",
    });
    assert.equal(calls, 1);
  });

  it("never routes display or audio effects to the motion controller", async () => {
    let calls = 0;
    const adapter = new LanMotionAdapter({
      baseUrl: "http://hshh-motion.local",
      sharedSecret: SECRET,
      now: () => NOW,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("unexpected fetch");
      },
    });
    const expression: HshhDeviceEffect = {
      type: "set_expression",
      request_id: "turn-1",
      actor_user_id: "user-1",
      device_id: "robot-1",
      expression: "happy",
      intensity: 0.5,
      duration_ms: 1_000,
      reason: "semantic display intent",
    };

    assert.deepEqual(await adapter.dispatch(expression), {
      status: "rejected",
      reason_code: "motion_adapter_effect_unsupported",
    });
    assert.equal(calls, 0);
  });

  it("rejects expired intimate motion but still sends an escape stop", async () => {
    let calls = 0;
    const adapter = new LanMotionAdapter({
      baseUrl: "http://192.168.1.50",
      sharedSecret: SECRET,
      now: () => NOW,
      fetchImpl: async () => {
        calls += 1;
        return signedResponse({
          protocol_version: HSHH_LAN_PROTOCOL_VERSION,
          command_id: "command-1",
          status: "stopped",
          reason_code: "local_stop_applied",
          observed_at: NOW.toISOString(),
          safety_state: "stopped",
          active_skill: null,
        });
      },
    });
    const expiredAt = new Date(NOW.getTime() - 1).toISOString();

    assert.deepEqual(
      await adapter.dispatch(safeSkillEffect("approach_short", expiredAt)),
      { status: "rejected", reason_code: "motion_command_expired" },
    );
    assert.deepEqual(await adapter.dispatch(safeSkillEffect("stop", expiredAt)), {
      status: "stopped",
      reason_code: "local_stop_applied",
    });
    assert.equal(calls, 1);
  });

  it("fails closed on an unsigned or mismatched response", async () => {
    const unsigned = new LanMotionAdapter({
      baseUrl: "http://hshh-motion.local",
      sharedSecret: SECRET,
      now: () => NOW,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: headers({}),
        async text() {
          return "{}";
        },
      }),
    });
    assert.deepEqual(await unsigned.dispatch(safeSkillEffect()), {
      status: "failed",
      reason_code: "motion_response_auth_failed",
    });

    const mismatched = new LanMotionAdapter({
      baseUrl: "http://hshh-motion.local",
      sharedSecret: SECRET,
      now: () => NOW,
      fetchImpl: async () =>
        signedResponse({
          protocol_version: HSHH_LAN_PROTOCOL_VERSION,
          command_id: "another-command",
          status: "accepted",
          reason_code: "motion_command_accepted",
          observed_at: NOW.toISOString(),
          safety_state: "ready",
        }),
    });
    assert.deepEqual(await mismatched.dispatch(safeSkillEffect()), {
      status: "failed",
      reason_code: "motion_response_id_mismatch",
    });
  });

  it("accepts only an explicitly paired private-LAN configuration", () => {
    for (const publicUrl of [
      "https://example.com",
      "https://fc-public.example",
      "https://fd-public.example",
      "http://172.32.0.1",
    ]) {
      assert.throws(
        () =>
          new LanMotionAdapter({
            baseUrl: publicUrl,
            sharedSecret: SECRET,
          }),
        /private-LAN/u,
      );
    }
    for (const privateUrl of [
      "http://hshh-motion.local",
      "http://10.0.0.10",
      "http://172.16.0.10",
      "http://192.168.1.10",
      "http://[fd12:3456::10]",
      "http://[fe80::10]",
    ]) {
      assert.doesNotThrow(
        () =>
          new LanMotionAdapter({
            baseUrl: privateUrl,
            sharedSecret: SECRET,
          }),
      );
    }
    assert.throws(
      () =>
        loadConfig({
          HSHH_MOTION_CONTROLLER_URL: "http://hshh-motion.local",
        }),
      /must be configured together/u,
    );
  });
});
