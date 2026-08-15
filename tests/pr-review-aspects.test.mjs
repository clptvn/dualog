// The PR review specialist panel.
//
// Two things here are contracts rather than implementation details, and both
// are cross-module: what a specialist pass is allowed to say (it must not be
// able to approve the review by itself), and which normalized finding
// categories the approval gate in shared.mjs will actually act on. Either can
// break without any code in this file changing -- a looser verdict regex in
// shared.mjs, or a category renamed in a prompt -- so they are asserted against
// the real consumers rather than restated here.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ASPECT_IDS,
  AUTO_ASPECT_IDS,
  FINDING_CATEGORIES,
  PR_REVIEW_ASPECTS,
  buildAggregationPrompt,
  buildAspectPrompt,
  extractAspectResult,
  extractNormalizedFindings,
  selectAspects,
  summarizeDiff,
  suppressVerdictLines,
} from "../src/pr-review-aspects.mjs";
import { computeReviewStatus, extractReviewVerdict } from "../src/shared.mjs";

const META = {
  scope_label: "pull request #7 (feature → main)",
  diff_stat: "1 file(s) changed:\n  src/app.ts",
  pr: {
    number: 7,
    title: "Add retry",
    body: "Adds a retry loop.",
    author: "someone",
    base: "main",
    head: "feature",
    url: "https://example.invalid/pr/7",
  },
};

function diffFor(file, addedLines) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,3 +1,6 @@",
    " const untouched = 1;",
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");
}

// ── Diff summarization ──────────────────────────────────────────────────────

test("summarizeDiff names changed files from the git headers", () => {
  const diff = [diffFor("src/a.ts", ["const x = 1;"]), diffFor("src/b.go", ["var y int"])].join("\n");
  const facts = summarizeDiff(diff);
  assert.deepEqual(facts.files, ["src/a.ts", "src/b.go"]);
  assert.equal(facts.touchesLogic, true);
});

test("summarizeDiff recognizes test files across several conventions", () => {
  for (const file of [
    "tests/foo.test.mjs",
    "src/__tests__/foo.tsx",
    "pkg/thing_test.go",
    "app/test_parser.py",
    "spec/models/user.rb",
  ]) {
    const facts = summarizeDiff(diffFor(file, ["assert(true)"]));
    assert.equal(facts.touchesTests, true, `${file} should be seen as a test file`);
  }
});

test("summarizeDiff does not treat a source file as a test file", () => {
  const facts = summarizeDiff(diffFor("src/latest.ts", ["export const x = 1;"]));
  assert.equal(facts.touchesTests, false);
  assert.equal(facts.touchesLogic, true);
});

test("summarizeDiff flags error handling, comments, and types only when added or removed", () => {
  const errors = summarizeDiff(diffFor("src/a.ts", ["try {", "} catch (err) {", "}"]));
  assert.equal(errors.touchesErrorHandling, true);

  const comments = summarizeDiff(diffFor("src/a.ts", ["// explain the thing"]));
  assert.equal(comments.touchesComments, true);

  const types = summarizeDiff(diffFor("src/a.ts", ["export interface User { id: string }"]));
  assert.equal(types.touchesTypes, true);
});

test("summarizeDiff ignores unchanged context lines", () => {
  // The comment and the catch are CONTEXT -- they were already there. Counting
  // them would select the comment and error aspects on nearly every diff, which
  // is the failure mode that makes an auto-selected panel meaningless.
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,4 +1,5 @@",
    " // a pre-existing comment",
    " } catch (err) {",
    " interface Existing { a: string }",
    "+const added = 1;",
  ].join("\n");
  const facts = summarizeDiff(diff);
  assert.equal(facts.touchesComments, false);
  assert.equal(facts.touchesErrorHandling, false);
  assert.equal(facts.touchesTypes, false);
});

test("summarizeDiff does not mistake a file header for a changed line", () => {
  // The header skip is load-bearing for `--- a/...`, not for `+++ b/...`:
  // COMMENT_RE's SQL alternative (`-- `) matches the `---` line, so without the
  // skip touchesComments would go true on EVERY diff and the comment specialist
  // would be auto-selected always, which is the same as never selecting it
  // deliberately. TYPE_RE happens not to match `+++ b/src/types.ts`, so a
  // types-only assertion here passed with or without the skip and guarded
  // nothing.
  const facts = summarizeDiff(diffFor("src/types.ts", ["const x = 1;"]));
  assert.equal(
    facts.touchesComments,
    false,
    "the `--- a/...` header was scanned as a changed comment line"
  );
  assert.equal(facts.touchesTypes, false);
});

// ── Aspect selection ────────────────────────────────────────────────────────

test("the general code aspect is always selected", () => {
  const { selected } = selectAspects(diffFor("README.md", ["hello"]));
  assert.ok(selected.includes("code"));
});

test("simplify is never auto-selected", () => {
  const diff = diffFor("src/a.ts", [
    "// c",
    "try { x() } catch (e) {}",
    "interface T { a: string }",
  ]);
  const { selected, decisions } = selectAspects(diff);
  assert.ok(!selected.includes("simplify"));
  assert.ok(!AUTO_ASPECT_IDS.includes("simplify"));
  const decision = decisions.find((d) => d.aspect === "simplify");
  assert.match(decision.reason, /opt-in/i);
});

test("auto-selection reports a reason for every aspect, selected or not", () => {
  const { decisions } = selectAspects(diffFor("docs/x.md", ["text"]));
  assert.equal(decisions.length, ASPECT_IDS.length);
  for (const decision of decisions) {
    assert.ok(decision.reason && decision.reason.length > 0, `${decision.aspect} has no reason`);
  }
});

test("an explicit aspect list overrides detection in both directions", () => {
  // simplify is opt-in and would never be auto-selected; code is always
  // auto-selected. Asking for only simplify must produce exactly that.
  const { selected } = selectAspects(diffFor("src/a.ts", ["const x = 1;"]), ["simplify"]);
  assert.deepEqual(selected, ["simplify"]);
});

test("an unknown aspect is rejected rather than silently dropped", () => {
  assert.throws(
    () => selectAspects(diffFor("src/a.ts", ["x"]), ["security-theatre"]),
    /Unknown review aspect/
  );
});

test("a logic change with no test change still selects the test aspect", () => {
  const { selected } = selectAspects(diffFor("src/parser.ts", ["export function parse() {}"]));
  assert.ok(
    selected.includes("tests"),
    "untested new logic is exactly the case the test specialist exists for"
  );
});

// ── Prompt construction ─────────────────────────────────────────────────────

function aspectPrompt(aspect, overrides = {}) {
  return buildAspectPrompt({
    aspect,
    meta: META,
    diff: diffFor("src/a.ts", ["const x = 1;"]),
    projectPath: "/tmp/project",
    maxDiffChars: 50000,
    passIndex: 1,
    passTotal: 3,
    ...overrides,
  });
}

test("every aspect builds a prompt carrying its own rubric", () => {
  for (const id of ASPECT_IDS) {
    const prompt = aspectPrompt(id);
    assert.ok(prompt.includes(PR_REVIEW_ASPECTS[id].title), `${id} prompt omits its title`);
    assert.ok(prompt.includes("### Normalized Findings"), `${id} prompt omits the findings contract`);
    assert.ok(prompt.includes(`ASPECT: ${id}`), `${id} prompt omits its footer id`);
  }
});

test("no specialist pass is allowed to emit a review verdict", () => {
  // The load-bearing invariant of the panel. shared.mjs resolves the whole
  // session from any partner line beginning VERDICT/STATUS/REVIEW_VERDICT, so a
  // specialist instructed to write one would let the first clean lens approve a
  // review whose other passes had not run.
  for (const id of ASPECT_IDS) {
    const prompt = aspectPrompt(id);
    assert.ok(
      !/^\s*REVIEW_VERDICT:/m.test(prompt),
      `the ${id} prompt instructs a bare REVIEW_VERDICT line`
    );
  }
});

test("the diff is embedded, and truncation is disclosed rather than hidden", () => {
  const big = diffFor("src/a.ts", [`const x = "${"y".repeat(5000)}";`]);
  const prompt = buildAspectPrompt({
    aspect: "code",
    meta: META,
    diff: big,
    projectPath: "/tmp/project",
    maxDiffChars: 200,
    passIndex: 1,
    passTotal: 2,
  });
  assert.ok(prompt.includes("only the first 200"));
  assert.ok(prompt.includes("do not draw conclusions about the unshown portion"));
});

test("earlier findings are passed forward so passes do not re-file them", () => {
  const prompt = aspectPrompt("tests", {
    priorFindings: ["[CRITICAL] src/a.ts:1 — boom"],
  });
  assert.ok(prompt.includes("Already Reported by Earlier Passes"));
  assert.ok(prompt.includes("boom"));
});

test("the consolidation prompt is the one that carries the verdict contract", () => {
  const prompt = buildAggregationPrompt({
    meta: META,
    projectPath: "/tmp/project",
    reports: [{ aspect: "code", content: "found nothing", failed: false }],
    skipped: [{ aspect: "types", reason: "no type definitions added or modified" }],
    hostDisplay: "Claude",
  });
  assert.ok(/REVIEW_VERDICT: <APPROVE\|CHANGES_REQUESTED\|NEEDS_DISCUSSION>/.test(prompt));
  assert.ok(prompt.includes("Aspects NOT Reviewed"));
  assert.ok(prompt.includes("no type definitions added or modified"));
});

test("a failed pass reaches consolidation as unreviewed, not as clean", () => {
  const prompt = buildAggregationPrompt({
    meta: META,
    projectPath: "/tmp/project",
    reports: [
      { aspect: "code", content: "ok", failed: false },
      { aspect: "errors", content: "", failed: true, error: "partner timed out" },
    ],
    skipped: [],
    hostDisplay: "Claude",
  });
  assert.ok(prompt.includes("UNREVIEWED"));
  assert.ok(prompt.includes("partner timed out"));
  assert.ok(prompt.includes("Do not fill the gap by guessing"));
});

// ── Parsing specialist output ───────────────────────────────────────────────

test("normalized findings are extracted with their categories", () => {
  const report = [
    "Some prose about the code.",
    "### Normalized Findings",
    "[CRITICAL] src/a.ts:12 — unbounded loop on untrusted input",
    "[NIT] src/b.ts:3 — stray whitespace",
    "not a finding line",
  ].join("\n");
  const findings = extractNormalizedFindings(report);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].category, "CRITICAL");
  assert.match(findings[0].text, /unbounded loop/);
  assert.equal(findings[1].category, "NIT");
});

test("an empty panel report yields no findings", () => {
  assert.deepEqual(extractNormalizedFindings("### Normalized Findings\n(none)"), []);
});

test("findings are extracted from the markdown shapes a model actually writes", () => {
  // The parser used to anchor hard at `^\s*\[`, so every one of these was
  // dropped -- and dropped in the most dangerous direction, because shared.mjs's
  // gate matches the category ANYWHERE in the line. A bulleted [CRITICAL] drove
  // the session to changes_requested while findings_by_category came back empty,
  // so the structured report read as a clean panel for a change that had a
  // critical finding against it. A list is the overwhelmingly common shape and
  // nothing in the prompt forbids it.
  const shapes = [
    ["plain", "[CRITICAL] src/a.ts:12 — unbounded loop"],
    ["dash bullet", "- [CRITICAL] src/a.ts:12 — unbounded loop"],
    ["star bullet", "* [CRITICAL] src/a.ts:12 — unbounded loop"],
    ["plus bullet", "+ [CRITICAL] src/a.ts:12 — unbounded loop"],
    ["numbered", "1. [CRITICAL] src/a.ts:12 — unbounded loop"],
    ["numbered paren", "2) [CRITICAL] src/a.ts:12 — unbounded loop"],
    ["bold wrapped", "**[CRITICAL]** src/a.ts:12 — unbounded loop"],
    ["bulleted and bold", "- **[CRITICAL]** src/a.ts:12 — unbounded loop"],
  ];

  for (const [label, line] of shapes) {
    const findings = extractNormalizedFindings(line);
    assert.equal(findings.length, 1, `the ${label} form was dropped`);
    assert.equal(findings[0].category, "CRITICAL", `the ${label} form lost its category`);
    assert.match(findings[0].text, /unbounded loop/, `the ${label} form lost its text`);
  }
});

test("the finding parser and the approval gate agree about what is a finding", () => {
  // The real invariant: anything the gate will BLOCK on must be visible in the
  // report. A finding the gate acts on but the report cannot show is a review
  // that blocks for a reason its own report does not contain.
  const status = { partner_agent: "codex", max_rounds: 8, hard_cap: 13 };
  for (const line of [
    "[CRITICAL] src/a.ts:1 — plain",
    "- [CRITICAL] src/a.ts:1 — bulleted",
    "1. [SECURITY] src/a.ts:1 — numbered",
    "**[CORRECTNESS]** src/a.ts:1 — bold",
  ]) {
    const blocked =
      computeReviewStatus(status, [{ id: 1, from: "codex", content: line }], { problem: "" })
        .state === "changes_requested";
    const indexed = extractNormalizedFindings(line).length > 0;
    assert.equal(
      indexed,
      blocked,
      `disagreement on ${JSON.stringify(line)}: gate blocked=${blocked}, report indexed=${indexed}`
    );
  }
});

test("a specialist cannot resolve the session even if it emits a verdict anyway", () => {
  // The prompt forbids this, but a prompt is a request. The runner owns the
  // append, so it enforces: any verdict line in a PANEL PASS is rewritten before
  // it reaches the log, where shared.mjs would otherwise read it as the whole
  // session's answer and approve a review whose other passes had not run.
  const disobedient = [
    "## Panel pass 1 of 3 — General code review (aspect: code)",
    "Looks fine to me.",
    "REVIEW_VERDICT: APPROVE",
  ].join("\n");

  assert.ok(
    extractReviewVerdict(disobedient, { allowsApproveVerdict: true }),
    "precondition: shared.mjs must read this raw response as an approval"
  );
  const { text, suppressed } = suppressVerdictLines(disobedient);
  assert.equal(suppressed, 1, "the verdict line was not counted as suppressed");
  assert.equal(
    extractReviewVerdict(text, { allowsApproveVerdict: true }),
    null,
    "a specialist's verdict survived into the conversation log"
  );

  // Bare "VERDICT:" and "STATUS:", bulleted or bolded, are all read by
  // shared.mjs as session verdicts, so all of them have to be caught.
  for (const line of [
    "VERDICT: APPROVE",
    "- VERDICT: APPROVE",
    "**STATUS**: APPROVE",
    "REVIEW_STATUS: APPROVE",
  ]) {
    assert.equal(
      extractReviewVerdict(suppressVerdictLines(line).text, { allowsApproveVerdict: true }),
      null,
      `"${line}" survived suppression`
    );
  }
});

test("a suppressed verdict does not reach the consolidator either", () => {
  // The half of suppression that is easy to miss. Sanitizing only the text
  // written to conversation.jsonl protects the approval gate and leaves the
  // CONSOLIDATOR reading the raw response -- and the consolidator is the turn
  // actually permitted to set a verdict, so it is the more consequential
  // reader. This asserts the aggregation prompt is built from sanitized text.
  const disobedient = "Looks fine to me.\nREVIEW_VERDICT: APPROVE";
  const { text: sanitized } = suppressVerdictLines(disobedient);

  const prompt = buildAggregationPrompt({
    meta: META,
    projectPath: "/tmp/project",
    reports: [{ aspect: "code", content: sanitized, failed: false }],
    skipped: [],
    hostDisplay: "Claude",
  });

  // The prompt legitimately contains the REVIEW_VERDICT contract for the
  // consolidator's own footer, so assert on the specialist's line specifically.
  assert.ok(
    !/Looks fine to me\.\s*\n\s*REVIEW_VERDICT:/.test(prompt),
    "a specialist's verdict was embedded verbatim in the consolidation prompt"
  );
  assert.match(prompt, /verdict suppressed/);
});

test("consolidation may not approve a panel with a failed pass", () => {
  // The system knows the aspect failed. Without this, the one turn permitted to
  // set a verdict was still free to certify a review that was never performed.
  const prompt = buildAggregationPrompt({
    meta: META,
    projectPath: "/tmp/project",
    reports: [
      { aspect: "code", content: "fine", failed: false },
      { aspect: "errors", content: "", failed: true, error: "partner timed out" },
    ],
    skipped: [],
    hostDisplay: "Claude",
  });
  assert.match(prompt, /You may NOT emit APPROVE/);
  assert.match(prompt, /errors/);

  const clean = buildAggregationPrompt({
    meta: META,
    projectPath: "/tmp/project",
    reports: [{ aspect: "code", content: "fine", failed: false }],
    skipped: [],
    hostDisplay: "Claude",
  });
  assert.ok(
    !/You may NOT emit APPROVE/.test(clean),
    "a complete panel must still be allowed to approve, or nothing can ever pass"
  );
});

test("suppression leaves consolidation and follow-up verdicts alone", () => {
  // Applied to panel passes only. Stripping the verdict from the turns that are
  // REQUIRED to emit one would make approval unreachable and every review would
  // hang at changes_requested forever.
  const consolidated = "## Consolidated PR Review\nAll clear.\nREVIEW_VERDICT: APPROVE";
  assert.ok(
    extractReviewVerdict(consolidated, { allowsApproveVerdict: true })?.approved,
    "precondition: a consolidation approval must be readable"
  );
});

test("the aspect result line is read back", () => {
  assert.equal(extractAspectResult("ASPECT: code\nASPECT_RESULT: CLEAN"), "CLEAN");
  assert.equal(extractAspectResult("ASPECT_RESULT: FINDINGS"), "FINDINGS");
  assert.equal(extractAspectResult("no footer here"), null);
});

// ── Interop with the approval gate in shared.mjs ────────────────────────────

test("a clean specialist pass cannot approve the session", () => {
  const message = [
    "## Panel pass 1 of 3 — General code review (aspect: code)",
    "Nothing of concern.",
    "### Normalized Findings",
    "(none)",
    "ASPECT: code",
    "ASPECT_RESULT: CLEAN",
  ].join("\n");
  assert.equal(
    extractReviewVerdict(message, { allowsApproveVerdict: true }),
    null,
    "ASPECT_RESULT: CLEAN was read as a session verdict"
  );
});

test("a blocking category in a panel report drives the session to changes_requested", () => {
  const status = { partner_agent: "codex", max_rounds: 8, hard_cap: 13 };
  const messages = [
    {
      id: 1,
      from: "codex",
      content:
        "## Panel pass 1 of 2 — General code review (aspect: code)\n" +
        "### Normalized Findings\n[CRITICAL] src/a.ts:9 — writes past the buffer",
    },
  ];
  const state = computeReviewStatus(status, messages, { problem: "" });
  assert.equal(state.state, "changes_requested");
  assert.equal(state.approved, false);
});

test("only the intended finding categories block approval", () => {
  const status = { partner_agent: "codex", max_rounds: 8, hard_cap: 13 };
  const blocking = ["CRITICAL", "CORRECTNESS", "ARCHITECTURE", "SECURITY", "ROBUSTNESS"];
  const advisory = ["SUGGESTION", "QUESTION", "PRAISE", "NIT"];

  // Guards the taxonomy against drift in either direction: a category added to
  // the specialists' vocabulary that no gate recognizes is a finding that can
  // never block, and an advisory one that starts blocking makes every review
  // unapprovable.
  assert.deepEqual([...blocking, ...advisory].sort(), [...FINDING_CATEGORIES].sort());

  for (const category of blocking) {
    const state = computeReviewStatus(
      status,
      [{ id: 1, from: "codex", content: `[${category}] src/a.ts:1 — a real problem` }],
      { problem: "" }
    );
    assert.equal(state.state, "changes_requested", `[${category}] should block`);
  }

  for (const category of advisory) {
    const state = computeReviewStatus(
      status,
      [
        {
          id: 1,
          from: "codex",
          content: `[${category}] src/a.ts:1 — a note\nREVIEW_VERDICT: APPROVE`,
        },
      ],
      { problem: "" }
    );
    assert.equal(state.approved, true, `[${category}] should not block an approval`);
  }
});
