// The look of the task report: a piece of explanatory journalism about one engineering task. It follows the
// design standards in .github/skills/engineer-report-design/SKILL.md (drawn from New York Times interactive
// articles and The Markup's "Show Your Work" series), and tests/report.test.mjs enforces the mechanical ones:
// every colour and typeface is a token declared once in :root, type sizes come from one scale, and there are
// no cards, shadows, rounded corners or motion.
// Fonts are embedded and nothing is fetched, so the page works from disk under its own content security policy.
import { promises as fs } from 'node:fs';

// Latin subsets of the two embedded families (SIL Open Font License; see assets/fonts/OFL-*.txt).
const FONTS = [
  { family: 'Newsreader', style: 'normal', weight: '300 700', file: 'newsreader-latin.woff2' },
  { family: 'Newsreader', style: 'italic', weight: '300 700', file: 'newsreader-italic-latin.woff2' },
  { family: 'Libre Franklin', style: 'normal', weight: '400 700', file: 'libre-franklin-latin.woff2' },
];

export async function loadFonts() {
  return Promise.all(FONTS.map(async (font) => ({
    ...font, data: (await fs.readFile(new URL(`../assets/fonts/${font.file}`, import.meta.url))).toString('base64'),
  })));
}

const fontFace = (font) => `@font-face { font-family: "${font.family}"; font-style: ${font.style}; font-weight: ${font.weight}; font-display: swap; src: url(data:font/woff2;base64,${font.data}) format("woff2"); }`;

// Without embedded fonts (a direct renderReport call) the same stacks fall back to system serif and sans.
export function reportCss({ fonts = [] } = {}) {
  return `${fonts.map(fontFace).join('\n')}
:root {
  color-scheme: light dark;
  --page: #ffffff; --wash: #f7f7f5; --ink: #121212; --text: #333333; --muted: #5a5a5a; --faint: #707070; --rule: #dfdfdf;
  --link: #326891; --pass: #4f7a0a; --fail: #b10d14; --wait: #9a5b00; --marker: #ffe98a; --scrim: rgba(255, 255, 255, .97);
  --serif: "Newsreader", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: "Libre Franklin", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  --col: 960px; --wide: 1280px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #121212; --wash: #1c1c1c; --ink: #f5f5f5; --text: #d4d4d4; --muted: #a8a8a8; --faint: #8f8f8f; --rule: #383838;
    --link: #8fbde0; --pass: #9fcf5a; --fail: #ff8f8a; --wait: #e6b450; --marker: #5c4d00; --scrim: rgba(18, 18, 18, .97);
  }
}
* { box-sizing: border-box; }
html { scroll-padding-top: 56px; background: var(--page); }
body { margin: 0; padding-bottom: 72px; background: var(--page); color: var(--text); font: 400 20px/30px var(--serif); -webkit-font-smoothing: antialiased; }
a { color: var(--link); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:focus-visible, summary:focus-visible, pre:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.col { max-width: calc(var(--col) + 48px); margin-left: auto; margin-right: auto; padding-left: 24px; padding-right: 24px; }
.wide { max-width: calc(var(--wide) + 48px); margin-left: auto; margin-right: auto; padding-left: 24px; padding-right: 24px; }
.pass { color: var(--pass); } .fail { color: var(--fail); } .wait { color: var(--wait); } .off { color: var(--faint); }
.state { font-weight: 700; }
code { font-family: var(--mono); font-size: .82em; font-style: normal; overflow-wrap: anywhere; }
pre { margin: 0; padding: 16px 20px; background: var(--wash); border: 1px solid var(--rule); color: var(--ink); font: 400 13px/21px var(--mono); overflow: auto; }
pre code { font-size: inherit; overflow-wrap: normal; }
.kicker { margin: 0; color: var(--ink); font: 700 13px/15px var(--sans); letter-spacing: .04em; text-transform: uppercase; }
.sans { margin: 0; color: var(--muted); font: 400 15px/21px var(--sans); }
.sans b { color: var(--ink); }
.sans b.pass { color: var(--pass); } .sans b.fail { color: var(--fail); } .sans b.wait { color: var(--wait); } .sans b.off { color: var(--faint); }
.empty { color: var(--muted); font: 400 15px/21px var(--sans); }

/* ---- masthead bar and section links ---- */
.bar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; padding: 10px 24px; border-bottom: 1px solid var(--rule); color: var(--ink); font: 500 13px/18px var(--sans); }
.bar .mark { font: 600 24px/28px var(--serif); letter-spacing: -.01em; }
.bar .right { text-align: right; }
nav.sections { position: sticky; top: 0; z-index: 3; display: flex; justify-content: center; gap: 0 22px; padding: 9px 24px; background: var(--page); border-bottom: 1px solid var(--rule); font: 500 13px/18px var(--sans); white-space: nowrap; overflow-x: auto; }
nav.sections a { color: var(--ink); text-decoration: none; }
nav.sections a:hover { text-decoration: underline; }

/* ---- headline ---- */
.head { max-width: calc(var(--col) + 48px); margin: 0 auto; padding: 64px 24px 0; text-align: center; }
h1 { margin: 14px 0 18px; color: var(--ink); font: 500 58px/60px var(--serif); letter-spacing: -.012em; overflow-wrap: anywhere; }
.deck { max-width: var(--col); margin: 0 auto; font: 300 24px/32px var(--serif); }
.byline { margin: 26px 0 0; font: 700 15px/20px var(--sans); }
.byline span { font-weight: 400; }
.time { margin: 4px 0 0; color: var(--muted); font: 500 13px/18px var(--sans); }

/* ---- your move ---- */
.move { margin-top: 44px; }
.move .inner { padding: 18px 0 20px; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); }
.ask { margin: 10px 0 8px; color: var(--ink); font: 400 27px/36px var(--serif); overflow-wrap: anywhere; }
.ask p { margin: 0 0 12px; }
.ask > :last-child { margin-bottom: 0; }
/* The engineer's own emphasis in the ask is drawn as a highlighter stroke. */
.ask strong { font-weight: 600; text-decoration: underline; text-decoration-color: var(--marker); text-decoration-thickness: .42em; text-underline-offset: -.24em; text-decoration-skip-ink: none; }

/* ---- the numbers ---- */
.numbers { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); margin-top: 48px; }
.numbers > div { padding: 0 24px; border-left: 1px solid var(--rule); }
.numbers > div:first-child { padding-left: 0; border-left: 0; }
.numbers .n { color: var(--ink); font: 500 62px/62px var(--serif); font-variant-numeric: lining-nums; letter-spacing: -.02em; }
.numbers .n small { color: var(--muted); font-size: 30px; font-weight: 400; letter-spacing: 0; }
.numbers .l { margin-top: 10px; color: var(--ink); font: 700 14px/18px var(--sans); }
.numbers .s { margin-top: 3px; color: var(--muted); font: 400 14px/19px var(--sans); }
.numbers a { color: inherit; text-decoration: none; }
.numbers a:hover { text-decoration: underline; }

/* ---- sections ---- */
.lede { margin-top: 52px; }
section > h2 { max-width: calc(var(--col) + 48px); margin: 56px auto 18px; padding: 0 24px; color: var(--ink); font: 700 30px/34px var(--sans); letter-spacing: -.01em; }
h3 { margin: 44px 0 0; color: var(--ink); font: 700 20px/26px var(--sans); }

/* ---- findings: a criterion stated, then the evidence that shows it ---- */
.finding { margin-top: 44px; }
h2 + .finding { margin-top: 26px; }
.statement { margin: 8px 0 0; font: 400 27px/36px var(--serif); overflow-wrap: anywhere; }
.statement strong { font-weight: 700; }
.statement.is-pass strong { color: var(--pass); } .statement.is-fail strong { color: var(--fail); } .statement.is-wait strong { color: var(--wait); }
.statement code { white-space: nowrap; }
.criterion, h2 + .criterion { margin-top: 0; }
.criterion > .criterion-summary { padding-top: 16px; padding-bottom: 16px; border-top: 1px solid var(--rule); }
.criterion-row { display: inline-grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; width: calc(100% - 16px); vertical-align: -2px; }
.criterion-result { font: 700 13px/30px var(--sans); }
.criterion-row .statement { margin: 0; font: 400 20px/30px var(--serif); }
.criterion-row code { white-space: normal; }
.criterion[open] { padding-bottom: 26px; }
.also { margin: 14px 0 0; }
figure { margin: 22px auto 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 22px 16px; align-items: start; margin-top: 26px; }
.grid figure { margin: 0; min-width: 0; }
.frame { display: block; }
a.frame { cursor: zoom-in; }
.frame img { display: block; max-width: 100%; max-height: 640px; width: auto; height: auto; margin: 0 auto; border: 1px solid var(--rule); }
.frame video { display: block; width: 100%; max-height: 640px; background: var(--wash); border: 1px solid var(--rule); }
.frame pre { max-height: 420px; white-space: pre; }
.frame.file { padding: 22px 20px; background: var(--wash); border: 1px solid var(--rule); color: var(--muted); font: 400 15px/21px var(--sans); }
.cut { margin: 0; padding: 8px 20px; border: 1px solid var(--rule); border-top: 0; color: var(--wait); font: 500 13px/18px var(--sans); }
figcaption { max-width: var(--col); margin: 12px auto 0; color: var(--text); font: 500 16px/22px var(--sans); overflow-wrap: anywhere; }
.grid figcaption { margin-left: 0; font: 500 15px/21px var(--sans); }
.credit { display: block; margin-top: 4px; color: var(--faint); font: 500 13px/17px var(--sans); }
.credit a { color: inherit; }

/* enlarge an image without script: :target */
.lightbox { display: none; position: fixed; inset: 0; z-index: 10; grid-template-rows: 1fr auto; gap: 12px; padding: 4vh 4vw; background: var(--scrim); }
.lightbox:target { display: grid; }
.lightbox img { max-width: 100%; max-height: 82vh; margin: auto; object-fit: contain; border: 1px solid var(--rule); }
.lightbox p { margin: 0; color: var(--ink); font: 500 16px/22px var(--sans); text-align: center; }
.lightbox .close { position: absolute; inset: 0; z-index: -1; cursor: zoom-out; }
.lightbox .x { position: absolute; top: 16px; right: 24px; color: var(--ink); font: 700 13px/18px var(--sans); }

/* ---- decisions ---- */
.decision { padding: 18px 0 20px; border-top: 1px solid var(--rule); }
.decision:first-of-type { padding-top: 0; border-top: 0; }
.decision .doc { margin-top: 8px; }

/* ---- tables ---- */
.table { overflow-x: auto; }
.sans + .table { margin-top: 16px; }
table { width: 100%; border-collapse: collapse; color: var(--text); font: 400 15px/20px var(--sans); }
th { padding: 0 16px 8px 0; border-bottom: 1px solid var(--ink); color: var(--ink); font: 700 12px/15px var(--sans); letter-spacing: .04em; text-align: left; text-transform: uppercase; }
td { padding: 11px 16px 11px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
.gates td:first-child { font-weight: 700; white-space: nowrap; }
.gates td:first-child a { color: var(--ink); }

/* ---- objections and other quoted findings ---- */
.objection { margin: 26px 0 0; padding: 2px 0 2px 20px; border-left: 3px solid var(--rule); }
.objection.open { border-left-color: var(--fail); }
.objection .q { color: var(--ink); font: italic 400 22px/31px var(--serif); }
.objection .q p { margin-bottom: 10px; }
.objection .who { margin: 8px 0 0; }
.objection .reply { margin: 6px 0 0; }
.reply > b, .entry > b { float: left; margin-right: .35em; color: var(--ink); font-weight: 700; }
.reply .doc p, .entry .doc p { margin-bottom: 8px; }

/* ---- the full record of each phase, folded ---- */
details { margin-top: 12px; }
summary { color: var(--ink); cursor: pointer; font: 700 14px/20px var(--sans); }
summary span { color: var(--muted); font-weight: 400; }
details[open] > summary { margin-bottom: 14px; }
.records { margin-top: 30px; }
.record { padding: 14px 0; border-top: 1px solid var(--rule); }
.record:last-child { border-bottom: 1px solid var(--rule); }
.record > details { margin-top: 0; }
.record h4 { margin: 26px 0 8px; color: var(--ink); font: 700 16px/22px var(--sans); }
.record .doc, .attempts .doc { font-size: 18px; line-height: 28px; }
.record .reply .doc { font-size: 15px; line-height: 21px; }
.review { margin-top: 26px; }
.review > .sans { margin-bottom: 6px; }
.record .objection .q { font-style: normal; }

/* ---- checks ---- */
.check + .check { margin-top: 30px; }
.cmd { margin: 0 0 2px; color: var(--ink); font: 500 14px/20px var(--mono); overflow-wrap: anywhere; }
.cmd .state { margin-right: 8px; font: 700 13px/20px var(--sans); }
.check pre { max-height: 340px; margin-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.attempts { margin: 0; padding: 0 0 0 20px; border-left: 1px solid var(--rule); list-style: none; }
.attempts li + li { margin-top: 22px; }

/* ---- activity ---- */
.log { margin: 0; padding: 0; list-style: none; color: var(--text); font: 400 15px/21px var(--sans); }
.log li { display: grid; grid-template-columns: 148px minmax(0, 1fr); column-gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--rule); overflow-wrap: anywhere; }
.log li:first-child { border-top: 1px solid var(--ink); }
.log time { color: var(--muted); font-variant-numeric: tabular-nums; }

/* ---- documents: what the engineer and reviewers wrote ---- */
.doc { overflow-wrap: anywhere; }
.doc > :first-child { margin-top: 0; }
.doc > :last-child { margin-bottom: 0; }
.doc p { margin: 0 0 20px; }
.doc h3, .doc h4, .doc h5, .doc h6 { margin: 30px 0 10px; color: var(--ink); font-family: var(--sans); font-style: normal; font-weight: 700; }
.doc h3 { font-size: 22px; line-height: 28px; } .doc h4 { font-size: 18px; line-height: 24px; } .doc h5, .doc h6 { font-size: 15px; line-height: 20px; }
.doc ul, .doc ol { margin: 0 0 20px; padding-left: 26px; }
.doc ul { list-style: disc; } .doc ul ul { list-style: circle; } .doc ol { list-style: decimal; }
.doc li > ul, .doc li > ol { margin: 4px 0 0; }
.doc li + li { margin-top: 4px; }
.doc li.task { margin-left: -26px; list-style: none; }
.doc pre, .doc .table { margin: 0 0 20px; }
.doc hr { margin: 24px 0; border: 0; border-top: 1px solid var(--rule); }
.doc blockquote { margin: 0 0 20px; padding-left: 20px; border-left: 3px solid var(--rule); color: var(--muted); }

/* ---- limitations, deviations and where the record lives ---- */
.notes { margin-top: 56px; }
.notes .inner { padding-top: 14px; border-top: 1px solid var(--rule); }
.entry { margin: 0 0 10px; color: var(--text); font: 400 15px/21px var(--sans); }
.entry.wait > b { color: var(--wait); }

@media (max-width: 720px) {
  body { font-size: 18px; line-height: 28px; }
  .bar { grid-template-columns: auto 1fr; }
  .bar .left { display: none; }
  nav.sections { justify-content: flex-start; }
  .head { padding-top: 36px; }
  h1 { font-size: 38px; line-height: 42px; }
  .deck { font-size: 20px; line-height: 28px; }
  .ask, .statement { font-size: 22px; line-height: 30px; }
  .criterion-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .criterion-row .statement { font-size: 18px; line-height: 28px; }
  .numbers { grid-template-columns: 1fr 1fr; row-gap: 26px; }
  .numbers > div { padding: 0 0 0 16px; }
  .numbers > div:nth-child(odd) { padding-left: 0; border-left: 0; }
  .numbers .n { font-size: 44px; line-height: 44px; }
  .numbers .n small { font-size: 22px; }
  section > h2 { font-size: 24px; line-height: 28px; }
  .log li { grid-template-columns: minmax(0, 1fr); }
}
@media print {
  body { padding: 0; }
  nav.sections, .lightbox { display: none; }
  section > h2 { break-after: avoid; }
  figure { break-inside: avoid; }
  pre, .frame pre, .check pre { max-height: none; }
}
`;
}
