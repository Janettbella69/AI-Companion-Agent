import assert from "node:assert/strict";
import test from "node:test";
import { SpeechStore } from "../src/speech/speechStore.js";

test("SpeechStore keeps one clip per device, expires, and consumes on take", () => {
  let nowMs = Date.parse("2026-08-16T00:00:00.000Z");
  const idSequence = ["aaaa", "bbbb", "cccc", "dddd"];
  let nextId = 0;
  const store = new SpeechStore({
    now: () => new Date(nowMs),
    ttlMs: 30_000,
    idFactory: () => idSequence[nextId++] ?? "eeee",
  });
  const first = store.put({
    deviceId: "robot-1",
    pcm: Buffer.alloc(32000),
    sampleRate: 16000,
  });
  assert.equal(first.speech_id, "spch_aaaa");
  assert.equal(first.duration_ms, 1000);
  store.put({ deviceId: "robot-1", pcm: Buffer.from([1, 2]), sampleRate: 16000 });
  assert.equal(store.take("robot-1", first.speech_id), undefined);
  const second = store.put({
    deviceId: "robot-1",
    pcm: Buffer.from([3, 4]),
    sampleRate: 16000,
  });
  assert.deepEqual(store.take("other", second.speech_id), undefined);
  assert.deepEqual(store.take("robot-1", second.speech_id)?.pcm, Buffer.from([3, 4]));
  assert.equal(store.take("robot-1", second.speech_id), undefined);
  const third = store.put({
    deviceId: "robot-1",
    pcm: Buffer.from([5, 6]),
    sampleRate: 16000,
  });
  nowMs += 30_001;
  assert.equal(store.take("robot-1", third.speech_id), undefined);
});
