// Rich content (visual-v2.md §3): an assistant message's blocks (markdown,
// highlighted code cards, mermaid diagrams), diffs with a line-number
// gutter, highlighted file excerpts and ANSI-colored command output.
// The host splits and highlights (protocol.md v2 `Block`, `syn:` spans);
// without blocks a message is one markdown block, as in v1.

import { div, image } from "gpui-kit";
import { appHome } from "herdr";
import { v_flex, h_flex, TextView } from "gpui-base";
import { alpha, codeLine, homeRel, icon, plural, spinner } from "./util.js";
import { SPACE } from "./space.js";
import { linkPaths } from "./paths.js";
import { oneLine, runsInCode } from "./bang.js";
import { decorateInlineCode, flavorPalette, mdChunks } from "./flavor.js";

export { mdChunks };

export const CODE_CAP = 30; // lines shown before "Show all N lines"
const RENDER_MAX = 600; // lines ever built for one block (the rest: copy it)
export const LINE_H = 19;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;

// `onLink` (an answer's prose): its file paths become links (linkPaths), and
// every link's click goes to it instead of straight to the system. When `opts.t`
// is provided (and `opts.codeTint !== false`), standalone inline code spans get a
// warm tinted pill matching Antigravity's terminal flavor while copying cleanly.
/** @typedef {(url: string, cx: import("gpui-kit").Context) => void} OnLink */
/**
 * @param {string} id
 * @param {string} text
 * @param {OnLink} [onLink]
 * @param {{ t?: any, codeTint?: boolean }} [opts]
 */
export const prose = (id, text, onLink, opts) => {
  let src = onLink ? linkPaths(text) : text;
  if (opts?.t && opts.codeTint !== false) src = decorateInlineCode(src, flavorPalette(opts.t).codeBg);
  const view = TextView.markdown(id, src).selectable(true);
  return onLink ? view.on_link_click(onLink) : view;
};

// The space above a piece of an answer, after `prev` (null: the first).
const above = (heading, prev) => (prev == null ? 0 : heading ? SPACE.headingAbove : prev.heading ? SPACE.headingBelow : SPACE.block);

function renderList(id, items, onLink, t, f) {
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
      .child(prose(`${id}-li-${idx}`, it.text || " ", onLink, { t }));
    return h_flex().min_w(0).items_start().when(padL > 0, (e) => e.pl(padL)).child(lead).child(body);
  }));
}

function renderTable(id, chunk, onLink, t, f) {
  // Very wide tables (6+ cols) fall back to native TextView table column measurement.
  if (chunk.headers.length > 5) return prose(id, chunk.text, onLink, { t });
  const alignCell = (el, a) => (a === "right" ? el.justify_end() : a === "center" ? el.justify_center() : el);
  const cell = (cid, txt, a, opts) => alignCell(h_flex().flex_1().min_w(0).px(10).py(6), a)
    .child(div().min_w(0).child(prose(cid, txt || " ", onLink, opts)));
  const head = h_flex().w_full().bg(f.tableHeadBg).border_b_1().border_color(t?.border).text_size(13).font_semibold().text_color(f.tableHead)
    .children(chunk.headers.map((h, ci) => cell(`${id}-th-${ci}`, h, chunk.aligns[ci], { t })));
  const body = chunk.rows.map((r, ri) => h_flex().w_full().text_size(13).line_height("20px")
    .when(ri > 0, (e) => e.border_t_1().border_color(alpha(t?.border, 0.55)))
    .when(ri % 2 === 1, (e) => e.bg(f.tableStripe))
    .children(r.map((val, ci) => cell(`${id}-td-${ri}-${ci}`, val, chunk.aligns[ci], { t }))));
  return v_flex().w_full().rounded(8).overflow_hidden().border_1().border_color(t?.border).child(head).children(body);
}

function renderChunk(id, p, onLink, t, f) {
  if (!t) return prose(id, p.text, onLink);
  switch (p.kind) {
    case "heading": {
      const col = f.heading(p.level);
      return div().min_w(0).text_color(col)
        .when(p.level === 1, (e) => e.w_full().pb(4).border_b_1().border_color(f.h1Rule))
        .child(prose(id, p.text, onLink, { t }));
    }
    case "hr":
      return div().w_full().py(4).child(div().w_full().h(1).bg(f.hr));
    case "callout": {
      const ca = f.callout(p.alert);
      return v_flex().w_full().min_w(0).gap(4).pl(12).pr(10).py(8).rounded(8)
        .border_l_2().border_color(ca.color).bg(ca.bg)
        .child(h_flex().gap(6).items_center().text_size(12.5).font_semibold().text_color(ca.color)
          .child(icon(ca.icon, 13).text_color(ca.color)).child(ca.label))
        .child(div().min_w(0).child(markdown(`${id}-b`, p.body, onLink, t)));
    }
    case "blockquote":
      return div().w_full().min_w(0).pl(12).pr(10).py(6).rounded_r(8)
        .border_l_2().border_color(f.quoteBar).bg(f.quoteBg)
        .child(markdown(`${id}-q`, p.body, onLink, t));
    case "table":
      return renderTable(id, p, onLink, t, f);
    case "list":
      return renderList(id, p.items, onLink, t, f);
    default:
      return prose(id, p.text, onLink, { t });
  }
}

// Markdown as its chunks, spaced (one TextView when it's one plain chunk). `onLink`: prose().
/**
 * @param {string} id
 * @param {string} text
 * @param {OnLink} [onLink]
 * @param {any} [t]
 */
export function markdown(id, text, onLink, t) {
  const parts = mdChunks(text || " ");
  const f = t ? flavorPalette(t) : null;
  if (parts.length === 1) return renderChunk(id, parts[0], onLink, t, f);
  return v_flex().min_w(0).children(parts.map((p, j) => div().pt(above(p.heading, parts[j - 1])).child(renderChunk(`${id}-${j}`, p, onLink, t, f))));
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
      if (runs.length) el = v_flex().min_w(0).gap(6).child(el).children(runs.map((r, j) => runBar(`${key}:${j}`, r, runs.length > 1, c)));
    }
    else if (b.type === "mermaid") el = mermaid(key, b, c);
    else el = c.codeView?.(key) || markdown(`md-${it.id}-${i}`, b.text, c.onLink, c.t);
    return div().pt(gap).child(el);
  }));
}

// A `!` run under its code block: run it in the agent (c.runBang.here names
// it; the terminal view types `!command` into Claude Code, as Ctrl+! does) or
// in a new tab of the space. A run of several runs them in order, stopping at
// the first that fails. `named`: the block has more than one run, so each bar
// says which.
/** @param {string} key @param {string[]} run @param {boolean} named @param {any} c */
function runBar(key, run, named, c) {
  const t = c.t;
  const here = c.runBang.here;
  const line = oneLine(run);
  const btn = (/** @type {string} */ id, /** @type {string} */ ic, /** @type {string} */ label, /** @type {string} */ tip, /** @type {(cx: any) => void} */ fn) =>
    h_flex().id(id).h(24).px(8).gap(6).flex_none().items_center().rounded(6).border_1().border_color(c.line).cursor_pointer()
      .text_size(11.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((_e, cx) => fn(cx)).child(icon(ic, 12)).child(label);
  const what = run.length > 1 ? `${run.length} commands in order, stopping at the first that fails` : null;
  return h_flex().min_w(0).gap(6).items_center()
    .when(Boolean(here) && line !== null, (e) => e.child(btn(`run-here-${key}`, "corner-up-right", `Run in ${here}`,
      `Types !${run.length > 1 ? "…" : run[0]} into ${here}: it runs there, and ${here} sees what it prints`, (cx) => c.runBang.run(run, "agent", cx))))
    .child(btn(`run-tab-${key}`, "terminal", "Run in a new tab", "In a terminal of its own, in this space: for a command that asks something", (cx) => c.runBang.run(run, "tab", cx)))
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
