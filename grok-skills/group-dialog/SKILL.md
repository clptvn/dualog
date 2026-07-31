---
name: group-dialog
description: Run multi-partner group dialogs or reviews via codex-dialog (Grok facilitator + Claude/Codex partners). Use when the user wants three models to collaborate, dual review, or group fan-out. Tools start_group_dialog / start_group_code_review.
user-invocable: true
---

# Group dialog (Grok facilitator)

```
codex-dialog__start_group_dialog({
  participants: ["grok", "claude", "codex"],  // or subset
  facilitator: "grok",
  mode: "fan_out" | "addressable" | "round_robin" | "review",
  problem_description, project_path, max_rounds: 1..5
})
codex-dialog__send_message({ session_id, content, to: "all" | "claude" | ["claude","codex"] })
codex-dialog__wait_for_partner_response({ session_id, since_id, expect: "all_pending" })
codex-dialog__end_dialog({ session_id })
```

For code review: `start_group_code_review` (auto-seeds first wave).

Partners run sequentially. Always pass `facilitator: "grok"` when you are the host.
