import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import sharp from "sharp";

import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { HshhAgent } from "../src/agent/hshhAgent.js";
import { loadConfig } from "../src/config.js";
import { DeviceEffectQueue } from "../src/device/deviceEffectQueue.js";
import type { LanCameraAdapter } from "../src/device/lanCameraAdapter.js";
import { EventContextGateway } from "../src/gateway/EventContextGateway.js";
import { AvatarMetadataPipeline } from "../src/mcp/avatarServer.js";
import { createHshhHttpServer } from "../src/server/httpServer.js";
import { SpeechStore } from "../src/speech/speechStore.js";
import { UtterancePipeline } from "../src/speech/utterancePipeline.js";
import { HshhDatabase } from "../src/store/database.js";

class CaptureResponse {
  statusCode = 200;
  headersSent = false;
  writableEnded = false;
  readonly headers = new Map<string, string | number>();
  readonly chunks: Buffer[] = [];
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor() {
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  setHeader(name: string, value: string | number): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  write(value: string | Buffer): boolean {
    this.headersSent = true;
    this.chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    return true;
  }

  end(value?: string | Buffer): this {
    if (value !== undefined) this.write(value);
    this.headersSent = true;
    this.writableEnded = true;
    this.finish();
    return this;
  }

  json(): unknown {
    return JSON.parse(Buffer.concat(this.chunks).toString("utf8"));
  }
}

async function invoke(
  server: Server,
  input: {
    method: string;
    path: string;
    token?: string;
    body?: unknown;
    rawBody?: Buffer;
    headers?: Record<string, string>;
  },
): Promise<CaptureResponse> {
  const extraHeaders: Record<string, string> = {};
  if (input.headers !== undefined) {
    for (const [name, value] of Object.entries(input.headers)) {
      extraHeaders[name.toLowerCase()] = value;
    }
  }
  const body =
    input.rawBody !== undefined
      ? [input.rawBody]
      : input.body === undefined
        ? []
        : [Buffer.from(JSON.stringify(input.body))];
  const request = Readable.from(body) as IncomingMessage;
  Object.assign(request, {
    method: input.method,
    url: input.path,
    headers: {
      ...(input.token === undefined
        ? {}
        : { authorization: `Bearer ${input.token}` }),
      ...(input.rawBody === undefined
        ? input.body === undefined
          ? {}
          : { "content-type": "application/json" }
        : { "content-type": "application/octet-stream" }),
      ...extraHeaders,
    },
  });
  const response = new CaptureResponse();
  server.emit(
    "request",
    request,
    response as unknown as ServerResponse,
  );
  await response.done;
  return response;
}

test("HTTP API authenticates writes and serves a safe missing-provider fallback", async () => {
  const now = () => new Date("2026-08-14T12:00:00.000Z");
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      HSHH_DEVICE_TOKEN: "test-device-token",
      HSHH_USER_TOKEN: "test-user-token",
      HSHH_PRINCIPAL_USER_ID: "user-1",
      HSHH_PRINCIPAL_DEVICE_ID: "robot-1",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  const database = new HshhDatabase(":memory:", { now });
  const gateway = new EventContextGateway({ now });
  const avatarPipeline = new AvatarMetadataPipeline({ now });
  const agent = new HshhAgent(database, config, {
    projectRoot: process.cwd(),
    gateway,
    avatarPipeline,
    now,
  });
  const server = createHshhHttpServer({
    config,
    database,
    gateway,
    agent,
    avatarPipeline,
    dispatchEmergencyStop: async () => ({
      status: "stopped",
      reason_code: "explicit_user_stop",
    }),
    now,
  });

  try {
    const unauthorized = await invoke(server, {
      method: "PUT",
      path: "/v1/memory-settings",
      body: { user_id: "user-1", enabled: true },
    });
    assert.equal(unauthorized.statusCode, 401);

    const wrongPrincipalKind = await invoke(server, {
      method: "PUT",
      path: "/v1/memory-settings",
      token: "test-device-token",
      body: { user_id: "user-1", enabled: true },
    });
    assert.equal(wrongPrincipalKind.statusCode, 401);

    const setting = await invoke(server, {
      method: "PUT",
      path: "/v1/memory-settings",
      token: "test-user-token",
      body: { user_id: "user-1", enabled: true },
    });
    assert.equal(setting.statusCode, 200);

    const missingConsentScope = await invoke(server, {
      method: "POST",
      path: "/v1/feedback",
      token: "test-user-token",
      body: {
        user_id: "user-1",
        device_id: "robot-1",
        feedback: "accept",
        occurred_at: now().toISOString(),
      },
    });
    assert.equal(missingConsentScope.statusCode, 400);

    const consent = await invoke(server, {
      method: "POST",
      path: "/v1/feedback",
      token: "test-user-token",
      body: {
        user_id: "user-1",
        device_id: "robot-1",
        feedback: "accept",
        consent_scope: "approach_short",
        detail: "可以，靠近一点。",
        occurred_at: now().toISOString(),
      },
    });
    assert.equal(consent.statusCode, 202);
    const consentResult = consent.json() as {
      consent: { scope: string; token: string };
    };
    assert.equal(consentResult.consent.scope, "approach_short");
    assert.match(consentResult.consent.token, /^consent_/u);

    const interaction = await invoke(server, {
      method: "POST",
      path: "/v1/interactions",
      token: "test-user-token",
      body: {
        transcript: "我有点累，安静陪我一下。",
        device_context: {
          device_id: "robot-1",
          user_id: "user-1",
          observed_at: now().toISOString(),
          presence: "present",
          pose: "upright",
          battery: "normal",
          safety_state: "ready",
        },
      },
    });
    assert.equal(interaction.statusCode, 200);
    const response = interaction.json() as {
      mode: string;
      decision: { emotion: { state: string }; skill_request?: unknown };
    };
    assert.equal(response.mode, "fallback");
    assert.equal(response.decision.emotion.state, "unknown");
    assert.equal(response.decision.skill_request, undefined);

    const stop = await invoke(server, {
      method: "POST",
      path: "/v1/feedback",
      token: "test-user-token",
      body: {
        user_id: "user-1",
        device_id: "robot-1",
        feedback: "stop",
        detail: "停下。",
        occurred_at: now().toISOString(),
      },
    });
    assert.equal(stop.statusCode, 202);
    assert.deepEqual(
      (stop.json() as { motion_stop: unknown }).motion_stop,
      { status: "stopped", reason_code: "explicit_user_stop" },
    );
    assert.equal(gateway.getActiveConsents("robot-1", "user-1").length, 0);

    const userTokenOnDeviceRoute = await invoke(server, {
      method: "POST",
      path: "/v1/device/events",
      token: "test-user-token",
      body: {
        device_id: "robot-1",
        user_id: "user-1",
        event: "distance_sample",
        source: "hc_sr04",
        occurred_at: now().toISOString(),
        payload: {
          distance_cm: 80,
          valid: true,
          confidence: 1,
          summary: "HC-SR04 valid distance sample",
        },
      },
    });
    assert.equal(userTokenOnDeviceRoute.statusCode, 401);

    const event = await invoke(server, {
      method: "POST",
      path: "/v1/device/events",
      token: "test-device-token",
      body: {
        device_id: "robot-1",
        user_id: "user-1",
        event: "distance_sample",
        source: "hc_sr04",
        occurred_at: now().toISOString(),
        payload: {
          distance_cm: 80,
          valid: true,
          confidence: 1,
          summary: "HC-SR04 valid distance sample",
        },
      },
    });
    assert.equal(event.statusCode, 202);
    const eventResult = event.json() as { accepted: boolean; evidence_id: string };
    assert.equal(eventResult.accepted, true);
    assert.match(eventResult.evidence_id, /^ev_/u);
  } finally {
    server.close();
    database.close();
  }
});

test("authenticated triggered keyframe starts one safe autonomous Agent turn", async () => {
  const observedAt = "2026-08-15T01:00:00.000Z";
  const now = () => new Date(observedAt);
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      HSHH_DEVICE_TOKEN: "test-device-token",
      HSHH_USER_TOKEN: "test-user-token",
      HSHH_PRINCIPAL_USER_ID: "user-1",
      HSHH_PRINCIPAL_DEVICE_ID: "robot-1",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  const database = new HshhDatabase(":memory:", { now });
  const gateway = new EventContextGateway({ now });
  const avatarPipeline = new AvatarMetadataPipeline({ now });
  const agent = new HshhAgent(database, config, {
    projectRoot: process.cwd(),
    gateway,
    avatarPipeline,
    now,
  });
  const jpeg = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: 70, g: 80, b: 90 },
    },
  }).jpeg().toBuffer();
  const cameraAdapter = {
    capture: async () => ({
      status: "completed" as const,
      reason_code: "camera_capture_completed" as const,
      capture_id: "capture-autonomous-1",
      observed_at: observedAt,
      image: {
        capture_id: "capture-autonomous-1",
        observed_at: observedAt,
        mime: "image/jpeg" as const,
        source: "esp32_cam" as const,
        base64: jpeg.toString("base64"),
      },
    }),
  } as unknown as LanCameraAdapter;
  const server = createHshhHttpServer({
    config,
    database,
    gateway,
    agent,
    avatarPipeline,
    cameraAdapter,
    now,
  });

  try {
    const captured = await invoke(server, {
      method: "POST",
      path: "/v1/device/captures",
      token: "test-device-token",
      body: { trigger_reason: "presence_event" },
    });
    assert.equal(captured.statusCode, 202);
    assert.equal((captured.json() as { accepted: boolean }).accepted, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const turns = database.listInteractionEvents({
      device_id: "robot-1",
      event_type: "autonomous_presence_turn_completed",
      limit: 10,
    });
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.payload?.["evidence_id"],
      (captured.json() as { evidence_id: string }).evidence_id);
    assert.equal(database.listInteractionEvents({
      device_id: "robot-1",
      event_type: "skill_command_issued",
      limit: 10,
    }).length, 0);
  } finally {
    server.close();
    database.close();
  }
});

test("avatar upload creates 9x5 preview/device assets and activates only after T5 verification", async () => {
  const now = () => new Date();
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      HSHH_DEVICE_TOKEN: "test-device-token",
      HSHH_USER_TOKEN: "test-user-token",
      HSHH_PRINCIPAL_USER_ID: "user-1",
      HSHH_PRINCIPAL_DEVICE_ID: "robot-1",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  const database = new HshhDatabase(":memory:", { now });
  const gateway = new EventContextGateway({ now });
  const avatarPipeline = new AvatarMetadataPipeline({ now });
  const agent = new HshhAgent(database, config, {
    projectRoot: process.cwd(),
    gateway,
    avatarPipeline,
    now,
  });
  const server = createHshhHttpServer({
    config,
    database,
    gateway,
    agent,
    avatarPipeline,
    now,
  });

  try {
    const source = await sharp({
      create: {
        width: 120,
        height: 160,
        channels: 3,
        background: { r: 184, g: 128, b: 91 },
      },
    }).png().toBuffer();
    const upload = await invoke(server, {
      method: "POST",
      path: "/v1/avatar-packs",
      token: "test-user-token",
      body: {
        device_id: "robot-1",
        user_id: "user-1",
        pet_id: "mimi",
        pet_type: "cat",
        visible_traits: ["棕色毛发", "圆耳朵"],
        mime_type: "image/png",
        image_base64: source.toString("base64"),
      },
    });
    assert.equal(upload.statusCode, 202);
    const jobId = (upload.json() as { job_id: string }).job_id;

    let jobResponse: CaptureResponse | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      jobResponse = await invoke(server, {
        method: "GET",
        path: `/v1/avatar-packs/${jobId}`,
        token: "test-user-token",
      });
      const status = (jobResponse.json() as { status: string }).status;
      if (status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(jobResponse);
    const job = jobResponse.json() as {
      status: string;
      asset_id: string;
      manifest: { expressions: Record<string, unknown[]> };
    };
    assert.equal(job.status, "ready");
    assert.equal(Object.keys(job.manifest.expressions).length, 9);
    assert.ok(
      Object.values(job.manifest.expressions).every((frames) => frames.length === 5),
    );
    assert.equal(database.getActivePetAsset("robot-1"), null);

    const frame = await invoke(server, {
      method: "GET",
      path: `/v1/avatar-packs/${jobId}/files/expressions/happy/happy_01.png`,
      token: "test-user-token",
    });
    assert.equal(frame.statusCode, 200);
    assert.equal(Buffer.concat(frame.chunks).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

    const activated = await invoke(server, {
      method: "POST",
      path: `/v1/avatar-packs/${jobId}/activate`,
      token: "test-user-token",
    });
    assert.equal(activated.statusCode, 202);
    assert.equal((activated.json() as { status: string }).status, "deploying");
    assert.equal(database.getActivePetAsset("robot-1"), null);

    const deployment = await invoke(server, {
      method: "GET",
      path: "/v1/device/avatar-pack",
      token: "test-device-token",
    });
    assert.equal(deployment.statusCode, 200);
    const deploymentBody = deployment.json() as {
      deployment: {
        asset_id: string;
        manifest_sha256: string;
        manifest: { expressions: Record<string, unknown[]> };
      };
    };
    assert.equal(deploymentBody.deployment.asset_id, job.asset_id);
    assert.equal(
      Object.keys(deploymentBody.deployment.manifest.expressions).length,
      9,
    );

    const deviceIdentity = await invoke(server, {
      method: "GET",
      path: `/v1/device/avatar-pack/${job.asset_id}/files/device/identity.jpg`,
      token: "test-device-token",
    });
    assert.equal(deviceIdentity.statusCode, 200);
    assert.equal(
      Buffer.concat(deviceIdentity.chunks).subarray(0, 3).toString("hex"),
      "ffd8ff",
    );

    const deviceFrame = await invoke(server, {
      method: "GET",
      path: `/v1/device/avatar-pack/${job.asset_id}/files/device/happy_01.jpg`,
      token: "test-device-token",
    });
    assert.equal(deviceFrame.statusCode, 200);
    assert.equal(
      Buffer.concat(deviceFrame.chunks).subarray(0, 3).toString("hex"),
      "ffd8ff",
    );

    const deviceActivation = await invoke(server, {
      method: "POST",
      path: `/v1/device/avatar-pack/${job.asset_id}/activate`,
      token: "test-device-token",
      body: {
        manifest_sha256: deploymentBody.deployment.manifest_sha256,
        files_verified: 45,
        identity_verified: true,
        display_ready: true,
      },
    });
    assert.equal(deviceActivation.statusCode, 200);
    assert.equal(database.getActivePetAsset("robot-1")?.id, job.asset_id);

    const activeJob = await invoke(server, {
      method: "GET",
      path: `/v1/avatar-packs/${jobId}`,
      token: "test-user-token",
    });
    assert.equal((activeJob.json() as { status: string }).status, "active");
  } finally {
    server.close();
    database.close();
  }
});

function speechTestConfig() {
  return loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      HSHH_DEVICE_TOKEN: "test-device-token",
      HSHH_USER_TOKEN: "test-user-token",
      HSHH_PRINCIPAL_USER_ID: "user-1",
      HSHH_PRINCIPAL_DEVICE_ID: "robot-1",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
}

function speechDecision() {
  return {
    reply_text: "我在。",
    expression: "happy" as const,
    emotion: {
      state: "unknown" as const,
      valence: 0,
      arousal: 0.2,
      engagement: 0.35,
      confidence: 0.3,
      evidence: [],
      observed_signals: [],
      user_confirmed: false,
      expires_at: "2026-08-16T00:01:00.000Z",
    },
    requires_user_confirmation: false,
    output_modalities: ["speech", "display"] as Array<"speech" | "display">,
  };
}

test("device utterances without a pipeline return speech_not_configured", async () => {
  const now = () => new Date("2026-08-16T00:00:00.000Z");
  const config = speechTestConfig();
  const database = new HshhDatabase(":memory:", { now });
  const gateway = new EventContextGateway({ now });
  const avatarPipeline = new AvatarMetadataPipeline({ now });
  const agent = new HshhAgent(database, config, {
    projectRoot: process.cwd(),
    gateway,
    avatarPipeline,
    now,
  });
  const server = createHshhHttpServer({
    config,
    database,
    gateway,
    agent,
    avatarPipeline,
    now,
  });
  try {
    const response = await invoke(server, {
      method: "POST",
      path: "/v1/device/utterances",
      token: "test-device-token",
      rawBody: Buffer.alloc(16000),
      headers: {
        "x-hshh-audio-format": "pcm_s16le",
        "x-hshh-sample-rate": "16000",
        "x-hshh-channels": "1",
        "x-hshh-utterance-id": "utt-curl-1",
      },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(
      (response.json() as { reason_code: string }).reason_code,
      "speech_not_configured",
    );
  } finally {
    server.close();
    database.close();
  }
});

test("device utterances accept PCM and serve TTS bytes after the pipeline runs", async () => {
  const now = () => new Date("2026-08-16T00:00:00.000Z");
  const config = speechTestConfig();
  const database = new HshhDatabase(":memory:", { now });
  const gateway = new EventContextGateway({ now });
  const avatarPipeline = new AvatarMetadataPipeline({ now });
  const agent = new HshhAgent(database, config, {
    projectRoot: process.cwd(),
    gateway,
    avatarPipeline,
    now,
  });
  const ttsPcm = Buffer.from([9, 8, 7, 6]);
  const effectQueue = new DeviceEffectQueue({ now });
  const speechStore = new SpeechStore({ now, idFactory: () => "aaaa" });
  let finished!: () => void;
  const pipelineDone = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const pipeline = new UtterancePipeline({
    speech: {
      transcribePcm: async () => ({ status: "completed", transcript: "你好" }),
      synthesizeSpeech: async () => ({
        status: "completed",
        pcm: ttsPcm,
        sampleRate: 16000,
      }),
    },
    gateway,
    agent: {
      interact: async () => ({ mode: "fallback", decision: speechDecision() }),
    },
    speechStore,
    effectQueue,
    now,
  });
  const originalRun = pipeline.run.bind(pipeline);
  pipeline.run = async (utteranceId: string) => {
    try {
      await originalRun(utteranceId);
    } finally {
      finished();
    }
  };
  const server = createHshhHttpServer({
    config,
    database,
    gateway,
    agent,
    avatarPipeline,
    effectQueue,
    utterancePipeline: pipeline,
    speechStore,
    now,
  });
  try {
    const accepted = await invoke(server, {
      method: "POST",
      path: "/v1/device/utterances",
      token: "test-device-token",
      rawBody: Buffer.alloc(16000),
      headers: {
        "x-hshh-audio-format": "pcm_s16le",
        "x-hshh-sample-rate": "16000",
        "x-hshh-channels": "1",
        "x-hshh-utterance-id": "utt-http-1",
      },
    });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.headers.get("connection"), "close");
    assert.equal((accepted.json() as { accepted: boolean }).accepted, true);
    await pipelineDone;
    const listed = effectQueue.list("robot-1");
    const speech = listed.find((item) => item.type === "play_speech");
    assert.equal(speech?.type, "play_speech");
    if (speech?.type !== "play_speech") {
      throw new Error("expected play_speech");
    }
    const downloaded = await invoke(server, {
      method: "GET",
      path: `/v1/device/speech/${speech.speech_id}`,
      token: "test-device-token",
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.headers.get("content-type"), "application/octet-stream");
    assert.equal(downloaded.headers.get("connection"), "close");
    assert.deepEqual(Buffer.concat(downloaded.chunks), ttsPcm);
  } finally {
    server.close();
    database.close();
  }
});

test("a second in-flight utterance for the same device returns 409", async () => {
  const now = () => new Date("2026-08-16T00:00:00.000Z");
  const config = speechTestConfig();
  const database = new HshhDatabase(":memory:", { now });
  const gateway = new EventContextGateway({ now });
  const avatarPipeline = new AvatarMetadataPipeline({ now });
  const agent = new HshhAgent(database, config, {
    projectRoot: process.cwd(),
    gateway,
    avatarPipeline,
    now,
  });
  const effectQueue = new DeviceEffectQueue({ now });
  const speechStore = new SpeechStore({ now });
  const pipeline = new UtterancePipeline({
    speech: {
      transcribePcm: () => new Promise(() => {}),
      synthesizeSpeech: async () => ({
        status: "failed",
        reason_code: "tts_unavailable",
      }),
    },
    gateway,
    agent: {
      interact: async () => ({ mode: "fallback", decision: speechDecision() }),
    },
    speechStore,
    effectQueue,
    now,
  });
  const server = createHshhHttpServer({
    config,
    database,
    gateway,
    agent,
    avatarPipeline,
    effectQueue,
    utterancePipeline: pipeline,
    speechStore,
    now,
  });
  try {
    const first = await invoke(server, {
      method: "POST",
      path: "/v1/device/utterances",
      token: "test-device-token",
      rawBody: Buffer.alloc(16000),
      headers: {
        "x-hshh-utterance-id": "utt-hang-1",
      },
    });
    assert.equal(first.statusCode, 202);
    const second = await invoke(server, {
      method: "POST",
      path: "/v1/device/utterances",
      token: "test-device-token",
      rawBody: Buffer.alloc(16000),
      headers: {
        "x-hshh-utterance-id": "utt-hang-2",
      },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(
      (second.json() as { reason_code: string }).reason_code,
      "utterance_in_flight",
    );
  } finally {
    server.close();
    database.close();
  }
});
