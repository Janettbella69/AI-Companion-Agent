import assert from "node:assert/strict";
import test from "node:test";
import type { ImageObservation, ModalityEvidence } from "../src/domain/contracts.js";
import { DoubaoVisionAdapter } from "../src/mcp/doubaoVisionAdapter.js";

const NOW = new Date("2026-08-15T12:00:00.000Z");

const image: ImageObservation = {
  capture_id: "capture-1",
  observed_at: NOW.toISOString(),
  mime: "image/jpeg",
  source: "esp32_cam",
  base64: "/9j/4AAQSkZJRgABAQAAAQABAAD/",
};

const evidence: ModalityEvidence = {
  evidence_id: "evidence-1",
  modality: "vision",
  source: "esp32_cam",
  observed_at: NOW.toISOString(),
  expires_at: new Date(NOW.getTime() + 5_000).toISOString(),
  confidence: 1,
  summary: "An event-triggered still was captured",
  media_ref: "capture-1",
};

test("DoubaoVisionAdapter sends the frame to Responses and returns observation facts", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new DoubaoVisionAdapter({
    apiKey: "ark-test-key",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-1-turbo-260628",
    fetchImpl: async (input, init) => {
      assert.equal(new URL(input).pathname, "/api/v3/responses");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer ark-test-key",
      );
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            person_visible: true,
            direction: "left",
            confidence: 0.93,
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await adapter.analyzeKeyframe({
    deviceId: "device-1",
    captureId: "capture-1",
    keyframe: image,
    evidence,
    now: NOW,
  });

  assert.equal(result.status, "completed");
  if (result.status === "completed") {
    assert.equal(result.reason_code, "doubao_vlm_observation");
    assert.deepEqual(result.evidence_ids, ["evidence-1"]);
    assert.equal(result.source, "esp32_cam");
    assert.equal(result.confidence, 0.93);
    assert.match(result.facts[1] ?? "", /left/u);
  }
  const input = requestBody?.input as Array<Record<string, unknown>>;
  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
  const content = input[0]?.content as Array<Record<string, unknown>>;
  assert.equal(content[1]?.type, "input_image");
  assert.equal(
    content[1]?.image_url,
    `data:image/jpeg;base64,${image.base64}`,
  );
});

test("DoubaoVisionAdapter never turns a failed request into a motion observation", async () => {
  const adapter = new DoubaoVisionAdapter({
    apiKey: "ark-test-key",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "doubao-seed-2-1-turbo-260628",
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: { message: "quota" } }), {
        status: 429,
      }),
  });

  const result = await adapter.analyzeKeyframe({
    deviceId: "device-1",
    captureId: "capture-1",
    keyframe: image,
    evidence,
    now: NOW,
  });
  assert.deepEqual(result, {
    status: "unavailable",
    reason_code: "doubao_http_429",
    observed_at: NOW.toISOString(),
    facts: [],
    confidence: 0,
    evidence_ids: [],
  });
});
