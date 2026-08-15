/**
 * The specialist panel behind start_pr_review.
 *
 * Ported from Anthropic's `pr-review-toolkit` plugin, which reviews a change by
 * running several NARROW specialists over it rather than one general reviewer.
 * That distinction is the whole point of the plugin and the reason this file
 * exists separately from review-runner.mjs: a single prompt carrying all six
 * rubrics produces a generalist doing six things adequately, which is precisely
 * what the panel was designed to avoid. Each aspect here gets its own partner
 * turn, with only its own lens loaded.
 *
 * Two deliberate departures from the source agents:
 *
 *  1. The source rubrics name their home codebase's stack directly -- specific
 *     logging helpers, a specific errorIds module, ES modules and React, the
 *     `function` keyword over arrows. Those are claude-cli-internal's
 *     conventions, not universal truths, and shipping them here would have
 *     dualog scolding a Go repo for not using `logForDebugging`. They are
 *     generalized to "this project's own stated conventions", which is what the
 *     rules were actually standing in for.
 *
 *  2. Each aspect keeps its native scoring vocabulary in its prose (confidence
 *     0-100, criticality 1-10, four 1-10 type axes) because that vocabulary IS
 *     the specialist, but must ALSO emit normalized `[CATEGORY]` finding lines.
 *     Without the second half, nothing downstream -- the aggregation pass, the
 *     verdict/blocking-finding parsing in shared.mjs, the report tool -- can
 *     read a panel whose six members each score differently.
 */

/**
 * The header the runner stamps on each specialist's report, and the pattern that
 * reads it back.
 *
 * Both live here because they are one contract with two ends: the runner writes
 * the header, and get_pr_review_report attributes every finding by matching it.
 * They were separate literals in separate files, which meant tightening the
 * pattern or changing the dash would have emptied the report of all findings --
 * silently, with no error and nothing failing, since the tests carried a third
 * copy and were checking the runner against themselves.
 */
export function buildAspectHeader({ aspect, title, passIndex, passTotal }) {
  return `## Panel pass ${passIndex} of ${passTotal} — ${title} (aspect: ${aspect})`;
}

/** Capture groups: 1 = pass index, 2 = pass total, 3 = title, 4 = aspect id. */
export const ASPECT_HEADER_RE =
  /^## Panel pass (\d+) of (\d+) — (.+) \(aspect: ([a-z][a-z0-9-]*)\)/m;

export const CONSOLIDATED_HEADER = "## Consolidated PR Review";
export const CONSOLIDATED_HEADER_RE = /^## Consolidated PR Review/m;

/**
 * The normalized finding vocabulary this module's parser understands.
 *
 * Stated verbatim to every specialist so their reports are machine-readable at
 * all. Note this is NOT the same list as the approval gate's: shared.mjs's
 * BLOCKING_FINDING_RE matches a SUPERSET, carrying the plan/spec categories
 * (GAP, AMBIGUITY, SCOPE, FEASIBILITY, UX, TESTABILITY) that this module has no
 * entry for. So an off-list category fails in the more dangerous direction than
 * it first appears: `[GAP]` would trip hasBlockingFindings and drive the whole
 * session to changes_requested, while extractNormalizedFindings drops it and it
 * never surfaces in get_pr_review_report at all. The gate sees a finding the
 * report cannot show you.
 */
export const FINDING_CATEGORIES = [
  "CRITICAL",
  "CORRECTNESS",
  "ARCHITECTURE",
  "SECURITY",
  "ROBUSTNESS",
  "SUGGESTION",
  "QUESTION",
  "PRAISE",
  "NIT",
];

const NORMALIZED_FINDINGS_BLOCK = `## Normalized Findings (REQUIRED)

Your prose above is the specialist report and should use your own rubric. But it
is read by an aggregator and by automated gates that do not know your rubric, so
every finding you raise must ALSO appear as a normalized line in a final section
titled exactly "### Normalized Findings".

One finding per line, in this exact shape:

[CATEGORY] path/to/file.ext:LINE — one-sentence statement of the defect

Categories, and what each one means (do not inflate — an inflated category
spends a reviewer's attention on the wrong thing):

- [CRITICAL] — bug, security hole, data loss, or correctness failure. Must fix.
- [CORRECTNESS] — logic error, edge case, race, wrong error handling.
- [ARCHITECTURE] — design problem, coupling, broken abstraction.
- [SECURITY] — input validation, authz, secrets, unsafe pattern.
- [ROBUSTNESS] — error paths, resource cleanup, partial-failure handling.
- [SUGGESTION] — concrete improvement with a demonstrable benefit. If you cannot
  say why a senior engineer would adopt it, leave it out.
- [QUESTION] — you cannot conclude without an answer. Use sparingly.
- [PRAISE] — optional, one line, only when honest.
- [NIT] — cosmetic. Group at the end or omit entirely.

If you found nothing that clears your own bar, write exactly:

### Normalized Findings
(none)

Reporting nothing is a valid and useful result. Do not manufacture findings to
look thorough — a padded list costs the reviewer more than an empty one.`;

function aspectFooter(aspectId) {
  // Deliberately ASPECT_RESULT and not any spelling of "verdict".
  //
  // shared.mjs scans partner messages for a line beginning VERDICT / STATUS /
  // REVIEW_VERDICT and lets it decide the whole session's state. A single
  // specialist must never be able to do that: the first clean aspect would
  // approve a review whose remaining five passes had not run yet.
  //
  // The invariant is that no SPECIALIST pass may emit a verdict -- not that only
  // one turn ever does. Consolidation is the FIRST turn permitted to, and every
  // follow-up turn after it is required to (buildFollowUpPrompt makes the footer
  // mandatory), which is how an approval is reached at all.
  return `## Machine-Readable Footer (REQUIRED)

End your response with these lines, after the normalized findings:

ASPECT: ${aspectId}
ASPECT_RESULT: <CLEAN|FINDINGS>
REFERENCED_FILES: path/one.ext, path/two.ext

ASPECT_RESULT is CLEAN only when you raised no finding above [SUGGESTION]
severity. REFERENCED_FILES lists files you actually opened and read, relative to
the project root; omit the line if you read none. Do NOT write a line beginning
with "VERDICT", "STATUS", or "REVIEW_VERDICT" — those are reserved for the final
aggregation pass, and emitting one here would resolve the entire review on the
strength of your single lens.`;
}

/**
 * Every aspect the panel can run.
 *
 * `applies` decides auto-selection from the diff. It is a heuristic over the
 * patch text and is allowed to be wrong in the generous direction -- a pass that
 * finds nothing costs one turn, while a pass that never ran costs the finding it
 * would have made. `optIn` marks aspects that must be asked for by name.
 */
export const PR_REVIEW_ASPECTS = {
  code: {
    id: "code",
    title: "General code review",
    source: "code-reviewer",
    optIn: false,
    // The toolkit runs this on every change, without a trigger condition.
    applies: () => ({ applicable: true, reason: "always applicable" }),
    prompt: `You are an expert code reviewer specializing in modern software development across
multiple languages and frameworks. You review changes against this project's own
stated guidelines with high precision, minimizing false positives.

## Your Lens

**Project guideline compliance.** Find this project's conventions where they are
actually written down — CLAUDE.md, AGENTS.md, CONTRIBUTING.md, a README, or the
consistent practice of the surrounding code — and check the change against them.
Read those files rather than assuming a convention. Do not import habits from
other codebases: if this project does something differently from what you would
choose, that is not a finding.

**Bug detection.** Real defects that will affect behavior — logic errors,
null/undefined handling, race conditions, leaks, security holes, performance
cliffs.

**Code quality.** Significant issues only: duplication that will drift, missing
critical error handling, accessibility problems, inadequate coverage of risky
paths.

## Confidence Scoring

Score every candidate issue 0-100 before you report it:

- 0-25: likely false positive, or a pre-existing issue this change did not cause
- 26-50: minor nitpick, not called out by any project guideline
- 51-75: valid but low impact
- 76-90: important, needs attention
- 91-100: critical bug, or an explicit violation of a written project rule

**Report only issues scoring 80 or above.** State the score with each one.

Filter aggressively. Quality over quantity. These are NOT findings: pre-existing
issues, things a linter or compiler would catch, pedantic style points a senior
engineer would not raise, and problems on lines this change did not touch.

## Output

Open by stating what you reviewed. For each surviving issue give the confidence
score, the file and line, the specific rule or bug, and a concrete fix. Group as
Critical (90-100) and Important (80-89). If nothing clears the bar, say so in a
sentence — that is a complete and useful review.`,
  },

  tests: {
    id: "tests",
    title: "Test coverage",
    source: "pr-test-analyzer",
    optIn: false,
    applies: (facts) => {
      if (facts.touchesTests) {
        return { applicable: true, reason: "test files changed" };
      }
      if (facts.touchesLogic) {
        return {
          applicable: true,
          reason: "logic changed with no accompanying test change",
        };
      }
      return { applicable: false, reason: "no test or logic changes detected" };
    },
    prompt: `You are an expert test coverage analyst reviewing a change. Your job is to
ensure critical functionality is covered — NOT to chase 100% line coverage.

## Your Lens

Focus on **behavioral** coverage, not line coverage. Identify the paths, edge
cases, and error conditions that must be tested to prevent regressions.

Look for critical gaps:
- Untested error-handling paths that could fail silently
- Missing boundary conditions
- Uncovered branches of critical business logic
- Absent negative cases for validation logic
- Missing coverage of concurrent or async behavior, where it matters

Evaluate the quality of tests that DO exist. Do they test behavior and contracts
rather than implementation details? Would they catch a real regression? Do they
survive a reasonable refactor? Are they descriptive enough to explain the
failure when they fail?

## Criticality Rating

Rate each suggested test 1-10 and give the specific failure it would catch:

- 9-10: could cause data loss, a security issue, or system failure
- 7-8: important business logic, user-facing errors
- 5-6: edge cases causing confusion or minor issues
- 3-4: nice-to-have completeness
- 1-2: optional polish

## Judgment

Be thorough but pragmatic. Before you flag a gap, consider whether an existing
test elsewhere already covers it — check before you claim it does not. Skip
trivial getters and setters unless they carry logic. Weigh the cost of each test
against the bug it prevents. Note when an existing test is testing implementation
rather than behavior, since that test will break for the wrong reasons.

## Output

1. **Summary** — overall state of coverage for this change
2. **Critical Gaps** — rated 8-10, must be added
3. **Important Improvements** — rated 5-7, worth considering
4. **Test Quality Issues** — brittle or implementation-coupled tests
5. **Positive Observations** — what is genuinely well covered`,
  },

  errors: {
    id: "errors",
    title: "Error handling and silent failures",
    source: "silent-failure-hunter",
    optIn: false,
    applies: (facts) =>
      facts.touchesErrorHandling
        ? { applicable: true, reason: "error-handling constructs changed" }
        : { applicable: false, reason: "no error-handling changes detected" },
    prompt: `You are an elite error-handling auditor with zero tolerance for silent failures.
Your mission is to protect users from obscure, hard-to-debug problems by ensuring
every error is surfaced, logged, and actionable.

## Non-Negotiable Principles

1. **Silent failures are unacceptable.** An error that occurs with no logging and
   no user feedback is a defect in itself.
2. **Users deserve actionable feedback.** A message must say what went wrong and
   what to do about it.
3. **Fallbacks must be explicit and justified.** Quietly falling back to other
   behavior hides the problem instead of fixing it.
4. **Catch blocks must be specific.** Broad catches swallow unrelated errors and
   make debugging impossible.
5. **Mocks and stubs belong in tests.** Production code falling back to a fake
   implementation is an architecture problem.

## Your Process

**Find every error path in the change.** Try/catch, try/except, rescue, recover,
Result and Option handling, error callbacks, error branches, fallback defaults,
places that log and continue, and optional chaining or null coalescing that can
quietly skip a failing operation.

**Interrogate each one:**

- *Logging:* Is it logged at the right severity, with enough context — which
  operation, which ids, what state — to debug this in six months? Does it follow
  whatever logging convention this project actually uses? Read the surrounding
  code to learn that convention rather than assuming one.
- *User feedback:* Does the user learn what failed and what they can do? Is the
  message specific enough to distinguish it from its neighbors?
- *Catch specificity:* Does it catch only what it expects? **List the specific
  unrelated errors this block could swallow** — that list is the finding.
- *Fallback behavior:* Was this fallback actually asked for, or is it masking a
  failure? Would a user be confused about why they are seeing it?
- *Propagation:* Should this error bubble up instead of being handled here? Does
  catching here skip necessary cleanup?

**Hunt these patterns specifically:** empty catch blocks; catches that only log
and continue; returning null/undefined/a default on error without logging;
optional chaining used to skip a failing operation; fallback chains that try one
approach after another without explaining why; retry loops that exhaust their
attempts and say nothing.

## Output

Per issue: **Location** (file:line) — **Severity** (CRITICAL for a silent failure
or broad catch, HIGH for a poor message or unjustified fallback, MEDIUM for
missing context) — **What is wrong and why** — **Hidden errors** this could
swallow, named specifically — **User impact** — **Recommendation** with a short
corrected snippet.

Be skeptical and uncompromising, and be constructive: the goal is better code,
not a lecture. Say so when error handling is genuinely well done — it is rare and
worth reinforcing.`,
  },

  comments: {
    id: "comments",
    title: "Comment accuracy",
    source: "comment-analyzer",
    optIn: false,
    applies: (facts) =>
      facts.touchesComments
        ? { applicable: true, reason: "comments or docstrings changed" }
        : { applicable: false, reason: "no comment changes detected" },
    prompt: `You are a meticulous code comment analyst. You approach every comment with
healthy skepticism, because an inaccurate comment is worse than no comment: it
is confidently wrong, and it compounds. Read as a developer meeting this code in
a year with no context.

## Your Lens

**Factual accuracy — check every claim against the code.** Do the documented
parameters and return types match the signature? Does the described behavior
match the logic? Do the referenced types, functions, and variables exist and get
used as described? Are the edge cases it mentions actually handled? Are the
complexity or performance claims true?

**Completeness.** Are critical assumptions and preconditions written down? Are
non-obvious side effects mentioned? Important error conditions? Is the approach
of a complex algorithm explained? Is the rationale captured where it is not
self-evident?

**Long-term value.** A comment restating what the code plainly says should go. A
comment explaining WHY is worth more than one explaining WHAT. A comment tied to
a transitional state will rot. Write for the least experienced future maintainer.

**Misleading elements.** Ambiguous phrasing with more than one reading. Stale
references to refactored code. Assumptions that no longer hold. Examples that no
longer match. TODOs and FIXMEs that were already handled.

## Output

**Summary** — what you examined and the headline.

**Critical Issues** — factually wrong or actively misleading comments.
Location / Issue / Suggested fix.

**Improvement Opportunities** — Location / what is missing / how to improve.

**Recommended Removals** — Location / why it earns no place.

**Positive Findings** — comments worth holding up as the standard, if any.

You are advisory. Identify and suggest; do not rewrite the code yourself.`,
  },

  types: {
    id: "types",
    title: "Type design and invariants",
    source: "type-design-analyzer",
    optIn: false,
    applies: (facts) =>
      facts.touchesTypes
        ? { applicable: true, reason: "types, classes, or schemas added or modified" }
        : { applicable: false, reason: "no type definitions added or modified" },
    prompt: `You are a type design expert with deep experience in large-scale architecture.
You believe well-designed types are the foundation of bug-resistant software, and
you evaluate them critically for invariant strength and encapsulation.

Review each type this change ADDS or MODIFIES. Skip types it merely uses.

## Analysis Framework

**1. Identify invariants** — implicit and explicit. Data consistency rules, valid
state transitions, constraints between fields, business rules encoded in the
shape, preconditions and postconditions.

**2. Encapsulation (1-10)** — Are internals hidden? Can the invariants be
violated from outside? Are access modifiers right? Is the interface minimal and
complete?

**3. Invariant expression (1-10)** — How clearly does the structure communicate
its rules? Are they enforced at compile time where the language allows? Is the
type self-documenting? Are constraints obvious from the definition alone?

**4. Invariant usefulness (1-10)** — Do these invariants prevent real bugs? Do
they match the actual requirements? Do they make the code easier to reason
about? Are they neither too strict nor too loose?

**5. Invariant enforcement (1-10)** — Checked at construction? Is every mutation
point guarded? Is an invalid instance impossible to build? Are the runtime checks
appropriate and complete?

## Principles

Prefer compile-time guarantees to runtime checks. Value clarity over cleverness.
Make illegal states unrepresentable. Validate at construction boundaries.
Immutability simplifies invariant maintenance. Weigh the maintenance cost of
every suggestion — perfect is the enemy of good, and a simpler type with fewer
guarantees often beats a complex one that tries to do everything.

## Anti-patterns to flag

Anemic models with no behavior; exposed mutable internals; invariants enforced
only by a comment; types with too many responsibilities; missing construction-
boundary validation; enforcement that is inconsistent across mutation methods;
types that depend on external code to stay valid.

## Output

Per type: the invariants you identified; the four ratings each with a one-line
justification; Strengths; Concerns; and Recommended Improvements that are
concrete and will not overcomplicate the codebase.`,
  },

  simplify: {
    id: "simplify",
    title: "Simplification and clarity",
    source: "code-simplifier",
    // Opt-in, and this is a departure worth stating: the toolkit runs this pass
    // only AFTER a review has otherwise passed, because it proposes rewrites
    // rather than reporting defects. Auto-running it would fold refactor
    // proposals into a correctness review and bury the findings that matter.
    optIn: true,
    applies: () => ({
      applicable: false,
      reason: "opt-in — request it explicitly, ideally after the review passes",
    }),
    prompt: `You are a code simplification specialist. You improve clarity, consistency, and
maintainability while preserving behavior EXACTLY. You have learned over many
years to prefer readable, explicit code to compact, clever code.

This pass is advisory: propose changes, do not make them.

## Rules

**1. Preserve functionality absolutely.** Change how the code does it, never what
it does. Every output, behavior, and edge case must survive. If you are not
certain a proposal is behavior-preserving, say so explicitly and explain the
risk — a "simplification" that changes behavior is a bug you introduced.

**2. Apply THIS project's standards.** Read the conventions the project actually
states — CLAUDE.md, AGENTS.md, a style guide — or infer them from the consistent
practice of the surrounding code. Do not impose conventions from other
codebases; matching the neighbors is the goal.

**3. Enhance clarity.** Reduce needless nesting and complexity. Remove redundant
code and abstractions that pay for nothing. Name things so the reader does not
have to reconstruct intent. Consolidate logic that belongs together. Delete
comments that restate obvious code. Avoid nested ternaries — prefer an if/else
chain or a switch. Choose clarity over brevity.

**4. Do not over-simplify.** Reject your own suggestion when it would reduce
clarity, produce something clever and hard to follow, merge concerns that belong
apart, remove an abstraction that is genuinely organizing the code, trade
readability for fewer lines, or make the code harder to debug or extend.

**5. Stay in scope.** Only code this change touched.

## Output

Per proposal: the location, what is complex now, the specific simplification,
and why it is better. Include a short before/after where it clarifies. State
plainly that behavior is unchanged — and where you cannot guarantee that, say
which behavior is at risk.

Report every proposal as [SUGGESTION] or [NIT] in the normalized findings. A
simplification is not a defect: reserve the higher categories for the case where
the existing complexity is actively hiding a bug, and say which bug.`,
  },
};

export const ASPECT_IDS = Object.keys(PR_REVIEW_ASPECTS);

/** Aspects eligible for automatic selection. */
export const AUTO_ASPECT_IDS = ASPECT_IDS.filter(
  (id) => !PR_REVIEW_ASPECTS[id].optIn
);

const TEST_PATH_RE =
  /(^|\/)(tests?|__tests__|__test__|spec|specs)\/|(\.|_|-)(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|rs|ts|js|mjs|cjs)$/i;

const SOURCE_EXT_RE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|scala|ex|exs|dart|m|mm|sh|bash|zsh|sql)$/i;

// Only added or removed lines. A comment three lines above an edit is context in
// the patch and did not change; treating it as changed would run the comment
// aspect on nearly every diff and dilute it into uselessness.
const COMMENT_RE =
  /^[+-]\s*(\/\/|\/\*|\*\s|\*\/|#(?!!)|--\s|<!--|"""|'''|%\s|;;)/;

const ERROR_RE =
  /^[+-].*\b(try\b|catch\b|except\b|finally\b|rescue\b|recover\(|throw\b|throws\b|raise\b|panic\(|reject\(|\.catch\(|errors\.(Is|As|New)|fmt\.Errorf|err\s*!=\s*nil|Result<|Option<|unwrap\(|expect\(|anyhow|thiserror|on_?error|onError|logError|console\.error)/i;

const TYPE_RE =
  /^[+-]\s*(export\s+)?(declare\s+)?(public\s+|private\s+|internal\s+|abstract\s+|final\s+|sealed\s+|pub\s+)?(interface|type|class|struct|enum|trait|protocol|record|newtype|data class|@dataclass|TypedDict|NamedTuple|z\.object|pydantic|BaseModel)\b/;

/**
 * Split a unified diff into the facts aspect selection needs.
 *
 * Deliberately textual. A real parser would buy nothing here: every consumer is
 * a boolean "was anything of this kind touched", and a heuristic that is
 * occasionally generous costs one wasted pass, while being clever and wrong
 * costs a specialist that never ran.
 */
export function summarizeDiff(diff) {
  const text = String(diff || "");
  const lines = text.split("\n");

  const files = [];
  let touchesComments = false;
  let touchesErrorHandling = false;
  let touchesTypes = false;

  for (const line of lines) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      files.push(header[2]);
      continue;
    }
    // Skip file headers: "+++ b/foo.ts" starts with "+" and would otherwise be
    // scanned as an added line of code.
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;

    if (!touchesComments && COMMENT_RE.test(line)) touchesComments = true;
    if (!touchesErrorHandling && ERROR_RE.test(line)) touchesErrorHandling = true;
    if (!touchesTypes && TYPE_RE.test(line)) touchesTypes = true;
  }

  const testFiles = files.filter((f) => TEST_PATH_RE.test(f));
  const sourceFiles = files.filter(
    (f) => SOURCE_EXT_RE.test(f) && !TEST_PATH_RE.test(f)
  );

  return {
    files,
    testFiles,
    sourceFiles,
    touchesTests: testFiles.length > 0,
    touchesLogic: sourceFiles.length > 0,
    touchesComments,
    touchesErrorHandling,
    touchesTypes,
  };
}

/**
 * Decide which specialists to run.
 *
 * Returns the selection AND the reason for every aspect, including the ones that
 * were skipped. The skipped list is the more important half: a panel that
 * silently declined to check error handling reads exactly like a panel that
 * checked it and found nothing.
 */
export function selectAspects(diff, requested) {
  const facts = summarizeDiff(diff);

  if (Array.isArray(requested) && requested.length > 0) {
    const unknown = requested.filter((id) => !PR_REVIEW_ASPECTS[id]);
    if (unknown.length) {
      throw new Error(
        `Unknown review aspect(s): ${unknown.join(", ")}. Known aspects: ${ASPECT_IDS.join(", ")}`
      );
    }
    // An explicit request wins over the heuristic in both directions: it may add
    // an aspect the diff does not suggest, and it may drop one the diff does.
    //
    // The caller's ORDER is preserved, not normalized to ASPECT_IDS order. Order
    // is behavioral here -- passes run in sequence and each is handed the
    // findings the earlier ones filed -- so quietly reordering the panel changes
    // which specialist gets to see what, while the echoed list still looks like
    // what was asked for. De-duplicated, since a repeated id would otherwise buy
    // a second full pass.
    const selected = [...new Set(requested)];
    return {
      facts,
      selected,
      decisions: ASPECT_IDS.map((id) => ({
        aspect: id,
        selected: selected.includes(id),
        reason: selected.includes(id)
          ? "requested explicitly"
          : "not in the requested aspect list",
      })),
    };
  }

  const decisions = ASPECT_IDS.map((id) => {
    const aspect = PR_REVIEW_ASPECTS[id];
    const verdict = aspect.applies(facts);
    return { aspect: id, selected: verdict.applicable, reason: verdict.reason };
  });

  return {
    facts,
    selected: decisions.filter((d) => d.selected).map((d) => d.aspect),
    decisions,
  };
}

function diffSection(diff, maxChars) {
  const truncated = diff.length > maxChars;
  const body = truncated ? diff.slice(0, maxChars) : diff;
  return {
    truncated,
    text:
      "```diff\n" +
      body +
      "\n```\n" +
      (truncated
        ? `\n**Note:** this diff is ${diff.length} chars and only the first ${maxChars} are shown. Read the changed files in the project directory for the rest, and do not draw conclusions about the unshown portion from the shown one.\n`
        : ""),
  };
}

function contextBlock(meta, projectPath) {
  let block = `## What You Are Reviewing

${meta.scope_label}
`;
  if (meta.pr) {
    block += `
**Pull request #${meta.pr.number}: ${meta.pr.title}**
Author: ${meta.pr.author || "unknown"} — ${meta.pr.head || "?"} → ${meta.pr.base || "?"}
${meta.pr.url || ""}
${meta.pr.body ? `\nPR description:\n\n${meta.pr.body}\n` : ""}`;
  }
  block += `
## Changed Files
${meta.diff_stat || "(no stat available)"}

## Project Directory
${projectPath}

Read any file here for context beyond the diff. You are expected to — the diff
alone rarely contains enough to judge a change fairly.
`;

  // A PR's contents live on the remote. The working tree may be on another
  // branch entirely, so "read the current file to check" -- which every prompt
  // here tells a specialist to do -- can silently send it to bytes that have
  // nothing to do with the change under review. Saying so is the difference
  // between a specialist that reads the tree carefully and one that trusts it.
  if (meta.scope === "pr") {
    block += `
**This is a pull request, and the directory above is NOT guaranteed to contain
it.** The diff was fetched from the remote; the local tree may sit on a different
branch, or predate the PR entirely. Use the directory to understand surrounding
code, conventions, and callers — but treat the DIFF as the authoritative statement
of what changed. If a file on disk disagrees with the diff, the diff is the change
and the file is not; say so rather than reviewing the local copy.
`;
  }
  return block;
}

/**
 * The prompt for one specialist pass.
 *
 * Each pass is a fresh partner invocation with no memory of its siblings, which
 * is the property that keeps the lenses independent. `priorAspects` is passed
 * only so a specialist can avoid re-reporting what another already filed --
 * their headline findings, not their reasoning.
 */
export function buildAspectPrompt({
  aspect,
  meta,
  diff,
  projectPath,
  maxDiffChars,
  passIndex,
  passTotal,
  reviewFocus,
  priorFindings = [],
}) {
  const spec = PR_REVIEW_ASPECTS[aspect];
  if (!spec) throw new Error(`Unknown review aspect: ${aspect}`);
  const { text: diffText } = diffSection(diff, maxDiffChars);

  let prompt = `${spec.prompt}

---

You are pass ${passIndex} of ${passTotal} in a multi-specialist review panel. You are
the **${spec.title}** specialist. Other specialists are covering the other
aspects — stay in your lane and review deeply rather than broadly. A finding
outside your lens is someone else's pass; a finding inside it that you skipped
is nobody's.

${contextBlock(meta, projectPath)}`;

  if (reviewFocus) {
    prompt += `
## Reviewer's Stated Focus
${reviewFocus}

Apply this focus within your own lens where it is relevant. It narrows your
attention; it does not replace your rubric.
`;
  }

  if (priorFindings.length) {
    prompt += `
## Already Reported by Earlier Passes

Do not re-file these. Do add to one if your lens reveals something the earlier
pass could not see, and say what you are adding.

${priorFindings.map((f) => `- ${f}`).join("\n")}
`;
  }

  prompt += `
## The Diff
${diffText}

---

${NORMALIZED_FINDINGS_BLOCK}

${aspectFooter(aspect)}

Respond with ONLY your specialist report, the normalized findings, and the
footer. Do not wrap any of it in JSON.`;

  return prompt;
}

/**
 * The final pass: turn N specialist reports into one actionable review.
 *
 * The first pass permitted to emit REVIEW_VERDICT -- follow-up turns emit one
 * too -- and the only one that sees every other pass's output.
 */
export function buildAggregationPrompt({
  meta,
  projectPath,
  reports,
  skipped,
  reviewFocus,
  hostDisplay,
}) {
  // A panel with a failed pass has a KNOWN hole, and until this block existed
  // nothing stopped consolidation from emitting APPROVE over it -- which
  // computeReviewStatus turns into approved/close_allowed, the gate end_dialog
  // enforces. The prompt marked the pass UNREVIEWED and then left the verdict
  // contract free to ignore it, so the system knew the aspect had failed and
  // still let the review say otherwise.
  const failedAspects = reports.filter((r) => r.failed).map((r) => r.aspect);
  const sections = reports
    .map(
      (r) =>
        `### ${PR_REVIEW_ASPECTS[r.aspect]?.title || r.aspect} (aspect: ${r.aspect})\n\n${
          r.failed
            ? `[This pass FAILED and produced no report: ${r.error}. Treat this aspect as UNREVIEWED — say so in your summary. Do not fill the gap by guessing what it would have found.]`
            : r.content
        }`
    )
    .join("\n\n---\n\n");

  return `You are consolidating a multi-specialist code review panel into one report a
reviewer can act on. Several specialists have each reviewed the same change
through a single narrow lens. Their reports are below.

${contextBlock(meta, projectPath)}
${reviewFocus ? `\n## Reviewer's Stated Focus\n${reviewFocus}\n` : ""}
## Specialist Reports

${sections}

${
  skipped.length
    ? `## Aspects NOT Reviewed

${skipped.map((s) => `- **${s.aspect}** — ${s.reason}`).join("\n")}

State these in your summary. An aspect nobody looked at must not be mistaken for
an aspect that came back clean.
`
    : ""
}
## Your Task

Consolidate. You are not re-reviewing the code — you are turning several
overlapping reports into one ordered, de-duplicated, honest account.

1. **Merge duplicates.** Several lenses often see one defect. Report it once,
   keeping the sharpest explanation and citing every aspect that raised it.
2. **Re-rank by real severity.** Each specialist scored within its own rubric, so
   a 9/10 test gap and a CRITICAL silent failure are not comparable as written.
   Judge them against each other now.
3. **Drop what does not survive.** A finding that reads as a false positive, a
   pre-existing issue, a compiler's job, or a nitpick a senior engineer would not
   raise does not belong in the final list. Say how many you dropped.
4. **Do not invent.** Every finding must trace to a specialist report. If the
   panel found little, report little — that is the honest outcome, and padding it
   costs ${hostDisplay} the ability to trust the ones that are real.

## Output Format

# PR Review Summary

## Critical Issues (N found)
Must fix before merge. Per issue: what, where (file:line), why it matters, the
fix, and which aspect(s) raised it.

## Important Issues (N found)
Should fix. Same shape.

## Suggestions (N found)
Worth considering. Keep this section tight.

## Strengths
What this change does genuinely well. Omit if you have nothing honest to say.

## Coverage
Which aspects ran, which were skipped and why, and anything the panel could not
reach — a truncated diff, a file it could not read, a failed pass.

## Recommended Action
An ordered plan: what to fix first, what can wait, and what to re-check after.

---

${NORMALIZED_FINDINGS_BLOCK}

## Machine-Readable Footer (REQUIRED)

End with these lines:

REVIEW_VERDICT: <APPROVE|CHANGES_REQUESTED|NEEDS_DISCUSSION>
REFERENCED_FILES: path/one.ext, path/two.ext

APPROVE only when nothing material remains. CHANGES_REQUESTED when there are
issues to address. NEEDS_DISCUSSION when you need ${hostDisplay} or the user to
answer something before you can conclude.
${
  failedAspects.length
    ? `
**You may NOT emit APPROVE.** ${failedAspects.length} specialist pass(es) FAILED
(${failedAspects.join(", ")}), so this panel is incomplete and part of this change
went unreviewed. Use NEEDS_DISCUSSION, and name each unreviewed aspect in your
Coverage section. Approving here would certify a review that was never performed.
`
    : ""
}

Paths in REFERENCED_FILES are relative to ${projectPath}, and the line is parsed
so your partner can verify your claims against the real code.

Respond with ONLY the consolidated report and the footer.`;
}

/**
 * The follow-up prompt, once the panel has reported and the host is responding.
 *
 * From here the session behaves like an ordinary review conversation: the panel
 * does not re-run, because re-running six specialists to check one fix would
 * spend the entire round budget confirming a single line.
 */
export function buildFollowUpPrompt({
  meta,
  projectPath,
  diff,
  maxDiffChars,
  messages,
  hostDisplay,
  partnerDisplay,
  hostAgent,
  partnerAgent,
  roundsUsed,
  softCap,
  hardCap,
}) {
  const { text: diffText } = diffSection(diff, maxDiffChars);

  let prompt = `You are continuing a multi-specialist code review you already delivered. The
panel has reported and been consolidated; ${hostDisplay} is now responding.

${contextBlock(meta, projectPath)}

## ${meta.scope === "pr" ? "The Change, As Last Fetched From The Pull Request" : "Current State of the Change"}
${diffText}

## Conversation So Far
`;

  for (const msg of messages) {
    const speaker =
      msg.from === hostAgent
        ? hostDisplay
        : msg.from === "system"
          ? "System"
          : `${partnerDisplay} (you)`;
    prompt += `\n### ${speaker} [message #${msg.id}]:\n${msg.content}\n`;
  }

  prompt += `
## Round Budget

Follow-up round ${roundsUsed + 1}. Soft cap ${softCap}, hard cap ${hardCap}.

## Your Task — Follow-up

- Address ${hostDisplay}'s responses to the review.
- Where something was fixed, VERIFY it${
    meta.scope === "pr"
      ? " against the refreshed diff above, which is re-fetched from the pull request. Do NOT verify against the local working tree: it may be on a different branch and can show you a fix that is not in the PR, or hide one that is."
      : " by reading the current file."
  } Do not take the claim of a fix as the fact of one.
- Where ${hostDisplay} disagreed, either accept the reasoning and say so, or
  explain concretely why the concern stands.
- Raise genuinely new issues only if they meet the same bar the panel used.
- Deliver the complete follow-up in this message rather than spreading it across
  rounds.
- When nothing material remains, set REVIEW_VERDICT: APPROVE and summarize what
  was reviewed and resolved.

## Machine-Readable Footer (REQUIRED)

REVIEW_VERDICT: <APPROVE|CHANGES_REQUESTED|NEEDS_DISCUSSION>
REFERENCED_FILES: path/one.ext, path/two.ext

Respond with ONLY your message and the footer.`;

  return prompt;
}

/**
 * Pull the normalized finding lines back out of a specialist report.
 *
 * Used to tell later passes what has already been filed, and to build the
 * report tool's aspect-keyed index.
 */
export function extractNormalizedFindings(content) {
  const findings = [];
  // Bullets, numbering, and bold wrapping are all accepted around the category.
  //
  // The prompt asks for a bare `[CATEGORY] path — text` line, but a model
  // writing a list of findings as a markdown list is the overwhelmingly common
  // shape and nothing forbids it. A strict anchor dropped every one of them,
  // and the failure was invisible in the worst way: shared.mjs's gate matches
  // the category ANYWHERE in the line, so a bulleted [CRITICAL] still drove the
  // session to changes_requested while this parser returned nothing -- an empty
  // findings index for a panel that had raised a critical finding, plus an empty
  // priorFindings list, so later passes were told nothing had been filed and
  // duplicated each other.
  const categoryRe = new RegExp(
    `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?\\**\\[(${FINDING_CATEGORIES.join("|")})\\]\\**\\s*(.+)$`,
    "i"
  );
  for (const line of String(content || "").split("\n")) {
    const match = line.match(categoryRe);
    if (!match) continue;
    findings.push({
      category: match[1].toUpperCase(),
      text: match[2].trim(),
      line: line.trim(),
    });
  }
  return findings;
}

/**
 * Neutralize any session-level verdict a SPECIALIST pass tried to emit.
 *
 * The panel's load-bearing invariant is that no single lens resolves the whole
 * review, and aspectFooter() only ASKS for that. shared.mjs reads a verdict from
 * any partner message, so one disobedient pass-1 response carrying
 * "REVIEW_VERDICT: APPROVE" approved a review whose other five passes had not
 * run -- bounded only by whether a later pass happened to emit a blocking
 * category. The runner owns the append, so it can enforce what the prompt
 * requests.
 *
 * Lives here rather than in the runner so it sits beside the footer that
 * declares the rule, and so it is testable at all: the runner is a process entry
 * point and executes on import.
 *
 * For PANEL PASSES ONLY. Consolidation and follow-up turns are required to emit
 * a verdict; stripping theirs would make approval unreachable.
 *
 * Returns { text, suppressed } — the count is the caller's cue to log it, since
 * a specialist ignoring an explicit instruction is worth noticing.
 */
export function suppressVerdictLines(response) {
  let suppressed = 0;
  const text = String(response ?? "").replace(
    /^([ \t]*)(?:[-*+]\s+)?(?:\*\*|__)?\s*(?:REVIEW[_\s-]?(?:VERDICT|STATUS)|VERDICT|STATUS)\s*(?:\*\*|__)?\s*:/gim,
    (_match, indent) => {
      suppressed++;
      return `${indent}ASPECT_NOTE (verdict suppressed — a specialist pass may not resolve the review):`;
    }
  );
  return { text, suppressed };
}

/** Read the ASPECT_RESULT line a specialist pass is required to emit. */
export function extractAspectResult(content) {
  const match = String(content || "").match(
    /^\s*ASPECT_RESULT:\s*(CLEAN|FINDINGS)\b/im
  );
  return match ? match[1].toUpperCase() : null;
}
