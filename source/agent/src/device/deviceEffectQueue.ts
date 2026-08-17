import { randomUUID } from "node:crypto";

import type {
  HshhDeviceDispatchResult,
  HshhDeviceEffect,
} from "../mcp/deviceServer.js";

const MAX_QUEUE_DEPTH = 64;
const EFFECT_TTL_MS = 30_000;

export type T5DeviceEffect =
  | {
      effect_id: string;
      sequence: number;
      request_id: string;
      device_id: string;
      type: "set_expression";
      expression: HshhDeviceEffect & { type: "set_expression" } extends infer T
        ? T extends { expression: infer E }
          ? E
          : never
        : never;
      intensity: number;
      duration_ms: number;
      created_at: string;
      expires_at: string;
    }
  | {
      effect_id: string;
      sequence: number;
      request_id: string;
      device_id: string;
      type: "play_sound";
      sound: HshhDeviceEffect & { type: "play_sound" } extends infer T
        ? T extends { sound: infer S }
          ? S
          : never
        : never;
      created_at: string;
      expires_at: string;
    }
  | {
      effect_id: string;
      sequence: number;
      request_id: string;
      device_id: string;
      type: "offer_consent";
      consent_scope: "approach_short" | "invite_hug";
      created_at: string;
      expires_at: string;
    }
  | {
      effect_id: string;
      sequence: number;
      request_id: string;
      device_id: string;
      type: "play_speech";
      speech_id: string;
      sample_rate: number;
      format: "pcm_s16le";
      duration_ms: number;
      created_at: string;
      expires_at: string;
    };

export interface DeviceEffectQueueOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class DeviceEffectQueue {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly effects: T5DeviceEffect[] = [];
  private readonly acknowledged = new Map<string, HshhDeviceDispatchResult>();
  /**
   * Start from unix seconds so a process restart cannot reuse 1, 2, 3…
   * while T5 still holds a higher in-RAM cursor and silently skips play_speech.
   */
  private sequence: number;

  constructor(options: DeviceEffectQueueOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.sequence = Math.max(1, Math.floor(this.now().getTime() / 1000));
  }

  enqueue(effect: HshhDeviceEffect): HshhDeviceDispatchResult {
    if (effect.type === "safe_skill") {
      return { status: "rejected", reason_code: "effect_queue_motion_forbidden" };
    }
    const now = this.now();
    this.cleanup(now);
    const duplicate = this.effects.find(
      (item) =>
        item.device_id === effect.device_id &&
        item.request_id === effect.request_id &&
        item.type === effect.type,
    );
    if (duplicate) {
      return { status: "accepted", reason_code: "effect_already_queued" };
    }
    if (this.effects.length >= MAX_QUEUE_DEPTH) {
      return { status: "failed", reason_code: "effect_queue_full" };
    }
    this.sequence += 1;
    const common = {
      effect_id: `effect_${this.idFactory()}`,
      sequence: this.sequence,
      request_id: effect.request_id,
      device_id: effect.device_id,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + EFFECT_TTL_MS).toISOString(),
    };
    this.effects.push(
      effect.type === "set_expression"
        ? {
            ...common,
            type: "set_expression",
            expression: effect.expression,
            intensity: effect.intensity,
            duration_ms: effect.duration_ms,
          }
        : {
            ...common,
            type: "play_sound",
            sound: effect.sound,
          },
    );
    return { status: "accepted", reason_code: "effect_queued_for_t5" };
  }

  enqueueConsentOffer(input: {
    requestId: string;
    deviceId: string;
    scope: "approach_short" | "invite_hug";
    ttlMs?: number;
  }): HshhDeviceDispatchResult {
    const now = this.now();
    this.cleanup(now);
    const duplicate = this.effects.find(
      (item) =>
        item.device_id === input.deviceId &&
        item.request_id === input.requestId &&
        item.type === "offer_consent",
    );
    if (duplicate) {
      return { status: "accepted", reason_code: "effect_already_queued" };
    }
    if (this.effects.length >= MAX_QUEUE_DEPTH) {
      return { status: "failed", reason_code: "effect_queue_full" };
    }
    const ttlMs = Math.max(1_000, Math.min(15_000, input.ttlMs ?? 10_000));
    this.sequence += 1;
    this.effects.push({
      effect_id: `effect_${this.idFactory()}`,
      sequence: this.sequence,
      request_id: input.requestId,
      device_id: input.deviceId,
      type: "offer_consent",
      consent_scope: input.scope,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttlMs).toISOString(),
    });
    return { status: "accepted", reason_code: "consent_offer_queued_for_t5" };
  }

  enqueuePlaySpeech(input: {
    requestId: string;
    deviceId: string;
    speechId: string;
    sampleRate: number;
    durationMs: number;
  }): HshhDeviceDispatchResult {
    const now = this.now();
    this.cleanup(now);
    const duplicate = this.effects.find(
      (item) =>
        item.device_id === input.deviceId &&
        item.request_id === input.requestId &&
        item.type === "play_speech",
    );
    if (duplicate) {
      return { status: "accepted", reason_code: "effect_already_queued" };
    }
    if (this.effects.length >= MAX_QUEUE_DEPTH) {
      return { status: "failed", reason_code: "effect_queue_full" };
    }
    this.sequence += 1;
    this.effects.push({
      effect_id: `effect_${this.idFactory()}`,
      sequence: this.sequence,
      request_id: input.requestId,
      device_id: input.deviceId,
      type: "play_speech",
      speech_id: input.speechId,
      sample_rate: input.sampleRate,
      format: "pcm_s16le",
      duration_ms: input.durationMs,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + EFFECT_TTL_MS).toISOString(),
    });
    return { status: "accepted", reason_code: "speech_queued_for_t5" };
  }

  list(deviceId: string, afterSequence = 0, limit = 16): T5DeviceEffect[] {
    const now = this.now();
    this.cleanup(now);
    const safeLimit = Math.max(1, Math.min(32, Math.trunc(limit)));
    return this.effects
      .filter(
        (item) =>
          item.device_id === deviceId && item.sequence > Math.max(0, afterSequence),
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, safeLimit)
      .map((item) => structuredClone(item));
  }

  peek(deviceId: string, effectId: string): T5DeviceEffect | undefined {
    return this.effects.find(
      (item) => item.device_id === deviceId && item.effect_id === effectId,
    );
  }

  acknowledge(
    deviceId: string,
    effectId: string,
    result: HshhDeviceDispatchResult,
  ): boolean {
    const index = this.effects.findIndex(
      (item) => item.device_id === deviceId && item.effect_id === effectId,
    );
    if (index < 0) return this.acknowledged.has(`${deviceId}:${effectId}`);
    this.effects.splice(index, 1);
    this.acknowledged.set(`${deviceId}:${effectId}`, { ...result });
    if (this.acknowledged.size > MAX_QUEUE_DEPTH * 2) {
      const oldest = this.acknowledged.keys().next().value;
      if (typeof oldest === "string") this.acknowledged.delete(oldest);
    }
    return true;
  }

  private cleanup(now: Date): void {
    const nowMs = now.getTime();
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      if (Date.parse(this.effects[index]!.expires_at) <= nowMs) {
        this.effects.splice(index, 1);
      }
    }
  }
}
