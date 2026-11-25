// Antigravity `/swarm` live status strip & mission-control panel for Herdr desktop Chat view.
//
// Features:
//   - Docked live status strip right above the composer (working / waiting / blocked counts,
//     busiest worker activity, quick Overview / Board / Members / Graph buttons, Approve -> Terminal).
//   - Expandable mission-control panel (docked above composer, or maximized to a wide modal dialog):
//       Overview  attention cards, goal/phase, workstreams, milestones/risks, progress reel thumbnails
//       Board     channel & sender filters, search, #seq jump pills, unread divider, steering composer
//       Members   grouped roster, + Add worker, inline Model switch, Nudge, 2-step Kill, live Transcript inspector
//       Graph     themed vector SVG communication graph (clickable -> Viewer zoom/pan), @all & inactive toggles,
//                 interactive timeline replay (prev/play/pause/next/speed/Live) + active post preview.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { alpha, icon, message, monoFont, plural, spinner, thumbnail } from "./util.js";
import { copyField, pasteField } from "./composer.js";
import {
  collectAttention,
  collectWorkstreams,
  extractSeqRefs,
  filterSwarmMessages,
  formatSwarmTime,
  groupSwarmMembers,
  memberToneColor,
  nextReplaySeq,
  statusLabel,
  statusToneColor,
  stripScreenshotLines,
  swarmStatusSummary,
  workstreamToneColor,
} from "./swarm-logic.js";

const SPEEDS = [1, 2, 4];
const WORKSPACES = ["inherit", "share", "branch"];

export class SwarmPanel {
  /** @param {any} view */
  constructor(view) {
    this.view = view;
    this.open = false;
    this.modal = false;
    this.startOpen = false;
    this.tab = "overview"; // overview | board | members | graph
    this.channel = "all";
    this.sender = "all";
    this.searchQuery = "";
    this.jumpSeq = null;
    this.seenSeq = 0;

    // Member inspector + roster actions
    this.inspectedMember = null;
    this.memberDetail = null;
    this.memberLoading = false;
    this.memberError = null;
    this.memberFetchedAt = 0;
    this.expandedTools = new Set();
    this.modelPickerMember = null;
    this.confirmKillMember = null;

    // Board steering state
    this.postTarget = "coordinator";
    this.postChannel = "main";

    // Add worker inline form
    this.addOpen = false;
    this.addWorkspace = "share";
    this.addModel = "";

    // Graph + replay state
    this.expandAll = false;
    this.hideInactive = false;
    this.replaySeq = null; // null = Live
    this.playing = false;
    this.speedIdx = 0;
    this.lastReplayAt = 0;
    this.graphData = null;
    this.graphKey = null;
    this.graphLoading = false;

    this.busyAction = false;
    this.lastSwarmId = null;

    // Lazily created GPUI text states (never created inside render)
    this.searchInput = null;
    this.postInput = null;
    this.startInput = null;
    this.addNameInput = null;
    this.addModelInput = null;
    this.addBriefInput = null;
  }

  ensureSearchInput() {
    if (!this.searchInput) {
      this.searchInput = InputState.new({ placeholder: "Filter posts…" });
      this.searchInput.on("change", (_e, cx) => {
        this.searchQuery = this.searchInput.value();
        cx.notify();
      });
    }
    return this.searchInput;
  }

  ensurePostInput() {
    if (!this.postInput) {
      this.postInput = InputState.new({ placeholder: "Steer or post to the board… (Enter sends)" });
      this.postInput.on("change", (_e, cx) => cx.notify());
    }
    return this.postInput;
  }

  ensureBoardInputs() {
    this.ensureSearchInput();
    this.ensurePostInput();
  }

  ensureStartInput() {
    if (!this.startInput) {
      this.startInput = TextareaState.new({ placeholder: "Describe the goal for the swarm… (Ctrl+Enter launches)" });
      this.startInput.set_auto_grow(2, 6);
      this.startInput.on("change", (_e, cx) => cx.notify());
    }
    return this.startInput;
  }

  ensureAddInputs() {
    if (!this.addNameInput) {
      this.addNameInput = InputState.new({ placeholder: "worker-name (lowercase, a-z 0-9 - _)" });
      this.addNameInput.on("change", (_e, cx) => cx.notify());
    }
    if (!this.addModelInput) {
      this.addModelInput = InputState.new({ placeholder: "Model (optional, default coordinator's)" });
      this.addModelInput.on("change", (_e, cx) => {
        this.addModel = this.addModelInput.value();
        cx.notify();
      });
    }
    if (!this.addBriefInput) {
      this.addBriefInput = TextareaState.new({ placeholder: "Worker brief: what it owns and what done looks like…" });
      this.addBriefInput.set_auto_grow(2, 6);
      this.addBriefInput.on("change", (_e, cx) => cx.notify());
    }
  }

  release() {
    this.open = false;
    this.modal = false;
    this.startOpen = false;
    this.addOpen = false;
    for (const f of [this.searchInput, this.postInput, this.startInput, this.addNameInput, this.addModelInput, this.addBriefInput]) {
      f?.release?.();
    }
    this.searchInput = null;
    this.postInput = null;
    this.startInput = null;
    this.addNameInput = null;
    this.addModelInput = null;
    this.addBriefInput = null;
  }

  openTab(tab, cx) {
    this.open = true;
    this.startOpen = false;
    this.tab = tab || "overview";
    if (this.tab === "board") {
      this.ensureBoardInputs();
      const head = this.view.store.state.swarm?.head_seq ?? 0;
      if (head > this.seenSeq) this.seenSeq = head;
    }
    if (this.tab === "members" && this.addOpen) this.ensureAddInputs();
    if (this.tab === "graph") this.syncGraph(cx, true);
    this.view.debug?.mark?.();
    cx.notify();
  }

  openStart(cx) {
    this.startOpen = true;
    this.open = false;
    this.ensureStartInput().focus();
    this.view.debug?.mark?.();
    cx.notify();
  }

  close(cx) {
    if (!this.open && !this.startOpen) return false;
    this.open = false;
    this.modal = false;
    this.startOpen = false;
    this.playing = false;
    this.modelPickerMember = null;
    this.confirmKillMember = null;
    this.view.composer?.focus?.();
    this.view.debug?.mark?.();
    cx.notify();
    return true;
  }

  /** Periodic tick from HerdrChat.tick(cx): live transcript refresh, graph SVG sync, and replay playback. */
  tick(cx) {
    const swarm = this.view.store.state.swarm;
    if (!swarm) {
      if (this.lastSwarmId !== null) {
        this.lastSwarmId = null;
        this.open = false;
        this.modal = false;
        this.inspectedMember = null;
        this.memberDetail = null;
        this.graphData = null;
        this.graphKey = null;
        this.playing = false;
        return true;
      }
      return false;
    }

    let changed = false;
    if (this.lastSwarmId !== swarm.coordinator_id) {
      this.lastSwarmId = swarm.coordinator_id;
      this.startOpen = false;
      this.channel = "all";
      this.sender = "all";
      this.jumpSeq = null;
      this.inspectedMember = null;
      this.memberDetail = null;
      this.graphData = null;
      this.graphKey = null;
      this.replaySeq = null;
      this.playing = false;
      const me = (swarm.members ?? []).find((m) => m.name === swarm.me);
      this.seenSeq = me?.last_read_seq ?? 0;
      changed = true;
    }

    if (!this.open) return changed;

    if (this.inspectedMember && !this.memberLoading && Date.now() - this.memberFetchedAt >= 1500) {
      this.fetchMember(this.inspectedMember, cx);
    }

    if (this.tab === "graph") {
      if (this.playing) {
        const speed = SPEEDS[this.speedIdx] ?? 1;
        const stepMs = Math.round(900 / speed);
        if (Date.now() - this.lastReplayAt >= stepMs) {
          this.lastReplayAt = Date.now();
          const seqs = (swarm.messages ?? []).map((m) => m.seq);
          const maxSeq = swarm.head_seq || seqs[seqs.length - 1] || 0;
          const next = nextReplaySeq(seqs, this.replaySeq ?? seqs[0] ?? 1, 1, maxSeq);
          this.replaySeq = next;
          if (next === null) this.playing = false;
          changed = true;
        }
      }
      this.syncGraph(cx, false);
    }

    return changed;
  }

  fetchMember(member, cx) {
    if (!member) return;
    this.inspectedMember = member;
    this.memberLoading = true;
    this.memberError = null;
    this.memberFetchedAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const d = await this.view.conn.req("swarm_member", { member, limit: 80 });
        if (this.inspectedMember === member) {
          this.memberDetail = d?.detail ?? null;
          if (!this.memberDetail) this.memberError = "Member transcript unavailable";
        }
      } catch (e) {
        if (this.inspectedMember === member) this.memberError = message(e);
      } finally {
        this.memberLoading = false;
        this.memberFetchedAt = Date.now();
        cx.notify();
      }
    });
  }

  syncGraph(cx, force = false) {
    const swarm = this.view.store.state.swarm;
    if (!swarm || this.graphLoading) return;
    const key = `${swarm.etag}|${this.replaySeq ?? "live"}|${this.expandAll ? 1 : 0}|${this.hideInactive ? 1 : 0}|${this.view.themeSent ?? ""}`;
    if (!force && key === this.graphKey && this.graphData) return;
    this.graphKey = key;
    this.graphLoading = true;
    const args = {
      replaySeq: this.replaySeq,
      expandAll: this.expandAll,
      hideInactive: this.hideInactive,
    };
    cx.spawn(async (cx) => {
      try {
        const d = await this.view.conn.req("swarm_graph", args);
        if (this.graphKey === key) this.graphData = d?.graph ?? null;
      } catch (e) {
        this.view.log(`swarm_graph failed: ${message(e)}`);
      } finally {
        this.graphLoading = false;
        cx.notify();
      }
    });
  }

  runAction(payload, okNotice, cx, onDone) {
    if (this.busyAction) return;
    this.busyAction = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.view.req("swarm_action", payload, cx);
        if (okNotice) this.view.flash(okNotice, cx);
        onDone?.(cx);
      } catch (e) {
        this.view.flash(`Swarm: ${message(e)}`, cx);
      } finally {
        this.busyAction = false;
        this.view.debug?.mark?.();
        cx.notify();
      }
    });
  }

  submitStart(cx) {
    const task = (this.startInput?.value() ?? "").trim();
    if (!task) return this.view.flash("Enter a goal to start a swarm", cx);
    this.runAction({ action: "start", task }, "Starting /swarm…", cx, () => {
      this.startInput?.set_value?.("");
      this.startOpen = false;
    });
  }

  submitPost(cx) {
    const text = (this.postInput?.value() ?? "").trim();
    if (!text) return;
    const payload = {
      action: "post",
      target: this.postTarget || "coordinator",
      ...(this.postChannel && this.postChannel !== "main" ? { channel: this.postChannel } : {}),
      message: text,
    };
    this.runAction(payload, `Sent to @${payload.target}`, cx, () => {
      this.postInput?.set_value?.("");
    });
  }

  submitAddWorker(cx) {
    const name = (this.addNameInput?.value() ?? "").trim().toLowerCase();
    const brief = (this.addBriefInput?.value() ?? "").trim();
    const model = (this.addModelInput?.value() ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,23}$/.test(name) || name === "all" || name === "coordinator" || name.startsWith("coordinator-")) {
      return this.view.flash("Worker name must be lowercase a-z, 0-9, - or _ (not coordinator/all)", cx);
    }
    if (!brief) return this.view.flash("Give the new worker a brief", cx);
    const payload = {
      action: "add",
      name,
      brief,
      ...(model ? { model } : {}),
      workspace: this.addWorkspace || "share",
    };
    this.runAction(payload, `Spawning @${name}…`, cx, () => {
      this.addNameInput?.set_value?.("");
      this.addBriefInput?.set_value?.("");
      this.addModelInput?.set_value?.("");
      this.addModel = "";
      this.addOpen = false;
    });
  }

  control(sub, cx) {
    const swarm = this.view.store.state.swarm;
    if (sub === "toggle") {
      if (this.open) this.close(cx);
      else this.openTab(this.tab, cx);
      return;
    }
    if (sub === "close") return this.close(cx);
    if (sub === "modal") {
      this.modal = !this.modal;
      this.open = true;
      if (this.tab === "board") this.ensureBoardInputs();
      if (this.tab === "members" && this.addOpen) this.ensureAddInputs();
      this.view.debug?.mark?.();
      cx.notify();
      return;
    }
    if (sub === "terminal") return this.view.showFace("terminal", cx);
    if (sub === "refresh") {
      this.view.fire("swarm_refresh", {}, cx, () => {
        if (this.inspectedMember) this.fetchMember(this.inspectedMember, cx);
        if (this.tab === "graph") this.syncGraph(cx, true);
      });
      return;
    }
    if (sub === "start:open") return this.openStart(cx);
    if (sub === "start:close") return this.close(cx);
    if (sub === "start:submit") return this.submitStart(cx);

    if (sub.startsWith("open:")) {
      const tab = sub.slice(5);
      if (this.open && this.tab === tab) this.close(cx);
      else this.openTab(tab, cx);
      return;
    }
    if (sub.startsWith("tab:")) {
      this.openTab(sub.slice(4), cx);
      return;
    }
    if (sub.startsWith("channel:")) {
      this.channel = sub.slice(8);
      this.jumpSeq = null;
      cx.notify();
      return;
    }
    if (sub.startsWith("sender:")) {
      this.sender = sub.slice(7);
      cx.notify();
      return;
    }
    if (sub.startsWith("jump:")) {
      const seq = Number(sub.slice(5));
      if (Number.isSafeInteger(seq) && seq > 0) {
        this.open = true;
        this.tab = "board";
        this.ensureBoardInputs();
        this.channel = "all";
        this.sender = "all";
        this.searchQuery = "";
        this.searchInput?.set_value?.("");
        this.jumpSeq = seq;
        cx.notify();
      }
      return;
    }
    if (sub.startsWith("reply:")) {
      const member = sub.slice(6);
      this.open = true;
      this.tab = "board";
      this.ensureBoardInputs();
      this.postTarget = member;
      this.postInput.focus();
      cx.notify();
      return;
    }
    if (sub.startsWith("post:target:")) {
      this.postTarget = sub.slice(12);
      cx.notify();
      return;
    }
    if (sub.startsWith("post:channel:")) {
      this.postChannel = sub.slice(13);
      cx.notify();
      return;
    }
    if (sub === "post:submit") return this.submitPost(cx);

    if (sub === "inspect:close") {
      this.inspectedMember = null;
      this.memberDetail = null;
      this.memberError = null;
      cx.notify();
      return;
    }
    if (sub.startsWith("inspect:")) {
      const member = sub.slice(8);
      this.open = true;
      this.tab = "members";
      this.modelPickerMember = null;
      this.confirmKillMember = null;
      this.fetchMember(member, cx);
      cx.notify();
      return;
    }
    if (sub.startsWith("tool:")) {
      const key = sub.slice(5);
      if (this.expandedTools.has(key)) this.expandedTools.delete(key);
      else this.expandedTools.add(key);
      cx.notify();
      return;
    }
    if (sub.startsWith("model:open:")) {
      const m = sub.slice(11);
      this.modelPickerMember = this.modelPickerMember === m ? null : m;
      this.confirmKillMember = null;
      cx.notify();
      return;
    }
    if (sub === "model:close") {
      this.modelPickerMember = null;
      cx.notify();
      return;
    }
    if (sub.startsWith("model:set:")) {
      const rest = sub.slice(10);
      const colon = rest.indexOf(":");
      if (colon > 0) {
        const member = rest.slice(0, colon);
        const model = rest.slice(colon + 1);
        this.modelPickerMember = null;
        this.runAction({ action: "model", member, model }, `Switching @${member} to ${model}…`, cx);
      }
      return;
    }
    if (sub.startsWith("kill:ask:")) {
      this.confirmKillMember = sub.slice(9);
      this.modelPickerMember = null;
      cx.notify();
      return;
    }
    if (sub === "kill:cancel") {
      this.confirmKillMember = null;
      cx.notify();
      return;
    }
    if (sub.startsWith("kill:confirm:")) {
      const member = sub.slice(13);
      this.confirmKillMember = null;
      this.runAction({ action: "kill", member }, `Stopping @${member}…`, cx);
      return;
    }
    if (sub.startsWith("nudge:")) {
      const member = sub.slice(6);
      this.runAction({ action: "nudge", member }, `Nudged @${member}`, cx);
      return;
    }
    if (sub === "add:open") {
      this.addOpen = !this.addOpen;
      if (this.addOpen) this.ensureAddInputs();
      cx.notify();
      return;
    }
    if (sub === "add:close") {
      this.addOpen = false;
      cx.notify();
      return;
    }
    if (sub.startsWith("add:ws:")) {
      const ws = sub.slice(7);
      if (WORKSPACES.includes(ws)) this.addWorkspace = ws;
      cx.notify();
      return;
    }
    if (sub.startsWith("add:model:")) {
      this.ensureAddInputs();
      this.addModel = sub.slice(10);
      this.addModelInput.set_value(this.addModel);
      cx.notify();
      return;
    }
    if (sub === "add:submit") return this.submitAddWorker(cx);

    // Graph & timeline replay controls
    if (sub === "graph:all") {
      this.expandAll = !this.expandAll;
      this.syncGraph(cx, true);
      cx.notify();
      return;
    }
    if (sub === "graph:inactive") {
      this.hideInactive = !this.hideInactive;
      this.syncGraph(cx, true);
      cx.notify();
      return;
    }
    if (sub === "graph:enlarge") {
      if (this.graphData?.path) {
        this.view.enlarge(this.graphData.path, { w: this.graphData.w ?? 640, h: this.graphData.h ?? 380 }, cx);
      }
      return;
    }
    if (sub === "replay:prev" || sub === "replay:next") {
      if (!swarm) return;
      this.playing = false;
      const seqs = (swarm.messages ?? []).map((m) => m.seq);
      const maxSeq = swarm.head_seq || seqs[seqs.length - 1] || 0;
      this.replaySeq = nextReplaySeq(seqs, this.replaySeq, sub === "replay:prev" ? -1 : 1, maxSeq);
      this.syncGraph(cx, true);
      cx.notify();
      return;
    }
    if (sub === "replay:play") {
      if (!swarm) return;
      const seqs = (swarm.messages ?? []).map((m) => m.seq);
      if (!seqs.length) return;
      const maxSeq = swarm.head_seq || seqs[seqs.length - 1] || 0;
      if (this.playing) {
        this.playing = false;
      } else {
        if (this.replaySeq === null || this.replaySeq >= maxSeq) this.replaySeq = seqs[0];
        this.playing = true;
        this.lastReplayAt = Date.now();
        this.syncGraph(cx, true);
      }
      cx.notify();
      return;
    }
    if (sub === "replay:speed") {
      this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
      cx.notify();
      return;
    }
    if (sub === "replay:live") {
      this.playing = false;
      this.replaySeq = null;
      this.syncGraph(cx, true);
      cx.notify();
      return;
    }
    if (sub.startsWith("replay:seq:")) {
      const seq = Number(sub.slice(11));
      const maxSeq = swarm?.head_seq ?? 0;
      if (Number.isSafeInteger(seq) && seq >= 1) {
        this.playing = false;
        this.replaySeq = seq >= maxSeq ? null : seq;
        this.syncGraph(cx, true);
        cx.notify();
      }
      return;
    }
  }

  dump(swarm) {
    return {
      active: Boolean(swarm),
      open: this.open,
      modal: this.modal,
      startOpen: this.startOpen,
      tab: this.tab,
      inspected: this.inspectedMember,
      counts: swarm?.counts ?? null,
    };
  }
}

// ---------------------------------------------------------------- shared small UI primitives

function smallBtn(id, label, t, { onClick, primary = false, danger = false, active = false, ic = null, tip = null, disabled = false } = {}) {
  let el = h_flex().id(id).flex_none().h(24).px(8).gap(5).items_center().rounded(6).text_size(11.5).font_medium()
    .border_1()
    .border_color(primary ? t.solid : danger ? alpha(t.ansi1, 0.45) : active ? alpha(t.accent, 0.55) : t.border)
    .bg(primary ? t.solid : danger ? alpha(t.ansi1, 0.12) : active ? alpha(t.accent, 0.14) : t.raised)
    .text_color(primary ? t.solid_foreground : danger ? t.ansi1 : active ? t.accent : t.foreground);
  if (disabled) el = el.opacity(0.45);
  else el = el.cursor_pointer().hover((s) => s.opacity(0.86)).on_click(onClick);
  if (tip) el = el.tooltip(tip);
  if (ic) el = el.child(icon(ic, 11.5));
  if (label) el = el.child(label);
  return el;
}

function statusBadge(status, t) {
  const col = statusToneColor(status, t);
  return h_flex().flex_none().h(19).px(6).gap(4).items_center().rounded(5)
    .bg(alpha(col, 0.14)).border_1().border_color(alpha(col, 0.32)).text_size(10.5).font_medium().text_color(col)
    .child(status === "working" ? spinner(9, col) : div().size(6).rounded(3).bg(col))
    .child(statusLabel(status));
}

function seqPill(id, seq, t, v) {
  return div().id(id).flex_none().h(20).px(6).flex().items_center().rounded(5).cursor_pointer()
    .bg(alpha(t.accent, 0.12)).border_1().border_color(alpha(t.accent, 0.3))
    .font_family(monoFont()).text_size(10.5).text_color(t.accent)
    .hover((s) => s.bg(alpha(t.accent, 0.22)))
    .on_click((_e, cx) => { cx.stop_propagation(); v.control(`swarm:jump:${seq}`, cx); })
    .child(`#${seq}`);
}

function memberChip(id, name, t, v, { active = false, suffix = "" } = {}) {
  const col = memberToneColor(name, t);
  return h_flex().id(id).flex_none().h(21).px(6).gap(4).items_center().rounded(5).cursor_pointer()
    .border_1().border_color(active ? col : alpha(col, 0.32))
    .bg(alpha(col, active ? 0.2 : 0.1)).text_size(11).font_medium().text_color(col)
    .hover((s) => s.bg(alpha(col, 0.24)))
    .on_click((_e, cx) => { cx.stop_propagation(); v.control(`swarm:inspect:${name}`, cx); })
    .child(`@${name}${suffix}`);
}

function fieldWrap(id, field, keyCtx, onEnter, onEsc, el) {
  return div().id(id).flex_1().min_w(0).key_context(keyCtx)
    .on_action("herdrchat_dialog_enter", (_e, cx) => onEnter?.(cx))
    .on_action("herdrchat_dialog_escape", (_e, cx) => onEsc?.(cx))
    .on_action("herdrchat_copy", (_e, cx) => copyField(field, cx))
    .on_action("herdrchat_paste", (_e, cx) => pasteField(field, cx))
    .child(el);
}

// ---------------------------------------------------------------- docked status strip

/** Live swarm status strip above the composer (or inline Start Swarm card when invoked via `/swarm`). */
export function swarmStrip(v, s, t) {
  const sw = v.swarm;
  const swarm = s.swarm;

  if (!swarm) {
    if (!sw?.startOpen) return null;
    const area = sw.startInput;
    if (!area) return null;
    return v_flex().id("swarm-start-card").w_full().p(12).gap(8).rounded(10)
      .border_1().border_color(alpha(t.accent, 0.45)).bg(t.popover)
      .child(h_flex().gap(8).items_center()
        .child(icon("sparkles", 13).text_color(t.accent))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child("Launch Antigravity /swarm"))
        .child(div().id("swarm-start-x").p(3).rounded(5).cursor_pointer().text_color(t.dim)
          .hover((st) => st.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => v.control("swarm:start:close", cx))
          .child(icon("x", 12))))
      .child(fieldWrap(
        "swarm-start-field",
        area,
        "HerdrChatEditor",
        (cx) => v.control("swarm:start:submit", cx),
        (cx) => v.control("swarm:start:close", cx),
        Textarea.new(area).w_full().px(8).py(6).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5),
      ))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Spawns coordinated parallel agents in this Antigravity session."))
        .child(smallBtn("swarm-start-cancel", "Cancel", t, { onClick: (_e, cx) => v.control("swarm:start:close", cx) }))
        .child(smallBtn("swarm-start-go", sw.busyAction ? "Launching…" : "Launch /swarm", t, {
          primary: true,
          disabled: sw.busyAction,
          onClick: (_e, cx) => v.control("swarm:start:submit", cx),
        })));
  }

  const sum = swarmStatusSummary(swarm);
  if (!sum) return null;
  const open = sw.open;
  const hasBlocked = sum.blocked > 0;
  const hasWorking = sum.working > 0;
  const dotColor = hasBlocked ? (t.ansi1 ?? t.blocked) : hasWorking ? (t.ansi2 ?? t.accent) : t.muted;

  const badge = (label, col) => div().flex_none().px(6).py(1).rounded(5)
    .bg(alpha(col, 0.14)).text_size(11).font_medium().text_color(col).child(label);

  const tabChip = (id, label, active) => div().id(`swarm-strip-${id}`).flex_none().h(22).px(7).flex().items_center().rounded(5)
    .text_size(11.5).cursor_pointer()
    .when(active, (e) => e.bg(alpha(t.accent, 0.18)).text_color(t.accent).font_semibold())
    .when(!active, (e) => e.text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)))
    .on_click((_e, cx) => { cx.stop_propagation(); v.control(`swarm:open:${id}`, cx); })
    .child(label);

  return h_flex().id("swarm-strip").w_full().min_h(32).px(10).py(4).gap(8).items_center().flex_wrap()
    .rounded(10).border_1().border_color(hasBlocked ? alpha(t.ansi1, 0.5) : open ? alpha(t.accent, 0.45) : t.border)
    .bg(hasBlocked ? alpha(t.ansi1, 0.08) : t.surface)
    .cursor_pointer().hover((st) => st.bg(hasBlocked ? alpha(t.ansi1, 0.12) : t.hover))
    .on_click((_e, cx) => v.control("swarm:toggle", cx))
    .child(hasWorking && !hasBlocked ? spinner(11, dotColor) : div().flex_none().size(8).rounded(4).bg(dotColor))
    .child(div().flex_none().max_w(160).truncate().text_size(12).font_semibold().text_color(t.foreground).child(sum.title))
    .when(sum.working > 0, (e) => e.child(badge(`${sum.working} working`, t.ansi2 ?? t.accent)))
    .when(sum.blocked > 0, (e) => e.child(badge(`${sum.blocked} blocked`, t.ansi1 ?? t.blocked)))
    .when(sum.waiting > 0, (e) => e.child(badge(`${sum.waiting} waiting`, t.muted)))
    .when(sum.attention > 0 && sum.blocked === 0, (e) => e.child(badge(`${sum.attention} alert${sum.attention === 1 ? "" : "s"}`, t.ansi3 ?? t.blocked)))
    .when(Boolean(sum.leadMember && sum.leadActivity), (e) => e.child(
      div().flex_1().min_w(60).truncate().text_size(11.5).text_color(t.dim)
        .child(`@${sum.leadMember} · ${sum.leadActivity}`),
    ))
    .when(!(sum.leadMember && sum.leadActivity), (e) => e.child(div().flex_1().min_w(8)))
    .when(hasBlocked && Boolean(v.view), (e) => e.child(
      smallBtn("swarm-strip-approve", "Approve · Terminal", t, {
        danger: true,
        ic: "terminal",
        onClick: (_e, cx) => { cx.stop_propagation(); v.control("swarm:terminal", cx); },
      }),
    ))
    .child(h_flex().flex_none().gap(2).items_center()
      .child(tabChip("overview", "Overview", open && sw.tab === "overview"))
      .child(tabChip("board", `Board${sum.headSeq ? ` (${sum.headSeq})` : ""}`, open && sw.tab === "board"))
      .child(tabChip("members", `Members (${sum.active})`, open && sw.tab === "members"))
      .child(tabChip("graph", "Graph", open && sw.tab === "graph")))
    .child(icon(open ? "chevron-down" : "chevron-up", 11).text_color(t.dim));
}

// ---------------------------------------------------------------- panel shell (docked or wide modal)

/** Docked mission-control panel above the composer. */
export function swarmDrawer(v, s, t, c) {
  if (!v.swarm?.open || v.swarm.modal || !s.swarm) return null;
  return swarmBody(v, s.swarm, t, c, false);
}

/** Maximized centered mission-control modal dialog (in HerdrChat.hud). */
export function swarmModal(v, s, t, c) {
  if (!v.swarm?.open || !v.swarm.modal || !s.swarm) return null;
  return div().id("swarm-modal-backdrop").absolute().top(0).bottom(0).left(0).right(0)
    .bg(alpha("#000000", 0.55)).flex().items_center().justify_center().p(20)
    .on_click((_e, cx) => v.control("swarm:close", cx))
    .child(div().id("swarm-modal-dialog").w_full().max_w(900).h("86%").flex().flex_col()
      .on_click((_e, cx) => cx.stop_propagation())
      .child(swarmBody(v, s.swarm, t, c, true)));
}

function swarmBody(v, swarm, t, c, isModal) {
  const sw = v.swarm;
  const sum = swarmStatusSummary(swarm);

  const tabBtn = (id, label, countText = null) => {
    const active = sw.tab === id;
    return h_flex().id(`swarm-tab-${id}`).h(28).px(10).gap(5).items_center().rounded(7).cursor_pointer()
      .text_size(12).font_medium()
      .when(active, (e) => e.bg(t.background).text_color(t.foreground).border_1().border_color(t.border))
      .when(!active, (e) => e.text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => v.control(`swarm:tab:${id}`, cx))
      .child(label)
      .when(Boolean(countText), (e) => e.child(div().text_size(10.5).text_color(active ? t.accent : t.dim).child(countText)));
  };

  const hdrBtn = (id, ic, tip, what) => h_flex().id(id).w(26).h(26).items_center().justify_center().rounded(6)
    .cursor_pointer().text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(tip)
    .on_click((_e, cx) => v.control(what, cx))
    .child(icon(ic, 13));

  const header = h_flex().flex_none().h(40).px(12).gap(8).items_center()
    .border_b_1().border_color(t.border).bg(t.surface)
    .child(icon("sparkles", 13).text_color(t.accent))
    .child(div().max_w(200).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(sum.title))
    .child(h_flex().gap(3).items_center()
      .child(tabBtn("overview", "Overview", sum.attention > 0 ? String(sum.attention) : null))
      .child(tabBtn("board", "Board", sum.headSeq > 0 ? `#${sum.headSeq}` : null))
      .child(tabBtn("members", "Members", `${sum.working}/${sum.active}`))
      .child(tabBtn("graph", "Graph")))
    .child(div().flex_1())
    .child(hdrBtn("swarm-refresh", "rotate", "Refresh swarm state", "swarm:refresh"))
    .when(Boolean(v.view), (e) => e.child(hdrBtn("swarm-terminal", "terminal", "Open Antigravity terminal (Ctrl+Shift+J)", "swarm:terminal")))
    .child(hdrBtn("swarm-modal-toggle", "maximize", isModal ? "Dock above composer" : "Expand mission control", "swarm:modal"))
    .child(hdrBtn("swarm-close", "x", "Close (Esc)", "swarm:close"));

  let content;
  if (sw.tab === "overview") content = renderOverviewTab(v, swarm, t, c);
  else if (sw.tab === "board") content = renderBoardTab(v, swarm, t, c);
  else if (sw.tab === "members") content = renderMembersTab(v, swarm, t);
  else content = renderGraphTab(v, swarm, t, c);

  let frame = v_flex().id("swarm-panel").w_full().rounded(12).overflow_hidden()
    .border_1().border_color(t.border).bg(t.popover).shadow_md();
  if (isModal) frame = frame.size_full().min_h(0);
  else frame = frame.max_h(440);

  return frame.child(header).child(content);
}

// ---------------------------------------------------------------- Tab 1: Overview

function renderOverviewTab(v, swarm, t, c) {
  const attention = collectAttention(swarm);
  const workstreams = collectWorkstreams(swarm);
  const narrator = swarm.narrator ?? {};
  const goal = narrator.goal || swarm.plan?.goal || null;
  const membersByName = new Map((swarm.members ?? []).map((m) => [m.name, m]));

  const sections = [];

  // Attention cards (system failures/approvals + narrator escalations)
  if (attention.length) {
    sections.push(
      v_flex().gap(6)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(`NEEDS ATTENTION (${attention.length})`))
        .children(attention.map((a, idx) => {
          const sevCol = a.severity === "high" ? (t.ansi1 ?? t.blocked) : a.severity === "med" ? (t.ansi3 ?? t.blocked) : t.accent;
          return v_flex().id(`swarm-attn-${idx}`).p(10).gap(6).rounded(8)
            .border_1().border_color(alpha(sevCol, 0.45)).bg(alpha(sevCol, 0.08))
            .child(h_flex().gap(6).items_center()
              .child(icon("alert", 13).text_color(sevCol))
              .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().text_color(t.foreground).child(a.title))
              .child(div().px(5).py(1).rounded(4).bg(alpha(sevCol, 0.16)).text_size(10).text_color(sevCol).child(a.kind)))
            .when(Boolean(a.why), (e) => e.child(div().text_size(12).line_height("18px").text_color(t.muted).child(a.why)))
            .child(h_flex().gap(6).flex_wrap().items_center()
              .children((a.refs ?? []).map((seq) => seqPill(`attn-ref-${idx}-${seq}`, seq, t, v)))
              .children((a.actions ?? []).map((act, ai) => {
                if (act.kind === "open_member" && act.member) {
                  return smallBtn(`attn-act-${idx}-${ai}`, act.label, t, { onClick: (_e, cx) => v.control(`swarm:inspect:${act.member}`, cx) });
                }
                if (act.kind === "switch_model" && act.member) {
                  return smallBtn(`attn-act-${idx}-${ai}`, act.label, t, {
                    onClick: (_e, cx) => {
                      v.swarm.openTab("members", cx);
                      v.control(`swarm:model:open:${act.member}`, cx);
                    },
                  });
                }
                if (act.kind === "open_terminal") {
                  return smallBtn(`attn-act-${idx}-${ai}`, act.label, t, {
                    danger: true,
                    ic: "terminal",
                    onClick: (_e, cx) => v.control("swarm:terminal", cx),
                  });
                }
                if (act.kind === "nudge" && act.member) {
                  return smallBtn(`attn-act-${idx}-${ai}`, act.label, t, { onClick: (_e, cx) => v.control(`swarm:nudge:${act.member}`, cx) });
                }
                if (act.kind === "jump_seq" && act.seq) {
                  return smallBtn(`attn-act-${idx}-${ai}`, act.label, t, { onClick: (_e, cx) => v.control(`swarm:jump:${act.seq}`, cx) });
                }
                return null;
              }).filter(Boolean)));
        })),
    );
  }

  // Goal + phase + narrator summary
  if (goal || narrator.headline || narrator.running_summary || narrator.phase) {
    const narStatus = narrator.status === "active" ? "Narrator live" : narrator.status === "stale" ? "Narrator stale" : narrator.status === "idle" ? "Narrator ready" : null;
    sections.push(
      v_flex().p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().gap(8).items_center().flex_wrap()
          .child(div().flex_1().min_w(0).text_size(13).font_semibold().text_color(t.foreground).child(goal?.title || narrator.headline || swarm.title))
          .when(Boolean(narrator.phase), (e) => e.child(div().px(6).py(1).rounded(5).bg(alpha(t.accent, 0.14)).text_size(11).font_medium().text_color(t.accent)
            .child(`Phase ${narrator.phase.index}/${narrator.phase.total} · ${narrator.phase.label}`)))
          .when(Boolean(narStatus), (e) => e.child(div().text_size(10.5).text_color(narrator.status === "stale" ? t.ansi3 : t.dim).child(narStatus))))
        .when(Boolean(goal?.line), (e) => e.child(div().text_size(12).line_height("18px").text_color(t.muted).child(goal.line)))
        .when(Boolean(narrator.running_summary), (e) => e.child(div().text_size(12).line_height("18px").text_color(t.foreground).child(narrator.running_summary))),
    );
  }

  // Workstreams / active threads
  sections.push(
    v_flex().gap(6)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(`WORKSTREAMS (${workstreams.length})`))
      .when(workstreams.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim).child("No worker threads yet — wait for workers to spawn or post to the board.")))
      .children(workstreams.map((ws, idx) => {
        const stCol = workstreamToneColor(ws.state, t);
        const pct = ws.progress && ws.progress.total > 0 ? Math.min(1, Math.max(0, ws.progress.done / ws.progress.total)) : null;
        const ownerLive = (ws.owners ?? [])
          .map((o) => {
            const m = membersByName.get(o);
            const live = m?.activity || narrator.now?.[o];
            return live ? `@${o}: ${live}` : null;
          })
          .filter(Boolean);
        return v_flex().id(`swarm-ws-${idx}`).p(10).gap(6).rounded(8).border_1().border_color(t.border).bg(t.background)
          .child(h_flex().gap(6).items_center().flex_wrap()
            .child(div().size(7).rounded(4).bg(stCol))
            .child(div().flex_1().min_w(120).text_size(12.5).font_semibold().text_color(t.foreground).child(ws.title))
            .when(pct !== null, (e) => e.child(h_flex().gap(6).items_center()
              .child(div().w(54).h(5).rounded(3).bg(alpha(t.muted, 0.2)).child(div().h_full().rounded(3).w(Math.round(54 * pct)).bg(stCol)))
              .child(div().text_size(11).font_family(monoFont()).text_color(t.dim).child(`${ws.progress.done}/${ws.progress.total}`))))
            .child(div().px(5).py(1).rounded(4).bg(alpha(stCol, 0.14)).text_size(10.5).text_color(stCol).child(ws.state)))
          .when(Boolean(ws.note), (e) => e.child(div().text_size(12).line_height("17px").text_color(t.muted).child(ws.note)))
          .when(ownerLive.length > 0, (e) => e.child(div().text_size(11.5).text_color(t.accent).child(ownerLive.join(" · "))))
          .when((ws.owners?.length ?? 0) > 0 || (ws.refs?.length ?? 0) > 0, (e) => e.child(h_flex().gap(5).flex_wrap().items_center()
            .children((ws.owners ?? []).map((o) => memberChip(`ws-own-${idx}-${o}`, o, t, v)))
            .children((ws.refs ?? []).map((seq) => seqPill(`ws-ref-${idx}-${seq}`, seq, t, v)))));
      })),
  );

  // Milestones & Risks
  const milestones = narrator.milestones ?? [];
  const risks = narrator.risks ?? [];
  if (milestones.length || risks.length) {
    sections.push(
      h_flex().gap(10).items_start().flex_wrap()
        .when(milestones.length > 0, (e) => e.child(
          v_flex().flex_1().min_w(220).p(10).gap(5).rounded(8).border_1().border_color(t.border).bg(t.background)
            .child(div().text_size(11).font_semibold().text_color(t.muted).child("MILESTONES"))
            .children(milestones.map((m) => h_flex().gap(6).items_start().text_size(12)
              .child(icon(m.state === "done" ? "circle-check" : "circle", 12).text_color(m.state === "done" ? t.ansi2 : t.dim))
              .child(div().flex_1().min_w(0).text_color(t.foreground).child(m.title + (m.note ? ` — ${m.note}` : ""))))),
        ))
        .when(risks.length > 0, (e) => e.child(
          v_flex().flex_1().min_w(220).p(10).gap(5).rounded(8).border_1().border_color(alpha(t.ansi3, 0.35)).bg(t.background)
            .child(div().text_size(11).font_semibold().text_color(t.ansi3).child("RISKS"))
            .children(risks.map((r) => h_flex().gap(6).items_start().text_size(12)
              .child(icon("alert", 12).text_color(r.severity === "high" ? t.ansi1 : t.ansi3))
              .child(div().flex_1().min_w(0).text_color(t.foreground).child(r.title + (r.note ? ` — ${r.note}` : ""))))),
        )),
    );
  }

  // Progress reel thumbnails (click to enlarge in Viewer)
  const frames = (swarm.frames ?? []).filter((f) => f.local_path);
  if (frames.length) {
    sections.push(
      v_flex().gap(6)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child(`PROGRESS SCREENSHOTS (${frames.length})`))
        .child(h_flex().gap(8).flex_wrap()
          .children(frames.slice(-12).map((f, i) => {
            const thumb = thumbnail(`swarm-reel-${i}`, { path: f.local_path, size: null }, 124, 80, c);
            if (!thumb) return null;
            return v_flex().gap(3).max_w(124)
              .child(thumb)
              .when(Boolean(f.caption || f.seq), (e) => e.child(
                div().truncate().text_size(10.5).text_color(t.dim)
                  .child([f.seq ? `#${f.seq}` : null, f.caption || f.agent].filter(Boolean).join(" · ")),
              ));
          }).filter(Boolean))),
    );
  }

  return v_flex().id("swarm-overview-body").flex_1().min_h(0).overflow_y_scroll().p(12).gap(12).children(sections);
}

// ---------------------------------------------------------------- Tab 2: Board

function renderBoardTab(v, swarm, t, c) {
  const sw = v.swarm;
  const channels = swarm.channels ?? [];
  const members = (swarm.members ?? []).filter((m) => !m.role_worker);
  const filtered = filterSwarmMessages(swarm, { channel: sw.channel, sender: sw.sender, search: sw.searchQuery });
  const searchField = sw.searchInput;
  const postField = sw.postInput;

  const filterPill = (id, label, active, what) => div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(6).cursor_pointer()
    .text_size(11.5)
    .when(active, (e) => e.bg(alpha(t.accent, 0.16)).border_1().border_color(alpha(t.accent, 0.45)).text_color(t.accent).font_medium())
    .when(!active, (e) => e.border_1().border_color(t.border).text_color(t.muted).hover((st) => st.bg(t.hover).text_color(t.foreground)))
    .on_click((_e, cx) => v.control(what, cx))
    .child(label);

  const filterBar = v_flex().flex_none().px(12).py(8).gap(6).border_b_1().border_color(t.border).bg(t.surface)
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(filterPill("swarm-ch-all", "All channels", sw.channel === "all", "swarm:channel:all"))
      .children(channels.map((ch) => filterPill(`swarm-ch-${ch.name}`, `#${ch.name} (${ch.message_count})`, sw.channel === ch.name, `swarm:channel:${ch.name}`)))
      .child(div().flex_1().min_w(12))
      .when(Boolean(searchField), (e) => e.child(h_flex().w(180).h(24).px(6).gap(4).items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
        .child(icon("search", 11).text_color(t.dim))
        .child(fieldWrap(
          "swarm-board-search",
          searchField,
          "HerdrChatDialog",
          null,
          (cx) => {
            if (sw.searchQuery) {
              sw.searchQuery = "";
              searchField.set_value("");
              cx.notify();
            } else v.control("swarm:close", cx);
          },
          Input.new(searchField).h(22).px(2).text_size(11.5),
        )))))
    .child(h_flex().gap(4).items_center().flex_wrap()
      .child(div().text_size(11).text_color(t.dim).pr(2).child("From:"))
      .child(filterPill("swarm-from-all", "Anyone", sw.sender === "all", "swarm:sender:all"))
      .children(members.map((m) => filterPill(`swarm-from-${m.name}`, `@${m.name}`, sw.sender === m.name, `swarm:sender:${m.name}`))));

  let insertedUnread = false;
  const rows = [];
  for (const m of filtered) {
    if (!insertedUnread && sw.seenSeq > 0 && m.seq > sw.seenSeq) {
      insertedUnread = true;
      rows.push(
        h_flex().py(2).gap(8).items_center()
          .child(div().flex_1().h(1).bg(alpha(t.accent, 0.45)))
          .child(div().text_size(10.5).font_semibold().text_color(t.accent).child("NEW"))
          .child(div().flex_1().h(1).bg(alpha(t.accent, 0.45))),
      );
    }
    const jumped = sw.jumpSeq === m.seq;
    const bodyText = m.screenshots?.length ? stripScreenshotLines(m.text) : m.text;
    const citedSeqs = extractSeqRefs(m.text, swarm.head_seq).filter((n) => n !== m.seq);
    const thumbs = (m.screenshots ?? [])
      .filter((s) => s.local_path)
      .map((s, si) => thumbnail(`swarm-msg-shot-${m.seq}-${si}`, { path: s.local_path, size: null }, 116, 74, c))
      .filter(Boolean);

    rows.push(
      v_flex().id(`swarm-msg-${m.seq}`).p(9).gap(5).rounded(8).border_1()
        .border_color(jumped ? t.accent : t.border)
        .bg(jumped ? alpha(t.accent, 0.08) : t.background)
        .child(h_flex().gap(6).items_center().flex_wrap()
          .child(div().font_family(monoFont()).text_size(11).font_semibold().text_color(jumped ? t.accent : t.dim).child(`#${m.seq}`))
          .child(memberChip(`swarm-msg-author-${m.seq}`, m.agent, t, v))
          .when(m.channel && m.channel !== "main", (e) => e.child(div().px(5).py(1).rounded(4).bg(t.surface).text_size(10.5).text_color(t.muted).child(`#${m.channel}`)))
          .when(Boolean(m.control), (e) => e.child(div().px(5).py(1).rounded(4).bg(alpha(t.ansi5, 0.14)).text_size(10.5).text_color(t.ansi5).child(`${m.control.op} #${m.control.channel}`)))
          .child(div().flex_1())
          .child(div().text_size(10.5).text_color(t.dim).child(formatSwarmTime(m.ts, m.time)))
          .child(div().id(`swarm-reply-${m.seq}`).px(6).py(1).rounded(4).cursor_pointer().text_size(10.5).text_color(t.dim)
            .hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => v.control(`swarm:reply:${m.agent}`, cx))
            .child("Reply")))
        .when(Boolean(bodyText), (e) => e.child(div().text_size(12.5).line_height("18px").text_color(t.foreground).child(bodyText)))
        .when(thumbs.length > 0, (e) => e.child(h_flex().gap(6).flex_wrap().pt(2).children(thumbs)))
        .when(citedSeqs.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().pt(2)
          .child(div().text_size(10.5).text_color(t.dim).child("Cited:"))
          .children(citedSeqs.map((n) => seqPill(`swarm-cite-${m.seq}-${n}`, n, t, v))))),
    );
  }

  const targets = ["coordinator", "all", ...members.filter((m) => !m.killed && m.name !== "coordinator").map((m) => m.name)];
  const activeChannels = channels.filter((ch) => !ch.archived);

  const steerBar = postField
    ? v_flex().flex_none().px(12).py(8).gap(6).border_t_1().border_color(t.border).bg(t.surface)
      .child(h_flex().gap(4).items_center().flex_wrap()
        .child(div().text_size(11).text_color(t.dim).child("To:"))
        .children(targets.map((tg) => filterPill(`swarm-to-${tg}`, `@${tg}`, sw.postTarget === tg, `swarm:post:target:${tg}`)))
        .when(activeChannels.length > 1, (e) => e.child(h_flex().gap(4).pl(6).items_center()
          .child(div().text_size(11).text_color(t.dim).child("in"))
          .children(activeChannels.map((ch) => filterPill(`swarm-pch-${ch.name}`, `#${ch.name}`, sw.postChannel === ch.name, `swarm:post:channel:${ch.name}`))))))
      .child(h_flex().gap(6).items_center()
        .child(fieldWrap(
          "swarm-post-field",
          postField,
          "HerdrChatDialog",
          (cx) => v.control("swarm:post:submit", cx),
          (cx) => v.control("swarm:close", cx),
          Input.new(postField).h(28).px(8).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12),
        ))
        .child(smallBtn("swarm-post-send", sw.busyAction ? "Sending…" : "Send", t, {
          primary: true,
          disabled: sw.busyAction,
          onClick: (_e, cx) => v.control("swarm:post:submit", cx),
        })))
    : null;

  return v_flex().flex_1().min_h(0)
    .child(filterBar)
    .child(v_flex().id("swarm-board-feed").flex_1().min_h(0).overflow_y_scroll().p(12).gap(8)
      .when(rows.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim).child("No board posts match this filter.")))
      .children(rows))
    .when(Boolean(steerBar), (e) => e.child(steerBar));
}

// ---------------------------------------------------------------- Tab 3: Members + Transcript Inspector

function renderMembersTab(v, swarm, t) {
  const sw = v.swarm;
  if (sw.inspectedMember) return renderMemberInspector(v, swarm, t);

  const groups = groupSwarmMembers(swarm);
  const models = swarm.models ?? [];

  const renderMemberCard = (m) => {
    const col = memberToneColor(m.name, t);
    const showingModels = sw.modelPickerMember === m.name;
    const confirmingKill = sw.confirmKillMember === m.name;
    return v_flex().id(`swarm-mem-${m.name}`).p(10).gap(6).rounded(8).border_1()
      .border_color(m.status === "blocked" ? alpha(t.ansi1, 0.5) : t.border)
      .bg(t.background)
      .child(h_flex().gap(8).items_center().flex_wrap()
        .child(div().id(`swarm-mem-name-${m.name}`).text_size(12.5).font_semibold().text_color(col).cursor_pointer()
          .on_click((_e, cx) => v.control(`swarm:inspect:${m.name}`, cx))
          .child(`@${m.name}`))
        .child(statusBadge(m.status, t))
        .when(Boolean(m.model), (e) => e.child(div().px(5).py(1).rounded(4).bg(t.surface).font_family(monoFont()).text_size(10.5).text_color(t.muted).child(m.model)))
        .when(Boolean(m.workspace_mode && m.workspace_mode !== "inherit"), (e) => e.child(div().px(5).py(1).rounded(4).bg(t.surface).text_size(10.5).text_color(t.dim).child(m.workspace_mode)))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(`${m.steps} steps · ${m.posts} posts${m.unread ? ` · ${m.unread} unread` : ""}`)))
      .when(Boolean(m.activity), (e) => e.child(div().text_size(12).text_color(t.foreground).child(m.activity)))
      .when(Boolean(m.failure), (e) => e.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.ansi1)
        .child(icon("alert", 12))
        .child(div().flex_1().min_w(0).child(m.failure.message))))
      .child(h_flex().gap(6).flex_wrap().items_center()
        .child(smallBtn(`mem-insp-${m.name}`, "Inspect", t, { ic: "eye", onClick: (_e, cx) => v.control(`swarm:inspect:${m.name}`, cx) }))
        .when(!m.killed, (e) => e.child(smallBtn(`mem-msg-${m.name}`, "Message", t, { ic: "message", onClick: (_e, cx) => v.control(`swarm:reply:${m.name}`, cx) })))
        .when(!m.killed, (e) => e.child(smallBtn(`mem-mod-${m.name}`, "Model", t, { active: showingModels, ic: "cpu", onClick: (_e, cx) => v.control(`swarm:model:open:${m.name}`, cx) })))
        .when(!m.killed && m.name !== "coordinator", (e) => e.child(smallBtn(`mem-nudge-${m.name}`, "Nudge", t, { onClick: (_e, cx) => v.control(`swarm:nudge:${m.name}`, cx) })))
        .when(m.status === "blocked" && Boolean(v.view), (e) => e.child(smallBtn(`mem-term-${m.name}`, "Approve in terminal", t, { danger: true, ic: "terminal", onClick: (_e, cx) => v.control("swarm:terminal", cx) })))
        .when(!m.killed && m.name !== "coordinator" && !confirmingKill, (e) => e.child(smallBtn(`mem-kill-${m.name}`, "Kill", t, { danger: true, onClick: (_e, cx) => v.control(`swarm:kill:ask:${m.name}`, cx) })))
        .when(confirmingKill, (e) => e.child(h_flex().gap(4).items_center()
          .child(smallBtn(`mem-kill-yes-${m.name}`, `Confirm kill @${m.name}`, t, { danger: true, onClick: (_e, cx) => v.control(`swarm:kill:confirm:${m.name}`, cx) }))
          .child(smallBtn(`mem-kill-no-${m.name}`, "Cancel", t, { onClick: (_e, cx) => v.control("swarm:kill:cancel", cx) })))))
      .when(showingModels, (e) => e.child(
        v_flex().pt(4).gap(4).border_t_1().border_color(t.border)
          .child(div().text_size(11).text_color(t.dim).child(`Switch @${m.name} model:`))
          .child(h_flex().gap(5).flex_wrap()
            .children(models.map((mod) => smallBtn(`mem-setmod-${m.name}-${mod}`, mod, t, {
              active: mod === m.model,
              onClick: (_e, cx) => v.control(`swarm:model:set:${m.name}:${mod}`, cx),
            })))),
      ));
  };

  let addForm = null;
  if (sw.addOpen && sw.addNameInput && sw.addModelInput && sw.addBriefInput) {
    addForm = v_flex().id("swarm-add-form").p(10).gap(8).rounded(8).border_1().border_color(alpha(t.accent, 0.45)).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.foreground).child("Spawn new swarm worker"))
        .child(smallBtn("swarm-add-cancel", "Cancel", t, { onClick: (_e, cx) => v.control("swarm:add:close", cx) })))
      .child(h_flex().gap(8)
        .child(fieldWrap("swarm-add-name", sw.addNameInput, "HerdrChatDialog", null, (cx) => v.control("swarm:add:close", cx),
          Input.new(sw.addNameInput).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(12)))
        .child(fieldWrap("swarm-add-model", sw.addModelInput, "HerdrChatDialog", null, (cx) => v.control("swarm:add:close", cx),
          Input.new(sw.addModelInput).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(12))))
      .when(models.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().items_center()
        .child(div().text_size(11).text_color(t.dim).child("Presets:"))
        .children(models.slice(0, 6).map((mod) => smallBtn(`swarm-add-m-${mod}`, mod, t, {
          active: sw.addModel === mod,
          onClick: (_e, cx) => v.control(`swarm:add:model:${mod}`, cx),
        })))))
      .child(h_flex().gap(5).items_center()
        .child(div().text_size(11).text_color(t.dim).child("Workspace:"))
        .children(WORKSPACES.map((ws) => smallBtn(`swarm-add-ws-${ws}`, ws, t, {
          active: sw.addWorkspace === ws,
          onClick: (_e, cx) => v.control(`swarm:add:ws:${ws}`, cx),
        }))))
      .child(fieldWrap("swarm-add-brief", sw.addBriefInput, "HerdrChatEditor", (cx) => v.control("swarm:add:submit", cx), (cx) => v.control("swarm:add:close", cx),
        Textarea.new(sw.addBriefInput).w_full().px(8).py(6).rounded(6).border_1().border_color(t.input).bg(t.surface).text_size(12)))
      .child(h_flex().justify_end().gap(6)
        .child(smallBtn("swarm-add-submit", sw.busyAction ? "Spawning…" : "Spawn worker", t, {
          primary: true,
          disabled: sw.busyAction,
          onClick: (_e, cx) => v.control("swarm:add:submit", cx),
        })));
  }

  const groupBlock = (title, list) => list.length
    ? v_flex().gap(6)
      .child(div().text_size(11).font_semibold().text_color(t.muted).child(`${title} (${list.length})`))
      .children(list.map(renderMemberCard))
    : null;

  return v_flex().id("swarm-members-body").flex_1().min_h(0).overflow_y_scroll().p(12).gap(12)
    .child(h_flex().items_center().gap(8)
      .child(div().flex_1().text_size(12).text_color(t.muted).child(`${plural(swarm.counts?.active ?? 0, "active agent")} · ${swarm.counts?.working ?? 0} working`))
      .child(smallBtn("swarm-add-btn", sw.addOpen ? "Hide form" : "Add worker", t, {
        primary: !sw.addOpen,
        ic: "plus",
        onClick: (_e, cx) => v.control("swarm:add:open", cx),
      })))
    .when(Boolean(addForm), (e) => e.child(addForm))
    .children([
      groupBlock("ACTIVE", groups.active),
      groupBlock("WAITING", groups.waiting),
      groupBlock("SUPPORT ROLES", groups.roles),
      groupBlock("STOPPED", groups.stopped),
    ].filter(Boolean));
}

function renderMemberInspector(v, swarm, t) {
  const sw = v.swarm;
  const name = sw.inspectedMember;
  const liveMember = (swarm.members ?? []).find((m) => m.name === name) ?? sw.memberDetail?.member ?? null;
  const events = sw.memberDetail?.events ?? [];
  const col = memberToneColor(name, t);
  const models = swarm.models ?? [];
  const showingModels = sw.modelPickerMember === name;
  const confirmingKill = sw.confirmKillMember === name;
  const mono = monoFont();

  const header = v_flex().flex_none().p(10).gap(6).border_b_1().border_color(t.border).bg(t.surface)
    .child(h_flex().gap(6).items_center().flex_wrap()
      .child(smallBtn("swarm-insp-back", "← Roster", t, { onClick: (_e, cx) => v.control("swarm:inspect:close", cx) }))
      .child(div().text_size(13).font_semibold().text_color(col).child(`@${name}`))
      .when(Boolean(liveMember), (e) => e.child(statusBadge(liveMember.status, t)))
      .when(Boolean(liveMember?.model), (e) => e.child(div().px(5).py(1).rounded(4).bg(t.background).font_family(mono).text_size(10.5).text_color(t.muted).child(liveMember.model)))
      .child(div().flex_1())
      .when(Boolean(liveMember && !liveMember.killed), (e) => e.child(smallBtn("insp-msg", "Message", t, { ic: "message", onClick: (_e, cx) => v.control(`swarm:reply:${name}`, cx) })))
      .when(Boolean(liveMember && !liveMember.killed), (e) => e.child(smallBtn("insp-mod", "Model", t, { active: showingModels, ic: "cpu", onClick: (_e, cx) => v.control(`swarm:model:open:${name}`, cx) })))
      .when(Boolean(liveMember && !liveMember.killed && name !== "coordinator"), (e) => e.child(smallBtn("insp-nudge", "Nudge", t, { onClick: (_e, cx) => v.control(`swarm:nudge:${name}`, cx) })))
      .when(Boolean(liveMember?.status === "blocked" && v.view), (e) => e.child(smallBtn("insp-term", "Approve", t, { danger: true, ic: "terminal", onClick: (_e, cx) => v.control("swarm:terminal", cx) })))
      .when(Boolean(liveMember && !liveMember.killed && name !== "coordinator" && !confirmingKill), (e) => e.child(smallBtn("insp-kill", "Kill", t, { danger: true, onClick: (_e, cx) => v.control(`swarm:kill:ask:${name}`, cx) })))
      .when(confirmingKill, (e) => e.child(h_flex().gap(4)
        .child(smallBtn("insp-kill-yes", "Confirm kill", t, { danger: true, onClick: (_e, cx) => v.control(`swarm:kill:confirm:${name}`, cx) }))
        .child(smallBtn("insp-kill-no", "Cancel", t, { onClick: (_e, cx) => v.control("swarm:kill:cancel", cx) })))))
    .when(Boolean(liveMember?.activity), (e) => e.child(div().text_size(11.5).text_color(t.accent).child(`Now: ${liveMember.activity}`)))
    .when(showingModels, (e) => e.child(h_flex().gap(5).flex_wrap().pt(2)
      .children(models.map((mod) => smallBtn(`insp-setmod-${mod}`, mod, t, {
        active: mod === liveMember?.model,
        onClick: (_e, cx) => v.control(`swarm:model:set:${name}:${mod}`, cx),
      })))));

  const eventCard = (ev, i) => {
    const key = `${name}:${ev.step_index}:${i}`;
    if (ev.kind === "tool") {
      const open = sw.expandedTools.has(key);
      return v_flex().id(`swarm-ev-${i}`).px(9).py(6).gap(4).rounded(7).border_1().border_color(t.border).bg(t.background)
        .child(h_flex().id(`swarm-ev-hdr-${i}`).gap(6).items_center().cursor_pointer()
          .on_click((_e, cx) => v.control(`swarm:tool:${key}`, cx))
          .child(icon("wrench", 11).text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(11.5).text_color(t.foreground).child(ev.tool_summary || ev.tool_name || "tool"))
          .when(Boolean(ev.tool_input), (e) => e.child(icon(open ? "chevron-down" : "chevron-right", 11).text_color(t.dim))))
        .when(open && Boolean(ev.tool_input), (e) => e.child(div().p(6).rounded(5).bg(t.surface).font_family(mono).text_size(11).text_color(t.muted).child(ev.tool_input)));
    }
    if (ev.kind === "tool_output") {
      return div().id(`swarm-ev-${i}`).px(9).py(6).rounded(7).border_1()
        .border_color(ev.error ? alpha(t.ansi1, 0.45) : t.border)
        .bg(ev.error ? alpha(t.ansi1, 0.08) : t.surface)
        .font_family(mono).text_size(11).line_height("16px").text_color(ev.error ? t.ansi1 : t.muted)
        .child((ev.text || "").slice(0, 700));
    }
    if (ev.kind === "thinking") {
      return div().id(`swarm-ev-${i}`).px(9).py(6).rounded(7).bg(alpha(t.surface, 0.7))
        .text_size(11.5).italic().line_height("17px").text_color(t.dim)
        .child((ev.text || "").slice(0, 500));
    }
    if (ev.kind === "error") {
      return div().id(`swarm-ev-${i}`).px(9).py(6).rounded(7).border_1().border_color(alpha(t.ansi1, 0.5))
        .bg(alpha(t.ansi1, 0.1)).text_size(12).text_color(t.ansi1).child(ev.text || "Error");
    }
    const isUser = ev.kind === "user";
    return v_flex().id(`swarm-ev-${i}`).px(9).py(7).gap(3).rounded(7).border_1()
      .border_color(isUser ? alpha(t.accent, 0.35) : t.border)
      .bg(isUser ? alpha(t.accent, 0.07) : t.background)
      .child(div().text_size(10.5).font_semibold().text_color(isUser ? t.accent : t.muted).child(isUser ? "Prompt" : ev.kind === "system" ? "System" : `@${name}`))
      .child(div().text_size(12).line_height("18px").text_color(t.foreground).child((ev.text || "").slice(0, 1200)));
  };

  return v_flex().flex_1().min_h(0)
    .child(header)
    .child(v_flex().id("swarm-member-events").flex_1().min_h(0).overflow_y_scroll().p(12).gap(6)
      .when(sw.memberLoading && !events.length, (e) => e.child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim).child(spinner(11)).child("Loading transcript…")))
      .when(Boolean(sw.memberError) && !events.length, (e) => e.child(div().text_size(12).text_color(t.ansi1).child(sw.memberError)))
      .when(!sw.memberLoading && !sw.memberError && !events.length, (e) => e.child(div().text_size(12).text_color(t.dim).child("No transcript steps recorded yet.")))
      .children(events.map(eventCard)));
}

// ---------------------------------------------------------------- Tab 4: Communication Graph + Timeline Replay

function renderGraphTab(v, swarm, t, c) {
  const sw = v.swarm;
  const g = sw.graphData;
  const seqs = (swarm.messages ?? []).map((m) => m.seq);
  const minSeq = seqs[0] ?? 1;
  const maxSeq = swarm.head_seq || seqs[seqs.length - 1] || 0;
  const live = sw.replaySeq === null || sw.replaySeq >= maxSeq;
  const curSeq = sw.replaySeq === null ? maxSeq : Math.min(maxSeq, Math.max(minSeq, sw.replaySeq));
  const speed = SPEEDS[sw.speedIdx] ?? 1;

  const relSvg = g?.path ? c.imageRel(g.path) : null;
  const stageW = Math.min(640, Math.max(320, (c?.colW ?? 680) - 48));
  const stageH = Math.round(stageW * ((g?.h ?? 380) / (g?.w ?? 640)));

  const toolbar = h_flex().flex_none().px(12).py(8).gap(6).items_center().flex_wrap().border_b_1().border_color(t.border).bg(t.surface)
    .child(smallBtn("swarm-g-all", `Expand @all${g?.allPostCount ? ` (${g.allPostCount})` : ""}`, t, {
      active: sw.expandAll,
      onClick: (_e, cx) => v.control("swarm:graph:all", cx),
    }))
    .child(smallBtn("swarm-g-inactive", "Hide inactive", t, {
      active: sw.hideInactive,
      onClick: (_e, cx) => v.control("swarm:graph:inactive", cx),
    }))
    .child(div().flex_1())
    .when(Boolean(relSvg), (e) => e.child(smallBtn("swarm-g-zoom", "Zoom SVG", t, {
      ic: "maximize",
      onClick: (_e, cx) => v.control("swarm:graph:enlarge", cx),
    })));

  // Pick up to 16 evenly sampled scrub stops along the board timeline for one-click scrubbing.
  const scrubStops = [];
  if (seqs.length <= 16) {
    for (const s of seqs) scrubStops.push(s);
  } else {
    for (let i = 0; i < 16; i++) {
      const idx = Math.min(seqs.length - 1, Math.round((i / 15) * (seqs.length - 1)));
      const val = seqs[idx];
      if (scrubStops[scrubStops.length - 1] !== val) scrubStops.push(val);
    }
  }

  const replayBar = maxSeq > 0
    ? v_flex().p(10).gap(7).rounded(8).border_1().border_color(t.border).bg(t.background)
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(smallBtn("swarm-rp-prev", "◀ Prev", t, { disabled: curSeq <= minSeq, onClick: (_e, cx) => v.control("swarm:replay:prev", cx) }))
        .child(smallBtn("swarm-rp-play", sw.playing ? "⏸ Pause" : "▶ Play", t, { primary: sw.playing, onClick: (_e, cx) => v.control("swarm:replay:play", cx) }))
        .child(smallBtn("swarm-rp-next", "Next ▶", t, { disabled: live, onClick: (_e, cx) => v.control("swarm:replay:next", cx) }))
        .child(smallBtn("swarm-rp-speed", `${speed}×`, t, { onClick: (_e, cx) => v.control("swarm:replay:speed", cx) }))
        .child(smallBtn("swarm-rp-live", "● Live", t, { active: live, onClick: (_e, cx) => v.control("swarm:replay:live", cx) }))
        .child(div().flex_1())
        .child(div().font_family(monoFont()).text_size(11.5).text_color(t.muted).child(`#${curSeq} / #${maxSeq}`)))
      .when(scrubStops.length > 1, (e) => e.child(h_flex().gap(3).items_center().flex_wrap()
        .children(scrubStops.map((sq) => {
          const past = sq <= curSeq;
          const exact = sq === curSeq;
          return div().id(`swarm-scrub-${sq}`).h(18).px(5).flex().items_center().rounded(4).cursor_pointer()
            .font_family(monoFont()).text_size(10)
            .bg(exact ? t.accent : past ? alpha(t.accent, 0.16) : t.surface)
            .text_color(exact ? t.solid_foreground : past ? t.accent : t.dim)
            .hover((st) => st.opacity(0.85))
            .on_click((_e, cx) => v.control(`swarm:replay:seq:${sq}`, cx))
            .child(`#${sq}`);
        }))))
      .when(Boolean(g?.activeMessage), (e) => e.child(
        v_flex().pt(4).gap(4).border_t_1().border_color(t.border)
          .child(h_flex().gap(6).items_center()
            .child(memberChip("swarm-rp-author", g.activeMessage.agent, t, v))
            .child(div().font_family(monoFont()).text_size(11).text_color(t.dim).child(`#${g.activeMessage.seq}`))
            .when(g.activeMessage.channel && g.activeMessage.channel !== "main", (x) => x.child(div().text_size(11).text_color(t.dim).child(`#${g.activeMessage.channel}`)))
            .child(div().flex_1())
            .child(smallBtn("swarm-rp-jump", "Jump in Board", t, { onClick: (_e, cx) => v.control(`swarm:jump:${g.activeMessage.seq}`, cx) })))
          .child(div().text_size(12).line_height("17px").text_color(t.foreground).child((g.activeMessage.text || "").slice(0, 220))),
      ))
    : null;

  return v_flex().flex_1().min_h(0)
    .child(toolbar)
    .child(v_flex().id("swarm-graph-body").flex_1().min_h(0).overflow_y_scroll().p(12).gap(10)
      .child(h_flex().id("swarm-graph-stage").w_full().justify_center().rounded(10).border_1().border_color(t.border).bg(t.background).p(6)
        .when(Boolean(relSvg), (e) => e.cursor_pointer().tooltip("Click to zoom & pan SVG")
          .on_click((_e, cx) => v.control("swarm:graph:enlarge", cx))
          .child(image(relSvg).w(stageW).h(stageH)))
        .when(!relSvg, (e) => e.h(180).items_center().justify_center()
          .child(h_flex().gap(6).items_center().text_size(12).text_color(t.dim)
            .child(spinner(11)).child("Rendering communication graph…"))))
      .when((g?.nodes?.length ?? 0) > 0, (e) => e.child(
        h_flex().gap(6).flex_wrap().items_center()
          .child(div().text_size(11).text_color(t.dim).child("Inspect:"))
          .children(g.nodes.map((n) => memberChip(`swarm-gnode-${n.name}`, n.name, t, v, {
            active: n.activeAtStep,
            suffix: ` (${n.posts})`,
          }))),
      ))
      .when(Boolean(replayBar), (e) => e.child(replayBar)));
}
