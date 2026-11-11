# Engineer

A standalone, canvas-free engineering workflow invoked directly as a skill:

```text
/engineer Add keyboard navigation to the search results and verify it.
```

Install `engineer@sbatten` from the `sbatten/copilot-plugins` marketplace.
It has no companion plugin, extension, canvas, server or npm dependencies.
The host must support skills and independent subagents; Node.js is needed to
render reports.

## Workflow

The current chat owns the task, with independent reviewer subagents:

| Phase | Work | Parallel review focuses |
| --- | --- | --- |
| Plan | Investigate; define scope, steps, risks, criteria and verification | Architecture, security, tests |
| Execute | Implement the approved plan; run relevant checks | Architecture, security, code, tests |
| Verify | Exercise each criterion; capture real evidence | Tests (plus specialists when useful) |

Each focus has a thin specialist agent: `engineer-reviewer-architecture`,
`engineer-reviewer-security`, `engineer-reviewer-code` and
`engineer-reviewer-tests`. All four load the shared
[engineer-review skill](skills/engineer-review/SKILL.md) for inspection rules,
finding IDs, revision handling and verdicts. Role-specific expertise stays in
the agents; the shared protocol has one source of truth.

The engineer launches the assigned specialists concurrently for each gate using
the host's native subagent facility. They do not create subsessions or change
project files. All assigned reviewers must
approve the current revision. Fixes and rebuttals go back to the reviewers;
findings and responses survive replacement of a one-shot agent. After three
rounds without agreement, the engineer returns a decision request rather than
silently overriding objections.

Verification failures return to implementation and review before new evidence
is captured. Material design changes also re-open planning. Explicit user
direction can change the route or team, but deviations and authorization stay
in the report. Commits, pushes, PRs and merges are not automatic.

This is instruction-driven orchestration, not a background workflow engine:
normal host permissions, cancellation, subagent availability and context limits
still apply. If independent review is unavailable, the engineer reports a
blocker rather than claiming self-review is independent.

## Report artifact

The engineer maintains a task-specific folder in persistent session storage,
outside the project, containing:

- `report.html`: a standalone, script-free report registered as an artifact;
- `report.json`: the durable structured record used to regenerate it;
- evidence: actual screenshots, recordings, rendered results and command output.

The HTML report opens directly from disk, in the reader's light or dark scheme.
It is written and set like a piece of explanatory journalism (the design
follows New York Times interactive articles and The Markup's "Show Your Work"
series): a serif headline and text, sans-serif labels, hairline rules and
colour only for state. Unlike a narrow newspaper column, text, tables and
phase records use up to 960px, while visual evidence and the numbers row use
up to 1280px. Both widths shrink to fit the viewport with 24px side gutters.
Its two open-licensed typefaces are embedded, so each
report is about 400 KB before evidence and still loads nothing from the
network. From the top:

- the status, the title, where the work stands and who reviewed it;
- what the engineer needs from you, when there is something;
- the numbers: criteria passing, evidence, checks, reviews and limitations;
- the summary;
- a scannable list of acceptance criteria: each collapsed row shows the full
  criterion and its Passed, Failed or Not verified result. Click or
  keyboard-activate a row to reveal its evidence: screenshots side by side and
  enlarged in place, recordings inline, text transcripts previewed. Shared
  evidence is shown once, with links from other criteria. Descriptions lead;
  internal criterion IDs are not shown as labels;
- key decisions;
- a table of every review gate, every blocking finding with the engineer's
  response, and each phase's full plan, implementation or verification report
  and review rounds, folded;
- checks with their real output, earlier failed attempts folded beneath;
- the original request and the activity and recovery history;
- limitations, process deviations and where the record lives.

Plans, reviews and other prose are rendered from a safe Markdown subset.
Historical failures and superseded or stale phase iterations remain visible
and are labelled as such.

Generate or refresh a report with:

```sh
node <installed-skill>/scripts/render-report.mjs <task-folder>/report.json
```

See the [skill](skills/engineer/SKILL.md) and
[report format](skills/engineer/references/report-format.md) for the full
workflow and data contract. The renderer rejects missing evidence, escaping
evidence paths and internally inconsistent completion claims; reviewers still
have to verify that the evidence actually proves the behavior.

## Development

From the repository root, with Node.js 22 or later:

```sh
node --test plugins/engineer/tests/*.test.mjs
```

Changes to the report's markup or stylesheet follow the repository's
[report design standards](../../.github/skills/engineer-report-design/SKILL.md);
the tests enforce the mechanical ones.
