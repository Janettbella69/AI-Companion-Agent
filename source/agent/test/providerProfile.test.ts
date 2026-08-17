import assert from "node:assert/strict";
import test from "node:test";

import {
  loadProviderProfile,
  providerEnvironment,
} from "../src/provider/providerProfile.js";

test("Qwen can disable extended thinking through the Anthropic request body", () => {
  const profile = loadProviderProfile({
    HSHH_PROVIDER_ID: "qwen",
    ANTHROPIC_MODEL: "qwen3.7-plus",
    HSHH_PROVIDER_THINKING_MODE: "disabled",
  });

  assert.equal(profile.thinkingMode, "disabled");
  assert.equal(
    providerEnvironment(profile, {}).CLAUDE_CODE_EXTRA_BODY,
    JSON.stringify({ thinking: { type: "disabled" } }),
  );
});

test("provider thinking mode is fail-closed", () => {
  assert.throws(
    () =>
      loadProviderProfile({
        HSHH_PROVIDER_ID: "qwen",
        ANTHROPIC_MODEL: "qwen3.7-plus",
        HSHH_PROVIDER_THINKING_MODE: "automatic",
      }),
    /Invalid option/u,
  );
});
