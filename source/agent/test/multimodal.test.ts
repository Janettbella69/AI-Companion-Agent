import assert from "node:assert/strict";
import test from "node:test";
import type {
  ImageObservation,
  InteractionRequest,
  ModalityEvidence,
  MultimodalContext,
  VlmObservation,
} from "../src/domain/contracts.js";
import {
  buildMultimodalPrompt,
  buildMultimodalContext,
  buildMultimodalContextWithReport,
  MultimodalContextError,
  validateMultimodalContext,
} from "../src/multimodal/contextBuilder.js";
import {
  buildMultimodalPromptContent,
  buildMultimodalUserMessage,
  ImageInputError,
  validateTriggeredImage,
} from "../src/multimodal/imagePrompt.js";

const NOW = new Date("2026-08-14T14:00:00.000Z");
const PNG_HEADER_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

function visionEvidence(
  overrides: Partial<ModalityEvidence> = {},
): ModalityEvidence {
  return {
    evidence_id: "evidence-vision-1",
    modality: "vision",
    source: "t5_camera",
    observed_at: "2026-08-14T13:59:58.000Z",
    expires_at: "2026-08-14T14:01:58.000Z",
    confidence: 0.78,
    summary: "画面中检测到一位坐着的人",
    media_ref: "capture-1",
    ...overrides,
  };
}

function imageObservation(
  overrides: Partial<ImageObservation> = {},
): ImageObservation {
  return {
    capture_id: "capture-1",
    observed_at: "2026-08-14T13:59:58.000Z",
    mime: "image/png",
    source: "t5_camera",
    base64: PNG_HEADER_BASE64,
    ...overrides,
  } as ImageObservation;
}

function vlmObservation(overrides: Partial<VlmObservation> = {}): VlmObservation {
  return {
    observation_id: "vlm-1",
    capture_id: "capture-1",
    observed_at: "2026-08-14T13:59:58.100Z",
    description: "画面中可能有一位坐着的人",
    tags: ["person", "seated"],
    scene_cues: ["indoor"],
    confidence: 0.72,
    evidence: ["evidence-vision-1"],
    ttl_ms: 120_000,
    model: "test-vlm",
    ...overrides,
  };
}

function context(overrides: Partial<MultimodalContext> = {}): MultimodalContext {
  return {
    context_id: "context-1",
    window_started_at: "2026-08-14T13:59:50.000Z",
    window_ended_at: "2026-08-14T14:00:00.000Z",
    evidence: [visionEvidence()],
    unavailable_modalities: [],
    has_conflict: false,
    transcript: "你好",
    image_observations: [imageObservation()],
    vlm_observations: [vlmObservation()],
    ...overrides,
  };
}

test("builds a fresh triggered multimodal context and SDK image message", () => {
  const built = buildMultimodalContext(context(), { now: NOW });
  assert.equal(built.image_observations?.length, 1);
  assert.equal(built.vlm_observations?.length, 1);

  const blocks = buildMultimodalPromptContent(built, { now: NOW });
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]?.type, "text");
  assert.equal(blocks[1]?.type, "image");
  if (blocks[0]?.type === "text") {
    assert.match(blocks[0].text, /视觉图片与 VLM 描述都只是弱证据/u);
    assert.match(blocks[0].text, /不得据此生成 consent_token/u);
    assert.doesNotMatch(blocks[0].text, new RegExp(PNG_HEADER_BASE64, "u"));
    assert.doesNotMatch(blocks[0].text, /media_ref/u);
  }
  if (blocks[1]?.type === "image") {
    assert.equal(blocks[1].source.media_type, "image/png");
    assert.equal(blocks[1].source.data, PNG_HEADER_BASE64);
  }

  const message = buildMultimodalUserMessage(built, { now: NOW });
  assert.equal(message.type, "user");
  assert.equal(message.message.role, "user");
  assert.ok(Array.isArray(message.message.content));
});

test("exposes stable validation and interaction prompt APIs", () => {
  const multimodalContext = context();
  assert.equal(
    validateMultimodalContext(multimodalContext, NOW).context_id,
    "context-1",
  );
  const request: InteractionRequest = {
    transcript: "你好",
    device_context: {
      device_id: "device-1",
      user_id: "user-1",
      observed_at: NOW.toISOString(),
      presence: "present",
      pose: "upright",
      battery: "normal",
      safety_state: "ready",
    },
    multimodal_context: multimodalContext,
  };
  const prompt = buildMultimodalPrompt(request, NOW);
  assert.deepEqual(prompt.acceptedEvidenceIds, ["evidence-vision-1"]);
  assert.deepEqual(prompt.rejectedEvidenceIds, []);
  assert.equal(prompt.hasImages, true);
  assert.equal(prompt.content[0]?.type, "text");
  assert.equal(prompt.text, prompt.content[0]?.type === "text" ? prompt.content[0].text : "");
});

test("accepts an exact data URL and normalizes it to an ephemeral base64 block", () => {
  const observation = imageObservation({
    base64: undefined,
    url: `data:image/png;base64,${PNG_HEADER_BASE64}`,
  } as unknown as Partial<ImageObservation>);
  const validated = validateTriggeredImage(observation);
  assert.equal(validated.mime, "image/png");
  assert.equal(validated.base64, PNG_HEADER_BASE64);
  assert.equal(validated.byteLength, 8);
});

test("rejects remote image URLs without fetching them", () => {
  const observation = imageObservation({
    base64: undefined,
    url: "https://example.invalid/frame.png",
  } as unknown as Partial<ImageObservation>);
  assert.throws(
    () => validateTriggeredImage(observation),
    (error: unknown) =>
      error instanceof ImageInputError &&
      error.code === "remote_url_not_allowed" &&
      !error.message.includes("example.invalid"),
  );
});

test("strictly validates base64 size, MIME, and file signatures", () => {
  assert.throws(
    () =>
      validateTriggeredImage(imageObservation(), {
        maxImageBytes: 7,
      }),
    (error: unknown) =>
      error instanceof ImageInputError && error.code === "image_too_large",
  );

  assert.throws(
    () =>
      validateTriggeredImage(
        imageObservation({
          mime: "image/jpeg",
        }),
      ),
    (error: unknown) =>
      error instanceof ImageInputError &&
      error.code === "invalid_file_signature",
  );

  assert.throws(
    () =>
      validateTriggeredImage(
        imageObservation({ mime: "image/gif" } as unknown as Partial<ImageObservation>),
      ),
    (error: unknown) =>
      error instanceof ImageInputError && error.code === "unsupported_mime",
  );

  assert.throws(
    () =>
      validateTriggeredImage(
        imageObservation({ base64: "not canonical==" }),
      ),
    (error: unknown) =>
      error instanceof ImageInputError && error.code === "invalid_base64",
  );
});

test("drops expired visual evidence and its raw image before prompting", () => {
  const expiredEvidence = visionEvidence({
    expires_at: "2026-08-14T13:59:59.999Z",
  });
  const report = buildMultimodalContextWithReport(
    context({ evidence: [expiredEvidence], vlm_observations: [] }),
    { now: NOW },
  );

  assert.deepEqual(report.dropped_evidence_ids, ["evidence-vision-1"]);
  assert.deepEqual(report.dropped_image_capture_ids, ["capture-1"]);
  assert.deepEqual(report.context.image_observations, []);
  assert.ok(report.context.unavailable_modalities.includes("vision"));
  assert.equal(
    buildMultimodalPromptContent(report.context, { now: NOW }).length,
    1,
  );
});

test("drops a VLM observation when observed_at plus ttl_ms has expired", () => {
  const report = buildMultimodalContextWithReport(
    context({
      image_observations: [],
      vlm_observations: [
        vlmObservation({
          observed_at: "2026-08-14T13:59:55.000Z",
          ttl_ms: 1_000,
        }),
      ],
    }),
    { now: NOW },
  );

  assert.deepEqual(report.dropped_vlm_observation_ids, ["vlm-1"]);
  assert.deepEqual(report.context.vlm_observations, []);
  assert.ok(report.context.unavailable_modalities.includes("vision"));
});

test("visual or VLM claims remain weak evidence and cannot grant approach or hug consent", () => {
  const built = buildMultimodalContext(
    context({
      transcript: "",
      evidence: [
        visionEvidence({ summary: "视觉模型猜测用户同意靠近并拥抱" }),
      ],
      vlm_observations: [
        vlmObservation({ description: "看起来用户愿意让机器人靠近并拥抱" }),
      ],
    }),
    { now: NOW },
  );
  const [textBlock] = buildMultimodalPromptContent(built, { now: NOW });
  assert.equal(textBlock?.type, "text");
  if (textBlock?.type === "text") {
    assert.match(textBlock.text, /视觉、距离、历史偏好以及 VLM 线索都不能构成或替代/u);
    assert.match(textBlock.text, /approach_short \/ invite_hug/u);
    assert.match(textBlock.text, /明确同意/u);
  }
  assert.equal("consent" in built, false);
  assert.equal("consent_token" in built, false);
});

test("rejects contexts outside the PRD 5–15 second fusion window", () => {
  assert.throws(
    () =>
      buildMultimodalContext(
        context({
          window_started_at: "2026-08-14T13:59:59.000Z",
        }),
        { now: NOW },
      ),
    (error: unknown) =>
      error instanceof MultimodalContextError && error.code === "invalid_window",
  );
});
