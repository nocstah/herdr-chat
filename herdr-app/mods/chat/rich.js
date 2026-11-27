// Rich content (visual-v2.md §3): an assistant message's blocks (markdown,
// highlighted code cards, mermaid diagrams, pictures), diffs with a line-number
// gutter, highlighted file excerpts and ANSI-colored command output.
// The host splits and highlights (protocol.md v2 `Block`, `syn:` spans);
// without blocks a message is one markdown block, as in v1.

import { div, image } from "gpui-kit";
import { appHome } from "herdr";
import { v_flex, h_flex, TextView } from "gpui-base";
import { alpha, codeLine, homeRel, icon, monoFont, plural, spinner } from "./util.js";
import { SPACE } from "./space.js";
import { linkPaths } from "./paths.js";
import { oneLine, runsInCode } from "./bang.js";
import { decorateInlineCode, findMatchRanges, flavorPalette, inlineCodeRanges, mdChunks, parseInlineSpans, picturesAsLinks, stripHeading } from "./flavor.js";

export { mdChunks };

export const CODE_CAP = 30; // lines shown before "Show all N lines"
const RENDER_MAX = 600; // lines ever built for one block (the rest: copy it)
export const LINE_H = 19;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;

// `onLink` (an answer's prose): its file paths become links (linkPaths), and
// every link's click goes to it instead of straight to the system. On Herdr 0.1.18+
// (`highlight_range` + `raw_html`), standalone inline code spans and active Find
// matches paint natively with `highlight_range()` while `.raw_html(false)` keeps raw
// HTML tags literal and `selection.range` aligned with Markdown source.
/** @typedef {(url: string, cx: import("gpui-kit").Context) => void} OnLink */
/** @typedef {(viewId: string, sel: any, source: string, cx: import("gpui-kit").Context) => void} OnSelect */
/**
 * @param {string} id
 * @param {string} text
 * @param {OnLink} [onLink]
 * @param {{ t?: any, codeTint?: boolean, onSelect?: OnSelect | null, findQuery?: string | null, findColor?: string | null }} [opts]
 */
export const prose = (id, text, onLink, opts) => {
  const base = onLink ? linkPaths(text) : text;
  const wantTint = Boolean(opts?.t && opts.codeTint !== false);
  const codeBg = wantTint ? flavorPalette(opts.t).codeBg : null;
  let view = TextView.markdown(id, base).selectable(true);
  const nativeHighlight = typeof view.highlight_range === "function";
  if (nativeHighlight) {
    if (typeof view.raw_html === "function") view = view.raw_html(false);
    if (codeBg) {
      for (const r of inlineCodeRanges(base)) view = view.highlight_range(r.start, r.end, codeBg);
    }
    if (opts?.findQuery && opts?.findColor) {
      for (const r of findMatchRanges(base, opts.findQuery)) view = view.highlight_range(r.start, r.end, opts.findColor);
    }
  } else if (codeBg) {
    view = TextView.markdown(id, decorateInlineCode(base, codeBg)).selectable(true);
  }
  if (opts?.onSelect && typeof view.on_selection_change === "function") {
    const onSelect = opts.onSelect;
    view = view.on_selection_change((sel, cx) => onSelect(id, sel, base, cx));
  }
  return onLink ? view.on_link_click(onLink) : view;
};

// The space above a piece of an answer, after `prev` (null: the first).
const above = (heading, prev) => (prev == null ? 0 : heading ? SPACE.headingAbove : prev.heading ? SPACE.headingBelow : SPACE.block);

function renderList(id, items, onLink, t, f, opts) {
  const maxOrd = items.reduce((m, it) => (it.ordered ? Math.max(m, it.marker.length) : m), 0);
  const numW = Math.max(20, maxOrd * 8 + 6);
  const bulletOf = (depth) => (depth === 0 ? ["•", f.bullet] : depth === 1 ? ["◦", f.bulletSub] : ["▪", f.bulletDeep]);
  return v_flex().min_w(0).gap(4).children(items.map((it, idx) => {
    const padL = it.depth * 18;
    let lead;
    if (it.checked !== null) {
      lead = div().flex_none().w(20).pt(4).flex().justify_center()
        .child(icon(it.checked ? "circle-check" : "circle", 13).text_color(it.checked ? f.check : t?.dim));
    } else if (it.ordered) {
      lead = div().flex_none().min_w(numW).pr(6).text_right().font_medium().text_color(f.ordered).child(it.marker);
    } else {
      const [glyph, col] = bulletOf(it.depth);
      lead = div().flex_none().w(18).pr(6).text_right().font_semibold().text_color(col).child(glyph);
    }
    const body = div().flex_1().min_w(0).when(it.checked === true, (e) => e.text_color(t?.muted))
      .child(prose(`${id}-li-${idx}`, it.text || " ", onLink, { ...opts, t }));
    return h_flex().min_w(0).items_start().when(padL > 0, (e) => e.pl(padL)).child(lead).child(body);
  }));
}

const HEADING_STYLE = [
  null,
  { size: 22, lh: "28px" },
  { size: 18, lh: "24px" },
  { size: 15.5, lh: "21px" },
  { size: 14, lh: "20px" },
  { size: 13.5, lh: "19px" },
  { size: 13, lh: "19px" },
];

// Native colored inline line for headings and table headers: gpui-shell's TextView.markdown
// pins its style to Theme::global(cx) and resets foreground to theme.foreground, so we render
// single-line colored headers directly with GPUI spans while keeping inline code pills, emphasis
// and clickable links working.
function styledInline(id, text, color, onLink, t, f, { size = 14, lh = "20px", align = "left" } = {}) {
  const src = onLink ? linkPaths(text) : text;
  const runs = parseInlineSpans(src);
  const plain = runs.length === 1 && !runs[0].code && !runs[0].url && !runs[0].italic && !runs[0].strike;
  if (plain) {
    return div().w_full().min_w(0).whitespace_normal().text_size(size).line_height(lh).font_semibold().text_color(color)
      .when(align === "right", (e) => e.text_right())
      .when(align === "center", (e) => e.text_center())
      .child(runs[0].text || " ");
  }
  const mono = monoFont();
  const codeSize = Math.max(11.5, Math.round(size * 0.86 * 10) / 10);
  const parts = [];
  let seq = 0;
  for (const r of runs) {
    const styleEl = (el) => el
      .when(Boolean(r.bold), (e) => e.font_bold())
      .when(Boolean(r.italic), (e) => e.italic())
      .when(Boolean(r.strike), (e) => e.line_through());
    if (r.code) {
      const pill = styleEl(div().flex_none().font_family(mono).text_size(codeSize).px(4).rounded(4).bg(f.codeBg)
        .text_color(r.url ? t.accent ?? color : color))
        .child(r.text);
      if (r.url) {
        const url = r.url;
        parts.push(pill.id(`${id}-sp-${seq++}`).cursor_pointer().hover((s) => s.text_decoration_1())
          .on_click((_e, cx) => (onLink ? onLink(url, cx) : cx.open_url(url))));
      } else {
        parts.push(pill);
      }
      continue;
    }
    if (r.url) {
      const url = r.url;
      for (const word of r.text.match(/\s+|\S+\s*/g) ?? [r.text]) {
        parts.push(styleEl(div().id(`${id}-sp-${seq++}`).flex_none().text_color(t.accent ?? color).cursor_pointer()
          .hover((s) => s.text_decoration_1())
          .on_click((_e, cx) => (onLink ? onLink(url, cx) : cx.open_url(url))))
          .child(word));
      }
      continue;
    }
    for (const word of r.text.match(/\s+|\S+\s*/g) ?? [r.text]) {
      parts.push(styleEl(div().flex_none()).child(word));
    }
  }
  return h_flex().w_full().min_w(0).flex_wrap().items_center().text_size(size).line_height(lh).font_semibold().text_color(color)
    .when(align === "right", (e) => e.justify_end())
    .when(align === "center", (e) => e.justify_center())
    .children(parts);
}

function renderTable(id, chunk, onLink, t, f, opts) {
  // Very wide tables (6+ cols) fall back to native TextView table column measurement.
  if (chunk.headers.length > 5) return prose(id, chunk.text, onLink, { ...opts, t });
  const alignCell = (el, a) => (a === "right" ? el.justify_end() : a === "center" ? el.justify_center() : el);
  const headCell = (cid, txt, a) => alignCell(h_flex().flex_1().min_w(0).px(10).py(6), a)
    .child(div().min_w(0).child(styledInline(cid, txt || " ", f.tableHead, onLink, t, f, { size: 13, lh: "19px", align: a })));
  const cell = (cid, txt, a, cellOpts) => alignCell(h_flex().flex_1().min_w(0).px(10).py(6), a)
    .child(div().min_w(0).child(prose(cid, txt || " ", onLink, cellOpts)));
  const head = h_flex().w_full().bg(f.tableHeadBg).border_b_1().border_color(t?.border).text_size(13).font_semibold().text_color(f.tableHead)
    .children(chunk.headers.map((h, ci) => headCell(`${id}-th-${ci}`, h, chunk.aligns[ci])));
  const body = chunk.rows.map((r, ri) => h_flex().w_full().text_size(13).line_height("20px")
    .when(ri > 0, (e) => e.border_t_1().border_color(alpha(t?.border, 0.55)))
    .when(ri % 2 === 1, (e) => e.bg(f.tableStripe))
    .children(r.map((val, ci) => cell(`${id}-td-${ri}-${ci}`, val, chunk.aligns[ci], { ...opts, t }))));
  return v_flex().w_full().rounded(8).overflow_hidden().border_1().border_color(t?.border).child(head).children(body);
}

function renderChunk(id, p, onLink, t, f, opts) {
  if (!t) return prose(id, p.text, onLink, opts);
  switch (p.kind) {
    case "heading": {
      const level = Math.max(1, Math.min(6, p.level ?? 1));
      const col = f.heading(level);
      const st = HEADING_STYLE[level] ?? HEADING_STYLE[4];
      const title = stripHeading(p.text);
      return div().w_full().min_w(0)
        .when(level === 1, (e) => e.pb(4).border_b_1().border_color(f.h1Rule))
        .child(styledInline(id, title, col, onLink, t, f, st));
    }
    case "hr":
      return div().w_full().py(4).child(div().w_full().h(1).bg(f.hr));
    case "callout": {
      const ca = f.callout(p.alert);
      return v_flex().w_full().min_w(0).gap(4).pl(12).pr(10).py(8).rounded(8)
        .border_l_2().border_color(ca.color).bg(ca.bg)
        .child(h_flex().gap(6).items_center().text_size(12.5).font_semibold().text_color(ca.color)
          .child(icon(ca.icon, 13).text_color(ca.color)).child(ca.label))
        .child(div().min_w(0).child(markdown(`${id}-b`, p.body, onLink, t, opts)));
    }
    case "blockquote":
      return div().w_full().min_w(0).pl(12).pr(10).py(6).rounded_r(8)
        .border_l_2().border_color(f.quoteBar).bg(f.quoteBg)
        .child(markdown(`${id}-q`, p.body, onLink, t, opts));
    case "table":
      return renderTable(id, p, onLink, t, f, opts);
    case "list":
      return renderList(id, p.items, onLink, t, f, opts);
    default:
      return prose(id, p.text, onLink, { ...opts, t });
  }
}

// Markdown as its chunks, spaced (one TextView when it's one plain chunk). `onLink`: prose().
/**
 * @param {string} id
 * @param {string} text
 * @param {OnLink} [onLink]
 * @param {any} [t]
 * @param {{ onSelect?: OnSelect | null, findQuery?: string | null, findColor?: string | null }} [opts]
 */
export function markdown(id, text, onLink, t, opts) {
  const parts = mdChunks(picturesAsLinks(text || " "));
  const f = t ? flavorPalette(t) : null;
  if (parts.length === 1) return renderChunk(id, parts[0], onLink, t, f, opts);
  return v_flex().min_w(0).children(parts.map((p, j) => div().pt(above(p.heading, parts[j - 1])).child(renderChunk(`${id}-${j}`, p, onLink, t, f, opts))));
}

// Whether a block starts or ends with a heading (for the space around it).
function edges(b) {
  if (b.type !== "markdown") return { first: false, last: false };
  const lines = (b.text ?? "").split("\n").filter((l) => l.trim());
  return { first: HEADING.test(lines[0] ?? ""), last: HEADING.test(lines[lines.length - 1] ?? "") };
}

// An assistant message's body.
export function blocks(it, c) {
  const list = it.blocks?.length ? it.blocks : [{ type: "markdown", text: it.text ?? "" }];
  let prev = null;
  return v_flex().min_w(0).children(list.map((b, i) => {
    const key = `${it.id}:${i}`;
    const e = edges(b);
    const gap = above(e.first, prev && { heading: prev.last });
    prev = e;
    let el;
    if (b.type === "code") {
      el = (!b.open && c.codeView?.(key)) || codeCard(key, b.lang, b.code ?? "", b.lines, b.open, c);
      // Its `!` commands (bang.js): a bar under it for each run.
      const runs = c.runBang && !b.open ? runsInCode(b.code ?? "") : [];
      if (runs.length) el = v_flex().min_w(0).gap(6).child(el).children(runs.map((r, j) => runBar(`${key}:${j}`, r, runs.length > 1, c, it.id)));
    }
    else if (b.type === "mermaid") el = mermaid(key, b, c);
    else if (b.type === "image") el = picture(key, b, c);
    else el = c.codeView?.(key) || markdown(`md-${it.id}-${i}`, b.text, c.onLink, c.t, {
      onSelect: c.onSelect ? (vid, sel, src, cx) => c.onSelect(vid, sel, { itemId: it.id, source: src }, cx) : null,
      findQuery: c.findQuery ?? null,
      findColor: c.findColor ?? null,
    });
    return div().pt(gap).child(el);
  }));
}

// A `!` run under its code block: run it in the agent (c.runBang.here names
// it; the terminal view types `!command` into Claude Code, as Ctrl+! does) or
// in a new tab of the space. A run of several runs them in order, stopping at
// the first that fails. `named`: the block has more than one run, so each bar
// says which.
/** @param {string} key @param {string[]} run @param {boolean} named @param {any} c @param {string} [messageId] */
function runBar(key, run, named, c, messageId) {
  const t = c.t;
  const here = c.runBang.here;
  const working = Boolean(c.runBang.working);
  const line = oneLine(run);
  const st = c.runBang.stateOf?.(run, key, messageId) ?? null;
  const ranHere = Boolean(st?.ran && st.where === "agent");
  const ranTab = Boolean(st?.ran && st.where === "tab");
  const queuedHere = Boolean(st?.queued && !st.ran && st.where === "agent");
  const queuedTab = Boolean(st?.queued && !st.ran && st.where === "tab");
  const btn = (
    /** @type {string} */ id,
    /** @type {string} */ ic,
    /** @type {string} */ label,
    /** @type {string} */ tip,
    /** @type {(e: any, cx: any) => void} */ fn,
    { done = false, queued = false } = {},
  ) =>
    h_flex().id(id).h(24).px(8).gap(6).flex_none().items_center().rounded(6).border_1()
      .border_color(done ? alpha(t.ansi2, 0.45) : queued ? alpha(t.accent, 0.4) : c.line)
      .when(done, (e) => e.bg(alpha(t.ansi2, 0.1)))
      .cursor_pointer()
      .text_size(11.5).text_color(done ? t.ansi2 : queued ? t.accent : t.muted)
      .hover((s) => s.bg(done ? alpha(t.ansi2, 0.16) : t.hover).text_color(done ? t.ansi2 : t.foreground))
      .tooltip(tip).on_click((e, cx) => fn(e, cx))
      .child(icon(done ? "check" : ic, 12).text_color(done ? t.ansi2 : queued ? t.accent : t.muted))
      .child(label);
  const what = run.length > 1 ? `${run.length} commands in order, stopping at the first that fails` : null;
  const cmdHint = run.length > 1 ? "…" : run[0];
  return h_flex().min_w(0).gap(6).items_center()
    .when(Boolean(here) && line !== null, (e) => e.child(btn(
      `run-here-${key}`,
      working || queuedHere ? "clock" : "corner-up-right",
      queuedHere ? `Queued in ${here}` : working ? `Queue in ${here}` : `Run in ${here}`,
      ranHere
        ? `Executed in ${here} · Click to run again`
        : working
          ? `Queue !${cmdHint} in ${here}: runs automatically after this turn finishes`
          : `Types !${cmdHint} into ${here}: it runs there, and ${here} sees what it prints`,
      (_e, cx) => c.runBang.run(run, "agent", cx, { queue: working, barKey: key }),
      { done: ranHere, queued: queuedHere },
    )))
    // a new tab opens at once, so it never waits for the turn: only the run in the agent queues
    .child(btn(
      `run-tab-${key}`,
      queuedTab ? "clock" : "terminal",
      queuedTab ? "Queued in new tab" : "Run in a new tab",
      ranTab
        ? "Executed in a new tab · Click to run again"
        : "In a terminal of its own, in this space: for a command that asks something",
      (_e, cx) => c.runBang.run(run, "tab", cx, { queue: false, barKey: key }),
      { done: ranTab, queued: queuedTab },
    ))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).when(named, (e) => e.font_family(c.mono))
      .child(named ? `! ${run[0]}${run.length > 1 ? ` (+${run.length - 1})` : ""}` : what ?? ""));
}

function plainLines(code) {
  return code.replace(/\n$/, "").split("\n").map((l) => [{ text: l }]);
}

// A copy button that shows ✓ for 1.5 s after copying.
export function copyButton(id, text, c, { size = 12, label = null } = {}) {
  const t = c.t;
  const done = c.copied(id);
  return h_flex().id(`copy-${id}`).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer()
    .text_size(11.5).text_color(done ? t.ansi2 : t.dim).hover((s) => s.bg(t.hover).text_color(done ? t.ansi2 : t.foreground))
    .tooltip(done ? "Copied" : "Copy").on_click((_e, cx) => c.copy(id, text, cx))
    .child(icon(done ? "check" : "copy", size)).when(Boolean(label), (e) => e.child(done ? "Copied" : label));
}

// A code card: highlighted monospace lines, capped at CODE_CAP lines until
// "Show all N lines". The language and Copy sit in the card's top right corner.
// A finished block (codeview.js) shows them while the pointer is over it
// (c.codeHover) or just after a copy: at rest it is the code alone. A card drawn
// in place (a fence still streaming, with a spinner; a diagram's source) always does.
export function codeCard(key, lang, code, lines, open, c) {
  const t = c.t;
  const f = flavorPalette(t);
  // Streaming (open fence): plain lines, one text run each, far cheaper to
  // rebuild every flush; highlighting arrives when the fence closes.
  const all = lines?.length && !open ? lines : plainLines(code);
  const n = all.length;
  const full = c.expanded.has(`code:${key}`);
  const shown = full ? all.slice(0, RENDER_MAX) : all.slice(0, CODE_CAP);
  const more = n - shown.length;
  const corner = open || !c.codeBody || c.codeHover || c.copied(`code:${key}`)
    ? h_flex().absolute().top(4).right(4).h(26).pl(9).pr(2).gap(6).items_center().rounded(7)
      .bg(c.codeBg).border_1().border_color(c.line)
      .child(div().text_size(11.5).font_medium().text_color(lang ? f.langTag : t.dim).child(lang || "text"))
      .when(Boolean(open), (e) => e.child(spinner(11, t.dim)))
      .child(copyButton(`code:${key}`, code, c))
    : null;
  const rendered = shown.map((l) => codeLine(l, t, t.foreground));
  // A finished block (codeview.js) scrolls sideways and selects; a streaming one is clipped.
  const body = (c.codeBody ? c.codeBody(rendered, code.replace(/\n$/, "").split("\n").slice(0, shown.length))
    : v_flex().px(12).py(8).overflow_hidden().children(rendered))
    .font_family(c.mono).text_size(12.5).line_height(`${LINE_H}px`).text_color(t.foreground);
  const foot = more > 0 || (full && n > CODE_CAP)
    ? h_flex().id(`code-more-${key}`).h(28).px(12).items_center().gap(6).border_t_1().border_color(c.line).cursor_pointer()
      .text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => c.toggle(`code:${key}`, cx))
      .child(icon(full ? "chevron-up" : "chevron-down", 12))
      .child(full ? (more > 0 ? `Showing ${shown.length} of ${n} lines · copy for the rest` : "Show less") : `Show all ${n} lines`)
    : null;
  return v_flex().relative().w_full().rounded(10).overflow_hidden().border_1().border_color(f.codeBorder || t.border).bg(c.codeBg)
    .child(body).children(foot ? [foot] : []).children(corner ? [corner] : []);
}

// A mermaid block: the host's SVG (click to enlarge, "Show source"), its
// ASCII fallback, or the source while the fence streams.
function mermaid(key, b, c) {
  const t = c.t;
  if (b.open || (!b.svg && !b.ascii?.length)) return codeCard(key, "mermaid", b.source ?? "", null, b.open, c);
  const src = c.expanded.has(`src:${key}`);
  const rel = b.svg ? (c.imageRel ? c.imageRel(b.svg) : homeRel(b.svg, appHome())) : null;
  // No picture to show yet (a host on another machine's, on its way here) and no ASCII: the source.
  if (!rel && !b.ascii?.length) return codeCard(key, "mermaid", b.source ?? "", null, false, c);
  const size = rel ? c.svgSize(b.svg) : null;
  const head = h_flex().h(30).pl(12).pr(6).gap(4).items_center().border_b_1().border_color(c.line)
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(b.error && !rel ? "mermaid · shown as text" : "mermaid"))
    .child(h_flex().id(`src-${key}`).h(22).px(6).gap(5).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => c.toggle(`src:${key}`, cx))
      .child(icon("code", 12)).child(src ? "Hide source" : "Show source"))
    .when(Boolean(rel), (e) => e.child(h_flex().id(`zoom-${key}`).h(22).px(6).items_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Enlarge").on_click((_e, cx) => c.enlarge(b.svg, size, cx))
      .child(icon("maximize", 12))))
    .child(copyButton(`code:${key}`, b.source ?? "", c));
  let body;
  if (rel) {
    // Fit the column, up to 1.4× the drawing's own size so its 13 px labels read like
    // the prose (a diagram drawn as large as it can be, not left small in a wide card),
    // and at most 640 px tall; the SVG's own aspect ratio once known (else a guess).
    let w = Math.min(c.colW - 26, Math.round((size?.w ?? 600) * 1.4));
    let h = size ? Math.round((w * size.h) / size.w) : 260;
    if (h > 640) { w = Math.round((w * 640) / h); h = 640; }
    // On hover a ⤢ at the top right says a click opens the zoomable viewer (the click is the body's).
    body = div().id(`svg-${key}`).relative().p(12).flex().justify_center().cursor_pointer().on_click((_e, cx) => c.enlarge(b.svg, size, cx))
      .on_hover((on, cx) => c.setSvgHover(key, on, cx))
      .child(image(rel).w(w).h(h))
      .when(c.svgHover === key, (e) => e.child(div().absolute().top(8).right(8).w(26).h(26).flex().items_center().justify_center()
        .rounded(6).bg(alpha(t.popover, 0.92)).border_1().border_color(t.input).text_size(14).text_color(t.foreground).child("⤢")));
  } else {
    body = v_flex().id(`ascii-${key}`).px(12).py(8).overflow_hidden().font_family(c.mono).text_size(12.5).line_height(`${LINE_H}px`)
      .children(b.ascii.map((l) => codeLine(l, t, t.foreground)));
  }
  return v_flex().w_full().rounded(10).overflow_hidden().border_1().border_color(t.border).bg(c.codeBg)
    .child(head).child(body)
    .when(src, (e) => e.child(div().border_t_1().border_color(c.line).child(codeCard(`${key}:src`, "mermaid", b.source ?? "", null, false, c))));
}

// A picture the answer shows on a line of its own (protocol v3.11): the host's copy of the file at
// its own size, at most the column's width and PICTURE_MAX_H tall, enlarged on a click; its words
// (the alt text) in a tooltip. Another machine's, still on its way here: its box, so the row keeps its
// height. One that can't be drawn: the line as a link, as the answer wrote it.
const PICTURE_MAX_H = 560;
function picture(key, b, c) {
  const t = c.t;
  const rel = c.imageRel ? c.imageRel(b.path) : homeRel(b.path, appHome());
  const size = b.size ?? (rel && /\.svg$/i.test(b.path ?? "") ? c.svgSize(b.path) : null);
  const room = Math.max(40, (c.colW ?? 640) - 2);
  let w = Math.min(room, size?.w ?? room);
  let h = size?.w ? Math.round((w * size.h) / size.w) : Math.round((w * 10) / 16);
  if (h > PICTURE_MAX_H) { w = Math.max(1, Math.round((w * PICTURE_MAX_H) / h)); h = PICTURE_MAX_H; }
  w = Math.max(1, w); h = Math.max(1, h);
  if (!rel && c.imagePending?.(b.path)) return div().id(`pic-${key}`).w(w + 2).h(h + 2).rounded(10).border_1().border_color(t.border).bg(t.hover);
  if (!rel) return markdown(`md-pic-${key}`, `[${(b.alt || "picture").replace(/[[\]]/g, "\\$&")}](<${b.src}>)`, c.onLink, t);
  let el = h_flex().id(`pic-${key}`).flex_none().cursor_pointer().rounded(10).overflow_hidden().border_1().border_color(t.border)
    .on_click((_e, cx) => c.enlarge(b.path, size, cx))
    .child(image(rel).w(w).h(h));
  if (b.alt) el = el.tooltip(b.alt);
  return h_flex().child(el);
}

// Styled lines (tool output, file excerpts) in a mono box, with an optional
// line-number gutter starting at `first`.
export function outputBox(key, lines, c, { first = null, cap = 400, color } = {}) {
  const t = c.t;
  if (lines.length > 1 && !lines[lines.length - 1]?.some?.((x) => x.text)) lines = lines.slice(0, -1);
  const n = lines.length;
  const from = Math.max(0, n - cap);
  const shown = lines.slice(from);
  const gutterW = first != null ? Math.max(2, String(first + n).length) * 7.6 + 14 : 0;
  const rows = shown.map((l, i) => {
    const line = codeLine(l, t, color ?? t.muted);
    if (first == null) return line;
    return h_flex().flex_none().child(div().flex_none().w(gutterW).pr(10).text_color(t.dim).opacity(0.7).flex().justify_end().child(String(first + from + i)))
      .child(line);
  });
  return v_flex().id(`out-${key}`).w_full().overflow_x_scroll().font_family(c.mono).text_size(12).line_height(`${LINE_H - 1}px`)
    .when(from > 0, (e) => e.child(div().text_size(11).text_color(t.dim).child(`… ${plural(from, "earlier line")}`)))
    .children(rows);
}

// diffLines (protocol v2): gutter with old/new numbers, +/− tints, highlighted spans.
export function diffView(key, lines, c, { cap = 600 } = {}) {
  const t = c.t;
  const shown = lines.filter((l) => l.kind !== "meta").slice(0, cap); // the card's title names the file
  const maxN = Math.max(...shown.map((l) => Math.max(l.old ?? 0, l.new ?? 0)), 9);
  const nw = String(maxN).length * 7.4 + 8;
  const rows = shown.map((l) => {
    if (l.kind === "hunk" || l.kind === "meta") {
      return h_flex().flex_none().h(LINE_H + 3).items_center().px(8).bg(alpha(t.ansi4, 0.07)).text_color(t.dim)
        .child(codeLine(l.spans, t, t.dim));
    }
    const add = l.kind === "add", del = l.kind === "del";
    const tint = add ? alpha(t.ansi2, 0.13) : del ? alpha(t.ansi1, 0.13) : null;
    let row = h_flex().flex_none().min_w_full()
      .child(div().flex_none().w(nw).pr(6).flex().justify_end().text_color(t.dim).opacity(0.75).child(l.old != null && !add ? String(l.old) : ""))
      .child(div().flex_none().w(nw).pr(6).flex().justify_end().text_color(t.dim).opacity(0.75).child(l.new != null && !del ? String(l.new) : ""))
      .child(div().flex_none().w(16).text_color(add ? t.ansi2 : del ? t.ansi1 : t.dim).child(add ? "+" : del ? "−" : " "))
      .child(codeLine(l.spans, t, t.foreground));
    if (tint) row = row.bg(tint);
    return row;
  });
  return v_flex().id(`diff-${key}`).w_full().rounded(6).overflow_hidden().overflow_x_scroll().bg(c.codeBg).py(4)
    .font_family(c.mono).text_size(12).line_height(`${LINE_H}px`)
    .children(rows)
    .when(lines.length > cap, (e) => e.child(div().px(8).text_size(11).text_color(t.dim).child(`… ${plural(lines.length - cap, "more line")}`)));
}

// A unified diff as text (v1 hosts): +/− tints only.
export function textDiff(key, text, c) {
  const lines = (text ?? "").replace(/\n$/, "").split("\n").slice(0, 600);
  let o = null, n = null;
  const dl = lines.map((l) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (m) { o = Number(m[1]); n = Number(m[2]); return { kind: "hunk", spans: [{ text: l }] }; }
    if (l.startsWith("+++") || l.startsWith("---")) return { kind: "meta", spans: [{ text: l }] };
    if (l.startsWith("+")) return { kind: "add", new: n != null ? n++ : null, spans: [{ text: l.slice(1) }] };
    if (l.startsWith("-")) return { kind: "del", old: o != null ? o++ : null, spans: [{ text: l.slice(1) }] };
    const r = { kind: "ctx", old: o != null ? o++ : null, new: n != null ? n++ : null, spans: [{ text: l.replace(/^ /, "") }] };
    return r;
  });
  return diffView(key, dl, c);
}
