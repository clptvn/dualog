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
  buildFollowUpPrompt,
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

test("an explicit aspect list keeps the caller's order and drops duplicates", () => {
  // Order is behavioral, not cosmetic: passes run in sequence and each is handed
  // the findings the earlier ones filed, so reordering changes which specialist
  // sees what. Every other call in this suite passes a single aspect or a list
  // already in canonical order, so the previous normalize-to-ASPECT_IDS-order
  // behavior was unobservable and reverting it could not fail anything.
  const diff = diffFor("src/a.ts", ["const x = 1;"]);
  assert.deepEqual(
    selectAspects(diff, ["tests", "code"]).selected,
    ["tests", "code"],
    "the caller's order was normalized away"
  );
  assert.deepEqual(
    selectAspects(diff, ["code", "code"]).selected,
    ["code"],
    "a repeated aspect would buy a second full partner turn"
  );
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

test("the follow-up prompt carries the APPROVE ban forward, not just consolidation", () => {
  // The ban used to last exactly one turn. Consolidation correctly refused to
  // approve over a failed pass, then the very next follow-up was told "when
  // nothing material remains, set REVIEW_VERDICT: APPROVE" with no knowledge
  // that a lens had never run -- so the host says "fixed", the follow-up
  // verifies the fixes, and approves over an unreviewed aspect.
  const base = {
    meta: META,
    projectPath: "/tmp/project",
    diff: diffFor("src/a.ts", ["const x = 1;"]),
    maxDiffChars: 50000,
    messages: [],
    hostDisplay: "Claude",
    partnerDisplay: "Codex",
    hostAgent: "claude",
    partnerAgent: "codex",
    roundsUsed: 0,
    softCap: 5,
    hardCap: 10,
  };

  const withFailure = buildFollowUpPrompt({ ...base, failedAspects: ["errors"] });
  assert.match(withFailure, /You may NOT emit APPROVE/);
  assert.match(withFailure, /errors/);

  const clean = buildFollowUpPrompt({ ...base, failedAspects: [] });
  assert.match(
    clean,
    /set REVIEW_VERDICT: APPROVE/,
    "a complete panel must still be able to reach an approval"
  );
  assert.ok(!/You may NOT emit APPROVE/.test(clean));
});

test("PR-scoped prompts warn that the local tree may not hold the change", () => {
  // For a `pr` target the diff comes from the remote, so "read the current file
  // to check" can send a specialist to a different branch entirely.
  const prMeta = { ...META, scope: "pr" };
  const branchMeta = { ...META, scope: "branch", pr: null };
  const args = {
    diff: diffFor("src/a.ts", ["const x = 1;"]),
    projectPath: "/tmp/project",
    maxDiffChars: 50000,
    passIndex: 1,
    passTotal: 2,
  };

  const prPrompt = buildAspectPrompt({ aspect: "code", meta: prMeta, ...args });
  const branchPrompt = buildAspectPrompt({ aspect: "code", meta: branchMeta, ...args });

  assert.match(prPrompt, /NOT guaranteed to contain/);
  assert.ok(
    !/NOT guaranteed to contain/.test(branchPrompt),
    "the warning must not fire for a local target, where the tree IS the change"
  );
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

// NOTE: that the CONSOLIDATOR's input is sanitized too -- not just the
// conversation log -- is asserted in tests/pr-review-panel.test.mjs, by reading
// the aggregation prompt the runner actually wrote to turns/<id>/prompt.md.
// A version of that assertion lived here and pre-sanitized its own input before
// building the prompt, so it proved only that a sanitized string stays
// sanitized: reverting the runner's `reports.push({ content: safeResponse })`
// could not fail it, because the runner was never involved.

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

test("suppression neutralizes every shape the approval gate would act on", () => {
  // Asserted against the GATE, never against the suppressor's own pattern.
  // Checking suppression against itself is precisely what let `## VERDICT:
  // APPROVE` through -- a heading, which is the shape a model naturally writes
  // under a section the prompt itself calls "Machine-Readable Footer". Five
  // EIGHT of the twelve shapes below leaked under the old suppressor -- five
  // verdict forms it under-matched, plus all three LGTM forms, which it had no
  // handling for at all. The runner logged `suppressed: 0` for every one,
  // indistinguishable from a pass that emitted no verdict.
  const shapes = [
    "VERDICT: APPROVE",
    "**VERDICT**: APPROVE",
    "*VERDICT*: APPROVE",
    "- VERDICT: APPROVE",
    "-VERDICT: APPROVE",
    "## VERDICT: APPROVE",
    "# REVIEW_VERDICT: APPROVE",
    "  ## STATUS: APPROVE",
    "REVIEW_STATUS: APPROVE",
    "LGTM",
    "- LGTM",
    "**LGTM**",
  ];

  for (const shape of shapes) {
    assert.ok(
      extractReviewVerdict(shape, { allowsApproveVerdict: true }),
      `precondition: the gate must read ${JSON.stringify(shape)} as an approval`
    );
    const { text, suppressed } = suppressVerdictLines(shape);
    assert.ok(suppressed > 0, `${JSON.stringify(shape)} was not counted as suppressed`);
    assert.equal(
      extractReviewVerdict(text, { allowsApproveVerdict: true }),
      null,
      `${JSON.stringify(shape)} still approves the session after suppression`
    );
  }
});

test("suppression and the gate agree about fenced regions, including malformed ones", () => {
  // The divergence that reopened this invariant a third time. The suppressor
  // tracked fences with a local boolean, so an UNCLOSED fence latched it and it
  // skipped the rest of the document -- while the gate pairs its fences, so an
  // unclosed one matches nothing and it reads straight past. The gate read text
  // the suppressor had decided not to look at.
  //
  // `` ```diff `` left open is among the commonest malformations a model
  // produces, and likelier still when a report quotes code containing fences.
  const cases = [
    ["unclosed fence, then a footer", ["Here is the patch:", "```diff", "-old", "+new", "", "REVIEW_VERDICT: APPROVE"]],
    ["three fences", ["```", "a", "```", "```", "REVIEW_VERDICT: APPROVE"]],
    ["opened with ```, closed with ~~~", ["```", "a", "~~~", "REVIEW_VERDICT: APPROVE"]],
    ["bare LGTM after an unclosed fence", ["```js", "x()", "", "LGTM"]],
  ];

  for (const [label, lines] of cases) {
    const source = lines.join("\n");
    assert.ok(
      extractReviewVerdict(source, { allowsApproveVerdict: true }),
      `precondition: the gate must read ${label} as an approval`
    );
    const { text } = suppressVerdictLines(source);
    assert.equal(
      extractReviewVerdict(text, { allowsApproveVerdict: true }),
      null,
      `${label}: a verdict survived suppression and can resolve the session`
    );
  }

  // The converse: a verdict genuinely inside a BALANCED fence is not a verdict,
  // so neither half should act on it.
  const fenced = ["```", "REVIEW_VERDICT: APPROVE", "```"].join("\n");
  assert.equal(extractReviewVerdict(fenced, { allowsApproveVerdict: true }), null);
  assert.equal(suppressVerdictLines(fenced).suppressed, 0);
});

test("the approval gate still reads a finding line that merely mentions a fence", () => {
  // A regression I shipped and had to take back. Rebuilding stripMarkdownNoise
  // on top of the line mask made it drop any line OVERLAPPING a noise span,
  // where it had excised only the span and kept scanning the rest of the line.
  // A finding whose text contains an inline ``` pairs with a later fence, so the
  // span covered the line's tail and the entire finding vanished -- flipping the
  // review from changes_requested to approved, for every session type, not just
  // PR panels. Nothing in the suite covered shared.mjs's gate directly, so it
  // passed 621 tests.
  const report = [
    "### Normalized Findings",
    "[CRITICAL] src/a.mjs:1064 — an unclosed ``` latches the fence flag",
    "",
    "Example of the malformed output:",
    "```",
    "some example",
    "```",
    "",
    "REVIEW_VERDICT: APPROVE",
  ].join("\n");

  const state = computeReviewStatus(
    { partner_agent: "codex", max_rounds: 8, hard_cap: 13 },
    [{ id: 1, from: "codex", content: report }],
    { problem: "" }
  );
  assert.equal(
    state.state,
    "changes_requested",
    "a blocking finding was dropped because its own text mentioned a fence"
  );

  // The same mechanism, smaller blast radius: a trailing HTML comment must not
  // swallow the approval it sits beside, or a clean review never becomes
  // closable.
  assert.ok(
    extractReviewVerdict("REVIEW_VERDICT: APPROVE <!-- rationale -->", {
      allowsApproveVerdict: true,
    }),
    "an inline HTML comment swallowed a legitimate approval"
  );
});

test("quoted example findings are not indexed as real ones", () => {
  // These over-report, which is safe for the gate -- but they also feed
  // priorFindings, which later passes are handed under "Do not re-file these".
  // A quoted example could tell pass 4 that a real defect was already filed when
  // nobody filed it, which is an under-reporting path one step removed.
  const report = [
    "The format looks like this:",
    "```",
    "[CRITICAL] path/to/file.ts:1 — an example, not a finding",
    "```",
    "    [SECURITY] also just an indented illustration",
    "",
    "### Normalized Findings",
    "- [ROBUSTNESS] src/a.ts:2 — a real one",
  ].join("\n");

  const findings = extractNormalizedFindings(report);
  assert.deepEqual(
    findings.map((f) => f.category),
    ["ROBUSTNESS"],
    "an illustrative example was indexed as a real finding"
  );
});

test("suppression does not touch text the approval gate ignores", () => {
  // The other direction, and it corrupts the deliverable rather than the gate.
  // The gate discards fenced, quoted and indented lines, so rewriting them
  // protects nothing — while mangling the specialist's own evidence, which is
  // both what a human reads and what the consolidator is handed. `**Status:**`
  // as a sub-heading is a shape models write constantly, and it was being turned
  // into a scolding note with the bold eaten.
  const report = [
    "Here is the evidence:",
    "```js",
    "  STATUS: ok",
    "```",
    "    VERDICT: APPROVE",
    "> STATUS: quoted",
    "**Status:** the error path is fine",
    "### Normalized Findings",
    "- [CRITICAL] src/a.ts:1 — boom",
  ].join("\n");

  assert.equal(
    extractReviewVerdict(report, { allowsApproveVerdict: true }),
    null,
    "precondition: the gate reads no verdict in this report"
  );

  const { text, suppressed } = suppressVerdictLines(report);
  assert.equal(suppressed, 0, "suppression fired on lines the gate never reads");
  assert.equal(text, report, "the specialist's report was rewritten");
  assert.equal(
    extractNormalizedFindings(text).length,
    1,
    "suppression must not disturb the normalized findings"
  );
});

// NOTE: the invariant that suppression applies to panel passes ONLY -- and so
// that consolidation and follow-up can still reach an approval -- is asserted in
// tests/pr-review-panel.test.mjs against the real runner. It cannot be tested
// here: it is a fact about WHERE the runner calls this function, not about what
// the function does. A version of that assertion used to live in this file and
// never called suppressVerdictLines at all, so it would have stayed green if the
// runner had started suppressing consolidation too -- the precise disaster its
// own comment described.

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
