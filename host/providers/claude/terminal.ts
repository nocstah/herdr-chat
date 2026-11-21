// Claude Code as the person's own TUI in a Herdr terminal, shown as a chat:
// the terminal view (Ctrl+Shift+J flips a Claude Code terminal to it and
// back). Nothing here runs Claude. The TUI stays the one process on the
// session, so the chat and the terminal show the same agent and a flip
// changes nothing:
//
// - the terminal: `hc events --terminal <t>` gives its agent status (the run
//   starts and settles with it), its foreground process and its end;
// - the session: Claude Code's registry of live processes
//   (<config>/sessions/<pid>.json, kept current, so a /clear or /resume in
//   the terminal moves the chat along), in that process's own config folder;
// - the timeline: the transcript as it grows (follow.ts);
// - sending: `hc send`, which pastes and presses Enter as the person would;
//   stopping: `hc interrupt` (the agent's stop key).
//
// What the TUI does on its own screen (permission prompts, /model's picker)
// stays there: the chat has no asks or pickers of its own here.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { TranscriptFollower } from "./follow.ts";
import { historyOf } from "./history.ts";
import { ClaudePlans } from "./plans.ts";
import { configDir, describeSession, sessionFiles, sessionIdOf, sessionPath } from "./sessions.ts";
import { processTree } from "../tui.ts";
import { CLAUDE_TOOLS } from "./tools.ts";
import { AgentError } from "../types.ts";
import type {
  AdapterHost, AdapterOptions, AgentCommand, AgentModel, AskAnswer, Capabilities, Disposition, ImageBlock, NormalizedEvent,
  PromptMode, ProviderAdapter, SessionSource, StartInfo, UsageInfo,
} from "../types.ts";

type Rec = Record<string, any>;
type Fg = { pid: number; name: string | null; argv: string[] };

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
/** How often the transcript is looked at (a stat; a read only when it grew). */
const TAIL_MS = () => num(process.env.HERDR_CHAT_TAIL_MS, 150);
/** How often the registry is read for the session the TUI has open. */
const SESSION_MS = () => num(process.env.HERDR_CHAT_SESSION_MS, 1000);
const SENT_TTL_MS = 10 * 60_000;
const AGENT_APPS = new Set(["claude", "claude-code"]);

const NOT_HERE = "Do that in Claude Code's terminal: Ctrl+Shift+J flips to it.";
const ASKING = "Claude Code is asking something in its terminal: answer it there first (Ctrl+Shift+J shows it), then send.";

/** Why `hc send` refused, in words (it prints {"error": {kind, message, hint}}). */
function sendError(out: string): string {
  try {
    const e = JSON.parse(out.trim().split("\n").pop() ?? "")?.error;
    if (e?.kind === "blocked") return ASKING;
    if (typeof e?.message === "string") return e.message;
  } catch {}
  return out.trim();
}

/**
 * Claude Code's own commands, for the slash menu: typed into the TUI like any
 * message (the chat flips to the terminal for the ones that open a screen
 * there, mods/chat). Its skills and plugins' commands work typed too.
 */
const VIEW_COMMANDS: [string, string][] = [
  ["model", "Pick the model (in the terminal)"],
  ["compact", "Compact the conversation"],
  ["clear", "Start a new conversation"],
  ["resume", "Resume another conversation (in the terminal)"],
  ["rewind", "Go back to an earlier point (in the terminal)"],
  ["context", "Show what fills the context"],
  ["cost", "Show this session's cost and time"],
  ["usage", "Show the plan's usage limits"],
  ["config", "Settings (in the terminal)"],
  ["permissions", "Allow and deny rules (in the terminal)"],
  ["agents", "Subagents (in the terminal)"],
  ["mcp", "MCP servers (in the terminal)"],
  ["memory", "Edit CLAUDE.md memory"],
  ["init", "Write a CLAUDE.md for this project"],
  ["review", "Review a pull request"],
  ["export", "Export the conversation"],
  ["status", "Version, model and account (in the terminal)"],
  ["help", "Claude Code's help (in the terminal)"],
];

export type TerminalAdapterOptions = AdapterOptions & {
  /** The terminal the TUI runs in (`t7`, as the host's core names it). */
  terminal: string;
  hc: string;
};

/** A process's CLAUDE_CONFIG_DIR (Linux: its environment), else null. */
function envOf(pid: number, name: string): string | null {
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) if (kv.startsWith(`${name}=`)) return kv.slice(name.length + 1) || null;
  } catch {}
  return null;
}

/** The text a prompt record and a sent message are compared by. */
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export class ClaudeTerminalAdapter implements ProviderAdapter {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly tools = CLAUDE_TOOLS;
  readonly capabilities: Capabilities = {
    steer: true, followUp: true, thinkingLevels: [], permissions: false, permissionModes: [], extensionUi: false,
    compact: false, compactInstructions: false, rename: false, fork: false, images: false, cost: false, tui: false,
  };
  readonly sessions: SessionSource = { kind: "files", files: (_current, scope) => sessionFiles(this.opts.cwd, scope), describe: describeSession };

  private opts: TerminalAdapterOptions;
  private host: AdapterHost | null = null;
  private events: ChildProcessWithoutNullStreams | null = null;
  private eventsRetry: NodeJS.Timeout | null = null;
  private tailTimer: NodeJS.Timeout | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  /** The terminal is live (its program may have quit back to the shell). */
  private live = true;
  private status: string | null = null;
  private fg: Fg | null = null;
  /** The Claude Code process on the terminal (found in the registry), and its config folder. */
  private agent: { pid: number; dir: string } | null = null;
  private file: string | null = null;
  private follower: TranscriptFollower | null = null;
  private offset = 0;
  private plans = new ClaudePlans();
  /** The core reads this session's history next (start, or a session change): the tail waits for it, or it would show the session again as live. */
  private awaitingHistory = false;
  private running = false;
  private sent: { id: string; text: string; at: number }[] = [];
  private model: string | null = null;
  private lastUsage: Rec | null = null;
  private quitSaid = false;
  private snapshot: Promise<void>;
  private gotSnapshot: () => void = () => {};

  constructor(opts: TerminalAdapterOptions) {
    this.opts = opts;
    this.snapshot = new Promise((r) => (this.gotSnapshot = r));
  }

  get alive(): boolean {
    return this.live && !this.disposed;
  }

  private emit(ev: NormalizedEvent): void {
    if (this.disposed) return;
    this.host?.emit(ev);
    const plan = ev.type === "tool_call" || ev.type === "tool_ended" ? this.plans.observe(ev) : null;
    if (plan) this.host?.emit(plan);
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
      // The core restarted: follow again (a fresh snapshot comes first).
      if (!this.disposed) this.eventsRetry = setTimeout(() => this.watch(), 1000).unref() as NodeJS.Timeout;
    });
    p.stdin.on("error", () => {});
  }

  private onEvent(m: Rec): void {
    if (Array.isArray(m.terminals)) {
      const t = m.terminals.find((x: Rec) => x?.address === this.opts.terminal);
      if (!t) {
        this.gone("isn't in the core");
      } else {
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
    // Its program exited (`turn` events carry an agent's turn state, not the terminal's).
    else if (p.type === "finished" || p.type === "removed") this.gone(`${p.type} (${d.reason ?? d.exit_code ?? "-"})`);
  }

  private foreground(f: Rec | null): void {
    const fg: Fg | null = f && Number(f.pid) > 0 ? { pid: Number(f.pid), name: typeof f.name === "string" ? f.name : null, argv: Array.isArray(f.argv) ? f.argv.map(String) : [] } : null;
    if (fg?.pid === this.fg?.pid) return;
    this.fg = fg;
    this.agent = null;
    if (this.host) this.checkSession();
  }

  private onStatus(s: Rec | null): void {
    const app = typeof s?.app === "string" ? s.app : null;
    const state = s && (!app || AGENT_APPS.has(app)) && typeof s.state === "string" ? s.state : null;
    if (state === this.status) return;
    this.status = state;
    if (!this.host) return;
    if (state === "working" || state === "blocked") this.runOn();
    else this.settle();
  }

  private gone(why: string): void {
    if (!this.live) return;
    this.live = false;
    this.log(why);
    this.settle();
    this.emit({ type: "notice", level: "warning", source: "host", text: "Claude Code's terminal has ended." });
  }

  private runOn(): void {
    if (this.running) return;
    this.running = true;
    this.emit({ type: "run_started" });
  }

  private settle(): void {
    if (!this.running) return;
    this.tail(); // what it wrote last
    for (const ev of this.follower?.close() ?? []) this.emit(ev);
    this.running = false;
    this.emit({ type: "run_settled", aborted: false });
  }

  // ---------------------------------------------------------------- the session

  /** The Claude Code process on the terminal (the foreground or one under it) and the session it has open, from its registry entry. */
  private registry(): { pid: number; dir: string; id: string; cwd: string } | null {
    const fg = this.fg;
    if (!fg) return null;
    const pids = this.agent ? [this.agent.pid] : processTree(fg.pid);
    for (const pid of pids) {
      const dir = this.agent?.pid === pid ? this.agent.dir : envOf(pid, "CLAUDE_CONFIG_DIR") ?? configDir();
      try {
        const r = JSON.parse(readFileSync(join(dir, "sessions", `${pid}.json`), "utf8"));
        if (typeof r?.sessionId !== "string") continue;
        this.agent = { pid, dir };
        return { pid, dir, id: r.sessionId, cwd: typeof r.cwd === "string" ? r.cwd : this.opts.cwd };
      } catch {}
    }
    return null;
  }

  private checkSession(): void {
    const r = this.registry();
    if (!r) {
      // Back at the shell: say so once; sends are refused until Claude Code runs again.
      if (this.fg && !this.quitSaid && this.file) {
        this.quitSaid = true;
        this.settle();
        this.emit({ type: "notice", level: "info", source: "host", text: "Claude Code quit in its terminal. Start it there again and this view follows it." });
      }
      return;
    }
    this.quitSaid = false;
    const file = sessionPath(r.cwd, r.id, r.dir);
    if (file === this.file) return;
    const first = this.file === null;
    this.log(`session ${r.id} (pid ${r.pid})`);
    this.file = file;
    this.follower = null;
    this.offset = 0;
    this.plans = new ClaudePlans();
    // The core reads the new session's history (history()), and the follower starts from there.
    if (!first) this.awaitingHistory = true;
    this.emit({ type: "session", id: r.id, file, ...(first ? {} : { reload: true }) });
  }

  // ---------------------------------------------------------------- the transcript

  /** The transcript's whole lines from `from`, and where the next read starts (after the last newline). */
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

  private parse(lines: string[]): Rec[] {
    const out: Rec[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l);
        if (r && typeof r === "object") out.push(r);
      } catch {}
    }
    return out;
  }

  /** New records since the last look: their events. */
  private tail(): void {
    if (!this.file || this.disposed || this.awaitingHistory) return;
    if (!this.follower) {
      // No history was read (the session had no transcript yet): from its start.
      if (!existsSync(this.file)) return;
      this.follower = new TranscriptFollower(this.file);
      this.offset = 0;
    }
    try {
      if (statSync(this.file).size < this.offset) {
        // Rewritten (not appended): from the start again, records already shown are skipped.
        this.offset = 0;
      }
    } catch {
      return;
    }
    const { lines, next } = this.read(this.offset);
    this.offset = next;
    let ended = false;
    for (const r of this.parse(lines)) {
      if (r.type === "assistant" && !r.isSidechain) this.noteModel(r.message ?? {});
      for (const ev of this.follower.feed(r)) {
        if (ev.type === "assistant_end" && !ev.parent) ended = ev.stopReason !== "toolUse";
        else if (ev.type === "tool_call" || ev.type === "user_message") ended = false;
        this.emit(this.matchEcho(ev));
      }
    }
    // A turn that ended while the terminal never showed it working (a quick answer, a local command's output).
    if (ended && this.running && this.status !== "working" && this.status !== "blocked") this.settle();
  }

  private noteModel(m: Rec): void {
    if (m.usage && typeof m.usage === "object" && m.model !== "<synthetic>") this.lastUsage = m.usage;
    if (typeof m.model !== "string" || m.model === "<synthetic>" || m.model === this.model) return;
    this.model = m.model;
    this.emit({ type: "model", model: { provider: "anthropic", id: m.model, name: m.model, reasoning: true, contextWindow: null, input: ["text"] } });
  }

  /** A prompt record that is a message this chat sent: the echo that confirms it. */
  private matchEcho(ev: NormalizedEvent): NormalizedEvent {
    if (ev.type !== "user_message") return ev;
    if (!this.running) this.runOn();
    const now = Date.now();
    this.sent = this.sent.filter((s) => now - s.at < SENT_TTL_MS);
    const i = this.sent.findIndex((s) => norm(s.text) === norm(ev.text));
    if (i < 0) return { ...ev, source: "external" };
    const [s] = this.sent.splice(i, 1);
    // An echo carries only its message's id: the core confirms the item it showed at send (chat.ts onUserEcho).
    return { ...ev, clientId: s!.id };
  }

  // ---------------------------------------------------------------- the adapter

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.watch();
    await Promise.race([this.snapshot, new Promise((r) => setTimeout(r, 5000))]);
    if (!this.live) throw new AgentError(`Terminal ${this.opts.terminal} has ended.`, true);
    this.checkSession();
    if (!this.file && session) {
      this.file = session;
      this.emit({ type: "session", id: sessionIdOf(session), file: session });
    }
    if (!this.file) this.log("no Claude Code session found yet: waiting for one");
    this.tailTimer = setInterval(() => this.tail(), TAIL_MS());
    this.tailTimer.unref();
    this.sessionTimer = setInterval(() => this.checkSession(), SESSION_MS());
    this.sessionTimer.unref();
    const streaming = this.status === "working" || this.status === "blocked";
    if (streaming) this.running = true;
    const hasHistory = Boolean(this.file && existsSync(this.file));
    // The core reads the history when it started on a session or there is one (chat.ts boot).
    this.awaitingHistory = Boolean(session) || hasHistory;
    return { streaming, hasHistory };
  }

  async history(): Promise<NormalizedEvent[]> {
    this.awaitingHistory = false;
    const file = this.file;
    if (!file || !existsSync(file)) return [];
    const { lines, next } = this.read(0);
    const records = this.parse(lines);
    this.offset = next;
    this.follower = new TranscriptFollower(file);
    this.follower.prime(records);
    for (const r of records) if (r.type === "assistant" && !r.isSidechain) this.noteModel(r.message ?? {});
    this.plans = new ClaudePlans();
    return this.plans.replay(historyOf(records, file));
  }

  /** Typed into the terminal, as the person would; Claude Code takes a message mid-run and queues it itself. */
  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    if (!this.live) throw new AgentError("Claude Code's terminal has ended.", true);
    if (!this.registry()) throw new Error("Claude Code isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (p.images.length) throw new Error("Images can't be sent from here: paste them in Claude Code's terminal.");
    // Typing would answer its question (hc send refuses too).
    if (this.status === "blocked") throw new Error(ASKING);
    // A command is the TUI's (its screen, or a run it starts itself): what it writes shows as it comes.
    const command = /^\/\S/.test(p.text.trim());
    // Noted before it's typed: the TUI writes its echo as Enter lands, before `hc send` returns.
    const sent = { id: p.id, text: p.text, at: Date.now() };
    if (!command) this.sent.push(sent);
    const r = await this.hc(["send", "--json", this.opts.terminal, p.text], 70_000);
    if (r.code !== 0) {
      this.sent = this.sent.filter((x) => x !== sent);
      throw new Error(`Couldn't type into the terminal: ${sendError(r.stdout || r.stderr) || `hc exit ${r.code}`}`);
    }
    if (command) return { disposition: "handled" };
    return { disposition: p.busy ? "queued" : "started" };
  }

  async clearQueue(): Promise<string[]> {
    return []; // typed already: the TUI has it
  }

  abort(): void {
    void this.hc(["interrupt", "--json", this.opts.terminal], 10_000).then((r) => {
      if (r.code !== 0) this.log(`interrupt: ${(r.stderr || r.stdout).trim()}`);
    });
  }

  answer(_askId: string, _answer: AskAnswer): void {}

  async dispose(): Promise<void> {
    this.kill();
  }

  kill(): void {
    this.disposed = true;
    for (const t of [this.tailTimer, this.sessionTimer, this.eventsRetry]) if (t) clearTimeout(t);
    this.events?.kill();
    this.events = null;
  }

  async listModels(): Promise<AgentModel[]> {
    return [];
  }

  async commands(): Promise<AgentCommand[]> {
    return VIEW_COMMANDS.map(([name, description]) => ({ name, description, source: "extension" as const }));
  }

  async usage(): Promise<UsageInfo> {
    const u = this.lastUsage;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const tokens = u ? n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) : null;
    return { contextTokens: tokens, contextWindow: null, percent: null, cost: null };
  }

  tuiCommand(): string[] {
    return [];
  }

  async setModel(): Promise<void> {
    throw new Error(NOT_HERE);
  }

  async setThinking(): Promise<void> {
    throw new Error(NOT_HERE);
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
