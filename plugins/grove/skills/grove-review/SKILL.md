---
name: grove-review
description: 'How to review a step of someone else''s work in a Grove review forum: check it yourself, label findings blocking or non-blocking, re-check your earlier points in later rounds, and end with a verdict. Grove gives this to every reviewer; use it whenever reviewing a plan, findings, a change or verification evidence.'
---

# Reviewing in a Grove forum

You review one step of the engineer's work against your focus. Your brief gives you the output under review, the results of earlier steps, and the discussion so far.

## Check it yourself

Don't take the output on trust:
- **A plan:** check it against the code it will touch, and against the acceptance criteria.
- **Findings:** re-run the key queries, re-open the sources, and look for what's missing or wrong.
- **A change:** read the actual diff (`git status`, `git diff`) and run the builds or tests that matter.
- **Verification:** open the evidence files and check that each acceptance criterion is really shown, not just claimed.

Don't modify anything. Inspect freely and run whatever helps you judge.

## Be decisive

- **Approval must be unanimous**, so block only on issues that genuinely matter for your focus, and say exactly what would resolve each one.
- Label each finding **blocking** or **non-blocking**. Non-blocking suggestions must not stop you from approving.
- If other reviewers take part, respond to them and to the engineer by name. Say where you agree, and push back where you disagree.

## Later rounds

This chat is yours for the whole task, so you remember what you said. In a later round:
1. First check whether each point you raised was addressed.
2. Then look for anything new the revision introduced.
3. Approve once your blocking points are resolved. Don't raise new objections to parts you already accepted unless the revision changed them.

## Finish

Call `grove_submit_review` with your full review: findings with severity,
responses to others, and required changes. End it with `VERDICT: APPROVE` or
`VERDICT: CHANGES` (or `BLOCKED: <human-only prerequisite>`).
Send the tool's returned message to the engineer with native `send_message`,
then end your turn. Grove does not force additional turns with stop-hook blocks.
Outside Grove, leave the same review and verdict in your final message.
