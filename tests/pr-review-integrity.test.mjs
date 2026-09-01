import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  computeReviewStatus,
  extractGateBlockingFindings,
} from "../src/shared.mjs";

const STATUS = {
  type: "pr_review",
  partner_agent: "codex",
  aspects: ["code"],
  max_rounds: 7,
  hard_cap: 12,
};

const aggregateMessage = (
  id = 2,
  body = "### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE"
) => ({
  id,
  from: "codex",
  content: `## Consolidated PR Review\n${body}`,
});

const specialistMessage = (
  aspect = "code",
  id = 1,
  findings = [],
  total = aspect === "code" ? 1 : 2
) => ({
  id,
  from: "codex",
  content:
    `## Panel pass ${id} of ${total} — ${aspect} review (aspect: ${aspect})\n` +
    "### Normalized Findings\n" +
    (findings.length
      ? findings
          .map(
            (finding) =>
              `[${finding.category}] [FINDING_ID: ${finding.id}] ${finding.text}`
          )
          .join("\n")
      : "(none)") +
    `\nASPECT_RESULT: ${findings.length ? "FINDINGS" : "CLEAN"}`,
});

const completeMessages = (aggregate = aggregateMessage()) => [specialistMessage(), aggregate];

const panelState = (aspectStatus, findings = []) => ({
  phase: "follow_up",
  finding_ledger_version: 1,
  findings,
  finding_occurrences: findings.map((finding) => ({
    finding_id: finding.id,
    message_id: finding.origin_message_id,
    phase: finding.origin_phase,
    category: finding.category,
    text: finding.text,
    source_kind: "normalized",
  })),
  finding_protocol_ambiguities: [],
  total_passes: 2,
  completed: [
    {
      aspect: "code",
      status: aspectStatus,
      message_id: 1,
      aspect_result:
        aspectStatus === "complete"
          ? findings.some(
              (finding) => finding.aspect === "code" && finding.origin_message_id === 1
            )
            ? "FINDINGS"
            : "CLEAN"
          : null,
    },
    { aspect: "__aggregate__", status: "complete", message_id: 2 },
  ],
  pending: [],
});

const ledgerFinding = (id = "F-code-1", overrides = {}) => ({
  id,
  category: "CORRECTNESS",
  text: "src/retry.mjs:12 — retries the unsafe operation twice",
  aspect: "code",
  origin_phase: "specialist",
  origin_message_id: 1,
  source_kind: "normalized",
  ...overrides,
});

test("a complete panel can approve from its consolidation", () => {
  const state = computeReviewStatus(STATUS, completeMessages(), {
    problem: "",
    panelState: panelState("complete"),
  });

  assert.equal(state.approved, true);
  assert.equal(state.panel_integrity.complete, true);
  assert.equal(state.panel_integrity.approval_allowed, true);
  assert.deepEqual(state.panel_integrity.blockers, []);
});

test("a consolidation cannot silently drop an earlier blocking finding and approve", () => {
  const finding = ledgerFinding();
  const messages = [
    {
      id: 1,
      from: "codex",
      content:
        "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
        "### Normalized Findings\n" +
        "[CORRECTNESS] [FINDING_ID: F-code-1] src/retry.mjs:12 — retries the unsafe operation twice\n" +
        "ASPECT_RESULT: FINDINGS",
    },
    aggregateMessage(2, "### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE"),
  ];
  const state = computeReviewStatus(STATUS, messages, {
    problem: "",
    panelState: panelState("complete", [finding]),
  });

  assert.equal(state.approved, false);
  assert.equal(state.source, "panel_integrity");
  assert.ok(state.panel_integrity.blockers.includes("undispositioned_findings"));
  assert.deepEqual(
    state.panel_integrity.finding_contract.undispositioned_finding_ids,
    ["F-code-1"]
  );
});

test("carrying a durable blocking finding forward keeps the review blocked", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "### Normalized Findings\n" +
          "[CORRECTNESS] [FINDING_ID: F-code-1] src/retry.mjs:12 — still retries twice\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.equal(state.state, "changes_requested");
  assert.equal(state.source, "blocking_findings");
});

test("a carried finding cannot be hidden behind resolved prose plus a disposition", () => {
  const finding = ledgerFinding("F-aggregate-1", {
    aspect: "__aggregate__",
    origin_phase: "consolidation",
    origin_message_id: 2,
  });
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "### Normalized Findings\n" +
          "[CORRECTNESS] [FINDING_ID: F-aggregate-1] src/retry.mjs:12 — resolved by the guard\n" +
          "FINDING_DISPOSITION: F-aggregate-1 | resolved | verified against the new guard\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.equal(state.state, "changes_requested");
  assert.equal(state.source, "blocking_findings");
});

test("a new follow-up finding cannot approve in the same message that carries it", () => {
  const finding = ledgerFinding("F-followup-1-1", {
    aspect: "__followup__",
    origin_phase: "follow_up",
    origin_message_id: 3,
  });
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(2, "REVIEW_VERDICT: CHANGES_REQUESTED"),
      {
        id: 3,
        from: "codex",
        content:
          "### Normalized Findings\n" +
          "[CORRECTNESS] [FINDING_ID: F-followup-1-1] src/new.mjs:4 — resolved wording cannot hide a carried issue\n" +
          "FINDING_DISPOSITION: F-followup-1-1 | resolved | claimed fixed in this response\n" +
          "REVIEW_VERDICT: APPROVE",
      },
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.equal(state.state, "changes_requested");
  assert.equal(state.source, "blocking_findings");
});

for (const disposition of ["resolved", "false-positive", "pre-existing"]) {
  test(`a finding may be explicitly ${disposition} with a rationale`, () => {
    const finding = ledgerFinding();
    const state = computeReviewStatus(
      STATUS,
      [
        specialistMessage("code", 1, [finding]),
        aggregateMessage(
          2,
          `### Normalized Findings\n(none)\n` +
            `FINDING_DISPOSITION: F-code-1 | ${disposition} | verified against the authoritative PR diff\n` +
            "REVIEW_VERDICT: APPROVE"
        ),
      ],
      { problem: "", panelState: panelState("complete", [finding]) }
    );

    assert.equal(state.approved, true);
    assert.equal(state.panel_integrity.approval_allowed, true);
    assert.equal(
      state.panel_integrity.finding_contract.dispositions[0].disposition,
      disposition
    );
  });
}

test("a duplicate disposition must target another known, dispositioned finding", () => {
  const findings = [
    ledgerFinding("F-code-1"),
    ledgerFinding("F-types-1", {
      aspect: "types",
      origin_message_id: 2,
      text: "src/retry.mjs:12 — the same unsafe retry is not represented in the type",
    }),
  ];
  const state = computeReviewStatus(
    { ...STATUS, aspects: ["code", "types"] },
    [
      specialistMessage("code", 1, [findings[0]], 2),
      specialistMessage("types", 2, [findings[1]]),
      aggregateMessage(
        3,
        "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-code-1 | resolved | verified by the new guard\n" +
          "FINDING_DISPOSITION: F-types-1 | duplicate | duplicate-of=F-code-1; same unsafe retry path\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    {
      problem: "",
      panelState: {
        ...panelState("complete", findings),
        total_passes: 3,
        completed: [
          {
            aspect: "code",
            status: "complete",
            message_id: 1,
            aspect_result: "FINDINGS",
          },
          {
            aspect: "types",
            status: "complete",
            message_id: 2,
            aspect_result: "FINDINGS",
          },
          { aspect: "__aggregate__", status: "complete", message_id: 3 },
        ],
      },
    }
  );

  assert.equal(state.approved, true);
  assert.equal(
    state.panel_integrity.finding_contract.dispositions[1].duplicate_of,
    "F-code-1"
  );
});

test("missing rationale and unknown duplicate targets fail closed", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "FINDING_DISPOSITION: F-code-1 | resolved |\n" +
          "FINDING_DISPOSITION: F-ghost-1 | duplicate | duplicate-of=F-code-1; same issue\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("undispositioned_findings"));
  assert.ok(state.panel_integrity.blockers.includes("invalid_finding_dispositions"));
});

test("duplicate cycles fail closed", () => {
  const findings = [ledgerFinding("F-code-1"), ledgerFinding("F-code-2")];
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, findings),
      aggregateMessage(
        2,
        "FINDING_DISPOSITION: F-code-1 | duplicate | duplicate-of=F-code-2; same root cause\n" +
          "FINDING_DISPOSITION: F-code-2 | duplicate | duplicate-of=F-code-1; same root cause\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", findings) }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("invalid_finding_dispositions"));
  assert.ok(
    state.panel_integrity.finding_contract.invalid_dispositions.some(
      (entry) => entry.reason === "duplicate_cycle"
    )
  );
});

test("pre-ledger panel state fails closed for approval", () => {
  const legacyPanel = panelState("complete");
  delete legacyPanel.finding_ledger_version;
  delete legacyPanel.findings;
  const state = computeReviewStatus(STATUS, [aggregateMessage()], {
    problem: "",
    panelState: legacyPanel,
  });

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("finding_ledger_unavailable"));
});

for (const [label, aspectStatus, blockerField] of [
  ["failed", "failed", "failed_aspects"],
  ["unverified", "complete_unverified", "unverified_aspects"],
]) {
  test(`a ${label} specialist cannot be approved by a disobedient consolidator`, () => {
    const state = computeReviewStatus(STATUS, [aggregateMessage()], {
      problem: "",
      panelState: panelState(aspectStatus),
    });

    assert.equal(state.approved, false);
    assert.equal(state.state, "needs_discussion");
    assert.equal(state.verdict, "NEEDS_DISCUSSION");
    assert.equal(state.source, "panel_integrity");
    assert.equal(state.close_allowed, false);
    assert.equal(state.panel_integrity.approval_allowed, false);
    assert.deepEqual(state.panel_integrity[blockerField], ["code"]);
    assert.equal(state.panel_integrity.rejected_verdict, "APPROVE");
  });
}

test("an approval emitted by a specialist stays blocked after consolidation", () => {
  const messages = [
    { id: 1, from: "codex", content: "REVIEW_VERDICT: APPROVE" },
    aggregateMessage(2, "No verdict was emitted by consolidation."),
  ];
  const state = computeReviewStatus(STATUS, messages, {
    problem: "",
    panelState: panelState("complete"),
  });

  assert.equal(state.approved, false);
  assert.equal(state.source, "panel_integrity");
  assert.ok(state.panel_integrity.blockers.includes("verdict_before_consolidation"));
  assert.equal(state.panel_integrity.consolidation_message_id, 2);
  assert.equal(state.panel_integrity.rejected_source_message_id, 1);
});

test("missing panel state fails closed for approval", () => {
  const state = computeReviewStatus(STATUS, [aggregateMessage()], { problem: "" });

  assert.equal(state.approved, false);
  assert.equal(state.source, "panel_integrity");
  assert.ok(state.panel_integrity.blockers.includes("panel_state_unavailable"));
});

test("the hard cap still permits cleanup when panel integrity blocks approval", () => {
  const state = computeReviewStatus(
    { ...STATUS, hard_cap: 1 },
    [aggregateMessage()],
    { problem: "", panelState: panelState("failed") }
  );

  assert.equal(state.approved, false);
  assert.equal(state.close_allowed, true);
  assert.equal(state.close_allowed_reason, "hard_cap");
  assert.equal(state.hard_cap_reached, true);
});

test("a panel with no partner turns remains safely abortable", () => {
  const state = computeReviewStatus(STATUS, [], { problem: "", panelState: null });

  assert.equal(state.approved, false);
  assert.equal(state.close_allowed, true);
  assert.equal(state.close_allowed_reason, "no_partner_turns");
});

test("a forged empty v1 ledger cannot erase a specialist's blocking finding", () => {
  const messages = [
    {
      id: 1,
      from: "codex",
      content:
        "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
        "### Normalized Findings\n" +
        "[CRITICAL] [FINDING_ID: F-code-1] src/x.mjs:1 — exploitable bug\n" +
        "ASPECT_RESULT: CLEAN",
    },
    aggregateMessage(),
  ];
  const state = computeReviewStatus(STATUS, messages, {
    problem: "",
    panelState: panelState("complete"),
  });

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("finding_ledger_invalid"));
  assert.ok(state.panel_integrity.blockers.includes("specialist_message_mismatch"));
  assert.ok(
    state.panel_integrity.finding_contract.invalid_ledger_entries.some(
      (entry) => entry.reason === "conversation_finding_missing_from_ledger"
    )
  );
});

test("a forged unindexed occurrence cannot cover different blocking text", () => {
  const finding = ledgerFinding("F-code-unindexed-1", {
    category: "CRITICAL",
    text: "[CRITICAL] docs/readme.md:1 — harmless wording",
    source_kind: "gate_readable_unindexed",
  });
  const forged = panelState("complete", [finding]);
  forged.finding_occurrences[0] = {
    finding_id: finding.id,
    message_id: 1,
    phase: "specialist",
    category: "CRITICAL",
    text: finding.text,
    source_kind: "gate_readable_unindexed",
  };
  const state = computeReviewStatus(
    STATUS,
    [
      {
        id: 1,
        from: "codex",
        content:
          "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
          "[CRITICAL] src/actual.mjs:1 — exploitable remote code execution\n" +
          "### Normalized Findings\n(none)\nASPECT_RESULT: FINDINGS",
      },
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-code-unindexed-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: forged }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("finding_ledger_invalid"));
  assert.ok(
    state.panel_integrity.finding_contract.invalid_ledger_entries.some(
      (entry) => entry.reason === "gate_readable_finding_occurrence_missing"
    )
  );
});

test("a phantom unindexed origin cannot rebind a later real normalized finding", () => {
  const finding = ledgerFinding("F-aggregate-1", {
    category: "CRITICAL",
    text: "[CRITICAL] docs/readme.md:1 — harmless wording",
    source_kind: "gate_readable_unindexed",
  });
  const stateRecord = panelState("complete", [finding]);
  stateRecord.finding_occurrences = [
    {
      finding_id: finding.id,
      message_id: 1,
      phase: "specialist",
      category: finding.category,
      text: finding.text,
      source_kind: "gate_readable_unindexed",
    },
    {
      finding_id: finding.id,
      message_id: 2,
      phase: "consolidation",
      category: finding.category,
      text: "src/actual.mjs:1 — exploitable remote code execution",
      source_kind: "normalized",
    },
  ];
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "### Normalized Findings\n" +
          "[CRITICAL] [FINDING_ID: F-aggregate-1] src/actual.mjs:1 — exploitable remote code execution\n" +
          "REVIEW_VERDICT: CHANGES_REQUESTED"
      ),
      {
        id: 3,
        from: "codex",
        content:
          "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-aggregate-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE",
      },
    ],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.invalid_ledger_entries.some(
      (entry) =>
        entry.reason === "occurrence_without_conversation_finding" &&
        entry.message_id === 1
    )
  );
});

test("a forged normalized ledger entry cannot replace the conversation finding text", () => {
  const finding = ledgerFinding("F-code-1", {
    category: "CRITICAL",
    text: "docs/readme.md:1 — harmless wording",
  });
  const state = computeReviewStatus(
    STATUS,
    [
      {
        id: 1,
        from: "codex",
        content:
          "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
          "### Normalized Findings\n" +
          "[CRITICAL] [FINDING_ID: F-code-1] src/actual.mjs:1 — exploitable RCE\n" +
          "ASPECT_RESULT: FINDINGS",
      },
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-code-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.invalid_ledger_entries.some(
      (entry) => entry.reason === "conversation_finding_origin_text_mismatch"
    )
  );
});

test("advisory-only FINDINGS is legitimate and needs no blocking disposition", () => {
  const advisory = {
    id: "F-code-1",
    category: "SUGGESTION",
    text: "src/a.mjs:2 — use the existing helper",
  };
  const stateRecord = panelState("complete");
  stateRecord.completed[0].aspect_result = "FINDINGS";
  const state = computeReviewStatus(
    STATUS,
    [specialistMessage("code", 1, [advisory]), aggregateMessage()],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, true);
  assert.deepEqual(
    state.panel_integrity.finding_contract.required_finding_ids,
    []
  );
});

test("advisory finding text may quote a blocking taxonomy token", () => {
  const advisory = {
    id: "F-code-1",
    category: "NIT",
    text: "src/a.mjs:2 — rename the [CRITICAL] heading for consistency",
  };
  const stateRecord = panelState("complete");
  stateRecord.completed[0].aspect_result = "FINDINGS";
  const state = computeReviewStatus(
    STATUS,
    [specialistMessage("code", 1, [advisory]), aggregateMessage()],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, true);
  assert.deepEqual(
    state.panel_integrity.finding_contract.required_finding_ids,
    []
  );
});

test("CLEAN cannot contradict an advisory normalized finding", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      {
        ...specialistMessage("code", 1, [
          {
            id: "F-code-1",
            category: "SUGGESTION",
            text: "src/a.mjs:2 — use the existing helper",
          },
        ]),
        content: specialistMessage("code", 1, [
          {
            id: "F-code-1",
            category: "SUGGESTION",
            text: "src/a.mjs:2 — use the existing helper",
          },
        ]).content.replace("ASPECT_RESULT: FINDINGS", "ASPECT_RESULT: CLEAN"),
      },
      aggregateMessage(),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("specialist_message_mismatch"));
});

test("a comment-only normalized heading cannot certify a clean specialist", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      {
        id: 1,
        from: "codex",
        content:
          "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
          "<!--\n### Normalized Findings\n(none)\n-->\n" +
          "ASPECT_RESULT: CLEAN",
      },
      aggregateMessage(),
    ],
    { problem: "", panelState: panelState("complete") }
  );
  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("specialist_message_mismatch"));
});

test("a disposition rationale may mention its finding ID and category", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-code-1 | resolved | verified the [CORRECTNESS] [FINDING_ID: F-code-1] retry path is gone\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, true);
  assert.deepEqual(state.panel_integrity.finding_contract.carried_finding_ids, []);
});

test("prose inside the normalized block cannot hide a known finding ID", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n" +
          "The [NIT] [FINDING_ID: F-code-1] issue is still broken\n" +
          "FINDING_DISPOSITION: F-code-1 | resolved | claimed fixed\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.blockers.includes("invalid_approval_source_contract")
  );
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) => error.reason === "finding_id_outside_normalized_record"
    )
  );
});

test("bare known finding IDs outside the normalized block cannot contradict disposition", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "F-code-1 is still broken in the retry path.\n" +
          "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-code-1 | resolved | claimed fixed\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) => error.reason === "known_finding_id_outside_protocol_record"
    )
  );
});

for (const malformedFinding of [
  "[CRITICAL ] src/x.mjs:1 — exploitable bug",
  "[ CRITICAL] src/x.mjs:1 — exploitable bug",
]) {
  test(`malformed normalized category fails closed: ${malformedFinding.split(" ")[0]}`, () => {
    const state = computeReviewStatus(
      STATUS,
      [
        specialistMessage(),
        aggregateMessage(
          2,
          `### Normalized Findings\n(none)\n${malformedFinding}\nREVIEW_VERDICT: APPROVE`
        ),
      ],
      { problem: "", panelState: panelState("complete") }
    );

    assert.equal(state.approved, false);
    assert.ok(
      state.panel_integrity.finding_contract.source_contract.errors.some(
        (error) => error.reason === "malformed_normalized_protocol_line"
      )
    );
  });
}

test("an astral character cannot hide a downgraded known finding ID", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n" +
          "[NIT] [FINDING_ID: F-code-1] docs/readme.md:1 — harmless wording 😀\n" +
          "FINDING_DISPOSITION: F-code-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("carried_findings"));
  assert.ok(state.panel_integrity.blockers.includes("finding_category_mismatch"));
});

test("markdown-noise splicing cannot hide a known finding ID", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n" +
          "[NIT] [FINDING_<!--x-->ID: F-code-1] docs/readme.md:1 — harmless wording\n" +
          "FINDING_DISPOSITION: F-code-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) =>
        error.reason === "known_finding_id_reconstructed_by_markdown_noise"
    )
  );
});

test("markdown-noise splicing cannot manufacture a shadow normalized heading", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "### Normalized <!--x-->Findings\n(none)\n" +
          "### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) =>
        error.reason === "normalized_protocol_shape_changed_by_markdown_noise"
    )
  );
});

test("an accepted fenced block rejects a reconstructed heading outside its fence", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "```markdown\n### Normalized Findings\n(none)\n```\n" +
          "### Normalized <!--x-->Findings\n(none)\nREVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) => error.reason === "normalized_protocol_outside_accepted_fence"
    )
  );
});

test("comment syntax is literal inside an accepted fenced protocol block", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "```markdown\n### Normalized Findings\n(none)\n" +
          "<!--x-->[NIT] [FINDING_ID: F-code-1] docs/readme.md:1 — harmless wording\n" +
          "```\nFINDING_DISPOSITION: F-code-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) => error.reason === "finding_id_outside_normalized_record"
    )
  );
});

test("a comment-looking blocker is visible inside an accepted fenced protocol block", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "```markdown\n### Normalized Findings\n(none)\n" +
          "<!-- [CRITICAL] src/x.mjs:1 — exploitable RCE -->\n```\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.source_contract.errors.some(
      (error) => error.reason === "malformed_normalized_protocol_line"
    )
  );
});

for (const [label, findingLine, expectedBlocker] of [
  [
    "category downgrade",
    "[NIT] [FINDING_ID: F-code-1] src/retry.mjs:12 — still retries twice",
    "finding_category_mismatch",
  ],
  [
    "unsupported category",
    "[BUG] [FINDING_ID: F-code-1] src/retry.mjs:12 — still retries twice",
    "invalid_approval_source_contract",
  ],
]) {
  test(`an approval rejects a ${label} in its normalized block`, () => {
    const finding = ledgerFinding();
    const stateRecord = panelState("complete", [finding]);
    stateRecord.finding_occurrences.push({
      finding_id: finding.id,
      message_id: 2,
      phase: "consolidation",
      category: findingLine.includes("[NIT]") ? "NIT" : "BUG",
      text: "src/retry.mjs:12 — still retries twice",
      source_kind: "normalized",
    });
    const state = computeReviewStatus(
      STATUS,
      [
        specialistMessage("code", 1, [finding]),
        aggregateMessage(
          2,
          `### Normalized Findings\n${findingLine}\n` +
            "FINDING_DISPOSITION: F-code-1 | resolved | claimed fixed\n" +
            "REVIEW_VERDICT: APPROVE"
        ),
      ],
      { problem: "", panelState: stateRecord }
    );

    assert.equal(state.approved, false);
    assert.ok(state.panel_integrity.blockers.includes(expectedBlocker));
  });
}

test("a carried finding in the accepted fenced normalized block still blocks", () => {
  const finding = ledgerFinding();
  const stateRecord = panelState("complete", [finding]);
  stateRecord.finding_occurrences.push({
    finding_id: finding.id,
    message_id: 2,
    phase: "consolidation",
    category: finding.category,
    text: finding.text,
    source_kind: "normalized",
  });
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "```markdown\n### Normalized Findings\n" +
          `[CORRECTNESS] [FINDING_ID: F-code-1] ${finding.text}\n` +
          "```\nFINDING_DISPOSITION: F-code-1 | resolved | claimed fixed\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("carried_findings"));
});

for (const [label, body, expectedBlocker] of [
  [
    "truncated source",
    "### Normalized Findings\n(none)\n[report truncated in the middle: 10 chars omitted]\nREVIEW_VERDICT: APPROVE",
    "truncated_approval_source",
  ],
  [
    "unclosed fence",
    "### Normalized Findings\n(none)\n```text\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
  [
    "unclosed comment",
    "### Normalized Findings\n(none)\n<!--\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
  [
    "comment-hidden normalized block",
    "<!--\n### Normalized Findings\n(none)\n-->\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
  [
    "comment-hidden empty payload",
    "### Normalized Findings\n<!--\n(none)\n-->\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
  [
    "bare LGTM",
    "### Normalized Findings\n(none)\nLGTM",
    "invalid_approval_source_contract",
  ],
  [
    "multiple verdicts",
    "### Normalized Findings\n(none)\nREVIEW_VERDICT: CHANGES_REQUESTED\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
  [
    "noise-spliced extra verdict",
    "VERD<!--x-->ICT: CHANGES_REQUESTED\n### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
  [
    "noise-spliced legacy approval",
    "LG<!--x-->TM\n### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE",
    "invalid_approval_source_contract",
  ],
]) {
  test(`a v1 panel rejects an approval with ${label}`, () => {
    const state = computeReviewStatus(
      STATUS,
      [specialistMessage(), aggregateMessage(2, body)],
      { problem: "", panelState: panelState("complete") }
    );
    assert.equal(state.approved, false);
    assert.ok(state.panel_integrity.blockers.includes(expectedBlocker));
  });
}

test("a partially fenced disposition is not authorization", () => {
  const finding = ledgerFinding();
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [finding]),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\n```text\n" +
          "FINDING_DISPOSITION: F-code-1 | resolved | fake ``` trailing\n" +
          "REVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete", [finding]) }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("invalid_finding_dispositions"));
});

test("a persisted protocol ambiguity blocks approval", () => {
  const stateRecord = panelState("complete");
  stateRecord.finding_protocol_ambiguities.push({
    phase: "specialist",
    aspect: "code",
    category: "CRITICAL",
    text: "src/a.mjs:1 — hidden by a second normalized block",
    message_id: 1,
  });
  const state = computeReviewStatus(
    STATUS,
    [specialistMessage(), aggregateMessage()],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("finding_protocol_ambiguity"));
});

test("an interrupted finding commit remains fail-closed", () => {
  const stateRecord = panelState("complete");
  stateRecord.pending_finding_commit = {
    phase: "follow_up",
    finding_ids: ["F-followup-1-1"],
  };
  const state = computeReviewStatus(
    STATUS,
    [specialistMessage(), aggregateMessage()],
    { problem: "", panelState: stateRecord }
  );
  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("finding_commit_pending"));
});

test("a bare APPROVE token cannot authorize a v1 panel", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(2, "### Normalized Findings\n(none)\nAPPROVE"),
    ],
    {
      problem: "Implementation plan review",
      panelState: panelState("complete"),
    }
  );
  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.blockers.includes("invalid_approval_source_contract")
  );
});

test("CLEAN requires an explicit empty normalized payload", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      {
        id: 1,
        from: "codex",
        content:
          "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
          "### Normalized Findings\nASPECT_RESULT: CLEAN",
      },
      aggregateMessage(),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("specialist_message_mismatch"));
});

test("a path segment named fixed cannot erase a real blocking finding", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "Critical (95): [CRITICAL] src/fixed/cache.mjs:12 — unauthenticated users can execute commands\n" +
          "### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE"
      ),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("finding_ledger_invalid"));
  assert.ok(
    state.panel_integrity.finding_contract.invalid_ledger_entries.some(
      (entry) => entry.reason === "gate_readable_finding_occurrence_missing"
    )
  );
});

for (const [label, line] of [
  [
    "semantic subject plus explicit contradiction",
    "Resolved path handling is still broken: [CRITICAL] attacker-controlled paths execute commands",
  ],
  [
    "capitalized contradiction",
    "RESOLVED PATH HANDLING IS STILL BROKEN: [SECURITY] untrusted input reaches the shell",
  ],
  [
    "punctuated contradiction",
    "Resolved path handling is still—failing: [ROBUSTNESS] concurrent requests lose data",
  ],
  [
    "negative resolution claim",
    "Addressed in the summary but not-resolved: [CORRECTNESS] retries still duplicate writes",
  ],
  [
    "continuing failure",
    "Fixed previously, but continues to fail: [CRITICAL] authorization is bypassed",
  ],
]) {
  test(`resolution wording cannot erase a real finding: ${label}`, () => {
    const specialist = {
      id: 1,
      from: "codex",
      content:
        "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
        "### Normalized Findings\n(none)\n" +
        `## Analysis\n${line}\n` +
        "ASPECT_RESULT: CLEAN",
    };
    const state = computeReviewStatus(
      STATUS,
      [specialist, aggregateMessage()],
      { problem: "", panelState: panelState("complete") }
    );

    assert.equal(extractGateBlockingFindings(specialist.content).length, 1);
    assert.equal(state.approved, false);
    assert.ok(state.panel_integrity.blockers.includes("finding_ledger_invalid"));
  });
}

for (const [label, line] of [
  ["colon", "Resolved: [CRITICAL] the obsolete cache issue from the prior diff."],
  ["em dash", "Resolved — [SECURITY] validation now rejects the unsafe input."],
  ["prior finding", "Previously raised: [CORRECTNESS] remains fixed in this diff."],
  [
    "category after prose prefix",
    "Resolution summary — [ROBUSTNESS] resolved by the new retry guard.",
  ],
]) {
  test(`an explicit resolution summary remains nonblocking panel prose: ${label}`, () => {
    const state = computeReviewStatus(
      STATUS,
      [
        specialistMessage(),
        aggregateMessage(
          2,
          `${line}\n### Normalized Findings\n(none)\nREVIEW_VERDICT: APPROVE`
        ),
      ],
      { problem: "", panelState: panelState("complete") }
    );

    assert.deepEqual(extractGateBlockingFindings(line), []);
    assert.equal(state.approved, true);
  });
}

test("a specialist message cannot be rebound after its consolidation", () => {
  const stateRecord = panelState("complete");
  stateRecord.completed = [
    {
      aspect: "code",
      status: "complete",
      message_id: 2,
      aspect_result: "CLEAN",
    },
    { aspect: "__aggregate__", status: "complete", message_id: 1 },
  ];
  const state = computeReviewStatus(
    STATUS,
    [
      aggregateMessage(
        1,
        "### Normalized Findings\n(none)\nREVIEW_VERDICT: NEEDS_DISCUSSION"
      ),
      {
        id: 2,
        from: "codex",
        content:
          "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
          "### Normalized Findings\n(none)\n" +
          "ASPECT_RESULT: CLEAN\nREVIEW_VERDICT: APPROVE",
      },
    ],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("specialist_message_mismatch"));
  assert.ok(
    state.panel_integrity.specialist_message_issues.some(
      (issue) => issue.reason === "specialist_message_order_invalid"
    )
  );
});

test("an unlinked duplicate panel header cannot become an approving follow-up", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\nREVIEW_VERDICT: NEEDS_DISCUSSION"
      ),
      {
        id: 3,
        from: "codex",
        content:
          "## Panel pass 1 of 1 — General code review (aspect: code)\n" +
          "### Normalized Findings\n(none)\n" +
          "ASPECT_RESULT: CLEAN\nREVIEW_VERDICT: APPROVE",
      },
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("specialist_message_mismatch"));
  assert.ok(
    state.panel_integrity.specialist_message_issues.some(
      (issue) => issue.reason === "unexpected_panel_header"
    )
  );
});

test("an unlinked duplicate consolidation header cannot become an approving follow-up", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      aggregateMessage(
        2,
        "### Normalized Findings\n(none)\nREVIEW_VERDICT: NEEDS_DISCUSSION"
      ),
      aggregateMessage(3),
    ],
    { problem: "", panelState: panelState("complete") }
  );

  assert.equal(state.approved, false);
  assert.ok(state.panel_integrity.blockers.includes("consolidation_incomplete"));
});

for (const [label, mutate, blocker] of [
  ["missing specialist message", () => {}, "specialist_message_mismatch"],
  [
    "duplicate completion",
    (state) => state.completed.push({ aspect: "code", status: "failed" }),
    "duplicate_completed_aspects",
  ],
  [
    "unexpected completion",
    (state) => state.completed.push({ aspect: "security", status: "failed" }),
    "unexpected_completed_aspects",
  ],
  ["wrong pass count", (state) => (state.total_passes = 3), "panel_pass_count_mismatch"],
  ["incomplete phase", (state) => (state.phase = "panel"), "panel_phase_incomplete"],
  ["nonempty pending", (state) => state.pending.push("code"), "panel_pending_inconsistent"],
]) {
  test(`corrupt panel state fails closed for ${label}`, () => {
    const stateRecord = panelState("complete");
    mutate(stateRecord);
    const messages =
      label === "missing specialist message"
        ? [aggregateMessage()]
        : [specialistMessage(), aggregateMessage()];
    const state = computeReviewStatus(STATUS, messages, {
      problem: "",
      panelState: stateRecord,
    });
    assert.equal(state.approved, false);
    assert.ok(state.panel_integrity.blockers.includes(blocker));
  });
}

test("duplicate partner message IDs fail closed", () => {
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage(),
      { id: 2, from: "codex", content: "Earlier same-id response" },
      aggregateMessage(),
    ],
    { problem: "", panelState: panelState("complete") }
  );
  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.blockers.includes("invalid_partner_message_sequence")
  );
});

test("a ledger origin cannot be rebound to a later harmless occurrence", () => {
  const actualText = "src/actual.mjs:1 — exploitable remote code execution";
  const harmlessText = "docs/readme.md:1 — harmless wording";
  const finding = ledgerFinding("F-code-1", {
    category: "CRITICAL",
    text: harmlessText,
    aspect: "__followup__",
    origin_phase: "follow_up",
    origin_message_id: 3,
  });
  const stateRecord = panelState("complete", [finding]);
  stateRecord.finding_occurrences = [
    {
      finding_id: finding.id,
      message_id: 1,
      phase: "specialist",
      category: "CRITICAL",
      text: actualText,
      source_kind: "normalized",
    },
    {
      finding_id: finding.id,
      message_id: 2,
      phase: "consolidation",
      category: "CRITICAL",
      text: actualText,
      source_kind: "normalized",
    },
    {
      finding_id: finding.id,
      message_id: 3,
      phase: "follow_up",
      category: "CRITICAL",
      text: harmlessText,
      source_kind: "normalized",
    },
  ];
  const state = computeReviewStatus(
    STATUS,
    [
      specialistMessage("code", 1, [
        { id: finding.id, category: "CRITICAL", text: actualText },
      ]),
      aggregateMessage(
        2,
        `### Normalized Findings\n[CRITICAL] [FINDING_ID: F-code-1] ${actualText}\n` +
          "REVIEW_VERDICT: CHANGES_REQUESTED"
      ),
      {
        id: 3,
        from: "codex",
        content:
          `### Normalized Findings\n[CRITICAL] [FINDING_ID: F-code-1] ${harmlessText}\n` +
          "REVIEW_VERDICT: NEEDS_DISCUSSION",
      },
      {
        id: 4,
        from: "codex",
        content:
          "### Normalized Findings\n(none)\n" +
          "FINDING_DISPOSITION: F-code-1 | false-positive | documentation only\n" +
          "REVIEW_VERDICT: APPROVE",
      },
    ],
    { problem: "", panelState: stateRecord }
  );

  assert.equal(state.approved, false);
  assert.ok(
    state.panel_integrity.finding_contract.invalid_ledger_entries.some(
      (entry) => entry.reason === "origin_not_earliest_occurrence"
    )
  );
});

test("PR-only disposition handling does not weaken ordinary review blocking", () => {
  const state = computeReviewStatus(
    { type: "review", partner_agent: "codex", max_rounds: 5, hard_cap: 10 },
    [
      {
        id: 1,
        from: "codex",
        content:
          "FINDING_DISPOSITION: F-x-1 | false-positive | [CORRECTNESS] still described here\n" +
          "REVIEW_VERDICT: APPROVE",
      },
    ],
    { problem: "" }
  );
  assert.equal(state.approved, false);
  assert.equal(state.state, "changes_requested");
});

test("the installed-style termination hook enforces panel integrity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dualog-panel-gate-"));
  const home = path.join(root, "home");
  const sessionId = "review-panel-integrity-hook";
  const sessionDir = path.join(home, ".dualog", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    fs.writeFileSync(
      path.join(sessionDir, "status.json"),
      JSON.stringify({
        ...STATUS,
        session_id: sessionId,
        runner_pid: process.pid,
        runner_state: "running",
      })
    );
    fs.writeFileSync(
      path.join(sessionDir, "conversation.jsonl"),
      JSON.stringify(aggregateMessage()) + "\n"
    );
    fs.writeFileSync(
      path.join(sessionDir, "panel_state.json"),
      JSON.stringify(panelState("failed"))
    );

    const hookPath = fileURLToPath(
      new URL("../src/hooks/require-lgtm-or-cap.mjs", import.meta.url)
    );
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_input: { session_id: sessionId } }),
      encoding: "utf-8",
      timeout: 20000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
    });

    assert.equal(
      result.status,
      2,
      `the close hook must block a false approval over a failed pass: ${result.stderr}`
    );
    assert.match(result.stderr, /BLOCKED: Cannot end this session yet/);
    assert.match(result.stderr, /needs_discussion/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
