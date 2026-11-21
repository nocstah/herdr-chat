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
// Claude Code's dialogs (a tool's permission, a plan's approval, its
// questions) show in the chat as cards: while it waits (status "blocked") its
// screen is read (screen.ts), and an answer is the keys a person would press
// there (`hc keys`, a typed answer `hc send --force`). Its other screens
// (/model's picker) stay in the terminal.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { movesTo, promptKey, readPrompt } from "./screen.ts";
import type { Row, ScreenPrompt } from "./screen.ts";
import { TranscriptFollower } from "./follow.ts";
import { historyOf } from "./history.ts";
import { ClaudePlans } from "./plans.ts";
import { configDir, describeSession, sessionFiles, sessionIdOf, sessionPath } from "./sessions.ts";
import { processTree } from "../tui.ts";
import { CLAUDE_TOOLS } from "./tools.ts";
import { AgentError } from "../types.ts";
import type {
  AdapterHost, AdapterOptions, AgentCommand, AgentModel, Ask, AskAnswer, Capabilities, Disposition, ImageBlock, NormalizedEvent,
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
/** How often the screen is read while Claude Code waits on a dialog. */
const ASK_MS = () => num(process.env.HERDR_CHAT_ASK_MS, 500);
/** After an answer's keys: the screen settles before it's read again (or the old dialog would come back). */
const ASK_SETTLE_MS = 700;
const AGENT_APPS = new Set(["claude", "claude-code"]);

const NOT_HERE = "Do that in Claude Code's terminal: Ctrl+Shift+J flips to it.";
const BUSY = "Claude Code is working: run the command when it's done, or in a new tab.";
const ASKING = "Claude Code is asking something in its terminal: answer it there first (Ctrl+Shift+J shows it), then send.";
const ASKING_CARD = "Claude Code is asking something: answer its card above the composer first, then send.";
const CHANGED = "Claude Code's dialog changed in the terminal: answer the new one.";

/** A row's words and what's in brackets or after a dot: "Yes, and switch to accept edits (auto-approve file edits…)". */
function splitLabel(label: string): { label: string; description?: string } {
  const plain = label.replace(/\s*\((?:shift\+tab|tab)\)$/i, "");
  const m = /^(.+?)(?: · |\s+\()(.+)$/.exec(plain);
  if (!m) return { label: plain };
  return { label: m[1]!.trim(), description: m[2]!.replace(/[()]/g, "").replace(/\s+/g, " ").trim() };
}

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
  /** Where the images a message sends are saved for Claude Code to read (sendImages); none: no images. */
  sentDir?: string;
};

/** How long a sent image's file is kept: Claude Code reads it as the message lands; the chat shows it again from it. */
const SENT_KEEP_MS = 7 * 24 * 3600_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
/** An `@` mention of a file, as Claude Code reads it (quoted when the path has a space). */
const mention = (p: string) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);

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
    steer: true, followUp: true, thinkingLevels: [], permissions: true, permissionModes: [], extensionUi: false,
    compact: false, compactInstructions: false, rename: false, fork: false, images: true, cost: false, tui: false,
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
  /** The effort and permission mode the TUI runs with, as its records last said (shown, not set: the TUI owns them). */
  private effort: string | null = null;
  private mode: string | null = null;
  private quitSaid = false;
  /** The dialog on Claude Code's screen shown as a card (its id, what it asks, the screen read). */
  private ask: { id: string; key: string; prompt: ScreenPrompt } | null = null;
  private askSeq = 0;
  private askTimer: NodeJS.Timeout | null = null;
  private answering = false;
  private askHold = 0;
  /** Until then, a review of the answers is sent as the card's last answer leaves it (the card asked them all). */
  private autoSubmit = 0;
  /** The answer being pressed is a question's last: its review is sent once its keys are in. */
  private submitNext = false;
  private snapshot: Promise<void>;
  private gotSnapshot: () => void = () => {};

  constructor(opts: TerminalAdapterOptions) {
    this.opts = opts;
    this.snapshot = new Promise((r) => (this.gotSnapshot = r));
    if (opts.sentDir) this.pruneSent(opts.sentDir);
  }

  /** Sent images older than SENT_KEEP_MS go. */
  private pruneSent(dir: string): void {
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (/^herdr-chat-[0-9a-f]{16}\./.test(f) && Date.now() - statSync(p).mtimeMs > SENT_KEEP_MS) rmSync(p, { force: true });
      }
    } catch {}
  }

  /**
   * A message's images, for Claude Code: each saved as a file it reads as the
   * message lands, named in the message as an `@` mention (Claude Code attaches
   * an image it's pointed at; the chat shows these as the message's images,
   * sessions.ts sentImages). The mentions go first, so the cursor never ends in
   * one (Enter there could take a file suggestion instead of sending).
   */
  private sendImages(images: ImageBlock[]): string[] {
    const dir = this.opts.sentDir;
    if (!dir) throw new Error("Images can't be sent from here: paste them in Claude Code's terminal.");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return images.map((img) => {
      const p = join(dir, `herdr-chat-${randomBytes(8).toString("hex")}.${EXT[img.mimeType] ?? "png"}`);
      writeFileSync(p, Buffer.from(img.data, "base64"), { mode: 0o600 });
      return p;
    });
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
    if (state === "blocked") this.watchAsk();
    else this.closeAsk();
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

  /** The dialog on the screen now; null: none it knows; undefined: the screen couldn't be read. */
  private async screenPrompt(): Promise<ScreenPrompt | null | undefined> {
    const r = await this.hc(["read", "--json", this.opts.terminal], 5000);
    try {
      const text = JSON.parse(r.stdout)?.text;
      return typeof text === "string" ? readPrompt(text) : undefined;
    } catch {
      return undefined;
    }
  }

  private showAsk(p: ScreenPrompt | null): void {
    const key = p ? promptKey(p) : null;
    if (this.ask && key === this.ask.key) {
      this.ask.prompt = p!; // the same dialog: the card stays (the cursor may have moved)
      return;
    }
    this.closeAsk();
    if (!p || !key) return;
    // The card asked every question: the review it leads to is sent as the person's last answer was.
    if (p.kind === "review" && Date.now() < this.autoSubmit) {
      this.autoSubmit = 0;
      const send = p.rows[0]!;
      void this.pressKeys([...movesTo(p, send), "enter"]).then(() => (this.askHold = Date.now() + ASK_SETTLE_MS), (e: Error) => this.log(`review: ${e.message}`));
      this.askHold = Date.now() + ASK_SETTLE_MS;
      return;
    }
    const id = `tv-ask-${++this.askSeq}`;
    this.ask = { id, key, prompt: p };
    this.emit({ type: "ask", ask: this.askOf(id, p) });
  }

  private closeAsk(): void {
    if (!this.ask) return;
    this.emit({ type: "ask_closed", id: this.ask.id });
    this.ask = null;
  }

  /** The card for a dialog: a permission card (its rows as choices) or a question. */
  private askOf(id: string, p: ScreenPrompt): Ask {
    if (p.kind === "question") {
      const options = p.rows.filter((r) => r !== p.other).map((r) => ({ label: r.label, ...(r.description ? { description: r.description } : {}) }));
      const tabs = p.tabs ?? [];
      const header = p.header ?? (tabs.length === 1 ? tabs[0]!.label : null);
      const title = tabs.length > 1 ? `Claude Code has ${tabs.length} questions (${Math.min(tabs.filter((t) => t.answered).length + 1, tabs.length)} of ${tabs.length})` : "Claude Code has a question";
      return { id, kind: "questions", title, questions: [{ id: "q", ...(header ? { header } : {}), question: p.question, options, multiSelect: p.multi, allowOther: Boolean(p.other) }] };
    }
    let firstYes = true;
    const choice = (r: Row) => {
      const yes = /^Yes\b/i.test(r.label);
      const kind = /^(No|Cancel)\b/i.test(r.label) || /^Tell Claude what to change\b/i.test(r.label) ? "deny" as const
        : yes && firstYes ? "allow" as const
          : /^Yes, and (?:always|don't ask)/i.test(r.label) ? "allow_always" as const : "other" as const;
      if (yes) firstYes = false;
      const { label, description } = splitLabel(r.label);
      const desc = [description, r.description].filter(Boolean).join(" · ");
      return { id: `r${r.stop}`, label, kind, ...(desc ? { description: desc } : {}) };
    };
    if (p.kind === "review") {
      const message = p.answers.map((a) => `- **${a.question}** → ${a.answer}`).join("\n");
      return { id, kind: "permission", title: "Review your answers", ...(message ? { message } : {}), choices: p.rows.map((r) => ({ ...choice(r), kind: r.stop === 0 ? "allow" as const : "other" as const })) };
    }
    if (p.kind === "plan") {
      const message = this.planText(p.planFile) ?? p.body;
      return { id, kind: "permission", title: "Claude Code's plan is ready", ...(message ? { message } : {}), choices: p.rows.map(choice) };
    }
    if (p.kind === "permission") {
      const message = [p.body, `**${p.question}**`].filter(Boolean).join("\n\n");
      return { id, kind: "permission", title: p.title, message, choices: p.rows.map(choice) };
    }
    return { id, kind: "permission", title: p.title, ...(p.body ? { message: p.body } : {}), choices: p.rows.map(choice) };
  }

  /** A plan's file, as Claude Code wrote it (the screen shows its end when it's long). */
  private planText(file: string | null): string | null {
    if (!file) return null;
    const home = (this.agent && envOf(this.agent.pid, "HOME")) || homedir();
    const path = file.startsWith("~/") ? join(home, file.slice(2)) : file;
    try {
      if (statSync(path).size > 256 * 1024) return null;
      return readFileSync(path, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private async pressKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    this.log(`dialog: keys ${keys.join(" ")}`);
    const r = await this.hc(["keys", "--json", this.opts.terminal, ...keys], 10_000);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc keys: exit ${r.code}`);
  }

  /**
   * Until the screen shows what the keys before did (the cursor on a row, a row
   * that takes text): Claude Code can take a paste before it draws a move, and
   * the paste and its Enter would land on the row the cursor left.
   */
  private async screenShows(what: (p: ScreenPrompt) => boolean, ms = 2500): Promise<ScreenPrompt> {
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 80))) {
      const p = await this.screenPrompt();
      if (p && what(p)) return p;
      if (Date.now() - t0 > ms) throw new Error("Claude Code didn't take the keys: answer in its terminal (Ctrl+Shift+J)");
    }
  }

  private async moveThenType(p: ScreenPrompt, row: Row, text: string, extra: string[] = []): Promise<void> {
    await this.pressKeys([...movesTo(p, row), ...extra]);
    await this.screenShows((now) => now.stops.find((r) => r.selected)?.stop === row.stop && (!extra.length || Boolean(now.stops[row.stop]?.input)));
    await this.typeAnswer(text);
  }

  /** Typed into the row the cursor is on (Type something, a reason), and Enter. */
  private async typeAnswer(text: string): Promise<void> {
    this.log(`dialog: typed ${text.length} chars`);
    const r = await this.hc(["send", "--json", "--force", this.opts.terminal, text.replace(/\s*\n\s*/g, " ").trim()], 20_000);
    if (r.code !== 0) throw new Error(sendError(r.stdout || r.stderr) || `hc send: exit ${r.code}`);
  }

  private async answerAsk(key: string, a: AskAnswer): Promise<void> {
    // The screen as it is now: the cursor may have moved, and it must still be the dialog the card showed.
    const p = await this.screenPrompt();
    if (!p || promptKey(p) !== key) throw new Error(CHANGED);
    if ("cancelled" in a) return this.pressKeys(["esc"]);
    if (p.kind === "question") return this.answerQuestion(p, "answers" in a ? a.answers.q : undefined);
    if (!("choice" in a)) return this.pressKeys(["esc"]);
    const row = p.stops.find((r) => `r${r.stop}` === a.choice);
    if (!row) throw new Error(CHANGED);
    const reason = a.message?.trim() ?? "";
    if (row.input) {
      // Tell Claude what to change: what to change goes in the row; none, and Esc keeps it planning.
      if (!reason) return this.pressKeys(["esc"]);
      return this.moveThenType(p, row, reason);
    }
    if (reason && p.kind === "permission" && /^No\b/i.test(row.label)) {
      // Tab makes "No" take a reason: "No, and tell Claude what to do differently".
      return this.moveThenType(p, row, reason, ["tab"]);
    }
    return this.pressKeys([...movesTo(p, row), "enter"]);
  }

  private async answerQuestion(p: Extract<ScreenPrompt, { kind: "question" }>, v: string | string[] | undefined): Promise<void> {
    if (v === undefined) return this.pressKeys(["esc"]);
    const picks = (Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter(Boolean);
    const options = p.rows.filter((r) => r !== p.other);
    const typed = picks.filter((x) => !options.some((r) => r.label === x)).join(", ");
    if (typed && !p.other) throw new Error("This question takes one of its options only.");
    // Its last question: Claude Code shows the answers to send next (a review), which goes as this answer does.
    if (p.tabs && p.tabs.filter((t) => !t.answered).length <= 1) this.submitNext = true;
    if (!p.multi) {
      const row = options.find((r) => r.label === picks[0]);
      if (row) return this.pressKeys([...movesTo(p, row), "enter"]);
      return this.moveThenType(p, p.other!, typed);
    }
    // A multiple choice: each box as the answer has it, what was typed in its own row, then Submit.
    const keys: string[] = [];
    let at = p.stops.find((r) => r.selected)?.stop ?? 0;
    const move = (to: number) => {
      for (; at !== to; at += to > at ? 1 : -1) keys.push(to > at ? "down" : "up");
    };
    for (const r of options) if (Boolean(r.checked) !== picks.includes(r.label)) {
      move(r.stop);
      keys.push("enter");
    }
    await this.pressKeys(keys);
    if (typed) {
      const other = p.other!;
      const moved = await this.screenShows((now) => now.stops.find((r) => r.selected)?.stop === at);
      await this.moveThenType(moved, other, typed);
      // Enter after the text can leave its box empty: tick it.
      const now = await this.screenShows((x) => x.kind === "question" && x.stops[other.stop]?.label !== "Type something");
      const box = now.stops[other.stop]!;
      if (!box.checked) await this.pressKeys([...movesTo(now, box), "enter"]);
    }
    // Submit, once the boxes show as the answer has them.
    const now = await this.screenShows((x) => x.kind === "question" && Boolean(x.submit) && x.rows.filter((r) => r !== x.other).every((r) => Boolean(r.checked) === picks.includes(r.label)));
    if (now.kind !== "question" || !now.submit) throw new Error(CHANGED);
    await this.pressKeys([...movesTo(now, now.submit), "enter"]);
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
      // Its own config folder: from its environment (CLAUDE_CONFIG_DIR, else its HOME's), as it resolves it.
      const home = envOf(pid, "HOME");
      const dir = this.agent?.pid === pid ? this.agent.dir : envOf(pid, "CLAUDE_CONFIG_DIR") ?? (home ? join(home, ".claude") : configDir());
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
      this.noteSettings(r);
      for (const ev of this.follower.feed(r)) {
        if (ev.type === "assistant_end" && !ev.parent) ended = ev.stopReason !== "toolUse";
        else if (ev.type === "tool_call" || ev.type === "user_message") ended = false;
        this.emit(this.matchEcho(ev));
      }
    }
    // A turn that ended while the terminal never showed it working (a quick answer, a local command's output).
    if (ended && this.running && this.status !== "working" && this.status !== "blocked") this.settle();
  }

  /** Claude Code writes its effort on each reply (`effort`) and its permission mode on each prompt and mode
   * switch (`permissionMode`, also a "permission-mode" record): the view shows them beside the model. */
  private noteSettings(r: Rec): void {
    if (r.isSidechain) return;
    if (r.type === "assistant" && typeof r.effort === "string" && r.effort && r.effort !== this.effort) {
      this.effort = r.effort;
      this.emit({ type: "thinking", level: r.effort });
    }
    if ((r.type === "user" || r.type === "permission-mode") && typeof r.permissionMode === "string" && r.permissionMode && r.permissionMode !== this.mode) {
      this.mode = r.permissionMode;
      this.emit({ type: "permission_mode", mode: r.permissionMode });
    }
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
    if (this.status === "blocked") this.watchAsk();
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
    for (const r of records) {
      if (r.type === "assistant" && !r.isSidechain) this.noteModel(r.message ?? {});
      this.noteSettings(r);
    }
    this.plans = new ClaudePlans();
    return this.plans.replay(historyOf(records, file));
  }

  /** Typed into the terminal, as the person would; Claude Code takes a message mid-run and queues it itself. */
  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    if (!this.live) throw new AgentError("Claude Code's terminal has ended.", true);
    if (!this.registry()) throw new Error("Claude Code isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    // Typing would answer its question (hc send refuses too).
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    // `!command`: Claude Code's bash mode runs it in the agent's shell, and the agent sees what it
    // printed; it comes back as a Bash card (sessions.ts bashEvents). Only at rest, as Ctrl+! does.
    const bang = /^!\s*([^\s=!][\s\S]*)$/.exec(p.text.trim());
    if (bang && this.status === "working") throw new Error(BUSY);
    // A command is the TUI's (its screen, or a run it starts itself): what it writes shows as it comes.
    const command = Boolean(bang) || /^\/\S/.test(p.text.trim());
    if (command && p.images.length) throw new Error("Images go with a message, not a command: send them on their own or with words.");
    const files = p.images.length ? this.sendImages(p.images) : [];
    const words = p.text.trim() ? p.text : files.length ? "" : p.text;
    const text = bang ? `!${bang[1]!.trim()}` : files.length ? `${files.map(mention).join(" ")} ${words}`.trimEnd() + (words ? "" : " ") : p.text;
    // Noted before it's typed: the TUI writes its echo as Enter lands, before `hc send` returns.
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
    return []; // typed already: the TUI has it
  }

  abort(): void {
    void this.hc(["interrupt", "--json", this.opts.terminal], 10_000).then((r) => {
      if (r.code !== 0) this.log(`interrupt: ${(r.stderr || r.stdout).trim()}`);
    });
  }

  /** A card's answer: the keys a person would press in the terminal. */
  answer(askId: string, a: AskAnswer): void {
    const ask = this.ask;
    const what = "choice" in a ? `choice ${a.choice}${a.message ? " with a reason" : ""}` : Object.keys(a).join(",");
    if (!ask || ask.id !== askId) {
      this.log(`dialog: ${what} for ${askId}, not the open one (${ask?.id ?? "none"})`);
      return;
    }
    this.log(`dialog: ${ask.prompt.kind} ${askId}: ${what}`);
    this.ask = null; // the card is gone; the poll shows it again if the dialog stays
    this.answering = true;
    void this.answerAsk(ask.key, a)
      .then(() => {
        if (this.submitNext) this.autoSubmit = Date.now() + 4000;
      })
      .catch((e: Error) => {
        this.autoSubmit = 0;
        this.emit({ type: "notice", level: "warning", source: "host", text: `Couldn't answer in Claude Code's terminal: ${e.message}` });
      })
      .finally(() => {
        this.submitNext = false;
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
