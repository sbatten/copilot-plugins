# Report format

Keep `report.json`, generated `report.html` and evidence in the same persistent,
task-specific artifact folder. The renderer uses only Node built-ins and does
not load code, fonts, scripts or styles from the network. Text is plain text,
not HTML or Markdown; preserve full prose and transcripts without summarizing
away the phase or review history.

Run:

```sh
node <installed-skill>/scripts/render-report.mjs <task-folder>/report.json
```

This validates the record and local evidence, writes `report.html` beside the
JSON and prints its absolute path. It exits nonzero on invalid data. Render an
in-progress report early; update it at every checkpoint, not only on success.

## Record

All fields below are required except `pr` and a stage's `reviewWaiver`.
Arrays can initially be empty. IDs must be unique within criteria and evidence.

```json
{
  "title": "Short task title",
  "request": "The original user request, with scope and constraints.",
  "status": "in-progress",
  "summary": "Current outcome, including what is not done.",
  "ask": "None, or the exact decision/prerequisite needed.",
  "workspace": "/absolute/path/to/checkout",
  "pr": "https://github.com/owner/repo/pull/123",
  "criteria": [
    {
      "id": "AC1",
      "text": "Observable, measurable acceptance criterion.",
      "result": "not-verified",
      "evidence": []
    }
  ],
  "evidence": [],
  "decisions": [],
  "stages": [],
  "checks": [],
  "activity": [],
  "deviations": [],
  "limitations": []
}
```

- `status`: `in-progress`, `complete`, `blocked`, `needs-decision`, `cancelled`.
- Criterion `result`: `pass`, `fail`, `not-verified`.
- Criterion `evidence`: evidence IDs, not file paths.
- `decisions`, `activity`, `deviations`, `limitations`: arrays of nonempty text.
  Decisions include alternatives and rationale. Activity includes timestamps,
  progress, recovery actions and external effects. Deviations quote the user's
  authorization. Limitations include anything untested or unresolved.

## Evidence

```json
{
  "id": "E1",
  "file": "evidence/after.png",
  "caption": "Actual result, what it shows and which criterion it proves."
}
```

Files must exist, be nonempty and resolve inside the artifact folder (including
symlink resolution). Use relative `/`-separated paths. Images (`png`, `jpg`,
`jpeg`, `gif`, `webp`, `svg`) and video (`mp4`, `webm`) are displayed inline;
other evidence such as real `.txt`, `.log`, `.json` or `.md` output is linked.
Keep captions meaningful; the existence of a file is not proof of its claim.
Do not include sensitive output. Keep superseded evidence with honest captions,
but point passing criteria only at evidence for the current revision.

## Phase history

Append a stage for each iteration of `plan`, `execute` or `verify`. Iterations
increase per phase. Keep old iterations; the latest one is the current gate.
Re-open dependent phases as new iterations immediately when their approval
becomes stale; do not leave old approval looking current.

```json
{
  "phase": "plan",
  "iteration": 1,
  "summary": "What this phase produced.",
  "details": "Full plan, implementation output or verification report.",
  "reviewers": ["architecture", "security", "tests"],
  "reviews": [
    {
      "reviewer": "architecture",
      "round": 1,
      "verdict": "changes",
      "details": "Full original reviewer response, checks, citations and rebuttals.",
      "findings": [
        {
          "id": "architecture-1",
          "severity": "blocking",
          "status": "open",
          "detail": "Concrete concern and required correction.",
          "response": "Engineer response, or Pending."
        }
      ]
    }
  ]
}
```

- `verdict`: `approve`, `changes`, `blocked`.
- `reviewers`: the assigned focuses for this gate, declared before launching
  agents. Every assigned reviewer must return approval; a missing result cannot
  disappear from the gate. Defaults are architecture/security/tests for plan,
  architecture/security/code/tests for execute, and tests for verify.
- Finding `severity`: `blocking`, `non-blocking`; `status`: `open`, `resolved`.
- Append every response and round. Within an iteration, each reviewer's rounds
  strictly increase. Repeat prior findings with the same ID and updated
  resolution in later reviews, so their disposition remains checkable.
- An approval with an open blocking finding is invalid.
- When a revision changes the underlying work, start a new iteration and get
  fresh approvals from all assigned reviewers. Do not mix approvals of different
  revisions. Include prior history in replacement reviewers' assignments.
- For an explicitly authorized skip, add `reviewWaiver` with the user's exact
  authorization and reason; never invent a waiver to get validation to pass.
  Preserve any existing reviews and objections.

## Checks

```json
{
  "command": "node --test tests/changed.test.mjs",
  "cwd": "/absolute/path/to/checkout",
  "result": "pass",
  "output": "Exact exit status and useful real output; reference a saved transcript."
}
```

Check `result`: `pass`, `fail`, `not-run`. Keep failed attempts, identifying
later retries by the same command and working directory. Save full transcripts
as evidence if too long for the check summary. Do not relabel old failures.

## Completion

A `complete` record requires:

- nonempty acceptance criteria, each passing with existing referenced evidence;
- a current iteration for all three phases, each with unanimous latest approval
  from its recorded reviewers, or an explicit `reviewWaiver`;
- no latest failed or unrun check for any recorded command/working-directory
  pair (old failed attempts remain visible).

The renderer validates structure and these consistency rules, not the truth
of prose, the choice of the assigned team or the quality of evidence.
Independent reviewers must establish those facts. The engineer must not call
an incomplete or unreviewed result complete.
