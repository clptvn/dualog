// TUI marker matching.
//
// Two jobs:
//  1. Equivalence -- the data-driven matcher must agree with the hand-written
//     per-agent string matching it replaces, across a realistic pane corpus.
//  2. Cross-contamination -- one adapter's ready/idle markers must never match
//     another adapter's busy screen. `>` and `❯` appear in almost every CLI's
//     prompt, so this is the failure mode that would actually bite.

import test from "node:test";
import assert from "node:assert/strict";
import {
  isReady,
  isIdlePrompt,
  isBlocked,
  detectStartupPrompt,
} from "../src/tui/markers.mjs";
import { getAdapter, resetRegistry } from "../src/adapters/registry.mjs";

resetRegistry();
const REG = { env: { XDG_CONFIG_HOME: "/nonexistent", XDG_CONFIG_DIRS: "" } };
const claude = getAdapter("claude", REG);
const codex = getAdapter("codex", REG);

// --- Pane corpus ----------------------------------------------------------
// Transcribed from the shapes the existing matchers were written against.

const PANES = {
  codexReady: [
    "OpenAI Codex (v1.2.3)",
    "",
    "  To get started, describe a task or try one of these commands:",
    "",
    "› ",
    "  Context 92% left    /model to change",
  ].join("\n"),

  codexBooting: [
    "OpenAI Codex (v1.2.3)",
    "",
    "› ",
    "  Booting MCP server...",
  ].join("\n"),

  // The critical scrollback case: booted long ago, ready now. The transcript
  // must exceed the not-ready tail window, which is the situation the tail
  // scoping exists to handle.
  codexBootedThenReady: [
    "OpenAI Codex (v1.2.3)",
    "  Booting MCP server...",
    ...Array.from(
      { length: 150 },
      (_, i) => `  transcript line ${i}: investigating the reported failure path`
    ),
    "› ",
    "  Context 71% left    /model to change",
  ].join("\n"),

  codexBusy: [
    "OpenAI Codex (v1.2.3)",
    "  Context 88% left",
    "",
    "• Thinking... (12s • 3.4k tokens)",
  ].join("\n"),

  codexTrust: [
    "  Do you trust the contents of this directory?",
    "",
    "  1. Yes, continue",
    "  2. No, quit",
  ].join("\n"),

  codexTrustAlt: [
    "  Do you trust this folder?",
    "  Trusting the directory allows Codex to read and edit files.",
    "  2. No, quit",
  ].join("\n"),

  codexMcpApproval: [
    '  Allow the mcp-search MCP server to run tool "smart_search"?',
    "    query: artifact read",
    "    path: /fixture/project",
    "    1. Allow   2. Allow for this session   3. Always allow   4. Cancel",
  ].join("\n"),

  claudeReady: [
    "Claude Code v2.1.0",
    "",
    '  Try "explain this codebase"',
    "",
    "❯ ",
    "  bypass permissions on                      shift+tab to cycle",
  ].join("\n"),

  claudeBusy: [
    "Claude Code v2.1.0",
    "",
    "✻ Pondering... (18s · 5.1k tokens · esc to interrupt)",
  ].join("\n"),

  claudeTrust: [
    "  Quick safety check",
    "",
    "  Do you trust the files in this folder?",
    "  1. Yes, I trust this folder",
    "  2. No, exit",
  ].join("\n"),

  claudeBypassWarning: [
    "  WARNING: Bypass Permissions mode",
    "",
    "  In Bypass Permissions mode, Claude Code will not ask for confirmation.",
    "",
    "  1. No, cancel",
    "  2. Yes, I accept",
  ].join("\n"),

  claudeTheme: [
    "  Choose the text style that looks best with your terminal:",
    "",
    "  1. Dark mode",
    "  2. Light mode",
  ].join("\n"),

  empty: "",
};

// --- Reference implementations --------------------------------------------
// Copied verbatim from the pre-refactor source. These are the behavior we must
// not change; they are deleted once the swap is complete.

function refIsInteractiveReady(agent, snapshot) {
  if (agent === "claude") {
    const hasClaudeHeader =
      /Claude Code v\d+\.\d+\.\d+/u.test(snapshot) || snapshot.includes("Claude Code v");
    const hasPromptUi =
      snapshot.includes('Try "') ||
      snapshot.includes("shift+tab to cycle") ||
      snapshot.includes("bypass permissions on") ||
      snapshot.includes("plan mode on");
    return hasClaudeHeader && hasPromptUi;
  }
  const tail = snapshot.slice(-2000);
  if (tail.includes("Booting MCP server") || /model:\s+loading/u.test(tail)) return false;
  const hasCodexHeader =
    /OpenAI Codex \(v\d+\.\d+\.\d+\)/u.test(snapshot) || snapshot.includes("OpenAI Codex");
  const hasPromptUi =
    snapshot.includes("›") ||
    snapshot.includes("Context ") ||
    snapshot.includes("/model to change") ||
    snapshot.includes("Tip: Try the Codex App");
  return hasCodexHeader && hasPromptUi;
}

function refDetectStartupPrompt(agent, snapshot) {
  const tail = snapshot.slice(-4000);
  const lowerTail = tail.toLowerCase();
  if (agent === "claude") {
    if (refIsInteractiveReady(agent, snapshot)) return null;
    if (
      snapshot.includes("Quick safety check") &&
      snapshot.includes("Yes, I trust this folder") &&
      snapshot.includes("No, exit")
    ) {
      return { kind: "workspace_trust", input: "1" };
    }
    if (
      lowerTail.includes("bypass permissions") &&
      (lowerTail.includes("warning") || lowerTail.includes("mode")) &&
      (lowerTail.includes("yes, i accept") ||
        /^\s*(?:\d+[\).]?\s*)?(?:yes|accept|continue)\b.*(?:accept|bypass|permission|continue)/imu.test(
          tail
        )) &&
      /^[^\w\n]*(?:\d+[\).]?\s*)?(?:no|cancel|exit)\b/imu.test(tail)
    ) {
      return { kind: "bypass_permissions_warning", input: "2" };
    }
    if (lowerTail.includes("choose") && (lowerTail.includes("theme") || lowerTail.includes("text style"))) {
      return { kind: "theme_picker", input: "" };
    }
    return null;
  }
  if (
    snapshot.includes("Do you trust the contents of this directory") &&
    snapshot.includes("Yes, continue") &&
    snapshot.includes("No, quit")
  ) {
    return { kind: "workspace_trust", input: "1" };
  }
  if (
    snapshot.includes("Do you trust") &&
    snapshot.includes("Trusting the directory") &&
    snapshot.includes("No, quit")
  ) {
    return { kind: "workspace_trust", input: "1" };
  }
  return null;
}

function refDetectIdlePrompt(snapshot, agent) {
  const lines = String(snapshot).split(/\r?\n/u).filter((l) => l.trim());
  const tailOriginal = lines.slice(-8).join("\n");
  const tail = tailOriginal
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[^\x20-\x7E]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
  if (agent === "claude") {
    return (
      /(?:❯|›)\s*$/u.test(tailOriginal) ||
      tail.includes('try "') ||
      tail.includes("shift+tab to cycle") ||
      tail.includes("bypass permissions on")
    );
  }
  return (
    /(?:❯|›)\s*$/u.test(tailOriginal) ||
    tail.includes("/model to change") ||
    tail.includes("tip: try the codex app") ||
    tail.includes("context ")
  );
}

// --- Equivalence ----------------------------------------------------------

const AGENTS = [
  ["claude", claude],
  ["codex", codex],
];

for (const [agent, adapter] of AGENTS) {
  for (const [paneName, snapshot] of Object.entries(PANES)) {
    test(`ready matches reference: ${agent} / ${paneName}`, () => {
      assert.equal(
        isReady(adapter.tui, snapshot),
        refIsInteractiveReady(agent, snapshot),
        `readiness diverged for ${agent} on ${paneName}`
      );
    });

    test(`idle matches reference: ${agent} / ${paneName}`, () => {
      assert.equal(
        isIdlePrompt(adapter.tui, snapshot),
        refDetectIdlePrompt(snapshot, agent),
        `idle detection diverged for ${agent} on ${paneName}`
      );
    });

    test(`startup prompt matches reference: ${agent} / ${paneName}`, () => {
      const actual = detectStartupPrompt(adapter.tui, snapshot, {
        readyWins: adapter.tui.suppressStartupWhenReady,
      });
      const expected = refDetectStartupPrompt(agent, snapshot);
      assert.equal(
        actual?.kind ?? null,
        expected?.kind ?? null,
        `startup kind diverged for ${agent} on ${paneName}`
      );
      assert.equal(actual?.input ?? null, expected?.input ?? null);
    });
  }
}

// --- Behavior the corpus exists to pin down -------------------------------

test("a booting pane is not ready even though the banner is present", () => {
  assert.equal(isReady(codex.tui, PANES.codexBooting), false);
});

test("a stale boot line in scrollback does not pin the pane to not-ready", () => {
  // The whole reason notReady is tail-scoped. Getting this wrong hangs every
  // turn after the first, silently.
  assert.equal(isReady(codex.tui, PANES.codexBootedThenReady), true);
});

test("startup interstitials are detected before the prompt exists", () => {
  assert.equal(detectStartupPrompt(codex.tui, PANES.codexTrust)?.input, "1");
  assert.equal(detectStartupPrompt(codex.tui, PANES.codexTrustAlt)?.input, "1");
  assert.equal(
    detectStartupPrompt(claude.tui, PANES.claudeTrust, { readyWins: true })?.input,
    "1"
  );
  assert.equal(
    detectStartupPrompt(claude.tui, PANES.claudeBypassWarning, { readyWins: true })?.input,
    "2"
  );
  assert.equal(
    detectStartupPrompt(claude.tui, PANES.claudeTheme, { readyWins: true })?.kind,
    "theme_picker"
  );
});

test("Codex MCP approvals are blocked prompts, while busy panes are not", () => {
  assert.equal(isBlocked(claude.tui, PANES.claudeBusy), false);
  assert.equal(isBlocked(codex.tui, PANES.codexBusy), false);
  assert.equal(isBlocked(codex.tui, PANES.codexMcpApproval), true);
});

// --- Cross-contamination --------------------------------------------------

test("no adapter reports ready on another adapter's screens", () => {
  const foreign = {
    claude: ["codexReady", "codexBusy", "codexTrust", "codexBooting"],
    codex: ["claudeReady", "claudeBusy", "claudeTrust", "claudeTheme"],
  };
  for (const [agent, adapter] of AGENTS) {
    for (const paneName of foreign[agent]) {
      assert.equal(
        isReady(adapter.tui, PANES[paneName]),
        false,
        `${agent} reported ready on ${paneName}`
      );
    }
  }
});

test("claude distinguishes its own busy screen from ready", () => {
  assert.equal(isReady(claude.tui, PANES.claudeBusy), false);
});

test("KNOWN LIMITATION: codex readiness cannot distinguish busy from ready", () => {
  // "Context " is part of the persistent status bar, so it is present while
  // the agent is working too. This is pre-existing behavior, preserved here
  // deliberately rather than quietly changed during a refactor -- the engine
  // compensates by also accepting a busy pane and by gating completion on the
  // sidecar files rather than on readiness.
  //
  // Fixing it means adding busy markers and checking them ahead of ready.
  assert.equal(isReady(codex.tui, PANES.codexBusy), true);
});

test("an empty pane is never ready, idle, or blocked", () => {
  for (const [, adapter] of AGENTS) {
    assert.equal(isReady(adapter.tui, PANES.empty), false);
    assert.equal(isIdlePrompt(adapter.tui, PANES.empty), false);
    assert.equal(isBlocked(adapter.tui, PANES.empty), false);
  }
});
