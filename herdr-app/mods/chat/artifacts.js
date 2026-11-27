// Antigravity artifact review & approval UI for Herdr desktop Chat view:
//   - Inline review card above the composer when Antigravity pauses for artifact approval;
//   - Spacious full-height Markdown reader modal (Expand button, artifact strip, or `/artifact`);
//   - Compact pending-artifact strip above the composer after dismissing the card.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { alpha, icon, message, plural, spinner } from "./util.js";
import { SPACE } from "./space.js";
import { markdown } from "./rich.js";
import { copyField, pasteField } from "./composer.js";
import { MAC } from "./platform.js";
import {
  artifactChoices,
  artifactShortName,
  artifactShortcutAnswer,
  artifactStatusLabel,
  artifactStatusTone,
  formatArtifactBytes,
  pendingArtifactsOf,
  pickActiveArtifact,
} from "./artifact-logic.js";

export class ArtifactReviewPanel {
  /** @param {any} view @param {any} cx */
  constructor(view, cx) {
    this.view = view;
    this.modalOpen = false;
    this.activeName = null;
    this.cache = new Map(); // name -> ArtifactEntry with content
    this.loadingName = null;
    this.loadError = null;
    this.submitting = false;
    this.lastDialogId = null;
    this.feedbackInput = null;
    this.modalFocus = cx?.focus_handle?.() ?? null;
  }

  ensureFeedbackInput() {
    if (!this.feedbackInput) {
      this.feedbackInput = TextareaState.new({ placeholder: "Add comments or requested changes… (optional)" });
      this.feedbackInput.set_auto_grow(1, 5);
      this.feedbackInput.on("change", (_e, cx) => {
        this.view.debug?.mark?.();
        cx.notify();
      });
    }
    return this.feedbackInput;
  }

  feedbackValue() {
    return String(this.feedbackInput?.value?.() ?? "");
  }

  clearFeedback() {
    this.feedbackInput?.set_value?.("");
  }

  release() {
    this.modalOpen = false;
    this.feedbackInput?.release?.();
    this.feedbackInput = null;
    this.modalFocus?.release?.();
    this.modalFocus = null;
    this.cache.clear();
  }

  /** Synchronize local selection and content cache whenever host ChatState updates. */
  sync(state) {
    const dlg = state?.dialog?.method === "artifact" ? state.dialog : null;
    const list = Array.isArray(state?.artifacts) ? state.artifacts : [];

    // Seed cache directly from any artifact dialog payload (already includes bounded Markdown content).
    if (dlg && Array.isArray(dlg.artifacts)) {
      for (const a of dlg.artifacts) {
        if (a?.name && typeof a.content === "string") {
          this.cache.set(a.name, a);
        }
      }
      if (dlg.id !== this.lastDialogId) {
        this.lastDialogId = dlg.id;
        this.ensureFeedbackInput();
        const picked = pickActiveArtifact(dlg.artifacts, this.activeName);
        this.activeName = picked?.name ?? null;
        this.submitting = false;
        this.loadError = null;
      }
    } else if (this.lastDialogId !== null) {
      this.lastDialogId = null;
      this.submitting = false;
    }

    // Invalidate cached content if on-disk metadata changed.
    const byName = new Map(list.map((a) => [a.name, a]));
    for (const [name, cached] of [...this.cache.entries()]) {
      const fresh = byName.get(name);
      if (!fresh) continue;
      if ((fresh.updatedAt ?? null) !== (cached.updatedAt ?? null) || (fresh.sizeBytes ?? null) !== (cached.sizeBytes ?? null)) {
        // Keep fresh dialog content if just seeded above; otherwise drop stale cache.
        const inDialog = dlg?.artifacts?.some((x) => x.name === name && typeof x.content === "string");
        if (!inDialog) this.cache.delete(name);
      } else if (fresh.status !== cached.status) {
        this.cache.set(name, { ...cached, status: fresh.status, summary: fresh.summary ?? cached.summary });
      }
    }

    if (this.modalOpen) {
      const merged = this.allArtifacts(state);
      const picked = pickActiveArtifact(merged, this.activeName);
      if (picked && picked.name !== this.activeName) this.activeName = picked.name;
    }
  }

  /** Merged list of conversation artifacts + any dialog artifacts, hydrated with cached content. */
  allArtifacts(state) {
    const map = new Map();
    for (const a of Array.isArray(state?.artifacts) ? state.artifacts : []) {
      if (a?.name) map.set(a.name, { ...a });
    }
    const dlg = state?.dialog?.method === "artifact" ? state.dialog : null;
    for (const a of dlg?.artifacts ?? []) {
      if (a?.name) map.set(a.name, { ...(map.get(a.name) ?? {}), ...a });
    }
    const out = [];
    for (const entry of map.values()) {
      const cached = this.cache.get(entry.name);
      if (cached && typeof entry.content !== "string" && typeof cached.content === "string") {
        out.push({ ...entry, content: cached.content, truncated: cached.truncated, sizeBytes: cached.sizeBytes ?? entry.sizeBytes });
      } else {
        out.push(entry);
      }
    }
    const order = { pending: 0, rejected: 1, approved: 2 };
    out.sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return out;
  }

  openModal(name, cx) {
    this.ensureFeedbackInput();
    this.modalOpen = true;
    this.loadError = null;
    this.view.composer.menu = null;
    const all = this.allArtifacts(this.view.store.state);
    const target = pickActiveArtifact(all, name ?? this.activeName);
    this.activeName = target?.name ?? null;
    if (target && typeof target.content !== "string") {
      this.fetchArtifact(target.name, cx);
    }
    this.modalFocus?.focus?.();
    this.view.debug?.mark?.();
    cx.notify();
  }

  closeModal(cx) {
    if (!this.modalOpen) return false;
    this.modalOpen = false;
    this.loadError = null;
    this.view.composer?.focus?.();
    this.view.debug?.mark?.();
    cx.notify();
    return true;
  }

  select(name, cx) {
    if (!name) return;
    this.activeName = name;
    this.loadError = null;
    const all = this.allArtifacts(this.view.store.state);
    const entry = all.find((a) => a.name === name);
    if (entry && typeof entry.content !== "string") {
      this.fetchArtifact(name, cx);
    }
    this.view.debug?.mark?.();
    cx.notify();
  }

  fetchArtifact(name, cx) {
    if (!name || this.loadingName === name) return;
    this.loadingName = name;
    this.loadError = null;
    cx.spawn(async (cx) => {
      try {
        const d = await this.view.req("artifact_read", { name }, cx);
        if (d?.artifact) {
          this.cache.set(d.artifact.name, d.artifact);
          this.loadError = null;
        }
      } catch (e) {
        if (this.activeName === name) this.loadError = message(e);
      } finally {
        if (this.loadingName === name) this.loadingName = null;
        this.view.debug?.mark?.();
        cx.notify();
      }
    });
  }

  /** Submit an artifact review action (`approve`, `approve_all`, `reject`, `comment`, `dismiss`). */
  submit(action, artifactName, cx, { fromDialog = false, feedbackOverride = null } = {}) {
    if (this.submitting && action !== "dismiss") return;
    const feedback = (feedbackOverride ?? this.feedbackValue()).trim();
    if (action === "comment" && !feedback) {
      this.ensureFeedbackInput().focus();
      this.view.flash("Add a comment before sending", cx);
      return;
    }
    const dlg = this.view.store.state.dialog;
    const isDialog = fromDialog && dlg?.method === "artifact";
    const payload = {
      artifactAction: action,
      ...(artifactName ? { artifact: artifactName } : {}),
      ...(feedback ? { message: feedback } : {}),
    };

    if (isDialog) {
      if (action !== "dismiss") {
        this.clearFeedback();
        this.modalOpen = false;
      }
      this.view.answer("artifact", payload, cx);
      return;
    }

    if (action === "dismiss") {
      this.closeModal(cx);
      if (dlg?.method === "artifact") {
        this.view.answer("artifact", { artifactAction: "dismiss" }, cx);
      } else {
        this.view.fire("artifact_review", { action: "dismiss" }, cx);
      }
      return;
    }

    this.submitting = true;
    this.view.debug?.mark?.();
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.view.req("artifact_review", {
          action,
          ...(artifactName ? { artifact: artifactName } : {}),
          ...(feedback ? { message: feedback } : {}),
        }, cx);
        this.clearFeedback();
        const remaining = pendingArtifactsOf(this.allArtifacts(this.view.store.state))
          .filter((a) => action === "approve_all" ? false : a.name !== artifactName);
        if (remaining.length === 0 || action === "approve_all" || action === "comment") {
          this.modalOpen = false;
          this.view.composer?.focus?.();
        } else {
          this.activeName = remaining[0].name;
          if (typeof remaining[0].content !== "string") this.fetchArtifact(remaining[0].name, cx);
        }
        const verb = action === "approve_all" ? "Approved all artifacts"
          : action === "approve" ? `Approved ${artifactShortName(artifactName)}`
            : action === "reject" ? `Requested changes on ${artifactShortName(artifactName)}`
              : `Sent comments on ${artifactShortName(artifactName)}`;
        this.view.flash(verb, cx);
      } catch (e) {
        this.view.flash(`Artifact review: ${message(e)}`, cx);
      } finally {
        this.submitting = false;
        this.view.debug?.mark?.();
        cx.notify();
      }
    });
  }

  /** Keyboard shortcut (`1–9`, `"enter"`, `"escape"`) when the inline artifact card is shown and composer is empty. */
  shortcut(key, dlg, cx) {
    const ans = artifactShortcutAnswer(key, dlg?.artifacts ?? [], this.activeName, this.feedbackValue());
    if (!ans) return false;
    this.submit(ans.artifactAction, ans.artifact ?? null, cx, { fromDialog: true, feedbackOverride: ans.message ?? "" });
    return true;
  }

  /** Dispatch `artifact:<cmd>` clicks from main.js `control()`. */
  control(cmd, cx) {
    if (cmd === "close") return this.closeModal(cx);
    if (cmd === "expand") return this.openModal(this.activeName, cx);
    if (cmd === "open-terminal") {
      this.modalOpen = false;
      return this.view.viewCommand("artifact", cx);
    }
    if (cmd.startsWith("open:")) return this.openModal(cmd.slice(5) || null, cx);
    if (cmd.startsWith("select:")) return this.select(cmd.slice(7), cx);
    if (cmd.startsWith("file:")) {
      const name = cmd.slice(5);
      const entry = this.allArtifacts(this.view.store.state).find((a) => a.name === name);
      if (entry?.path) {
        this.modalOpen = false;
        this.view.openFile(entry.path, undefined, cx, { mustExist: true });
      }
      return;
    }
    if (cmd.startsWith("copy:")) {
      const name = cmd.slice(5);
      const entry = this.allArtifacts(this.view.store.state).find((a) => a.name === name);
      if (entry?.content) this.view.copy(`artifact:${name}`, entry.content, cx);
      return;
    }
    if (cmd === "dismiss") {
      return this.submit("dismiss", null, cx, { fromDialog: this.view.store.state.dialog?.method === "artifact" });
    }
    if (cmd.startsWith("action:")) {
      // action:<act>:<artifactName?>
      const rest = cmd.slice(7);
      const sep = rest.indexOf(":");
      const act = sep >= 0 ? rest.slice(0, sep) : rest;
      const target = sep >= 0 ? rest.slice(sep + 1) || null : null;
      const viaDialog = !this.modalOpen && this.view.store.state.dialog?.method === "artifact";
      return this.submit(act, target, cx, { fromDialog: viaDialog });
    }
  }

  dump(state) {
    const list = this.allArtifacts(state);
    return {
      count: list.length,
      pending: pendingArtifactsOf(list).length,
      active: this.activeName,
      modalOpen: this.modalOpen,
      submitting: this.submitting,
      names: list.map((a) => `${a.name}:${a.status}`),
    };
  }
}

function actionButton(id, ch, t, busy, onClick) {
  const allow = ch.kind === "allow";
  const deny = ch.kind === "deny";
  const bg = allow ? t.solid : deny ? alpha(t.ansi1, 0.14) : t.raised;
  const fg = allow ? t.solid_foreground : deny ? t.ansi1 : t.foreground;
  const border = allow ? t.solid : deny ? alpha(t.ansi1, 0.45) : t.input;
  let el = h_flex().id(id).flex_none().min_h(30).px(12).py(5).gap(7).items_center().rounded(8)
    .border_1().border_color(border).bg(bg).text_color(fg).text_size(12.5).font_medium()
    .tooltip(ch.description ?? ch.label);
  if (busy) {
    el = el.opacity(0.6);
  } else {
    el = el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick);
  }
  if (ch.key != null) {
    el = el.child(div().flex_none().text_size(10.5).opacity(0.65).child(String(ch.key)));
  }
  return el.child(ch.label);
}

function smallHeaderBtn(id, ic, label, tip, t, onClick) {
  return h_flex().id(id).flex_none().h(24).px(8).gap(5).items_center().rounded(6).cursor_pointer()
    .border_1().border_color(t.border).bg(t.surface).text_size(11.5).text_color(t.muted)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(onClick)
    .when(Boolean(ic), (e) => e.child(icon(ic, 12)))
    .when(Boolean(label), (e) => e.child(label));
}

function artifactTabs(artifacts, activeName, t, onSelect, idPrefix) {
  if (!Array.isArray(artifacts) || artifacts.length <= 1) return null;
  return h_flex().w_full().gap(6).flex_wrap().items_center().children(
    artifacts.map((a, idx) => {
      const selected = a.name === activeName;
      const tone = artifactStatusTone(a.status, t);
      return h_flex().id(`${idPrefix}-tab-${idx}`).flex_none().h(26).px(9).gap(6).items_center().rounded(7).cursor_pointer()
        .border_1().border_color(selected ? tone : t.border)
        .bg(selected ? alpha(tone, 0.14) : t.surface)
        .text_size(12).text_color(selected ? t.foreground : t.muted)
        .when(selected, (e) => e.font_medium())
        .hover((s) => s.bg(selected ? alpha(tone, 0.18) : t.hover).text_color(t.foreground))
        .tooltip(`${a.name} · ${artifactStatusLabel(a.status)}`)
        .on_click((_e, cx) => onSelect(a.name, cx))
        .child(div().flex_none().size(6).rounded(3).bg(tone))
        .child(artifactShortName(a.name));
    }),
  );
}

function renderArtifactMarkdown(id, entry, t, c, { loading = false, error = null } = {}) {
  if (loading) {
    return h_flex().p(16).gap(8).items_center().text_size(12.5).text_color(t.muted)
      .child(spinner(13, t.muted))
      .child(`Loading ${entry?.name ?? "artifact"}…`);
  }
  if (error) {
    return h_flex().p(14).gap(8).items_center().text_size(12.5).text_color(t.ansi1)
      .child(icon("alert", 13))
      .child(error);
  }
  const content = typeof entry?.content === "string" ? entry.content : "";
  if (!content.trim()) {
    return div().p(14).text_size(12.5).text_color(t.dim).child("(Empty artifact file)");
  }
  return v_flex().w_full().min_w(0).gap(8)
    .child(markdown(id, content, c?.onLink, t, {
      onSelect: c?.onSelect ? (vid, sel, src, cx) => c.onSelect(vid, sel, { itemId: `artifact:${entry.name}`, source: src }, cx) : null,
    }))
    .when(Boolean(entry?.truncated), (e) => e.child(
      h_flex().pt(8).gap(6).items_center().border_t_1().border_color(alpha(t.border, 0.7)).text_size(11.5).text_color(t.dim)
        .child(icon("info", 12))
        .child("Preview truncated at 128 KB — click Open file to read the full document."),
    ));
}

function feedbackBox(panel, id, t, onSubmit, onEscape) {
  const ta = panel.feedbackInput;
  if (!ta) return null;
  return div().id(id).w_full().key_context("HerdrChatEditor")
    .on_action("herdrchat_dialog_enter", (_e, cx) => onSubmit(cx))
    .on_action("herdrchat_dialog_escape", (_e, cx) => onEscape(cx))
    .on_action("herdrchat_copy", (_e, cx) => copyField(ta, cx))
    .on_action("herdrchat_paste", (_e, cx) => pasteField(ta, cx))
    .child(Textarea.new(ta).w_full().px(10).py(6).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground));
}

/** Inline Artifact Review & Approval card rendered above the composer when `state.dialog.method === "artifact"`. */
export function artifactDialogCard(v, d, pendingDialogs, t, c) {
  const panel = v.artifacts;
  if (!panel || panel.modalOpen) return null;
  const list = Array.isArray(d?.artifacts) && d.artifacts.length ? d.artifacts : pendingArtifactsOf(panel.allArtifacts(v.store.state));
  const active = pickActiveArtifact(list, panel.activeName);
  if (!active) return null;

  const hasFeedback = Boolean(panel.feedbackValue().trim());
  const choices = artifactChoices(list, active.name, hasFeedback);
  const tabs = artifactTabs(list, active.name, t, (name, cx) => panel.select(name, cx), "art-inline");
  const sizeLabel = formatArtifactBytes(active.sizeBytes);
  const primary = choices.find((x) => x.kind === "allow") ?? choices[0];

  const onEnterFeedback = (cx) => {
    const fb = panel.feedbackValue().trim();
    panel.submit(fb ? "reject" : primary?.action ?? "approve", fb ? active.name : (primary?.artifact ?? active.name), cx, { fromDialog: true });
  };

  return v_flex().id("artifact-dialog-card").w_full().min_w(0).gap(SPACE.block).p(12).rounded(14)
    .border_1().border_color(alpha(t.blocked, 0.72)).bg(t.popover).shadow_md()
    .child(h_flex().gap(8).items_center()
      .child(icon("file-text", 14).text_color(t.blocked))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground)
        .child(d.title || `Review ${active.name}`))
      .when(Boolean(sizeLabel), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(sizeLabel)))
      .when(pendingDialogs > 1, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${pendingDialogs - 1} more`)))
      .child(smallHeaderBtn("art-inline-file", "book", "Open file", `Open ${active.name} in files viewer`, t, (_e, cx) => v.control(`artifact:file:${active.name}`, cx)))
      .child(smallHeaderBtn("art-inline-expand", "maximize", "Expand", "Open full-height artifact review", t, (_e, cx) => v.control("artifact:expand", cx)))
      .child(div().id("dlg-cancel").px(4).cursor_pointer().text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
        .tooltip("Dismiss card (keeps artifact strip above composer)")
        .on_click((_e, cx) => v.control("artifact:dismiss", cx))
        .child("Esc")))
    .when(Boolean(tabs), (e) => e.child(tabs))
    .when(Boolean(active.summary), (e) => e.child(
      div().px(2).text_size(12).line_height("17px").text_color(t.muted).whitespace_normal().child(active.summary),
    ))
    .child(div().relative().w_full().rounded(10).overflow_hidden().border_1().border_color(t.border).bg(t.background)
      .child(v_flex().id(`art-inline-body-${active.name}`).w_full().min_w(0).max_h(300).overflow_y_scroll().pl(14).pr(16).py(12)
        .child(renderArtifactMarkdown(`art-md-${d.id}-${active.name}`, active, t, c, {
          loading: panel.loadingName === active.name && typeof active.content !== "string",
          error: panel.loadError,
        })))
      .child(Scrollbar.vertical(`art-inline-body-${active.name}`).absolute().inset_0()))
    .when(Boolean(panel.feedbackInput), (e) => e.child(feedbackBox(panel, "art-inline-feedback", t, onEnterFeedback, (cx) => v.control("artifact:dismiss", cx))))
    .child(h_flex().w_full().min_w(0).gap(8).flex_wrap().items_center()
      .children(choices.map((ch) => actionButton(
        `art-choice-${ch.id}`,
        ch,
        t,
        panel.submitting,
        (_e, cx) => v.control(`artifact:action:${ch.action}:${ch.artifact ?? ""}`, cx),
      ))))
    .child(div().text_size(11).text_color(t.dim)
      .child(`1–${choices.length} choose · Enter ${primary?.label ?? "Approve"} · Esc dismiss (${MAC ? "⌘" : "Ctrl"}+Enter in feedback sends changes)`));
}

/** Compact strip shown above the composer when pending artifacts remain after dismissing the card (or without OSC 7501). */
export function artifactStrip(v, s, t) {
  if (s.dialog?.method === "artifact") return null;
  const pending = pendingArtifactsOf(s.artifacts);
  if (!pending.length) return null;
  const first = pending[0];
  const label = pending.length === 1
    ? `Artifact awaiting review · ${artifactShortName(first.name)}`
    : `${plural(pending.length, "artifact")} awaiting review`;
  const approveAct = pending.length > 1 ? "approve_all:" : `approve:${first.name}`;
  const approveLabel = pending.length > 1 ? `Approve all (${pending.length})` : "Approve";
  const btn = (id, text, primary, what) => h_flex().id(id).flex_none().h(22).px(9).items_center().rounded(6).cursor_pointer()
    .border_1().border_color(primary ? t.solid : alpha(t.blocked, 0.45))
    .bg(primary ? t.solid : alpha(t.blocked, 0.14))
    .text_color(primary ? t.solid_foreground : t.foreground).text_size(11.5).font_medium()
    .hover((st) => st.opacity(0.86))
    .on_click((_e, cx) => { cx.stop_propagation(); v.control(what, cx); })
    .child(text);
  return h_flex().id("artifact-strip").w_full().min_h(32).px(10).py(4).gap(8).items_center().rounded(10)
    .border_1().border_color(alpha(t.blocked, 0.5)).bg(alpha(t.blocked, 0.09))
    .cursor_pointer().hover((st) => st.bg(alpha(t.blocked, 0.14)))
    .on_click((_e, cx) => v.control(`artifact:open:${first.name}`, cx))
    .child(icon("file-text", 13).text_color(t.blocked))
    .child(div().flex_1().min_w(0).truncate().text_size(12).font_medium().text_color(t.foreground).child(label))
    .child(btn("artifact-strip-review", "Review", false, `artifact:open:${first.name}`))
    .child(btn("artifact-strip-approve", approveLabel, true, `artifact:action:${approveAct}`));
}

/** Spacious full-height Artifact Review Modal rendered inside `hud()` (from Expand, the strip, or `/artifact`). */
export function artifactModal(v, s, t, c) {
  const panel = v.artifacts;
  if (!panel?.modalOpen) return null;
  const all = panel.allArtifacts(s);
  const active = pickActiveArtifact(all, panel.activeName);
  const pending = pendingArtifactsOf(all);
  const hasFeedback = Boolean(panel.feedbackValue().trim());
  const choices = active
    ? artifactChoices(pending.length ? pending : [active], active.name, hasFeedback).map((ch) => ({ ...ch, key: null }))
    : [];
  const tabs = artifactTabs(all, active?.name ?? null, t, (name, cx) => panel.select(name, cx), "art-modal");
  const copied = active ? v.copiedAt?.has?.(`artifact:${active.name}`) : false;
  const tone = active ? artifactStatusTone(active.status, t) : t.muted;
  const sizeLabel = active ? formatArtifactBytes(active.sizeBytes) : null;

  const onEnterFeedback = (cx) => {
    if (!active) return;
    const fb = panel.feedbackValue().trim();
    panel.submit(fb ? "reject" : "approve", active.name, cx);
  };

  return div().id("artifact-modal-backdrop").absolute().top(0).bottom(0).left(0).right(0)
    .bg(alpha("#000000", 0.58)).flex().items_center().justify_center().p(20)
    .on_click((_e, cx) => v.control("artifact:close", cx))
    .child(v_flex().id("artifact-modal-dialog").w_full().max_w(940).h("88%").min_h(320).rounded(12).overflow_hidden()
      .border_1().border_color(t.border).bg(t.popover).shadow_md()
      .when(Boolean(panel.modalFocus), (e) => e.track_focus(panel.modalFocus))
      .on_click((_e, cx) => cx.stop_propagation())
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          cx.stop_propagation();
          v.control("artifact:close", cx);
        }
      })
      .child(h_flex().flex_none().min_h(44).px(14).py(6).gap(8).items_center().border_b_1().border_color(t.border).bg(t.surface)
        .child(icon("file-text", 14).text_color(tone))
        .child(div().min_w(0).truncate().font_semibold().text_size(13.5).text_color(t.foreground)
          .child(active ? active.name : "Artifacts"))
        .when(Boolean(active), (e) => e.child(
          div().flex_none().px(7).py(2).rounded(5).bg(alpha(tone, 0.16)).text_size(11).font_medium().text_color(tone)
            .child(artifactStatusLabel(active.status)),
        ))
        .when(Boolean(sizeLabel), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(sizeLabel)))
        .child(div().flex_1())
        .when(Boolean(active?.content), (e) => e.child(
          smallHeaderBtn("art-modal-copy", copied ? "check" : "copy", copied ? "Copied" : "Copy", "Copy Markdown", t, (_e, cx) => v.control(`artifact:copy:${active.name}`, cx)),
        ))
        .when(Boolean(active?.path), (e) => e.child(
          smallHeaderBtn("art-modal-file", "book", "Open file", `Open ${active.name} in files viewer`, t, (_e, cx) => v.control(`artifact:file:${active.name}`, cx)),
        ))
        .when(Boolean(v.view), (e) => e.child(
          smallHeaderBtn("art-modal-term", "terminal", "Terminal", "Open Antigravity's terminal /artifact view", t, (_e, cx) => v.control("artifact:open-terminal", cx)),
        ))
        .child(h_flex().id("art-modal-close").w(26).h(26).items_center().justify_center().rounded(6).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
          .on_click((_e, cx) => v.control("artifact:close", cx)).child(icon("x", 13))))
      .when(Boolean(tabs), (e) => e.child(
        div().flex_none().px(14).py(8).border_b_1().border_color(alpha(t.border, 0.7)).bg(t.surface).child(tabs),
      ))
      .when(Boolean(active?.summary), (e) => e.child(
        div().flex_none().px(16).py(8).border_b_1().border_color(alpha(t.border, 0.7)).bg(alpha(t.surface, 0.6))
          .text_size(12).line_height("18px").text_color(t.muted).whitespace_normal().child(active.summary),
      ))
      .child(active
        ? div().relative().flex_1().min_h(0).w_full().bg(t.background)
            .child(v_flex().id(`art-modal-body-${active.name}`).size_full().overflow_y_scroll().pl(20).pr(22).py(16)
              .child(renderArtifactMarkdown(`art-modal-md-${active.name}`, active, t, c, {
                loading: panel.loadingName === active.name && typeof active.content !== "string",
                error: panel.loadError,
              })))
            .child(Scrollbar.vertical(`art-modal-body-${active.name}`).absolute().inset_0())
        : v_flex().flex_1().items_center().justify_center().gap(8).p(24).bg(t.background)
            .child(icon("file-text", 24).text_color(t.dim))
            .child(div().text_size(13).text_color(t.muted).child("No artifacts in this conversation yet."))
            .child(div().text_size(12).text_color(t.dim).child("Plans, walkthroughs, and reports created by Antigravity will appear here for review.")))
      .when(Boolean(active), (e) => e.child(
        v_flex().flex_none().px(14).py(10).gap(8).border_t_1().border_color(t.border).bg(t.surface)
          .when(Boolean(panel.feedbackInput), (f) => f.child(feedbackBox(panel, "art-modal-feedback", t, onEnterFeedback, (cx) => v.control("artifact:close", cx))))
          .child(h_flex().w_full().gap(8).items_center().flex_wrap()
            .children(choices.map((ch) => actionButton(
              `art-modal-choice-${ch.id}`,
              ch,
              t,
              panel.submitting,
              (_e, cx) => v.control(`artifact:action:${ch.action}:${ch.artifact ?? ""}`, cx),
            )))
            .child(div().flex_1())
            .when(s.dialog?.method === "artifact", (b) => b.child(
              smallHeaderBtn("art-modal-dismiss", null, "Dismiss", "Dismiss review card and return to chat", t, (_e, cx) => v.control("artifact:dismiss", cx)),
            ))
            .child(smallHeaderBtn("art-modal-done", null, "Close", "Close (Esc)", t, (_e, cx) => v.control("artifact:close", cx)))),
      )));
}
