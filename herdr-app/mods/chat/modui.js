// Claude Code mods drawn in the chat (protocol.md v3.10): the band above the composer and
// the panes a mod opens, beside the timeline when there's room, else above the composer.
// The host hands over each drawing as a plain-data tree (Box, Text, Button, Input, Select,
// Link, Code, Markdown, Svg); this draws it with GPUI and sends back what the person does
// (`mod_ui` op). Claude Code lays out in character cells: a cell is CELL_W × ROW_H here.

import { div, image } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { icon, alpha } from "./util.js";
import { markdown, codeCard } from "./rich.js";

const CELL_W = 7.5;
const ROW_H = 18;
// Gaps, margins and padding in cells: a terminal's blank line is too much room in a window.
const GAP_X = 6;
const GAP_Y = 6;
const STEPS = { xs: 2, sm: 4, md: 8, lg: 12, xl: 16 };
const SVG_MAX_W = 640;
const TEXT_SIZE = { caption: 11, footnote: 12, body: 13, heading: 15, title: 18 };
/** A chat narrower than this shows a pane above the composer, not beside the timeline. */
export const DOCK_MIN = 880;

// Ink's color names, as the terminal draws them, → the theme's ANSI colors.
const NAMED = {
  black: "ansi0", red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", magenta: "ansi5", cyan: "ansi6", white: "ansi7",
  gray: "ansi8", grey: "ansi8", blackBright: "ansi8", redBright: "ansi9", greenBright: "ansi10", yellowBright: "ansi11",
  blueBright: "ansi12", magentaBright: "ansi13", cyanBright: "ansi14", whiteBright: "ansi15",
};
// Claude Code's theme keys → the chat's theme: a theme color's name, a color, or one made from the theme.
// The public keys (ThemeKey), then the ones its own lowered drawings use (Progress's track and fill…).
const CLAUDE_ORANGE = "#d97757";
const tint = (k, a) => (t) => alpha(t[k], a);
const THEME_KEYS = {
  text: "foreground", inverseText: "background", inactive: "muted", subtle: "dim", suggestion: "ansi4", remember: "ansi4",
  success: "ansi2", error: "ansi1", warning: "ansi3", merged: "ansi5", claude: CLAUDE_ORANGE, permission: "ansi4", planMode: "ansi6",
  autoAccept: "ansi5", promptBorder: "input", bashBorder: "ansi5", ide: "ansi4", diffAdded: "ansi2", diffRemoved: "ansi1",
  diffAddedDimmed: tint("ansi2", 0.6), diffRemovedDimmed: tint("ansi1", 0.6), diffAddedWord: "ansi2", diffRemovedWord: "ansi1",
  background: "background", skill: "ansi5", professionalBlue: "ansi4", chromeYellow: "ansi3", claudeBlue_FOR_SYSTEM_SPINNER: "ansi4",
  clawd_body: CLAUDE_ORANGE, clawd_background: "background", userMessageBackground: tint("foreground", 0.12),
  userMessageBackgroundHover: tint("foreground", 0.18), composerSidebarBackground: "surface", selectionBg: "selection",
  bashMessageBackgroundColor: tint("foreground", 0.07), memoryBackgroundColor: tint("foreground", 0.07),
  rate_limit_fill: "accent", rate_limit_empty: tint("foreground", 0.12), fastMode: "ansi3", effortUltra: "ansi5",
  briefLabelYou: "muted", briefLabelClaude: CLAUDE_ORANGE,
  red_FOR_SUBAGENTS_ONLY: "ansi1", blue_FOR_SUBAGENTS_ONLY: "ansi4", green_FOR_SUBAGENTS_ONLY: "ansi2", yellow_FOR_SUBAGENTS_ONLY: "ansi3",
  purple_FOR_SUBAGENTS_ONLY: "ansi5", orange_FOR_SUBAGENTS_ONLY: CLAUDE_ORANGE, pink_FOR_SUBAGENTS_ONLY: "ansi13", cyan_FOR_SUBAGENTS_ONLY: "ansi6",
  rainbow_red: "ansi1", rainbow_orange: CLAUDE_ORANGE, rainbow_yellow: "ansi3", rainbow_green: "ansi2", rainbow_blue: "ansi4",
  rainbow_indigo: "ansi12", rainbow_violet: "ansi5",
};

/** A mod's color (a theme key, an Ink name, `#hex`, a theme color's name) as a color GPUI draws, or null. */
export function modColor(c, t) {
  if (typeof c !== "string" || !c) return null;
  if (c.startsWith("#")) return /^#[0-9a-f]{3,8}$/i.test(c) ? c : null;
  // A shimmer (an animation's second color) draws as its color.
  const base = c.replace(/_?[Ss]himmer$/, "");
  const k = THEME_KEYS[c] ?? THEME_KEYS[base] ?? NAMED[c] ?? (t[c] !== undefined ? c : null);
  if (!k) return null;
  if (typeof k === "function") return k(t);
  return k.startsWith("#") ? k : t[k] ?? null;
}

function space(v, axis) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v) * (axis === "x" ? GAP_X : GAP_Y);
  return STEPS[v] ?? null;
}

function size(v, axis) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, v) * (axis === "x" ? CELL_W : ROW_H);
  if (typeof v === "string" && /^\d+(\.\d+)?%$/.test(v)) return v;
  return null;
}

/** Every node of a tree, depth first. */
function* walk(n) {
  if (!n || typeof n !== "object") return;
  yield n;
  for (const c of n.children ?? []) yield* walk(c);
}

export class ModUi {
  /** @param {any} v the chat view (main.js) */
  constructor(v) {
    this.v = v;
    /** plugin:key → { state, press, site, drawn } for each Input drawn */
    this.fields = new Map();
    /** plugin:key → { value, drawn } the person's pick, until the mod draws another */
    this.picks = new Map();
    this.viewport = "";
  }

  get ui() {
    return this.v.store.state.modUi ?? null;
  }

  /** Something to draw. */
  any() {
    const ui = this.ui;
    return Boolean(ui && (ui.band || ui.panes?.length));
  }

  /** After a state change (a handler, where InputState.new may run): a field for each Input drawn. */
  sync(cx) {
    const ui = this.ui;
    const sites = ui ? [["AbovePrompt", "above-prompt", ui.band], ...Object.entries(ui.bodies ?? {}).map(([id, t]) => ["Pane", id, t])] : [];
    const seen = new Set();
    for (const [component, instance, tree] of sites) {
      for (const n of walk(tree)) {
        if (n.type !== "Input" || !n.press) continue;
        const key = `${n.press.plugin}:${n.props?.key ?? ""}`;
        seen.add(key);
        let f = this.fields.get(key);
        const drawn = typeof n.props?.value === "string" ? n.props.value : "";
        if (!f) {
          const state = InputState.new({ placeholder: String(n.props?.placeholder ?? "") });
          f = { state, press: n.press, site: { component, instance }, drawn: null, key: n.props?.key ?? "" };
          state.on("change", (_e, cx) => this.input(f, "change", cx));
          state.on("submit", (_e, cx) => this.input(f, "submit", cx));
          this.fields.set(key, f);
        }
        f.press = n.press;
        f.site = { component, instance };
        // The person's typing stands until the mod draws another value.
        if (drawn !== f.drawn) {
          f.drawn = drawn;
          if (f.state.value() !== drawn) f.state.set_value(drawn);
        }
      }
    }
    for (const k of [...this.fields.keys()]) if (!seen.has(k)) this.fields.delete(k);
  }

  input(f, kind, cx) {
    const value = f.state.value();
    if (kind === "change" && value === f.drawn) return;
    this.act({ action: "input", ...f.press, key: f.key, kind, value, component: f.site.component, instance: f.site.instance }, cx);
  }

  act(args, cx) {
    this.v.req("mod_ui", args, cx).then((d) => {
      if (d?.handled === false) this.v.log(`mod_ui ${args.action}: not handled (a stale drawing)`);
    }, (e) => this.v.flash(`Mod: ${e?.message ?? e}`, cx));
  }

  /** The room the band and the pane have, in cells, for the mods' `e.viewport`. */
  report(band, pane, docked, cx) {
    const vp = {
      band: { columns: Math.max(10, Math.floor(band / CELL_W)), rows: 6 },
      pane: { columns: Math.max(10, Math.floor(pane.w / CELL_W)), rows: Math.max(4, Math.floor(pane.h / ROW_H)) },
      docked,
    };
    const key = JSON.stringify(vp);
    if (key === this.viewport || !this.any()) return;
    this.viewport = key;
    this.v.req("mod_ui", { action: "viewport", ...vp }, cx).catch(() => {});
  }

  // ---------------------------------------------------------------- the band and the pane

  /** The band above the composer: every mod's row, as the mods drew them. */
  band(t, c) {
    const tree = this.ui?.band;
    if (!tree) return null;
    return v_flex().id("mod-band").w_full().px(4).gap(4).text_size(12.5).text_color(t.foreground)
      .child(this.node(tree, t, c, { component: "AbovePrompt", instance: "above-prompt" }, "b"));
  }

  /**
   * The shown pane: its tabs (when several) and ×, then its body.
   * `docked`: a column beside the timeline (full height); else a box above the composer.
   */
  pane(t, c, { docked, maxH }) {
    const ui = this.ui;
    if (!ui?.panes?.length) return null;
    const shown = ui.panes.find((p) => p.id === ui.shown) ?? ui.panes.at(-1);
    const body = ui.bodies?.[shown.id];
    const bg = modColor(shown.background, t) ?? t.surface;
    const tabs = h_flex().flex_1().min_w(0).gap(2).items_center().children(ui.panes.map((p) => {
      const on = p.id === shown.id;
      return div().id(`mod-tab-${p.id}`).h(24).px(8).flex().items_center().rounded(6).min_w(0).cursor_pointer().text_size(12)
        .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.hover)).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(p.plugin ? `${p.title} · from ${p.plugin}` : p.title)
        .on_click((_e, cx) => { if (!on) this.act({ action: "show", pane: p.id }, cx); })
        .child(div().truncate().child(p.title));
    }));
    const close = div().id("mod-pane-close").size(24).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(`Close ${shown.title}`)
      .on_click((_e, cx) => this.act({ action: "close", pane: shown.id }, cx))
      .child(icon("x", 13));
    const head = h_flex().flex_none().h(34).pl(6).pr(5).gap(6).items_center().border_b_1().border_color(alpha(t.border, 0.7))
      .child(tabs).child(close);
    // Docked: the column's height, with a scrollbar. Inline: its content's, up to the box's max, then it
    // scrolls (overflow_y_scrollbar's wrapper would clamp the content to max_h: chrome.js activityDrawer).
    const inner = (docked ? v_flex().id(`mod-pane-body-${shown.id}`).flex_1().min_h(0).overflow_y_scrollbar()
      : v_flex().id(`mod-pane-body-${shown.id}`).w_full().max_h(Math.max(80, maxH - 35)).overflow_y_scroll())
      .p(12).gap(6)
      .text_size(13).text_color(t.foreground)
      .child(body ? this.node(body, t, c, { component: "Pane", instance: shown.id }, "p") : div().text_color(t.dim).child("…"));
    const box = v_flex().id("mod-pane").bg(bg).overflow_hidden();
    return docked
      ? box.size_full().border_l_1().border_color(t.border).child(head).child(inner)
      : box.w_full().rounded(10).border_1().border_color(t.border).child(head).child(inner);
  }

  // ---------------------------------------------------------------- one element

  node(n, t, c, site, path) {
    if (typeof n === "string") return div().child(n);
    if (!n || typeof n !== "object") return null;
    const p = n.props ?? {};
    const id = `mod-${site.instance}-${path}`;
    const kids = () => (n.children ?? []).map((k, i) => this.node(k, t, c, site, `${path}.${i}`)).filter(Boolean);
    switch (n.type) {
      case "Box":
      case "div":
        return this.box(n, p, t, c, kids(), id, n.type === "div");
      case "Text":
      case "span":
      case "b":
        return this.text(n, t, c, site, path);
      case "Button":
        return this.button(n, p, t, c, site, path, id);
      case "Input":
        return this.field(n, p, t);
      case "Select":
        return this.select(n, p, t, id);
      case "Link": {
        const href = String(p.href ?? "");
        const label = (n.children ?? []).filter((x) => typeof x === "string").join("") || p.label || href;
        return div().id(id).text_color(t.accent).cursor_pointer().hover((s) => s.text_decoration_1()).tooltip(href)
          .on_click((_e, cx) => c.onLink?.(href, cx)).child(String(label));
      }
      case "Code": {
        const lines = n.lines ?? null;
        const lang = typeof p.language === "string" ? p.language : null;
        return div().w_full().child(codeCard(id, lang, String(p.source ?? ""), lines, false, c));
      }
      case "Markdown": {
        const md = markdown(id, String(p.text ?? ""), (url, cx) => {
          // A mod that answers its links hears the press; else the link opens as any other.
          if (n.press && (!Array.isArray(p.pressableLinks) || p.pressableLinks.includes(url))) this.act({ action: "press", ...n.press, key: p.key, href: url }, cx);
          else c.onLink?.(url, cx);
        }, t);
        return p.dimColor ? div().opacity(0.7).child(md) : md;
      }
      case "Svg": {
        const rel = n.path ? c.imageRel?.(n.path) : null;
        if (!rel) return div().text_color(t.dim).child(String(p.alt ?? "(a drawing)"));
        // Its own size, as a page draws it: the props', else the markup's; a viewBox alone takes a default width.
        const own = n.size ?? {};
        const w = Math.min(typeof p.width === "number" ? p.width : own.w ?? (own.h && own.ratio ? own.h * own.ratio : 320), SVG_MAX_W);
        const h = typeof p.height === "number" ? p.height : own.ratio ? w / own.ratio : own.h ?? w;
        return image(rel).w(w).h(h).flex_none();
      }
      case "Progress": {
        // value from 0 to max (absent: 1); no fraction (value or max unusable): running, no known end.
        const max = p.max === undefined ? 1 : p.max;
        const known = Number.isFinite(p.value) && Number.isFinite(max) && max > 0;
        const frac = known ? Math.max(0, Math.min(1, p.value / max)) : null;
        const color = modColor(p.color, t) ?? t.accent;
        const figure = p.valueText ?? (frac === null ? "running" : `${Math.round(frac * 100)}%`);
        return v_flex().gap(3).w_full()
          .child(h_flex().w_full().justify_between().gap(8).text_size(12).child(div().min_w(0).truncate().text_color(t.muted).child(String(p.label ?? ""))).child(div().flex_none().text_color(t.dim).child(String(figure))))
          .child(div().w_full().h(4).rounded(2).bg(alpha(t.foreground, 0.12)).overflow_hidden()
            .child(frac === null ? div().h_full().w("30%").rounded(2).bg(alpha(color, 0.5)) : div().h_full().rounded(2).bg(color).w(`${Math.round(frac * 100)}%`)));
      }
      default:
        // A Client (a desktop surface module) and anything newer: their children, if any.
        return (n.children?.length ? this.box(n, {}, t, c, kids(), id, false) : null);
    }
  }

  box(n, p, t, c, kids, id, column) {
    if (p.display === "none") return null;
    let el = div().flex().relative().min_w(0);
    const dir = p.flexDirection ?? (column ? "column" : "row");
    el = dir === "column" ? el.flex_col() : dir === "row-reverse" ? el.flex_row_reverse() : dir === "column-reverse" ? el.flex_col_reverse() : el.flex_row();
    if (p.flexWrap === "wrap" || p.flexWrap === "wrap-reverse") el = el.flex_wrap();
    if (typeof p.flexGrow === "number") el = el.flex_grow(p.flexGrow);
    if (typeof p.flexShrink === "number") el = el.flex_shrink(p.flexShrink);
    el = align(el, p.alignItems, { "flex-start": "items_start", center: "items_center", "flex-end": "items_end", stretch: "items_stretch" });
    el = align(el, p.alignSelf, { "flex-start": "self_start", center: "self_center", "flex-end": "self_end" });
    el = align(el, p.justifyContent, { "flex-start": "justify_start", center: "justify_center", "flex-end": "justify_end", "space-between": "justify_between", "space-around": "justify_around", "space-evenly": "justify_evenly" });
    const gx = space(p.columnGap ?? p.gap, "x");
    const gy = space(p.rowGap ?? p.gap, "y");
    if (gx !== null) el = el.gap_x(gx);
    if (gy !== null) el = el.gap_y(gy);
    for (const [k, axis, m] of [["width", "x", "w"], ["height", "y", "h"], ["minWidth", "x", "min_w"], ["minHeight", "y", "min_h"]]) {
      const v = size(p[k], axis);
      if (v !== null) el = el[m](v);
    }
    el = edges(el, p, "padding", "p");
    el = edges(el, p, "margin", "m");
    if (p.borderStyle) {
      const bc = modColor(p.borderColor, t) ?? t.border;
      el = el.border_1().border_color(p.borderDimColor ? alpha(bc, 0.5) : bc).rounded(p.borderStyle === "round" ? 8 : 4);
      if (!["padding", "paddingX", "paddingY", "paddingLeft", "paddingTop"].some((k) => p[k] !== undefined)) el = el.px(8).py(4);
    }
    const bg = modColor(p.backgroundColor, t);
    if (bg) el = el.bg(bg);
    if (p.overflow === "hidden") el = el.overflow_hidden();
    if (p.overflowX === "scroll") el = el.id(id).overflow_x_scroll();
    if (p.mono) el = el.font_family(c.mono);
    if (p.position === "absolute") {
      el = el.absolute();
      for (const [k, axis] of [["top", "y"], ["left", "x"], ["right", "x"], ["bottom", "y"]]) {
        if (typeof p[k] === "number") el = el[k](p[k] * (axis === "x" ? CELL_W : ROW_H));
      }
    }
    const hov = p.hover;
    if (hov && p.key) {
      const hb = modColor(hov.backgroundColor, t);
      const hc = modColor(hov.borderColor, t);
      if (hb || hc) el = el.id(id).hover((s) => { let x = s; if (hb) x = x.bg(hb); if (hc) x = x.border_color(hc); return x; });
    }
    return el.children(kids);
  }

  /** Text: its own style, and nested Text as runs of their own. */
  text(n, t, c, site, path) {
    const runs = [];
    const flat = (node, inherit) => {
      const p = node.props ?? {};
      const style = { ...inherit };
      if (node.type === "b") style.bold = true;
      for (const k of ["color", "backgroundColor", "dimColor", "size", "weight", "mono", "bold", "italic", "underline", "strikethrough", "inverse"]) {
        if (p[k] !== undefined) style[k] = p[k];
      }
      for (const ch of node.children ?? []) {
        if (typeof ch === "string") runs.push({ text: ch, style });
        else if (ch && typeof ch === "object") flat(ch, style);
      }
    };
    flat(n, {});
    const p = n.props ?? {};
    const one = (r, el) => styled(el, r.style, t, c);
    let el;
    if (runs.length <= 1) el = one(runs[0] ?? { text: "", style: {} }, div().min_w(0)).child(runs[0]?.text ?? "");
    else el = h_flex().flex_wrap().min_w(0).children(runs.map((r) => one(r, div().flex_none()).child(r.text)));
    const cut = p.wrap && p.wrap !== "wrap";
    if (cut || p.maxLines === 1) el = el.truncate();
    return el;
  }

  button(n, p, t, c, site, path, id) {
    const label = p.label ?? ((n.children ?? []).filter((x) => typeof x === "string").join("") || p.key || "");
    const press = (_e, cx) => {
      if (!n.press) return;
      this.act({ action: "press", ...n.press, key: p.key ?? label }, cx);
    };
    if (p.plain) {
      return h_flex().id(id).gap(4).items_center().rounded(4).px(2).cursor_pointer().text_color(p.dimColor ? t.muted : t.foreground)
        .hover((s) => s.text_color(t.foreground).bg(t.hover)).on_click(press)
        .when(Boolean(p.hotkey), (e) => e.child(div().text_color(t.accent).child(`${p.hotkey}:`)))
        .child(String(label));
    }
    const primary = p.variant === "primary";
    return h_flex().id(id).h(26).px(10).gap(6).items_center().justify_center().rounded(7).cursor_pointer().flex_none().text_size(12.5)
      .border_1().border_color(primary ? t.solid ?? t.accent : t.input).bg(primary ? t.solid ?? t.accent : t.surface)
      .text_color(primary ? t.solid_foreground ?? t.accent_foreground : p.dimColor ? t.muted : t.foreground)
      .hover((s) => (primary ? s.opacity(0.9) : s.bg(t.hover).text_color(t.foreground)))
      .on_click(press)
      .child(String(label));
  }

  field(n, p, t) {
    const f = n.press ? this.fields.get(`${n.press.plugin}:${p.key ?? ""}`) : null;
    const input = f
      ? Input.new(f.state).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5)
      : div().h(28).px(8).flex().items_center().rounded(7).border_1().border_color(t.input).text_color(t.dim).child(String(p.value || p.placeholder || ""));
    return h_flex().w_full().gap(8).items_center()
      .when(Boolean(p.label), (e) => e.child(div().flex_none().text_color(t.muted).child(String(p.label))))
      .child(div().flex_1().min_w(0).child(input));
  }

  select(n, p, t, id) {
    const options = Array.isArray(p.options) ? p.options : [];
    const key = n.press ? `${n.press.plugin}:${p.key ?? ""}` : null;
    const drawn = typeof p.value === "string" ? p.value : null;
    const mine = key ? this.picks.get(key) : null;
    const value = mine && mine.drawn === drawn ? mine.value : drawn;
    return h_flex().w_full().gap(8).items_center().flex_wrap()
      .when(Boolean(p.label), (e) => e.child(div().flex_none().text_color(t.muted).child(String(p.label))))
      .child(h_flex().gap(2).p(2).rounded(8).bg(alpha(t.border, 0.35)).flex_wrap().children(options.map((o, i) => {
        const on = o.value === value;
        return div().id(`${id}-o${i}`).h(24).px(9).flex().items_center().rounded(6).cursor_pointer().text_size(12)
          .text_color(on ? t.foreground : t.muted).when(on, (e) => e.bg(t.background).shadow_sm())
          .hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            if (on || !n.press) return;
            if (key) this.picks.set(key, { value: o.value, drawn });
            this.act({ action: "select", ...n.press, key: p.key, value: o.value }, cx);
            cx.notify();
          })
          .child(String(o.label ?? o.value));
      })));
  }
}

function align(el, v, map) {
  const m = v ? map[v] : null;
  return m && typeof el[m] === "function" ? el[m]() : el;
}

// padding / margin and their X, Y, Top, Bottom, Left, Right forms, in cells or steps.
function edges(el, p, name, short) {
  const all = space(p[name], "y");
  const x = space(p[`${name}X`] ?? p[name], "x");
  const y = space(p[`${name}Y`] ?? p[name], "y");
  const side = (s, axis) => space(p[`${name}${s}`], axis);
  const t = side("Top", "y") ?? y, b = side("Bottom", "y") ?? y, l = side("Left", "x") ?? x, r = side("Right", "x") ?? x;
  if (all === null && x === null && y === null && t === null && b === null && l === null && r === null) return el;
  if (t !== null) el = el[`${short}t`](t);
  if (b !== null) el = el[`${short}b`](b);
  if (l !== null) el = el[`${short}l`](l);
  if (r !== null) el = el[`${short}r`](r);
  return el;
}

function styled(el, s, t, c) {
  let fg = modColor(s.color, t);
  let bg = modColor(s.backgroundColor, t);
  if (s.inverse) [fg, bg] = [bg ?? t.background, fg ?? t.foreground];
  if (fg) el = el.text_color(fg);
  if (bg) el = el.bg(bg).px(2).rounded(3);
  if (s.dimColor) el = el.opacity(0.6);
  if (s.size && TEXT_SIZE[s.size]) el = el.text_size(TEXT_SIZE[s.size]);
  const weight = s.weight ?? (s.bold ? "semibold" : null);
  if (weight === "medium") el = el.font_medium();
  else if (weight === "semibold") el = el.font_semibold();
  else if (weight === "bold") el = el.font_bold();
  if (s.mono) el = el.font_family(c.mono);
  if (s.italic) el = el.italic();
  if (s.underline) el = el.text_decoration_1();
  if (s.strikethrough) el = el.line_through();
  return el;
}
