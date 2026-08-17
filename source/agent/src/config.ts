import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

import {
  loadProviderProfile,
  type ProviderProfile,
} from "./provider/providerProfile.js";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export interface AgentServiceConfig {
  host: string;
  port: number;
  corsOrigin: string;
  databasePath: string;
  sessionRoot: string;
  skillsRoot: string;
  anthropicApiKey?: string;
  anthropicAuthToken?: string;
  claudeModel: string;
  providerProfile: ProviderProfile;
  deviceToken?: string;
  userToken?: string;
  principalUserId?: string;
  principalDeviceId?: string;
  consentSecret?: string;
  motionControllerUrl?: string;
  motionSharedSecret?: string;
  motionTimeoutMs: number;
  cameraUrl?: string;
  cameraSharedSecret?: string;
  cameraTimeoutMs: number;
  doubaoVisionApiKey?: string;
  doubaoVisionBaseUrl?: string;
  doubaoVisionModel?: string;
  doubaoVisionTimeoutMs?: number;
  dashscopeApiKey?: string;
  dashscopeBaseUrl: string;
  visionGuidedDemoEnabled: boolean;
  allowUnsensoredMotion: boolean;
  agentTimeoutMs: number;
  maxRequestBytes: number;
  sandboxFailClosed: boolean;
  allowDeepResearch: boolean;
  allowedWebDomains: string[];
  logLevel: z.infer<typeof logLevelSchema>;
}

function optionalSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  bounds: { min: number; max: number },
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(
      `${name} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  }
  return parsed;
}

function resolveDatabasePath(value: string | undefined, cwd: string): string {
  const configured = value?.trim() || "./var/hshh.sqlite";
  if (configured === ":memory:" || configured.startsWith("file:")) {
    return configured;
  }
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

function resolveDirectoryPath(
  value: string | undefined,
  cwd: string,
  fallback: string,
): string {
  const configured = value?.trim() || fallback;
  return isAbsolute(configured) ? configured : resolve(cwd, configured);
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}

/**
 * Loads an optional dotenv file with Node's built-in parser. Existing process
 * environment variables continue to take precedence.
 */
export function loadEnvFileIfPresent(path = resolve(process.cwd(), ".env")): boolean {
  if (!existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AgentServiceConfig {
  const providerProfile = loadProviderProfile(env);
  const config: AgentServiceConfig = {
    host: env.HSHH_HOST?.trim() || "127.0.0.1",
    port: parseInteger(env.HSHH_PORT, 8787, "HSHH_PORT", {
      min: 1,
      max: 65_535,
    }),
    corsOrigin: env.HSHH_CORS_ORIGIN?.trim() || "http://localhost:3000",
    databasePath: resolveDatabasePath(env.HSHH_DATABASE_PATH, cwd),
    sessionRoot: resolveDirectoryPath(env.HSHH_SESSION_ROOT, cwd, "./var/sessions"),
    skillsRoot: resolveDirectoryPath(env.HSHH_SKILLS_ROOT, cwd, "./.claude/skills"),
    claudeModel: providerProfile.model,
    providerProfile,
    motionTimeoutMs: parseInteger(
      env.HSHH_MOTION_TIMEOUT_MS,
      400,
      "HSHH_MOTION_TIMEOUT_MS",
      { min: 50, max: 2_000 },
    ),
    cameraTimeoutMs: parseInteger(
      env.HSHH_CAMERA_TIMEOUT_MS,
      1_500,
      "HSHH_CAMERA_TIMEOUT_MS",
      { min: 100, max: 5_000 },
    ),
    visionGuidedDemoEnabled: parseBoolean(
      env.HSHH_ENABLE_VISION_GUIDED_DEMO,
      false,
      "HSHH_ENABLE_VISION_GUIDED_DEMO",
    ),
    allowUnsensoredMotion: parseBoolean(
      env.HSHH_ALLOW_UNSENSORED_MOTION,
      false,
      "HSHH_ALLOW_UNSENSORED_MOTION",
    ),
    agentTimeoutMs: parseInteger(
      env.HSHH_AGENT_TIMEOUT_MS,
      8_000,
      "HSHH_AGENT_TIMEOUT_MS",
      { min: 1_000, max: 60_000 },
    ),
    maxRequestBytes: parseInteger(
      env.HSHH_MAX_REQUEST_BYTES,
      12 * 1024 * 1024,
      "HSHH_MAX_REQUEST_BYTES",
      { min: 1_024, max: 20 * 1024 * 1024 },
    ),
    sandboxFailClosed: parseBoolean(
      env.HSHH_SANDBOX_FAIL_CLOSED,
      true,
      "HSHH_SANDBOX_FAIL_CLOSED",
    ),
    allowDeepResearch: parseBoolean(
      env.HSHH_ALLOW_DEEP_RESEARCH,
      false,
      "HSHH_ALLOW_DEEP_RESEARCH",
    ),
    allowedWebDomains: (env.HSHH_ALLOWED_WEB_DOMAINS ??
      "code.claude.com,github.com,api-docs.deepseek.com,kimi.com,open.bigmodel.cn,help.aliyun.com")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    logLevel: logLevelSchema.parse(env.HSHH_LOG_LEVEL?.trim() || "info"),
    dashscopeBaseUrl:
      env.HSHH_DASHSCOPE_BASE_URL?.trim() ||
      "https://dashscope.aliyuncs.com/api/v1",
  };

  const anthropicApiKey = providerProfile.apiKey;
  if (anthropicApiKey !== undefined) {
    config.anthropicApiKey = anthropicApiKey;
  }

  const anthropicAuthToken = providerProfile.authToken;
  if (anthropicAuthToken !== undefined) {
    config.anthropicAuthToken = anthropicAuthToken;
  }

  const deviceToken = optionalSecret(env.HSHH_DEVICE_TOKEN);
  if (deviceToken !== undefined) {
    config.deviceToken = deviceToken;
  }

  const userToken = optionalSecret(env.HSHH_USER_TOKEN);
  if (userToken !== undefined) {
    config.userToken = userToken;
  }

  const principalUserId = optionalSecret(env.HSHH_PRINCIPAL_USER_ID);
  if (principalUserId !== undefined) {
    config.principalUserId = principalUserId;
  }

  const principalDeviceId = optionalSecret(env.HSHH_PRINCIPAL_DEVICE_ID);
  if (principalDeviceId !== undefined) {
    config.principalDeviceId = principalDeviceId;
  }

  const authValues = [
    deviceToken,
    userToken,
    principalUserId,
    principalDeviceId,
  ];
  if (authValues.some((value) => value !== undefined)) {
    if (authValues.some((value) => value === undefined)) {
      throw new Error(
        "HSHH_DEVICE_TOKEN, HSHH_USER_TOKEN, HSHH_PRINCIPAL_USER_ID and HSHH_PRINCIPAL_DEVICE_ID must be configured together",
      );
    }
    if (deviceToken === userToken) {
      throw new Error("HSHH_DEVICE_TOKEN and HSHH_USER_TOKEN must be different");
    }
  }

  const consentSecret = optionalSecret(env.HSHH_CONSENT_SECRET);
  if (consentSecret !== undefined) {
    config.consentSecret = consentSecret;
  }

  const motionControllerUrl = optionalSecret(env.HSHH_MOTION_CONTROLLER_URL);
  const motionSharedSecret = optionalSecret(env.HSHH_MOTION_SHARED_SECRET);
  if (
    (motionControllerUrl === undefined) !== (motionSharedSecret === undefined)
  ) {
    throw new Error(
      "HSHH_MOTION_CONTROLLER_URL and HSHH_MOTION_SHARED_SECRET must be configured together",
    );
  }
  if (motionControllerUrl !== undefined && motionSharedSecret !== undefined) {
    config.motionControllerUrl = motionControllerUrl;
    config.motionSharedSecret = motionSharedSecret;
  }

  const cameraUrl = optionalSecret(env.HSHH_CAMERA_URL);
  const cameraSharedSecret = optionalSecret(env.HSHH_CAMERA_SHARED_SECRET);
  if ((cameraUrl === undefined) !== (cameraSharedSecret === undefined)) {
    throw new Error(
      "HSHH_CAMERA_URL and HSHH_CAMERA_SHARED_SECRET must be configured together",
    );
  }
  if (cameraUrl !== undefined && cameraSharedSecret !== undefined) {
    if (cameraSharedSecret === motionSharedSecret) {
      throw new Error("Camera and motion controllers must use different secrets");
    }
    config.cameraUrl = cameraUrl;
    config.cameraSharedSecret = cameraSharedSecret;
  }

  const dashscopeApiKey =
    optionalSecret(env.DASHSCOPE_API_KEY) ??
    (providerProfile.providerId === "qwen"
      ? providerProfile.authToken ?? providerProfile.apiKey
      : undefined);
  if (dashscopeApiKey !== undefined) {
    config.dashscopeApiKey = dashscopeApiKey;
  }

  const doubaoVisionApiKey = optionalSecret(env.HSHH_DOUBAO_API_KEY);
  if (doubaoVisionApiKey !== undefined) {
    config.doubaoVisionApiKey = doubaoVisionApiKey;
    config.doubaoVisionBaseUrl =
      optionalSecret(env.HSHH_DOUBAO_BASE_URL) ??
      "https://ark.cn-beijing.volces.com/api/v3";
    config.doubaoVisionModel =
      optionalSecret(env.HSHH_DOUBAO_MODEL) ??
      "doubao-seed-2-1-turbo-260628";
    config.doubaoVisionTimeoutMs = parseInteger(
      env.HSHH_DOUBAO_TIMEOUT_MS,
      5_000,
      "HSHH_DOUBAO_TIMEOUT_MS",
      { min: 1_000, max: 15_000 },
    );
  }

  return config;
}
