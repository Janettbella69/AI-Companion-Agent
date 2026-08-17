import { z } from "zod";

export const PROVIDER_IDS = [
  "anthropic",
  "deepseek",
  "kimi",
  "glm",
  "qwen",
  "custom",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

const providerIdSchema = z.enum(PROVIDER_IDS);
const providerThinkingModeSchema = z.enum(["provider_default", "disabled"]);

const OFFICIAL_BASE_URLS: Readonly<Record<Exclude<ProviderId, "custom">, string>> = {
  anthropic: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com/anthropic",
  kimi: "https://api.kimi.com/coding/",
  glm: "https://open.bigmodel.cn/api/anthropic",
  qwen: "https://dashscope.aliyuncs.com/apps/anthropic",
};

export interface ProviderProfile {
  providerId: ProviderId;
  baseUrl: string;
  apiKey?: string;
  authToken?: string;
  model: string;
  defaultHaikuModel: string;
  defaultSonnetModel: string;
  defaultOpusModel: string;
  thinkingMode: "provider_default" | "disabled";
  supportsVision: boolean;
  supportsToolUse: boolean;
  supportsStructuredOutput: boolean;
  supportedBetaHeaders: string[];
  verified: boolean;
}

function optionalSecret(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
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

function parseBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("ANTHROPIC_BASE_URL must use HTTPS outside localhost");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, value.endsWith("/") ? "/" : "");
}

export function loadProviderProfile(env: NodeJS.ProcessEnv): ProviderProfile {
  const providerId = providerIdSchema.parse(
    env.HSHH_PROVIDER_ID?.trim().toLowerCase() || "anthropic",
  );
  const configuredBaseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (providerId === "custom" && !configuredBaseUrl) {
    throw new Error("ANTHROPIC_BASE_URL is required for the custom provider profile");
  }

  const baseUrl = parseBaseUrl(
    configuredBaseUrl ||
      OFFICIAL_BASE_URLS[providerId as Exclude<ProviderId, "custom">],
  );
  const configuredModel =
    env.ANTHROPIC_MODEL?.trim() || env.CLAUDE_MODEL?.trim();
  if (providerId !== "anthropic" && !configuredModel) {
    throw new Error(
      `ANTHROPIC_MODEL is required for provider profile ${providerId}`,
    );
  }
  const model = configuredModel || "sonnet";
  const apiKey = optionalSecret(env.ANTHROPIC_API_KEY);
  const authToken = optionalSecret(env.ANTHROPIC_AUTH_TOKEN);

  const profile: ProviderProfile = {
    providerId,
    baseUrl,
    model,
    defaultHaikuModel:
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || model,
    defaultSonnetModel:
      env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || model,
    defaultOpusModel:
      env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || model,
    thinkingMode: providerThinkingModeSchema.parse(
      env.HSHH_PROVIDER_THINKING_MODE?.trim().toLowerCase() ||
        "provider_default",
    ),
    supportsVision: parseBoolean(
      env.HSHH_PROVIDER_SUPPORTS_VISION,
      providerId === "anthropic",
      "HSHH_PROVIDER_SUPPORTS_VISION",
    ),
    supportsToolUse: parseBoolean(
      env.HSHH_PROVIDER_SUPPORTS_TOOL_USE,
      true,
      "HSHH_PROVIDER_SUPPORTS_TOOL_USE",
    ),
    supportsStructuredOutput: parseBoolean(
      env.HSHH_PROVIDER_SUPPORTS_STRUCTURED_OUTPUT,
      true,
      "HSHH_PROVIDER_SUPPORTS_STRUCTURED_OUTPUT",
    ),
    supportedBetaHeaders: (env.HSHH_PROVIDER_BETA_HEADERS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    verified: parseBoolean(
      env.HSHH_PROVIDER_VERIFIED,
      providerId === "anthropic",
      "HSHH_PROVIDER_VERIFIED",
    ),
  };

  if (apiKey !== undefined) profile.apiKey = apiKey;
  if (authToken !== undefined) profile.authToken = authToken;
  return profile;
}

export function hasProviderCredential(profile: ProviderProfile): boolean {
  return Boolean(profile.apiKey || profile.authToken);
}

export function assertProviderReady(profile: ProviderProfile): void {
  if (!profile.verified) {
    throw new Error(`Provider profile ${profile.providerId} has not passed the HSHH conformance suite`);
  }
  if (!profile.supportsToolUse || !profile.supportsStructuredOutput) {
    throw new Error(
      `Provider profile ${profile.providerId} lacks required tool or structured-output support`,
    );
  }
}

export function providerEnvironment(
  profile: ProviderProfile,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  return {
    PATH: inherited.PATH,
    HOME: inherited.HOME,
    LANG: inherited.LANG ?? "C.UTF-8",
    LC_ALL: inherited.LC_ALL,
    TMPDIR: inherited.TMPDIR,
    NODE_EXTRA_CA_CERTS: inherited.NODE_EXTRA_CA_CERTS,
    ANTHROPIC_BASE_URL: profile.baseUrl,
    ANTHROPIC_API_KEY: profile.apiKey,
    ANTHROPIC_AUTH_TOKEN: profile.authToken,
    ANTHROPIC_MODEL: profile.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: profile.defaultHaikuModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: profile.defaultSonnetModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: profile.defaultOpusModel,
    CLAUDE_CODE_EXTRA_BODY:
      profile.thinkingMode === "disabled"
        ? JSON.stringify({ thinking: { type: "disabled" } })
        : undefined,
    CLAUDE_AGENT_SDK_CLIENT_APP: "hshh-robot/0.4.0",
  };
}
