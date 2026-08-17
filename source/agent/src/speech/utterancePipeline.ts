import type { HshhAgent } from "../agent/hshhAgent.js";
import type { DeviceEffectQueue } from "../device/deviceEffectQueue.js";
import type { AgentDecision, Expression } from "../domain/contracts.js";
import type { EventContextGateway } from "../gateway/EventContextGateway.js";
import type { DashScopeSpeechAdapter } from "./dashscopeSpeechAdapter.js";
import type { SpeechStore } from "./speechStore.js";

export const MAX_UTTERANCE_BYTES = 512 * 1024;
export const MIN_UTTERANCE_MS = 300;

const LEGAL_SAMPLE_RATES = new Set([8000, 16000, 22050, 24000]);
const JOB_TTL_MS = 30_000;
const CONSENT_TTL_MS = 10_000;
const EXPRESSION_DURATION_MS = 3500;
const EXPRESSION_INTENSITY = 0.75;
const EFFECT_REASON = "render_utterance_decision";

type UtteranceJob = {
  deviceId: string;
  userId: string;
  utteranceId: string;
  pcm: Buffer;
  sampleRate: number;
  channels: number;
};

type AcceptResult =
  | { ok: true; utterance_id: string; expires_at: string }
  | { ok: false; status: number; reason_code: string };

type LogFields = Record<string, string | number | boolean>;

export class UtterancePipeline {
  private readonly speech: Pick<
    DashScopeSpeechAdapter,
    "transcribePcm" | "synthesizeSpeech"
  >;
  private readonly gateway: EventContextGateway;
  private readonly agent: Pick<HshhAgent, "interact">;
  private readonly speechStore: SpeechStore;
  private readonly effectQueue: DeviceEffectQueue;
  private readonly now: () => Date;
  private readonly log?: (fields: LogFields) => void;
  private readonly jobs = new Map<string, UtteranceJob>();
  private readonly inFlightDevices = new Set<string>();

  constructor(options: {
    speech: Pick<DashScopeSpeechAdapter, "transcribePcm" | "synthesizeSpeech">;
    gateway: EventContextGateway;
    agent: Pick<HshhAgent, "interact">;
    speechStore: SpeechStore;
    effectQueue: DeviceEffectQueue;
    now?: () => Date;
    log?: (fields: LogFields) => void;
  }) {
    this.speech = options.speech;
    this.gateway = options.gateway;
    this.agent = options.agent;
    this.speechStore = options.speechStore;
    this.effectQueue = options.effectQueue;
    this.now = options.now ?? (() => new Date());
    if (options.log !== undefined) {
      this.log = options.log;
    }
  }

  accept(input: {
    deviceId: string;
    userId: string;
    utteranceId: string;
    pcm: Buffer;
    sampleRate: number;
    channels: number;
    format: string;
  }): AcceptResult {
    if (this.inFlightDevices.has(input.deviceId)) {
      return { ok: false, status: 409, reason_code: "utterance_in_flight" };
    }
    if (
      input.format !== "pcm_s16le" ||
      input.channels !== 1 ||
      !LEGAL_SAMPLE_RATES.has(input.sampleRate)
    ) {
      return { ok: false, status: 400, reason_code: "invalid_audio_header" };
    }
    if (input.pcm.length > MAX_UTTERANCE_BYTES) {
      return { ok: false, status: 413, reason_code: "utterance_too_large" };
    }
    if (input.pcm.length / 2 / input.sampleRate < MIN_UTTERANCE_MS / 1000) {
      return { ok: false, status: 400, reason_code: "utterance_too_short" };
    }
    this.jobs.set(input.utteranceId, {
      deviceId: input.deviceId,
      userId: input.userId,
      utteranceId: input.utteranceId,
      pcm: Buffer.from(input.pcm),
      sampleRate: input.sampleRate,
      channels: input.channels,
    });
    this.inFlightDevices.add(input.deviceId);
    return {
      ok: true,
      utterance_id: input.utteranceId,
      expires_at: new Date(this.now().getTime() + JOB_TTL_MS).toISOString(),
    };
  }

  async run(utteranceId: string): Promise<void> {
    const job = this.jobs.get(utteranceId);
    if (!job) {
      return;
    }
    this.jobs.delete(utteranceId);
    const fields: LogFields = {
      utterance_id: job.utteranceId,
      pcm_bytes: job.pcm.length,
      sample_rate: job.sampleRate,
    };
    try {
      await this.execute(job, fields);
    } finally {
      this.inFlightDevices.delete(job.deviceId);
      this.log?.(fields);
    }
  }

  private async execute(job: UtteranceJob, fields: LogFields): Promise<void> {
    const asrStarted = performance.now();
    let asr: Awaited<ReturnType<DashScopeSpeechAdapter["transcribePcm"]>>;
    try {
      asr = await this.speech.transcribePcm({
        pcm: job.pcm,
        sampleRate: job.sampleRate,
        channels: job.channels,
      });
    } catch {
      asr = { status: "failed", reason_code: "asr_unavailable" };
    }
    fields["asr_ms"] = Math.round(performance.now() - asrStarted);
    if (asr.status !== "completed") {
      fields["reason_code"] = asr.reason_code;
      this.enqueueConfused(job);
      return;
    }
    fields["transcript_preview"] = asr.transcript.slice(0, 40);

    const ingested = this.gateway.ingestEvent({
      event: "speech_transcript",
      source: "t5_microphone",
      device_id: job.deviceId,
      user_id: job.userId,
      occurred_at: this.now().toISOString(),
      payload: {
        transcript: asr.transcript,
        media_ref: job.utteranceId,
        confidence: 1,
        summary: "Transcribed T5 microphone utterance",
      },
    });
    if (!ingested.accepted) {
      fields["reason_code"] = ingested.reason_code;
      this.enqueueConfused(job);
      return;
    }

    let decision: AgentDecision;
    try {
      const response = await this.agent.interact({
        request_id: job.utteranceId,
        transcript: asr.transcript,
        locale: "zh-CN",
        device_context: {
          device_id: job.deviceId,
          user_id: job.userId,
          observed_at: this.now().toISOString(),
          presence: "unknown",
          pose: "unknown",
          battery: "unknown",
          safety_state: "stopped",
        },
      });
      decision = response.decision;
    } catch {
      fields["reason_code"] = "agent_error";
      this.enqueueExpression(job, "confused");
      this.enqueueConfused(job);
      return;
    }

    let tts: Awaited<ReturnType<DashScopeSpeechAdapter["synthesizeSpeech"]>>;
    try {
      tts = await this.speech.synthesizeSpeech({
        text: decision.reply_text,
        sampleRate: job.sampleRate,
      });
    } catch {
      tts = { status: "failed", reason_code: "tts_unavailable" };
    }

    if (tts.status === "completed" && tts.pcm.length > 0) {
      fields["tts_bytes"] = tts.pcm.length;
      const stored = this.speechStore.put({
        deviceId: job.deviceId,
        pcm: tts.pcm,
        sampleRate: tts.sampleRate,
      });
      this.effectQueue.enqueuePlaySpeech({
        requestId: job.utteranceId,
        deviceId: job.deviceId,
        speechId: stored.speech_id,
        sampleRate: tts.sampleRate,
        durationMs: stored.duration_ms,
      });
      this.enqueueExpression(job, decision.expression);
      fields["reason_code"] = "ok";
    } else {
      fields["reason_code"] =
        tts.status === "failed" ? tts.reason_code : "tts_unavailable";
      this.enqueueExpression(job, decision.expression);
      this.enqueueConfused(job);
    }

    if (
      decision.requires_user_confirmation &&
      (decision.confirmation_scope === "approach_short" ||
        decision.confirmation_scope === "invite_hug")
    ) {
      this.effectQueue.enqueueConsentOffer({
        requestId: job.utteranceId,
        deviceId: job.deviceId,
        scope: decision.confirmation_scope,
        ttlMs: CONSENT_TTL_MS,
      });
    }
  }

  private enqueueConfused(job: UtteranceJob): void {
    this.effectQueue.enqueue({
      type: "play_sound",
      request_id: job.utteranceId,
      actor_user_id: job.userId,
      device_id: job.deviceId,
      sound: "confused",
      reason: EFFECT_REASON,
    });
  }

  private enqueueExpression(job: UtteranceJob, expression: Expression): void {
    this.effectQueue.enqueue({
      type: "set_expression",
      request_id: job.utteranceId,
      actor_user_id: job.userId,
      device_id: job.deviceId,
      expression,
      intensity: EXPRESSION_INTENSITY,
      duration_ms: EXPRESSION_DURATION_MS,
      reason: EFFECT_REASON,
    });
  }
}
