import assert from "node:assert/strict";
import test from "node:test";
import { DashScopeSpeechAdapter } from "../src/speech/dashscopeSpeechAdapter.js";

test("transcribePcm sends WAV data URI and returns transcript", async () => {
  const calls: Array<{ url: string; body: unknown; headers: Headers }> = [];
  const adapter = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers,
      });
      return new Response(
        JSON.stringify({
          output: { choices: [{ message: { content: [{ text: "你好" }] } }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  const pcm = Buffer.alloc(32000, 1);
  const result = await adapter.transcribePcm({ pcm, sampleRate: 16000, channels: 1 });
  assert.equal(result.status, "completed");
  if (result.status === "completed") assert.equal(result.transcript, "你好");
  assert.match(calls[0]!.url, /multimodal-generation\/generation$/u);
  assert.equal(calls[0]!.headers.get("authorization"), "Bearer sk-test");
  const audio = (calls[0]!.body as { input: { messages: Array<{ content: Array<{ audio: string }> }> } })
    .input.messages[0]!.content[0]!.audio;
  assert.match(audio, /^data:audio\/wav;base64,/u);
  assert.equal(JSON.stringify(calls[0]!.body).includes(pcm.toString("hex")), false);
});

test("transcribePcm maps empty text and HTTP errors to asr_unavailable", async () => {
  const empty = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ output: { choices: [{ message: { content: [{ text: "  " }] } }] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  assert.deepEqual(await empty.transcribePcm({ pcm: Buffer.alloc(32000), sampleRate: 16000, channels: 1 }), {
    status: "failed",
    reason_code: "asr_unavailable",
  });
  const httpFail = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(
    (await httpFail.transcribePcm({ pcm: Buffer.alloc(32000), sampleRate: 16000, channels: 1 })).status,
    "failed",
  );
});

test("synthesizeSpeech requests pcm and returns bytes", async () => {
  const pcm = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const adapter = new DashScopeSpeechAdapter({
    apiKey: "sk-test",
    baseUrl: "https://dashscope.aliyuncs.com/api/v1",
    fetchImpl: async (input, init) => {
      assert.match(String(input), /audio\/tts\/SpeechSynthesizer$/u);
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        input: { text: string; voice: string; format: string; sample_rate: number };
      };
      assert.equal(body.model, "cosyvoice-v3-flash");
      assert.equal(body.input.voice, "longanyang");
      assert.equal(body.input.format, "pcm");
      assert.equal(body.input.sample_rate, 16000);
      assert.equal(body.input.text, "你好");
      return new Response(pcm, { status: 200, headers: { "content-type": "application/octet-stream" } });
    },
  });
  const result = await adapter.synthesizeSpeech({ text: "你好", sampleRate: 16000 });
  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.deepEqual(result.pcm, pcm);
    assert.equal(result.sampleRate, 16000);
  }
});
