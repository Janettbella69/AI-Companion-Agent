type StoredClip = {
  speechId: string;
  pcm: Buffer;
  sampleRate: number;
  expiresAtMs: number;
};

export class SpeechStore {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly idFactory: () => string;
  private readonly clips = new Map<string, StoredClip>();

  constructor(options?: {
    now?: () => Date;
    ttlMs?: number;
    idFactory?: () => string;
  }) {
    this.now = options?.now ?? (() => new Date());
    this.ttlMs = options?.ttlMs ?? 30_000;
    this.idFactory =
      options?.idFactory ??
      (() => crypto.randomUUID().replace(/-/g, "").slice(0, 8));
  }

  put(input: {
    deviceId: string;
    pcm: Buffer;
    sampleRate: number;
  }): { speech_id: string; expires_at: string; duration_ms: number } {
    const speechId = `spch_${this.idFactory()}`;
    const expiresAtMs = this.now().getTime() + this.ttlMs;
    const duration_ms = Math.round(
      (input.pcm.byteLength / 2 / input.sampleRate) * 1000,
    );

    this.clips.set(input.deviceId, {
      speechId,
      pcm: input.pcm,
      sampleRate: input.sampleRate,
      expiresAtMs,
    });

    return {
      speech_id: speechId,
      expires_at: new Date(expiresAtMs).toISOString(),
      duration_ms,
    };
  }

  take(
    deviceId: string,
    speechId: string,
  ): { pcm: Buffer; sampleRate: number } | undefined {
    const clip = this.clips.get(deviceId);
    if (!clip || clip.speechId !== speechId) {
      return undefined;
    }

    if (this.now().getTime() >= clip.expiresAtMs) {
      this.clips.delete(deviceId);
      return undefined;
    }

    this.clips.delete(deviceId);
    return { pcm: clip.pcm, sampleRate: clip.sampleRate };
  }
}
