---
name: engineer-report-design
description: 'Design standards for the Engineer plugin''s HTML task report: the reference designs it follows, layout, typography, colour, state vocabulary and evidence presentation. Use when changing the report''s markup, stylesheet or embedded fonts, adding a section or state to it, or checking that a report change still follows the reference rather than a default component kit.'
---

# Engineer report design standards

This is a repository-only skill for maintaining the Engineer report's look, not
a skill bundled with the installed plugin. Run commands from the repository
root. The data contract (what goes in `report.json`) is separate: see
`plugins/engineer/skills/engineer/references/report-format.md`.

| What | Where |
| --- | --- |
| Stylesheet, tokens and font embedding | `plugins/engineer/skills/engineer/scripts/report-style.mjs` |
| Page structure and state vocabulary | `plugins/engineer/skills/engineer/scripts/report-view.mjs` |
| Markdown subset for prose | `plugins/engineer/skills/engineer/scripts/report-markdown.mjs` |
| Embedded fonts and their licences | `plugins/engineer/skills/engineer/assets/fonts/` |
| Enforcement | `plugins/engineer/tests/report.test.mjs` ("the stylesheet keeps to the report design standards") |

## The idea

**The report is a piece of explanatory journalism about one engineering task.**
It states what happened, shows the proof beside each claim, and keeps the
apparatus (who reviewed, what ran, what is still uncertain) available without
letting it lead. It was chosen over a dashboard look and a landing-page look
because it does the best job of delivering information while still being
pleasant to read.

## The references

These standards start from existing designs, not from first principles. When a
question is not answered below, look at the references and do what they do.

- **New York Times interactive articles** (for example "How Decades of Racist
  Housing Policy Left Neighborhoods Sweltering", 2020, and "How George Floyd
  Was Killed in Police Custody", 2020). They set the page: a centred serif
  headline and deck, a narrow serif text column, wide graphics, and short
  **statements in larger type with the key phrase in the graphic's colour**,
  each followed by the graphic that shows it.
- **The Markup, "Show Your Work"**. A newsroom's methodology articles ("How we
  tested…"): the same kind of document as this report. It confirms a serif
  body with sans-serif labels, ruled structure, and methodology and
  limitations stated plainly at the end.

Values measured on those pages, and what the report uses:

| Role | Reference | Report |
| --- | --- | --- |
| Headline | NYT Cheltenham 55/56, weight 500, `#121212` | Newsreader 58/60, weight 500 |
| Deck | NYT Cheltenham 23/30, weight 300 | Newsreader 24/32, weight 300 |
| Body | NYT Imperial 20/30, `#333`, 600px column (The Markup: 18/30.6, 620px) | Newsreader 20/30, up to 960px column |
| Criterion statement | NYT Cheltenham 24/36 before a graphic, key phrase bold and coloured | Newsreader 20/30 in a disclosure row (18/28 on small screens), same emphasis |
| Section heading | NYT Franklin 30/34, weight 700 | Libre Franklin 30/34, weight 700 |
| Byline | NYT Franklin 15/20, weight 700 | Libre Franklin 15/20, weight 700 |
| Caption | NYT Franklin 16/22, weight 500, `#333` | Libre Franklin 16/22, weight 500 |
| Credit | NYT Franklin 13/17, `#999` | Libre Franklin 13/17, `#707070` |
| Kicker | NYT Franklin 13/15, weight 700, uppercase | same, tracked .04em |
| Link | NYT blue, underlined (colour matched to the capture, not measured) | `#326891`, underlined |

Newsreader stands in for Cheltenham and Imperial, and Libre Franklin for
Franklin; both are open (SIL OFL) and are embedded in every report.

Deliberate departures from the references:

- The report is wider than a newspaper article: narrative, tables and phase
  records use up to 960px; images, recordings and the numbers row use up to
  1280px. Engineering plans and evidence need more room than a narrow reading
  column provides.
- Criteria are a compact, scannable list of native disclosure rows, with
  evidence collapsed by default rather than interleaved into the initial view.
  Readers can survey every outcome before inspecting its proof.
- Credits and other faint text are darker than the Times' `#999`, to keep
  4.5:1 contrast.
- There is a dark scheme, because reports are often opened inside a dark
  editor.
- There is no brand accent (The Markup's pink). The only colours beyond ink
  and the link blue are the three state colours.
- Section links stay pinned under the masthead, because a report is consulted,
  not only read once.

## Standards

Each standard has a reason. If a change needs to break one, change the
standard here (and its test) in the same commit; do not work around it.

### 1. A claim, then the evidence that shows it

- Order: status, headline and where the work stands; the engineer's request,
  if any; the numbers; the summary; then **each acceptance criterion as a
  expandable row with its evidence inside**; decisions; reviews; checks; the
  request; activity; limitations.
- Evidence is shown in full once, under the first criterion that cites it.
  Later criteria link back to it. Evidence no criterion cites comes last,
  labelled as supporting or superseded.
- Each criterion's full readable statement and explicit Passed / Failed /
  Not verified result remain visible in its summary. Evidence starts collapsed;
  clicking or keyboard-activating the summary expands it. Long statements wrap
  rather than truncate, with the result below the statement on small screens.
  IDs are internal keys for anchors and evidence mapping, not visible labels;
  related-criterion references use their human descriptions. Disclosure markers
  inherit the same small sans-serif summary styling as the phase records,
  not the larger serif statement styling. Optically align them with the
  statement's first line, not the entire multi-line row: the inline grid sits
  2px below the shared baseline to lift the smaller sans-serif marker relative
  to the serif text.
  Keep native disclosure semantics and ensure fragment links to shared evidence
  reveal their target inside a collapsed criterion.
- Text, the headline and deck, tables, transcripts and folded phase/review
  records use up to 960px of content width. Images, recordings and the numbers
  row use up to 1280px. Both measures are centred, with 24px side gutters,
  and shrink to the available viewport width; do not restore a narrower
  article column inside them.
- Whole phase outputs and review rounds are folded; the review table and every
  blocking finding are not.

*Why:* the reader can scan the entire criteria set without scrolling through
proof, then inspect any claim in place. Failures and unverified outcomes remain
visible while their evidence is collapsed; blocking review findings stay open.

### 2. Three typefaces, each with a job

- **Serif** (`--serif`, Newsreader): the narrative. Headline, deck, statements,
  the ask, body text, the large numbers and quoted objections.
- **Sans** (`--sans`, Libre Franklin): the apparatus. Kickers, section
  headings, bylines, labels, captions, credits, tables, notes and state words.
- **Mono** (`--mono`, system): code, commands, paths in output, and verbatim
  output.
- Sizes come from one scale: 12, 13, 14, 15, 16, 18, 20, 22, 24, 27, 30, 38,
  44, 58, 62. (38 and 44 are the small-screen headline and numbers.)
- Uppercase is for kickers and table headers only, tracked .04em.
- Inline code is mono at .82em with no background.

### 3. Colour is ink, one link colour, and state

- The page is `--page`; text is `--ink`, `--text`, `--muted` and `--faint`;
  lines are `--rule`; links are `--link`.
- `--pass`, `--fail` and `--wait` colour **state words, the state word in a
  number's label, and the bold phrase of a criterion statement**. Nothing else.
- `--marker` draws a highlighter stroke under bold words **in the ask only**.
- Fills are limited to `--page`, `--wash` (behind verbatim output) and
  `--scrim` (the image viewer).
- Every colour is a token declared once in `:root`, with a dark value. No
  colour literals elsewhere.
- Every text token keeps at least 4.5:1 contrast on `--page` and `--wash` in
  both schemes; ink on the marker keeps 7:1.

### 4. States are words

Every state is a word from a fixed vocabulary, in one of four tones. Never a
glyph, icon or colour alone.

| Tone | Used for |
| --- | --- |
| `pass` | Complete, Passed, Approved, approve, Resolved |
| `fail` | Failed, changes, Open (a blocking finding on a current iteration) |
| `wait` | Needs your decision, Blocked on you, Not verified, Not run, In review, Awaiting review, Review waived, Stale, blocked, Open (non-blocking) |
| `off` | In progress, Cancelled, Superseded, pending, Open when superseded |

Add a new state to the vocabulary maps at the top of `report-view.mjs` and to
this table, not inline.

### 5. The author's emphasis carries meaning

- Bold in the **ask** is highlighted: it marks the options or the thing needed.
- Bold in a **criterion** takes the colour of its result: it marks the outcome.
- Italic serif is for quoted blocking findings.
- Elsewhere bold and italic are ordinary emphasis.

*Why:* this is the Times' colour-keyed phrase, driven by what the engineer
wrote, so the renderer never has to guess which words matter.

### 6. Evidence is shown as captured

- Never upscaled, cropped or restyled; a hairline border separates it from the
  page. Two or more images for one criterion sit side by side.
- The caption says what the item shows. The credit line beneath gives its ID,
  its file, and any other criteria that cite it.
- After expanding a criterion, images enlarge in place and transcripts are
  previewed in the text column. Shared-evidence links reveal the owning
  criterion; returning from the image viewer must still reveal the image.

### 7. Rules, not boxes

- No cards, rounded corners, shadows, gradients, opacity or motion.
- Structure comes from space and hairlines. A 2px ink rule opens the ask; a
  1px ink rule opens a table; a 3px rule at the left marks a quoted finding,
  and is red only while a blocking finding on a current iteration is open.
- Only verbatim output (transcripts, check output, fenced code) sits on a
  wash with a border.
- No icons or illustrations.

### 8. It works as a file

- No scripts, nothing fetched, strict content security policy
  (`font-src data:` for the embedded fonts).
- Fonts are Latin subsets; other scripts fall back to system fonts.
- Light and dark from the same tokens; print drops the section links and lets
  output run to its full length.
- Keyboard focus is always visible; images have alternative text; states do
  not depend on colour.

## Changing the fonts

The font files are the Latin subsets served by Google Fonts for
`Newsreader:ital,opsz,wght@0,6..72,300..700;1,6..72,300..700` and
`Libre Franklin:wght@400..700`. To change them, replace the `.woff2` files,
update the `FONTS` list in `report-style.mjs`, and keep each family's
`OFL-*.txt` beside them. They add about 400 KB to every report, so add a
family or a script subset only with a reason.

## Checking a change

1. Run the tests; one enforces standards 2, 3 and 7 mechanically (tokens only,
   three typefaces, the type scale, permitted fills, no forbidden properties,
   contrast):

   ```sh
   node --test plugins/engineer/tests/*.test.mjs
   ```

2. Render a report with evidence, a failed-then-passed check, a multi-round
   review and an ask, and **look at it**: light, dark, and 400px wide.
   At a 1440px viewport, verify 960px text and 1280px evidence content widths;
   at 400px, verify 24px gutters and no page-level horizontal overflow.
   Include ten mixed-result criteria: verify all statements and results are
   visible with evidence collapsed, keyboard expansion works, and links to
   shared evidence and back from the image viewer reveal their targets.
3. Ask of anything new: what do the references do here? If they have no
   answer and a new size, colour, fill or typeface seems necessary, that is a
   change to these standards, not to one section.
