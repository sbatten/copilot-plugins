---
name: engineer
description: 'Own an engineering task from plan through implementation and verification, with independent parallel subagent reviews after each phase and a detailed artifact report. Use when the user invokes /engineer or explicitly requests this reviewed engineering workflow.'
---

# Engineer

Own the user's task in this chat. The default route is:

**plan -> parallel review -> execute -> parallel review -> verify -> review**

Use ordinary subagents, not separate sessions or chats. No canvas, extension,
external coordinator, installed companion plugin or service is required. Do not
invoke session-creation or session-messaging tools to run this workflow.

## Start and keep a durable record

1. Read the request, repository instructions and worktree status. Preserve
   unrelated changes. Establish the exact goal, scope and measurable acceptance
   criteria; investigate existing code and prior art before designing changes.
2. Create a task-specific folder under the host's persistent session artifact
   directory, outside the project. Give separate invocations separate folders.
   If the host provides no such directory, use an explicitly identified durable
   local artifact location outside the checkout and report its absolute path.
3. Read [the report format](references/report-format.md). Maintain `report.json`
   there, beginning with the request, criteria and known constraints. Save full
   phase outputs and every review round, not just a final summary. Copy evidence
   and real command transcripts into this folder. Never store secrets.
4. Track the three phases and review gates with the host's todo facilities.
   Update the report and render `report.html` after each phase/review checkpoint
   and before returning a blocked, interrupted or final result:

   ```sh
   node <absolute-path-to-this-skill>/scripts/render-report.mjs <task-folder>/report.json
   ```

   Resolve the installed skill path; do not assume the user's project contains
   this plugin. Fix renderer errors rather than claiming a report was generated.
   Register the HTML file with the host's artifact tool when available, using
   its absolute file URI. Otherwise link its absolute path in chat. Keep the
   JSON and evidence beside it so the report works from disk without a server.
   Keep the renderer's wide, responsive layout for prose, tables and phase
   records; do not add narrow article-column wrappers or manual line breaks
   to constrain their width.

## 1. Plan, then review

Investigate without changing project source. Write a plan another engineer can
execute without guessing:

- goal, scope and non-goals;
- observed behavior and relevant code paths, with source references;
- ordered implementation steps and affected files, interfaces or data;
- alternatives and key decisions with reasons;
- risks, failure modes and mitigations;
- numbered, measurable acceptance criteria;
- verification for each criterion, including edge cases, regression checks and
  the screenshots, recordings or real command output that will prove it.

Save the full plan in the report. Review it with **architecture, security,
performance and tests** subagents in parallel. Do not implement until the gate
passes.

## 2. Execute, then review

Implement the approved plan yourself in this checkout. Keep changes focused,
follow repository patterns and update directly related documentation. Run the
smallest relevant builds, tests and lint checks; record exact commands, working
directory, exit status, outcomes and transcript evidence, including failures.

Report the actual changes, behavior, diff scope, checks and anything unfinished.
Review the implementation with **architecture, security, performance, code and tests**
subagents in parallel. Reviewers inspect the actual worktree, including relevant
untracked files and any pre-existing edits, not merely your summary. Do not move
to verification until the gate passes.

If implementation materially changes the design or acceptance criteria, revise
the plan and re-open its review before relying on its earlier approval.

## 3. Verify, then review

Exercise every acceptance criterion for real, including failure paths. This is
proof of the requested behavior, not just another test-suite invocation:

- UI changes: capture actual before/after screenshots or recordings using the
  host's browser or desktop tools, respecting permissions. Save recordings as
  MP4 (H.264, `yuv420p`), for broad playback support. If a capture tool
  produces non-MP4, transcode it to MP4 before adding it to the report; changing the
  extension is not conversion.
- CLI, library, data or documentation changes: retain real command output,
  rendered results or other directly inspectable evidence. Do not manufacture
  screenshots or successful output. Visual evidence is preferred where useful,
  not a substitute for checking the behavior.
- Map each criterion to named evidence files, a caption and a pass/fail result.
  Record environmental limits and anything not exercised as **not-verified**.
  Write each criterion as a distinct, readable outcome: the report shows its
  full text and result in a collapsed row, with evidence revealed on expansion.
  Keep IDs as internal mapping keys; do not repeat them in the criterion text.

Do not edit project source during verification. If it fails, return to execute,
fix the cause, repeat implementation review, and capture fresh evidence. Mark
superseded evidence and old reviews clearly; approval of old work is not
approval of a new revision.

Have a **tests** subagent independently open the evidence files and check every
criterion. Add parallel specialists if the task needs them. Verification is not
complete until its review passes.

## Review protocol

Use the bundled specialist agent matching each focus:

| Focus | Agent |
| --- | --- |
| Architecture | `engineer-reviewer-architecture` |
| Security | `engineer-reviewer-security` |
| Performance | `engineer-reviewer-performance` |
| Code | `engineer-reviewer-code` |
| Tests | `engineer-reviewer-tests` |

All five load the [engineer-review skill](../engineer-review/SKILL.md) for the
shared inspection, findings, revision and verdict protocol. Read it before
dispatch, and resolve its installed absolute path for reviewer assignments.
Discover the host's native subagent tool if needed. Launch all reviewers for a
gate concurrently
(parallel tool calls or background tasks); do not launch one and wait before
starting the others. Then collect every result before deciding the gate. Do not
create a worker pool for unrelated tasks, delegate the entire workflow, or let
reviewers spawn more agents. The engineer remains responsible for changes.

Supply a self-contained assignment to every reviewer:

- phase, focus, goal, current plan and acceptance criteria;
- absolute checkout and artifact directory paths;
- exact work under review, relevant diff paths and how to inspect new files;
- phase output and checks, evidence paths for verification;
- full prior findings, responses and decisions for that phase, with the current
  revision and review round identified;
- the installed shared review skill path and the selected specialist role;
- the full shared review protocol and specialist instructions if using a fallback.

Use host defaults for model selection unless the user explicitly overrides them.
If custom agent selection is unavailable, use a native general-purpose subagent
with the **entire shared review skill and selected specialist instructions** in
its prompt and record the fallback. If no independent subagent facility is available, mark the gate
blocked; do not replace independent review with self-approval.

Rules for each gate:

1. Save each full reviewer response and its verdict in the report.
2. All assigned reviewers must explicitly **APPROVE** the same current revision.
   Missing, failed, malformed or blocked reviews are not approval. Non-blocking
   suggestions do not prevent approval.
3. Address every finding by ID. Fix valid blockers; explain disagreements with
   evidence and send the rebuttal back for review. Never silently discard a
   finding or count your own rebuttal as reviewer agreement.
4. Re-review revisions with the same reviewers when the tool supports follow-up.
   For one-shot or unavailable agents, launch replacements with the complete
   history and record why. Preserve objections across replacement.
5. After three rounds without agreement on a phase, stop at **needs-decision**:
   summarize the disputed findings, positions, options and one precise human
   ask. Do not loop indefinitely or declare success.
6. If changes affect already-reviewed work, invalidate dependent approvals and
   re-run the affected gates. Keep their earlier iterations in the report.

## Deliver honestly

Render and register the final report artifact, then reply with its link first,
the outcome, key changes, checks and any remaining ask. The report must retain:
the original request, full plan, implementation and verification outputs,
evidence gallery, criterion-to-evidence mapping, decisions and alternatives,
all review rounds and finding resolutions, check results, activity/recovery
history, process deviations, limitations and any PR link.

Set status **complete** only when criteria pass with evidence and all current
gates approve. A failed check, missing evidence or inaccessible reviewer must be
visible; use **blocked** or **needs-decision** when appropriate.

No automatic commit, push, pull request, publication or merge: do those only if
the user requests them, using normal host approvals. Record any such effects
and their links before retrying to avoid duplicate actions.

Explicit human direction may change the route or reviewers; record the exact
authorization and reason as a deviation and, for an unreviewed phase, its
`reviewWaiver`. Do not invent approval, bypass host permissions or ignore a
hold/cancel. On resumption, read the existing report, check the actual checkout
and external effects, and continue without erasing history.
