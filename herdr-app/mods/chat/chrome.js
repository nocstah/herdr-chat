// What sits around the composer (visual-v2.md §1, §4): the footer row's
// controls (model and thinking chips, the context meter, extension status
// chips with their "+N" popover), the widget trays, the queue
// lanes, the plan strip, and the empty state's title.
// Extension-agnostic: statuses and widgets are shown by key, as sent.

import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Popover, Scrollbar } from "gpui-base";
import { MOD, alpha, count, icon, money, monoFont, plural, providerIcon, spans, spansText, spinner, unwrapHc } from "./util.js";
import { keyHint, withKey } from "./shortcuts.js";
import { planProgress, planSteps } from "./cards.js";
import { MAC } from "./platform.js";
import { bgDetailEmpty, bgDetailLines, bgRows, bgSummary } from "./background.js";
import { flavorPalette, toolVerb } from "./flavor.js";

const ACTIVITY_ICON = { bash: "terminal", read: "file-text", edit: "pencil", write: "file-plus", search: "search", web: "globe", agent: "bot", script: "code", wait: "clock", generic: "wrench" };

const STATUS_MAX = 28;
const STATUS_W = (text) => Math.min(STATUS_MAX, [...text].length) * 6.3 + 18;

function ring(pct, t) {
  const p = Math.max(0, Math.min(100, Math.round((pct ?? 0) / 5) * 5));
  const color = pct > 90 ? t.ansi1 : pct > 75 ? t.blocked : t.muted;
  return svg(`mods/${MOD}/icons/ring/${p}.svg`).size(14).flex_none().text_color(color);
}

function chipEl(id, t, { tip, onClick, active } = {}) {
  let el = h_flex().id(id).h(28).px(8).gap(6).items_center().rounded(8).text_size(12).text_color(active ? t.foreground : t.muted)
    .flex_none();
  if (onClick) el = el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick);
  if (active) el = el.bg(t.hover);
  if (tip) el = el.tooltip(tip);
  return el;
}

function surface(t) {
  return v_flex().p(4).gap(1).rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_md();
}

// Under the composer, as the Claude app has it: where the chat works on the left (its folder, the branch,
// extension statuses), what it runs with on the right (the context, the model with its effort, the
// permission mode). `v` is the view (main.js); `width` the column's. Narrow columns get less:
//   xs (< 200 px, a ~240 px column): the folder's icon, the context ring, the model;
//   sm (< 300 px): and the folder's name, the mode;   md (< 520 px): and the effort, the statuses as they fit;
//   full: and the context's % and the cost.
export function footerTier(width) {
  return width < 200 ? "xs" : width < 300 ? "sm" : width < 520 ? "md" : "full";
}

// The Claude app's words for the permission modes and effort levels: an agent's own labels (its
// capabilities) win; the terminal view, where the TUI owns them, has only the ids.
const MODE_LABELS = { default: "Manual", acceptEdits: "Accept edits", "accept-edits": "Accept edits", plan: "Plan", auto: "Auto", bypassPermissions: "Bypass", dontAsk: "Don't ask" };
const EFFORT_LABELS = { minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
export const effortLabel = (level) => (level && level !== "default" ? EFFORT_LABELS[level] ?? cap(level) : null);
export const modeLabel = (id, modes) => (id ? modes?.find((m) => m.id === id)?.label ?? MODE_LABELS[id] ?? cap(id) : null);

// "claude-opus-5-5" (a terminal's transcript names the model by its id) → "Opus 5.5"; "Claude Haiku 4.5" →
// "Haiku 4.5", as the Claude app says them; any other name as it is.
export function modelLabel(name) {
  const id = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i.exec(String(name));
  return id ? `${cap(id[1].toLowerCase())} ${id[2]}${id[3] ? `.${id[3]}` : ""}` : shortModel(name);
}

function underChip(id, t, { tip, onClick, color } = {}) {
  let el = h_flex().id(id).h(24).px(6).gap(5).items_center().rounded(6).text_size(12.5).text_color(color ?? t.muted).flex_none();
  if (onClick) el = el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(onClick);
  if (tip) el = el.tooltip(tip);
  return el;
}

export function underRow(v, t, { width }) {
  const s = v.store.state;
  const caps = s.capabilities ?? null; // what this agent can do (null until the host says)
  const tier = footerTier(width);
  v.footerTier = tier;
  const tiny = tier === "xs", small = tiny || tier === "sm";
  const drawn = []; // what it draws, by name (the dump: footerChips)

  // Left: the folder (a click copies its path), its branch, the statuses.
  const left = [];
  const cwd = (s.cwd || v.cwd || "").replace(v.homeDir, "~");
  if (cwd) {
    const name = cwd === "~" || cwd === "/" ? cwd : cwd.split("/").filter(Boolean).at(-1) ?? cwd;
    left.push(underChip("folder", t, { tip: `${cwd} · click to copy`, onClick: (_e, cx) => v.control("folder", cx) }).flex_shrink(1).min_w(0)
      .child(icon("folder", 13))
      .when(!tiny, (e) => e.child(div().min_w(0).max_w(Math.max(60, Math.round(width * 0.3))).truncate().child(name))));
    drawn.push("folder");
  }
  const branch = tiny ? null : branchChip(v, t, { width: Math.round(width * 0.6) });
  if (branch) left.push(branch);

  // Right: the context, the model and its effort, the mode.
  const right = [];
  const u = s.usage;
  const cost = caps?.cost === false || tier !== "full" ? null : u?.cost ?? null;
  if (u && (u.percent != null || cost != null)) {
    const win = u.contextWindow ?? s.model?.contextWindow ?? null;
    const tip = [
      u.percent != null ? `${Math.round(u.percent)}% of the context window` : null,
      u.contextTokens != null ? `${count(u.contextTokens)}${win ? ` / ${count(win)}` : ""} tokens` : null,
      (caps?.cost === false ? null : u?.cost ?? null) != null ? `${money(u.cost)} this session` : null,
    ].filter(Boolean).join(" · ");
    right.push(underChip("chip-context", t, { tip })
      .when(u.percent != null, (e) => e.child(ring(u.percent, t)).when(tier === "full", (x) => x.child(div().text_size(11.5).child(`${Math.round(u.percent)}%`))))
      .when(cost != null, (e) => e.child(div().text_size(11.5).text_color(t.dim).child(money(cost)))));
    drawn.push("context", ...(cost != null ? ["cost"] : []));
  }
  const name = s.model?.name ?? s.model?.id ?? null;
  const modelTip = withKey(`${v.providerName()}${s.model ? ` · ${name} (${s.model.provider}/${s.model.id})` : ""} · /model`, "model");
  right.push(underChip("chip-model", t, { tip: modelTip, color: t.foreground, onClick: (_e, cx) => v.control("chip:model", cx) })
    .child(div().max_w(small ? 90 : 160).truncate().child(name ? modelLabel(name) : "Model")));
  drawn.push("model");
  // The effort: the agent's own picker where it has one; in the terminal view, the TUI's /model (where Claude Code sets it).
  const pickEffort = caps?.thinkingLevels?.length > 0;
  const effort = effortLabel(s.thinking) ?? (pickEffort ? "Effort" : null);
  if (effort && !small) {
    right.push(underChip("chip-thinking", t, { color: t.dim,
      tip: pickEffort ? withKey(withKey(`Effort: ${effort} · /thinking`, "effort"), "cycleEffort") : `Effort: ${effort} · /model in ${v.providerName()} changes it`,
      onClick: (_e, cx) => v.control(pickEffort ? "chip:thinking" : "chip:model", cx) }).child(effort));
    drawn.push("thinking");
  }
  const modes = caps?.permissionModes ?? [];
  const mode = modeLabel(s.permissionMode, modes);
  if (mode && !tiny) {
    const m = modes.find((x) => x.id === s.permissionMode);
    const modeColor = flavorPalette(t).mode(s.permissionMode);
    right.push(underChip("chip-permission", t, modes.length
      ? { color: modeColor, tip: withKey(withKey(`${mode}: ${m?.description ?? "Permission mode"} · click to change`, "mode"), "cycleMode"), onClick: (_e, cx) => v.control("chip:permission", cx) }
      : { color: modeColor, tip: `Permission mode: ${mode} · Shift+Tab in ${v.providerName()} changes it` })
      .ml(4).child(div().max_w(small ? 70 : 110).truncate().child(mode)));
    drawn.push("permission");
  }
  v.footerChips = drawn;

  // Statuses: as many chips as fit between the two sides, then "+N".
  const rightW = right.length * 70 + (name ? Math.min(modelLabel(name).length * 7, 160) : 40);
  let room = small ? 0 : Math.max(0, width - rightW - 120 - (branch ? 100 : 0));
  const list = caps?.extensionUi === false ? [] : v.visibleStatuses();
  const shown = [];
  for (const x of list) {
    const w = STATUS_W(x.text);
    if (w > room && shown.length < list.length) break;
    room -= w + 4;
    shown.push(x);
  }
  const extra = list.length - shown.length + (caps?.extensionUi === false ? 0 : v.hiddenStatuses().length);
  v.footerStatuses = { shown: shown.map((x) => x.key), extra }; // (the dump)
  const chips = shown.map((x) => {
    const short = [...x.text].length > STATUS_MAX ? [...x.text].slice(0, STATUS_MAX - 1).join("") + "…" : x.text;
    return chipEl(`status-${x.key}`, t, { tip: `${x.key}: ${x.text}` }).h(24).px(6).text_size(11.5).cursor_pointer().hover((st) => st.bg(t.hover))
      .child(spans(short === x.text ? x.spans : [{ text: short }], t, t.dim));
  });
  if (extra > 0) chips.push(chipEl("status-more", t, { tip: "All extension statuses", active: v.statusesOpen }).h(24).px(6).text_size(11.5)
    .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).child(`+${extra}`));
  // The chips are the popover's trigger: a click on any lists them all (and hides some).
  if (chips.length) {
    left.push(Popover.new("statuses").anchor("bottom_left").open(Boolean(v.statusesOpen))
      .on_open_change((open, cx) => v.setStatusesOpen(open, cx))
      .trigger(h_flex().id("statuses").gap(2).items_center().children(chips))
      .content(statusesPopover(v, t)));
  }
  return h_flex().id("under-row").w_full().h(26).gap(8).items_center().overflow_hidden()
    .child(h_flex().flex_1().min_w(0).gap(2).items_center().overflow_hidden().children(left))
    .child(h_flex().flex_none().gap(0).items_center().children(right));
}

// The composer's + (bottom left, as the Claude app has it): what can go into a message: uploaded files
// (native file picker), a workspace file mention (@), a command (/), or an image from the clipboard.
export function plusButton(v, t) {
  const item = (id, name, label, hint) => h_flex().id(`plus-${id}`).h(30).px(8).gap(10).items_center().rounded(7).cursor_pointer().text_size(13)
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => v.control(`plus:${id}`, cx))
    .child(icon(name, 14).text_color(t.muted)).child(div().flex_1().child(label))
    .child(div().text_size(11.5).text_color(t.dim).child(hint));
  return Popover.new("plus").anchor("bottom_left").open(Boolean(v.plusOpen))
    .on_open_change((open, cx) => v.setPlusOpen(open, cx))
    .trigger(h_flex().id("compose-plus").w(30).h(30).flex_none().rounded(8).items_center().justify_center().cursor_pointer()
      .text_color(v.plusOpen ? t.foreground : t.muted).when(Boolean(v.plusOpen), (e) => e.bg(t.hover))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Add to the message")
      .child(icon("plus", 16)))
    .content(surface(t).w(220)
      .child(item("upload", "file-plus", "Upload files…", ""))
      .child(item("file", "at-sign", "Mention a file", "@"))
      .child(item("command", "square-slash", "Commands", "/"))
      .child(item("image", "image", "Paste an image", MAC ? "⌘V" : "Ctrl+V")));
}

// The mic (where the Claude app has it): starts or stops the desktop's dictation, the toggle Omarchy's
// dictation keys run (omarchy-dictation), which types into the composer. None where there isn't one.
export function micButton(v, t) {
  if (!v.dictation) return null;
  return h_flex().id("compose-mic").w(30).h(30).flex_none().rounded(8).items_center().justify_center().cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Dictate (starts or stops dictation)")
    .on_click((_e, cx) => v.control("dictate", cx)).child(icon("mic", 15));
}

// "Claude Haiku 4.5" → "Haiku 4.5"; "GPT-5.6 Luna" → "GPT-5.6 Luna" (no vendor word to drop).
function shortModel(name) {
  return String(name).replace(/^(Claude|Anthropic|OpenAI|Google)\s+/i, "");
}

function statusesPopover(v, t) {
  const all = v.store.state.statuses.filter((x) => spansText(x.spans).trim());
  const hidden = new Set(v.hiddenStatuses().map((x) => x.key));
  const rows = all.filter((x) => v.showHidden || !hidden.has(x.key)).map((x) => {
    const off = hidden.has(x.key);
    return h_flex().id(`st-row-${x.key}`).min_h(30).px(8).py(4).gap(10).items_start().rounded(7).hover((s) => s.bg(t.hover))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().text_size(11).text_color(t.dim).child(x.key))
        .child(div().text_size(12).opacity(off ? 0.5 : 1).child(spans(x.spans, t, t.foreground))))
      .child(div().id(`st-hide-${x.key}`).mt(2).p(3).rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground).bg(t.raised))
        .tooltip(off ? "Show in the footer" : "Hide from the footer")
        .on_click((_e, cx) => v.control(`status:${off ? "show" : "hide"}:${x.key}`, cx)).child(icon(off ? "eye" : "eye-off", 12)));
  });
  return surface(t).w(340).max_h(360)
    .child(div().px(8).pt(4).pb(2).text_size(11).text_color(t.dim).child("Extension status"))
    .children(rows)
    .when(hidden.size > 0, (e) => e.child(h_flex().id("st-show-hidden").h(28).px(8).items_center().rounded(7).cursor_pointer().text_size(11.5).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => v.control("status:toggle-hidden", cx))
      .child(v.showHidden ? "Hide the hidden ones" : `Show hidden (${hidden.size})`)));
}

// A widget's summary: its first line that says something (not only
// box-drawing, dashes or blanks).
const DECOR = /^[\s\u2500-\u259f\-=_~*·•.:|+#]*$/;
const RULED = /^[\u2500-\u259f\-=_~]{2,}.*[\u2500-\u259f\-=_~]{2,}$/; // "── queue ──": a heading rule
export function widgetSummary(w) {
  const line = w.lines.map((l) => spansText(l).trim()).find((x) => x && !DECOR.test(x) && !RULED.test(x));
  return line ?? w.key;
}

// Widgets (setWidget). All closed: one quiet line of their summaries.
// One open: a tray, each widget a row (summary, key dim) that opens to its lines.
export function widgetTray(v, list, t) {
  if (!list.length) return null;
  if (!list.some((w) => v.widgetOpen(w.key))) {
    return h_flex().w_full().h(22).px(6).gap(6).items_center().text_size(11.5).text_color(t.dim)
      .children(list.map((w, i) => h_flex().id(`widget-${w.key}`).min_w(0).gap(5).items_center().px(4).rounded(5).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.muted)).tooltip(`${w.key} · click to open`)
        .on_click((_e, cx) => v.control(`widget:${w.key}`, cx))
        .child(icon("chevron-right", 10)).child(div().min_w(0).truncate().child(widgetSummary(w)))));
  }
  return v_flex().w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .children(list.map((w, i) => {
      const open = v.widgetOpen(w.key);
      return v_flex().when(i > 0, (e) => e.border_t_1().border_color(alpha(t.border, 0.6)))
        .child(h_flex().id(`widget-${w.key}`).h(28).px(10).gap(8).items_center().cursor_pointer().text_size(12)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => v.control(`widget:${w.key}`, cx))
          .child(icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(open ? "" : widgetSummary(w)))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(w.key)))
        .when(open, (e) => e.child(v_flex().px(10).pb(8).pl(29).gap(1).text_size(12).children(w.lines.map((l) => spans(l, t, t.muted)))));
    }));
}

// Queued steers and follow-ups: [label, text]. A subagent's report (an
// `hc send`, queue.steeringFrom / followUpFrom in protocol v3.1, else the
// text's `<hc from=…>` envelope) says so: "Report from t7 review".
export function queueLabels(s) {
  const label = (k, x, from) => {
    const env = unwrapHc(x);
    const who = from ?? env.from;
    return who ? [`Report from ${who}`, (env.from ? env.text : x).trim()] : [k, x];
  };
  return [...s.queue.steering.map((x, i) => label("Steer", x, s.queue.steeringFrom?.[i])),
    ...s.queue.followUp.map((x, i) => label("Follow-up", x, s.queue.followUpFrom?.[i]))];
}

// The two lanes just above the composer (protocol v3.2), each first in,
// first out: steering (blue, the agent's next turn), then the follow-ups
// (yellow, after this run). A row the host can take back (queue.*Removable)
// opens for editing on a click, and has ⇄ (to the other lane) and ×.
// A report's row says who sent it.
export function queueChips(v, s, t) {
  const q = s.queue ?? {};
  const lane = (kind, texts, ids, removable, from, color, iconName, title, { sendNow = false } = {}) => {
    if (!texts?.length) return null;
    const rows = texts.map((x, i) => {
      const id = ids?.[i] ?? null;
      const can = Boolean(id && removable?.[i]);
      const env = unwrapHc(x);
      const who = from?.[i] ?? env.from;
      const text = (env.from ? env.text : x).trim();
      const btn = (name, tip, what) => div().id(`queued-${name}-${kind}-${i}`).flex_none().p(3).rounded(5).cursor_pointer().text_color(t.dim)
        .hover((st) => st.text_color(t.foreground).bg(t.hover)).tooltip(tip)
        .on_click((_e, cx) => { cx.stop_propagation(); v.control(`queue:${what}:${id}`, cx); })
        .child(icon(name === "move" ? "arrow-left-right" : "x", 11.5));
      const editBtn = can ? h_flex().id(`queued-edit-${kind}-${i}`).flex_none().h(20).px(6).gap(4).items_center().rounded(5).cursor_pointer()
        .bg(alpha(color, 0.14)).text_size(11).font_medium().text_color(color)
        .hover((st) => st.bg(alpha(color, 0.24)).text_color(t.foreground))
        .tooltip("Put back in the composer to edit")
        .on_click((_e, cx) => { cx.stop_propagation(); v.control(`queue:edit:${id}`, cx); })
        .child(icon("pencil", 10))
        .child("Edit") : null;
      return h_flex().id(`queued-${kind}-${i}`).min_h(26).pl(10).pr(4).gap(6).items_center().text_size(12)
        .when(i > 0, (e) => e.border_t_1().border_color(alpha(color, 0.18)))
        .when(can, (e) => e.cursor_pointer().hover((st) => st.bg(alpha(color, 0.1))).tooltip("Click to edit it in the composer")
          .on_click((_e, cx) => v.control(`queue:edit:${id}`, cx)))
        .when(Boolean(who), (e) => e.child(div().flex_none().text_color(t.dim).child(`Report from ${who}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(text))
        .when(can, (e) => e
          .child(editBtn)
          .child(btn("move", kind === "steer" ? "Move to the follow-ups (after this run)" : "Steer with it now (next turn)", "move"))
          .child(btn("remove", "Remove from the queue", "remove")));
    });
    const sending = Boolean(v.sendingNow);
    const sendBtn = sendNow ? h_flex().id(`queued-send-now-${kind}`).flex_none().h(18).px(6).gap(4).items_center().rounded(5)
      .bg(alpha(color, 0.16)).text_color(color).font_medium()
      .when(sending, (e) => e.opacity(0.75))
      .when(!sending, (e) => e.cursor_pointer().hover((st) => st.bg(alpha(color, 0.28)).text_color(t.foreground))
        .tooltip(withKey("Send queued message immediately", "sendNow"))
        .on_click((_e, cx) => { cx.stop_propagation(); v.control("queue:send-now", cx); }))
      .child(sending ? spinner(10, color) : icon("arrow-up", 10.5))
      .child(sending ? "Sending…" : "Send immediately") : null;
    return v_flex().w_full().rounded(10).border_1().border_color(alpha(color, 0.35)).bg(alpha(color, 0.07)).overflow_hidden()
      .child(h_flex().h(24).pl(10).pr(sendBtn ? 4 : 10).gap(6).items_center().text_size(11).text_color(color)
        .child(icon(iconName, 11))
        .child(div().min_w(0).truncate().child(title))
        .when(texts.length > 1, (e) => e.child(div().flex_none().text_color(t.dim).child(`· ${texts.length}`)))
        .when(Boolean(sendBtn), (e) => e.child(div().flex_1()).child(sendBtn)))
      .children(rows);
  };
  const steer = lane("steer", q.steering, q.steeringIds, q.steeringRemovable, q.steeringFrom, t.ansi4, "corner-up-right", "Steer: next turn", { sendNow: Boolean(q.steeringSendNow) });
  const follow = lane("followUp", q.followUp, q.followUpIds, q.followUpRemovable, q.followUpFrom, t.ansi3, "clock", "Follow-up: after this run");
  if (!steer && !follow) return null;
  return v_flex().w_full().gap(6).children([steer, follow].filter(Boolean));
}

// The plan strip, right above the composer: "2/5", a progress bar and the
// current step. A click opens the full list above it; another closes it.
export function planStrip(v, s, t) {
  const plan = s.plan;
  if (!plan?.steps?.length) return null;
  const { done, total, current } = planProgress(plan);
  const finished = done === total;
  const open = v.planOpen;
  const BAR = 56;
  const head = h_flex().id("plan-strip").h(28).px(10).gap(8).items_center().text_size(12).cursor_pointer()
    .hover((st) => st.bg(t.hover)).tooltip(open ? "Hide the steps" : "Show every step")
    .on_click((_e, cx) => v.control("plan", cx))
    .child(icon(finished ? "circle-check" : "list-checks", 12).text_color(finished ? t.ansi2 : t.dim))
    .child(div().flex_none().text_color(t.muted).child(finished ? `${total}/${total} done` : `${done}/${total}`))
    .child(div().flex_none().w(BAR).h(4).rounded(2).bg(alpha(t.muted, 0.2))
      .child(div().h_full().rounded(2).w(Math.round((BAR * done) / total)).bg(finished ? t.ansi2 : t.accent)))
    .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(finished ? "" : current ?? ""))
    .child(icon(open ? "chevron-down" : "chevron-up", 11).text_color(t.dim));
  return v_flex().w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .when(open, (e) => e.child(div().id("plan-steps").max_h(240).overflow_y_scroll().px(12).py(10).border_b_1().border_color(alpha(t.border, 0.6))
      .child(planSteps(plan, t))))
    .child(head);
}

function clockTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Expandable live activity/info scrollback above the composer (Ctrl+O), preserving
// every status/thinking update and tool call of the current or most recent run.
export function activityDrawer(v, s, t) {
  if (!v.supportsActivity?.() || !v.activityOpen) return null;
  const entries = Array.isArray(s.activityLog) ? s.activityLog : [];
  const working = v.store.working();
  if (!working && !entries.length) return null;
  const mono = monoFont();
  const hint = keyHint("expandInfo");
  const f = flavorPalette(t);
  const rows = entries.length
    ? entries.map((e, i) => {
      const newest = i === entries.length - 1;
      const live = newest && working;
      const isTool = e.kind === "tool";
      const sp = isTool ? toolVerb(e.text) : null;
      const kind = sp?.kind ?? "generic";
      const verbCol = f.tool(kind);
      const mark = live
        ? div().flex_none().pt(3).child(spinner(10, t.working))
        : isTool
          ? div().flex_none().pt(3).child(icon(ACTIVITY_ICON[kind] ?? "wrench", 10).text_color(verbCol))
          : div().flex_none().pt(6).child(div().size(4).rounded(2).bg(newest ? f.thinking : f.thinkingRail));
      const body = sp
        ? h_flex().flex_1().min_w(0).gap(5).items_start().font_family(mono).text_size(11.5)
            .child(div().flex_none().font_medium().text_color(verbCol).child(sp.verb))
            .when(Boolean(sp.rest), (el) => el.child(div().flex_1().min_w(0).whitespace_normal().text_color(live ? t.foreground : t.muted).child(sp.rest)))
        : div().flex_1().min_w(0).whitespace_normal()
            .when(isTool, (el) => el.font_family(mono).text_size(11.5))
            .text_color(live ? t.foreground : t.muted)
            .child(e.text);
      return h_flex().id(`act-entry-${i}`).flex_none().gap(8).items_start().text_size(12).line_height("17px")
        .child(div().flex_none().font_family(mono).text_size(10.5).pt(1).text_color(t.dim).child(clockTime(e.ts)))
        .child(mark)
        .child(body);
    })
    : [div().text_size(12).text_color(t.dim).child(working ? "Waiting for activity updates…" : "No activity info recorded for this turn.")];
  const head = h_flex().id("activity-strip").h(28).px(10).gap(8).items_center().text_size(12).cursor_pointer()
    .hover((st) => st.bg(t.hover)).tooltip(withKey("Collapse activity log", "expandInfo"))
    .on_click((_e, cx) => v.control("activity:toggle", cx))
    .child(working ? spinner(11, t.working) : icon("info", 12).text_color(f.bullet))
    .child(div().flex_none().font_medium().text_color(working ? f.thinking : t.muted).child("Activity"))
    .when(entries.length > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(`· ${plural(entries.length, "update")}`)))
    .child(div().flex_1())
    .when(!v.activityFollow && entries.length > 1, (el) => el.child(div().id("activity-latest").px(6).py(1).rounded(5).text_size(11).text_color(t.accent)
      .hover((st) => st.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); v.control("activity:latest", cx); }).child("↓ Latest")))
    .when(Boolean(hint), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(hint)))
    .child(icon("chevron-down", 11).text_color(t.dim));
  // Use plain overflow_y_scroll() + paired Scrollbar.vertical() rather than overflow_y_scrollbar():
  // gpui-kit's Scrollable wrapper clones max_h() onto both the viewport and inner content box, which clamps
  // content height to max_h and prevents scrolling when entries overflow.
  return v_flex().id("activity-drawer").w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .child(div().relative().w_full().border_b_1().border_color(alpha(t.border, 0.6))
      .child(v_flex().id("activity-log").w_full().max_h(240).overflow_y_scroll().track_scroll(v.activityScroll).pl(10).pr(14).py(8).gap(4)
        .on_scroll_wheel((e, cx) => { if (e.delta.y > 0 && v.activityFollow) { v.activityFollow = false; cx.notify(); } })
        .children(rows))
      .child(Scrollbar.vertical("activity-log").absolute().inset_0()))
    .child(head);
}

// What the agent runs in the background (protocol v3.8, state.background), right above the composer, as Claude Code's
// agents panel shows it under its prompt: "main", then a row per background agent (its type, its task, what it does
// now, the worktree's branch, the time, its tokens) and per workflow run (its name, a bar of the agents that
// answered, done/total, the time, the tokens); the shells and monitors are counted in the heading, as in the TUI's
// footer. An ended task stays a moment, marked. A click on the heading folds the rows. A command Claude Code runs is a
// row of its own (v3.9: its command, its last output line), as under the TUI's ↓; a click on a row opens it under
// itself, as the TUI's tasks list does: a command's output as it grows (Stop, the whole output in the file viewer), an
// agent's last steps, a run's agents (main.js bgOpen, read once a second while open).
export function backgroundStrip(v, s, t) {
  const b = s.background;
  if (!b?.tasks?.length && !b?.shells && !b?.monitors) return null;
  // The host's clock: its time when it sent this, moved on by the time since it came.
  if (v.bgSeen !== b) {
    v.bgSeen = b;
    v.bgSkew = Date.now() - b.at;
  }
  const now = Date.now() - (v.bgSkew ?? 0);
  const rows = bgRows(b, now);
  v.bgShown = rows; // (the dump)
  const open = !v.bgClosed && rows.length > 0;
  const BAR = 48;
  const working = v.store.working();
  const bullet = (state) => {
    const color = state === "failed" ? t.ansi1 : state === "stopped" ? t.blocked : state === "done" ? t.ansi2 : t.dim;
    return state === "done" ? icon("check", 11).text_color(color) : state === "failed" || state === "stopped" ? icon("x", 11).text_color(color)
      : div().flex_none().size(7).rounded(4).border_1().border_color(t.muted);
  };
  const mono = monoFont();
  const openId = v.bgOpenId ?? null;
  const line = (r) => h_flex().id(`bg-${r.id}`).h(22).px(10).gap(7).items_center().text_size(12).cursor_pointer()
    .when(r.id === openId, (e) => e.bg(t.hover)).hover((st) => st.bg(t.hover))
    .on_click((_e, cx) => v.control(`bg:open:${r.id}`, cx))
    .tooltip([r.name, r.title, r.worktree && `worktree ${r.worktree}`, r.activity, r.meta].filter(Boolean).join(" · "))
    .child(div().flex_none().w(12).flex().justify_center().child(bullet(r.state)))
    .child(r.command ? icon(r.kind === "monitor" ? "eye" : "terminal", 11).text_color(t.dim)
      : div().flex_none().max_w(180).truncate().text_color(r.state === "running" ? t.muted : t.dim).child(r.name))
    .when(Boolean(r.title), (e) => e.child(div().min_w(40).max_w(r.command ? 320 : 260).truncate().when(r.command, (x) => x.font_family(mono).text_size(11.5))
      .text_color(r.state === "running" ? t.foreground : t.dim).child(r.title)))
    .when(r.progress !== null, (e) => e.child(div().flex_none().w(BAR).h(4).rounded(2).bg(alpha(t.muted, 0.2))
      .child(div().h_full().rounded(2).w(Math.round(BAR * r.progress)).bg(r.state === "failed" ? t.ansi1 : r.state === "done" ? t.ansi2 : t.accent))))
    .when(Boolean(r.worktree), (e) => e.child(h_flex().flex_none().max_w(140).gap(3).items_center().text_size(11).text_color(t.dim)
      .child(icon("git-branch", 10)).child(div().min_w(0).truncate().child(r.worktree))))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(r.activity))
    .child(div().flex_none().text_size(11.5).text_color(r.state === "failed" ? t.ansi1 : t.dim).child(r.meta));
  const head = h_flex().id("bg-strip").h(26).px(10).gap(8).items_center().text_size(12).cursor_pointer()
    .hover((st) => st.bg(t.hover)).tooltip(open ? "Fold the background tasks" : "Show the background tasks")
    .on_click((_e, cx) => v.control("background", cx))
    .child(icon("bot", 12).text_color(t.dim))
    .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(bgSummary(b)))
    .when(rows.length > 0, (e) => e.child(icon(open ? "chevron-down" : "chevron-up", 11).text_color(t.dim)));
  const main = h_flex().id("bg-main").h(22).px(10).gap(7).items_center().text_size(12)
    .child(div().flex_none().w(12).flex().justify_center().child(div().size(7).rounded(4).bg(working ? t.accent : t.muted)))
    .child(div().text_color(t.foreground).child("main"))
    .child(div().text_size(11.5).text_color(t.dim).child(working ? "working" : "idle"));
  const shownOpen = open && rows.some((r) => r.id === openId);
  const rowsAndDetail = rows.flatMap((r) => (r.id === openId ? [line(r), bgDetail(v, r, t, mono)] : [line(r)]));
  return v_flex().w_full().rounded(10).border_1().border_color(t.border).bg(t.surface).overflow_hidden()
    .when(open, (e) => e.child(v_flex().id("bg-rows").py(4).max_h(shownOpen ? 380 : 200).overflow_y_scroll().border_b_1().border_color(alpha(t.border, 0.6))
      .child(main).children(rowsAndDetail)))
    .child(head);
}

// An opened row (backgroundStrip): what it did so far, read from the host once a second (main.js bgFetch).
function bgDetail(v, r, t, mono) {
  const d = v.bgDetail?.id === r.id ? v.bgDetail : null;
  // As many lines as the box shows without scrolling (12 × 17 px under its 240): the newest at its foot.
  const lines = d && !d.error ? bgDetailLines(d, 12) : [];
  const button = (id, label, what, color = t.muted) => div().id(id).h(22).px(8).rounded(6).flex().items_center().text_size(11.5).text_color(color)
    .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => v.control(what, cx)).child(label);
  const command = r.command && d?.title;
  const body = lines.length
    ? v_flex().children(lines.map((l, i) => {
      if (l.kind === "output") return div().id(`bgl-${i}`).font_family(mono).text_size(11.5).line_height("17px").text_color(t.muted).truncate().child(l.text || " ");
      if (l.kind === "tool") return h_flex().gap(6).items_center().text_size(11.5).text_color(t.muted)
        .child(icon("wrench", 10).text_color(t.dim)).child(div().min_w(0).truncate().font_family(mono).child(l.text));
      if (l.kind === "text") return div().text_size(12).text_color(t.foreground).truncate().child(l.text);
      // A run's agent.
      return h_flex().gap(6).items_center().text_size(12)
        .child(l.kind === "running" ? spinner(10, t.working ?? t.accent) : icon(l.kind === "failed" ? "x" : "check", 10).text_color(l.kind === "failed" ? t.ansi1 : t.ansi2))
        .child(div().min_w(0).truncate().text_color(l.kind === "running" ? t.foreground : t.dim).child(l.text));
    }))
    : div().text_size(11.5).text_color(t.dim).child(bgDetailEmpty(d));
  const actions = h_flex().gap(4).items_center()
    .when(Boolean(d?.cut), (e) => e.child(div().text_size(11).text_color(t.dim).child("… earlier output")))
    .child(div().flex_1())
    .when(Boolean(d?.stoppable), (e) => e.child(button(`bg-stop-${r.id}`, "Stop", `bg:stop:${r.id}`, t.ansi1)))
    .when(Boolean(d?.outputFile), (e) => e.child(button(`bg-file-${r.id}`, "Whole output", `bg:output:${r.id}`)))
    .child(button(`bg-close-${r.id}`, "Close", `bg:open:${r.id}`));
  return v_flex().id(`bg-open-${r.id}`).mx(10).mt(2).mb(6).px(10).py(8).gap(6).rounded(8).bg(t.background).border_1().border_color(alpha(t.border, 0.8))
    .when(Boolean(command), (e) => e.child(h_flex().gap(8).font_family(mono).text_size(11.5).line_height("17px")
      .child(div().flex_none().text_color(t.dim).child("$")).child(div().flex_1().min_w(0).text_color(t.foreground).child(command))))
    .child(div().id(`bg-body-${r.id}`).max_h(240).overflow_y_scroll().child(body))
    .child(actions);
}

// The branch of the chat's folder (host git.ts, state.git), beside the folder under the composer; a
// detached HEAD shows its commit. A click copies it.
export function branchChip(v, t, { width }) {
  const g = v.store.state.git;
  const name = g?.name ?? null;
  v.branchShown = name;
  if (!name) return null;
  const f = flavorPalette(t);
  return h_flex().id("branch").flex_shrink(1).max_w(Math.max(60, Math.round(width * 0.45))).min_w(0).h(24).px(6).gap(5).items_center()
    .rounded(6).text_size(12.5).text_color(f.branch).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => v.control("branch", cx))
    .child(icon(g.detached ? "git-commit" : "git-branch", 11))
    .child(div().min_w(0).truncate().child(name));
}

// A new chat: the agent's name and the folder it runs in.
export function emptyState(v, t) {
  const s = v.store.state;
  const cwd = (s.cwd || v.cwd || "").replace(v.homeDir, "~");
  return v_flex().items_center().gap(6).pb(20)
    .child(h_flex().gap(10).items_center().text_color(t.foreground)
      .child(providerIcon(v.providerId(), 26))
      .child(div().text_size(28).font_semibold().child(v.providerName())))
    .child(div().text_size(12.5).text_color(t.dim).child(cwd));
}
