import { resolve } from "node:path";

import { HshhAgent } from "./agent/hshhAgent.js";
import { loadConfig, loadEnvFileIfPresent } from "./config.js";
import { LanCameraAdapter } from "./device/lanCameraAdapter.js";
import { DeviceEffectQueue } from "./device/deviceEffectQueue.js";
import { LanMotionAdapter } from "./device/lanMotionAdapter.js";
import type { VerifiedVisionGuidance } from "./domain/contracts.js";
import { EventContextGateway } from "./gateway/EventContextGateway.js";
import { AvatarMetadataPipeline } from "./mcp/avatarServer.js";
import { DoubaoVisionAdapter } from "./mcp/doubaoVisionAdapter.js";
import { createSafeSkillCommand } from "./policy/policyGate.js";
import { createHshhHttpServer } from "./server/httpServer.js";
import { HshhDatabase } from "./store/database.js";
import { DashScopeSpeechAdapter } from "./speech/dashscopeSpeechAdapter.js";
import { SpeechStore } from "./speech/speechStore.js";
import { UtterancePipeline } from "./speech/utterancePipeline.js";

const projectRoot = resolve(process.cwd());
loadEnvFileIfPresent(resolve(projectRoot, ".env"));
const config = loadConfig(process.env, projectRoot);
const now = () => new Date();
const database = new HshhDatabase(config.databasePath, { now });
const gateway = new EventContextGateway({ now });
const avatarPipeline = new AvatarMetadataPipeline({
  now,
  assetRoot: resolve(projectRoot, "var", "avatar-packs"),
});
const effectQueue = new DeviceEffectQueue({ now });
const motionAdapter =
  config.motionControllerUrl !== undefined &&
  config.motionSharedSecret !== undefined
    ? new LanMotionAdapter({
        baseUrl: config.motionControllerUrl,
        sharedSecret: config.motionSharedSecret,
        timeoutMs: config.motionTimeoutMs,
        now,
      })
    : undefined;
const cameraAdapter =
  config.cameraUrl !== undefined && config.cameraSharedSecret !== undefined
    ? new LanCameraAdapter({
        baseUrl: config.cameraUrl,
        sharedSecret: config.cameraSharedSecret,
        timeoutMs: config.cameraTimeoutMs,
        now,
      })
    : undefined;
const perceptionAdapter =
  config.doubaoVisionApiKey !== undefined &&
  config.doubaoVisionBaseUrl !== undefined &&
  config.doubaoVisionModel !== undefined
    ? new DoubaoVisionAdapter({
        apiKey: config.doubaoVisionApiKey,
        baseUrl: config.doubaoVisionBaseUrl,
        model: config.doubaoVisionModel,
        ...(config.doubaoVisionTimeoutMs === undefined
          ? {}
          : { timeoutMs: config.doubaoVisionTimeoutMs }),
      })
    : undefined;
const agent = new HshhAgent(database, config, {
  projectRoot,
  gateway,
  avatarPipeline,
  dispatchDeviceEffect: async (effect) =>
    effect.type === "safe_skill"
      ? motionAdapter === undefined
        ? { status: "rejected", reason_code: "motion_adapter_unavailable" }
        : motionAdapter.dispatch(effect)
      : effectQueue.enqueue(effect),
  now,
  ...(perceptionAdapter === undefined ? {} : { perceptionAdapter }),
});
const speechStore = new SpeechStore({ now });
const utterancePipeline =
  config.dashscopeApiKey === undefined
    ? undefined
    : new UtterancePipeline({
        speech: new DashScopeSpeechAdapter({
          apiKey: config.dashscopeApiKey,
          baseUrl: config.dashscopeBaseUrl,
        }),
        gateway,
        agent,
        speechStore,
        effectQueue,
        now,
        log: (fields) => {
          process.stdout.write(`HSHH utterance ${JSON.stringify(fields)}\n`);
        },
      });
const server = createHshhHttpServer({
  config,
  database,
  gateway,
  agent,
  avatarPipeline,
  effectQueue,
  speechStore,
  ...(utterancePipeline === undefined ? {} : { utterancePipeline }),
  ...(cameraAdapter === undefined ? {} : { cameraAdapter }),
  ...(config.visionGuidedDemoEnabled && motionAdapter !== undefined
    ? {
        visionGuidedDemo: {
          maxSteps: 4,
          settleMs: 1_100,
          dispatchStep: async ({
            userId,
            deviceId,
            skill,
            guidance,
            consentToken,
          }: {
            userId: string;
            deviceId: string;
            skill: "approach_short" | "turn_to_user";
            guidance: VerifiedVisionGuidance;
            consentToken?: string;
          }) => {
            const issuedAt = now();
            const command = createSafeSkillCommand(
              skill,
              {
                device_id: deviceId,
                user_id: userId,
                observed_at: issuedAt.toISOString(),
                presence: "present",
                pose: "unknown",
                battery: "unknown",
                safety_state: "stopped",
              },
              "authenticated_vision_guided_demo_step",
              issuedAt,
              consentToken,
            );
            return motionAdapter.dispatch({
              type: "safe_skill",
              request_id: command.request_id,
              actor_user_id: userId,
              device_id: deviceId,
              command,
              vision_guidance: guidance,
            });
          },
        },
      }
    : {}),
  ...(motionAdapter === undefined
    ? {}
    : {
        dispatchEmergencyStop: async ({
          userId,
          deviceId,
        }: {
          userId: string;
          deviceId: string;
        }) => {
          const context =
            gateway.getDeviceContext(deviceId) ??
            database.getDeviceContext(deviceId) ?? {
              device_id: deviceId,
              user_id: userId,
              observed_at: now().toISOString(),
              presence: "unknown" as const,
              pose: "unknown" as const,
              battery: "unknown" as const,
              safety_state: "stopped" as const,
            };
          const command = createSafeSkillCommand(
            "stop",
            context,
            "explicit_user_stop",
            now(),
          );
          return motionAdapter.dispatch({
            type: "safe_skill",
            request_id: command.request_id,
            actor_user_id: userId,
            device_id: deviceId,
            command,
          });
        },
      }),
  now,
});

database.recordInteractionEvent({
  event_type: "provider_profile_selected",
  occurred_at: now().toISOString(),
  payload: {
    provider_id: config.providerProfile.providerId,
    verified: config.providerProfile.verified,
    supports_vision: config.providerProfile.supportsVision,
    motion_adapter_configured: motionAdapter !== undefined,
    camera_adapter_configured: cameraAdapter !== undefined,
    speech_pipeline_configured: utterancePipeline !== undefined,
    vision_guided_demo_enabled:
      config.visionGuidedDemoEnabled && motionAdapter !== undefined,
  },
});

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `HSHH Agent SDK service listening on http://${config.host}:${config.port}\n`,
  );
  process.stdout.write(
    `HSHH speech pipeline ${utterancePipeline === undefined ? "disabled" : "enabled"}\n`,
  );
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`HSHH received ${signal}; shutting down\n`);
  server.close(() => {
    database.close();
    process.exitCode = 0;
  });
  setTimeout(() => {
    process.exitCode = 1;
  }, 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
