import { wrapPcmS16LeAsWav } from "./pcmWav.js";

export type SpeechTranscribeResult =
  | { status: "completed"; transcript: string }
  | { status: "failed"; reason_code: string };

export type SpeechSynthesizeResult =
  | { status: "completed"; pcm: Buffer; sampleRate: number }
  | { status: "failed"; reason_code: string };

export interface DashScopeSpeechAdapterOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
  asrModel?: string;
  ttsModel?: string;
  ttsVoice?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_ASR_MODEL = "qwen3-asr-flash";
const DEFAULT_TTS_MODEL = "cosyvoice-v3-flash";
const DEFAULT_TTS_VOICE = "longanyang";
const TTS_TEXT_MAX_CHARS = 200;

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

function looksLikeBase64(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed);
}

function extractAsrText(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const output = (body as { output?: unknown }).output;
  if (typeof output === "object" && output !== null) {
    const outputText = (output as { text?: unknown }).text;
    if (typeof outputText === "string") return outputText;

    const choices = (output as { choices?: unknown }).choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const message = (choices[0] as { message?: unknown })?.message;
      const content = (message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as { text?: unknown }).text === "string"
          ) {
            return (item as { text: string }).text;
          }
        }
      } else if (typeof content === "string") {
        return content;
      }
    }
  }
  return undefined;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

export class DashScopeSpeechAdapter {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly asrModel: string;
  private readonly ttsModel: string;
  private readonly ttsVoice: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DashScopeSpeechAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.asrModel = options.asrModel ?? DEFAULT_ASR_MODEL;
    this.ttsModel = options.ttsModel ?? DEFAULT_TTS_MODEL;
    this.ttsVoice = options.ttsVoice ?? DEFAULT_TTS_VOICE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private authHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.apiKey}`);
    return headers;
  }

  async transcribePcm(input: {
    pcm: Buffer;
    sampleRate: number;
    channels: number;
  }): Promise<SpeechTranscribeResult> {
    try {
      const wav = wrapPcmS16LeAsWav(input.pcm, input.sampleRate, input.channels);
      const audioDataUri = `data:audio/wav;base64,${wav.toString("base64")}`;
      const url = joinUrl(
        this.baseUrl,
        "services/aigc/multimodal-generation/generation",
      );
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: this.asrModel,
          input: {
            messages: [
              {
                role: "user",
                content: [{ audio: audioDataUri }],
              },
            ],
          },
          parameters: {
            asr_options: { enable_itn: true, language: "zh" },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return { status: "failed", reason_code: "asr_unavailable" };
      }

      const body: unknown = await response.json();
      const text = extractAsrText(body)?.trim();
      if (!text) {
        return { status: "failed", reason_code: "asr_unavailable" };
      }
      return { status: "completed", transcript: text };
    } catch (error) {
      if (isAbortError(error) || error instanceof Error) {
        return { status: "failed", reason_code: "asr_unavailable" };
      }
      return { status: "failed", reason_code: "asr_unavailable" };
    }
  }

  async synthesizeSpeech(input: {
    text: string;
    sampleRate: number;
  }): Promise<SpeechSynthesizeResult> {
    try {
      const text = input.text.trim().slice(0, TTS_TEXT_MAX_CHARS);
      if (!text) {
        return { status: "failed", reason_code: "tts_unavailable" };
      }

      const url = joinUrl(this.baseUrl, "services/audio/tts/SpeechSynthesizer");
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({
          model: this.ttsModel,
          input: {
            text,
            voice: this.ttsVoice,
            format: "pcm",
            sample_rate: input.sampleRate,
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return { status: "failed", reason_code: "tts_unavailable" };
      }

      const pcm = await this.extractTtsPcm(response);
      if (!pcm || pcm.length === 0) {
        return { status: "failed", reason_code: "tts_unavailable" };
      }
      return { status: "completed", pcm, sampleRate: input.sampleRate };
    } catch (error) {
      if (isAbortError(error) || error instanceof Error) {
        return { status: "failed", reason_code: "tts_unavailable" };
      }
      return { status: "failed", reason_code: "tts_unavailable" };
    }
  }

  private async extractTtsPcm(response: Response): Promise<Buffer | undefined> {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    // 1. octet-stream / audio body → PCM
    if (contentType.includes("octet-stream") || contentType.includes("audio")) {
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > 0 ? bytes : undefined;
    }

    // Prefer JSON for remaining paths
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }

    if (typeof body !== "object" || body === null) return undefined;
    const output = (body as { output?: unknown }).output;
    if (typeof output !== "object" || output === null) return undefined;

    const audio = (output as { audio?: unknown }).audio;

    // 2. JSON output.audio.url → GET with Bearer
    if (
      typeof audio === "object" &&
      audio !== null &&
      typeof (audio as { url?: unknown }).url === "string"
    ) {
      const audioUrl = (audio as { url: string }).url;
      const audioResponse = await this.fetchImpl(audioUrl, {
        method: "GET",
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!audioResponse.ok) return undefined;
      const bytes = Buffer.from(await audioResponse.arrayBuffer());
      return bytes.length > 0 ? bytes : undefined;
    }

    // 3. output.audio.data or output.audio string as base64
    if (
      typeof audio === "object" &&
      audio !== null &&
      typeof (audio as { data?: unknown }).data === "string"
    ) {
      const data = (audio as { data: string }).data.trim();
      if (!looksLikeBase64(data)) return undefined;
      const bytes = Buffer.from(data, "base64");
      return bytes.length > 0 ? bytes : undefined;
    }

    if (typeof audio === "string" && looksLikeBase64(audio)) {
      const bytes = Buffer.from(audio.trim(), "base64");
      return bytes.length > 0 ? bytes : undefined;
    }

    // 4. else unavailable
    return undefined;
  }
}
