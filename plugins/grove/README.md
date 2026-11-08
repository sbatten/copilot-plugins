# Grove

A Copilot plugin that pairs a **Chief of Staff orchestration workflow** with a
**hi-detail pixel-art canvas** (480×320, crisp at any panel size) that shows it happening. The canvas is
a calm, bioluminescent forest clearing.

The beautiful, accurate live view is the primary experience. Autonomous engineers
doing meaningful work and producing trustworthy reports are a close second.
Neither is expendable. Tracking and workflow machinery support both; they must
not prevent agents from recovering or following the human's instructions.

## Guiding principles

This is the repository's design charter for maintaining Grove's code, bundled
agent instructions and user experience. It is not a requirement for runtime
agents to consult this repository while working on other projects. The workflow
below describes the current implementation.

1. **Protect both essential pillars.** The beautiful, decorative, accurate live
   forest is the primary experience. Autonomous engineers doing meaningful work
   with trustworthy reports are a close second, not an optional extra. Do not
   simplify the product by sacrificing either. Workflow machinery is subordinate
   to both.
2. **Keep the Chief available through delegation.** The Chief delegates all
   task work, including small actions and research, and ends its turn rather
   than waiting. Coordination, status and interpreting human intent stay with
   the Chief; the engineer owns the task's outcome. Availability comes from
   clear agent responsibilities, not a parallel permission system.
3. **Prefer native host capabilities.** Supply the correct session, workspace
   and worktree parameters, and use native messaging and session controls.
   When something goes wrong, inspect the call and its parameters before
   assuming the host needs a defensive wrapper. Continue existing work in its
   checkout. Normal host approvals and permissions still apply.
4. **Use guidance rather than cages.** Reviewed planning, implementation and
   verification, followed by draft/publish/watch/merge, are useful defaults.
   They are not unoverrideable product rules. Agents need freedom to adapt
   their route and resolve operational problems, not additional tool denials
   or forced stop-hook correction turns.
5. **Explicit human direction already supplies authorization.** The human
   should not have to repeat an approval, learn Grove's internal transitions,
   or grant a special repair flag. The Chief interprets their intent and the
   engineer carries it out, recording deviations in the report. This does not
   authorize inventing approval or bypassing the host's own safeguards.
6. **Let the team recover without erasing accountability.** Engineers may
   retry or replace inaccessible reviewers and repair operational problems.
   If the engineer is inaccessible too, the Chief can recover or replace the
   team when asked. Preserve the task, checkout, evidence and prior findings;
   replacing a chat must not silently dispose of an objection. Escalate
   unresolved review disagreement at the round limits and genuine human-only
   prerequisites, not recoverable bookkeeping.
7. **Make the scene truthful, not mechanically busy.** Phase-based movement
   is intentional; the scene need not react to every file read or tool call.
   A running implementation command belongs at the forge, while a genuinely
   idle member rests in its tent and a human blocker waits at the lantern.
   A dispatch is not proof of activity, and stale observations are uncertainty,
   not proof that work continues. The engineer's character belongs to its task
   even if the backing chat dies. Ordinary subagents do not get characters.
8. **Tracking supports work; it does not authorize it.** Show tracking errors
   honestly, reconcile them when possible, and let independent useful work
   continue. Ordinary host tools must not wait on Grove's board reads. Retain
   atomic storage, revision fencing and assignment identity to keep decisions
   and reports correct; do not turn those internal mechanisms into a workflow
   maze for agents or humans.
9. **Keep the report rich and honest.** Preserve its existing presentation:
   outcome and ask, PR, evidence, acceptance criteria, decisions, work and review
   history. Record recovery actions, unresolved concerns and intentional process
   deviations. Completed work is not automatically unanimous review approval.
10. **Respect stops through the native host.** Human hold/cancel instructions
    matter, but Grove is not an emergency-stop or process-isolation layer.
    Record the decision, notify the team and use native session controls as
    appropriate. Do not claim an already-running command has been undone.

**Maintainer check:** prefer the smallest mechanism that preserves both pillars.
Before adding a restriction or recovery protocol, identify the concrete failure
it prevents, check whether native tooling or agent guidance already addresses it,
and ensure an engineer can recover without another human authorization ritual.
Distinguish data integrity from behavioral policy, and keep the scene and report
truthful when a default is overridden or tracking is incomplete.

## The workflow

You talk to one agent, the **Chief of Staff**. Its instructions say to delegate
every request and never wait on agents, so it remains available. Grove does not
add a tool-denial layer: agents use native host tools and normal host approvals.

When you ask for something, the Chief:
1. turns the request into tasks, each marked `code`, `research` or `other`;
2. hands each task to a new, independent **engineer session** with
   `create_session`;
3. replies and ends its turn, so it's always free for your next message.

Each **engineer** does its task from start to finish in its own chat: it plans,
researches, implements and verifies, loading a **skill** for each kind of step.
For an independent opinion it hires **reviewers**, normally reusing each
specialty's chat across rounds so it remembers earlier findings. An inaccessible
reviewer can be replaced without losing the recorded discussion.
**Session-backed team members get sprites; subagents do not.** An engineer's
character belongs to the task and survives replacement of its backing chat.

In VS Code's session list, **each task is grouped under its engineer**:
- **Engineers:** the Chief starts each engineer as an independent top-level
  session at its structured task destination (`relationship: "independent"`).
- **Reviewers:** nested chats inside their engineer's session
  (`relationship: "currentSession"`), so a task's whole team sits together.
- **Routing:** Grove's `preToolUse` hook supplies this placement (and the
  model) on recognized engineer and reviewer `create_session` calls. Unrelated
  session calls pass through. Routing comes from the task destination, not
  the Chief's cwd or a path mentioned in the goal.

### Workspace routing

Every new `grove_create_task` requires `destination`:

| Mode | Workspace | Creation intent |
| --- | --- | --- |
| `new-worktree` | Absolute target repo | `worktree: true` |
| `existing-worktree` | Continuation checkout | Direct folder |
| `read-only` | Absolute research folder | Direct folder; no new worktree needed |
| `scratch` | Omitted | Omit workspace/worktree; independent host scratch |

Grove supplies native workspace/worktree parameters and records the directory
reported by the host. Recovery reuses that checkout instead of requesting
another new worktree. It does not probe Git identity, gate tools on placement,
or require a Grove repair flag and extra confirmation form.

Reviewers share the engineer folder by default. `{ name: "code", worktree: true }`
requests a separate nested worktree on supporting hosts. The engineer tells the
reviewer which branch/commit to inspect; the agents use native tools to prepare
their checkout when needed. Grove does not select commits or require a clean
snapshot merely to accept a review. Normal host approvals still apply.

### Steps: the engineer shapes the work

Not every task is a code change, so the engineer decides what each task needs.
It builds a **route** out of four kinds of step, and can attach reviewers to
any of them:

| Step | Skill the engineer loads | For |
| --- | --- | --- |
| `plan` | `grove-plan` | designing a change before making it |
| `research` | `grove-research` | finding things out: data, issues, code, docs, the web |
| `execute` | `grove-execute` | making a change: code, or other actions |
| `verify` | `grove-verify` | proving it works with **visual evidence** (screenshots, screen recordings, rendered output) saved to session data |
| *reviewers* | | checking a step's output in a shared forum; approval is **unanimous** by default |

**Reviewers:**
- **Built-in:** `security`, `tests`, `code` and `architecture` have their own
  personas. `accuracy` re-derives numbers and facts independently.
- **Your own:** any other name needs a focus, for example
  `{ "name": "privacy", "focus": "no user-identifying data" }`.
- **How they review:** Grove adds the `grove-review` skill to every reviewer's
  brief: check the work yourself, label findings blocking or non-blocking,
  re-check your own earlier points first in later rounds, and end with a
  verdict.

**Templates** cover the common shapes:
- `code-change`:
  1. **plan**, reviewed by security, tests and architecture;
  2. **execute**, reviewed by security, tests, code and architecture;
  3. **verify**, reviewed by tests. The engineer verifies its own work, so the
     tests reviewer opens the evidence and checks it against each criterion.
- `research`: one **research** step, reviewed by accuracy.

These are default guidance, not unoverrideable rules. Explicit human direction
already authorizes a different route, reviewer set or shipping behavior. The
engineer records the reason in the report instead of asking for approval again.

Some examples:
- "What are the weekly and monthly active users of the agents window?" gets
  one research step with an accuracy reviewer.
- "Collect easy issues assigned to me" gets one research step, reviewed if it
  matters.
- A feature request gets the `code-change` template.

**How a route runs:**
1. **Each step:** `grove_next` gives the engineer the step's assignment (the
   skill to load, the brief, feedback to address, the evidence folder). It
   does the work in its own chat and submits the output with `grove_submit`.
   Grove checks it right away and says what to fix if it falls short.
2. **Reviews:** if the step has reviewers, `grove_submit` returns their hires
   and the engineer ends its turn. Each reviewer reports back to the
   engineer's chat. If the review isn't unanimous, the engineer revises in its
   own chat and resubmits, and the same reviewer chats review it again.
   - **Review limits:** after 3 rounds without agreement the step is escalated
     to you. Sending it back starts another review window; lack of agreement
     after 6 total rounds on the step also escalates, even across windows.
   - Rebuttals and revisions go back to the team. Identical summary wording
     is not treated as proof that the underlying work did not change.
3. **Choosing again:** when the steps are done, Grove shows the engineer their
   results, and it chooses what's next:
   - add more steps, replace planned ones, or **redo** a finished step (and
     everything after it) with feedback;
   - or **deliver** a short summary, the key decisions it made, and an `ask`:
     the one thing it needs from you (a decision, a question to answer, or
     just "approve").
4. **Failed verification:** this also comes back to the engineer, which
   usually redoes from the execute step.
5. **Draft PR:** a code change (one with an `execute` step, unless the engineer
   said `ship: false`) isn't brought to you yet. Grove adds a step for the
   engineer to commit it and open a **draft pull request**, so you can review
   the change itself. If the work can't go in a PR (no repository, no remote,
   nothing changed in files), it says `NO PR: <why>` instead.
6. **Sign-off:** a delivered result goes to the Chief, which brings it to you.
   - **The report:** a link to the task's report comes first (see below),
     then the draft PR's link.
   - **The engineer's ask** and **the result:** the answer or outcome, with
     links to the evidence.
   - **Approve** when you're satisfied. A code change then ships (see below).
   - **Ask for more**, and the same engineer plans the follow-up, usually
     redoing a step. This works on a finished task too: it reopens it.

**Adapting and recovering:** `grove_plan_steps` with `replace: true` can replace
unfinished work (include `note` for active work). `grove_submit` accepts
`reviewers` and `note` to adapt a current review, including an empty reviewer
list when the human says to skip it. `grove_deliver` accepts `ship: false` for
local-only work and `complete: true` for an already-authorized outcome, without
another sign-off. The engineer records the existing authorization in its decisions.

If a review can't agree, the task is **escalated to you**. The Chief links the
report and lays out each reviewer's position.

### Shipping an approved code change

When you approve a code change (the engineer delivered it with an `execute`
step, and didn't say `ship: false`), the engineer carries on without being
asked:

1. **Publish:** Grove adds a step for the engineer:
   - push anything new to the draft PR and mark it **ready for review** (or,
     if there was no draft, commit, push and open the PR), with
     `Closes #<n>` for the issue it fixes;
   - do anything else you asked for when approving, such as closing a
     superseded PR;
   - start any GitHub comment with 🤖;
   - submit the PR link (Grove checks for it).
2. **Watch:** Grove itself polls the PR with `gh pr view` every 2 minutes. The
   engineer isn't woken and isn't pushed while checks run.
   - **Checks fail, a reviewer requests changes, or the branch conflicts:**
     Grove wakes the engineer with the details. It plans the fix (usually one
     execute step), and Grove goes back to watching. The same problem on the
     same commit isn't raised twice.
   - **Ready to merge** (checks complete without failures, mergeable, and review
     approved or no review required with a clean merge state):
     the Chief asks you, and the inbox shows a **Merge** button.
   - **Merged** (by the engineer or anyone else): the task is done, and the Chief
     tells you.
   - **Closed without merging:** escalated to you.
3. **Merge:** when you say so, the engineer merges it the way the repository
   expects, never bypassing checks or reviews.

If you don't want a PR, the Chief approves with `ship: false`. If the draft
step said `NO PR`, approving simply finishes the task. If `gh` can't
read the PR, the engineer's sprite shows the error until it can.

This lifecycle is the default. The human can direct a different one through
the Chief, including publishing or merging without another approval prompt.
The engineer carries it out using native tools and reports what it did.

### Blocked, on hold, and questions

The normal conversation goes through the Chief, who interprets your intent,
records it (`grove_record_decision`) and messages the engineer. These actions
are conveniences for the agents, not a vocabulary you need to learn:

| You… | Decision | What happens |
| --- | --- | --- |
| want everyone to stop for now | `hold` | Open review assignments are cancelled and automatic work wake-ups pause. The Chief notifies/stops sessions using native host tools; already-running actions are not undone. |
| want them to continue | `resume` | The engineer carries on with its step, or the missing reviewers get their work again, in the same chats. |
| ask something about the work | `question` | The engineer finds out what it needs, answers with `grove_answer`, and the Chief brings you the answer. |
| want to steer a running task | `note` | The engineer (and its reviewers) see your words; nothing stops. |
| aren't ready to act on something waiting on you | `shelve` | It goes on the **shelf** (see below). |
| want a shelved task back in your inbox | `unshelve` | It's back exactly where it was. |

Status questions ("where are we?") aren't recorded: the Chief answers them
from `grove_status`.

Approval can also authorize continuation of a blocked or ongoing task; it need
not match a sign-off screen. `resume` and `retry` pass on continuation without
resetting already-active work. Explicit `changes` can reopen a finished or
cancelled task. If you request a different route or shipping outcome, the
engineer adapts it instead of asking for the same approval again.

**The shelf:** anything waiting on you (a sign-off, an escalation, a blocker, a
PR ready to merge) can be set aside for later with **Shelve** in the inbox, or
by telling the Chief.
- It leaves your inbox, and the Chief leaves the **Needs you** lantern if
  nothing else waits, so the lantern always means something needs you now.
- The engineer rests in its tent, which goes dark with a "z" drifting up. Its
  chat, its reviewers' chats, the draft PR and the report are all kept, and
  Grove doesn't wake or push it.
- Grove keeps watching a shelved task's PR. If the PR needs work (failing
  checks, requested changes, conflicts), the task comes off the shelf and goes
  back to the engineer.
- **To pick it up:** **Bring back** in the inbox's shelf puts it back in your
  inbox exactly where it was. Or attach it to chat and say what you want: any
  answer (approve, "run it again with this week's data", cancel) takes it off
  the shelf, and the same engineer, which remembers everything, does it.
- There's no timer: it waits until you bring it back.

**Blocked on you:** when something only you can do stands in the way (signing
in, access), the engineer calls `grove_blocked`, or a reviewer ends its review
with `BLOCKED: <what you must do>`.
- Grove records the blocker, cancels open review assignments and pauses its
  automatic work wake-ups. The team is instructed to pause; the Chief tells you
  exactly what to do. Native session controls handle stopping running work.
  The task shows in your inbox, and whoever is blocked waits at the
  **Needs you** lantern.
- When you've done it, tell the Chief (or attach the task and say so). It
  records `retry`, and work continues in the same chats.
- There's deliberately no "retry" button: unblocking goes through the Chief.
  Operational problems the engineer can solve do not need a human unblock:
  it uses native tools and `grove_recover` when the prerequisite is resolved.

**Status board:** engineers post progress with `grove_update`. It shows on the
tent's hover, in the inbox, in the task view and in the report, and
`grove_status` returns it.
- **Keep the Chief's chat clear:** engineers are instructed to use the board
  for progress and send the Chief results, escalations, blockers, answers and PR
  notices. Reviewers normally report to their engineer. These are communication
  conventions, not restrictions on native `send_message`.

**Host message limits:** a hire that hits the host's limit on messages per
session isn't counted as a failure. It waits 15 minutes and retries in the
same chat. Reuse preserves context, but an engineer can replace an inaccessible
reviewer with `grove_recover` whenever it judges that necessary; it need not wait
for the host to declare the chat gone. Prior findings and discussion stay on
the board and in the replacement's brief.

You can answer in the Chief's chat or from its **inbox** in the grove (see
[The canvas](#the-canvas)).

### The task report

Whenever a task comes back to you, for sign-off, input or completion under
existing authorization, Grove writes
a self-contained HTML page beside its evidence, at
`files/grove/<T>/report.html` in the Chief's session data. It's rewritten
when you decide. The canvas also serves it at `report/<T>/`.

It's styled as a higher-resolution version of the grove: the night sky and
treeline, parchment scrolls with gilded corners, rune tags, the team's real
sprites, and each step's workstation. The content changes with the task, but the order doesn't:
1. **Your move** (the summons scroll at the top): what's needed from you in
   one line, the engineer's `ask`, how to answer from the chat or the inbox, a
   brief summary, and a row of facts (the PR, how many pieces of evidence,
   criteria shown, verification and reviews).
2. **Pull request:** for work using PR shipping, its state or why there isn't
   one. Local-only or non-PR deliveries can omit this section.
3. **Evidence:** screenshots and screen recordings first, as a gallery.
   Click an image to enlarge it; recordings play in place. The verify step's
   evidence comes first, then anything saved during research or execute
   steps.
4. **Acceptance criteria:** each one with the evidence that proves it (matched
   by the criterion's text or number in `evidence.json`).
5. **Decisions:** the key decisions the engineer listed, each review's outcome,
   and what you asked for along the way.
6. **What the team did:** the result (the last research, execute or plan
   output), progress updates and questions.
7. **How it was done:** the team (the engineer and its reviewers), then every
   step with its output, each reviewer's verdict and the full review
   discussion, then the task's log.

Recovery and process deviations remain visible in the history and decisions.
If an unfinished review is bypassed at delivery under human direction, the
report labels it as not completed rather than displaying unanimous approval.

The page has no scripts. Every value is escaped, and the step outputs'
Markdown is rendered as a safe subset. It also works on a phone and prints
cleanly.

Tasks run in parallel, one engineer session each.

### Models

| Session | Model | Set in |
| --- | --- | --- |
| Chief of Staff | User-selected model | Chat model picker; no model pinned in `chief-of-staff.agent.md` |
| Engineer, `code` task | Claude Opus 5.5 | `ENGINEER_MODELS` in `lib/process/models.mjs` (`grove-engineer.agent.md` names the code model) |
| Engineer, `research` or `other` task | GPT-6.1 Sol | `ENGINEER_MODELS` |
| Security reviewer | Claude Opus 5.5 | `grove-reviewer-security.agent.md` |
| Code reviewer | Claude Opus 5.5 | `grove-reviewer-code.agent.md` |
| Architecture reviewer | GPT-6.1 Sol | `grove-reviewer-architecture.agent.md` |
| Tests reviewer | GPT-6.1 Sol | `grove-reviewer-tests.agent.md` |
| Custom-focus reviewers (accuracy, privacy…) | rotation: Grok 4.7, Gemini 4, GPT-6.1 Sol, Claude Opus 5.5 | `grove-reviewer.agent.md` |

- **How it applies:** The Chief leaves the model choice to the user.
  Engineers and reviewers aren't started *as* custom agents
  (`create_session` can't choose one), so Grove passes the model to
  `create_session` on every hand-off and hire, and puts each agent file's
  instructions in the session's brief. The `preToolUse` hook also sets the
  model, overriding a missing or different one, so no specialist session inherits a
  lighter model from the chat that started it.
- **Rotation:** for the generic reviewer, the list is a rotation, not a
  fallback order: the first custom focus on a step gets Grok 4.7, the second
  Gemini 4, and so on.
- **To change a model,** edit the agent file (or `ENGINEER_MODELS`) and
  reinstall the plugin. `tests/agents.test.mjs` requires specialists to name
  one and the Chief to leave it unset.
- **Reasoning effort and context size** can't be set per session:
  `create_session` only takes a model, so these follow the host's defaults.

### How work flows between sessions

```
you ──► Chief of Staff ──► T1 engineer ── plan · execute · verify (in its own chat, one skill per step)
            ▲   │               │
            │   │               ├──► T1 · Security / Tests / Architecture reviewers   (plan)
            │   │               ├──► T1 · Security / Tests / Code / Architecture      (execute; same chats)
            │   │               └──► T1 · Tests reviewer                               (verify; same chat)
            │   │                         └─ each reviews, then reports back to the engineer's chat
            │   └─ grove_record_decision ─► board applies it ──► optional engineer notification
            ├──── "[Grove → Chief of Staff] T1 is ready" + report ◄── board ◄── submissions and reviews
            │
   grove inbox (Complete / Dismiss) ─► board applies it ──► optional engineer notification
```

- **Down:** `grove_create_task` names the task and returns a hand-off (title, a short prompt with
  a one-time marker, and the model for the task's kind). The Chief starts the
  engineer with it. In the new session Grove turns the marker into the
  engineer's full brief: its standing instructions (`grove-engineer.agent.md`),
  the goal, the criteria, and the steps with their skills.
  Put all startup instructions in the goal and criteria before creating the
  engineer: creation starts work immediately, with no follow-up decision needed.
- **Work:** the engineer works each step in its own chat and submits it with
  `grove_submit`. Grove checks the output against the step's contract, records
  it on the board, and opens the review or starts the next step.
- **Reviews:** `grove_submit` (or `grove_next`) gives `create_session` the
  first time a specialty is needed, and `send_message` to that reviewer's chat
  after that. The engineer only passes a short hire marker; Grove, inside the
  reviewer's chat, expands it into the brief: the reviewer's persona, the
  `grove-review` skill, the task, the output under review, the results of
  earlier steps and the review discussion. The reviewer calls
  `grove_submit_review`, which records the verdict and returns the native
  **`send_message` to the engineer**. A final-message observer also records
  reviews from sessions that omit the submission tool, without a stop-hook loop.
  The report steers the
  engineer's active turn (`delivery: "steer"`), or, if the engineer is idle
  (the host answers with action `rejected` and reason `cannotSteer`), is
  resent queued and starts its next turn; any other result is not resent.
  The engineer's Grove applies reviewer results through revision-fenced task writes.
- **Up:** when a task needs you (a delivered result, an escalation, a
  blocker), the engineer **messages the Chief** (`grove_next` lists the
  message). Grove attaches the full details to that turn, and the Chief relays
  them to you.
- **Back down:** your answer goes to the Chief, which applies it with
  `grove_record_decision` before returning success. It can notify the engineer.
  Decisions that change the engineer's work (changes, note, question, hold,
  cancel) steer its active turn; the rest queue. The engineer reads the already
  applied decision and follows the human's intent, adapting the workflow if needed.
  The returned native message includes its `delivery` field; automatic
  notification retries use the same policy.
- **Relays are pointers.** Host messages can be clipped or arrive out of
  order, so a relay only carries its marker and tells the engineer to call
  `grove_next`, whose `decisions` and `reviews` fields hold the full text.
  Stale, replayed or forged markers are ignored.
- **Human control is authoritative.** Both chat and inbox actions apply
  durably without an engineer session. Duplicate UI actions and repeated
  cancellation are safe. Per-task filesystem locking and revision checks stop
  stale saves, claims and callbacks from overwriting human state. Interrupted
  commits replay the durable decision log on the next board read.
- **Notification is separate.** Only verified current-engineer links are used.
  Automatic notification has a persisted limit of three attempts per decision/generation,
  including the one permitted steer-to-queue fallback. Unknown chat ownership
  stops retries immediately. Application remains successful even if notification
  is unavailable; execution (answering, publishing, merging) is separately pending.
  Grove does not automatically replace an engineer for failed notification.
  Recovery/replacement requires the human's explicit request through
  `grove_handoff`. Old conditional recovery notices cannot replace an engineer
  for a decision already applied.

Adopting committed task changes from another session also updates the live canvas.
New engineers and activity changes reach connected viewers without a follow-up
Chief turn; unchanged refreshes do not broadcast another state.
  These limits bound Grove's automatic retries, not native tool availability.
  The Chief can inspect, message or recover the team through host tools when asked.
- **Dismiss everyone in chat** means cancel each active task individually,
  equivalent to using each engineer's existing Dismiss action. No bulk-dismiss
  UI is added. The Chief remains, and reports/history are preserved. Scene-only
  `clearAgents` cannot dismiss task teams.
- **Concurrency rollout:** all Grove processes sharing a board must reload the
  updated plugin before relying on revision fencing. Older running code does
  not honor the new lock/revision contract. A tool already in flight cannot be
  undone; use native session messaging/controls to stop work. Grove records
  cancellation durably but does not deny host tools.
- **Host limits.** A queued send the host rejects with `cannotSteer` is a
  host result, not a Grove one. An engineer whose chat has gone cold can only
  be reached again with a host change or a new hand-off. Grove captures the
  link from any tool result named `get_current_session`. The meta update in
  `grove_handoff` reloads the board first but is not a cross-process
  transaction. If the host registers the Grove provider twice, both copies
  run; Grove does not deduplicate them yet.
- **Grove must load in every chat it hands work to.** Hand-off prompts carry
  only a marker; the receiving chat's own Grove expands it into the brief. If
  the host starts a reviewer chat without the plugin (seen after a plugin
  update while the engineer's session stayed open), the reviewer says so in one
  line and ends its turn instead of asking for a brief. The hire fails with
  "Grove was not loaded in its new chat" after the claim timeout, and the
  engineer recovers or asks the human to reload its session.
- **Native hand-offs are visible.** Session creation and model-to-model
  `send_message` calls appear in the host, so the human can follow the work.
  - **Why not wake sessions directly?** Turns an extension starts itself (the
    SDK's `session.send`) don't appear in VS Code, and host tools such as tool
    search don't work inside them.
  - **Fallback:** Grove uses those direct wake-ups only if an expected message
    hasn't arrived within 45 seconds, or the engineer stopped in the middle of
    a step.

### Tracking, not permission

Each session runs a copy of the extension with a Chief, engineer, reviewer or
observer role. Roles scope writes to the shared board; they do not restrict
native host tools. Delegation, communication and review behavior live in agent
instructions. Neither tool hooks nor stop hooks deny work or force correction
turns. Host approvals and permissions remain unchanged.

Reviewer tickets bind results to their assignments and submission versions, so
late results from a replaced reviewer cannot approve a different revision.
`grove_submit` validates non-empty output and structured evidence/results/PR
links, not prose length. Review quality is judged by the team and the human.

Grove watches phase skills and session activity. Active work stays at the
phase's workstation, including while a command runs. Idle sessions rest in
their tents; human prerequisites show at the lantern. Stale activity observations
are not shown as indefinitely active work.

Tracking failures are visible as delayed tracking, not permission failures.
Polling reconciles the board when it becomes available, while independent work
continues. Atomic writes, task locks and revision fencing still protect reports
and decisions from stale writes.

**Recovery belongs to the team:**
- Engineers use native session/workspace tools to inspect and repair problems.
- `grove_recover` with `reviewer` and `note` replaces an inaccessible reviewer
  without discarding its prior findings or the forum's history. It can be used
  whenever needed, not only after a host declares the chat gone.
- `grove_recover` with `note` resumes a prerequisite the engineer has resolved.
  It is not direction to ignore a human hold or silently waive objections.
- Failed hires are retried up to three times; exhaustion returns recovery to the
  engineer rather than automatically escalating an operational problem to you.
  Host message limits still back off for 15 minutes.
- If an engineer itself is inaccessible, ask the Chief to reach or replace it
  using native messaging or `grove_handoff`. The replacement keeps the same task,
  character, checkout, review history and reports.
- Unresolved review disagreement at the round limits and things agents truly
  cannot perform still come to the human.

Process state is a **board** in the Chief's session data, at `files/grove/`:
- `board.json` holds task numbering, hand-offs and notices sent.
- `tasks/<T>.json` holds one task, including its reviewers' chat links. Its
  engineer records work; the Chief applies human decisions under the same lock.
- `results/<ticket>.json` holds one reviewer's progress heartbeats and final
  review. Only the reviewer session working that ticket writes it.
- `decisions/<T>.json` holds your decisions, from chat or the grove inbox.
  Only the Chief writes it.
- Evidence goes in `<T>/evidence/attempt-<n>/`, and the report in
  `<T>/report.html`.

Engineers and reviewers find the board through
`<COPILOT_HOME or ~/.copilot>/extension-data/grove/boards/<board-id>.json`.

**A fresh Chief of Staff chat can resume an existing Grove.** Before creating
tasks, call `grove_status` to identify its `boardId`, then `grove_resume` with
that id and the new chief's `chiefSession` (`openLink` from
`get_current_session`), with the human's permission. All tasks, engineers,
hand-offs, decisions and evidence stay on the original board. Future notices
go to the new chief, which can dismiss or otherwise manage old tasks normally.
The previous chief becomes read-only. A `grove-chief.json` link in the new
session's files remembers the resumed board across restarts. Simply viewing
another board does not take it over; creating tasks without resuming still
starts a separate Grove.

**Board format:** version 2 is the one-engineer process. A board from the
earlier process (version 1: a task lead with a persona session per step)
isn't migrated. Grove leaves it untouched and says so: start a new Chief of
Staff chat for a fresh board. The old reports and evidence stay on disk.

## The canvas

The canvas shows the team at work. Your **inbox** lives on the Chief of Staff:

- **Books over the Chief:** while tasks wait on you, books in their task
  colours float over the Chief at the **Needs you** lantern (three at most,
  then a count).
- **Click the Chief** (or the books), or use the **Inbox** button in the
  toolbar (which also shows the count), to open the inbox. It opens like a
  game's menu: a near full-screen panel over the dimmed grove. Press **Esc**,
  click **Close**, or click outside the panel to return to the grove.
- **One row per task**, in three sections: **Needs you**, **In progress** and
  **On the shelf**. Each row has the task's report book on the left, what it
  needs and a short summary in the middle, and its actions on the right, with
  the main one (Approve, Merge, Accept or Bring back) first and highlighted.
  On a narrow screen the actions wrap under the text. Each ask shows:
  - the task, what it needs (**Ready for sign-off** or **Needs your input**),
    how long it has waited, the engineer's ask and a short summary;
  - a **book** that opens the task's report in a new tab;
  - **Attach to chat:** your next message in the Chief's chat is about this
    task, so you can write "approve, but rename the flag" without naming it.
    The Chief records it as your answer, or as a note to the team if the task
    is still running. Attach several tasks to cover them in one message, and
    click again to remove one. Attached tasks show in the inbox and on the
    **Inbox** button.
    - **How it works:** VS Code doesn't show pills that extensions push into
      the chat input, so Grove doesn't use them. Grove keeps the attached tasks
      and adds them as context to your next message to the Chief, once. Its
      own relay messages don't use them up. The Chief names the task at the
      start of its reply, since the context isn't visible in chat. Only the
      Grove opened from the Chief's chat can attach.
  - **Complete** (sign off, or **Approve** for a code change, which normally
    publishes its existing draft PR; if there is no draft, the engineer opens
    a PR; **Accept** for a stuck review, which puts the team back to work),
    **Merge** for a PR that's ready, **Shelve** (set it aside for later; see
    [the shelf](#blocked-on-hold-and-questions)), and **Dismiss** (cancel the
    task, after a second click to confirm).
  - **Blocked** tasks show what the team needs from you, with Attach, Shelve
    and Dismiss only: tell the Chief when it's done.
- **In progress:** tasks still running (including on hold, or watching a PR)
  are listed below the asks with the engineer's latest update, plus Attach and
  Dismiss.
- **On the shelf:** shelved tasks are listed last, with what they were waiting
  for, their report, and **Bring back**, Attach and Dismiss.
- **How inbox decisions travel:** Grove applies them to the board immediately.
  An active engineer's tracker polls about once a second; work notifications
  and fallback wake-ups are separate from recording the decision, and depend on
  session/host availability. Shelving does not request a work wake-up.
  The inbox and the lantern change at
  once, without waiting for the engineer. The Chief hears what you decided at the start of its next turn.
  If the engineer's session isn't running, the Chief is asked to message it after
  45 seconds. Only the Grove opened from the Chief of Staff's chat can decide.

- **Team members become sprites:** the Chief and each task's engineer/reviewer
  roles have session-backed characters. An engineer keeps its character when
  its backing chat is replaced; reviewer replacement reuses the specialty's
  character. Ordinary subagents have no character. The role picks its class:

  | Role | Class |
  | --- | --- |
  | Chief of Staff | archmage |
  | engineer | mage (dusk robe, with its task's pennant), a **shapeshifter** |
  | reviewer | seer (robe colour by specialty) |

- **Activities become places:** while the engineer's session is active, it
  walks to the workstation for its phase. Thinking and long-running tools are
  part of that activity; it does not move stations for every individual tool:

  | The engineer is… | Where |
  | --- | --- |
  | planning, or choosing the next steps | the PLANNING star table |
  | researching | the RESEARCH bookshelf under the ancient tree |
  | executing (and opening, publishing or merging a PR) | the IMPLEMENTING forge |
  | verifying | the TESTING dummies |
  | actively coordinating its review | in the huddle at the REVIEW lectern (plans and research) or the CODE REVIEW mirror (changes and verification) |
  | waiting on you, on hold, or watching a PR | resting in its tent |
  | genuinely idle, even with an unfinished step | resting in its tent |
  | activity observations are stale | resting rather than pretending to work; tooltip marks activity unknown and gives the last seen phase |
  | blocked on you | at the **Needs you** lantern next to the Chief |

  Session events distinguish active turns from idle ones. Observations currently
  refresh about every 30 seconds; after 90 seconds without an observation,
  activity is no longer treated as current. A dispatched reviewer rests until
  its tracker observes it working. Expiring observations refresh the scene even
  when the board has no new writes.

  - **Shapeshifting:** the engineer is a mage on the move, but when it
    arrives at a station it transforms into the class that works there: a
    scribe at the star table, a scout at the bookshelf, an artificer at the
    forge, a warden at the dummies. A ring of light rises from its feet as it
    changes, and it changes back to a mage when it sets off again. Its robe
    stays the same colour, and its tooltip says which form it has taken.
  - **Detours:** the station follows the skills it loads. If it loads
    `grove-research` in the middle of an execute step, it walks to the
    bookshelf, and back to the forge when it loads `grove-execute` again.
  - Each review stands in its own **huddle** under a banner such as `T3 R2`
    (task and round). The speaker rotates while they discuss.
  - **Reviewers** walk to the huddle while they review, and rest in their
    team's **tent** between rounds (their chat stays open for the next
    round). A blocked reviewer waits at the **Needs you** lantern. The team
    leaves when the task is done.
- **Team tents:** when a task's team forms, it pitches a tent at camp in the
  task's colour, beside the fire.
  - Idle members walk into the tent and aren't drawn while inside, so a busy
    camp stays readable. The doorway glows while anyone is in.
  - **Hover** a tent to see the task, its stage, what it's blocked on, its PR,
    the engineer's latest update, who's resting inside (each reviewer with its
    last verdict: approved or changes) and who's out working. **Click** it to
    open the task view.
  - The tent comes down once the team has left.
  - There's no limit on tents. Ten pitch with room to spare on either side of
    the fire; further tents pack into the gaps between them, always clear of
    the fire's seats.
  - The **Chief** waits at the **Needs you** lantern whenever a decision is
    waiting for you, with its inbox books overhead. It sits at camp otherwise:
    always available.
- **Errors:** an agent with a problem shows a red **!** bubble and flickers.
  Click it for the reason. Agents with an error stay out by the fire rather
  than going into their tent. Errors come from:
  - **Session errors:** any session (the Chief, an engineer, or a reviewer)
    that hits an error in its chat, such as "No response was returned" or a
    failed model request. It shows until a turn goes through again, with a
    count when it repeats. Reviewers report it in their heartbeats, and an
    engineer's is stored on its task, so the Chief's grove sees both.
  - **Failed hires:** a hire that failed, for example because the host's
    message limit was hit, the session never started, or Grove was not loaded
    in the reviewer's new chat. The reason shows until
    the retry starts, even if the reviewer never got a chat.
  - **Stalled tasks:** an engineer that stopped responding.
  - **Tracking delays:** the board could not be read or reconciled. The delay
    is visible, polling retries, and independent work can continue. Ordinary
    host tools do not wait for a board read or require tracking repair first.

  `grove_status` includes task/session errors for the Chief; the canvas also
  shows its local tracker's delay when tracking is unavailable.
- **Task names:** every task gets a mystical name, such as **Moonfern**, as
  well as its id (`T3`), so you can tell the Chief "ask Moonfern to…". Any
  Grove tool with a `taskId` field accepts either. The name sits in a small line above the task's
  title in the inbox, the task strip, the task view, tent and agent tooltips,
  and the report, so the title keeps its room. Session titles use it too
  (`Moonfern · Add dark mode`).
  - Names come from `lib/process/names.mjs`. Each board starts at a different
    place in the list and takes the next name for each new task, so names
    never repeat on a board; after a full lap they gain a numeral
    (`Moonfern II`). Tasks made before names existed get theirs the same way
    when the board loads.
- **Many tasks at once:** every task gets a colour.
  - Each agent wears a **pennant** in its task's colour.
  - Review huddles fly a banner in it, and the team's tent is made of it.
  - The **task strip** under the scene shows one chip per task with its stage,
    or "Waiting for its engineer" until the engineer session picks the task up.
- **Task view:** click a task chip to see the task's steps. Above them: whether
  it's on hold or blocked, its PR, your open question and the engineer's updates. Pick a step to read
  its output, its review (round votes and every post) and, once delivered, the
  engineer's summary. **Report ↗** opens the task's report. It's read-only. Press
  **Escape** or **◀ Grove** to return.

## Using it

### Install in VS Code

1. Open the **Agent Customizations** editor and select **Plugins**.
2. Add `sbatten/copilot-plugins` as a plugin marketplace, then install
   **grove** from that marketplace using the Copilot plugin manager.
3. If you previously installed Grove directly through Copilot, remove that
   installation before installing the marketplace copy to avoid duplicates.
4. Use the **Copilot** agent harness with SDK extension and canvas support.
   The plugin needs the VS Code agent host's session tools.

For local development, you can instead select the add (`+`) button next to
**User** or **Workspace** and choose this plugin's folder,
`plugins/grove/`, rather than the repository root.

The manifest at `.plugin/plugin.json` uses VS Code's supported OpenPlugin
format. Its component paths are relative to this plugin's root and register
the bundled agents, skills, and SDK extension together.

The repository's [marketplace manifest](../../marketplace.json) lists
`./plugins/grove/` as its only plugin. When publishing a release,
keep its plugin version and description aligned with this plugin's
[manifest](.plugin/plugin.json).
Adding the marketplace does not migrate an existing direct installation.

For a Copilot-managed installation, refresh the marketplace catalog with
`/plugin marketplace update sbatten`, then update the installed copy with
`/plugin update grove@sbatten`.

### Start a task

1. Install the plugin, then start a **new** chat with the **Chief of Staff**
   agent selected. The host must provide the session tools `create_session`
   and friends (the VS Code agent host does).
2. Ask for what you want. The Chief opens the Grove canvas, starts an
   engineer session per task, and is free again right away.
3. Keep talking to the Chief to start work. When a task needs you, the Chief
   links its report in chat, and the task appears in the Chief's inbox in the
   grove. Answer from either. Watch the team in the canvas, or open an
   engineer's session to follow it in detail.

The plugin also includes the engineer's phase skills (`grove-plan`,
`grove-research`, `grove-execute`, `grove-verify`) and the reviewers'
`grove-review`. They work outside Grove too: for example, ask any chat to
"verify this change with evidence" and it can use `grove-verify`.

## Contents

Paths below are relative to this plugin's directory, `plugins/grove/`.

```
.plugin/plugin.json
agents/                  # chief-of-staff, grove-engineer, grove-reviewer (+ -security/-tests/-code/-architecture)
extensions/grove/
  extension.mjs          # SDK wiring: canvas, grove_* tools, hooks
  lib/process/           # engine (stages, steps, reviews), shared board, roles/relay/hooks/tools, briefs, evidence, report
  lib/                   # HTTP/SSE runtime, schemas, scene ops, atomic storage
  web/                   # Canvas page: model, engine/, sprites/, scene/, tasks.mjs (strip + forum view), inbox.mjs
tests/process.test.mjs   # end-to-end process tests (simulated Chief, engineer and reviewer sessions)
tests/report.test.mjs    # task report rendering and the canvas's report/inbox routes
tests/engine.test.mjs    # engine alone: submissions, reviews, hold, blockers, questions, shipping a PR, limits
tests/agents.test.mjs    # agent and skill front matter
skills/grove-plan/, grove-research/, grove-execute/, grove-verify/   # the engineer's phase skills
  grove-verify/scripts/check-evidence.mjs                            # checks evidence.json the way Grove does
skills/grove-review/     # how reviewers review (Grove adds it to every reviewer's brief)
```

## Canvas reference

### Grove tools

| Tool | Who | Description |
| --- | --- | --- |
| `grove_create_task` | Chief | Open a task `{ title, goal, kind, destination, criteria?, chiefSession? }`. The first task needs `chiefSession` from the Chief's `get_current_session.openLink`. Pass the returned handoff to native `create_session`; new scratch tasks omit workspace/worktree. |
| `grove_handoff` | Chief | Recover an engineer: `{ taskId, destination? }`. Returns the replacement's handoff and any native message to tell the previous engineer to stop. Reuses the recorded directory and preserves the task/character/history. Pass paired `forDecision`/`forGeneration` only when supplied by a Grove notice. |
| `grove_resume` | Fresh Chief | `{ boardId?, chiefSession }`: with human permission, resume an existing board, keep its tasks/engineers, and route notices here. |
| `grove_record_decision` | Chief | `{ taskId, decision, note?, ship?, errorId? }`: durably apply `approve`, `changes`, `note`, `question`, `hold`, `resume`, `retry`, `merge`, `shelve`, `unshelve`, `acknowledge-error` or `cancel`. Preserve the human's words in `note` (required for changes/note/question). Approval can authorize continuation as well as sign-off; `ship: false` on sign-off skips PR publication. `acknowledge-error` requires `engineerErrorId` from `grove_status` as `errorId`: it quietly dismisses only that session-error occurrence, preserving its original details and acknowledgment in task/report history, without changing approval/shelf state or waking anyone. Tracking/storage, PR-fetch and blocker failures are not dismissed; later session errors remain visible. Successful activity clears session errors automatically; a stale refused clear retries on ordinary polling without another model event, fenced to the same owner and occurrence. Returns state and an optional native notification; no engineer acknowledgement is needed. |
| `grove_cancel_task` | Chief | `{ taskId, reason? }`: cancel on the board. Notify/stop sessions with native tools; Grove does not deny their tools or undo running actions. |
| `grove_status` | Chief, engineer, observer session | `{ taskId? }`: show stages, kinds, engineer/reviewer links, votes, history, task/session errors and what's waiting on the human. |
| `grove_plan_steps` | engineer | `{ template?, steps?: [{ kind, title?, brief?, reviewers? }], replace?, redoFrom?, note? }`. Add steps or redo finished non-shipping work. `replace` drops pending steps; with `note`, it can also replace active work to recover or follow human direction. History remains. Returns what to do next. |
| `grove_next` | engineer | What to do now: the assignment for the step in progress (`work`: skill, brief, review feedback, evidence folder), reviewer hires to make (`create_session` with `title`, `prompt`, `relationship: "currentSession"`, `model` for a new reviewer, or `send_message` with `session`, `message` for one who has a chat), messages to send the Chief, `decisions` (the human's decisions not yet read, with notes) and `reviews` (the current round's verdicts), and, when no step is running, the results and what to decide. |
| `grove_submit_review` | reviewer | `{ output }`: record the full review ending in `VERDICT: APPROVE`, `VERDICT: CHANGES` or `BLOCKED: <human prerequisite>`. Returns the native message to send to the engineer; no stop-hook correction loop is needed. |
| `grove_recover` | engineer | `{ reviewer?, note }`: replace an inaccessible reviewer, or resume a prerequisite the engineer has resolved. Explain the failure/recovery in `note`; findings and discussion remain. Returns the next work/hires. No extra Grove repair consent is needed. |
| `grove_submit` | engineer | `{ step, output, reviewers?: string[], note? }`: record a step's output and return any reviewer hires. With `note`, reconcile a submission while tracking still shows review/waiting. Override `reviewers` with an explanation when adapting the review; an empty list skips it under explicit human direction. |
| `grove_deliver` | engineer | `{ summary, ask?, decisions?, ship?, complete? }`: write the report and return its path and Chief notification. Normally code work gets a draft PR and sign-off; a PR under watch hands back to watching. `ship: false` disables PR automation for this delivery. `complete: true` finishes an already-authorized outcome without another sign-off or automatic draft step; explain the existing authorization/deviation in `decisions`. |
| `grove_update` | engineer | Post progress on the task's status board: `{ text }`. |
| `grove_blocked` | engineer | Stop the task until the human does something only they can: `{ need, reason? }`. Returns the message to send the Chief. |
| `grove_answer` | engineer | Answer the human's open question: `{ text }`. Returns the message to send the Chief. |

### Canvas actions

These are mostly used for manual scenes and demos. Process agents appear automatically.

- **Canvas id:** `grove`
- **Open input:** `{ "scene"?: string }`. The scene name is the durable
  identity and defaults to `"default"`.
- **Actions:**

| Action | Description |
| --- | --- |
| `getState` | Return agents, the council, the theme, station visibility and the viewer count. |
| `hireAgent` | Hire an agent: `{ id, role, name?, palette?, activity?, task? }`. It walks in from the road. |
| `updateAgent` | Change an agent: `{ id, activity?, task?, error?, name?, role?, palette? }`. On an activity change, the agent walks to that station. |
| `dismissAgent` | Dismiss a manually hired scene agent: `{ id }`. Cancel a task to dismiss its engineer/team. |
| `convene` | Gather agents at the council ring: `{ topic, members[] }`. |
| `resolveCouncil` | End the council: `{ decision?, next? }`. The decision is announced, and members return to their prior activities (or `next`). |
| `configureScene` | Change the scene: `{ theme?: night\|dusk\|dawn, stations?: { <station>: boolean } }`. |
| `clearAgents` | Clear manual scene agents and their council only; does not cancel tasks. |
| `summonDemo` | Hire a demo party: `{ cycle?: boolean }`. By default the party keeps moving. |
| `setView` | Switch views: `{ view: "scene" \| "gallery" }`. |
| `snapshot` | Return a PNG of the visible canvas so an agent can see it: `{ scale?: 1–4 }`. |

Field values:

- **Roles:** `orchestrator`, `engineer`, `planner`, `implementer`, `reviewer`, `tester`, `researcher`, `generalist`.
- **Activities:** `idle`, `planning`, `plan-review`, `implementing`, `code-review`, `testing`, `research`, `waiting`, `done`.
  - To send agents to council, use `convene` instead of setting an activity.

In the canvas, click an agent to see its name, class, station and task (click
again, elsewhere, or press Escape to hide it). Hovering only highlights it, so
details don't flicker past as agents walk.

State is stored privately under
`<COPILOT_HOME or ~/.copilot>/extension-data/grove/scenes/<scene>.json`.
Writes are atomic, and each file includes a format marker and version.

## Development

The [grove-sprites repository skill](../../.github/skills/grove-sprites/SKILL.md)
documents artwork authoring, animation, palettes, layout and visual validation
for contributors. It lives outside the plugin and is not installed into users'
projects. Its validator resolves the source assets relative to its own location.

Run these commands from `plugins/grove/`:

```sh
node --test tests/*.test.mjs                             # all process, control, relay, report and scene regressions
node tests/process.test.mjs                              # process engine, roles, relays (simulated sessions)
node tests/control.test.mjs                             # durable human decisions, stale writes and notification
node tests/canvas-refresh.test.mjs                       # external task adoption reaches SSE viewers without chief turns
node tests/engine.test.mjs                               # engine alone: hold, blockers, questions, shipping, limits
node tests/placement.test.mjs                            # native routing, truthful activity, non-blocking tracking recovery
node tests/agents.test.mjs                               # plugin manifest, component paths, agent/skill front matter
node tests/scene.test.mjs                                # team tents: pitch, rest inside, strike
node tests/report.test.mjs                               # task report, report/evidence/inbox routes
node tests/relay-delivery.test.mjs                       # native messaging, full review/decision delivery and restarts
node tests/relay-outcome.test.mjs                        # host send results: accepted, cannotSteer, redaction
node tests/decision-text.test.mjs                        # inbox decision lines and toasts
node ../../.github/skills/grove-sprites/scripts/validate-sprites.mjs   # repository sprite validator
node --check extensions/grove/extension.mjs
```

After you edit files in `web/`, reload the canvas page. After you edit
`extension.mjs` or `lib/`, reload extensions.

Member sessions may run in a sandbox. Session data, which holds Grove
evidence, is writable, but locations such as `/tmp` may not be. Plans should target the
workspace or session data.
