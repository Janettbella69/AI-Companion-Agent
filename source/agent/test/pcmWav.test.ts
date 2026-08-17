import assert from "node:assert/strict";
import test from "node:test";
import { wrapPcmS16LeAsWav } from "../src/speech/pcmWav.js";
import { loadConfig } from "../src/config.js";

test("wrapPcmS16LeAsWav writes a 44-byte header and preserves PCM", () => {
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const wav = wrapPcmS16LeAsWav(pcm, 16000, 1);
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("loadConfig reads DASHSCOPE_API_KEY without using the Doubao key", () => {
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      DASHSCOPE_API_KEY: "sk-speech-test",
      HSHH_DOUBAO_API_KEY: "ark-not-for-speech",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  assert.equal(config.dashscopeApiKey, "sk-speech-test");
  assert.equal(config.dashscopeBaseUrl, "https://dashscope.aliyuncs.com/api/v1");
  assert.equal(config.doubaoVisionApiKey, "ark-not-for-speech");
});

test("loadConfig reuses the Qwen DashScope token for speech when DASHSCOPE_API_KEY is unset", () => {
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "qwen",
      ANTHROPIC_MODEL: "qwen3.7-plus",
      ANTHROPIC_AUTH_TOKEN: "sk-qwen-chat",
      HSHH_DOUBAO_API_KEY: "ark-not-for-speech",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  assert.equal(config.dashscopeApiKey, "sk-qwen-chat");
  assert.equal(config.doubaoVisionApiKey, "ark-not-for-speech");
});

test("loadConfig does not treat a non-Qwen chat token or Doubao key as speech", () => {
  const config = loadConfig(
    {
      HSHH_PROVIDER_ID: "anthropic",
      ANTHROPIC_MODEL: "sonnet",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-not-speech",
      HSHH_DOUBAO_API_KEY: "ark-not-for-speech",
      HSHH_DATABASE_PATH: ":memory:",
    },
    process.cwd(),
  );
  assert.equal(config.dashscopeApiKey, undefined);
  assert.equal(config.doubaoVisionApiKey, "ark-not-for-speech");
});
