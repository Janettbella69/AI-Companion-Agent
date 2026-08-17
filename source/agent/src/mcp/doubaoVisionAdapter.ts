import type {
  ImageObservation,
} from "../domain/contracts.js";
import type {
  AudioTranscriptionInput,
  KeyframeAnalysisInput,
  PerceptionAdapter,
  PerceptionObservation,
  SensorPerceptionInput,
} from "./perceptionServer.js";

const directionValues = new Set(["left", "center", "right", "unknown"]);

interface DoubaoResponse {
  output_text?: unknown;
  output?: unknown;
  error?: { message?: unknown };
}

interface DoubaoVisionAdapterOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function unavailable(reasonCode: string, now: Date): PerceptionObservation {
  return {
    status: "unavailable",
    reason_code: reasonCode,
    observed_at: now.toISOString(),
    facts: [],
    confidence: 0,
    evidence_ids: [],
  };
}

function imageDataUrl(image: ImageObservation): string | undefined {
  if ("base64" in image) return `data:${image.mime};base64,${image.base64}`;
  if (image.url.startsWith("data:")) return image.url;
  return undefined;
}

function textFromResponse(body: DoubaoResponse): string | undefined {
  if (typeof body.output_text === "string") return body.output_text;
  if (!Array.isArray(body.output)) return undefined;
  for (const item of body.output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "output_text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
    }
  }
  return undefined;
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function observationFromModel(
  value: unknown,
  input: KeyframeAnalysisInput,
): PerceptionObservation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("doubao_invalid_observation");
  }
  const record = value as Record<string, unknown>;
  const personVisible = record.person_visible;
  const direction = record.direction;
  const confidence = record.confidence;
  if (
    typeof personVisible !== "boolean" ||
    typeof direction !== "string" ||
    !directionValues.has(direction) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error("doubao_invalid_observation");
  }
  const normalizedDirection = personVisible ? direction : "unknown";
  const facts = [
    personVisible
      ? "A person is visible in the ESP32-CAM frame."
      : "No person is visible in the ESP32-CAM frame.",
    `The observed user direction is ${normalizedDirection}.`,
  ];
  return {
    status: "completed",
    reason_code: "doubao_vlm_observation",
    observed_at: input.keyframe.observed_at,
    facts,
    confidence,
    evidence_ids: [input.evidence.evidence_id],
    source: "esp32_cam",
  };
}

function noSensorAdapter(
  input: SensorPerceptionInput | AudioTranscriptionInput,
): PerceptionObservation {
  return unavailable("doubao_vision_adapter_not_for_sensor", input.now);
}

/** Isolated VLM adapter. It observes a frame and cannot issue device actions. */
export class DoubaoVisionAdapter implements PerceptionAdapter {
  private readonly apiKey: string;
  private readonly endpoint: URL;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DoubaoVisionAdapterOptions) {
    this.apiKey = options.apiKey.trim();
    this.endpoint = new URL("responses", options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (this.endpoint.protocol !== "https:") {
      throw new Error("HSHH_DOUBAO_BASE_URL must use HTTPS");
    }
    this.model = options.model.trim();
    this.timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 15_000) {
      throw new Error("HSHH_DOUBAO_TIMEOUT_MS must be between 1000 and 15000");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyzeKeyframe(input: KeyframeAnalysisInput): Promise<PerceptionObservation> {
    const image = imageDataUrl(input.keyframe);
    if (image === undefined) return unavailable("doubao_image_payload_unavailable", input.now);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "分析这张 ESP32-CAM 画面。只返回 JSON：person_visible(boolean)、direction(left|center|right|unknown)、confidence(0到1)。不要推测情绪，不要给出动作建议。人物不可见时 direction 必须为 unknown。",
                },
                { type: "input_image", image_url: image },
              ],
            },
          ],
          max_output_tokens: 256,
          temperature: 0,
          thinking: { type: "disabled" },
          text: {
            format: {
              type: "json_schema",
              name: "hshh_camera_observation",
              strict: true,
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  person_visible: { type: "boolean" },
                  direction: { type: "string", enum: ["left", "center", "right", "unknown"] },
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                },
                required: ["person_visible", "direction", "confidence"],
              },
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) return unavailable(`doubao_http_${response.status}`, input.now);
      const body = (await response.json()) as DoubaoResponse;
      const text = textFromResponse(body);
      if (text === undefined) return unavailable("doubao_empty_response", input.now);
      return observationFromModel(parseJson(text), input);
    } catch (error) {
      return unavailable(
        error instanceof Error && error.name === "AbortError"
          ? "doubao_timeout"
          : "doubao_adapter_error",
        input.now,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async detectPose(input: SensorPerceptionInput): Promise<PerceptionObservation> {
    return noSensorAdapter(input);
  }

  async detectGesture(input: SensorPerceptionInput): Promise<PerceptionObservation> {
    return noSensorAdapter(input);
  }

  async transcribeAudio(input: AudioTranscriptionInput): Promise<PerceptionObservation> {
    return noSensorAdapter(input);
  }
}
