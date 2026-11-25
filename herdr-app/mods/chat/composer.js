// The composer: a growing Textarea, its key bindings, the slash and @file
// menus, image chips and prompt history. The view owns what Enter, Esc and
// the menus do (main.js `actions`); this keeps the text state and the keys.
//
// Keys (spike d): the Textarea takes Up/Down/Enter before any on_key_down,
// but bindings in a context of ours *around* it ("HerdrChatMenu > Input") win,
// so the wrapper's key_context says which keys we want right now:
//   HerdrChatMenu     a menu is open: ↑ ↓ Enter Tab Esc drive it
//   HerdrChatEmpty    nothing typed (or a recalled prompt): ↑ ↓ walk history
//   HerdrChatComposer text typed: Enter sends (steers while working), Alt+Enter
//                  queues a follow-up, Shift+Enter is a newline
//   HerdrChatAsk      a permission card is open and nothing is typed: 1–9
//                  choose, ↑ ↓ move, Enter answers, Esc denies
//   HerdrChatQuestions the same for a questions card, and Space ticks
// Esc is ours in all of them.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { alpha, fileChip, icon, spinner, thumbnail } from "./util.js";
import { formatMention } from "./file-picker.js";
import { detectInsertedSpan, pasteChipTitle, pastePreviewLine, shouldCollapsePaste } from "./paste.js";
import { follow } from "./menus.js";
import { keyHint } from "./shortcuts.js";
import { MAC } from "./platform.js";

const CONTEXTS = ["HerdrChatMenu", "HerdrChatEmpty", "HerdrChatComposer", "HerdrChatAsk", "HerdrChatQuestions"];
const EXTRA_INPUTS = ["HerdrChatFind", "HerdrChatDialog", "HerdrChatEditor"];
const CARDS = ["HerdrChatAsk", "HerdrChatQuestions"];
const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
// Linux: a terminal app's copy/paste keys. Herdr's text fields copy/paste on Ctrl+C/V only there,
// but desktop terminal-clipboard bindings (Super+C/V -> Ctrl+Shift+C/V), dictation tools and
// clipboard managers send Ctrl+Shift+C/V (or Ctrl/Shift+Insert) to a terminal app's window,
// whatever its pane shows; our chat inputs take them too.
const COPY_KEYS = MAC ? [] : ["ctrl-shift-c", "ctrl-insert"];
const PASTE_KEYS = MAC ? [] : ["ctrl-shift-v", "shift-insert"];
// The composer intercepts standard Ctrl+V / Cmd+V too so large pastes collapse into chips.
const COMPOSER_PASTE_KEYS = [MAC ? "cmd-v" : "ctrl-v", ...PASTE_KEYS];
export const ACTIONS = ["herdrchat_enter", "herdrchat_up", "herdrchat_down", "herdrchat_tab", "herdrchat_escape", "herdrchat_space", ...DIGITS.map((d) => `herdrchat_digit_${d}`)];

// Copies a field's selected slice: true when it copied something.
export function copyField(field, cx) {
  if (!field) return false;
  const r = field.selected_range?.();
  if (!r || r.start === r.end) return false;
  const lo = Math.min(r.start, r.end), hi = Math.max(r.start, r.end);
  const text = String(field.value?.() ?? "").slice(lo, hi);
  if (text) cx.write_to_clipboard(text);
  return Boolean(text);
}

export function pasteField(field, cx) {
  if (!field) return;
  let text;
  try {
    text = cx.read_from_clipboard();
  } catch {}
  if (text) field.replace?.(text);
}

// The composer's bindings in the app's keymap (keymap.js says when).
export function bindComposerKeys(cx) {
  const b = [];
  for (const ctx of CONTEXTS) {
    // Sending (Enter steers, Alt+Enter queues a follow-up) is the `steer` and `followUp` shortcuts
    // (shortcuts.js), so the person can rebind them; in a menu and on an approval card Enter stays ours.
    if (ctx === "HerdrChatMenu" || CARDS.includes(ctx)) b.push({ keystroke: "enter", action: "herdrchat_enter", context: `${ctx} > Input` });
    b.push({ keystroke: "escape", action: "herdrchat_escape", context: ctx });
    // An Input's own Esc (a picker's filter field) would win over the context around it.
    b.push({ keystroke: "escape", action: "herdrchat_escape", context: `${ctx} > Input` });
  }
  for (const ctx of CARDS) for (const d of DIGITS) b.push({ keystroke: d, action: `herdrchat_digit_${d}`, context: `${ctx} > Input` });
  for (const ctx of CONTEXTS) {
    for (const k of COPY_KEYS) b.push({ keystroke: k, action: "herdrchat_copy", context: `${ctx} > Input` });
    for (const k of COMPOSER_PASTE_KEYS) b.push({ keystroke: k, action: "herdrchat_paste", context: `${ctx} > Input` });
  }
  // Outside an input (an answer's text selected, the focus on the timeline): the window's selection (selcopy.js).
  for (const k of COPY_KEYS) b.push({ keystroke: k, action: "herdrchat_copy", context: "HerdrChat" });
  for (const ctx of EXTRA_INPUTS) {
    for (const k of COPY_KEYS) b.push({ keystroke: k, action: "herdrchat_copy", context: `${ctx} > Input` });
    for (const k of PASTE_KEYS) b.push({ keystroke: k, action: "herdrchat_paste", context: `${ctx} > Input` });
  }
  b.push({ keystroke: "space", action: "herdrchat_space", context: "HerdrChatQuestions > Input" });
  for (const ctx of ["HerdrChatMenu", "HerdrChatEmpty", ...CARDS]) {
    b.push({ keystroke: "up", action: "herdrchat_up", context: `${ctx} > Input` });
    b.push({ keystroke: "down", action: "herdrchat_down", context: `${ctx} > Input` });
  }
  b.push({ keystroke: "tab", action: "herdrchat_tab", context: "HerdrChatMenu" });
  // Find's field (find.js): Enter and ↑ the match before, Shift+Enter and ↓ the one after, Esc closes.
  for (const [k, a] of [["enter", "older"], ["up", "older"], ["shift-enter", "newer"], ["down", "newer"], ["escape", "close"]]) {
    b.push({ keystroke: k, action: `herdrchat_find_${a}`, context: "HerdrChatFind > Input" });
  }
  b.push({ keystroke: "escape", action: "herdrchat_find_close", context: "HerdrChatFind" });
  // The dialog card: Enter submits an input; Esc cancels (an editor keeps Enter).
  b.push({ keystroke: "enter", action: "herdrchat_dialog_enter", context: "HerdrChatDialog > Input" });
  b.push({ keystroke: "escape", action: "herdrchat_dialog_escape", context: "HerdrChatDialog" });
  b.push({ keystroke: "escape", action: "herdrchat_dialog_escape", context: "HerdrChatEditor" });
  b.push({ keystroke: MAC ? "cmd-enter" : "ctrl-enter", action: "herdrchat_dialog_enter", context: "HerdrChatEditor > Input" });
  cx.bind_keys(b);
}

// Fuzzy-ish rank: prefix > word start > substring > subsequence.
export function rank(name, q) {
  if (!q) return 1;
  const n = name.toLowerCase();
  q = q.toLowerCase();
  if (n.startsWith(q)) return 4 - n.length / 1000;
  if (n.split(/[-:_/ ]/).some((w) => w.startsWith(q))) return 3 - n.length / 1000;
  if (n.includes(q)) return 2 - n.length / 1000;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 1 - n.length / 1000 : 0;
}

// A skill in the text is a pill (an inline token): its text is the command
// (`/skill:diagnose`), so the value reads as typed; the pill shows its name.
export const skillToken = (s) => ({ id: `skill:${s.command}`, text: `/${s.command}`, label: s.name });

// An image chip's thumbnail: a fixed box, so the composer keeps its height while the image loads.
const THUMB = { w: 64, h: 48 };

export class Composer {
  // `skills()`: the chat's skill commands, [{command, name}] (main.js).
  // `onRemoveChip(chip, cx)`: a chip's ✕.
  // `onPasteCollapse(text, cx)`: large plain-text paste collapsed into a chip.
  constructor(cx, { onChange, onPasteOther, onPasteCollapse, onRemoveChip, placeholder, skills }) {
    this.ta = TextareaState.new({ placeholder: placeholder ?? "Message…" });
    this.ta.set_auto_grow(1, 10);
    this.skills = skills ?? (() => []);
    this.onRemoveChip = onRemoveChip;
    this.onPasteCollapse = onPasteCollapse;
    this.value = "";
    this.cursor = 0; // where the last edit ended: the state has no getter for it
    this.chips = []; // image, file, or collapsed paste chips
    this.menu = null; // {kind: "slash"|"files", query, items, sel, start}
    this.history = null; // {list, i, text}
    this.focused = false;
    this.suppressPasteCollapse = false;
    this.ta.on("change", (_e, cx) => {
      const before = this.value;
      const next = this.ta.value();
      if (!this.suppressPasteCollapse && this.onPasteCollapse) {
        const ins = detectInsertedSpan(before, next);
        if (ins && shouldCollapsePaste(ins.inserted)) {
          const restored = next.slice(0, ins.start) + next.slice(ins.end);
          this.suppressPasteCollapse = true;
          try {
            const tokens = this.skillSpans(restored);
            this.ta.set_value(tokens.length ? { text: restored, tokens } : restored);
            this.ta.set_selected_range({ start: ins.start, end: ins.start });
            this.value = restored;
            this.cursor = ins.start;
          } finally {
            this.suppressPasteCollapse = false;
          }
          this.onPasteCollapse(ins.inserted, cx);
          onChange?.(cx);
          return;
        }
      }
      this.value = next;
      this.cursor = editEnd(before, this.value);
      if (this.history && this.value !== this.history.text) this.history = null;
      this.pillTyped(before);
      onChange?.(cx);
    });
    this.ta.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.ta.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.ta.on("paste_other", (_e, cx) => onPasteOther?.(cx));
    this.onPasteOther = onPasteOther;
  }

  // A copy key of COPY_KEYS: copy the selected slice from the textarea; with none, the text selected in the chat
  // (copyMiss: main.js handOffCopy).
  copyKey(cx) {
    if (!copyField(this.ta, cx)) this.copyMiss?.(cx);
  }

  // A paste key of COMPOSER_PASTE_KEYS: large plain-text pastes collapse into a chip
  // (keeping formatting verbatim and the composer tidy); short pastes go inline at the
  // cursor; empty text falls back to image paste.
  pasteKey(cx) {
    let text;
    try {
      text = cx.read_from_clipboard();
    } catch {}
    if (text) {
      if (shouldCollapsePaste(text) && this.onPasteCollapse) {
        this.onPasteCollapse(text, cx);
        cx.notify();
      } else {
        this.ta.replace(text);
      }
    } else {
      this.onPasteOther?.(cx);
    }
  }

  focus() {
    this.ta.focus();
  }

  // The text, with its skill commands as pills.
  set(text) {
    this.suppressPasteCollapse = true;
    try {
      const tokens = this.skillSpans(text);
      this.ta.set_value(tokens.length ? { text, tokens } : text);
      this.value = text;
      this.cursor = text.length;
      this.ta.set_selected_range({ start: text.length, end: text.length });
    } finally {
      this.suppressPasteCollapse = false;
    }
  }

  // Inserts text directly into the textarea at the current cursor/selection without
  // re-collapsing it (used when unpacking a paste chip via "Edit inline").
  insertInline(text) {
    this.suppressPasteCollapse = true;
    try {
      const sel = this.ta.selected_range?.();
      const at = sel ? Math.min(sel.start, sel.end) : this.cursor;
      this.ta.replace(text);
      this.value = this.ta.value();
      this.cursor = Math.min(this.value.length, at + text.length);
    } finally {
      this.suppressPasteCollapse = false;
    }
  }

  // Where `/command` of a known skill stands as a word in `text` (one per skill).
  skillSpans(text) {
    const out = [];
    for (const s of this.skills()) {
      const word = `/${s.command}`;
      const m = new RegExp(`(^|\\s)${escapeRe(word)}(?=\\s|$)`).exec(text);
      if (m) out.push({ range: { start: m.index + m[1].length, end: m.index + m[1].length + word.length }, token: skillToken(s) });
    }
    return out.sort((a, b) => a.range.start - b.range.start);
  }

  tokens() {
    return this.ta.tokens?.() ?? [];
  }

  // What to send: a skill pill becomes the message's leading `/command`, the
  // rest follows (a pill inside the text leaves its name there). Null when
  // the text has more than one skill: an agent runs one skill per message.
  message() {
    const text = this.value;
    const pills = this.skillPills();
    if (pills.length > 1) return null;
    if (!pills.length) return text;
    const { range, token } = pills[0];
    const before = text.slice(0, range.start);
    const after = text.slice(range.end);
    const rest = (before.trim() ? `${before}${token.label ?? token.text.slice(1)}${after}` : after).trim();
    return `${token.text}${rest ? ` ${rest}` : ""}`;
  }

  // The skill pills in the text.
  skillPills() {
    return this.tokens().filter((t) => t.token.id.startsWith("skill:"));
  }

  // A skill command typed out in full, then a space or newline: a pill.
  pillTyped(before) {
    if (this.value.length !== before.length + 1 || !/\s/.test(this.value[this.cursor - 1] ?? "")) return;
    const head = this.value.slice(0, this.cursor - 1);
    const m = /(^|\s)\/(\S+)$/.exec(head);
    const s = m && this.skills().find((x) => x.command === m[2]);
    if (!s) return;
    const start = head.length - m[2].length - 1;
    if (this.tokens().some((t) => t.range.start < head.length && t.range.end > start)) return;
    this.ta.set_selected_range({ start, end: head.length });
    this.ta.replace_with_token(skillToken(s));
    this.ta.set_selected_range({ start: this.cursor, end: this.cursor });
    this.value = this.ta.value();
  }

  // A skill picked from the menu: a pill in place of the "/query" being typed, then a space.
  insertSkill(s) {
    const m = this.menu;
    const start = m?.start ?? 0;
    const end = start + 1 + (m?.query?.length ?? 0);
    this.ta.set_selected_range({ start, end });
    this.ta.replace_with_token(skillToken(s));
    this.ta.replace(" ");
    this.value = this.ta.value();
    this.cursor = start + skillToken(s).text.length + 1;
    this.menu = null;
  }

  // `pending`: a dropped/picked file the host is still copying or uploading; `kind`: "image" | "file".
  addChip(path, { pending = false, size = null, kind = "image", label = null } = {}) {
    const chip = { path, sourcePath: path, size, kind, label: label ?? path.split("/").pop(), pending, isDir: false };
    this.chips.push(chip);
    return chip;
  }

  pasteChips() {
    return this.chips.filter((ch) => ch.kind === "paste");
  }

  removeChip(i, cx) {
    const [ch] = this.chips.splice(i, 1);
    if (ch) this.onRemoveChip?.(ch, cx);
  }

  clear() {
    this.set("");
    this.chips = [];
    this.menu = null;
    this.history = null;
  }

  context() {
    const empty = !this.value.trim() && !this.chips.length;
    // A menu, or a select/confirm dialog while nothing is typed: ↑ ↓ Enter choose.
    if (this.menu?.items?.length || (this.dialogKeys && empty)) return "HerdrChatMenu";
    if (this.askCard && empty) return this.askCard === "questions" ? "HerdrChatQuestions" : "HerdrChatAsk";
    if (empty || (this.history && this.value === this.history.text && !this.chips.length)) return "HerdrChatEmpty";
    return "HerdrChatComposer";
  }

  // Up/Down through the prompts sent before (newest first).
  recall(list, dir) {
    if (!list.length) return false;
    if (!this.history) {
      if (dir > 0) return false;
      this.history = { list, i: -1, draft: this.value };
    }
    const i = this.history.i - dir; // up = older = higher index
    if (i < 0) {
      const draft = this.history.draft ?? "";
      this.history = null;
      this.set(draft);
      return true;
    }
    if (i >= this.history.list.length) return false;
    this.history.i = i;
    this.history.text = this.history.list[i];
    this.set(this.history.text);
    return true;
  }

  // What the text asks for: "/cmd" alone (every command), "/name" being
  // typed anywhere else (skills only: the rest need the whole message), or
  // "@query" at the end.
  wanted() {
    const v = this.value;
    const inPill = (at) => this.tokens().some((t) => t.range.start <= at && t.range.end > at);
    const slash = /^\/([^\s]*)$/.exec(v);
    if (slash && !inPill(0)) return { kind: "slash", query: slash[1], start: 0 };
    const head = v.slice(0, this.cursor);
    const mid = /(^|\s)\/([^\s/]*)$/.exec(head);
    if (mid) {
      const start = head.length - mid[2].length - 1;
      if (!inPill(start)) return { kind: "slash", query: mid[2], start, skillsOnly: true };
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(v);
    if (at) return { kind: "files", query: at[2] };
    return null;
  }

  moveSel(d) {
    const m = this.menu;
    if (!m?.items?.length) return;
    m.sel = (m.sel + d + m.items.length) % m.items.length;
    follow(m);
  }

  // Replace "@query" at the end with "@path " (quoted when the path has whitespace).
  insertFile(path) {
    const v = this.value.replace(/(^|\s)@([^\s@]*)$/, (_m, pre) => `${pre}${formatMention(path)} `);
    this.set(v);
    this.menu = null;
  }

  // The composer card, as the Claude app draws its own: the text, attachment chips, then a row with the +
  // (`c.plus`) at the left, what the keys do now or a flash (`c.hint`) between, and the mic (`c.mic`)
  // and the send / stop button at the right. What it runs with is under the card (chrome.js
  // underRow). `c` is the view's render context (cards.js).
  view(t, c) {
    const stopDown = (_e, cx) => cx.stop_propagation();
    const focusBar = (_e, cx) => {
      cx.stop_propagation();
      this.focus();
      cx.notify();
    };
    const focusCard = (_e, cx) => {
      if (!this.focused) {
        this.focus();
        cx.notify();
      }
    };
    const chips = this.chips.map((ch, i) => {
      const x = div().id(`chip-x-${i}`).cursor_pointer().rounded(4).hover((s) => s.text_color(t.foreground).bg(t.hover))
        .on_mouse_down("left", stopDown)
        .on_click((_e, cx) => { cx.stop_propagation(); this.removeChip(i, cx); cx.notify(); }).child(icon("x", 11));
      if (ch.kind === "paste") {
        const ic = ch.pending
          ? spinner(11, t.muted)
          : ch.error
            ? icon("alert", 12).text_color(t.ansi1)
            : icon("file-text", 12).text_color(t.accent);
        const title = pasteChipTitle(ch);
        const preview = pastePreviewLine(ch.text);
        const tip = ch.error
          ? `Paste attachment failed: ${ch.error} · Click to inspect or retry`
          : [preview, ch.mode === "file" ? "Sent as .txt attachment" : "Sent inline verbatim", "Click to preview or edit inline"].filter(Boolean).join(" · ");
        let el = h_flex().id(`chip-${i}`).flex_none().h(26).pl(8).pr(6).gap(6).items_center().rounded(6)
          .border_1().border_color(ch.error ? alpha(t.ansi1, 0.55) : t.border)
          .bg(t.raised).text_size(11.5).text_color(t.foreground).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(tip)
          .on_mouse_down("left", stopDown)
          .on_click((_e, cx) => c.previewPaste?.(ch.id, cx))
          .child(ic)
          .child(div().max_w(220).truncate().child(title));
        if (ch.mode === "file") {
          const badgeText = ch.pending ? "saving…" : ch.error ? "failed" : ".txt";
          const badgeColor = ch.error ? t.ansi1 : ch.pending ? t.dim : t.accent;
          el = el.child(div().flex_none().px(4).py(1).rounded(4).text_size(10)
            .bg(ch.error ? alpha(t.ansi1, 0.14) : ch.pending ? alpha(t.muted, 0.14) : alpha(t.accent, 0.14))
            .text_color(badgeColor).child(badgeText));
        }
        return el.child(x);
      }
      if (ch.kind === "file") {
        const ic = ch.pending ? spinner(11, t.muted) : icon(ch.isDir ? "folder" : "file-text", 12);
        return fileChip(`chip-${i}`, ch.label, t, { iconEl: ic, tip: ch.pending ? `Uploading ${ch.label}…` : ch.path })
          .pr(6).bg(t.raised).on_mouse_down("left", stopDown).child(x);
      }
      const thumb = ch.pending
        ? h_flex().id(`chip-${i}`).flex_none().rounded(10).border_1().border_color(t.border)
          .child(h_flex().w(THUMB.w).h(THUMB.h).items_center().justify_center().text_color(t.muted).child(icon("image", 16)))
        : thumbnail(`chip-${i}`, ch, THUMB.w, THUMB.h, c);
      if (thumb) {
        return div().relative().flex_none().on_mouse_down("left", stopDown).child(thumb.tooltip(ch.label))
          .child(x.absolute().top(4).right(4).p(1).bg(t.raised).border_1().border_color(t.border).text_color(t.muted));
      }
      return fileChip(`chip-${i}`, ch.label, t).pr(6).bg(t.raised).on_mouse_down("left", stopDown).child(x);
    });
    // A reply (`c.compact`: the chat has a conversation), as the Claude app draws it: one row, the text and
    // the send / stop button, growing with the text. The +, the mic and the hint are under the card then
    // (chrome.js underRow `lead`).
    const compact = Boolean(c.compact);
    let wrap = div().id("composer-box").w_full().min_w(0).cursor_text().key_context(this.context());
    if (compact) wrap = wrap.flex_1();
    for (const a of ACTIONS) wrap = wrap.on_action(a, (_e, cx) => c.action(a, cx));
    if (COPY_KEYS.length) wrap = wrap.on_action("herdrchat_copy", (_e, cx) => this.copyKey(cx));
    wrap = wrap.on_action("herdrchat_paste", (_e, cx) => this.pasteKey(cx));
    const field = Textarea.new(this.ta).w_full().text_size(14).text_color(t.foreground).bg(alpha(t.background, 0));
    wrap = wrap.child((compact ? field.pl(16).pr(4).py(11) : field.px(16).pt(14).pb(8))
      .token((tok, _cx) => skillPillEl(tok, t)));
    const working = c.working;
    const typed = Boolean(this.value.trim() || this.chips.length);
    const stop = working && !typed;
    const side = compact ? 30 : 32;
    const btn = h_flex().id(stop ? "stop" : "send").flex_none().w(side).h(side).rounded(compact ? 9 : 10).items_center().justify_center().cursor_pointer()
      .bg(stop ? t.foreground : typed ? t.solid : t.raised)
      .text_color(stop ? t.background : typed ? t.solid_foreground : t.dim)
      .hover((s) => s.opacity(0.85))
      .tooltip(stop ? `Stop (Esc${keyHint("stop") ? ` · ${keyHint("stop")}` : ""})` : working ? "Steer (Enter)" : "Send (Enter)")
      .on_mouse_down("left", stopDown)
      .on_click((_e, cx) => c.action(stop ? "herdrchat_stop" : "herdrchat_enter", cx))
      .child(icon(stop ? "square" : "arrow-up", stop ? 11 : 15));
    const card = v_flex().id("composer-card").w_full().rounded(compact ? 14 : 18).border_1().border_color(this.focused ? alpha(t.foreground, 0.2) : t.input).bg(t.surface).shadow_sm()
      .cursor_text().on_mouse_down("left", focusCard);
    if (compact) {
      // The chips above the text; the button stays beside the text's last line.
      return card
        .when(chips.length > 0, (e) => e.child(h_flex().id("composer-chips").px(14).pt(8).gap(6).flex_wrap().cursor_text().on_mouse_down("left", focusBar).children(chips)))
        .child(h_flex().id("composer-row").w_full().min_w(0).items_end().cursor_text()
          .child(wrap)
          .child(div().id("composer-send-wrap").flex_none().pr(6).pb(6).on_mouse_down("left", stopDown).child(btn)));
    }
    return card
      .child(wrap)
      .when(chips.length > 0, (e) => e.child(h_flex().id("composer-chips").px(14).pb(6).gap(6).flex_wrap().cursor_text().on_mouse_down("left", focusBar).children(chips)))
      .child(h_flex().id("composer-bar").h(44).pl(8).pr(8).gap(6).items_center().cursor_text().on_mouse_down("left", focusBar)
        .when(Boolean(c.plus), (e) => e.child(div().id("composer-plus-wrap").flex_none().on_mouse_down("left", stopDown).child(c.plus)))
        .child(h_flex().id("composer-hint").flex_1().min_w(0).h_full().items_center().cursor_text()
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(c.hintColor ?? t.dim).child(c.hint ?? ""))) // clips, never under the buttons
        .when(Boolean(c.mic), (e) => e.child(div().id("composer-mic-wrap").flex_none().on_mouse_down("left", stopDown).child(c.mic)))
        .child(btn));
  }
}

// The pill a skill token draws in the text (cards.js draws the same in a sent message).
function skillPillEl(tok, t) {
  if (!tok.token.id.startsWith("skill:")) return null;
  const h = Math.max(18, Math.min(22, Math.round(tok.line_height) - 2));
  return h_flex().h(h).px(6).gap(4).items_center().rounded(5).text_size(12.5).font_medium()
    .bg(alpha(t.accent, tok.selected ? 0.3 : 0.14)).text_color(t.accent)
    .child(icon("book", 11.5)).child(tok.token.label ?? tok.token.text);
}

// Where an edit from `a` to `b` ends in `b`: after what was typed or pasted.
function editEnd(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return b.length - s;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
