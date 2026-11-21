// Find in the chat (KEYS.md `find`): a bar above the timeline, at its right.
// The host looks through the whole conversation (protocol `search`), history
// the chat hasn't loaded too; main.js pages that history in, opens the folded
// work group that holds a match, and scrolls its row into view, marked. It
// starts at the latest match: Enter (or ↑) goes to the one before, Shift+Enter
// (or ↓) to the one after, wrapping; Esc closes it.

import { div } from "gpui-kit";
import { h_flex, InputState, Input } from "gpui-base";
import { alpha, icon } from "./util.js";

// The field's keys (composer.js binds them in "HerdrChatFind > Input").
export const FIND_ACTIONS = ["herdrchat_find_older", "herdrchat_find_newer", "herdrchat_find_close"];

/** @typedef {{id: string, n: number}} Match */

export class Find {
  /** @param {(cx: import("gpui-kit").Context) => void} onQuery the text changed */
  constructor(onQuery) {
    this.input = InputState.new({ placeholder: "Find in chat" });
    this.query = "";
    /** @type {Match[]} oldest first */
    this.matches = [];
    this.total = 0;
    this.capped = false;
    this.cur = -1; // the match shown (index in matches)
    this.busy = false; // a search or a history page is on its way
    this.seq = 0; // the latest query's number: an older answer is dropped
    this.goSeq = 0; // the latest step's number: a history page for an older one stops there
    /** @type {string | null} the row marked (the match's, or the group's that holds it) */
    this.rowId = null;
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value();
      onQuery(cx);
    });
  }

  focus() {
    this.input.focus();
  }

  /** @returns {Match | null} */
  get current() {
    return this.matches[this.cur] ?? null;
  }

  /** @param {Match[]} matches @param {number} total @param {boolean} capped */
  set(matches, total, capped) {
    this.matches = matches;
    this.total = total;
    this.capped = capped;
    this.cur = matches.length - 1;
    if (!matches.length) this.rowId = null;
  }

  /** @param {-1 | 1} dir -1: the match before (older), 1: the one after */
  step(dir) {
    const n = this.matches.length;
    if (!n) return false;
    this.cur = (this.cur + dir + n) % n;
    return true;
  }

  label() {
    if (!this.query.trim()) return "";
    if (this.busy && !this.matches.length) return "…";
    if (!this.matches.length) return "No results";
    return `${this.cur + 1} of ${this.matches.length}${this.capped ? "+" : ""}`;
  }

  /**
   * @param {any} t the theme
   * @param {(action: string, cx: import("gpui-kit").Context) => void} actions
   */
  view(t, actions) {
    const any = this.matches.length > 0;
    /** @param {string} id @param {string} name @param {string} tip @param {string} action @param {boolean} on */
    const btn = (id, name, tip, action, on) => div().id(id).w(24).h(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(on ? t.muted : alpha(t.dim, 0.5)).tooltip(tip)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); actions(action, cx); }))
      .child(icon(name, 13));
    let field = div().id("find-field").flex_1().min_w(0).key_context("HerdrChatFind");
    for (const a of FIND_ACTIONS) field = field.on_action(a, (_e, cx) => actions(a, cx));
    field = field.child(Input.new(this.input).h(26).px(2).text_size(12.5));
    return h_flex().id("find-bar").w(340).h(36).pl(10).pr(4).gap(4).items_center().rounded(10)
      .bg(t.popover).border_1().border_color(t.input)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().flex_none().text_color(t.dim).child(icon("search", 13)))
      .child(field)
      .child(div().flex_none().text_size(11.5).text_color(any || !this.query.trim() ? t.dim : t.blocked).child(this.label()))
      .child(btn("find-older", "chevron-up", "Before (Enter)", "herdrchat_find_older", any))
      .child(btn("find-newer", "chevron-down", "After (Shift+Enter)", "herdrchat_find_newer", any))
      .child(btn("find-close", "x", "Close (Esc)", "herdrchat_find_close", true));
  }
}

// What find looks through in an item, as the host does (host/timeline.ts searchText):
// for a host without `search`, over the items loaded here.
/** @param {any[]} items @param {string} query @returns {{matches: Match[], total: number, capped: boolean}} */
export function searchLoaded(items, query) {
  const q = query.trim().toLowerCase();
  /** @type {Match[]} */
  const matches = [];
  let total = 0;
  if (!q) return { matches, total, capped: false };
  for (const it of items) {
    if (it.parent) continue;
    const text = it.kind === "tool" ? it.title : ["user", "assistant", "notice"].includes(it.kind) ? it.text : "";
    if (!text) continue;
    const hay = String(text).toLowerCase();
    let n = 0;
    for (let at = hay.indexOf(q); at >= 0; at = hay.indexOf(q, at + q.length)) n++;
    if (n) { matches.push({ id: it.id, n }); total += n; }
  }
  return { matches, total, capped: false };
}
