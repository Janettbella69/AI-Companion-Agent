import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSystemPrompt,
  buildTrustedTurnContext,
} from "../src/agent/systemPrompt.js";

test("builds a static HSHH constitution for the native Claude Code preset", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /# HSHH 身份与工作方式/u);
  assert.match(prompt, /一两句经常足够，但不是硬性上限/u);
  assert.match(prompt, /只有 Gateway 签发/u);
  assert.match(prompt, /AgentDecision JSON Schema/u);
  assert.match(prompt, /不得用 null、空字符串、空对象/u);
  assert.doesNotMatch(prompt, /user_id:/u);
  assert.doesNotMatch(prompt, /device_id:/u);
  assert.doesNotMatch(prompt, /长期记忆: (?:用户已启用|未启用)/u);
  assert.doesNotMatch(prompt, /当前任务模式:/u);
  assert.equal(prompt, buildSystemPrompt());
});

test("serializes changing host state into a separate trusted turn context", () => {
  const context = buildTrustedTurnContext({
    memoryEnabled: true,
    supportsVision: false,
    taskMode: "deep_research",
  });

  assert.match(context, /^<hshh_trusted_turn_context>/u);
  assert.match(context, /"task_mode":"deep_research"/u);
  assert.match(context, /"long_term_enabled":true/u);
  assert.match(context, /"direct_image_input":false/u);
  assert.match(context, /<\/hshh_trusted_turn_context>$/u);
});
