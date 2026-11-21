// new-chat: the "New chat with…" launcher, and the commands that open chats.
//
// As an overlay (`mod.open:new-chat`, the "open" key: cmd-i): Pi, Claude
// Code or Codex, then a new tab with the chat (mod chat, props {chat, cwd,
// provider}) for the focused terminal's folder (else the space's). Keys:
// p / c / x pick (only an agent that is installed; the launcher has no text
// field, so letters are always picks), 1/2/3 too, ↑↓ move, Enter opens the
// selected one (the last choice, kept in <appHome>/data/herdr-chat/launcher.json),
// Esc closes. Its commands: `new-chat.pick:<provider>`, `new-chat.enter`.
//
// As the layout's empty floating block (props {role: "commands"},
// install/layout.ts): always on screen at no size, so it takes the commands a
// key or another mod runs while no launcher is open:
// - `new-chat.open`: the launcher (as mod.open:new-chat; again: closes it);
// - `new-chat.pi`, `new-chat.claude`, `new-chat.codex`: that agent's chat, in a new tab;
// - `new-chat.continue:<terminal>`: chat-menu's Continue as chat (an agent's
//   TUI handed over to a chat on its session, see continueAsChat);
//   `new-chat.continue`: the same on the focused terminal (the "continue" key);
// - `new-chat.flip`: a Claude Code terminal ⇄ its chat view, in place (the "flip" key,
//   Ctrl+Shift+J as in Ovis; faces.js); `new-chat.flip:<terminal>`: that terminal's;
// - `new-chat.first-face:chat|terminal`, `new-chat.first-face:codex:chat|terminal`: the face a
//   terminal shows when Claude Code (or Codex) starts in it (settings.json `claude.face`,
//   `codex.face`; first-face.js): with chat, its chat view, flipped
//   as the flip key does (FirstFace);
// - `new-chat.update-check`: the update questions now, the release lookup too (update.js;
//   they also run a few seconds after this block starts, an install reloads it, and
//   once an hour, with the lookup at most once a day).
//   The question (a window that leaves the app usable, one at a time) takes
//   `new-chat.update:<button>` (restart, later, update, notes, output) and `new-chat.update:focus`.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, focused, hc, knownAgents, nextCommand, notify, openOverlay, panes, props, readTextFile, run, spaces, terminals, theme } from "herdr";
import * as fs from "fs/promises";
import { randomBytes } from "crypto";
import { UpdateDialog, checkHosts, checkRelease, checkRunning } from "./update.js";
import { appHas, bare, flip, viewProps, viewTerminal } from "./faces.js";
import { REMOTE_CHECK, VIEW_AGENTS, faceOf, flipsThere, remoteAnswer, started, withFace } from "./first-face.js";

const CHOICES = [
  { id: "pi", label: "Pi", icon: "pi", tint: true, letter: "p" },
  { id: "claude", label: "Claude Code", icon: "claude", letter: "c" },
  { id: "codex", label: "Codex", icon: "codex", letter: "x" },
];
const PREFS = () => `${appHome()}/data/herdr-chat/launcher.json`;

/** A chat with `provider` in a new tab, in the focused terminal's folder (else the space's). */
async function openChat(provider) {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space);
  const cwd = f?.cwd || space?.folder || null;
  const chat = `c-${randomBytes(4).toString("hex")}`;
  run("tab.new", { name: provider, mod: "chat", props: { chat, provider, ...(cwd ? { cwd } : {}) } });
  await fs.mkdir(`${appHome()}/data/herdr-chat`, { recursive: true });
  await fs.writeFile(PREFS(), JSON.stringify({ last: provider }));
}

const term = (addr) => terminals().find((t) => t.address === addr);
const word = (s) => (typeof s === "string" ? s : s?.state ?? null);
const base = (p) => String(p ?? "").split("/").pop();
const NAMES = Object.fromEntries(CHOICES.map((c) => [c.id, c.label]));

// Herdr's names for the agents (its status reports Claude Code as claude-code) → ours.
const HERDR_AGENTS = { pi: "pi", claude: "claude", "claude-code": "claude", codex: "codex" };

/** The agent a terminal runs, as Herdr reports it (an id of CHOICES), else null. */
export function agentOf(t) {
  for (const a of [t?.program?.key, t?.app, t?.status?.app, t?.report?.app, t?.agent]) if (HERDR_AGENTS[a]) return HERDR_AGENTS[a];
  return null;
}

/**
 * Why a terminal can't continue as a chat (null: it can): a live agent TUI
 * (Pi, Claude Code, Codex), idle or done. `working: true`: it can once its run
 * ends (chat-menu shows the item disabled). Which session it has open is the
 * host's to find (continueAsChat). Shared with chat-menu (a copy there: mods
 * can't import each other).
 */
export function cantContinue(t) {
  if (!t || t.state !== "live") return { why: "not live" };
  if (t.labels?.["herdr-chat.chat"]) return { why: "already a chat" };
  if (!agentOf(t)) return { why: "not an agent's TUI" };
  const st = word(t.status);
  if (st === "working" || st === "blocked") return { why: "Wait for the run to end", working: true };
  if (!["idle", "done"].includes(st)) return { why: `status ${st}` };
  return null;
}

/** The machine of another computer's terminal address ("box" for "box/t7"), null for one of this computer's. */
export function machineOf(address) {
  const s = String(address ?? ""), at = s.indexOf("/");
  return at > 0 ? s.slice(0, at) : null;
}

const isAgent = (argv, agent) => base(argv?.[0]) === agent || base(argv?.[1]) === agent;

/** The agent's process in a terminal (`hc get --json`): its foreground program when that's the agent (started from a shell), else the terminal's own. */
export function agentPid(info, agent) {
  const is = (p) => p?.pid && isAgent(p.argv, agent);
  if (is(info?.foreground)) return info.foreground.pid;
  if (is(info)) return info.pid;
  return null;
}

/** The agent among a process's children ({pid, argv} from `ps`), else null: a terminal whose own command started
 *  the agent (`fish -ic 'claude --resume …; exec fish -i'`, `zsh -c 'claude'`) has that shell in its foreground. */
export function agentChild(children, agent) {
  return children.find((c) => c.pid > 0 && isAgent(c.argv, agent))?.pid ?? null;
}

/** A process's children as {pid, argv} (argv split on spaces: enough for the program's name), or []. `on`: another machine's. */
async function childrenOf(pid, on = null) {
  const at = on ? { on } : {};
  const kids = await exec("pgrep", ["-P", String(pid)], at);
  const pids = kids.stdout.split("\n").map(Number).filter((n) => n > 0);
  if (!pids.length) return [];
  const ps = await exec("ps", ["-o", "pid=,command=", "-p", pids.join(",")], at);
  return ps.stdout.split("\n").map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), argv: m[2].split(/\s+/) }));
}

/** The chat's install: this computer's, or for an agent on another machine (`on`), that machine's
 *  (a copy of the chat mod's machines.js remoteInstall: mods can't import each other). */
async function chatConfig(on = null) {
  let cfg = {};
  if (on) {
    const r = await exec("/bin/sh", ["-c", 'h="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"; cat "${h%/}/mods/chat/config.json" 2>/dev/null'], { on, timeout: 20000 });
    try { cfg = JSON.parse(r.stdout || "{}") ?? {}; } catch {}
    if (!cfg.host) throw new Error(`herdr-chat isn't installed on ${on} (its mods/chat/config.json names no host): install it there too`);
    return cfg;
  }
  try { cfg = JSON.parse((await readTextFile(`${appHome()}/mods/chat/config.json`)) ?? "{}"); } catch {}
  if (!cfg.host) throw new Error("mods/chat/config.json names no host (install again)");
  return cfg;
}

/** The session the TUI has open, from the host (each agent's way: host/providers/<agent>/tui.ts): {session, model, thinking, args}. */
async function tuiSession(cfg, agent, pid, cwd, label, on = null) {
  const r = await exec("/usr/bin/env", [...(cfg.node ? [`HERDR_CHAT_NODE=${cfg.node}`] : []), cfg.host, "tui-session",
    "--provider", agent, "--pid", String(pid), "--cwd", cwd, ...(label ? ["--label", label] : [])], on ? { on } : {});
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().replace(/^herdr-chat-host: /, "") || "the host couldn't tell the TUI's session");
  return JSON.parse(r.stdout);
}

const alive = async (pid, on = null) => (await exec("kill", ["-0", String(pid)], on ? { on } : {})).code === 0;

/**
 * Continue as chat (research subagent-chat.md §F): an agent's TUI becomes a
 * chat on the same session (and model and thinking, where the agent records
 * them), whichever agent it is.
 * - A sub-agent (a parent): a core terminal runs one program, so the TUI ends
 *   (`hc kill`), and a host starts in its place with the same parent, name and
 *   folder (`hc run --parent <p> --name <n>`, bin/herdr-chat-subagent --session
 *   <file>): the parent sees one exit note, then its `hc send/wait <name>`
 *   reach the host. Then the chat dialog.
 * - A top-level TUI (continueInPlace): the chat takes its pane's place.
 * `addr` empty: the focused terminal (the "continue" key).
 */
export async function continueAsChat(addr, cx) {
  const t = term(addr || focused()?.terminal);
  const no = cantContinue(t);
  if (no) throw new Error(no.working ? "Wait for the run to end, then Continue as chat." : `Not an agent's TUI that can continue as a chat: ${no.why}.`);
  const agent = agentOf(t);
  const g = await hc(["get", t.address, "--json"]);
  if (g.code !== 0) throw new Error(`hc get ${t.address}: ${g.stderr.trim()}`);
  const info = JSON.parse(g.stdout);
  const shell = info.foreground?.pid ?? info.pid;
  // An agent on another machine ("box/t7"): its processes, its session and the chat's host are that machine's.
  const on = machineOf(t.address);
  if (on && t.parent) throw new Error(`a sub-agent on ${on} can't continue as a chat yet`);
  const pid = agentPid(info, agent) ?? (shell ? agentChild(await childrenOf(shell, on), agent) : null);
  if (!pid) throw new Error(`no ${NAMES[agent]} process in ${t.address} (its foreground is ${info.foreground?.argv?.[0] ?? "unknown"})`);
  const cwd = info.foreground?.cwd || t.cwd || "/";
  const cfg = await chatConfig(on);
  const found = await tuiSession(cfg, agent, pid, cwd, t.labels?.["herdr-chat.session"] ?? null, on);
  if (!t.parent) return continueInPlace(t, agent, pid, cwd, found, cx, on);
  const launcher = cfg.host.replace(/herdr-chat-host$/, "herdr-chat-subagent");
  const kill = await hc(["kill", t.address]);
  if (kill.code !== 0) throw new Error(`hc kill ${t.address}: ${kill.stderr.trim()}`);
  // Its name is free once the old terminal has ended.
  for (let i = 0; i < 50 && term(t.address)?.state === "live"; i++) await cx.sleep(100);
  // The model and thinking as the agent's own arguments: a sub-agent's host isn't restarted by a chat later.
  const args = found.args ?? [];
  const r = await hc(["run", "--bg", "--json", "--parent", t.parent, ...(t.name ? ["--name", t.name] : []), "--cwd", cwd,
    "--", launcher, "--provider", agent, "--session", found.session, ...(args.length ? ["--", ...args] : [])]);
  if (r.code !== 0) throw new Error(`hc run: ${r.stderr.trim() || r.stdout.trim()}`);
  const next = JSON.parse(r.stdout).address;
  // The launcher labels its terminal with the chat id once it starts.
  let chat = null;
  for (let i = 0; i < 100 && !chat; i++) { chat = term(next)?.labels?.["herdr-chat.chat"] ?? null; if (!chat) await cx.sleep(100); }
  if (!chat) throw new Error(`the chat host ${next} didn't label itself (herdr-chat.chat)`);
  run("overlay.close", { id: "terminal-peek" });
  openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { chat, peek: next, provider: agent } });
  return next;
}

/**
 * A top-level TUI (its own pane in a tab): the chat opens beside it
 * (pane.split with the chat mod, focused), then the agent gets SIGTERM (it
 * saves its session; the host waits for that pid: --after-pid). The agent may
 * be a shell's foreground program (`claude` typed in zsh): only that pid is
 * signalled, never the terminal. Once it is gone the TUI's pane closes, so the
 * chat takes its place, unless its shell runs something else then (it stays, and says so).
 */
export async function continueInPlace(t, agent, pid, cwd, found, cx, on = null) {
  const pane = panes().find((p) => p.terminal === t.address);
  if (!pane) throw new Error(`${t.address} has no pane in a tab`);
  const before = new Set(panes().map((p) => p.pane));
  const chat = `c-${randomBytes(4).toString("hex")}`;
  run("pane.split", { direction: "right", pane: pane.pane, mod: "chat",
    props: { chat, provider: agent, session: found.session, afterPid: pid, cwd, ...(found.model ? { model: found.model } : {}), ...(found.thinking ? { thinking: found.thinking } : {}) } });
  let mine = null;
  for (let i = 0; i < 50 && !mine; i++) { mine = panes().find((p) => !before.has(p.pane) && p.mod === "chat" && p.tab === pane.tab); if (!mine) await cx.sleep(100); }
  if (!mine) throw new Error("the chat's pane didn't appear beside the TUI");
  run("pane.focus", { pane: mine.pane });
  const k = await exec("kill", ["-TERM", String(pid)], on ? { on } : {});
  if (k.code !== 0) throw new Error(`kill -TERM ${pid}: ${k.stderr.trim()}`);
  for (let i = 0; i < 100 && (await alive(pid, on)); i++) await cx.sleep(100);
  if (await alive(pid, on)) {
    notify({ title: "Continue as chat", body: `${NAMES[agent]} (pid ${pid}) didn't quit in 10 s: the chat waits for it (resume there once it's gone).`, level: "warning" });
    return mine.pane;
  }
  // A shell left with its prompt: nothing else runs in it, so it goes. A program
  // that ended with the agent: the pane shows its exit, so it goes too. A prompt's own
  // commands (git status, an rc file) come and go: up to 3 s for the shell to
  // be alone in its terminal.
  let a = null, idleShell = false;
  for (let i = 0; i < 15 && !idleShell; i++) {
    await cx.sleep(200);
    const after = await hc(["get", t.address, "--json"]);
    a = after.code === 0 ? JSON.parse(after.stdout) : null;
    idleShell = !a || a.state !== "live" || !a.foreground?.pid || a.foreground.pid === a.pid;
  }
  if (!idleShell) {
    notify({ title: "Continue as chat", body: `The TUI's terminal now runs ${a.foreground?.argv?.[0] ?? "something"}: its pane stays.`, level: "info" });
    return mine.pane;
  }
  if (panes().some((p) => p.pane === pane.pane)) run("pane.close", { pane: pane.pane });
  run("pane.focus", { pane: mine.pane });
  return mine.pane;
}

// The floating block: commands only, nothing drawn.
/**
 * The flip key on a terminal (faces.js): a Claude Code or Codex terminal shows its chat
 * view in its place (made the first time; the view's host reads the session
 * the TUI has open and types into it, so nothing restarts), and a terminal
 * whose view shows goes back. In the view itself the chat mod takes the key.
 * Another machine's terminal flips in that machine's document and its view's
 * host runs there (herdr-chat installed there too).
 */
async function flipFace(addr, cx) {
  const f = focused();
  // A chat view's pane whose keyboard isn't in the chat (its own key didn't take it): its terminal.
  const terminal = addr || f?.terminal || (f?.pane ? await viewTerminal(f.pane) : null);
  if (!terminal) throw new Error("Ctrl+Shift+J flips a Claude Code or Codex terminal to its chat view: focus one first.");
  const t = term(terminal);
  if (!t || t.state !== "live") throw new Error(`Terminal ${terminal} isn't running.`);
  const agent = agentOf(t);
  const viewable = VIEW_AGENTS.includes(agent);
  const props = viewable ? viewProps(bare(terminal), t.foreground?.cwd ?? t.cwd ?? null, agent) : null;
  let r;
  try {
    r = await flip(cx, terminal, "toggle", props);
  } catch (/** @type {any} */ e) {
    if (!viewable && /no chat view yet/.test(String(e?.message))) {
      throw new Error(agent ? `The chat view is for Claude Code and Codex terminals for now (this one runs ${NAMES[agent] ?? agent}).` : "No agent runs here: the chat view is for a Claude Code or Codex terminal.");
    }
    throw e;
  }
  if (r.face === "terminal") return run("pane.focus", { pane: r.term });
  // A new view is in the app once it has read the document (within half a second; another machine's
  // after its core's event and a read over its link).
  const machine = machineOf(terminal);
  if (r.created && !(await appHas(cx, r.pane, machine ? 8000 : 2000))) throw new Error(`The chat view didn't appear${machine ? ` (${machine} answered slowly)` : ""}: try again.`);
  run("pane.focus", { pane: r.pane });
}

const SETTINGS = () => `${appHome()}/data/herdr-chat/settings.json`;

/** settings.json, {} when there's none; throws when it isn't JSON (a person's file: never written over then). */
async function readSettings() {
  const text = await readTextFile(SETTINGS());
  if (text == null || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${SETTINGS()} isn't valid JSON: fix it, then try again.`);
  }
}

/** `new-chat.first-face:[<agent>:]<face>`: settings.json's claude.face (or the agent's), the rest of the file as it was. */
async function setFirstFace(arg) {
  const [agent, face] = arg.includes(":") ? arg.split(":", 2) : ["claude", arg];
  if (!VIEW_AGENTS.includes(agent)) throw new Error(`first-face is for ${VIEW_AGENTS.join(" and ")}, not "${agent}".`);
  if (face !== "chat" && face !== "terminal") throw new Error(`first-face takes chat or terminal, not "${face}".`);
  const settings = await readSettings();
  if (settings?.[agent]?.face === face) return;
  await fs.mkdir(`${appHome()}/data/herdr-chat`, { recursive: true });
  await fs.writeFile(SETTINGS(), JSON.stringify(withFace(settings, face, agent), null, 2) + "\n");
}

/** What `machine` says of its own first face (first-face.js REMOTE_CHECK), asked over its core; null when it didn't
 *  answer. Kept a few seconds, for terminals starting there together. */
const remoteChecks = new Map();
async function remoteCheck(machine) {
  const had = remoteChecks.get(machine);
  if (had && Date.now() - had.at < 5000) return had.answer;
  const r = await exec("/bin/sh", ["-c", REMOTE_CHECK], { on: machine, timeout: 8000 }).catch(() => null);
  const answer = r?.code === 0 ? remoteAnswer(r.stdout) : null;
  remoteChecks.set(machine, { at: Date.now(), answer });
  return answer;
}

/**
 * Claude Code's and Codex's first face (first-face.js): every half second, the terminals where one started since the
 * last look; unless settings.json's face for that agent is "terminal", each shows its chat view, made as the flip key
 * makes it. A terminal whose pane isn't in the layout document yet (a tab just made) is tried again for a few seconds.
 * The keyboard follows into the view only from the terminal's own pane. Another machine's terminal only while that
 * machine's own app doesn't run, and by that machine's setting (remoteCheck).
 */
class FirstFace {
  constructor(cx) {
    /** @type {Map<string, boolean> | null} address → ran Claude Code or Codex at the last look */
    this.was = null;
    /** @type {Map<string, number>} address → until when to try its flip */
    this.pending = new Map();
    /** @type {Set<string>} another machine's terminals pending here that its check let this app flip */
    this.allowed = new Set();
    this.busy = false;
    // The first look after the app has listed its terminals: what runs then keeps its face.
    cx.timer.after(2000, () => cx.timer.every(500, () => void this.look(cx)));
  }

  async look(cx) {
    if (this.busy) return;
    this.busy = true;
    try {
      const list = terminals().filter((t) => t?.address);
      // Not one of herdr-chat's own: a chat's host, or the TUI its /tui opened, which was asked for as a terminal.
      const runs = (t) => t.state === "live" && VIEW_AGENTS.includes(agentOf(t)) && !Object.keys(t.labels ?? {}).some((k) => k.startsWith("herdr-chat."));
      const now = Date.now();
      // Another machine's document reaches this app later (its core's event, then a read over its link): longer.
      for (const a of started(this.was, list, runs, now)) this.pending.set(a, now + (machineOf(a) ? 15000 : 8000));
      this.was = new Map(list.map((t) => [t.address, runs(t)]));
      if (!this.pending.size) return;
      // A settings.json that isn't JSON: as one without the keys (setFirstFace says what's wrong with it).
      let settings = null;
      if ([...this.pending.keys()].some((a) => !machineOf(a))) {
        try {
          settings = await readSettings();
        } catch {}
      }
      for (const [address, until] of [...this.pending]) {
        const t = list.find((x) => x.address === address);
        const machine = machineOf(address);
        // Another machine's: asked once per start (its app may flip it itself, or its setting may be the terminal).
        if (machine && t && runs(t) && !this.allowed.has(address)) {
          if (flipsThere(await remoteCheck(machine), agentOf(t))) this.allowed.add(address);
          else { this.pending.delete(address); continue; }
        }
        if (!t || !runs(t) || (!machine && faceOf(settings, agentOf(t)) !== "chat")) {
          this.pending.delete(address);
          this.allowed.delete(address);
          continue;
        }
        const mine = focused()?.terminal === address;
        try {
          const r = await flip(cx, address, "chat", viewProps(bare(address), t.foreground?.cwd ?? t.cwd ?? null, agentOf(t)));
          this.pending.delete(address);
          this.allowed.delete(address);
          if (mine && (!r.created || (await appHas(cx, r.pane, machine ? 8000 : 2000))) && focused()?.terminal === address) run("pane.focus", { pane: r.pane });
        } catch (e) {
          // A tab just made: its pane reaches the document after this look. Else, or out of time: the terminal stays.
          if (!/has no pane/.test(String(e?.message)) || Date.now() > until) {
            this.pending.delete(address);
            this.allowed.delete(address);
            if (!/has no pane/.test(String(e?.message))) notify({ title: "Chat view", body: `${NAMES[agentOf(t)] ?? "The agent"} started in ${address}; its chat view didn't open: ${e?.message ?? e}`, level: "error" });
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

class Commands {
  constructor(cx) {
    this.firstFace = new FirstFace(cx);
    // After an install (which reloads this mod) or at start: an update that ran, chats on older
    // code (asked first), else a newer release.
    const updates = async (now = false) => {
      try {
        await checkRunning();
        if (!(await checkHosts({ always: now }))) await checkRelease({ now });
      } catch (e) {
        notify({ title: "herdr-chat update", body: String(e?.message ?? e), level: "error" });
      }
    };
    cx.timer.after(3000, () => void updates());
    cx.timer.every(3600 * 1000, () => void updates());
    // An update the dialog started: its end (checkRunning does nothing while none runs). On
    // success question 2, once the dialog (it polls every second) has closed.
    cx.timer.every(3000, () => void checkRunning().then((ok) => ok && cx.timer.after(1500, () => void checkHosts({ always: true }))).catch(() => {}));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        try {
          if (c === "open") run("mod.open", { name: "new-chat" });
          else if (CHOICES.some((x) => x.id === c)) await openChat(c);
          else if (c === "continue" || c.startsWith("continue:")) await continueAsChat(c.slice(9), cx);
          else if (c === "flip" || c.startsWith("flip:")) await flipFace(c.slice(5), cx);
          else if (c === "update-check") await updates(true);
          else if (c.startsWith("first-face:")) await setFirstFace(c.slice(11));
        } catch (e) {
          notify({ title: c.startsWith("continue") ? "Continue as chat" : c.startsWith("flip") || c.startsWith("first-face") ? "Chat view" : "New chat", body: String(e?.message ?? e), level: "error" });
        }
      }
    });
  }
}

export default class NewChat extends View {
  init(_props, cx) {
    if (props()?.role === "commands") { this.commands = new Commands(cx); return; }
    if (props()?.role === "update") {
      this.handle = cx.focus_handle();
      this.update = new UpdateDialog(props(), cx);
      // No focus of its own (update.js): a click on it, or `new-chat.update:focus`, gives it the keys.
      // Its buttons by command (`new-chat.update:restart|later|update|notes|output`), as a click.
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (c === "focus" || c === "update:focus") this.handle.focus();
          else if (c.startsWith("update:")) this.update.answer(c.slice(7), cx);
          cx.notify();
        }
      });
      return;
    }
    this.sel = 0;
    this.done = false;
    this.installed = null; // provider id → installed (knownAgents), null until known
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => {
      try {
        const last = JSON.parse((await readTextFile(PREFS())) ?? "{}").last;
        const i = CHOICES.findIndex((c) => c.id === last);
        if (i >= 0) this.sel = i;
      } catch {}
      this.handle.focus();
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents();
        this.installed = Object.fromEntries(CHOICES.map((c) => [c.id, known.find((a) => a.key === c.id)?.installed !== false]));
      } catch {}
      cx.notify();
    });
    cx.timer.after(120, () => this.handle.focus());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c.startsWith("pick:")) this.open(CHOICES.findIndex((x) => x.id === c.slice(5)), cx);
        else if (c === "enter") this.open(this.sel, cx);
        cx.notify();
      }
    });
  }

  // An agent knownAgents() says isn't installed (unknown yet: every one is offered).
  available(c) {
    return this.installed?.[c.id] !== false;
  }

  open(i, cx) {
    if (this.done || i < 0 || i >= CHOICES.length) return;
    this.done = true;
    const provider = CHOICES[i].id;
    const overlay = props()?.overlay;
    cx.spawn(async () => {
      try {
        await openChat(provider);
      } catch (e) {
        notify({ title: "New chat", body: String(e?.message ?? e), level: "error" });
      } finally {
        if (overlay) closeOverlay(overlay);
      }
    });
  }

  key(e, cx) {
    const k = e.keystroke;
    const letter = CHOICES.findIndex((c) => c.letter === k && this.available(c));
    if (letter >= 0) this.open(letter, cx);
    else if (/^[1-9]$/.test(k)) this.open(Number(k) - 1, cx);
    else if (k === "up") this.sel = (this.sel + CHOICES.length - 1) % CHOICES.length;
    else if (k === "down" || k === "tab") this.sel = (this.sel + 1) % CHOICES.length;
    else if (k === "enter") this.open(this.sel, cx);
    else if (k === "escape") { const o = props()?.overlay; if (o) closeOverlay(o); }
    cx.notify();
  }

  render() {
    if (this.commands) return div();
    if (this.update) return this.update.render(this.handle);
    const t = theme();
    const mark = (c) => {
      const path = `mods/chat/icons/providers/${c.icon}.svg`;
      return (c.tint ? svg(path).text_color(t.foreground) : image(path)).size(18).flex_none();
    };
    const letters = CHOICES.filter((c) => this.available(c)).map((c) => c.letter.toUpperCase()).join(" ");
    return v_flex().id("launcher").size_full().p(8).gap(2).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .child(div().px(8).pt(4).pb(6).text_size(11.5).text_color(t.dim).child("New chat"))
      .children(CHOICES.map((c, i) => h_flex().id(`choice-${c.id}`).h(36).px(10).gap(10).items_center().rounded(8).cursor_pointer()
        .when(i === this.sel, (e) => e.bg(t.selected))
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(i, cx))
        .child(mark(c))
        .child(div().flex_1().text_size(13).text_color(this.available(c) ? t.foreground : t.dim).child(this.available(c) ? c.label : `${c.label} (not installed)`))
        .when(this.available(c), (e) => e.child(div().px(5).rounded(4).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.dim).child(c.letter.toUpperCase())))))
      .child(div().px(8).pt(6).text_size(10.5).text_color(t.dim).child(`${letters} or ↑↓ Enter · Esc`));
  }
}
