// Codex as the person's own TUI in a Herdr terminal, shown as a chat: the
// terminal view (Ctrl+Shift+J flips a Codex terminal to it and back), as
// providers/claude/terminal.ts does for Claude Code. Nothing here runs Codex.
// The TUI stays the one client of its conversation, so the chat and the
// terminal show the same agent and a flip changes nothing:
//
// - the terminal: `hc events --terminal <t>` gives its agent status (the run
//   starts and settles with it), its foreground process and its end;
// - the conversation: the rollout file of the thread the TUI shows (bind.ts:
//   held open by the TUI, or the one its daemon loaded for it), looked at
//   again every second and a half, so a /new or /resume there moves the chat
//   along;
// - the timeline: the rollout as it grows, each finished item as Codex's
//   app-server would hand it to a chat (items.ts → map.ts);
// - sending: `hc send` (paste and Enter, as the person would: mid-run, Codex
//   takes it into the turn); stopping: `hc interrupt`.
//
// Codex's dialogs (an approval, its questions, Implement this plan?) show as
// cards: while it waits (status "blocked") its screen is read (screen.ts), and
// an answer is the key the dialog shows for it, or the moves and Enter.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { bindRollout, findRollout, isCodexTui, LINUX_IO } from "./bind.ts";
import type { BindIO, Binding } from "./bind.ts";
import { RolloutFollower } from "./items.ts";
import { codexModels, modelAnswer, newLines, startingModel } from "./models.ts";
import { codexAtPrompt, codexMovesTo, codexPromptKey, readCodexPrompt } from "./screen.ts";
import { waitForPrompt } from "../prompt-wait.ts";
import type { PromptWait } from "../prompt-wait.ts";
import type { CodexPrompt, CodexRow } from "./screen.ts";
import { readImageFile } from "./adapter.ts";
import { CODEX_TOOLS } from "./tools.ts";
import { AgentError } from "../types.ts";
import type {
  AdapterHost, AdapterOptions, AgentCommand, AgentModel, Ask, AskAnswer, Capabilities, Disposition, ImageBlock, NormalizedEvent,
  PromptMode, ProviderAdapter, SessionSource, StartInfo, UsageInfo,
} from "../types.ts";

type Rec = Record<string, any>;
type Fg = { pid: number; name: string | null; argv: string[] };

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const TAIL_MS = () => num(process.env.HERDR_CHAT_TAIL_MS, 150);
/** How often the conversation the TUI shows is looked for again. */
const SESSION_MS = () => num(process.env.HERDR_CHAT_SESSION_MS, 1500);
const ASK_MS = () => num(process.env.HERDR_CHAT_ASK_MS, 500);
const ASK_SETTLE_MS = 700;
const SENT_TTL_MS = 10 * 60_000;
const AGENT_APPS = new Set(["codex"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const NOT_HERE = "Do that in Codex's terminal: Ctrl+Shift+J flips to it.";
const BUSY = "Codex is working: run the command when it's done, or in a new tab.";
const ASKING = "Codex is asking something in its terminal: answer it there first (Ctrl+Shift+J shows it), then send.";
const ASKING_CARD = "Codex is asking something: answer its card above the composer first, then send.";
const CHANGED = "Codex's dialog changed in the terminal: answer the new one.";
const NO_IMAGES = "Images can't be typed into Codex's terminal from the chat yet: paste them there (Ctrl+Shift+J shows it).";

/** Why `hc send` refused, in words. */
function sendError(out: string): string {
  try {
    const e = JSON.parse(out.trim().split("\n").pop() ?? "")?.error;
    if (e?.kind === "blocked") return ASKING;
    if (typeof e?.message === "string") return e.message;
  } catch {}
  return out.trim();
}

/** Codex's own commands, for the slash menu: typed into the TUI (the chat flips to the terminal for those that open a screen there). */
const VIEW_COMMANDS: [string, string][] = [
  ["model", "Pick the model and reasoning effort"],
  ["permissions", "What Codex may do without asking (in the terminal)"],
  ["plan", "Switch to Plan mode"],
  ["new", "Start a new conversation"],
  ["resume", "Resume another conversation (in the terminal)"],
  ["fork", "Fork this conversation"],
  ["compact", "Compact the conversation"],
  ["review", "Review the current changes"],
  ["diff", "Show the git diff (in the terminal)"],
  ["init", "Write an AGENTS.md for this project"],
  ["status", "Session settings and token usage (in the terminal)"],
  ["mcp", "MCP servers (in the terminal)"],
  ["rename", "Rename this conversation"],
  ["usage", "Account usage (in the terminal)"],
  ["quit", "Quit Codex"],
];

export type CodexTerminalOptions = AdapterOptions & {
  /** The terminal the TUI runs in (`t7`, as the host's core names it). */
  terminal: string;
  hc: string;
  /** What the binding reads (tests stand in for /proc). */
  io?: BindIO;
};

/** The text a user message and a sent one are compared by. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** A rollout's records (a fork's file starts after its source's: those first, up to where the fork began). */
export function rolloutRecords(path: string, home: string, depth = 0): Rec[] {
  let text: string;
  try {
    const size = statSync(path).size;
    const buf = Buffer.alloc(size);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, size, 0);
    } finally {
      closeSync(fd);
    }
    text = buf.subarray(0, buf.lastIndexOf(0x0a) + 1).toString("utf8");
  } catch {
    return [];
  }
  const own: Rec[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === "object") own.push(r);
    } catch {}
  }
  const base = own[0]?.type === "session_meta" ? own[0]!.payload?.history_base : null;
  if (depth < 4 && base && typeof base.thread_id === "string" && typeof base.end_ordinal_exclusive === "number") {
    const src = findRollout(home, base.thread_id);
    if (src) {
      const before = rolloutRecords(src, home, depth + 1).filter((r) => typeof r.ordinal !== "number" || r.ordinal < base.end_ordinal_exclusive);
      return [...before, ...own];
    }
  }
  return own;
}

export class CodexTerminalAdapter implements ProviderAdapter {
  readonly id = "codex";
  readonly name = "Codex";
  readonly tools = CODEX_TOOLS;
  readonly capabilities: Capabilities = {
    steer: true, followUp: false, thinkingLevels: [], permissions: true, permissionModes: [], extensionUi: false,
    compact: false, compactInstructions: false, rename: false, fork: false, images: false, cost: false, tui: false,
  };
  // /resume is the TUI's (its picker): the chat's own list stays empty.
  readonly sessions: SessionSource = { kind: "files", files: () => [], describe: () => null };

  private opts: CodexTerminalOptions;
  private io: BindIO;
  private host: AdapterHost | null = null;
  private events: ChildProcessWithoutNullStreams | null = null;
  private eventsRetry: NodeJS.Timeout | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private live = true;
  private status: string | null = null;
  private fg: Fg | null = null;
  private file: string | null = null;
  private thread: string | null = null;
  private follower: RolloutFollower | null = null;
  private offset = 0;
  private awaitingHistory = false;
  private running = false;
  private settling = false;
  private sent: { id: string; text: string; at: number }[] = [];
  private quitSaid = false;
  private unsureSaid = false;
  private binding = false;
  private usageNow: { contextTokens: number | null; contextWindow: number | null } = { contextTokens: null, contextWindow: null };
  private ask: { id: string; key: string; prompt: CodexPrompt } | null = null;
  private askSeq = 0;
  private askTimer: NodeJS.Timeout | null = null;
  private answering = false;
  private askHold = 0;
  private modelNow: string | null = null;
  private effortNow: string | null = null;
  private snapshot: Promise<void>;
  private gotSnapshot: () => void = () => {};

  constructor(opts: CodexTerminalOptions) {
    this.opts = opts;
    this.io = opts.io ?? LINUX_IO;
    this.snapshot = new Promise((r) => (this.gotSnapshot = r));
  }

  get alive(): boolean {
    return this.live && !this.disposed;
  }

  private emit(ev: NormalizedEvent): void {
    if (this.disposed) return;
    this.host?.emit(ev);
    // The model and effort it runs with now (the picker's current ones), and the model's levels for the effort chip.
    if (ev.type === "model" && ev.model.id !== this.modelNow) {
      this.modelNow = ev.model.id;
      const m = codexModels(this.home()).find((x) => x.id === ev.model.id);
      this.host?.emit({ type: "capabilities", capabilities: { thinkingLevels: m?.efforts ?? [] } });
    } else if (ev.type === "thinking") this.effortNow = ev.level;
  }

  private log(msg: string): void {
    this.opts.log(`terminal ${this.opts.terminal}: ${msg}`);
  }

  // ---------------------------------------------------------------- the terminal

  private watch(): void {
    if (this.disposed || this.events) return;
    const p = spawn(this.opts.hc, ["events", "--json", "--terminal", this.opts.terminal], { stdio: ["pipe", "pipe", "pipe"] });
    this.events = p;
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          this.onEvent(JSON.parse(line));
        } catch {}
      }
    });
    p.on("error", (e) => this.log(`${this.opts.hc} events: ${e.message}`));
    p.on("close", () => {
      if (this.events !== p) return;
      this.events = null;
      if (!this.disposed) this.eventsRetry = setTimeout(() => this.watch(), 1000).unref() as NodeJS.Timeout;
    });
    p.stdin.on("error", () => {});
  }

  private onEvent(m: Rec): void {
    if (Array.isArray(m.terminals)) {
      const t = m.terminals.find((x: Rec) => x?.address === this.opts.terminal);
      if (!t) this.gone("isn't in the core");
      else {
        if (t.state && t.state !== "live") this.gone(`ended (${t.state})`);
        this.foreground(t.foreground ?? null);
        this.onStatus(t.status ?? null);
      }
      this.gotSnapshot();
      return;
    }
    const p: Rec = m.params ?? {};
    if (m.method !== "event" || p.terminal !== this.opts.terminal) return;
    const d: Rec = p.data ?? {};
    if (p.type === "status") this.onStatus(d.status ?? null);
    else if (p.type === "foreground") this.foreground(d);
    else if (p.type === "finished" || p.type === "removed") this.gone(`${p.type} (${d.reason ?? d.exit_code ?? "-"})`);
  }

  private foreground(f: Rec | null): void {
    const fg: Fg | null = f && Number(f.pid) > 0 ? { pid: Number(f.pid), name: typeof f.name === "string" ? f.name : null, argv: Array.isArray(f.argv) ? f.argv.map(String) : [] } : null;
    if (fg?.pid === this.fg?.pid) return;
    this.fg = fg;
    if (this.host) void this.checkSession();
  }

  private onStatus(s: Rec | null): void {
    const app = typeof s?.app === "string" ? s.app : null;
    const state = s && (!app || AGENT_APPS.has(app)) && typeof s.state === "string" ? s.state : null;
    if (state === this.status) return;
    this.status = state;
    if (!this.host) return;
    if (state === "working" || state === "blocked") this.runOn();
    else this.settle();
    if (state === "blocked") this.watchAsk();
    else this.closeAsk();
  }

  private gone(why: string): void {
    if (!this.live) return;
    this.live = false;
    this.log(why);
    this.settle();
    this.emit({ type: "notice", level: "warning", source: "host", text: "Codex's terminal has ended." });
  }

  private runOn(): void {
    if (this.running) return;
    this.running = true;
    this.emit({ type: "run_started" });
  }

  private settle(): void {
    if (!this.running || this.settling) return;
    // What it wrote last; a turn end in it would settle again from tail().
    this.settling = true;
    try {
      this.tail();
    } finally {
      this.settling = false;
    }
    this.running = false;
    this.emit({ type: "run_settled", aborted: false });
  }

  // ---------------------------------------------------------------- the conversation

  /** Whether a Codex TUI runs on the terminal now (its foreground or one under it). */
  private codexRuns(): boolean {
    const fg = this.fg;
    if (!fg) return false;
    return this.io.tree(fg.pid).some((p) => isCodexTui(this.io.argv(p)));
  }

  private promptWaits = 0;

  /** A command the chat typed opened a screen in the TUI (prompt-wait.ts): until Codex shows its prompt again. */
  awaitPrompt(): Promise<PromptWait> {
    const mine = ++this.promptWaits;
    return waitForPrompt(() => this.screenText(), codexAtPrompt, { cancelled: () => this.disposed || !this.live || mine !== this.promptWaits });
  }

  private async screenText(): Promise<string | null> {
    const r = await this.hc(["read", "--json", this.opts.terminal], 5000);
    try {
      const text = JSON.parse(r.stdout)?.text;
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  }

  private async checkSession(): Promise<void> {
    if (this.binding || this.disposed) return;
    this.binding = true;
    try {
      if (!this.codexRuns()) {
        if (this.fg && !this.quitSaid && this.file) {
          this.quitSaid = true;
          this.settle();
          this.emit({ type: "notice", level: "info", source: "host", text: "Codex quit in its terminal. Start it there again and this view follows it." });
        }
        return;
      }
      this.quitSaid = false;
      let b: Binding = bindRollout(this.fg!.pid, this.io);
      if (b.path === null && b.why === "ambiguous") {
        const screen = await this.screenText();
        if (this.disposed || !this.fg) return;
        b = bindRollout(this.fg.pid, this.io, () => screen);
      }
      if (b.path === null) {
        if (b.why === "ambiguous" && !this.file && !this.unsureSaid) {
          this.unsureSaid = true;
          this.log(`can't tell which of ${b.candidates.length} conversations is this terminal's`);
          this.emit({ type: "notice", level: "info", source: "host", text: "Codex has more than one conversation open in this folder, and this view can't tell which is this terminal's yet. It follows once the terminal shows a message of it." });
        }
        return;
      }
      this.unsureSaid = false;
      if (b.path === this.file) return;
      const first = this.file === null;
      this.log(`conversation ${b.id} (${b.how})`);
      this.file = b.path;
      this.thread = b.id;
      this.follower = null;
      this.offset = 0;
      if (!first) this.awaitingHistory = true;
      this.emit({ type: "session", id: b.id, file: b.path, ...(first ? {} : { reload: true }) });
    } catch (e) {
      this.log(`binding: ${(e as Error).message}`);
    } finally {
      this.binding = false;
    }
  }

  private home(): string {
    const pid = this.fg?.pid;
    const env = (n: string) => (pid ? this.io.env(pid, n) : null);
    return env("CODEX_HOME") ?? process.env.CODEX_HOME ?? join(env("HOME") ?? homedir(), ".codex");
  }

  /** The rollout's whole lines from `from`, and where the next read starts. */
  private read(from: number): { lines: string[]; next: number } {
    const file = this.file;
    if (!file) return { lines: [], next: from };
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return { lines: [], next: from };
    }
    if (size <= from) return { lines: [], next: from };
    const buf = Buffer.alloc(size - from);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, buf.length, from);
    } finally {
      closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], next: from };
    return { lines: buf.subarray(0, end).toString("utf8").split("\n"), next: from + end + 1 };
  }

  private tail(): void {
    if (!this.file || this.disposed || this.awaitingHistory) return;
    if (!this.follower) {
      if (!existsSync(this.file)) return;
      // No history was read: from the start (a conversation that began after the view did).
      this.follower = new RolloutFollower({ readImage: readImageFile });
      this.offset = 0;
    }
    try {
      if (statSync(this.file).size < this.offset) this.offset = 0;
    } catch {
      return;
    }
    const { lines, next } = this.read(this.offset);
    this.offset = next;
    // Whether these lines end a turn (not an end read before: settle reads too, and would come back here).
    let ended = false;
    for (const l of lines) {
      if (!l.trim()) continue;
      let r: unknown;
      try {
        r = JSON.parse(l);
      } catch {
        continue;
      }
      const before = this.follower.turn;
      for (const ev of this.follower.feed(r)) this.emit(this.matchEcho(ev));
      if (this.follower.turn !== before) ended = this.follower.turn === "ended";
    }
    this.usageNow = this.follower.usage();
    // A turn that ended while the terminal never showed it working (a quick answer).
    if (ended && this.running && this.status !== "working" && this.status !== "blocked") this.settle();
  }

  /** A user message this chat sent: the echo that confirms it; any other came from the terminal. */
  private matchEcho(ev: NormalizedEvent): NormalizedEvent {
    if (ev.type !== "user_message") return ev;
    if (!this.running) this.runOn();
    const now = Date.now();
    this.sent = this.sent.filter((s) => now - s.at < SENT_TTL_MS);
    const i = this.sent.findIndex((s) => norm(s.text) === norm(ev.text));
    if (i < 0) return { ...ev, source: "external" };
    const [s] = this.sent.splice(i, 1);
    const { source: _source, ...rest } = ev;
    return { ...rest, clientId: s!.id };
  }

  // ---------------------------------------------------------------- its dialogs

  private watchAsk(): void {
    if (this.askTimer || this.disposed) return;
    this.askTimer = setTimeout(() => void this.pollAsk(), 0);
    this.askTimer.unref();
  }

  private async pollAsk(): Promise<void> {
    if (!this.disposed && this.status === "blocked" && !this.answering && Date.now() >= this.askHold) {
      const p = await this.screenPrompt();
      if (this.status === "blocked" && !this.answering && Date.now() >= this.askHold && p !== undefined) this.showAsk(p);
    }
    this.askTimer = null;
    if (!this.disposed && this.status === "blocked") {
      this.askTimer = setTimeout(() => void this.pollAsk(), ASK_MS());
      this.askTimer.unref();
    }
  }

  private async screenPrompt(): Promise<CodexPrompt | null | undefined> {
    const text = await this.screenText();
    return text === null ? undefined : readCodexPrompt(text);
  }

  private showAsk(p: CodexPrompt | null): void {
    const key = p ? codexPromptKey(p) : null;
    if (this.ask && key === this.ask.key) {
      this.ask.prompt = p!;
      return;
    }
    this.closeAsk();
    if (!p || !key) return;
    const id = `tv-ask-${++this.askSeq}`;
    this.ask = { id, key, prompt: p };
    this.emit({ type: "ask", ask: this.askOf(id, p) });
  }

  private closeAsk(): void {
    if (!this.ask) return;
    this.emit({ type: "ask_closed", id: this.ask.id });
    this.ask = null;
  }

  private askOf(id: string, p: CodexPrompt): Ask {
    if (p.kind === "question") {
      const options = p.rows.map((r) => ({ label: r.label, ...(r.description ? { description: r.description } : {}) }));
      const title = /^Question 1\/1\b/.test(p.progress ?? "") || !p.progress ? "Codex has a question" : `Codex has a question (${p.progress.replace(/^Question /, "").replace(/\s*\(.*$/, "")})`;
      return { id, kind: "questions", title, questions: [{ id: "q", question: p.question || "Codex asks", options, multiSelect: false, allowOther: Boolean(p.other || p.freeform) }] };
    }
    let firstYes = true;
    const choice = (r: CodexRow) => {
      const yes = /^(Yes|Allow)\b/i.test(r.label);
      const kind = /^(No|Cancel)\b/i.test(r.label) ? "deny" as const
        : yes && firstYes ? "allow" as const
          : /^Yes, and (?:don't ask again|allow)|for this (?:session|conversation)|in the future/i.test(r.label) ? "allow_always" as const : "other" as const;
      if (yes) firstYes = false;
      return { id: `r${r.stop}`, label: r.label, kind, ...(r.description ? { description: r.description } : {}) };
    };
    if (p.kind === "approval") {
      // The command or what it asks about, as the terminal shows it; a `$ command` line as code.
      const body = p.body.split("\n").map((l) => (/^\$ /.test(l) ? `\`\`\`sh\n${l.slice(2)}\n\`\`\`` : l)).join("\n\n");
      return { id, kind: "permission", title: p.title.replace(/^Would you like to /, "Codex wants to ").replace(/\?$/, ""), ...(body ? { message: body } : {}), choices: p.rows.map(choice) };
    }
    return { id, kind: "permission", title: p.title, ...(p.body ? { message: p.body } : {}), choices: p.rows.map((r, i) => ({ ...choice(r), ...(i === 0 ? { kind: "allow" as const } : {}) })) };
  }

  private async pressKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    this.log(`dialog: keys ${keys.join(" ")}`);
    const r = await this.hc(["keys", "--json", this.opts.terminal, ...keys], 10_000);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc keys: exit ${r.code}`);
  }

  /** Until the screen shows what the keys before did (the cursor on a row): a paste ahead of the redraw lands where the cursor was. */
  private async screenShows(what: (p: CodexPrompt) => boolean, ms = 2500): Promise<CodexPrompt> {
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 80))) {
      const p = await this.screenPrompt();
      if (p && what(p)) return p;
      if (Date.now() - t0 > ms) throw new Error("Codex didn't take the keys: answer in its terminal (Ctrl+Shift+J)");
    }
  }

  private async typeAnswer(text: string): Promise<void> {
    this.log(`dialog: typed ${text.length} chars`);
    const r = await this.hc(["send", "--json", "--force", this.opts.terminal, text.replace(/\s*\n\s*/g, " ").trim()], 20_000);
    if (r.code !== 0) throw new Error(sendError(r.stdout || r.stderr) || `hc send: exit ${r.code}`);
  }

  /** After a "No" that took a reason: once Codex is back at its prompt, the reason as a message. */
  private async sendReason(reason: string): Promise<void> {
    for (const t0 = Date.now(); this.status === "blocked" && Date.now() - t0 < 5000; ) await new Promise((r) => setTimeout(r, 100));
    const r = await this.hc(["send", "--json", this.opts.terminal, reason], 70_000);
    if (r.code !== 0) throw new Error(sendError(r.stdout || r.stderr) || `hc send: exit ${r.code}`);
  }

  private async answerAsk(key: string, a: AskAnswer): Promise<void> {
    const p = await this.screenPrompt();
    if (!p || codexPromptKey(p) !== key) throw new Error(CHANGED);
    if ("cancelled" in a) return this.pressKeys(["esc"]);
    if (p.kind === "question") return this.answerQuestion(p, "answers" in a ? a.answers.q : undefined);
    if (!("choice" in a)) return this.pressKeys(["esc"]);
    const row = p.stops.find((r) => `r${r.stop}` === a.choice);
    if (!row) throw new Error(CHANGED);
    await this.pressKeys(row.key ? [row.key] : [...codexMovesTo(p, row), "enter"]);
    const reason = a.message?.trim() ?? "";
    if (reason && /^No\b/i.test(row.label)) {
      this.sent.push({ id: `reason-${Date.now()}`, text: reason, at: Date.now() });
      await this.sendReason(reason);
    }
  }

  private async answerQuestion(p: Extract<CodexPrompt, { kind: "question" }>, v: string | string[] | undefined): Promise<void> {
    if (v === undefined) return this.pressKeys(["esc"]);
    const pick = (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
    const row = p.rows.find((r) => r.label === pick);
    if (row) return this.pressKeys([...codexMovesTo(p, row), "enter"]);
    if (!pick) return this.pressKeys(["enter"]);
    if (p.freeform) {
      // The answer field: the cursor on it, then the text and Enter.
      await this.pressKeys(codexMovesTo(p, p.freeform));
      await this.screenShows((now) => now.stops.find((r) => r.selected)?.stop === p.freeform!.stop);
      return this.typeAnswer(pick);
    }
    if (p.other) {
      // None of the above with the text as its notes (Tab opens them).
      await this.pressKeys([...codexMovesTo(p, p.other), "tab"]);
      await new Promise((r) => setTimeout(r, 250));
      return this.typeAnswer(pick);
    }
    throw new Error("This question takes one of its options only.");
  }

  // ---------------------------------------------------------------- the adapter

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.watch();
    await Promise.race([this.snapshot, new Promise((r) => setTimeout(r, 5000))]);
    if (!this.live) throw new AgentError(`Terminal ${this.opts.terminal} has ended.`, true);
    await this.checkSession();
    if (!this.file && session && existsSync(session)) {
      this.file = session;
      this.thread = UUID.exec(basename(session))?.[0] ?? null;
      this.emit({ type: "session", id: this.thread, file: session });
    }
    if (!this.file) {
      this.log("no Codex conversation found yet: waiting for one");
      // Until its first turn writes one: the model it started on, as Codex picks it (models.ts).
      const tui = this.tuiPid();
      const start = tui ? startingModel(this.io.argv(tui), this.home()) : null;
      if (start?.model) this.emit({ type: "model", model: { provider: "openai", id: start.model, name: start.model, reasoning: true, contextWindow: null, input: ["text", "image"] } });
      if (start?.effort) this.emit({ type: "thinking", level: start.effort });
    }
    this.tailTimer = setInterval(() => this.tail(), TAIL_MS());
    this.tailTimer.unref();
    this.sessionTimer = setInterval(() => void this.checkSession(), SESSION_MS());
    this.sessionTimer.unref();
    const streaming = this.status === "working" || this.status === "blocked";
    if (streaming) this.running = true;
    if (this.status === "blocked") this.watchAsk();
    const hasHistory = Boolean(this.file && existsSync(this.file));
    this.awaitingHistory = Boolean(session) || hasHistory;
    return { streaming, hasHistory };
  }

  async history(): Promise<NormalizedEvent[]> {
    this.awaitingHistory = false;
    const file = this.file;
    if (!file || !existsSync(file)) return [];
    const records = rolloutRecords(file, this.home());
    // Where the live tail starts: the end of what this read (the file's own whole lines).
    this.offset = this.read(0).next;
    const past = new RolloutFollower({ history: true, readImage: readImageFile });
    const out: NormalizedEvent[] = [];
    // The model, effort and limits it had last are the chat's state, not its history: sent as they are now.
    const now = new Map<string, NormalizedEvent>();
    for (const r of records) for (const ev of past.feed(r)) {
      if (ev.type === "model" || ev.type === "thinking") now.set(ev.type, ev);
      else if (ev.type === "status") now.set(`status:${ev.key}`, ev);
      else out.push(ev);
    }
    for (const ev of now.values()) this.emit(ev);
    // A turn still running stays open for the live follower: its items come as they finish.
    out.push(...past.mapper.turnCompleted(past.thread ?? "", { status: "completed" }).filter((e) => e.type === "assistant_end"));
    this.usageNow = past.usage();
    this.follower = new RolloutFollower({ readImage: readImageFile });
    this.follower.thread = past.thread;
    this.follower.mapper.reset(past.thread);
    this.follower.model = past.model;
    this.follower.effort = past.effort;
    this.follower.contextWindow = past.contextWindow;
    this.follower.limits = past.limits;
    return out;
  }

  /** Typed into the terminal, as the person would; mid-run Codex takes it into the turn. */
  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    if (!this.live) throw new AgentError("Codex's terminal has ended.", true);
    if (!this.codexRuns()) throw new Error("Codex isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    if (p.images.length) throw new Error(NO_IMAGES);
    // `!command`: Codex runs it in a shell of its own and shows it; only at rest, as Ctrl+! does.
    const bang = /^!\s*([^\s=!][\s\S]*)$/.exec(p.text.trim());
    if (bang && this.status === "working") throw new Error(BUSY);
    const command = Boolean(bang) || /^\/\S/.test(p.text.trim());
    const text = bang ? `!${bang[1]!.trim()}` : p.text;
    const sent = { id: p.id, text: p.text, at: Date.now() };
    if (!command) this.sent.push(sent);
    const r = await this.hc(["send", "--json", this.opts.terminal, text], 70_000);
    if (r.code !== 0) {
      this.sent = this.sent.filter((x) => x !== sent);
      throw new Error(`Couldn't type into the terminal: ${sendError(r.stdout || r.stderr) || `hc exit ${r.code}`}`);
    }
    if (command) return { disposition: "handled" };
    return { disposition: p.busy ? "queued" : "started" };
  }

  async clearQueue(): Promise<string[]> {
    return [];
  }

  abort(): void {
    void this.hc(["interrupt", "--json", this.opts.terminal], 10_000).then((r) => {
      if (r.code !== 0) this.log(`interrupt: ${(r.stderr || r.stdout).trim()}`);
    });
  }

  answer(askId: string, a: AskAnswer): void {
    const ask = this.ask;
    const what = "choice" in a ? `choice ${a.choice}${a.message ? " with a reason" : ""}` : Object.keys(a).join(",");
    if (!ask || ask.id !== askId) {
      this.log(`dialog: ${what} for ${askId}, not the open one (${ask?.id ?? "none"})`);
      return;
    }
    this.log(`dialog: ${ask.prompt.kind} ${askId}: ${what}`);
    this.ask = null;
    this.answering = true;
    void this.answerAsk(ask.key, a)
      .catch((e: Error) => this.emit({ type: "notice", level: "warning", source: "host", text: `Couldn't answer in Codex's terminal: ${e.message}` }))
      .finally(() => {
        this.answering = false;
        this.askHold = Date.now() + ASK_SETTLE_MS;
      });
  }

  async dispose(): Promise<void> {
    this.kill();
  }

  kill(): void {
    this.disposed = true;
    for (const t of [this.tailTimer, this.sessionTimer, this.eventsRetry, this.askTimer]) if (t) clearTimeout(t);
    this.events?.kill();
    this.events = null;
  }

  /** Codex's /model picker's models (models.ts), and the current one if the catalog hides it. */
  async listModels(): Promise<AgentModel[]> {
    return codexModels(this.home())
      .filter((m) => m.listed || m.id === this.modelNow)
      .map((m) => ({ provider: "openai", id: m.id, name: m.name, reasoning: m.efforts.length > 0, enabled: true }));
  }

  /** The Codex TUI's process in the terminal (the foreground, or one under it). */
  private tuiPid(): number | null {
    const fg = this.fg;
    return fg ? this.io.tree(fg.pid).find((p) => isCodexTui(this.io.argv(p))) ?? null : null;
  }

  /**
   * A /model line typed into the TUI (models.ts), as the person would type it: Codex sets the model at once,
   * with no picker, and says so on its screen ("Model changed to …"), or prints why not: that refusal is this
   * one's error. Its screen answers well before `hc send` is done (it waits a few seconds for a turn the line
   * never starts); without either line on it, the send's end and a second more are the answer.
   */
  private async typeModelCommand(line: string): Promise<void> {
    if (!this.live) throw new AgentError("Codex's terminal has ended.", true);
    if (!this.codexRuns()) throw new Error("Codex isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    const before = await this.screenText();
    let sent: { code: number | null; out: string } | null = null;
    let sentAt = 0;
    void this.hc(["send", "--json", this.opts.terminal, line], 70_000).then((r) => {
      sent = { code: r.code, out: r.stdout || r.stderr };
      sentAt = Date.now();
    });
    for (const t0 = Date.now(); Date.now() - t0 < 75_000;) {
      await new Promise((res) => setTimeout(res, 250));
      const done = sent as { code: number | null; out: string } | null;
      if (done && done.code !== 0) throw new Error(`Couldn't type into the terminal: ${sendError(done.out) || `hc exit ${done.code}`}`);
      const after = await this.screenText();
      const answer = after === null ? null : modelAnswer(newLines(before, after));
      if (answer && "refused" in answer) throw new Error(`Codex: ${answer.refused}`);
      if (answer || (done && Date.now() - sentAt > 1000)) return;
    }
  }

  async setModel(_provider: string, id: string): Promise<void> {
    if (id === this.modelNow) return; // already (Codex refuses a hidden model by name, even the current one)
    const m = codexModels(this.home()).find((x) => x.id === id);
    if (!m) throw new Error(`Codex's model list has no "${id}".`);
    // The effort it has now, where the new model has it; else the model's own default (as Codex's picker does).
    const effort = this.effortNow && m.efforts.includes(this.effortNow) ? this.effortNow : m.defaultEffort;
    await this.typeModelCommand(`/model ${id}${effort ? ` --reasoning=${effort}` : ""}`);
    this.emit({ type: "model", model: { provider: "openai", id, name: id, reasoning: m.efforts.length > 0, contextWindow: m.contextWindow, input: ["text", "image"] } });
    if (effort) this.emit({ type: "thinking", level: effort });
  }

  async setThinking(level: string): Promise<void> {
    const m = this.modelNow ? codexModels(this.home()).find((x) => x.id === this.modelNow) : undefined;
    if (m?.efforts.length && !m.efforts.includes(level)) throw new Error(`${m.name} has ${m.efforts.join(", ")}.`);
    await this.typeModelCommand(`/model --reasoning=${level}`);
    this.emit({ type: "thinking", level });
  }

  async commands(): Promise<AgentCommand[]> {
    return VIEW_COMMANDS.map(([name, description]) => ({ name, description, source: "extension" as const }));
  }

  async usage(): Promise<UsageInfo> {
    const { contextTokens, contextWindow } = this.usageNow;
    const percent = contextTokens !== null && contextWindow ? Math.round((contextTokens / contextWindow) * 100) : null;
    return { contextTokens, contextWindow, percent, cost: null };
  }

  tuiCommand(): string[] {
    return [];
  }

  async setPermissionMode(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  async compact(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  async newSession(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  async switchSession(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  async setName(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  private hc(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn(this.opts.hc, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => p.kill(), timeoutMs);
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      p.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: e.message });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
