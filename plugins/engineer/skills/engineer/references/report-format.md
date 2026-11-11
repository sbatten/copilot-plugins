# Report format

Keep `report.json`, generated `report.html` and evidence in the same persistent,
task-specific artifact folder. The renderer uses only Node built-ins and does
not load code, fonts, scripts or styles from the network; its two typefaces are
embedded in each report (about 400 KB, Latin text; other scripts use system
fonts). Preserve full prose and transcripts without summarizing away the phase
or review history.

The report reads like an article: where the work stands, the ask, the numbers
and the summary, then a scannable list of acceptance criteria. Each row shows
the criterion's full text and its Passed, Failed or Not verified result, with
evidence collapsed by default. Click or keyboard-activate a row to inspect
its evidence without losing the criteria overview.

The layout is deliberately wider than a newspaper article: text, tables,
transcripts and phase/review records use up to 960px of content width; visual
evidence and the numbers row use up to 1280px. Both are centred with 24px side
gutters and shrink to fit smaller viewports.

Prose fields (`request`, `summary`, `ask`, criterion text, decisions, stage
`summary`, `details` and `reviewWaiver`, review `details`, finding `detail` and
`response`, activity, deviations and limitations) are rendered as a safe
Markdown subset: headings, lists and task lists, tables, fenced code, quotes,
links, bold, italic and inline code. Use it: a plan with headings and a table
of alternatives reads far better than a wall of text. Raw HTML is shown as
text. Put command output, diffs and diagrams in fenced code blocks so their
layout survives. One-line fields (criterion text, stage `summary`, activity
entries) take inline formatting only. Relative links resolve against the
artifact folder; use absolute paths for files in the checkout. Titles, IDs,
captions, commands and check output are always shown literally.

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
- `title`: the report's headline. Say what the task was in plain words.
- `summary`: the outcome in a few sentences, as the article's opening. The
  renderer already states where the work stands and shows the numbers
  (criteria passing, evidence, checks, reviews, limitations), so do not repeat
  those.
- `ask`: exactly `None.` when nothing is needed. Anything else is shown before
  everything but the headline, in large type, so make it one precise,
  answerable request. **Bold** the options or the thing you need: bold words
  in the ask are highlighted.
- Criterion `text`: one sentence stating the behavior. **Bold** the phrase that
  states the outcome; it takes the colour of the result (green when the
  criterion passes, red when it fails, amber when it is not verified). This
  human description labels the expandable row; criterion IDs remain internal
  keys for anchors and evidence mapping, not visible row labels.
- Criterion `result`: `pass`, `fail`, `not-verified`.
- Criterion `evidence`: evidence IDs, not file paths, in the order they should
  be shown.
- `decisions`, `activity`, `deviations`, `limitations`: arrays of nonempty text.
  Give each decision its own entry, with the alternatives and rationale. Start
  each activity entry with its date or timestamp (`2026-11-10 18:20: ...`) and
  cover progress, recovery actions and external effects. Deviations quote the
  user's authorization. Limitations include anything untested or unresolved.

## Evidence

```json
{
  "id": "E1",
  "file": "evidence/after.png",
  "caption": "Actual result, what it shows and which criterion it proves."
}
```

Files must exist, be nonempty and resolve inside the artifact folder (including
symlink resolution). Use relative `/`-separated paths. Each item is shown in
full once, inside the expandable row of the first criterion that cites it;
later criteria link back to it, revealing the shared evidence when followed.
Expanding a row shows:

- images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`) inline and enlarged on
  selection; two or more images for one criterion sit side by side, so cite a
  before/after or step-by-step sequence in order;
- video (`mp4`) in an inline player;
- text (`txt`, `log`, `out`, `tap`, `json`, `md`, `csv`, `tsv`, `diff`, `patch`,
  `yaml`, `yml`, `xml`) as an inline preview of the first 64 KB, so a real
  transcript can be read without leaving the report;
- anything else as a link.

Generate video evidence as MP4 with H.264 encoding and `yuv420p` pixel format
for broad playback support. If the capture tool outputs non-MP4,
transcode the recording to MP4 (do not just rename it).

Evidence no criterion cites is shown last, as supporting or superseded.
The caption is printed under the item: say what it shows, not that it exists,
and do not restate the criterion. The existence of a file is not proof of its
claim.
Do not include sensitive output. Keep superseded evidence with honest captions,
but point passing criteria only at evidence for the current revision.

## Phase history

Append a stage for each iteration of `plan`, `execute` or `verify`. Iterations
increase per phase. Keep old iterations; the latest one is the current gate.
Re-open dependent phases as new iterations immediately when their approval
becomes stale; do not leave old approval looking current. The report lists
every iteration in a table (approved, in review, review waived, superseded, or
stale: a current iteration recorded before a newer iteration of an earlier
phase), shows every blocking finding in the open, and folds each iteration's
full output and review rounds beneath.
Keep `summary` to one line; it is the iteration's headline.

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
later retries by the same command and working directory: the report shows the
latest attempt and folds the earlier ones beneath it. `output` is shown
verbatim in a monospace block, not as Markdown. Save full transcripts as
evidence if too long for the check summary. Do not relabel old failures.

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
