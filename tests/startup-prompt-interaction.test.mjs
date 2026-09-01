import test from "node:test";
import assert from "node:assert/strict";

import { getAdapter, resetRegistry } from "../src/adapters/registry.mjs";
import { respondToStartupPrompt } from "../src/partner-invocation.mjs";
import { detectStartupPrompt } from "../src/tui/markers.mjs";

const REGISTRY_OPTIONS = {
  env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" },
};

test("current Claude trust transcript sends Down then Enter as named keys", async () => {
  resetRegistry();
  const claude = getAdapter("claude", REGISTRY_OPTIONS);
  const transcript = [
    "Accessing workspace:",
    "",
    "/private/tmp/dualog-native-mac-smoke",
    "",
    "Quick safety check: Is this a project you created or one you trust?",
    "",
    "❯ No, exit",
    "  Yes, I trust this folder",
    "",
    "Enter to confirm · Esc to cancel",
  ].join("\n");

  const prompt = detectStartupPrompt(claude.tui, transcript, {
    readyWins: claude.tui.suppressStartupWhenReady,
  });
  assert.equal(prompt?.kind, "workspace_trust");
  assert.deepEqual(prompt?.keys, ["down", "enter"]);
  assert.equal(prompt?.input, undefined);

  const calls = [];
  const handle = { paneId: "%42" };
  await respondToStartupPrompt(handle, prompt, {
    sendKey: async (actualHandle, key) => calls.push(["key", actualHandle, key]),
    sendText: async (...args) => calls.push(["text", ...args]),
  });

  assert.deepEqual(calls, [
    ["key", handle, "down"],
    ["key", handle, "enter"],
  ]);
});

test("numbered startup prompts retain pasted-text plus Enter behavior", async () => {
  const calls = [];
  const handle = { paneId: "%7" };
  await respondToStartupPrompt(
    handle,
    { kind: "confirmation", input: "2" },
    {
      sendKey: async (...args) => calls.push(["key", ...args]),
      sendText: async (...args) => calls.push(["text", ...args]),
    }
  );

  assert.deepEqual(calls, [
    ["text", handle, "2", { enter: true, submitDelayMs: 0 }],
  ]);
});
