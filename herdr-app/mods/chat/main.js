// chat (the herdr-chat mod): an agent (Pi, Claude Code, Codex) as a native chat in a Herdr tab. A `tab.new {mod: "chat",
// props: {chat, cwd}}` pane. It finds (or starts) the chat's herdr-chat-host in
// a herdr-core terminal whose pane sits in this tab, hidden (hostpane.js: the
// tab and the agents list show the agent's status, nothing draws the host),
// connects over TCP and renders the host's timeline. It never talks to Pi directly.
//
// Modules: connection (host life + socket), hostpane (the host's hidden pane), store (state + items), rows
// (items → timeline rows: work groups, footers, activity), timeline (own
// measured scroller), cards (rows), rich (blocks, code, diffs, output),
// composer (text, keys, the card), chrome (footer controls, statuses,
// widgets, queue, the plan strip, empty state), menus (slash/@ menus, pickers), dialogs,
// files (open in an editor), keymap (its key bindings, kept when Herdr rebuilds
// the app's keymap), debug (E2E dump).
//
// Commands (`chat.<c>`, also how E2E drives what a click does):
//   focus · toggle:<id> (an item, a group `g-…`, `code:…`) · click:<control>
//   · scroll:up|down · hover:<itemId> · svghover:<itemId>:<k> (a diagram's ⤢ hint) · key:<k> · drop:<paths> · clear · type:<text>
//   · wheel:<dy> (the open menu or picker, as the mouse wheel does) · outside (a press outside it)
//   · shortcut:<action> (keys.default.json's actions, as their keys do)
//   controls: chip:model|thinking|permission, latest, send, stop, restart,
//   dialog:submit|cancel|choice:<id>|reason:<text>|other:<q>:<text>,
//   picker:<n>, picker:scope:<n> (its scope tabs: /resume's folder/all, /model's accounts), copy:<itemId>, edit:<itemId>, open:<itemId>, enlarge:<itemId>:<k> (the viewer: viewer.js, its own viewer:… commands),
//   enlarge:chip:<i>, chip-x:<i> (a composer image chip's thumbnail and ✕),
//   widget:<key>, status:hide|show:<key>, queue:edit|move|remove:<message id> (a queued row),
//   status:toggle-hidden, statuses (the +N popover), plan (opens or closes the plan strip's steps),
//   handoff:return|show|close|cancel (the hand-off banner), conflict:go|take

import { View, div } from "gpui-kit";
import { fps_monitor } from "gpui-fps";
import { v_flex, h_flex, Popup } from "gpui-base";
import { agents, appHome, closeOverlay, focused, hc, home, layout, nextCommand, notify, openOverlay, panes, props, run, settings, setShared, shared, spaces, terminals, theme, updates, window as appWindow } from "herdr";
import { faceOf, facesOf, flip, sharedFace } from "./faces.js";

// What each chat pane shows, for the agents list (mods/chat-agents/chat-focus.js): pane → agent's terminal.
const SHOWS = "herdr-chat.panes";
// A terminal view's pane → its terminal, for the top bar's switch (mods/chat-switch).
const VIEW_PANES = "herdr-chat.views";
import { randomBytes } from "crypto";
import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { exec } from "herdr";
import { allModPanes, modPanes, readDoc } from "./place.js";
import { bare, machineOf, qualify } from "./machines.js";
import { getDoc, hideHost, locate } from "./hostpane.js";
import { SHORTCUTS, actionName, errors as keyErrors, keyHint, loadShortcuts, shortcuts, withKey } from "./shortcuts.js";
import { keepKeys } from "./keymap.js";
import { Connection, hostSide, hostTerminal, readConfig, runsHost } from "./connection.js";
import { Store } from "./store.js";
import { Timeline } from "./timeline.js";
import { findMark, lineOf, planProgress, row, samePlan } from "./cards.js";
import { fileLink } from "./paths.js";
import { oneLine as bangLine, runLink, tabScript } from "./bang.js";
import { Find, searchLoaded } from "./find.js";
import { buildRows, cardLive, defaultOpen, groupCards } from "./rows.js";
import { space } from "./space.js";
import { backgroundStrip, emptyState, micButton, planStrip, plusButton, queueChips, queueLabels, underRow, widgetTray } from "./chrome.js";
import { bgDetailLines, bgTicking } from "./background.js";
import { openFile } from "./files.js";
import { Composer } from "./composer.js";
import { Picker, menuView, slashItems, wheel as wheelMenu } from "./menus.js";
import { DialogCard } from "./dialogs.js";
import { Debug } from "./debug.js";
import { Updater, quiet } from "./update.js";
import { CodeView, owners } from "./codeview.js";
import { Viewer, readSvgSize } from "./viewer.js";
import { TermBar } from "./termbar.js";
import { DEFAULT_PROVIDER, MOD, PROVIDERS, PROVIDER_NAMES, alpha, homeRel, icon, message, monoFont, plural, relTime, spansText, spinner, tildePath, typedText, unwrapHc } from "./util.js";

const COL_MAX = 800;
const APP_READ_AFTER_ECHO = 380; // ms from seeing a label echo to just before the app's next read (beforeAppRead)
let VIEWS = 0;

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
// The terminal view: Claude Code's and Codex's commands whose result shows in the chat (its records have it); any other opens a screen in the TUI.
const VIEW_IN_PLACE = new Set(["compact", "clear", "cost", "context", "usage", "init", "review", "memory", "export", "new", "plan"]);

// A model provider's name for the model picker's scope tabs: its id with the dashes
// out. The agent names its providers (two Claude Code logins are two providers, so an
// account is a tab); the mod names none of them.
const modelTab = (p) => p.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default class HerdrChat extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.viewer) {
      // An enlarged image or diagram, opened by a chat as an overlay (viewer.js: zoom and pan).
      this.viewer = new Viewer(p.viewer, cx);
      return;
    }
    if (p.termbar) {
      // The bar over an agent's terminal a chat opened in a dialog (termbar.js).
      this.termbar = new TermBar(p.termbar, cx);
      return;
    }
    this.chat = p.chat ?? "c-unknown";
    // A sub-agent's chat (docs/dev/research/subagent-chat.md): its host is another agent's child, started
    // with `hc run` (bin/herdr-chat-subagent), and is the parent's to end. This view never starts, kills,
    // restarts, hides or moves it. `peek`: the chat as the agents list's peek dialog (no place, no
    // layout writes); `subagent`: the chat in a tab of its own (Open as tab), the host left paneless.
    this.sub = p.peek || p.subagent || null;
    this.peekMode = Boolean(p.peek);
    // The terminal view (faces.js): this chat is the chat face of a Claude Code or Codex terminal. Its host
    // reads the TUI's session and types into it; it has no pane of its own, and the tab is the terminal's.
    // The props name the terminal as its machine's document does ("t5"): `view` is the app's name for it.
    this.viewAttach = !this.sub && typeof p.attach === "string" ? bare(p.attach) : null;
    this.provider = p.provider ?? null; // an id of PROVIDERS; null: the registry's, else DEFAULT_PROVIDER
    this.cwd = p.cwd || null;
    this.store = new Store();
    this.timeline = new Timeline("herdr-chat-timeline");
    this.expanded = new Set();
    this.full = new Map();
    this.dialog = new DialogCard((cx) => { this.debug?.mark(); cx?.notify(); }, () => this.composer.focus());
    this.picker = null;
    this.handoff = null;
    this.transcript = false;
    this.flashText = null;
    this.ops = [];
    this.logLines = [];
    this.loadingOlder = false;
    this.editorAcked = null;
    this.hover = null; // the message under the pointer (its action row shows)
    this.copiedAt = new Map(); // copy button id → when (✓ for 1.5 s)
    this.groups = new Map(); // work group id → open (the person's choice)
    /** @type {Find | null} find in the chat, while its bar is open */
    this.find = null;
    this.groupAnims = new Map(); // work group id → {target, step, h} while it slides
    this.groupH = new Map(); // work group id → its cards' natural height
    this.codeViews = new Map();
    this.codeSel = new Map(); // code block key → its CodeView (codeview.js registers itself): the E2E's chat.codesel // "<item>:<block>" → {entity, props}: finished code blocks (codeview.js)
    this.uid = `v${++VIEWS}`;
    owners.set(this.uid, this);
    this.svgSizes = new Map(); // image path → {w, h} | null (loading)
    this.thumbsSeen = null; // debug only: image path → [[ms, w, h]…], the boxes its thumbnail was drawn at
    this.width = 0;
    this.homeDir = home();
    this.prefs = loadPrefs();
    this.place = null; // {pane, tab, space}: this chat's own pane, from the layout document (place.js)
    this.placeFrom = null; // "doc" | "guess" (no document to read)
    this.hide = null; // the host's pane in the layout document: {terminal, pane, hidden, …} (keepHostHidden)
    this.fallback = null; // {terminal, reason, at}: the hidden flag can't be written, the pane is 0 px instead
    this.debug = new Debug(cx, this.peekMode ? `${this.chat}.peek` : this.chat, () => this.dump(), () => {
      this.timeline.trace(this.debug);
      this.thumbsSeen = this.debug.trace();
    });
    if (!this.peekMode) this.lookupPlace(cx);
    // Chat-scoped shortcuts (shortcuts.js): defaults, then the person's keys.json; then the
    // chat's bindings in the app's keymap, kept there when Herdr rebuilds it (keymap.js).
    cx.spawn(async (cx) => {
      await loadShortcuts();
      keepKeys(cx);
      this.keysReady = true;
      this.debug.mark();
      cx.notify();
    });
    // The composer's mic (chrome.js micButton): the desktop's dictation toggle, where there is one.
    this.dictation = null;
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      try {
        const r = await exec("/bin/sh", ["-c", "command -v omarchy-dictation"]);
        if (r.code === 0 && r.stdout.trim()) { this.dictation = r.stdout.trim(); this.debug.mark(); cx.notify(); }
      } catch {}
    });
    this.composer = new Composer(cx, {
      placeholder: `Message ${PROVIDER_NAMES[this.provider ?? DEFAULT_PROVIDER] ?? "the agent"}…`,
      onChange: (cx) => { this.updateMenu(cx); this.debug.mark(); cx.notify(); },
      onPasteOther: (cx) => this.pasteImage(cx),
      // req logs a failure. An older host has no detach_image: its chips aren't the chat's copies.
      onRemoveChip: (ch) => this.req("detach_image", { path: ch.path }).catch(() => {}),
      skills: () => this.commandList().filter((c) => c.source === "skill").map((c) => ({ command: c.name, name: c.name.replace(/^skill:/, "") })),
    });
    this.conn = new Connection({
      chat: this.chat,
      cwd: this.cwd ?? home(),
      session: p.session ?? null,
      provider: this.provider,
      hostEnv: p.hostEnv ?? null,
      // Continue as chat on a top-level Pi TUI (new-chat's continueInPlace): its pid, model and thinking.
      handOver: p.afterPid ? { pid: p.afterPid, model: p.model ?? null, thinking: p.thinking ?? null } : null,
      attachOnly: Boolean(this.sub),
      attach: this.viewAttach, // the host runs on the terminal's machine: its own name for it
      place: () => this.findPlace(),
      // A chat in another machine's space: its host runs there (machines.js).
      machine: () => (this.place ? machineOf(this.place.pane) : null),
      onRecord: (rec, cx) => this.onRecord(rec, cx),
      onFlush: (cx) => { this.debug.mark(); cx.notify(); },
      onChange: (cx) => { this.debug.mark(); cx.notify(); },
      log: (m) => this.log(m),
    });
    if (!this.cwd) this.cwd = p.cwd ?? null;
    this.updater = new Updater({ sub: Boolean(this.sub), log: (m) => this.log(m) }); // a host older than the install (update.js)
    cx.spawn(async (cx) => { await this.updater.load(); this.debug.mark(); cx.notify(); });
    this.conn.start(cx);
    this.commands(cx);
    // Data, not animation: where the host pane is, a TUI that finished, a
    // dialog's countdown. Cheap when nothing changed (no notify).
    cx.timer.every(400, (cx) => this.tick(cx));
    this.composer.focus();
    cx.timer.after(400, () => this.composer.focus());
    // The right-click menu's Open as a chat tab (chat-menu): straight on to the tab.
    if (this.peekMode && p.then === "tab") this.openAsTab(cx);
  }

  log(m) {
    this.logLines.push(`${new Date().toISOString().slice(11, 23)} ${m}`);
    if (this.logLines.length > 60) this.logLines.shift();
    this.debug?.mark();
  }

  flash(text, cx) {
    this.flashText = text ? { text, at: Date.now() } : null;
    this.debug.mark();
    cx?.notify();
  }

  // ---- where this chat lives ---------------------------------------------------

  // This chat's pane, tab and space, or null until known. Never guessed from
  // focus (feedback row 12): lookupPlace() reads it from the layout document.
  findPlace() {
    if (!this.place) return null;
    const p = panes().find((x) => x.pane === this.place.pane);
    if (!p) {
      this.log(`place lost: pane ${this.place.pane} is gone`);
      this.place = null;
      this.placeFrom = null;
      return null;
    }
    if (p.tab !== this.place.tab) { // the pane moved to another tab: it keeps its id
      this.place.tab = p.tab;
      this.place.space = spaces().find((sp) => sp.tabs.some((x) => x.id === p.tab))?.id ?? this.place.space;
    }
    return this.place;
  }

  // Ask the core's layout document which pane has this chat's props. The
  // document may lag a new tab by a moment: tick() asks again until it knows.
  lookupPlace(cx) {
    if (this.placeLooking || Date.now() - (this.placeTried ?? 0) < 600) return;
    if (this.place && this.findPlace()) return;
    this.placeLooking = true;
    this.placeTried = Date.now();
    cx.spawn(async (cx) => {
      try {
        // This computer's document, and those of the machines whose spaces the app shows: a chat
        // in another machine's space is in that machine's (its host then runs there).
        this.docPanes = await allModPanes(MOD);
        this.docAt = Date.now();
        const live = this.docPanes.filter((x) => x.props?.chat === this.chat).find((x) => panes().some((p) => p.pane === x.pane));
        if (live) {
          this.place = { pane: live.pane, tab: live.tab, space: live.space };
          this.placeFrom = "doc";
          this.log(`place: pane ${live.pane} in tab ${live.tab} (layout document${live.machine ? ` of ${live.machine}` : ""})`);
          // Its host's install is that machine's: the update check compares with it, and its files
          // (images, diagrams) are under that machine's app home (imageRel).
          if (live.machine) cx.spawn(async (cx) => {
            this.remoteHome = (await hostSide(live.machine).catch(() => null))?.home ?? null;
            await this.updater.load(live.machine);
            this.debug.mark();
            cx.notify();
          });
        } else this.placeMisses = (this.placeMisses ?? 0) + 1;
      } catch (e) {
        this.placeError = message(e);
        this.placeErrors = (this.placeErrors ?? 0) + 1;
        if (this.placeErrors === 1) this.log(`layout document: ${this.placeError}`);
        if (this.placeErrors >= 3 && !this.place) this.guessPlace();
      } finally {
        this.placeLooking = false;
      }
      this.debug.mark();
      cx.notify();
    });
  }

  // No layout document (no hc on PATH?): the host's tab label, else the only chat pane.
  guessPlace() {
    const mine = panes().filter((p) => p.mod === MOD);
    const host = hostTerminal(this.chat);
    const hostTab = qualify(machineOf(host?.address), host?.labels?.["herdr.tab"]);
    const pane = (hostTab && mine.find((p) => p.tab === hostTab)) || (mine.length === 1 ? mine[0] : null);
    if (!pane || String(pane.tab).includes("/")) return;
    const space = spaces().find((sp) => sp.tabs.some((x) => x.id === pane.tab))?.id;
    if (!space) return;
    this.place = { pane: pane.pane, tab: pane.tab, space };
    this.placeFrom = "guess";
    this.log(`place guessed: pane ${pane.pane} (${this.placeError})`);
  }

  // What the chat is called: the session's name, an extension's title, else
  // the first thing the person asked (trimmed), else "New chat".
  displayName() {
    const s = this.store.state;
    if (s.sessionName) return s.sessionName;
    if (s.title) return s.title;
    const first = this.store.items.find((it) => it.kind === "user" && (it.text?.trim() || it.skill));
    if (first) {
      const line = (first.text.trim() ? first.text : typedText(first)).replace(/<hc [^>]*>|<\/hc>/g, "").trim().split("\n")[0].replace(/\s+/g, " ");
      return line.length > 48 ? line.slice(0, 47).trimEnd() + "…" : line;
    }
    return "New chat";
  }

  // The Herdr tab follows the chat's name while nobody renamed it: only when
  // it's still the agent's id (the launcher's) or the name we gave it last.
  renameTab() {
    const me = this.myPane();
    const name = this.displayName();
    if (!me || name === "New chat") return;
    const tab = spaces().flatMap((sp) => sp.tabs).find((t) => t.id === me.tab);
    if (!tab || tab.name === name) return;
    const ours = PROVIDERS.includes(tab.name) || tab.name === this.tabName || !tab.named; // the launcher names it after the agent
    if (!ours) return;
    const short = name.length > 32 ? name.slice(0, 31).trimEnd() + "…" : name;
    if (tab.name === short) return;
    this.tabName = short;
    run("tab.rename", { id: me.tab, name: short });
  }

  myPane() {
    return this.place ? panes().find((p) => p.pane === this.place.pane) ?? null : null;
  }

  // The terminal view's terminal as this app names it: "t5", or "cypherpunk/t5" in that machine's
  // space (faces.js). Its machine is the pane's, known once the place is.
  get view() {
    return this.viewAttach ? qualify(this.place ? machineOf(this.place.pane) : null, this.viewAttach) : null;
  }

  hostPane() {
    const term = hostTerminal(this.chat);
    return term ? panes().find((p) => p.terminal === term.address) ?? null : null;
  }

  // Zoom another pane of this tab over the rest (a hand-off's terminal, the
  // editor): one pane fills the tab. The app may not take it while focus is
  // moving, so tick() retries for a few seconds. (pane null: the chat's own.)
  zoomPane(pane, on = true) {
    this.zoomWant = { pane, on, until: Date.now() + 3000, last: 0 };
    this.applyZoom();
  }

  applyZoom() {
    const w = this.zoomWant;
    const me = this.myPane();
    if (!w || !me) return;
    if (focused()?.tab !== me.tab) return; // not while another tab shows
    const target = w.pane ? panes().find((p) => p.pane === w.pane) : me;
    if (!target || Boolean(target.zoomed) === w.on || Date.now() > w.until) {
      this.zoomWant = null;
      return;
    }
    if (Date.now() - w.last < 700) return;
    w.last = Date.now();
    run("pane.zoom", { pane: target.pane });
  }

  // The app hands the keyboard to the pane a moment after pane.focus: take
  // it into the composer (or the open picker / dialog field) then.
  refocus(cx) {
    cx.timer.after(150, () => this.focusInput());
    cx.timer.after(500, () => this.focusInput());
  }

  focusInput() {
    const me = this.myPane();
    if (me && focused()?.tab !== me.tab) return; // never take the keyboard from another tab
    if (this.picker) this.picker.focus();
    else if (this.store.state.dialog && this.dialog.field && ["input", "editor"].includes(this.store.state.dialog.method)) this.dialog.field.focus();
    else this.composer.focus();
  }

  tick(cx) {
    if (!this.peekMode && !this.findPlace()) this.lookupPlace(cx);
    this.applyZoom();
    if (this.store.loaded && !this.sub && !this.view) this.renameTab();
    const me = this.myPane();
    let changed = false;
    const zk = `${Boolean(me?.zoomed)}:${panes().find((p) => p.tab === me?.tab && p.zoomed)?.pane ?? ""}`;
    if (zk !== this.lastZoomed) { this.lastZoomed = zk; this.debug.mark(); } // the dump shows it
    // Layout moves only while this tab is the shown one: a chat in a
    // background tab must never pull the person over to it.
    const shown = Boolean(me) && focused()?.tab === me.tab;
    if (!this.sub) {
      if (this.healHost(cx)) changed = true;
      if (this.updateTick(cx)) changed = true;
      if (!this.view) this.keepHostHidden(me, cx);
      if (this.redirectFocus(cx)) changed = true;
    }
    if (this.view && this.viewTick(me, cx)) changed = true;
    // The background strip's times move on once a second while something runs; an opened row reads its detail again.
    const bgTasks = this.store.state.background?.tasks ?? [];
    if (this.bgOpenId && !bgTasks.some((x) => x.id === this.bgOpenId)) {
      this.bgOpenId = null; // it left the strip
      this.bgDetail = null;
      changed = true;
    }
    if (bgTicking(this.store.state.background) || this.bgOpenId) {
      const sec = Math.floor(Date.now() / 1000);
      if (sec !== this.bgSecond) {
        this.bgSecond = sec;
        changed = true;
        if (this.bgOpenId) this.bgFetch(cx);
      }
    }
    if (me && !this.sub) this.publishShows(me);
    if (me && this.view) this.publishView(me);
    if (shown) this.markSeen(me, cx);
    if (this.sub && this.subKey() !== this.lastSubKey) { this.lastSubKey = this.subKey(); changed = true; } // the header bar
    // The hand-off's terminal (in its dialog): finished, back to the chat (the
    // host resumes the agent by itself).
    if (this.handoff?.terminal) {
      const t = terminals().find((x) => x.address === this.handoff.terminal);
      // terminals() learns of a new terminal a moment after hc run returns.
      if (t?.state === "live") this.handoff.seen = true;
      const gone = this.handoff.seen ? t?.state !== "live" : Date.now() - this.handoff.at > 15000;
      if (gone) this.finishHandoff(cx);
    }
    // A reopened chat in a hand-off: its TUI gone (closed while the mod was away), resume;
    // still running but never reported (the mod reloaded before it could), report it.
    if (this.store.loaded && !this.handoffChecked && Date.now() - (this.loadedAt ?? 0) > 1500) {
      this.handoffChecked = true;
      const h = this.store.state.handoff;
      const live = (a) => terminals().some((x) => x.address === a && x.state === "live");
      if (this.store.state.phase === "handoff" && h && !this.handoff) {
        const tui = h.terminal ?? terminals().find((x) => x.state === "live" && x.labels?.["herdr-chat.tui"] === this.chat)?.address ?? null;
        if (h.terminal && !live(h.terminal)) {
          this.log(`the hand-off's terminal ${h.terminal} is gone: resume`);
          this.fire("resume", {}, cx);
        } else if (tui) {
          this.log(`hand-off in ${tui}: reported again`);
          this.req("handoff_started", { terminal: tui }, cx).catch(() => {});
        }
      }
    }
    if (this.olderWanted && !this.loadingOlder && this.conn.status === "connected") this.fetchOlder(cx);
    // The editor, zoomed over the tab; closed, its pane goes (and the zoom with it): back to the chat.
    if (this.editorTerm) {
      const t = terminals().find((x) => x.address === this.editorTerm.address);
      if (t?.state === "live") this.editorTerm.seen = true;
      const tp = !this.editorTerm.focused && panes().find((p) => p.terminal === this.editorTerm.address);
      if (tp && shown) { run("pane.focus", { pane: tp.pane }); this.zoomPane(tp.pane, true); this.editorTerm.focused = true; }
      if (this.editorTerm.seen ? t?.state !== "live" : Date.now() - this.editorTerm.at > 15000) {
        this.editorTerm = null;
        changed = true;
        if (shown) {
          if (me) run("pane.focus", { pane: me.pane });
          this.refocus(cx);
        }
      }
    }
    if (this.conn.status === "connected" && this.store.loaded) this.syncTheme(cx);
    if (this.svgWanted?.size) this.loadSizes(cx);
    if (this.mirrorWanted?.size) this.loadMirrors(cx);
    if (Date.now() - (this.sweptAt ?? 0) > 30000) this.sweepOrphans(cx);
    // Elapsed seconds (thinking, the activity line) while Pi works: data, once a second.
    const sec = Math.floor(Date.now() / 1000);
    if ((this.store.working() || this.store.state.dialog) && sec !== this.lastSec) { this.lastSec = sec; changed = true; }
    if (this.copiedAt.size) for (const [k, at] of this.copiedAt) if (Date.now() - at > 1500) {
      this.copiedAt.delete(k);
      changed = true;
      if (k.startsWith("code:")) this.setCodeProps(k.slice(5), null, cx);
    }
    if (this.flashText && Date.now() - this.flashText.at > 6000) { this.flashText = null; changed = true; }
    if (this.confirmClose && Date.now() - this.confirmClose > 10000) { this.confirmClose = null; changed = true; }
    if (this.store.state.dialog?.timeoutAt) changed = true;
    if (changed) { this.debug.mark(); cx.notify(); }
  }

  // ---- the host's pane ------------------------------------------------------------

  // Feedback row 12: a host that sits in another tab (labeled for it, or its
  // pane there in the layout document) is restarted in this chat's own tab,
  // on the same session (the registry keeps it). Only once the place is
  // certain (the layout document). The new host gets a new hidden pane.
  healHost(cx) {
    // The old host, shutting down, can still take a reconnect (its welcome clears
    // autoStart): once its terminal has ended, start the new one for certain.
    const hl = this.healing;
    // An old host that said bye but hangs on its way out (hosts before 0.3 waited on their clients): ended for it.
    if (hl && !hl.restarted && !hl.killed && Date.now() - hl.at > 5000 && this.conn.status !== "connected" && terminals().some((t) => t.address === hl.terminal && t.state === "live")) {
      hl.killed = true;
      this.log(`the old host ${hl.terminal} didn't end after its shutdown: killing it`);
      run("terminal.kill", { terminal: hl.terminal });
    }
    if (hl && !hl.restarted && !terminals().some((t) => t.address === hl.terminal && t.state === "live") && this.conn.status !== "connected") {
      hl.restarted = true;
      this.byeAt = null; // (its bye was ours, not another chat's)
      this.conn.restart();
      this.log(`the old host ${hl.terminal} ended: starting its replacement`);
    }
    const term = hostTerminal(this.chat);
    if (term?.parent) return false; // a sub-agent is its parent's: never restarted from here
    // Labels name tabs as the terminal's own machine does ("tb1"); the place as the app does ("box/tb1").
    const label = qualify(machineOf(term?.address), term?.labels?.["herdr.tab"]);
    const docTab = this.hide?.terminal === term?.address ? this.hide?.tab : null;
    const tab = label || docTab;
    if (!term || !tab || this.placeFrom !== "doc" || !this.place || tab === this.place.tab) return false;
    if (this.healing && Date.now() - this.healing.at < 15000) return false;
    this.healed = (this.healed ?? 0) + 1;
    this.log(`host ${term.address} sits in tab ${tab}, not this chat's ${this.place.tab}: restarting it here on the same session`);
    this.replaceHost(term, tab, cx);
    return true;
  }

  // A new host on the same session (the registry keeps it): the old one shuts
  // down (killed if it doesn't answer), and healHost starts the new one once
  // the old terminal has ended. `from`: why, for the dump (a tab, "update").
  replaceHost(term, from, cx) {
    this.healing = { at: Date.now(), from, terminal: term.address, oldPid: this.conn.welcome?.host?.pid ?? null };
    this.conn.restart();
    const kill = () => run("terminal.kill", { terminal: term.address });
    if (this.conn.status === "connected") this.req("shutdown", {}, cx, { timeout: 5000 }).catch(kill);
    else kill();
  }

  // A replacement host is on its way (replaceHost): the old one's bye and welcome are ours.
  replacing() {
    return Boolean(this.healing && !this.healing.restarted);
  }

  // A host older than the install (update.js): restart it once the person asked and the chat is quiet.
  updateTick(cx) {
    if (this.conn.status !== "connected" || !this.store.loaded) return false;
    const host = hostTerminal(this.chat);
    if (!this.updater.due({ welcome: this.conn.welcome, state: this.store.state, host, replacing: this.replacing() })) return false;
    this.replaceHost(host, "update", cx);
    return true;
  }

  // Feedback row 11 (docs/dev/research/split-glitch.md): the host's pane stays in
  // the chat's tab for the chat's whole life, hidden (hostpane.js), so a
  // split is one ordinary reflow and the chat stays in Herdr's agents list.
  // A new host (started without herdr.* labels) gets a hidden node, then its
  // labels; a host that shows (an older chat's, a client that dropped the
  // flag) gets the flag; a parked one (an older chat's) gets a node. The
  // document is checked when the tab's panes change, and every 5 s while
  // the tab shows (30 s when it doesn't), and written only when the tab is quiet. If the flag can't be written or
  // doesn't stick, the pane is resized to 0 px instead (fallbackHide).
  keepHostHidden(me, cx) {
    const term = hostTerminal(this.chat);
    if (!me || !term || this.placeFrom !== "doc" || !this.place) return;
    let h = this.hide;
    if (h?.terminal !== term.address) {
      h = this.hide = { terminal: term.address, at: Date.now(), pane: null, tab: null, hidden: null, checkedAt: 0, writes: [], errors: 0, stale: true };
      this.debug.mark();
    }
    const sig = panes().filter((p) => p.tab === me.tab).map((p) => p.pane).sort().join(",");
    if (sig !== this.tabSig) { this.tabSig = sig; this.tabSigAt = Date.now(); h.stale = true; }
    // Quiet: no pane or tab moved in the last second, here or in any tab (see beforeAppRead).
    const world = `${spaces().flatMap((s) => s.tabs.map((t) => t.id)).join(",")}|${panes().map((p) => p.pane).join(",")}`;
    if (world !== this.worldSig) { this.worldSig = world; this.worldSigAt = Date.now(); }
    const quiet = Date.now() - (this.tabSigAt ?? 0) > 400 && Date.now() - (this.worldSigAt ?? 0) > 1000;
    // Another client can drop the flag without moving a pane: checked every 5 s while the tab shows.
    const period = focused()?.tab === me.tab ? 5000 : 30000;
    const due = h.stale || h.hidden !== true || Date.now() - h.checkedAt > period;
    if (h.busy || !quiet || !due || Date.now() - h.checkedAt < 900) return;
    h.busy = true;
    h.stale = false;
    cx.spawn(async (cx) => {
      try {
        const machine = machineOf(this.place.tab);
        const { value } = await getDoc(machine);
        const at = locate(value, this.chat, term.address, machine);
        h.checkedAt = Date.now();
        const was = h.hidden;
        h.pane = at.host?.pane ?? null;
        h.tab = at.host?.tab ?? null;
        h.hidden = at.host ? at.host.hidden : null;
        if (was !== h.hidden) this.log(`host ${term.address}: ${at.host ? `pane ${at.host.pane}${at.host.hidden ? ", hidden" : ", shown"}` : "no pane"} in the layout document`);
        // No pane of this chat in the document: closing, or not written yet. Never write then.
        if (!at.chat || at.chat.tab !== this.place.tab) return;
        if (this.fallback?.terminal === term.address) return this.fallbackHide(term, null, cx, at.host?.px);
        if (at.host && at.host.tab !== this.place.tab) return; // another tab's: healHost restarts it here
        if (!h.hidden) {
          const recent = h.writes.filter((t) => Date.now() - t < 20000);
          if (recent.length >= 3) return this.fallbackHide(term, `the hidden flag didn't stick (${recent.length} writes in 20 s)`, cx);
          // The app's own change goes first; after ~20 s of that (a mismatch inStep can't explain), write anyway.
          const r = await hideHost(this.place.tab, term.address, { force: (h.waiting ?? 0) >= 20, beforeWrite: () => this.beforeAppRead(term.address, cx) });
          if (r.did === "waiting") {
            h.waits = (h.waits ?? 0) + 1;
            h.waiting = (h.waiting ?? 0) + 1;
            h.stale = true;
            if (h.waiting === 20) this.log(`host ${term.address}: the layout document still differs from the app's tabs: writing anyway`);
            return;
          }
          h.waiting = 0;
          h.writes.push(Date.now());
          h.stale = true; // read it back
          this.log(`host ${term.address}: ${r.did === "added" ? `hidden pane ${r.pane} added` : r.did === "flagged" ? `pane ${r.pane} hidden` : `pane ${r.pane} already hidden`} (layout document)`);
          return;
        }
        h.errors = 0;
        // In the document, hidden: now its labels, so `hc ls` and every client agree where it is.
        // (A host labeled for another tab is healHost's.)
        if (!term.labels?.["herdr.tab"] && !h.labeling) {
          h.labeling = true;
          const { space, tab } = this.place;
          // As the host's own machine names them (the app's own labels there are bare).
          const r = await hc(["label", term.address, `herdr.space=${bare(space)}`, `herdr.tab=${bare(tab)}`]);
          h.labeling = false;
          if (r.code !== 0) this.log(`hc label ${term.address}: ${(r.stderr || r.stdout).trim()}`);
          else this.log(`host ${term.address}: labeled for tab ${tab}`);
        }
        // An older chat was zoomed over its host: the host hidden now, the zoom has nothing to hide.
        // (Once, while its tab shows: layout moves never happen in a background tab.)
        const mine = this.myPane();
        if (!this.unzoomed && mine && focused()?.tab === mine.tab && !this.handoff && !this.editorTerm && this.store.state.phase !== "handoff") {
          this.unzoomed = true;
          const others = panes().filter((p) => p.tab === mine.tab && p.pane !== mine.pane && p.pane !== h.pane);
          if (mine.zoomed && !others.length) { this.log("the host is hidden: the chat's zoom goes"); this.zoomPane(null, false); }
        }
      } catch (e) {
        h.errors++;
        h.error = message(e);
        this.log(`hiding the host ${term.address}: ${h.error}`);
        if (h.errors >= 3) this.fallbackHide(term, `the layout document can't be written: ${h.error}`, cx);
      } finally {
        h.busy = false;
        this.debug.mark();
        cx.notify();
      }
    });
  }

  // The app reads the layout document once per loop of its own (500 ms
  // apart). A change it makes between a write of ours and that read is lost:
  // its own write then conflicts, and it takes our document instead ("Layout
  // changed elsewhere": a tab just opened with a mod in it is gone). So the
  // write is rare (once per host), waits for a second with no tab or pane
  // moving, and lands just before the app's next read: a label written now
  // shows in terminals() when the app's loop takes it in, and the next loop
  // runs about 500 ms later. The write's process is started ahead and sends
  // at that time (hostpane.js rpc `at`), so its start-up doesn't push it
  // past the read. A host that can't take the label (it just ended) gets no write.
  async beforeAppRead(address, cx) {
    const n = String(Date.now());
    const r = await hc(["label", address, `herdr-chat.sync=${n}`]);
    if (r.code !== 0) return false;
    const until = Date.now() + 1500;
    while (Date.now() < until) {
      if (terminals().find((t) => t.address === address)?.labels?.["herdr-chat.sync"] === n) {
        this.phased = (this.phased ?? 0) + 1;
        return Date.now() + APP_READ_AFTER_ECHO;
      }
      await cx.sleep(10);
    }
    this.unphased = (this.unphased ?? 0) + 1; // no echo: written anyway
    return null;
  }

  // The fallback (split-glitch.md §4-E): the host's pane at 0 px
  // (layout.resize, a documented command), an 8 px seam instead of a hidden
  // pane. Never parked. A host without a pane is labeled for this tab first,
  // so the app adopts it.
  fallbackHide(term, reason, cx, px = null) {
    if (reason && this.fallback?.terminal !== term.address) {
      this.fallback = { terminal: term.address, reason, at: Date.now(), resized: null, resizedAt: 0 };
      this.log(`fallback for the host ${term.address}: ${reason}`);
      this.noticeFallback(reason);
    }
    const f = this.fallback;
    const pane = panes().find((p) => p.terminal === term.address);
    if (!pane) {
      if (term.labels?.["herdr.tab"] || f.labeled) return;
      f.labeled = true;
      const { space, tab } = this.place;
      cx.spawn(async () => { await hc(["label", term.address, `herdr.space=${bare(space)}`, `herdr.tab=${bare(tab)}`]); });
      return;
    }
    if (px === 0 || (f.resized === pane.pane && Date.now() - f.resizedAt < 3000)) return; // (px: what the document says)
    f.resized = pane.pane;
    f.resizedAt = Date.now();
    run("layout.resize", { id: pane.pane, px: 0 });
    this.log(`fallback: the host's pane ${pane.pane} resized to 0 px`);
  }

  // The fallback's notice: once per Herdr version (shared, so not once per
  // chat), naming the likely cause: the hidden flag is a Herdr internal.
  noticeFallback(reason) {
    let version = null;
    try { version = updates()?.app?.version ?? null; } catch {}
    const key = "chat.hiddenPaneFallback";
    if (shared(key) === (version ?? "unknown")) return;
    setShared(key, version ?? "unknown");
    notify({
      title: "Chat",
      body: `Herdr${version ? ` ${version}` : ""} changed how panes hide; the chat uses a fallback: the agent's terminal sits in a thin seam at the tab's edge. (${reason})`,
      level: "warning",
    });
  }

  // Any route to the agent (the agents list, agent.next, a notification)
  // lands on the host's hidden pane: give the chat the focus back at once.
  // From render too (focused() changes re-render), not only the 400 ms tick.
  redirectFocus(cx) {
    const me = this.myPane();
    const host = this.hostPane();
    if (!me || !host || host.tab !== me.tab || focused()?.pane !== host.pane || this.handoff) return false;
    if (Date.now() - (this.redirectAt ?? 0) < 250) return false;
    this.redirectAt = Date.now();
    this.redirects = (this.redirects ?? 0) + 1;
    run("pane.focus", { pane: me.pane });
    this.refocus(cx);
    return true;
  }

  // The agents list marks the agent this chat shows while its pane has the
  // keyboard (mods/chat-agents/chat-focus.js): the host's terminal, or the
  // terminal view's. Stale panes go out with the next change.
  /** @param {any} me */
  publishShows(me) {
    const addr = this.view ?? hostTerminal(this.chat)?.address ?? null;
    const map = /** @type {Record<string, string>} */ (shared(SHOWS) ?? {});
    if (!addr || map[me.pane] === addr) return;
    const live = new Set(panes().map((p) => p.pane));
    const next = Object.fromEntries(Object.entries(map).filter(([p]) => live.has(p)));
    next[me.pane] = addr;
    setShared(SHOWS, next);
  }

  // The top bar's switch (mods/chat-switch) shows the face of the agent whose
  // pane has the keyboard: for this pane, the terminal the view shows.
  /** @param {any} me */
  publishView(me) {
    const map = /** @type {Record<string, string>} */ (shared(VIEW_PANES) ?? {});
    if (map[me.pane] === this.view) return;
    const live = new Set(panes().map((p) => p.pane));
    const next = Object.fromEntries(Object.entries(map).filter(([p]) => live.has(p)));
    next[me.pane] = /** @type {string} */ (this.view);
    setShared(VIEW_PANES, next);
  }

  // The layout's top bar has the switch (the installer's, mods/chat-switch): the view leaves out its own.
  barSwitch() {
    let found = false;
    /** @param {any} n */
    const walk = (n) => {
      if (found || !n || n.hidden) return;
      if (n.content?.mod === "chat-switch") found = true;
      else for (const c of n.children ?? []) walk(c);
    };
    try { walk(layout()); } catch {}
    return found;
  }

  // Herdr marks an agent seen only when its terminal is drawn, and the host
  // never is: while the person looks at the chat (the window active, its tab
  // shown), the host's turn is labeled seen (herdr.seen, shared by every
  // client), so "done" becomes "idle" as for any agent you look at.
  markSeen(me, cx) {
    // The terminal view: the agent is the attached terminal, not drawn while its chat face shows.
    const term = this.view ? terminals().find((t) => t.address === this.view) : hostTerminal(this.chat);
    if (!term || term.turn == null || !appWindow()?.active || focused()?.tab !== me.tab) return;
    const key = `${term.address}:${term.turn}`;
    if (String(term.labels?.["herdr.seen"] ?? "") === String(term.turn) || this.seenSent === key) return;
    this.seenSent = key;
    cx.spawn(async () => {
      const r = await hc(["label", term.address, `herdr.seen=${term.turn}`]);
      if (r.code !== 0) { this.seenSent = null; this.log(`hc label herdr.seen: ${(r.stderr || r.stdout).trim()}`); }
    });
  }

  // A host whose chat has no pane any more, and that didn't end itself
  // (host/panewatch.ts): a host from before it, one whose chat's pane closed
  // before it ever saw it (never armed), one whose watch couldn't reach the
  // core: end it, once two checks 30 s apart agree.
  sweepOrphans(cx) {
    this.sweptAt = Date.now();
    cx.spawn(async () => {
      let doc;
      try { doc = await readDoc(); } catch { return; }
      if (!doc?.spaces) return;
      const chats = new Set(modPanes(doc, MOD).map((x) => x.props?.chat).filter(Boolean));
      const missing = new Set();
      for (const t of terminals()) {
        const chat = t.labels?.["herdr-chat.chat"];
        if (t.state !== "live" || !chat) continue;
        // Another machine's host ("box/t7"): its chat's pane is in that machine's document, not this one;
        // its host ends itself when the pane goes (host/panewatch.ts). Never this computer's to end.
        if (machineOf(t.address)) continue;
        // The shell herdr-core restored in a host's place (connection.js runsHost): nobody's, end it.
        const shell = !runsHost(t);
        // A sub-agent (a parent, or the launcher's role=subagent) has no pane by design: never an orphan.
        if (!shell && (t.parent || t.labels?.["herdr-chat.role"] !== "host" || chats.has(chat))) continue;
        missing.add(t.address);
        if (!this.orphans?.has(t.address)) continue;
        this.log(shell ? `${t.address} is a shell restored in chat ${chat}'s host's place: ending it` : `orphan host ${t.address} (chat ${chat} has no pane): ending it`);
        run("terminal.kill", { terminal: t.address });
      }
      this.orphans = missing;
      // The host removes the attachments of chats closed while their host was down (protocol.md
      // "Attachments"): the chats open on its own machine, from that machine's document. An older
      // host has no sweep_attachments: req logs it.
      if (this.conn.status !== "connected") return;
      const machine = this.place ? machineOf(this.place.pane) : null;
      let open = chats;
      if (machine) {
        try { open = new Set(modPanes(await readDoc(machine), MOD).map((x) => x.props?.chat).filter(Boolean)); } catch { return; }
        if (!open.has(this.chat)) return; // its document doesn't have this chat yet: never sweep then
      }
      this.req("sweep_attachments", { open: [...open] }).catch(() => {});
    });
  }

  // ---- records ------------------------------------------------------------------

  // Finished code blocks become retained views (codeview.js): made here, in
  // the record handler (never in render), updated when their props change.
  syncCode(cx) {
    const seen = new Set();
    const items = this.store.items;
    for (let i = Math.max(0, items.length - 400); i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "assistant" || !it.blocks?.length) continue;
      const last = it.blocks.length - 1;
      it.blocks.forEach((b, k) => {
        // Markdown: once the stream moved past it. Code: once its fence closed.
        if (b.type === "markdown" ? it.streaming && k === last : b.type !== "code" || b.open) return;
        const key = `${it.id}:${k}`;
        seen.add(key);
        this.setCodeProps(key, b, cx);
      });
    }
    for (const [k, v] of this.codeViews) if (!seen.has(k)) { v.entity.release(); this.codeViews.delete(k); this.codeSel.delete(k); }
  }

  setCodeProps(key, b, cx) {
    const cur = this.codeViews.get(key);
    const block = b ?? cur?.block;
    if (!block) return;
    const props = block.type === "markdown" ? { owner: this.uid, key, markdown: block.text ?? "", id: `md-${key.replace(":", "-")}` }
      : { owner: this.uid, key, lang: block.lang ?? null, code: block.code ?? "", lines: block.lines ?? null,
        full: this.expanded.has(`code:${key}`), copied: this.copiedAt.has(`code:${key}`) };
    if (!cur) {
      if (!cx?.new) return;
      this.codeViews.set(key, { entity: cx.new(CodeView, props), props, block });
      return;
    }
    const p = cur.props;
    if (p.markdown === props.markdown && p.code === props.code && p.lang === props.lang && p.full === props.full && p.copied === props.copied && (p.lines?.length ?? 0) === (props.lines?.length ?? 0)) return;
    cur.props = props;
    cur.block = block;
    cur.entity.set_props(props);
  }

  // set_theme (protocol v2): the colors the host draws mermaid SVGs with.
  // After each connect, and whenever theme() changes.
  syncTheme(cx) {
    const t = theme();
    const colors = { background: t.background, foreground: t.foreground, muted: t.muted, border: t.border, accent: t.accent };
    for (let i = 0; i < 16; i++) colors[`ansi${i}`] = t[`ansi${i}`];
    const dark = Boolean(settings()?.dark ?? true);
    const key = `${this.conn.connects}:${JSON.stringify(colors)}:${dark}`;
    if (key === this.themeSent) return;
    this.themeSent = key;
    this.req("set_theme", { colors, dark }, cx).then(() => { this.themeOk = true; }, () => { this.themeOk = false; });
  }

  onRecord(rec, cx) {
    if (rec.t === "welcome") {
      cx.spawn(async (cx) => {
        const note = await this.updater.onWelcome(rec, this.healing?.oldPid);
        if (note) this.flash(note, cx);
        this.debug.mark();
        cx.notify();
      });
    } else if (rec.t === "snapshot") {
      this.store.snapshot(rec);
      this.loadedAt = Date.now();
      if (!this.cwd) this.cwd = this.store.state.cwd;
      this.full.clear();
      this.afterState(cx);
      this.syncCode(cx);
    } else if (rec.t === "patch") {
      if (!this.store.patch(rec)) {
        this.log(`seq gap at ${rec.seq} (had ${this.store.seq}): resync`);
        this.conn.resync();
        return;
      }
      if (rec.state) this.afterState(cx);
      if (rec.upsert?.some((it) => it.kind === "assistant" && it.blocks)) this.syncCode(cx);
    } else if (rec.t === "toast") {
      notify({ title: this.providerName(), body: rec.text, level: rec.level === "warning" ? "warning" : rec.level === "error" ? "error" : "info" });
      this.log(`toast ${rec.level}: ${rec.text}`);
    } else if (rec.t === "bye") {
      this.log(`bye: ${rec.reason}`);
      // Closed on purpose: another chat took the session over (not our own replaceHost).
      if (rec.reason === "shutdown" && !this.replacing()) this.byeAt = Date.now();
    }
  }

  afterState(cx) {
    const s = this.store.state;
    // A permission or questions card leaves the keyboard in the composer
    // (number keys, Enter and Esc answer while it's empty).
    this.dialog.sync(s.dialog);
    this.composer.dialogKeys = s.dialog?.method === "select" || s.dialog?.method === "confirm";
    this.composer.askCard = s.dialog?.method === "permission" || s.dialog?.method === "questions" ? s.dialog.method : null;
    if (s.editorText != null && s.editorText !== this.editorAcked) {
      this.editorAcked = s.editorText;
      this.composer.set(s.editorText);
      this.composer.focus();
      this.req("ack_editor_text", {}, cx);
    } else if (s.editorText == null) this.editorAcked = null;
    if (this.composer.menu?.kind === "slash") this.updateMenu(cx);
    // The strip's steps stay open while the same plan is on, not for the next one.
    if (!samePlan(this.planShown, s.plan)) this.planOpen = false;
    this.planShown = s.plan;
  }

  // ---- ops ------------------------------------------------------------------------

  req(op, args = {}, cx, opts) {
    const at = Date.now();
    const entry = { op, at, ok: null };
    this.ops.push(entry);
    if (this.ops.length > 40) this.ops.shift();
    return this.conn.req(op, args, opts).then((data) => {
      entry.ok = true;
      entry.data = data;
      this.debug.mark();
      return data;
    }, (e) => {
      entry.ok = false;
      entry.error = message(e);
      this.log(`${op} failed: ${message(e)}`);
      this.debug.mark();
      throw e;
    });
  }

  // Run an op from an event: errors go to the flash line.
  fire(op, args, cx, then) {
    cx.spawn(async (cx) => {
      try {
        const d = await this.req(op, args, cx);
        then?.(d, cx);
      } catch (e) {
        this.flash(`${op}: ${message(e)}`, cx);
      }
      cx.notify();
    });
  }

  // `mode`: "auto" (Enter: steers while the agent works) or "followUp" (Alt+Enter: after this run).
  // A follow-up taken out of its lane for editing goes back to it on Enter (its lane never changes implicitly).
  send(cx, mode = "auto") {
    if (mode === "auto" && this.editingQueued?.lane === "followUp") mode = "followUp";
    this.editingQueued = null;
    const message = this.composer.message();
    if (message === null) return this.flash("One skill per message: remove the other pill", cx);
    const text = message.replace(/\s+$/, "");
    const images = this.composer.chips.map((c) => c.path);
    if (!text.trim() && !images.length) return;
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text.trim());
    // /reload on a host older than the install restarts the host, not just the agent.
    if (m?.[1] === "reload" && !images.length && this.updater.canRestart(this.conn.welcome)) {
      this.composer.clear();
      this.updater.want();
      const quietNow = quiet(this.store.state, hostTerminal(this.chat)?.address);
      return this.flash(quietNow ? `Restarting on ${this.updater.label()}` : `Restarts on ${this.updater.label()} when ${this.providerName()} is done`, cx);
    }
    // The terminal view: /model alone opens the chat's picker where the host lists the TUI's models (Codex).
    if (this.view && m?.[1] === "model" && !m[2].trim() && !images.length) {
      this.composer.clear();
      return this.openModelPicker(cx);
    }
    if (m && !images.length) {
      const cmd = this.commandList().find((c) => c.name === m[1]);
      if (cmd?.handler === "client") {
        this.composer.clear();
        this.clientCommand(m[1], m[2].trim(), cx);
        return;
      }
    }
    this.composer.clear();
    this.timeline.toBottom();
    // The terminal view: `!command` is the TUI's shell command (Claude Code's bash mode), shown by its own records (a card).
    const bang = Boolean(this.view) && !images.length && /^!\s*[^\s=!]/.test(text.trim());
    this.fire("send", { text, ...(images.length ? { images } : {}), mode, ...(bang ? { echo: false } : {}) }, cx, (d, cx) => {
      this.lastSend = { text, disposition: d?.disposition ?? null, at: Date.now() };
      // The terminal view: a command typed into the TUI opens its screen there (as Ovis peeks the terminal),
      // and the chat comes back once the TUI is at its prompt again.
      // `/model <name>` sets it in place in both TUIs (no picker opens there).
      if (this.view && m && !images.length && !VIEW_IN_PLACE.has(m[1]) && !(m[1] === "model" && m[2].trim())) this.visitTerminal(cx);
    });
  }

  // ---- the terminal view (faces.js) -------------------------------------------------

  // An agent's command the chat face has no picker for (/resume; /model where the host lists no models): typed
  // into the TUI, which shows it.
  viewCommand(name, cx) {
    this.fire("send", { text: `/${name}`, mode: "auto" }, cx, (_d, cx) => this.visitTerminal(cx));
  }

  // A trip to the terminal for a screen a command opened there (a picker, a list): the terminal shows, and once
  // the TUI is back at its prompt (Esc, or a pick) the chat shows again, unless the faces were flipped meanwhile.
  visitTerminal(cx) {
    const trip = (this.trip = (this.trip ?? 0) + 1);
    this.showFace("terminal", cx);
    this.req("await_prompt", {}, cx, { timeout: 16 * 60_000 }).then((r) => {
      if (r?.back && this.trip === trip && this.face === "terminal") this.showFace("chat", cx);
    }, () => {});
  }

  // Shows the terminal (or this chat) in this pane's place: the other face hides.
  showFace(face, cx) {
    if (!this.view) return;
    cx.spawn(async (cx) => {
      try {
        const r = await flip(cx, this.view, face);
        this.face = r.face;
        run("pane.focus", { pane: r.face === "terminal" ? r.term : r.pane });
      } catch (e) {
        this.flash(`Couldn't show the terminal: ${message(e)}`, cx);
      }
      this.debug.mark();
      cx.notify();
    });
  }

  // Each tick: which face shows (this app's last flip until a read of the document made after it, then
  // the document's: another app showing the tab, such as the terminal's machine's own, may flip it),
  // the keyboard on the face that shows (a route to the hidden one, such as the agents list, lands on
  // the other), the composer's focus when this face comes up, and the agent's status for the bar.
  viewTick(me, cx) {
    let changed = false;
    const flipped = sharedFace(this.view);
    if (flipped && flipped.at >= (this.faceDocAt ?? 0) && flipped.face !== this.face) {
      this.face = flipped.face;
      changed = true;
      if (this.face === "chat") this.trip = (this.trip ?? 0) + 1; // back already: a trip's return isn't wanted
    }
    const machine = machineOf(this.view);
    // Often while the keyboard is in this tab (another app's flip that hides this view reaches it only so:
    // a shown view learns it at once, on_size_change), else now and then.
    const here = Boolean(me) && focused()?.tab === me.tab;
    if (!this.faceReading && Date.now() - (this.faceReadAt ?? 0) > (here ? 2000 : machine ? 8000 : 5000)) {
      this.faceReading = true;
      const started = (this.faceReadAt = Date.now());
      cx.spawn(async (cx) => {
        try {
          const f = facesOf(await readDoc(machine), bare(this.view));
          // A flip here since the read began is newer than what it read.
          if ((sharedFace(this.view)?.at ?? 0) > started) return;
          this.faceDocAt = started;
          const was = this.face;
          this.face = f ? faceOf(f) : null;
          if (this.face !== was) { this.debug.mark(); cx.notify(); }
        } catch {} finally {
          this.faceReading = false;
          if (this.faceAgain) { this.faceAgain = false; this.faceReadAt = 0; }
        }
      });
    }
    const term = terminals().find((t) => t.address === this.view);
    const status = term?.state === "live" ? term.status ?? null : "ended";
    if (status !== this.viewStatus) { this.viewStatus = status; changed = true; }
    const f = focused();
    const tp = panes().find((p) => p.terminal === this.view);
    if (me && f && f.tab === me.tab && Date.now() - (this.faceFocusAt ?? 0) > 250) {
      const to = this.face === "chat" && tp && f.pane === tp.pane ? me.pane : this.face === "terminal" && tp && f.pane === me.pane ? tp.pane : null;
      // The face may be another app's flip this one hasn't read yet (the keyboard then went to the face
      // that shows now): unless this app flipped as the keyboard moved, or read the document since, the
      // document first.
      if (f.pane !== this.keyPane) { this.keyPane = f.pane; this.keyPaneAt = Date.now(); }
      const sure = (sharedFace(this.view)?.at ?? 0) >= this.keyPaneAt - 1000 || (this.faceDocAt ?? 0) >= this.keyPaneAt;
      if (to && !sure) this.faceReadAt = 0;
      else if (to) {
        this.faceFocusAt = Date.now();
        run("pane.focus", { pane: to });
      }
    }
    // This face just took the pane focus (a flip, a click): the keyboard goes to the composer.
    const mine = Boolean(me) && f?.pane === me.pane && this.face === "chat";
    if (mine && !this.hadFocus) this.refocus(cx);
    this.hadFocus = mine;
    return changed;
  }

  // The terminal view's status, in words: only when it wants the person (the
  // dot says the rest; its tooltip has the word).
  viewWord(all = false) {
    const st = this.viewStatus;
    // Waiting on a dialog the chat shows as a card: answered here; one it doesn't know: in the terminal.
    const words = { working: "working", blocked: this.store.state.dialog ? "needs you" : "needs you in the terminal", done: "finished", idle: "idle", ended: "terminal ended" };
    return all || st === "blocked" || st === "ended" ? words[st] ?? "" : "";
  }

  // The switch floats at the top right when the pane's margin beside the
  // column has room for it (no bar across the top, as in Ovis); a narrow
  // pane gets it in a slim row of its own, so it never covers a message.
  viewFloats() {
    if (!this.width) return true;
    const word = this.viewWord();
    const pill = 150 + (word ? 8 + word.length * 6.5 : 0);
    const margin = (this.width - Math.min(COL_MAX, this.width)) / 2 + this.pad();
    return margin >= pill + 22;
  }

  viewBar(t) {
    const st = this.viewStatus;
    const color = st === "blocked" ? t.blocked : st === "ended" ? t.dim : t[st] ?? t.dim;
    const word = this.viewWord();
    const seg = (id, label, on, what) => div().id(id).flex_none().px(10).py(2).rounded(5).text_size(11.5)
      .when(on, (e) => e.bg(t.background).text_color(t.foreground).font_semibold())
      .when(!on, (e) => e.text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground)).on_click((_e, cx) => this.control(what, cx)))
      .child(label);
    const tip = keyHint("flip") ?? "Ctrl+Shift+J";
    return h_flex().id("view-bar").flex_none().h(28).pl(10).pr(2).gap(8).items_center().rounded(8)
      .bg(t.surface).border_1().border_color(t.border).text_size(12)
      .child(h_flex().id("view-status").flex_none().gap(6).items_center().tooltip(`${this.providerName()} · ${this.viewWord(true)}`)
        .child(st === "working" ? spinner(11) : div().w(10).flex_none().text_color(color).child(st === "idle" || !st ? "○" : st === "ended" ? "·" : "●"))
        .when(Boolean(word), (e) => e.child(div().text_color(color).child(word))))
      .child(h_flex().id("view-switch").flex_none().p(2).gap(2).rounded(6).bg(t.hover).tooltip(`Switch · ${tip}`)
        .child(seg("view-chat", "Chat", true, null))
        .child(seg("view-terminal", "Terminal", false, "view:terminal")));
  }

  abort(cx) {
    this.fire("abort", {}, cx, (d, cx) => {
      const restored = (d?.restored ?? []).filter(Boolean);
      if (restored.length) {
        const now = this.composer.value.trim();
        this.composer.set([...restored, ...(now ? [now] : [])].join("\n\n"));
      }
      this.composer.focus();
      cx.notify();
    });
  }

  clientCommand(name, rest, cx) {
    if (name === "model") {
      if (rest) {
        const [provider, ...id] = rest.split("/");
        return this.fire("set_model", id.length ? { provider, modelId: id.join("/") } : { model: rest }, cx);
      }
      return this.openModelPicker(cx);
    }
    if (name === "thinking") {
      if (rest) return this.fire("set_thinking", { level: rest }, cx);
      return this.openThinkingPicker(cx);
    }
    if (name === "resume") return this.openSessionsPicker(cx);
    if (name === "fork") return this.openForkPicker(cx);
    if (name === "transcript") return this.showTranscript(cx);
    if (name === "copy") {
      const text = this.store.lastAssistantText();
      if (text) {
        cx.write_to_clipboard(text);
        this.copied = text.length;
        this.flash("Copied the last answer", cx);
      } else this.flash("Nothing to copy yet", cx);
      return;
    }
    // The rest of the client built-ins come from the host, per provider (protocol
    // "Built-in commands per provider"): one with `argv` is a terminal utility
    // (/login, /settings…) run as it is; any other is a hand-off to the agent's
    // own TUI on this session (/tui, and /tree, /export… where the agent lists them).
    const cmd = this.store.state.commands.find((c) => c.name === name && c.handler === "client");
    if (cmd?.argv?.length) return this.startHandoff("utility", name, cx, cmd.argv, cmd.input);
    if (cmd || name === "tui") return this.startHandoff("session", name, cx, null, cmd?.input);
    this.fire("send", { text: `/${name}${rest ? " " + rest : ""}`, mode: "auto" }, cx);
  }

  pasteImage(cx) {
    // A host on another machine would read that machine's clipboard: this computer's goes there instead.
    if (this.remoteMachine()) return this.pasteImageThere(cx);
    this.fire("clipboard_image", {}, cx, (d, cx) => {
      if (d?.path) this.composer.addChip(d.path, { size: d.size ?? null });
      else this.flash("The clipboard has no image", cx);
      this.debug.mark();
    });
  }

  // This computer's clipboard image for a host on another machine: saved here by this computer's
  // own host program (`clipboard-image`), sent beside the host there, then made the chat's copy.
  pasteImageThere(cx) {
    cx.spawn(async (cx) => {
      try {
        const cfg = await readConfig();
        if (!cfg.host) throw new Error("herdr-chat's host isn't installed on this computer: an image can't be pasted from here");
        const dir = `${appHome().replace(/\/+$/, "")}/data/herdr-chat/outgoing`;
        await fs.mkdir(dir, { recursive: true });
        const file = `${dir}/${this.chat}-${Date.now()}-paste.png`;
        const r = await exec("/usr/bin/env", [...(cfg.node ? [`HERDR_CHAT_NODE=${cfg.node}`] : []), cfg.host, "clipboard-image", "--out", file]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^herdr-chat-host: /, "") || "couldn't read the clipboard");
        if (!JSON.parse(r.stdout || "{}")?.path) return this.flash("The clipboard has no image", cx);
        try {
          const there = await this.putForHost(file);
          const d = await this.req("attach_image", { path: there }, cx);
          this.composer.addChip(d.path, { size: d.size ?? null });
        } finally {
          fs.unlink(file).catch(() => {});
        }
      } catch (e) {
        this.flash(message(e), cx);
      }
      this.debug.mark();
      cx.notify();
    });
  }

  drop(paths, cx) {
    let text = this.composer.value;
    for (const p of paths) {
      if (IMAGE.test(p)) {
        this.attachImage(this.composer.addChip(p, { pending: true }), cx);
        continue;
      }
      const rel = this.cwd && p.startsWith(this.cwd + "/") ? p.slice(this.cwd.length + 1) : p;
      text += (text && !/\s$/.test(text) ? " " : "") + `@${rel} `;
    }
    if (text !== this.composer.value) this.composer.set(text);
    this.composer.focus();
    this.debug.mark();
    cx.notify();
  }

  // A dropped image's chip holds the dropped file until the host has made the chat's copy
  // (attach_image), which the chip can show: a send in between carries the file itself, and a copy
  // the chip no longer holds goes again. A file the host refuses leaves with its reason. An older
  // host has no attach_image: the chip keeps the file.
  attachImage(chip, cx) {
    cx.spawn(async (cx) => {
      try {
        // A host on another machine can't read this computer's file: it goes there first.
        const from = this.remoteMachine() ? await this.putForHost(chip.path) : chip.path;
        const { path, size } = await this.req("attach_image", { path: from }, cx);
        if (this.composer.chips.includes(chip)) Object.assign(chip, { path, size: size ?? null });
        else this.req("detach_image", { path }).catch(() => {});
      } catch (e) {
        const i = this.composer.chips.indexOf(chip);
        if (i >= 0 && !/^Unknown op/.test(message(e))) {
          this.composer.removeChip(i);
          this.flash(message(e), cx);
        }
      }
      chip.pending = false;
      this.debug.mark();
      cx.notify();
    });
  }

  // ---- menus and pickers --------------------------------------------------------

  updateMenu(cx) {
    const w = this.composer.wanted();
    if (!w) {
      this.composer.menu = null;
      return;
    }
    const prev = this.composer.menu;
    if (w.kind === "slash") {
      const list = w.skillsOnly ? this.commandList().filter((c) => c.source === "skill") : this.commandList();
      const items = slashItems(list, w.query);
      const same = prev?.kind === "slash" && prev.query === w.query && prev.start === w.start;
      const sel = same ? Math.min(prev.sel, Math.max(0, items.length - 1)) : 0;
      this.composer.menu = items.length ? { kind: "slash", query: w.query, items, sel, start: w.start, skillsOnly: Boolean(w.skillsOnly) } : null;
      return;
    }
    if (prev?.kind === "files" && prev.query === w.query) return;
    const menu = { kind: "files", query: w.query, items: prev?.kind === "files" ? prev.items : [], sel: 0, loading: true };
    this.composer.menu = menu;
    const token = (this.filesToken = (this.filesToken ?? 0) + 1);
    cx.spawn(async (cx) => {
      try {
        const d = await this.req("files", { query: w.query, limit: 50 }, cx);
        if (token !== this.filesToken || this.composer.menu !== menu) return;
        menu.items = d?.files ?? [];
        menu.loading = false;
        if (!menu.items.length) this.composer.menu = null;
      } catch {
        if (this.composer.menu === menu) this.composer.menu = null;
      }
      this.debug.mark();
      cx.notify();
    });
  }

  // The slash commands: the host's (built-ins, then the agent's).
  commandList() {
    return this.store.state.commands ?? [];
  }

  // The shortcut a slash command shares, for the menu: "⇧⌘M" beside /model.
  slashKey(name) {
    const a = { model: "model", thinking: "effort", resume: "resume", tui: "tui" }[name];
    return a ? keyHint(a) : null;
  }

  pickMenu(i, cx, { complete = false } = {}) {
    const m = this.composer.menu;
    const it = m?.items?.[i ?? m.sel];
    if (!it) return;
    if (m.kind === "files") {
      this.composer.insertFile(it);
    } else if (it.source === "skill") { // a pill; the person goes on typing
      this.composer.insertSkill({ command: it.name, name: it.name.replace(/^skill:/, "") });
    } else if (complete || /^</.test(it.args ?? "")) { // required args: complete, let the person type them
      this.composer.set(`/${it.name} `);
      this.composer.menu = null;
    } else {
      this.composer.set(`/${it.name}`);
      this.composer.menu = null;
      this.send(cx);
    }
    // A command that opened a picker (/resume, /thinking) leaves the keyboard in it.
    if (this.picker) this.picker.focus();
    else this.composer.focus();
    this.debug.mark();
    cx.notify();
  }

  openPicker(picker, cx) {
    // A press outside the picker closed it on the way to the chip that opens it: a toggle, not a reopen.
    if (this.pickerClosed?.kind === picker.kind && Date.now() - this.pickerClosed.at < 350) return;
    this.picker = picker;
    this.composer.menu = null;
    picker.focus();
    this.debug.mark();
    cx.notify();
  }

  closePicker(cx) {
    this.picker = null;
    this.composer.focus();
    this.debug.mark();
    cx.notify();
  }

  // A press outside the open menu or picker closes it (the composer keeps its text).
  outside(cx) {
    if (this.picker) {
      this.pickerClosed = { kind: this.picker.kind, at: Date.now() };
      this.closedBy = "outside";
      return this.closePicker(cx);
    }
    if (this.composer.menu) {
      this.composer.menu = null;
      this.closedBy = "outside";
      this.debug.mark();
      cx.notify();
    }
  }

  // The mouse wheel over the open menu or picker: its rows move, the selection stays.
  wheel(dy, cx) {
    const m = this.picker ?? this.composer.menu;
    if (!m) return;
    const moved = this.picker ? this.picker.wheel(dy) : wheelMenu(m, dy, m.items?.length ?? 0);
    this.debug.mark();
    if (moved) cx.notify();
  }

  // The chat-scoped shortcuts (shortcuts.js, KEYS.md). The same actions for
  // every agent; one it can't do says so.
  shortcut(a, cx) {
    this.lastShortcut = { action: a, at: Date.now() };
    this.log(`shortcut ${a}`);
    const caps = this.caps();
    const toggle = (kind, open) => (this.picker?.kind === kind ? this.closePicker(cx) : open());
    switch (a) {
      case "steer": return this.send(cx);
      case "followUp": return this.send(cx, "followUp");
      case "model": return toggle("model", () => this.openModelPicker(cx));
      case "effort":
        if (!this.hasThinking()) return this.flash(`${this.providerName()} has no thinking levels for this model`, cx);
        return toggle("thinking", () => this.openThinkingPicker(cx));
      case "cycleEffort": return this.cycleEffort(cx);
      case "mode": return toggle("permission", () => this.openModePicker(cx));
      case "cycleMode": return this.cycleMode(cx);
      case "stop":
        if (!this.store.working()) return this.flash("Nothing to stop", cx);
        return this.abort(cx);
      case "tui":
        if (this.view) return this.showFace("terminal", cx);
        if (caps?.tui === false) return this.flash(`${this.providerName()} has no terminal UI to continue in`, cx);
        return this.startHandoff("session", "tui", cx);
      case "flip":
        if (this.view) return this.showFace("terminal", cx);
        return this.flash(`${keyHint("flip") ?? "Ctrl+Shift+J"} flips a Claude Code or Codex terminal and its chat view. This chat runs its own agent: ${keyHint("tui") ?? "/tui"} opens it in a terminal`, cx);
      case "resume": return this.view ? this.viewCommand("resume", cx) : toggle("sessions", () => this.openSessionsPicker(cx));
      case "pageUp": this.timeline.page(1); break;
      case "pageDown": this.timeline.page(-1); break;
      case "top": this.timeline.toTop(); break;
      case "latest": this.timeline.toBottom(); break;
      case "find": return this.openFind(cx);
      case "focusComposer":
        if (this.picker) this.picker = null;
        this.composer.focus();
        break;
      case "newChat": return this.newChat(cx);
      default: this.log(`unknown shortcut ${a}`);
    }
    this.debug.mark();
    cx.notify();
  }

  hasThinking() {
    return this.thinkingLevels().length > 0;
  }

  // Shift+Tab: the agent's next permission mode (Ask → Accept edits → Plan → …);
  // an agent with none (Pi) cycles the thinking level instead, as its own TUI does.
  cycleMode(cx) {
    const s = this.store.state;
    const modes = this.caps()?.permissionModes ?? [];
    if (!modes.length) return this.cycleEffort(cx);
    const i = modes.findIndex((m) => m.id === s.permissionMode);
    const next = modes[(i + 1) % modes.length];
    this.flash(`Mode: ${next.label}`, cx);
    this.fire("set_permission_mode", { mode: next.id }, cx);
  }

  // The next thinking level (effort) the current model allows, wrapping around.
  cycleEffort(cx) {
    if (!this.hasThinking()) return this.flash(`${this.providerName()} has no thinking levels for this model`, cx);
    const levels = this.thinkingLevels();
    if (!levels.length) return this.flash(`${this.providerName()} has no thinking levels for this model`, cx);
    const next = levels[(levels.indexOf(this.store.state.thinking) + 1) % levels.length]; // unknown or unset: the first
    this.flash(`Thinking: ${next}`, cx);
    this.fire("set_thinking", { level: next }, cx);
  }

  // A queued row (chrome.js queueChips): × removes it, ⇄ moves it to the other
  // lane, a click takes it back into the composer (sending re-queues it).
  queueRow(op, id, cx) {
    const q = /** @type {{steeringIds?: (string | null)[]}} */ (this.store.state.queue);
    const lane = q?.steeringIds?.includes(id) ? "steer" : "followUp";
    if (op === "remove") return this.fire("queue_remove", { message: id }, cx);
    if (op === "move") {
      const to = lane === "steer" ? "followUp" : "steer";
      this.flash(to === "steer" ? "Steering with it now" : "Moved to the follow-ups: it goes after this run", cx);
      return this.fire("queue_move", { message: id, to }, cx);
    }
    if (op === "edit") {
      return this.fire("queue_edit", { message: id }, cx, (d, cx) => {
        const now = this.composer.value.replace(/\s+$/, "");
        this.composer.set(now.trim() ? `${now}\n\n${d?.text ?? ""}` : d?.text ?? "");
        for (const p of d?.images ?? []) this.composer.addChip(p);
        this.editingQueued = { lane };
        this.composer.focus();
        const hint = keyHint("steer");
        const k = !hint || hint === "↩" ? "Enter" : hint;
        this.flash(lane === "followUp" ? `Editing a follow-up: ${k} queues it again` : `Editing a steer: ${k} steers with it`, cx);
        this.debug.mark();
      });
    }
    this.log(`unknown queue control ${op}`);
  }

  // A new chat tab beside this one: same agent, this folder, or `cwd` on `session` (/resume, another folder's).
  newChat(cx, { cwd = this.cwd, session = null } = {}) {
    const place = this.findPlace();
    const provider = this.providerId();
    const chat = `c-${randomBytes(4).toString("hex")}`;
    const hostEnv = props()?.hostEnv; // (E2E: the fake agent's scenario)
    this.lastNewChat = chat;
    run("tab.new", { name: provider, ...(place?.space ? { space: place.space } : {}), mod: MOD,
      props: { chat, provider, ...(cwd ? { cwd } : {}), ...(session ? { session } : {}), ...(hostEnv ? { hostEnv } : {}) } });
    this.debug.mark();
  }

  openModelPicker(cx) {
    cx.spawn(async (cx) => {
      try {
        const d = await this.req("models", {}, cx);
        const cur = this.store.state.model;
        const models = [...(d?.models ?? [])].sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)));
        // The terminal view of a TUI whose models the host can't list (Claude Code): its own picker, in the terminal.
        if (this.view && !models.length) return this.viewCommand("model", cx);
        const rows = (provider) => models.filter((m) => !provider || m.provider === provider)
          .map((m) => ({ value: `${m.provider}/${m.id}`, label: m.name || m.id, detail: `${m.provider}/${m.id}${m.enabled ? "" : " · not enabled"}`, current: cur && cur.provider === m.provider && cur.id === m.id, m }));
        // One tab per provider, after All, so a model is picked from one account at a
        // time. In id order: the agent lists its models in no order the tabs can keep.
        const providers = [...new Set(models.map((m) => m.provider))].sort();
        const tabs = [{ label: "All", provider: null }, ...providers.map((p) => ({ label: modelTab(p), provider: p }))];
        const picker = new Picker("model", "Model", rows(null), (it, cx) => {
          this.closePicker(cx);
          this.fire("set_model", { provider: it.m.provider, modelId: it.m.id }, cx);
        }, {
          hint: keyHint("model"),
          scopes: providers.length < 2 ? null
            : {
              labels: tabs.map((x) => x.label), index: 0,
              onChange: (i, cx) => { picker.setItems(rows(tabs[i].provider), {}, cx); this.debug.mark(); },
            },
        });
        this.openPicker(picker, cx);
      } catch (e) {
        this.flash(`models: ${message(e)}`, cx);
      }
    });
  }

  openThinkingPicker(cx) {
    const cur = this.store.state.thinking ?? "off";
    const items = this.thinkingLevels().map((l) => ({ value: l, label: l, current: l === cur }));
    this.openPicker(new Picker("thinking", "Thinking level", items, (it, cx) => {
      this.closePicker(cx);
      this.fire("set_thinking", { level: it.value }, cx);
    }, { hint: keyHint("effort") }), cx);
  }

  // Permission modes (capabilities.permissionModes): Ask, Accept edits, Plan… as the agent names them.
  openModePicker(cx) {
    const s = this.store.state;
    const items = (s.capabilities?.permissionModes ?? []).map((m) => ({ value: m.id, label: m.label, detail: m.description ?? "", current: m.id === s.permissionMode }));
    if (!items.length) return this.flash(`${this.providerName()} has no permission modes`, cx);
    this.openPicker(new Picker("permission", "Permission mode", items, (it, cx) => {
      this.closePicker(cx);
      this.fire("set_permission_mode", { mode: it.value }, cx);
    }, { hint: keyHint("mode") }), cx);
  }

  // What the agent can do (state.capabilities); null until the host says.
  caps() {
    return this.store.state.capabilities ?? null;
  }

  thinkingLevels() {
    return this.caps()?.thinkingLevels ?? [];
  }

  providerId() {
    return this.store.state.provider ?? this.conn.provider ?? this.provider ?? DEFAULT_PROVIDER;
  }

  providerName() {
    return this.store.state.providerName ?? PROVIDER_NAMES[this.providerId()] ?? "the agent";
  }

  // /resume: this folder's sessions, or every folder's (Tab, as in Pi's own picker),
  // every one, newest first. The host searches them (name, first message, folder) as
  // the filter changes, and is asked again while it's still reading them (`loading`).
  // This folder's switches this chat; another folder's opens in a chat tab there.
  openSessionsPicker(cx) {
    const SCOPES = ["cwd", "all"];
    let seq = 0;
    const row = (s, scope, now) => ({
      value: s.path, s, current: s.path === this.store.state.sessionFile,
      label: oneLine(s.name || s.firstMessage) || s.path.split("/").pop(),
      meta: [scope === "all" && s.cwd ? tildePath(s.cwd, this.homeDir) : null, s.messageCount == null ? null : plural(s.messageCount, "message"), relTime(s.modified, now)]
        .filter(Boolean).join(" · "),
    });
    const load = (cx, refresh) => {
      const n = ++seq;
      const live = () => n === seq && this.picker === picker;
      cx.spawn(async (cx) => {
        try {
          for (let again = refresh; ; again = false) {
            const scope = SCOPES[picker.scopes.index];
            const d = await this.req("sessions", { scope, query: picker.query, refresh: again }, cx);
            if (!live()) return;
            const now = Date.now();
            picker.empty = scope === "all" ? "No sessions yet" : "No sessions in this folder yet";
            // A host from before this picker (a chat open across the upgrade) ignores `query`, has no
            // `loading`: the picker filters what it sent itself, as it did then.
            if (d && !("loading" in d)) picker.onQuery = null;
            picker.setItems((d?.sessions ?? []).map((s) => row(s, scope, now)), { progress: d?.loading ?? null }, cx);
            this.debug.mark();
            cx.notify();
            if (!d?.loading) return;
            await cx.sleep(300);
            if (!live()) return;
          }
        } catch (e) {
          if (!live()) return;
          picker.setItems([], {}, cx);
          this.flash(`sessions: ${message(e)}`, cx);
        }
      });
    };
    const picker = new Picker("sessions", "Resume a session", [], (it, cx) => {
      this.closePicker(cx);
      // (A host older than `here` lists only this folder's.)
      if (it.s.here !== false || !it.s.cwd) this.fire("switch_session", { path: it.value }, cx);
      else this.newChat(cx, { cwd: it.s.cwd, session: it.value });
    }, {
      hint: keyHint("resume"), loading: true,
      scopes: { labels: ["This folder", "All folders"], index: 0, onChange: (_i, cx) => load(cx, true) },
      onQuery: (cx) => load(cx, false),
    });
    this.openPicker(picker, cx);
    load(cx, true);
  }

  // /fork: the person's messages, newest first. The pick makes a new session up to
  // that message (the agent's own fork; this one stays as it was) and puts the
  // message back in the composer, to edit and send.
  openForkPicker(cx) {
    if (this.sub) return this.flash("/fork isn't available in a sub-agent's chat: its parent drives this session", cx);
    cx.spawn(async (cx) => {
      try {
        const d = await this.req("fork_points", {}, cx);
        const items = (d?.points ?? []).map((p, i) => ({ value: p.id, label: oneLine(p.text) || "(an image)", detail: i === 0 ? "the last message" : null }));
        if (!items.length) return this.flash("Nothing to fork from yet", cx);
        this.openPicker(new Picker("fork", "Fork from a message", items, (it, cx) => {
          this.closePicker(cx);
          this.fire("fork", { point: it.value }, cx, (r, cx) => {
            this.composer.set(r?.text ?? "");
            this.composer.focus();
          });
        }), cx);
      } catch (e) {
        this.flash(`fork: ${message(e)}`, cx);
      }
    });
  }

  // ---- keys ---------------------------------------------------------------------

  action(a, cx) {
    this.log(`action ${a}`);
    const pk = this.picker;
    const m = this.composer.menu?.items?.length ? this.composer.menu : null;
    const dlg = this.store.state.dialog;
    // A permission or questions card, the composer empty: 1–9, ↑↓, Space, Enter, Esc answer it.
    if (!pk && !m && dlg && this.composer.askCard && !this.composer.value.trim() && this.askAction(a, dlg, cx)) {
      this.debug.mark();
      cx.notify();
      return;
    }
    if (!pk && !m && dlg && this.composer.dialogKeys && !this.composer.value.trim() && ["herdrchat_up", "herdrchat_down", "herdrchat_enter"].includes(a)) {
      const n = dlg.method === "select" ? (dlg.options ?? []).length : 2;
      if (a === "herdrchat_enter") {
        if (dlg.method === "select") this.answer("value", dlg.options[this.dialog.sel], cx);
        else this.answer("confirm", this.dialog.sel === 0, cx);
      } else if (n) this.dialog.sel = (this.dialog.sel + (a === "herdrchat_up" ? -1 : 1) + n) % n;
    } else if (pk) {
      if (a === "herdrchat_up") pk.move(-1);
      else if (a === "herdrchat_down") pk.move(1);
      else if (a === "herdrchat_enter") pk.choose(null, cx);
      else if (a === "herdrchat_tab") pk.tab(cx);
      else if (a === "herdrchat_escape") this.closePicker(cx);
    } else if (a === "herdrchat_up" && m) this.composer.moveSel(-1);
    else if (a === "herdrchat_down" && m) this.composer.moveSel(1);
    else if (a === "herdrchat_enter" && m) return this.pickMenu(null, cx);
    else if (a === "herdrchat_tab" && m) return this.pickMenu(null, cx, { complete: true });
    else if (a === "herdrchat_up") this.composer.recall(this.store.sentPrompts(), -1);
    else if (a === "herdrchat_down") this.composer.recall(this.store.sentPrompts(), 1);
    else if (a === "herdrchat_enter") this.send(cx);
    else if (a === "herdrchat_stop") this.abort(cx);
    else if (a === "herdrchat_escape") {
      if (m) this.composer.menu = null;
      else if (this.store.state.dialog) this.answer("cancel", null, cx);
      else if (this.runAsk) this.runAsk = null;
      else if (this.store.working()) this.abort(cx);
      else if (this.peekMode) return this.closePeek();
    }
    this.debug.mark();
    cx.notify();
  }

  askAction(a, d, cx) {
    const digit = /^herdrchat_digit_(\d)$/.exec(a);
    if (d.method === "permission") {
      const n = (d.choices ?? []).length;
      if (digit) return this.answer("choice", this.dialog.choiceFor(d, Number(digit[1])), cx), true;
      if (a === "herdrchat_enter") return this.answer("choice", this.dialog.choiceFor(d, "enter"), cx), true;
      if (a === "herdrchat_escape") {
        const deny = this.dialog.choiceFor(d, "escape");
        if (deny) this.answer("choice", deny, cx); else this.answer("cancel", null, cx);
        return true;
      }
      if ((a === "herdrchat_up" || a === "herdrchat_down") && n) { this.dialog.sel = (this.dialog.sel + (a === "herdrchat_up" ? -1 : 1) + n) % n; return true; }
      return false;
    }
    if (d.method === "questions") {
      const key = /^herdrchat_(up|down|space|enter)$/.exec(a)?.[1];
      if (a === "herdrchat_escape") this.answer("cancel", null, cx);
      else if (digit) this.dialog.form.digit(Number(digit[1]));
      else if (key) { const ans = this.dialog.form.key(key); if (ans) this.answer("answers", ans, cx); }
      else return false;
      return true;
    }
    return false;
  }

  answer(kind, value, cx) {
    const d = this.store.state.dialog;
    if (!d) return;
    let args;
    if (kind === "cancel") args = { dialog: d.id, cancelled: true };
    else if (kind === "confirm") args = { dialog: d.id, confirmed: Boolean(value) };
    else if (kind === "submit") args = { dialog: d.id, value: this.dialog.value() };
    else if (kind === "choice") { if (!value) return; args = { dialog: d.id, ...value }; }
    else if (kind === "answers") { if (!value) return; args = { dialog: d.id, answers: value }; }
    else args = { dialog: d.id, value };
    this.lastAnswer = { ...args, at: Date.now() };
    this.fire("dialog_answer", args, cx);
    this.composer.focus();
  }

  toggle(id, cx) {
    if (id.startsWith("g-")) {
      const r = buildRows(this.store.items, this.store.state).find((x) => x.id === id);
      const now = this.groups.get(id) ?? (r ? defaultOpen(r) : false);
      this.groups.set(id, !now);
      this.animateGroup(id, now ? "close" : "open", cx);
    } else if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    if (id.startsWith("code:")) this.setCodeProps(id.slice(5), null, cx);
    this.debug.mark();
    cx.notify();
  }

  // A group's cards slide open or shut: step 0 draws the start height, step
  // 1 the end one (the transition runs natively between them), then the
  // explicit height goes. `groupH` keeps each open group's natural height.
  animateGroup(id, target, cx) {
    const a = { target, step: 0, h: this.groupH.get(id) ?? null, at: Date.now() };
    this.groupAnims.set(id, a);
    cx.spawn(async (cx) => {
      if (target === "close" || a.h != null) {
        await cx.sleep(20);
        if (this.groupAnims.get(id) !== a) return;
        a.step = 1;
        cx.notify();
      }
      await cx.sleep(240);
      if (this.groupAnims.get(id) === a) { this.groupAnims.delete(id); cx.notify(); }
    });
  }

  groupMeasured(id, h, cx) {
    if (this.groupH.get(id) === h) return;
    this.groupH.set(id, h);
    const a = this.groupAnims.get(id);
    if (a?.target === "open" && a.h == null) {
      a.h = h;
      a.step = 1;
      cx.notify();
    }
  }

  setHover(id, on, cx) {
    const next = on ? id : this.hover === id ? null : this.hover;
    if (next === this.hover) return;
    this.hover = next;
    this.debug.mark();
    cx.notify();
  }

  // The diagram under the pointer (rich.js shows its ⤢ enlarge hint).
  setSvgHover(key, on, cx) {
    const next = on ? key : this.svgHover === key ? null : this.svgHover ?? null;
    if (next === (this.svgHover ?? null)) return;
    this.svgHover = next;
    this.debug.mark();
    cx.notify();
  }

  // The status chips' popover (chrome.js), opened and closed by its trigger.
  setStatusesOpen(open, cx) {
    this.statusesOpen = open;
    this.debug.mark();
    cx.notify();
  }

  // The composer's + menu (chrome.js plusButton).
  setPlusOpen(open, cx) {
    this.plusOpen = open;
    this.debug.mark();
    cx.notify();
  }

  // Text selected in a code block (codeview.js), on ⌘C.
  copySelection(text, cx) {
    cx.write_to_clipboard(text);
    this.lastCopy = { id: "code-selection", len: text.length, text: text.slice(0, 500) };
    this.flash(`Copied ${text.length} character${text.length === 1 ? "" : "s"}`, cx);
  }

  copy(id, text, cx) {
    cx.write_to_clipboard(text ?? "");
    this.copied = (text ?? "").length;
    this.copiedAt.set(id, Date.now());
    this.lastCopy = { id, len: (text ?? "").length };
    if (id.startsWith("code:")) this.setCodeProps(id.slice(5), null, cx);
    this.debug.mark();
    cx.notify();
  }

  // Quote an answer in your reply, as a markdown quote after what the draft holds: the
  // part of it you copied (select, Ctrl+C, Quote; mods can't read a text view's
  // selection), else all of it.
  /** @param {any} it @param {import("gpui-kit").Context} cx */
  quote(it, cx) {
    const whole = String(it.text ?? "").trim();
    if (!whole) return;
    let clip = "";
    try { clip = (cx.read_from_clipboard() ?? "").trim(); } catch {}
    const part = plainText(clip).length >= 8 && clip.length < whole.length && plainText(whole).includes(plainText(clip)) ? clip : null;
    const body = (part ?? whole).split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
    const draft = this.composer.value.trimEnd();
    this.composer.set(`${draft ? `${draft}\n\n` : ""}${body}\n\n`);
    this.composer.focus();
    this.lastQuote = { item: it.id, part: Boolean(part), len: body.length };
    this.flash(part ? "Quoted the part you copied" : "Quoted the answer", cx);
  }

  // Edit and resend: the message's text back in the composer.
  editResend(it, cx) {
    const env = /^\s*<hc from="[^"]*"[^>]*>([\s\S]*?)<\/hc>\s*$/.exec(it.text ?? "");
    this.composer.set(env ? env[1] : typedText(it));
    this.composer.focus();
    this.debug.mark();
    cx.notify();
  }

  // An image or diagram, big, in a dialog over the window.
  enlarge(path, size, cx) {
    const rel = this.imageRel(path);
    if (!rel) return this.flash(this.remoteMachine() && this.remoteHome ? "That image is still on its way from the other machine" : "Can't show a file outside the app's folder", cx);
    const w = Math.min(1400, Math.max(320, (size?.w ?? 900) + 48));
    const h = Math.min(1000, Math.max(240, (size?.h ?? 600) + 80));
    this.enlarged = path;
    openOverlay({ mod: MOD, kind: "dialog", width: 0.85, height: 0.85, props: { viewer: { path: rel, w: size?.w ?? null, h: size?.h ?? null, want: [w, h] } } });
    this.debug.mark();
  }

  // An SVG's natural size, from its viewBox / width / height (read once, off
  // render). Raster images come with theirs (items' `imageSizes`): the mod
  // can't read them (no fs.read grant), and a size read late would resize a drawn row.
  svgSize(path) {
    if (!path) return null;
    if (this.svgSizes.has(path)) return this.svgSizes.get(path);
    // Another machine's: read from its copy here, once it's here (imageRel).
    if (/\.svg$/i.test(path) && (!this.remoteMachine() || this.imageRel(path))) (this.svgWanted ??= new Set()).add(path);
    return null;
  }

  // ---- a host on another machine: its files here --------------------------------

  // The machine of the chat's space when it isn't this computer's: its host runs there (machines.js).
  remoteMachine() {
    return this.place ? machineOf(this.place.pane) : null;
  }

  // A file the host names (a path on its machine: an attachment, a rendered diagram) as image()
  // takes it: relative to this app's home, else null. A host on another machine keeps them under
  // its app home there; the same relative path here gets a copy (loadMirrors, through herdr-core),
  // and until it has one, this is null (the row shows its fallback and redraws once it's here).
  imageRel(path) {
    const machine = this.remoteMachine();
    if (!machine) return homeRel(path, appHome());
    if (!this.remoteHome || !path) return null;
    const rel = homeRel(path, this.remoteHome);
    if (!rel) return null;
    const st = (this.mirrors ??= new Map()).get(rel);
    if (st === "here") return rel;
    if (!st) {
      this.mirrors.set(rel, "wanted");
      (this.mirrorWanted ??= new Map()).set(rel, { machine, path });
    }
    return null;
  }

  // A file of the host's machine on its way here (imageRel asked for it, it isn't here yet).
  imagePending(path) {
    if (!this.remoteMachine() || !this.remoteHome) return Boolean(this.remoteMachine());
    const st = this.mirrors?.get(homeRel(path, this.remoteHome) ?? "");
    return st === "wanted" || st === "loading";
  }

  // Copies the wanted files of the host's machine here, at most 6 MB each (an exec's output is
  // base64), then redraws. One already here (an earlier open) isn't fetched again.
  loadMirrors(cx) {
    const want = [...this.mirrorWanted];
    this.mirrorWanted.clear();
    for (const [rel] of want) this.mirrors.set(rel, "loading");
    cx.spawn(async (cx) => {
      for (const [rel, { machine, path }] of want) {
        const local = `${appHome().replace(/\/+$/, "")}/${rel}`;
        try {
          // fs here may write the app's data folder but not read it: test(1) says whether it's here.
          if ((await exec("test", ["-f", local])).code !== 0) {
            const r = await exec("/bin/sh", ["-c", '[ -f "$1" ] || exit 3; [ "$(wc -c < "$1")" -le 6000000 ] || exit 4; base64 < "$1"', "sh", path], { on: machine, timeout: 60000 });
            if (r.code !== 0) throw new Error(r.code === 3 ? "not there" : r.code === 4 ? "over 6 MB" : (r.stderr || "").trim() || `exit ${r.code}`);
            await fs.mkdir(local.slice(0, local.lastIndexOf("/")), { recursive: true });
            await fs.writeFile(local, Buffer.from(r.stdout.replace(/\s+/g, ""), "base64"));
          }
          this.mirrors.set(rel, "here");
        } catch (e) {
          this.mirrors.set(rel, "failed");
          this.log(`${machine}:${path}: ${message(e)}`);
        }
      }
      this.debug.mark();
      cx.notify();
    });
  }

  // A file of this computer's (a pasted or dropped image) for a host on another machine: sent
  // beside the host's terminal there (hc put, at most 8 MB), and its path there.
  async putForHost(path) {
    const host = hostTerminal(this.chat);
    if (!host) throw new Error("the chat's host isn't running");
    const r = await hc(["put", host.address, path, "--json"]);
    if (r.code !== 0) throw new Error(`couldn't send the image to ${machineOf(host.address)}: ${(r.stderr || r.stdout).trim()}`);
    const landed = JSON.parse(r.stdout)?.path;
    if (!landed) throw new Error("hc put said nothing of where the image landed");
    return landed;
  }

  loadSizes(cx) {
    const want = [...this.svgWanted];
    this.svgWanted.clear();
    for (const p of want) this.svgSizes.set(p, null);
    cx.spawn(async (cx) => {
      for (const p of want) {
        try {
          // Another machine's file: its copy here.
          const rel = this.remoteMachine() ? this.imageRel(p) : null;
          const sz = await readSvgSize(rel ? `${appHome().replace(/\/+$/, "")}/${rel}` : p);
          if (sz) this.svgSizes.set(p, sz);
        } catch {}
      }
      cx.notify();
    });
  }

  // ---- find in the chat (find.js) ----------------------------------------------

  /** @param {import("gpui-kit").Context} cx */
  openFind(cx) {
    if (!this.find) this.find = new Find((cx) => this.findQuery(cx));
    this.find.focus();
    this.debug.mark();
    cx.notify();
  }

  /** @param {import("gpui-kit").Context} cx */
  closeFind(cx) {
    this.find = null;
    this.composer.focus();
    this.debug.mark();
    cx.notify();
  }

  /** @param {string} a @param {import("gpui-kit").Context} cx */
  findAction(a, cx) {
    const f = this.find;
    if (!f) return;
    if (a === "herdrchat_find_close") return this.closeFind(cx);
    if (f.step(a === "herdrchat_find_older" ? -1 : 1)) this.findGo(cx);
    cx.notify();
  }

  // The text changed: ask the host (a moment after the last key), and show the latest match.
  /** @param {import("gpui-kit").Context} cx */
  findQuery(cx) {
    const f = this.find;
    if (!f) return;
    const seq = ++f.seq;
    const q = f.query;
    f.busy = Boolean(q.trim());
    if (!q.trim()) { f.set([], 0, false); this.debug.mark(); cx.notify(); return; }
    cx.spawn(async (cx) => {
      await cx.sleep(150);
      if (this.find !== f || f.seq !== seq) return;
      let r;
      try {
        r = await this.req("search", { query: q }, cx);
      } catch {
        r = searchLoaded(this.store.items, q); // a host from before `search`: what's loaded here
      }
      if (this.find !== f || f.seq !== seq) return;
      f.set(r?.matches ?? [], r?.total ?? 0, Boolean(r?.capped));
      f.busy = false;
      this.findGo(cx);
      this.debug.mark();
      cx.notify();
    });
  }

  // Bring the current match into view: older history paged in until it's here,
  // the work group holding it opened, its row marked and scrolled to.
  /** @param {import("gpui-kit").Context} cx */
  findGo(cx) {
    const f = this.find;
    const m = f?.current;
    if (!f || !m) return;
    const seq = ++f.goSeq;
    cx.spawn(async (cx) => {
      while (!this.store.get(m.id) && this.store.hasOlder && this.store.items.length) {
        f.busy = true;
        cx.notify();
        try {
          const d = await this.req("history", { before: this.store.items[0].id, limit: 500 }, cx);
          this.timeline.prepended();
          this.store.prepend(d?.items ?? [], d?.hasOlder);
        } catch (e) {
          this.flash(`history: ${message(e)}`, cx);
          break;
        }
        if (this.find !== f || f.goSeq !== seq) return;
      }
      f.busy = false;
      /** @type {any[]} */
      const rows = buildRows(this.store.items, this.store.state);
      const r = rows.find((x) => x.id === m.id || (x.kind === "group" && x.items.some((/** @type {any} */ it) => it.id === m.id)));
      f.rowId = r?.id ?? null;
      if (r?.kind === "group" && !(this.groups.get(r.id) ?? defaultOpen(r))) this.groups.set(r.id, true);
      if (r) this.timeline.reveal(r.id);
      this.debug.mark();
      cx.notify();
    });
  }

  // A link in an answer: a file path (rich.js linkPaths) opens in an editor, as
  // a tool's path does, once it's there; any other link goes to the system.
  /** @param {string} url @param {import("gpui-kit").Context} cx */
  onLink(url, cx) {
    const bang = runLink(url);
    if (bang) return this.askRun([bang], cx);
    const f = fileLink(url);
    if (!f) return cx.open_url(url);
    this.openFile(f.path, f.line, cx, { mustExist: true });
  }

  // ---- `!` commands in answers (bang.js) -------------------------------------------

  // What the answers' run bars and links do: where a `!` command can run.
  // `here`: the agent's name when it can run there (the terminal view: the
  // TUI's shell command, Claude Code's bash mode), else null (a chat's own agent has no bash mode: a new tab only).
  bangTarget() {
    return { here: this.view ? this.providerName() : null, run: (/** @type {string[]} */ cmds, /** @type {string} */ where, /** @type {any} */ cx) => this.runBang(cmds, where, cx) };
  }

  // An inline `! command` was clicked: the card above the composer asks where to run it.
  /** @param {string[]} commands @param {any} cx */
  askRun(commands, cx) {
    this.runAsk = { commands, at: Date.now() };
    this.debug.mark();
    cx.notify();
  }

  // Runs `commands` (one run: in order, stopping at the first that fails) in the agent or a new tab.
  /** @param {string[]} commands @param {string} where "agent" | "tab" @param {any} cx */
  runBang(commands, where, cx) {
    this.runAsk = null;
    const name = this.providerName();
    if (where === "agent") {
      const line = bangLine(commands);
      if (!this.view || line === null) return;
      if (this.viewStatus === "working") return this.flash(`${name} is working: run it when it's done, or in a new tab`, cx);
      if (this.viewStatus === "blocked") return this.flash(`${name} is asking something: answer it first`, cx);
      this.lastRun = { where, commands, at: Date.now() };
      this.timeline.toBottom();
      // No bubble: the agent's own records show the run (a command card), once it's typed.
      this.fire("send", { text: `!${line}`, mode: "auto", echo: false }, cx);
      return;
    }
    const me = this.myPane();
    const space = me ? spaces().find((sp) => sp.tabs.some((tb) => tb.id === me.tab))?.id ?? null : null;
    const folder = this.cwd ?? this.store.state.cwd ?? null;
    this.lastRun = { where, commands, at: Date.now() };
    run("tab.new", { name: "run", ...(space ? { space } : {}), ...(folder ? { folder } : {}), argv: ["bash", "-c", tabScript(commands)] });
    cx.notify();
  }

  // The card for an inline `! command`: run it here or in a new tab (Esc or × closes it).
  /** @param {any} t */
  runCard(t) {
    const ask = this.runAsk;
    if (!ask) return null;
    const here = this.view ? this.providerName() : null;
    const line = bangLine(ask.commands);
    const btn = (/** @type {string} */ id, /** @type {string} */ label, /** @type {boolean} */ primary, /** @type {(cx: any) => void} */ fn) =>
      h_flex().id(id).h(28).px(12).items_center().rounded(7).cursor_pointer()
        .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
        .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
        .hover((s) => s.opacity(0.88)).on_click((_e, cx) => fn(cx)).child(label);
    return v_flex().gap(8).p(12).rounded(10).border_1().border_color(t.border).bg(t.popover)
      .child(h_flex().gap(8).items_center()
        .child(icon("terminal", 13).text_color(t.muted))
        .child(div().flex_1().min_w(0).text_size(13).font_semibold().child("Run this command?"))
        .child(div().id("run-cancel").cursor_pointer().text_size(11).text_color(t.dim).hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.runAsk = null; cx.notify(); }).child("Esc")))
      .child(div().px(10).py(6).rounded(7).bg(t.background).border_1().border_color(t.border).font_family(monoFont()).text_size(12.5)
        .child(`! ${line ?? ask.commands.join(" && ")}`))
      .child(h_flex().gap(8).flex_wrap()
        .when(Boolean(here) && line !== null, (e) => e.child(btn("run-ask-here", `Run in ${here}`, true, (cx) => this.runBang(ask.commands, "agent", cx))))
        .child(btn("run-ask-tab", "Run in a new tab", !here, (cx) => this.runBang(ask.commands, "tab", cx)))
        .child(btn("run-ask-copy", "Copy", false, (cx) => { this.copy("run-ask", line ?? ask.commands.join("\n"), cx); this.runAsk = null; })));
  }

  // A file a tool touched, in an editor (files.js). `mustExist`: a path an answer
  // named, checked first (in the chat's folder, on the space's machine).
  openFile(path, line, cx, { mustExist = false } = {}) {
    const me = this.myPane();
    const abs = path.startsWith("/") ? path : `${this.cwd ?? this.store.state.cwd}/${path}`;
    this.lastOpen = { path: abs, line, at: Date.now(), how: null };
    cx.spawn(async (cx) => {
      try {
        if (mustExist) {
          const machine = this.remoteMachine();
          const r = await exec("/bin/sh", ["-c", 'test -f "$1"', "sh", abs], machine ? { on: machine, timeout: 15000 } : { timeout: 15000 });
          if (r.code !== 0) {
            this.lastOpen.how = "missing";
            this.flash(`No file ${tildePath(abs)}`, cx);
            this.debug.mark();
            return;
          }
        }
        const r = await openFile({ path: abs, line, cwd: this.cwd ?? this.store.state.cwd, pane: me?.pane, tab: me?.tab, space: this.place?.space, machine: this.remoteMachine() });
        this.lastOpen.how = r.how;
        if (r.terminal) {
          this.editorTerm = { address: r.terminal, at: Date.now(), seen: false };
        }
      } catch (e) {
        this.lastOpen.how = "failed";
        this.flash(`open ${path}: ${message(e)}`, cx);
      }
      this.debug.mark();
      cx.notify();
    });
  }

  // Extension statuses: the non-empty ones, minus those hidden from the footer.
  visibleStatuses() {
    if (this.caps()?.extensionUi === false) return []; // this agent has no extension UI
    const hidden = new Set(this.prefs.hiddenStatuses);
    return this.store.state.statuses.map((x) => ({ key: x.key, spans: x.spans, text: spansText(x.spans).trim() }))
      .filter((x) => x.text && !hidden.has(x.key));
  }

  hiddenStatuses() {
    const hidden = new Set(this.prefs.hiddenStatuses);
    return this.store.state.statuses.filter((x) => hidden.has(x.key) && spansText(x.spans).trim());
  }

  widgetOpen(key) {
    return Boolean(this.prefs.widgetsOpen[key]);
  }

  // A background strip row opened or closed (chrome.js bgDetail): its detail is read now, then once a second.
  bgOpen(id, cx) {
    if (this.bgOpenId === id) {
      this.bgOpenId = null;
      this.bgDetail = null;
      return;
    }
    this.bgOpenId = id;
    this.bgDetail = null;
    this.bgFetch(cx);
  }

  // Not through req(): its answer is a command's output, kept out of the ops the debug dump shows.
  bgFetch(cx) {
    const id = this.bgOpenId;
    if (!id || this.bgFetching) return;
    this.bgFetching = true;
    cx.spawn(async (cx) => {
      try {
        const d = await this.conn.req("background_detail", { task: id });
        if (this.bgOpenId === id) this.bgDetail = d?.detail ?? { id, error: "It has ended" };
      } catch (e) {
        if (this.bgOpenId === id) this.bgDetail = { id, error: /Unknown op/.test(message(e)) ? "Restart the chat to see this" : message(e) };
      } finally {
        this.bgFetching = false;
      }
      cx.notify();
    });
  }

  bgStop(id, cx) {
    this.fire("background_stop", { task: id }, cx, (d, cx) => {
      this.flash(d?.stopped ? "Stopped" : "It had ended", cx);
      this.bgFetch(cx);
    });
  }

  more(id, cx) {
    this.fire("tool_output", { item: id }, cx, (d) => {
      this.full.set(id, d?.text ?? "");
      this.debug.mark();
    });
  }

  // The click handlers' code, by name (also `chat.click:<name>`).
  control(name, cx) {
    const what = name;
    const d = this.store.state.dialog;
    switch (what) {
      case "chip:model": return this.openModelPicker(cx);
      case "view:terminal": return this.showFace("terminal", cx);
      case "chip:thinking": return this.openThinkingPicker(cx);
      case "chip:permission": return this.openModePicker(cx);
      case "handoff:return": return this.returnToChat(cx);
      case "handoff:show": return this.showHandoff(cx);
      case "handoff:close": return this.closeTui(cx);
      case "handoff:cancel": this.confirmClose = null; break;
      case "conflict:go": return this.goToConflict(cx);
      case "conflict:take": return this.fire("take_over", {}, cx);
      case "statuses": return this.setStatusesOpen(!this.statusesOpen, cx);
      // The folder under the composer: its path copied.
      case "folder": {
        const path = this.store.state.cwd || this.cwd || "";
        if (!path) return;
        cx.write_to_clipboard(path);
        this.copied = path.length;
        this.lastCopy = { id: "folder", len: path.length, text: path };
        return this.flash(`Copied ${path.replace(this.homeDir, "~")}`, cx);
      }
      // The + menu: "@" or "/" typed where the text ends, which opens its menu; or the clipboard's image.
      case "plus:file":
      case "plus:command": {
        this.plusOpen = false;
        const v = this.composer.value, ch = what === "plus:file" ? "@" : "/";
        this.composer.set(v === "" ? ch : `${v}${/\s$/.test(v) ? "" : " "}${ch}`);
        this.composer.focus();
        this.updateMenu(cx);
        break;
      }
      case "plus:image":
        this.plusOpen = false;
        this.composer.focus();
        this.pasteImage(cx);
        break;
      // The mic: the desktop's dictation starts (or stops); it types into the composer, which has the keyboard.
      case "dictate": {
        this.composer.focus();
        const cmd = this.dictation;
        if (!cmd) return;
        cx.spawn(async (cx) => {
          await cx.sleep(0);
          let r;
          try { r = await exec(cmd, ["toggle"]); } catch (e) { r = { code: 1, stderr: message(e) }; }
          if (r.code !== 0) this.flash(`Dictation: ${String(r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n")[0]}`, cx);
        });
        break;
      }
      case "update:restart": this.updater.want(); break;
      case "branch": {
        const what = this.store.state.git?.name;
        if (!what) return;
        cx.write_to_clipboard(what);
        this.copied = what.length;
        this.lastCopy = { id: "branch", len: what.length, text: what };
        return this.flash(`Copied ${what}`, cx);
      }
      case "status:toggle-hidden": this.showHidden = !this.showHidden; break;
      case "plan": this.planOpen = !this.planOpen; break;
      case "background": this.bgClosed = !this.bgClosed; break;
      case "latest": this.timeline.toBottom(); break;
      case "send": return this.send(cx);
      case "peek:tab": return this.openAsTab(cx);
      case "peek:close": return this.closePeek();
      case "stop": return this.abort(cx);
      case "restart":
        if (this.conn.status === "stopped" || this.conn.status === "failed") { this.byeAt = null; this.conn.restart(); }
        else this.fire("resume", {}, cx);
        break;
      case "dialog:submit": return this.answer("submit", null, cx);
      case "dialog:cancel": return this.answer("cancel", null, cx);
      default:
        if (what.startsWith("bg:open:")) return this.bgOpen(what.slice(8), cx);
        if (what.startsWith("bg:stop:")) return this.bgStop(what.slice(8), cx);
        if (what.startsWith("bg:output:")) {
          const f = this.bgDetail?.id === what.slice(10) ? this.bgDetail.outputFile : null;
          if (f) this.openFile(f, undefined, cx, { mustExist: true });
          break;
        }
        if (what.startsWith("dialog:choice:")) {
          const ch = d?.choices?.find((x) => x.id === what.slice(14));
          if (ch) return this.answer("choice", this.dialog.choiceAnswer(ch), cx);
          break;
        }
        if (what.startsWith("dialog:reason:")) { this.dialog.field?.set_value?.(what.slice(14)); break; }
        if (what.startsWith("dialog:other:")) { // dialog:other:<question index>:<text>
          const [qi, ...rest] = what.slice(13).split(":");
          this.dialog.form?.setOther(Number(qi), rest.join(":"));
          break;
        }
        if (what.startsWith("picker:scope:")) return this.picker?.scope(Number(what.slice(13)), cx);
        if (what.startsWith("picker:")) return this.picker?.choose(Number(what.slice(7)), cx);
        if (what.startsWith("copy:")) {
          const it = this.store.get(what.slice(5));
          if (it) this.copy(`msg:${it.id}`, it.kind === "user" ? typedText(it) : it.text ?? "", cx);
          break;
        }
        if (what.startsWith("edit:")) {
          const it = this.store.get(what.slice(5));
          if (it) this.editResend(it, cx);
          break;
        }
        if (what.startsWith("enlarge:chip:")) {
          const ch = this.composer.chips[Number(what.slice(13))];
          if (ch) this.enlarge(ch.path, ch.size, cx);
          break;
        }
        if (what.startsWith("chip-x:")) {
          this.composer.removeChip(Number(what.slice(7)));
          break;
        }
        if (what.startsWith("enlarge:")) {
          const [, id, k] = what.split(":");
          const it = this.store.get(id);
          const svg = it?.blocks?.[Number(k)]?.svg;
          const img = svg ?? it?.images?.[Number(k)] ?? it?.imagePaths?.[Number(k)];
          if (img) this.enlarge(img, svg ? this.svgSize(svg) : it.imageSizes?.[Number(k)] ?? null, cx);
          break;
        }
        if (what.startsWith("open:")) {
          const it = this.store.get(what.slice(5));
          const d = it?.detail;
          if (d?.path) this.openFile(d.path, lineOf(d), cx);
          break;
        }
        if (what.startsWith("queue:")) {
          const [, op, id] = what.split(":");
          return this.queueRow(op, id, cx);
        }
        if (what.startsWith("widget:")) {
          const k = what.slice(7);
          this.prefs.widgetsOpen[k] = !this.prefs.widgetsOpen[k];
          savePrefs(this.prefs);
          break;
        }
        if (what.startsWith("status:hide:") || what.startsWith("status:show:")) {
          const k = what.slice(12);
          const set = new Set(this.prefs.hiddenStatuses);
          if (what.startsWith("status:hide:")) set.add(k); else set.delete(k);
          this.prefs.hiddenStatuses = [...set];
          savePrefs(this.prefs);
          break;
        }
        this.log(`unknown control ${name}`);
    }
    this.debug.mark();
    cx.notify();
  }

  commands(cx) {
    const queue = [];
    let wake = null;
    cx.spawn(async () => {
      for (;;) {
        queue.push(await nextCommand());
        if (wake) wake();
      }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        if (!queue.length) await new Promise((r) => (wake = r));
        wake = null;
        const c = queue.shift();
        try {
          this.command(c, cx);
        } catch (e) {
          this.log(`command ${c}: ${message(e)}`);
        }
        this.debug.mark();
        cx.notify();
      }
    });
  }

  command(c, cx) {
    this.log(`command ${c}`);
    // codesel:<block key>:<line>:<col>:<line>:<col>: select in a code block, as a drag does (E2E).
    if (c.startsWith("codesel:")) {
      const [r0, c0, r1, c1] = c.split(":").slice(-4).map(Number);
      const key = c.slice(8).split(":").slice(0, -4).join(":");
      const v = this.codeSel.get(key);
      if (v) { v.sel = { a: { r: r0, c: c0 }, b: { r: r1, c: c1 } }; v.focus?.focus(); cx.notify(this.codeViews.get(key)?.entity); }
      else this.log(`codesel: no code block ${key}`);
      return;
    }
    if (c === "focus") this.focusInput(); else if (c.startsWith("toggle:")) this.toggle(c.slice(7), cx);
    else if (c.startsWith("click:")) this.control(c.slice(6), cx);
    else if (c === "scroll:up") this.timeline.scrollBy(600);
    else if (c === "scroll:down") this.timeline.scrollBy(-600);
    else if (c.startsWith("key:")) this.action(`herdrchat_${c.slice(4)}`, cx);
    else if (c.startsWith("drop:")) this.drop(c.slice(5).split(","), cx);
    else if (c.startsWith("hover:")) this.setHover(c.slice(6) || this.hover, Boolean(c.slice(6)), cx);
    else if (c.startsWith("svghover:")) this.setSvgHover(c.slice(9) || this.svgHover, Boolean(c.slice(9)), cx);
    else if (c === "clear") this.composer.clear();
    else if (c.startsWith("wheel:")) this.wheel(Number(c.slice(6)), cx);
    else if (c === "outside") this.outside(cx);
    else if (c.startsWith("shortcut:")) this.shortcut(c.slice(9), cx);
    else if (c.startsWith("type:")) { this.composer.set(this.composer.value + c.slice(5)); this.updateMenu(cx); } // E2E: when the window drops keys
  }

  // ---- terminal hand-offs ----------------------------------------------------------

  showTranscript(cx) {
    // The host's pane is hidden (a zoom can't show it): a peek over the tab.
    const term = hostTerminal(this.chat);
    if (!term) return this.flash("The chat's host isn't running", cx);
    run("terminal.peek", { terminal: term.address });
    this.transcript = "peek";
    this.debug.mark();
    cx.notify();
  }

  // mode "session": the chat's session in the agent's TUI (op handoff → its
  // argv, then resume); "utility": a built-in's own argv (/login, /settings),
  // in the chat's folder, then resume. Either runs in a terminal with no pane,
  // shown in a dialog over the chat (openTermDialog): the chat stays where it
  // is, and the dialog closes when the terminal ends. `input`: typed into the
  // terminal once the agent is idle ("/login"), so the person lands on that screen.
  startHandoff(mode, name, cx, utilityArgv, input) {
    if (this.sub) return this.flash(`/${name} isn't available in a sub-agent's chat: its parent drives this session (/transcript shows the host's terminal)`, cx);
    if (this.handoff) return this.flash(`${this.providerName()}'s terminal is already open`, cx);
    this.handoff = { mode, name, terminal: null, at: Date.now(), overlay: null };
    this.debug.mark();
    cx.spawn(async (cx) => {
      try {
        // A chat in another machine's space: the TUI runs there, as its host does.
        const machine = this.place ? machineOf(this.place.pane) : null;
        const cfg = await readConfig(await hostSide(machine));
        // The TUI's command: the adapter's (e.g. `claude --resume <id>`). The
        // person's settings `<agent>.tui` replaces the program, keeping its arguments.
        const prog = cfg.agent(this.providerId()).tui;
        let argv;
        if (mode === "session") {
          const d = await this.req("handoff", {}, cx, { timeout: 20000 });
          if (!d?.argv?.length) throw new Error("this chat has no session yet");
          argv = prog ? withProgram(d.argv, prog) : [...d.argv];
        } else argv = prog ? withProgram(utilityArgv, prog) : [...utilityArgv];
        // No herdr.space/tab labels: no pane, so the layout and the chat's tab stay as they are.
        const r = await hc(["run", "--bg", "--json", "--no-parent", ...(machine ? ["--on", machine] : []), "--name", `chat-tui-${this.chat}`, "--cwd", this.cwd ?? this.store.state.cwd ?? "/",
          "--label", `herdr-chat.tui=${this.chat}`, "--", ...argv]);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
        this.handoff.terminal = JSON.parse(r.stdout).address;
        this.handoff.argv = argv;
        this.log(`handoff ${name}: ${argv.join(" ")} in ${this.handoff.terminal}`);
        this.openTermDialog();
        // The host owns the hand-off: it watches this terminal and resumes when it ends.
        // (Its address as the host's own core names it: "t7", not "box/t7".)
        if (mode === "session") this.req("handoff_started", { terminal: bare(this.handoff.terminal) }, cx)
          .then(() => { this.handoff && (this.handoff.reported = true); }, () => {});
        if (input) this.typeWhenIdle(this.handoff.terminal, input);
      } catch (e) {
        this.flash(`/${name}: ${message(e)}`, cx);
        const wasSession = this.handoff?.mode === "session"; // (a utility never stopped the agent)
        this.handoff = null;
        if (wasSession && this.store.state.phase === "handoff") this.fire("resume", {}, cx);
      }
      this.debug.mark();
      cx.notify();
    });
  }

  // The hand-off's terminal in a dialog over the window, under termbar.js's bar.
  openTermDialog() {
    const h = this.handoff ?? (this.store.state.handoff?.terminal ? { mode: "session", name: "tui", terminal: this.store.state.handoff.terminal } : null);
    if (!h?.terminal) return;
    const agent = this.providerName();
    const termbar = { terminal: h.terminal, mode: h.mode, provider: this.providerId(), agent,
      title: h.name === "tui" ? `${agent} · terminal UI` : `${agent} · /${h.name}` };
    h.overlay = openOverlay({ kind: "dialog", modal: true, width: 0.86, height: 0.86, layout: { type: "column", children: [
      { type: "block", size: { px: 40 }, content: { mod: MOD, props: { termbar } } },
      { type: "block", content: { terminal: h.terminal } },
    ] } });
    if (!this.handoff) this.handoff = { ...h, at: Date.now(), seen: true, reported: true };
  }

  // Types `text` into a terminal once its agent is idle (`hc wait`, then `hc send --if idle`).
  typeWhenIdle(terminal, text) {
    hc(["wait", terminal, "--timeout", "30", "--json"])
      .then(() => hc(["send", terminal, text, "--if", "idle", "--json"]))
      .then((r) => this.log(`typed ${text} into ${terminal}: ${(r?.stdout ?? "").trim()}`), (e) => this.log(`typing ${text} into ${terminal}: ${message(e)}`));
  }

  // A host that owns the hand-off (state.handoff) resumes by itself; an older one is asked to.
  hostOwnsHandoff() {
    return "handoff" in this.store.state;
  }

  finishHandoff(cx) {
    const h = this.handoff;
    this.handoff = null;
    this.confirmClose = null;
    if (h.overlay) closeOverlay(h.overlay);
    this.log(`handoff ${h.name} finished`);
    if (h.mode === "utility" || !this.hostOwnsHandoff() || !h.reported) this.fire("resume", {}, cx);
    const me = this.myPane();
    if (me) run("pane.focus", { pane: me.pane });
    this.refocus(cx);
    this.debug.mark();
  }

  // The banner's Show it: the hand-off's terminal in its dialog again (closed, or
  // gone with an app restart), else its tab when Open as tab gave it one.
  showHandoff(cx) {
    const term = this.handoff?.terminal ?? this.store.state.handoff?.terminal ?? null;
    if (!term) return;
    const pane = panes().find((p) => p.terminal === term);
    if (pane) run("pane.focus", { pane: pane.pane });
    else this.openTermDialog();
    this.debug.mark();
    cx.notify();
  }

  // The banner's Return to chat: a TUI still running is closed first, after a confirm.
  returnToChat(cx) {
    const term = this.store.state.handoff?.terminal ?? this.handoff?.terminal ?? null;
    const live = term && terminals().some((t) => t.address === term && t.state === "live");
    if (live) {
      this.confirmClose = Date.now();
      this.debug.mark();
      cx.notify();
      return;
    }
    this.closeTui(cx);
  }

  closeTui(cx) {
    const term = this.store.state.handoff?.terminal ?? this.handoff?.terminal ?? null;
    this.confirmClose = null;
    if (term) run("terminal.kill", { terminal: term });
    if (this.handoff?.overlay) closeOverlay(this.handoff.overlay);
    this.log(`return to chat${term ? `: closed ${term}` : ""}`);
    this.handoff = null;
    this.fire("resume", {}, cx);
    const me = this.myPane();
    if (me) run("pane.focus", { pane: me.pane });
    this.refocus(cx);
    this.debug.mark();
    cx.notify();
  }

  // The conflict banner's Go to that chat: its own pane (the layout document), else its host's terminal.
  goToConflict(cx) {
    const c = this.store.state.conflict;
    if (!c) return;
    cx.spawn(async (cx) => {
      try {
        this.docPanes = modPanes(await readDoc(), MOD);
      } catch {}
      const other = this.docPanes?.find((x) => x.props?.chat === c.chat && panes().some((p) => p.pane === x.pane));
      this.lastGo = other ? { pane: other.pane } : { terminal: c.terminal ?? null };
      if (other) {
        run("tab.select", { id: other.tab });
        run("pane.focus", { pane: other.pane });
      } else if (c.terminal) run("agent.focus", { terminal: c.terminal });
      else this.flash("The other chat isn't open in this window", cx);
      this.debug.mark();
      cx.notify();
    });
  }

  close() {
    if (this.viewer || this.termbar) return;
    owners.delete(this.uid);
    // A sub-agent's host is its parent's: closing its peek or its tab leaves it running.
    if (this.sub || hostTerminal(this.chat)?.parent) {
      this.conn?.close();
      return;
    }
    // The chat's pane closed alone leaves the host's hidden pane, a tab that
    // shows nothing. The host watches for that itself (host/panewatch.ts): it
    // closes its pane, and the tab with it.
    this.conn?.close();
  }

  // ---- a sub-agent's chat ----------------------------------------------------------

  subTerm() {
    return this.sub ? terminals().find((t) => t.address === this.sub) ?? null : null;
  }

  subStatus() {
    return agents().find((a) => a.address === this.sub)?.status ?? this.subTerm()?.status ?? null;
  }

  subKey() {
    const k = this.subTerm();
    return `${k?.state}:${this.subStatus()}:${k?.name}:${k?.parent}`;
  }

  closePeek() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Open as tab: the chat in a tab of the parent's space (the one already open, if any). The host
  // stays paneless, under its parent: a tab closed (which ends its panes' terminals) leaves it running.
  openAsTab(cx) {
    const k = this.subTerm();
    const all = terminals();
    const parent = k?.parent ? all.find((t) => t.address === k.parent) : null;
    const pm = machineOf(parent?.address);
    const tabOf = (addr) => qualify(pm, parent?.labels?.["herdr.tab"]) ?? panes().find((p) => p.terminal === addr)?.tab ?? null;
    const ptab = parent ? tabOf(parent.address) : null;
    const space = qualify(pm, parent?.labels?.["herdr.space"]) ?? spaces().find((sp) => sp.tabs.some((x) => x.id === ptab))?.id ?? focused()?.space ?? null;
    const name = k?.name || this.displayName();
    const provider = this.store.state.provider ?? this.conn.provider ?? this.provider ?? null;
    cx.spawn(async (cx) => {
      let open = null;
      try {
        open = modPanes(await readDoc(), MOD).find((x) => x.props?.chat === this.chat && x.props?.subagent && panes().some((p) => p.pane === x.pane));
      } catch {}
      if (open) {
        run("tab.select", { id: open.tab });
        run("pane.focus", { pane: open.pane });
      } else {
        run("tab.new", { name: name.length > 32 ? name.slice(0, 31) + "…" : name, ...(space ? { space } : {}), mod: MOD,
          props: { chat: this.chat, subagent: this.sub, ...(provider ? { provider } : {}), ...(this.cwd ? { cwd: this.cwd } : {}) } });
      }
      this.openedTab = { at: Date.now(), space, existing: open?.tab ?? null };
      this.log(`open as tab: ${open ? `tab ${open.tab} already has it` : `new tab in ${space ?? "the focused space"}`}`);
      this.closePeek();
      this.debug.mark();
      cx.notify();
    });
  }

  // The bar on top of a sub-agent's chat, as the peek mod draws it: who, how it's doing, from whom.
  subBar(t) {
    const k = this.subTerm();
    const st = this.subStatus();
    const parent = k?.parent ? terminals().find((p) => p.address === k.parent) : null;
    const words = { working: "working", blocked: "needs you", done: "finished", idle: "idle", error: "error" };
    const color = st === "error" ? t.ansi1 : t[st] ?? t.dim;
    const button = (id, label, what) => div().id(id).flex_none().px(8).py(2).rounded(5).text_color(t.muted).cursor_pointer()
      .hover((x) => x.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.control(what, cx)).child(label);
    const ended = k?.state !== "live";
    return h_flex().id("sub-bar").flex_none().h(34).w_full().px(12).gap(8).items_center().bg(t.surface).border_b_1().border_color(t.border).text_size(12)
      .child(st === "working" && !ended ? spinner(11) : div().w(12).flex_none().text_color(color).child(ended ? "·" : st === "idle" ? "○" : "●"))
      .child(div().truncate().font_semibold().text_color(t.foreground).child(k?.name || k?.template || this.displayName()))
      .child(div().flex_none().text_color(ended ? t.dim : color).child(ended ? "ended" : words[st] ?? st ?? ""))
      .when(Boolean(parent), (e) => e.child(div().truncate().text_color(t.dim).child(`from ${parent.name || parent.address}`)))
      .child(div().flex_1())
      .when(this.peekMode && !ended, (e) => e.child(button("sub-tab", "↗ Open as tab", "peek:tab")))
      .when(this.peekMode, (e) => e.child(button("sub-close", "✕", "peek:close")));
  }

  // ---- what the E2E reads -------------------------------------------------------

  dump() {
    const s = this.store.state;
    const host = hostTerminal(this.chat);
    const me = this.myPane();
    const m = this.composer.menu;
    // Built here too, not taken from the last render: a window that isn't drawn (locked screen) doesn't render.
    const rows = buildRows(this.store.items, s);
    const group = (r) => {
      const open = this.groups.get(r.id) ?? defaultOpen(r);
      return { items: r.items.map((x) => x.id), open, cards: groupCards(r, open, rows.children).map((x) => x.id) };
    };
    return {
      chat: this.chat, cwd: this.cwd, props: props(), renders: this.renders ?? 0,
      sub: this.sub, peekMode: this.peekMode, subStatus: this.sub ? this.subStatus() : null, subState: this.subTerm()?.state ?? null, openedTab: this.openedTab ?? null,
      connection: { status: this.conn.status, error: this.conn.error, connects: this.conn.connects, autoStart: this.conn.autoStart, link: this.conn.link?.kind ?? null },
      seq: this.store.seq, snapshots: this.store.snapshots,
      provider: s.provider ?? this.conn.provider ?? this.provider ?? null, providerName: this.providerName(),
      capabilities: s.capabilities ?? null, permissionMode: s.permissionMode ?? null,
      phase: s.phase, error: s.error, model: s.model ? `${s.model.provider}/${s.model.id}` : null, thinking: s.thinking,
      sessionFile: s.sessionFile, sessionName: s.sessionName, usage: s.usage, queue: s.queue,
      plan: s.plan?.steps?.length ? { ...planProgress(s.plan), steps: s.plan.steps.map((x) => [x.text, x.status]), open: Boolean(this.planOpen) } : null,
      background: s.background ? { rows: (this.bgShown ?? []).map((r) => [r.kind, r.name, r.state, r.meta]), shells: s.background.shells, monitors: s.background.monitors, open: !this.bgClosed,
        opened: this.bgOpenId ?? null, detail: this.bgDetail ? { kind: this.bgDetail.kind ?? null, state: this.bgDetail.state ?? null, lines: bgDetailLines(this.bgDetail).length, stoppable: Boolean(this.bgDetail.stoppable), error: this.bgDetail.error ?? null } : null } : null,
      dialog: s.dialog ? { id: s.dialog.id, method: s.dialog.method, title: s.dialog.title, value: this.dialog.field ? this.dialog.value() : null,
        ...this.dialog.form?.debugState() } : null,
      statuses: s.statuses.map((x) => ({ key: x.key, text: x.spans.map((y) => y.text).join("") })),
      widgets: s.widgets.map((w) => w.key), commands: s.commands.length, commandNames: s.commands.map((c) => c.name),
      items: this.store.items.map((it) => ({ id: it.id, kind: it.kind, ...(it.parent ? { parent: it.parent } : {}), ...(it.status ? { status: it.status } : {}), ...(it.streaming ? { streaming: true } : {}),
        ...(it.detail?.type === "agent" ? { live: cardLive(it, rows.children).map((x) => x.id) } : {}),
        ...(it.kind === "user" ? { text: it.text.slice(0, 200), source: it.source, from: it.from ?? null, skill: it.skill?.name ?? null } : {}),
        ...(it.kind === "tool" ? { name: it.name, title: it.title, images: it.images ?? [] } : {}),
        ...(it.kind === "assistant" ? { len: it.text.length, stopReason: it.stopReason ?? null } : {}),
        ...(it.kind === "notice" ? { level: it.level, text: (it.text ?? "").slice(0, 200), source: it.source ?? null } : {}) })),
      hasOlder: this.store.hasOlder,
      expanded: [...this.expanded], full: [...this.full.keys()],
      sticky: this.timeline.sticky, top: Math.round(this.timeline.top), viewH: this.timeline.viewH, scale: this.timeline.scale, shown: this.timeline.shown,
      composer: { text: this.composer.value, pills: this.composer.tokens().map((x) => ({ ...x.range, id: x.token.id, label: x.token.label ?? null })), cursor: this.composer.cursor, message: this.composer.message(), chips: this.composer.chips.map((c) => c.path), pending: this.composer.chips.filter((c) => c.pending).length, chipImages: this.composer.chips.map((c) => homeRel(c.path, appHome())), chipSizes: this.composer.chips.map((c) => c.size), focused: this.composer.focused, context: this.composer.context(), history: this.composer.history ? this.composer.history.i : null },
      menu: m ? { kind: m.kind, query: m.query, start: m.start ?? null, sel: m.sel, top: m.top ?? 0, wheeled: m.wheeled ?? 0, count: m.items.length,
        items: m.items.slice(0, 12).map((x) => (typeof x === "string" ? x : x.name)) } : null,
      picker: this.picker ? pickerDump(this.picker) : null,
      closedBy: this.closedBy ?? null, footerTier: this.footerTier ?? null, footerStatuses: this.footerStatuses ?? null, bottomH: this.bottomH ?? null, queueLabels: queueLabels(s).map((x) => x[0]), byeAt: this.byeAt ?? null,
      handoff: this.handoff, transcript: this.transcript, hostHandoff: s.handoff ?? null, conflict: s.conflict ?? null,
      confirmClose: Boolean(this.confirmClose), lastGo: this.lastGo ?? null,
      placeFrom: this.placeFrom, placeError: this.placeError ?? null, healed: this.healed ?? 0,
      hostHidden: this.hide?.hidden ?? null, hostNodePane: this.hide?.pane ?? null, hostNodeTab: this.hide?.tab ?? null, hideWrites: this.hide?.writes.length ?? 0, hideWaits: this.hide?.waits ?? 0, hidePhased: this.phased ?? 0, hideUnphased: this.unphased ?? 0,
      hideError: this.hide?.error ?? null, widths: this.widths ?? [],
      hostAgent: ((a) => (a ? { pane: a.pane, tab: a.tab, status: a.status } : null))(host && agents().find((x) => x.address === host.address)),
      windowActive: Boolean(appWindow()?.active), tabStatus: spaces().flatMap((sp) => sp.tabs).find((x) => x.id === me?.tab)?.status ?? null, fallback: this.fallback, redirects: this.redirects ?? 0, redirectsFromRender: this.redirectsFromRender ?? 0, seenSent: this.seenSent ?? null,
      hostTab: qualify(machineOf(host?.address), host?.labels?.["herdr.tab"]) ?? null, tabPanes: panes().filter((p) => p.tab === me?.tab).map((p) => ({ pane: p.pane, terminal: p.terminal, mod: p.mod ?? null })),
      shortcuts: this.keysReady ? shortcuts() : null, keyErrors: keyErrors, lastShortcut: this.lastShortcut ?? null, lastNewChat: this.lastNewChat ?? null,
      reports: this.store.items.filter((it) => it.kind === "user" && isReport(it)).map((it) => it.id),
      place: this.place, zoomed: me?.zoomed ?? null, zoomedPane: panes().find((p) => p.tab === me?.tab && p.zoomed)?.pane ?? null, paneTitle: me?.title ?? null, name: this.displayName(),
      tabName: spaces().flatMap((sp) => sp.tabs).find((x) => x.id === me?.tab)?.name ?? null, host: host ? { address: host.address, status: host.status } : null,
      hostPane: this.hostPane()?.pane ?? null, focusedPane: focused()?.pane ?? null,
      flash: this.flashText?.text ?? null, lastSend: this.lastSend ?? null, lastAnswer: this.lastAnswer ?? null, copied: this.copied ?? null,
      ops: this.ops.slice(-20).map((o) => ({ op: o.op, ok: o.ok, error: o.error, data: o.op === "send" || o.op === "abort" || o.op === "handoff" ? o.data : undefined })),
      log: this.logLines.slice(-30),
      // v2 view state
      width: this.width, colW: this.colW(), empty: this.isEmpty(),
      rows: space(rows).map((r) => ({ id: r.id, kind: r.kind, gap: r.gap, slot: r.slot, ...(r.kind === "group" ? group(r) : {}),
        ...(r.footer ? { footer: r.footer } : {}), ...(r.kind === "item" ? { item: r.item.kind } : {}) })),
      activity: this.activity(), lastCopy: this.lastCopy ?? null,
      codeBlocks: [...this.codeSel].map(([key, v]) => ({ key, linesW: Math.round(v.linesW), viewW: Math.round(v.viewW), sel: v.sel, focused: Boolean(v.focus?.is_focused?.()) })), lastOpen: this.lastOpen ?? null, editorTerm: this.editorTerm ?? null, lastQuote: this.lastQuote ?? null,
      find: this.find ? { query: this.find.query, matches: this.find.matches.length, total: this.find.total, cur: this.find.cur, current: this.find.current?.id ?? null, rowId: this.find.rowId, busy: this.find.busy, label: this.find.label() } : null,
      statusesShown: this.visibleStatuses().map((x) => x.key), statusesHidden: this.prefs.hiddenStatuses, footerChips: this.footerChips ?? null, branch: this.branchShown ?? null, plusOpen: Boolean(this.plusOpen), dictation: this.dictation ?? null,
      update: { ...this.updater.dump(this.conn.welcome), healing: this.healing ?? null },
      widgetsOpen: this.prefs.widgetsOpen, themeSent: Boolean(this.themeSent), themeOk: this.themeOk ?? null,
      enlarged: this.enlarged ?? null, svgHover: this.svgHover ?? null, svgSizes: Object.fromEntries(this.svgSizes),
      heightsSeen: this.timeline.heightsSeen?.dump() ?? null, thumbsSeen: this.thumbsSeen?.dump() ?? null,
      blocks: this.store.items.filter((it) => it.kind === "assistant" && it.blocks?.length).map((it) => ({ id: it.id, types: it.blocks.map((b) => b.type + (b.open ? "*" : "")) })),
      renderError: this.renderError ?? null,
      perf: this.perf ? { renders: this.perf.n, avgMs: +(this.perf.total / this.perf.n).toFixed(2), maxMs: this.perf.max } : null,
      settings: { font_family: settings()?.font_family ?? null, font: settings()?.font ?? null, dark: settings()?.dark ?? null },
    };
  }

  // ---- view -------------------------------------------------------------------------

  banner(t) {
    const c = this.conn;
    const s = this.store.state;
    // buttons: [[id, label, control]] (the first is the main one)
    const row = (color, iconEl, text, buttons = []) => h_flex().w_full().px(12).py(8).gap(10).items_center().rounded(10).border_1()
      .border_color(alpha(color, 0.35)).bg(alpha(color, 0.08)).text_size(12.5).text_color(t.foreground)
      .child(iconEl.text_color(color)).child(div().flex_1().min_w(0).child(text))
      .children(buttons.map(([id, label, what], i) => h_flex().id(id).flex_none().h(26).px(10).items_center().rounded(6).cursor_pointer()
        .bg(i === 0 ? t.solid : t.raised).text_color(i === 0 ? t.solid_foreground : t.foreground)
        .border_1().border_color(i === 0 ? t.solid : t.input).text_size(12).hover((x) => x.opacity(0.85))
        .on_click((_e, cx) => this.control(what, cx)).child(label)));
    const restart = (label) => [["banner-btn", label, "restart"]];
    if (this.sub && (c.status === "stopped" || c.status === "failed")) return row(t.muted, icon("info", 13), "The sub-agent ended. Its parent started it and ends it; the session is kept.");
    if (c.status === "stopped" && this.byeAt) return row(t.muted, icon("info", 13), "This chat was closed: its session moved to another chat (Take over there).", restart("Reopen here"));
    if (c.status === "stopped") return row(t.blocked, icon("alert", 13), "The chat's host stopped. The session is kept.", restart("Restart"));
    if (c.status === "failed") return row(t.ansi1, icon("alert", 13), c.error ?? "Couldn't start the host", restart("Retry"));
    if (c.status === "starting") return row(t.muted, spinner(12), `Starting ${this.providerName()}…`);
    if (c.status === "connecting" && !this.store.loaded) return row(t.muted, spinner(12), c.error ? `Connecting… (${c.error})` : "Connecting…");
    if (c.status === "reconnecting" || c.status === "connecting") return row(t.blocked, spinner(12), "Reconnecting…");
    if (s.phase === "exited" || s.phase === "error") return row(t.ansi1, icon("alert", 13), s.error ?? `${this.providerName()} exited`, restart(`Restart ${this.providerName()}`));
    if (s.phase === "handoff") {
      if (this.confirmClose) return row(t.blocked, icon("terminal", 13), `Close ${this.providerName()}'s terminal UI? What it's doing there stops.`,
        [["handoff-close", "Close it", "handoff:close"], ["handoff-cancel", "Cancel", "handoff:cancel"]]);
      return row(t.muted, icon("terminal", 13), `${this.providerName()} is open in its terminal UI. Quit it there, or come back here.`,
        [["handoff-show", "Show it", "handoff:show"], ["handoff-return", "Return to chat", "handoff:return"]]);
    }
    if (s.phase === "conflict") {
      const k = s.conflict ?? {};
      const where = k.chat ? "another chat" : `another ${this.providerName()}${k.pid ? ` (pid ${k.pid})` : ""}`;
      if (!k.chat) return row(t.blocked, icon("alert", 13), `This session is open in ${where}. Quit it there, then check again.`,
        [["conflict-again", "Check again", "restart"]]);
      return row(t.blocked, icon("alert", 13), `This session is open in ${where}. Two writers would corrupt it.`,
        [["conflict-go", "Go to that chat", "conflict:go"], ["conflict-take", "Take over", "conflict:take"]]);
    }
    const u = this.updater.bar(c.welcome, this.providerName());
    if (u) return row(t.muted, icon("rotate", 13), u.text, u.button ? [["update-restart", "Restart", "update:restart"]] : []);
    return null;
  }

  // A new chat: nothing said yet (startup notices don't count).
  isEmpty() {
    return this.store.loaded && !this.store.hasOlder && !this.store.items.some((it) => it.kind !== "notice") && !this.store.working();
  }

  // What the activity line says while Pi works or waits.
  activity() {
    const s = this.store.state;
    if (s.dialog) return { text: "Waiting for you", waiting: true, since: null };
    if (s.phase === "compacting") return { text: "Compacting…", since: null };
    if (s.phase !== "working") return null;
    const items = this.store.items;
    for (let i = items.length - 1; i >= 0 && i >= items.length - 40; i--) {
      const it = items[i];
      if (it.kind === "tool" && (it.status === "running" || it.status === "pending")) {
        // Code Mode: a Poll says what it waits for ("Waiting for #12 Run the tests"), a script its description.
        if (it.name === "Poll" && it.title) return { text: it.title, since: it.ts };
        if (it.name === "REPL" && it.title && it.title !== "REPL") return { text: `Running ${it.title}`, since: it.ts };
        return { text: `Running ${it.name}`, since: it.ts };
      }
      // Its row counts the seconds, or the live row of the folded card it's in (rows.js liveSteps).
      if (it.kind === "thinking" && it.streaming) return { text: "Working", since: null };
      if (it.kind === "assistant" && it.streaming) return { text: it.text ? "Writing" : "Working", since: null };
      if (it.kind === "user") break;
    }
    return { text: "Working", since: null };
  }

  // The one column everything shares: ≤ 800 px, centered, 24 px padding (12 below 600 px).
  column(el) {
    return div().w_full().flex().justify_center().child(el.w_full().max_w(COL_MAX).px(this.pad()));
  }

  // The widths the chat was laid out at, newest last (the E2E counts a split's reflows).
  sized(w) {
    (this.widths ??= []).push(Math.round(w));
    if (this.widths.length > 16) this.widths.shift();
    this.debug.mark();
  }

  pad() {
    return this.width && this.width < 600 ? 12 : 24;
  }

  colW() {
    return Math.min(COL_MAX, this.width || COL_MAX) - 2 * this.pad();
  }

  ctx(t) {
    return {
      t, mono: monoFont(), expanded: this.expanded, full: this.full, cwd: this.cwd, colW: this.colW(), now: Date.now(),
      codeBg: t.background, line: alpha(t.border, 0.7), hover: this.hover, activity: this.activity(),
      codeView: (key) => this.codeViews.get(key)?.entity ?? null,
      toggle: (id, cx) => this.toggle(id, cx), more: (id, cx) => this.more(id, cx),
      copy: (id, text, cx) => this.copy(id, text, cx), copied: (id) => this.copiedAt.has(id),
      enlarge: (p, size, cx) => this.enlarge(p, size, cx), svgSize: (p) => this.svgSize(p), traceThumb: (p, w, h) => this.thumbsSeen?.add(p, w, h),
      imageRel: (p) => this.imageRel(p), imagePending: (p) => this.imagePending(p),
      quote: (/** @type {any} */ it, /** @type {import("gpui-kit").Context} */ cx) => this.quote(it, cx),
      runBang: this.sub ? null : this.bangTarget(),
      openFile: (p, line, cx) => this.openFile(p, line, cx), onLink: (/** @type {string} */ url, /** @type {import("gpui-kit").Context} */ cx) => this.onLink(url, cx), editResend: (it, cx) => this.editResend(it, cx),
      setHover: (id, on, cx) => this.setHover(id, on, cx), svgHover: this.svgHover ?? null, findItem: this.find?.current?.id ?? null,
      setSvgHover: (key, on, cx) => this.setSvgHover(key, on, cx), groupOpen: (id) => this.groups.get(id),
      groupAnim: (id) => this.groupAnims.get(id) ?? null, groupMeasured: (id, h, cx) => this.groupMeasured(id, h, cx),
      modelName: (m) => this.modelName(m), showCost: this.caps()?.cost !== false,
      children: this.children, color: (fg) => (fg?.startsWith("#") ? fg : theme()[fg] ?? null),
    };
  }

  modelName(m) {
    const s = this.store.state.model;
    if (s && (`${s.provider}/${s.id}` === m || s.id === m)) return s.name || s.id;
    // An alias resolved by the agent ("haiku" → "claude-haiku-5-5"): the current model's name.
    if (s?.id && s.name && String(m).toLowerCase().includes(String(s.id).toLowerCase())) return s.name;
    const known = this.modelNames?.get(m);
    return known ?? String(m).split("/").pop();
  }

  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    if (this.termbar) return this.termbar.render(cx);
    // The host's hidden pane took the focus (agent.focus, the agents list, cmd-]): a
    // focus change re-renders, so give it back now, not on the next tick.
    const fp = focused()?.pane;
    if (fp && fp === this.hide?.pane && !this.handoff) cx.spawn(async (cx) => { await cx.sleep(1); if (this.redirectFocus(cx)) { this.redirectsFromRender = (this.redirectsFromRender ?? 0) + 1; this.debug.mark(); cx.notify(); } });
    const t0 = Date.now();
    let el;
    try {
      el = this.renderChat(cx);
    } catch (e) {
      // A render that throws keeps the last frame: say why in the dump (and on screen).
      this.renderError = `${message(e)} ${String(e?.stack ?? "").split("\n").slice(0, 4).join(" | ")}`;
      this.debug.mark();
      return div().p(16).text_color(theme().ansi1).child(`render failed: ${this.renderError}`);
    }
    this.renderError = null;
    const ms = Date.now() - t0;
    const p = (this.perf ??= { n: 0, total: 0, max: 0 });
    p.n++; p.total += ms; p.max = Math.max(p.max, ms);
    return el;
  }

  renderChat(cx) {
    this.renders = (this.renders ?? 0) + 1;
    const t = theme();
    const s = this.store.state;
    const rows = (this.rows = space(buildRows(this.store.items, s)));
    this.children = rows.children;
    const c = this.ctx(t);
    const empty = this.isEmpty();
    const banner = this.banner(t);
    const widgets = s.capabilities?.extensionUi === false ? [] : s.widgets;
    const above = widgets.filter((w) => w.placement !== "belowEditor");
    const below = widgets.filter((w) => w.placement === "belowEditor");
    // The open menu or picker: an overlay above the composer (a Popup anchored to it,
    // painted over the timeline), never in the flow.
    const menu = this.picker ? this.picker.view(t, (a, cx) => this.action(a, cx), { onOutside: (cx) => this.outside(cx) })
      : menuView(this.composer.menu, t, { onPick: (i, cx) => this.pickMenu(i, cx), onWheel: (dy, cx) => this.wheel(dy, cx),
        onOutside: (cx) => this.outside(cx), keys: (name) => this.slashKey(name) });
    const working = this.store.working();
    const keyName = (a, plain) => { const k = keyHint(a); return k === "↩" ? plain : k; };
    const sendKey = keyName("steer", "Enter");
    const followKey = keyName("followUp", null);
    const hintText = this.flashText?.text ?? (s.dialog ? (s.dialog.method === "permission" ? "Answer above · Esc denies" : "Answer above · Esc cancels") : working
      ? [sendKey && `${sendKey} ${s.capabilities?.steer === false ? "queues" : "steers"}`, followKey && `${followKey} after this run`, "Esc stops"].filter(Boolean).join(" · ")
      : this.peekMode && this.composer.focused && !this.composer.value ? "Esc closes" : null);
    const composer = Popup.new("composer-anchor", this.composer.view(t, { ...c, working, plus: plusButton(this, t), mic: micButton(this, t),
      hint: hintText, hintColor: this.flashText ? t.blocked : t.dim, action: (a, cx) => this.action(a, cx) }))
      .anchor("bottom_left").w_full()
      .when(Boolean(menu), (e) => e.content(div().w(this.colW()).pb(8).child(menu)));
    // Its height is in the dump: an open menu must not change it (an overlay, not the flow).
    const bottom = v_flex().id("chat-bottom").w_full().gap(8)
      .on_size_change((sz, cx) => { if (sz.height !== this.bottomH) { this.bottomH = sz.height; this.debug.mark(); } })
      .when(Boolean(s.dialog), (e) => e.child(this.dialog.view(s.dialog, s.dialogsPending, t, (k, v, cx) => this.answer(k, v, cx), c)))
      .when(Boolean(this.runAsk) && !s.dialog, (e) => e.child(this.runCard(t)))
      .children([widgetTray(this, above, t), backgroundStrip(this, s, t), queueChips(this, s, t), planStrip(this, s, t)].filter(Boolean))
      .child(composer)
      .children([widgetTray(this, below, t)].filter(Boolean))
      // Under the card, as the Claude app has it: the folder and its branch; the model, its effort and the mode.
      .child(div().px(4).child(underRow(this, t, { width: this.colW() - 8 })));
    // The terminal view's own Chat | Terminal pill, unless the top bar has the switch: at the top right, or in a slim row.
    const pill = Boolean(this.view) && !this.sub && !this.barSwitch();
    const floats = pill && this.viewFloats();
    let root = v_flex().id("herdr-chat").key_context("HerdrChat").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .on_size_change((sz, cx) => {
        if (Math.abs(sz.width - this.width) > 0.5) { this.width = sz.width; this.sized(sz.width); cx.notify(); }
        // A hidden pane gets no room: shown or hidden, by this app's flip or another's, the face is read again now.
        if (this.view) { this.faceReadAt = 0; this.faceAgain = this.faceReading; }
      })
      .on_drop((e, cx) => this.drop(e.paths ?? [], cx))
      .children(this.sub ? [this.subBar(t)] : pill && !floats ? [h_flex().flex_none().w_full().justify_end().pt(4).px(10).child(this.viewBar(t))] : [])
      .children(banner ? [div().flex_none().pt(10).child(this.column(div().child(banner)))] : []);
    for (const a of Object.keys(SHORTCUTS)) root = root.on_action(actionName(a), (_e, cx) => this.shortcut(a, cx));

    if (empty) {
      // Startup notices (an extension's warning) don't end the empty state: they show under it.
      const notes = rows.filter((r) => r.kind === "item" && r.item.kind === "notice").slice(-3);
      return this.hud(root.child(v_flex().flex_1().min_h(0).justify_center().pb(40)
        .child(this.column(v_flex().gap(18).child(emptyState(this, t)).child(bottom)
          .when(notes.length > 0, (e) => e.child(v_flex().gap(2).children(notes.map((r) => row(r, c)))))))), t, floats);
    }
    // Find's match: its row, or in a work group, its own step (cards.js, c.findItem).
    const mark = this.find?.rowId?.startsWith("g-") ? null : this.find?.rowId ?? null;
    const timeline = this.timeline.view(rows, (r) => this.column(r.id === mark ? findMark(row(r, c), t) : row(r, c)), {
      onNearTop: () => this.wantOlder(),
      thumb: alpha(t.muted, 0.35),
    });
    return this.hud(root
      // Find's bar: a strip above the timeline (never over a message), at the column's right.
      .when(Boolean(this.find), (e) => e.child(div().flex_none().pt(8).pb(4)
        .child(this.column(h_flex().justify_end().child(this.find?.view(t, (a, cx) => this.findAction(a, cx)))))))
      .child(div().relative().flex_1().min_h(0).flex().flex_col()
        .child(timeline)
        // Scrolled up: a band of background at the bottom edge, so ↓ Latest sits on it, never on text.
        .when(!this.timeline.sticky, (e) => e.child(div().absolute().bottom(0).left(0).right(0).h(16).bg(alpha(t.background, 0.92)))))
      // ↓ Latest sits on the timeline's bottom edge, over the gap above the composer, not the text.
      // pt: room between the last output and the composer (feedback row 5)
      .child(div().relative().flex_none().pt(20).pb(6).child(this.column(bottom))
        .when(!this.timeline.sticky, (e) => e.child(div().absolute().top(-14).left(0).right(0).flex().justify_center()
          .child(h_flex().id("latest").h(26).px(11).gap(6).items_center()
            .rounded(13).bg(t.popover).border_1().border_color(t.input).text_size(12).text_color(t.foreground).cursor_pointer().shadow_md()
            .hover((x) => x.bg(t.hover)).on_click((_e, cx) => this.control("latest", cx))
            .child(icon("arrow-down", 12)).child("Latest"))))), t, floats);
  }

  // The terminal view's floating switch and the FPS HUD (debug/fps): on top
  // of the chat, last children of the root.
  hud(el, t, floats = false) {
    if (floats) el = el.relative().child(div().absolute().top(8).right(14).child(this.viewBar(t)));
    return this.debug?.fps ? el.relative().child(fps_monitor()) : el;
  }

  // From render: only notice; tick() fetches.
  wantOlder() {
    if (this.store.hasOlder && !this.loadingOlder && this.store.items.length) this.olderWanted = true;
  }

  fetchOlder(cx) {
    this.olderWanted = false;
    this.loadingOlder = true;
    const before = this.store.items[0]?.id;
    cx.spawn(async (cx) => {
      try {
        const d = await this.req("history", { before, limit: 100 }, cx);
        const older = d?.items ?? [];
        this.timeline.prepended();
        this.store.prepend(older, d?.hasOlder);
      } catch (e) {
        this.flash(`history: ${message(e)}`, cx);
      } finally {
        this.loadingOlder = false;
        this.debug.mark();
        cx.notify();
      }
    });
  }
}

// The open picker in the debug dump: its first 12 rows.
function pickerDump(pk) {
  const items = pk.items();
  const top = items.slice(0, 12);
  return {
    kind: pk.kind, sel: pk.sel, top: pk.top ?? 0, wheeled: pk.wheeled ?? 0, count: items.length, hint: pk.hint,
    items: top.map((x) => x.value), labels: top.map((x) => x.label), metas: top.map((x) => x.meta ?? null),
    scope: pk.scopes?.index ?? null, scopeLabels: pk.scopes?.labels ?? null, loading: pk.loading, stale: pk.stale, progress: pk.progress,
  };
}

// Text as it reads, for finding a copied passage in a message's markdown: no
// emphasis, code, heading, quote or table marks, a link as its words, spaces as one.
/** @param {string} s */
function plainText(s) {
  return s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~#>|•]/g, " ").replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

// A message on one line, for a picker row.
function oneLine(text) {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > 140 ? t.slice(0, 139).trimEnd() + "…" : t;
}

// A message another agent sent (cards.js draws it as a report card): an
// `hc send` report (source external, or queued as a steer first) with its sender.
function isReport(it) {
  return Boolean(it.from ?? unwrapHc(it.text).from);
}

// An argv with its program replaced (settings `<agent>.tui`), keeping an
// `env K=V…` prefix (Pi's hand-off: `env HERDR_CHAT_HANDOFF=… pi --session <f>`).
function withProgram(argv, prog) {
  let i = 0;
  if (/(^|\/)env$/.test(argv[0] ?? "")) {
    i = 1;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
  }
  return [...argv.slice(0, i), ...prog, ...argv.slice(i + 1)];
}

// Per-key choices that outlive the chat: statuses hidden from the footer,
// widgets left open (localStorage, per mod copy).
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem("herdr-chat.prefs") ?? "{}");
    return { hiddenStatuses: Array.isArray(p.hiddenStatuses) ? p.hiddenStatuses : [], widgetsOpen: p.widgetsOpen ?? {} };
  } catch {
    return { hiddenStatuses: [], widgetsOpen: {} };
  }
}

function savePrefs(p) {
  try {
    localStorage.setItem("herdr-chat.prefs", JSON.stringify(p));
  } catch {}
}
