// Antigravity CLI (`agy`) as the person's own TUI in a Herdr terminal, shown as
// a chat: the terminal view (Ctrl+Shift+J flips an Antigravity terminal to it
// and back), as providers/claude/terminal.ts and providers/codex/terminal.ts do.
// Nothing here runs `agy`. The TUI stays the single owner of its conversation,
// so the chat and the terminal show the same agent and a flip changes nothing:
//
// - the terminal: `hc events --terminal <t>` gives its agent status (the run
//   starts and settles with it), its foreground process and its end;
// - the conversation: the lock (`presence/<id>.lock`) or conversation DB
//   (`conversations/<id>.db`) the `agy` process holds open (bind.ts), checked
//   every 1.5 s so /new, /clear or /resume in the terminal moves the chat along;
// - the timeline: `brain/<id>/.system_generated/logs/transcript.jsonl` as it
//   grows (items.ts), with decoded tool args, edit diffs, thinking and usage;
// - sending: `hc send` (paste and Enter, as the person would); stopping:
//   `hc interrupt`;
// - dialogs: while blocked, its screen is read (screen.ts) and answered via
//   `hc keys` / `hc send --force`;
// - pickers: model (`agy models`, `/model <id>`), effort (`/effort <level>`),
//   and permission mode (`Shift+Tab` verified against the status bar).
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { bindConversation, isAgyTui, LINUX_IO } from "./bind.ts";
import type { AgyBindIO, AgyBinding } from "./bind.ts";
import { AgyTranscriptFollower, modelInfoOf } from "./items.ts";
import { commandAnswer, EFFORT_ORDER, findModelGroup, newLines, parseModelLabel, parseModelsOutput, startingState } from "./models.ts";
import type { AgyModelGroup } from "./models.ts";
import { agyAtPrompt, agyMovesTo, agyPromptKey, extractAgyShellOutput, parseAgyPermissionBody, readAgyInterrupted, readAgyPrompt, readAgyQuotaWarning, readAgyRunningCommand, readAgySendNowKey, readAgyStatusBar, readAgyWorkingStatus } from "./screen.ts";
import type { AgyMode, AgyPrompt, AgyRow } from "./screen.ts";
import { sendAgyBang } from "./bang.ts";
import {
  buildSwarmActionPrompt,
  materializeSwarmFrames,
  parseSwarmAction,
  readSwarmMemberTranscript,
  readSwarmSnapshot,
} from "./swarm.ts";
import type { SwarmActionRequest, SwarmMemberTranscript, SwarmSnapshot } from "./swarm.ts";
import { ANTIGRAVITY_TOOLS } from "./tools.ts";
import { firstLine } from "../../tools.ts";
import { imageLines, pruneImages, saveImages, withImageLines } from "../sent-images.ts";
import { waitForPrompt } from "../prompt-wait.ts";
import type { PromptWait } from "../prompt-wait.ts";
import { AgentError } from "../types.ts";
import type {
  AdapterHost, AdapterOptions, AgentCommand, AgentModel, Ask, AskAnswer, Capabilities, Disposition, ImageBlock,
  NormalizedEvent, PermissionMode, PromptMode, ProviderAdapter, QuotaWarning, SessionSource, StartInfo, UsageInfo,
} from "../types.ts";

type Rec = Record<string, any>;
type Fg = { pid: number; name: string | null; argv: string[] };

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const TAIL_MS = () => num(process.env.HERDR_CHAT_TAIL_MS, 150);
const SESSION_MS = () => num(process.env.HERDR_CHAT_SESSION_MS, 1500);
const ASK_MS = () => num(process.env.HERDR_CHAT_ASK_MS, 500);
const WORK_STATUS_MS = () => num(process.env.HERDR_CHAT_WORK_STATUS_MS, 500);
const BANG_POLL_MS = () => num(process.env.HERDR_CHAT_BANG_POLL_MS, 300);
const BANG_SLOW_MS = () => Math.max(BANG_POLL_MS(), Math.round(BANG_POLL_MS() * 2.2));
const BANG_FAST_WINDOW_MS = 4_000;
const BANG_SETTLE_ACTIVE_MS = () => Math.max(60, Math.round(BANG_POLL_MS() * 1.5));
const BANG_SETTLE_OUTPUT_MS = () => Math.max(90, Math.round(BANG_POLL_MS() * 2.5));
const BANG_SETTLE_QUIET_MS = () => Math.max(180, Math.round(BANG_POLL_MS() * 7));
const BANG_MAX_MS = 120_000;
const BANG_DEDUP_TTL_MS = 60_000;
const ASK_SETTLE_MS = 700;
const SENT_TTL_MS = 10 * 60_000;
const MODELS_TTL_MS = 60_000;
const AGENT_APPS = new Set(["antigravity", "agy"]);
const COMPACT_WS = /\s+/g;
const TRUNCATED_RE = /<truncated \d+ bytes>/;
const FULL_WAIT_MS = 1500;

/** Sibling `transcript_full.jsonl` written beside Antigravity's compact `transcript.jsonl`, or null. */
export function fullTranscriptPath(path: string): string | null {
  const next = path.replace(/([/\\])transcript\.jsonl$/, "$1transcript_full.jsonl");
  return next !== path ? next : null;
}

/** Whether a compact transcript record had one or more fields truncated into `transcript_full.jsonl`. */
function isTruncatedRecord(r: Rec): boolean {
  if (Array.isArray(r.truncated_fields) && r.truncated_fields.length > 0) return true;
  if (typeof r.content === "string" && TRUNCATED_RE.test(r.content)) return true;
  if (typeof r.thinking === "string" && TRUNCATED_RE.test(r.thinking)) return true;
  return false;
}

/** Shorten Antigravity's verbose always-allow prefix choice labels while preserving the full text as tooltip description. */
function formatAgyChoiceLabel(raw: string): { label: string; description?: string } {
  const compact = (prefix: string) => {
    const unquoted = prefix.trim().replace(/^(['"])(.*)\1$/, "$2").replace(/\s+/g, " ").trim();
    const short = unquoted.length > 34 ? `${unquoted.slice(0, 33).trimEnd()}…` : unquoted;
    return `'${short}'`;
  };
  const conv = /^Yes,\s+and\s+always\s+allow\s+in\s+this\s+conversation\s+for\s+commands\s+that\s+start\s+with\s+(.+)$/i.exec(raw);
  if (conv) return { label: `Always allow ${compact(conv[1]!)} (this chat)`, description: raw };
  const persist = /^Yes,\s+and\s+always\s+allow\s+for\s+commands\s+that\s+start\s+with\s+(.+?)(?:\s*\(([^)]+)\))?$/i.exec(raw);
  if (persist) {
    const scope = persist[2]?.trim() ? ` (${persist[2].trim()})` : "";
    return { label: `Always allow ${compact(persist[1]!)}${scope}`, description: raw };
  }
  return { label: raw };
}

const NOT_HERE = "Do that in Antigravity's terminal: Ctrl+Shift+J flips to it.";
const BUSY = "Antigravity is working: run the command when it's done, or in a new tab.";
const ASKING = "Antigravity is asking something in its terminal: answer it there first (Ctrl+Shift+J shows it), then send.";
const ASKING_CARD = "Antigravity is asking something: answer its card above the composer first, then send.";
const CHANGED = "Antigravity's dialog changed in the terminal: answer the new one.";
const NO_IMAGES = "Images can't be sent from here: paste them in Antigravity's terminal (Ctrl+Shift+J shows it).";

const MODES: PermissionMode[] = [
  { id: "default", label: "Manual", description: "Ask before editing files or running commands" },
  { id: "accept-edits", label: "Accept edits", description: "Auto-approve workspace edits; ask before commands" },
  { id: "auto", label: "Auto", description: "Auto-approve edits and safe commands in sandbox" },
  { id: "plan", label: "Plan", description: "Research and outline a plan before editing" },
];

const VIEW_COMMANDS: [string, string][] = [
  ["model", "Pick the model"],
  ["effort", "Set reasoning effort (low, medium, high, xhigh, max)"],
  ["plan", "Explore and draft an implementation plan"],
  ["clear", "Start a new conversation"],
  ["new", "Start a new conversation"],
  ["resume", "Resume another conversation (in the terminal)"],
  ["fork", "Fork this conversation"],
  ["compact", "Compact the conversation"],
  ["config", "Settings (in the terminal)"],
  ["permissions", "Allow, ask and deny rules (in the terminal)"],
  ["diff", "Show changes, turns and commits (in the terminal)"],
  ["context", "Show context usage (in the terminal)"],
  ["mcp", "MCP servers (in the terminal)"],
  ["hooks", "Active hooks (in the terminal)"],
  ["plugin", "Plugins manager (in the terminal)"],
  ["agents", "Agents (in the terminal)"],
  ["artifact", "Artifact review panel (in the terminal)"],
  ["btw", "Ask a quick side question"],
  ["goal", "Run autonomously until the goal is verified"],
  ["grill-me", "Clarify requirements before starting"],
  ["learn", "Capture corrections as rules or skills"],
  ["boost", "Run multi-agent deep reasoning"],
  ["swarm", "Launch or manage a parallel multi-agent swarm"],
  ["credits", "View remaining AI credits (in the terminal)"],
  ["help", "Antigravity's help (in the terminal)"],
  ["exit", "Quit Antigravity"],
];

function sendError(out: string): string {
  try {
    const e = JSON.parse(out.trim().split("\n").pop() ?? "")?.error;
    if (e?.kind === "blocked") return ASKING;
    if (typeof e?.message === "string") return e.message;
  } catch {}
  return out.trim();
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** A message's images named via sent-images.ts: shown as the message's images, without the marker lines. */
function withImages(ev: NormalizedEvent): NormalizedEvent {
  if (ev.type !== "user_message") return ev;
  const m = imageLines(ev.text);
  if (!m.images.length) return ev;
  const images = [...(ev.imageBlocks ?? []), ...m.images];
  return { ...ev, text: m.text, images: images.length, imageBlocks: images };
}

export type AntigravityTerminalOptions = AdapterOptions & {
  /** The terminal the TUI runs in (`t7`, as the host's core names it). */
  terminal: string;
  hc: string;
  /** Injectable /proc reader for tests. */
  io?: AgyBindIO;
  /** Where sent images are saved for `agy` to read via read_file (sent-images.ts). */
  sentDir?: string;
  /** Where host-generated images and materialized swarm screenshots go (<stateDir>/images/<chat>). */
  imageDir?: string;
  /** Optional model-list fetcher override for tests. */
  fetchModels?: () => Promise<AgyModelGroup[]>;
};

export class AntigravityTerminalAdapter implements ProviderAdapter {
  readonly id = "antigravity";
  readonly name = "Antigravity";
  readonly tools = ANTIGRAVITY_TOOLS;
  readonly capabilities: Capabilities = {
    steer: true, followUp: false, thinkingLevels: [], permissions: true, permissionModes: MODES, extensionUi: false,
    compact: false, compactInstructions: false, rename: false, fork: false, images: true, cost: false, tui: false,
  };
  readonly sessions: SessionSource = { kind: "files", files: () => [], describe: () => null };

  private opts: AntigravityTerminalOptions;
  private io: AgyBindIO;
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
  private conversationId: string | null = null;
  private dataDir: string | null = null;
  private follower: AgyTranscriptFollower | null = null;
  private offset = 0;
  private fullOffset = 0;
  private fullCache = new Map<number, Rec>();
  private fullWait: { step: number; since: number } | null = null;
  private awaitingHistory = false;
  private running = false;
  private settling = false;
  private sent: { id: string; text: string; at: number }[] = [];
  /** Messages held in the chat's steering lane while Antigravity works — editable/removable until sent now or drained at turn end. */
  private queued: { id: string; text: string; raw: string; sendText: string }[] = [];
  private drainingQueue = false;
  private quitSaid = false;
  private binding = false;
  private usageNow: { contextTokens: number | null; contextWindow: number | null } = { contextTokens: null, contextWindow: null };
  private ask: { id: string; key: string; prompt: AgyPrompt } | null = null;
  private askSeq = 0;
  private askTimer: NodeJS.Timeout | null = null;
  private answering = false;
  private askHold = 0;
  private modelNow: string | null = null;
  private effortNow: string | null = null;
  private modeNow: AgyMode | null = null;
  private quotaWarningNow: QuotaWarning | null = null;
  private activityTextNow: string | null = null;
  private interruptedNow: string | null = null;
  private abortRequested = false;
  private sawWorkingScreen = false;
  private workTimer: NodeJS.Timeout | null = null;
  private swarmEtag: string | null = null;
  private catalog: AgyModelGroup[] = [];
  private catalogAt = 0;
  private catalogLoading: Promise<AgyModelGroup[]> | null = null;
  private promptWaits = 0;
  private bangSeq = 0;
  private bangWatchers = new Map<string, {
    callId: string;
    command: string;
    normCmd: string;
    args: Rec;
    startedAt: number;
    controller: AbortController;
    done: boolean;
    output: string;
    exitCode: number | null;
  }>();
  private recentBangs: Array<{ normCmd: string; at: number }> = [];
  private snapshot: Promise<void>;
  private gotSnapshot: () => void = () => {};

  constructor(opts: AntigravityTerminalOptions) {
    this.opts = opts;
    this.io = opts.io ?? LINUX_IO;
    this.snapshot = new Promise((r) => (this.gotSnapshot = r));
    if (opts.sentDir) pruneImages(opts.sentDir);
  }

  get alive(): boolean {
    return this.live && !this.disposed;
  }

  bangActive(): boolean {
    return this.bangWatchers.size > 0;
  }

  private emit(ev: NormalizedEvent): void {
    if (this.disposed) return;
    this.host?.emit(ev);
    if (ev.type === "model" && ev.model.id !== this.modelNow) {
      this.modelNow = ev.model.id;
      this.publishEfforts();
    } else if (ev.type === "thinking") {
      this.effortNow = ev.level;
      this.publishEfforts();
    } else if (ev.type === "permission_mode") {
      this.modeNow = (ev.mode as AgyMode | null) ?? null;
    }
  }

  private publishEfforts(): void {
    const g = this.modelNow ? findModelGroup(this.catalog, this.modelNow) : undefined;
    let efforts: string[];
    if (g) {
      efforts = g.efforts;
    } else if (this.effortNow || this.modelNow) {
      efforts = [...EFFORT_ORDER];
    } else {
      efforts = [];
    }
    this.host?.emit({ type: "capabilities", capabilities: { thinkingLevels: efforts } });
  }

  private log(msg: string): void {
    this.opts.log(`terminal ${this.opts.terminal}: ${msg}`);
  }

  private defaultDataDir(): string {
    if (this.dataDir) return this.dataDir;
    const pid = this.tuiPid() ?? this.fg?.pid;
    const override = (pid ? this.io.env(pid, "ANTIGRAVITY_CLI_DATA_DIR") : null) ?? process.env.ANTIGRAVITY_CLI_DATA_DIR;
    if (override) return override;
    const home = (pid ? this.io.env(pid, "HOME") : null) ?? homedir();
    return join(home, ".gemini", "antigravity-cli");
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
    const prev = this.status;
    this.status = state;
    if (!this.host) return;
    if (state === "working" || state === "blocked") {
      this.setQuotaWarning(null);
      this.runOn();
    } else {
      this.stopWorkStatus();
      this.settle();
      void this.syncFromScreen();
    }
    if (state === "blocked") {
      this.stopWorkStatus();
      this.watchAsk();
    } else {
      this.closeAsk();
      if (state === "working") this.watchWorkStatus();
    }
    if (this.queued.length && (prev === "blocked" || state === "blocked")) this.publishQueue();
  }

  private setQuotaWarning(next: QuotaWarning | null): void {
    if ((this.quotaWarningNow?.id ?? null) === (next?.id ?? null)
      && (this.quotaWarningNow?.message ?? null) === (next?.message ?? null)) return;
    this.quotaWarningNow = next;
    this.emit({ type: "quota_warning", warning: next });
  }

  private setActivityText(next: string | null): void {
    const clean = next?.trim() || null;
    if (clean === this.activityTextNow) return;
    this.activityTextNow = clean;
    this.emit({ type: "activity_text", text: clean });
  }

  private handleScreenInterruption(text: string): boolean {
    const msg = readAgyInterrupted(text);
    if (!msg) {
      if (this.status !== "working" && this.status !== "blocked") this.interruptedNow = null;
      return false;
    }
    if (msg === this.interruptedNow) return false;
    this.interruptedNow = msg;
    if (this.running) this.settle(true);
    this.emit({ type: "notice", level: "warning", source: "host", text: msg });
    return true;
  }

  private watchWorkStatus(): void {
    if (this.workTimer || this.disposed) return;
    this.workTimer = setTimeout(() => void this.pollWorkStatus(), 0);
    this.workTimer.unref();
  }

  private stopWorkStatus(): void {
    if (this.workTimer) clearTimeout(this.workTimer);
    this.workTimer = null;
    this.setActivityText(null);
  }

  /** Replace Antigravity's generic `"Running command... 7s"` spinner text with the real pending command/summary when known. */
  private enrichWorkingStatus(status: string, screen: string): string {
    const m = /^Running command(?:\.{3}|…)?(?:\s*\(?((?:\d+h\s*)?(?:\d+m\s*)?\d+(?:\.\d+)?s)\)?)?$/i.exec(status.trim());
    if (!m) return status;
    const elapsed = m[1]?.replace(/\s+/g, " ").trim() || "";
    this.tail();
    const info = this.follower?.pendingCommandInfo() ?? null;
    const rawCmd = info?.command || readAgyRunningCommand(screen) || "";
    const rawSummary = info?.summary || "";
    const suffix = elapsed ? ` · ${elapsed}` : "";
    if (rawCmd) {
      const cmd = firstLine(rawCmd, 96);
      const summary = rawSummary && !/^Running command/i.test(rawSummary) && !cmd.toLowerCase().includes(rawSummary.toLowerCase())
        ? firstLine(rawSummary, 60)
        : "";
      return `$ ${cmd}${summary ? ` · ${summary}` : ""}${suffix}`;
    }
    if (rawSummary && !/^Running command/i.test(rawSummary)) {
      return `${firstLine(rawSummary, 96)}${suffix}`;
    }
    return status;
  }

  private async pollWorkStatus(): Promise<void> {
    const active = () => !this.disposed && this.running && this.status !== "blocked";
    if (active() && !this.answering && this.agyRuns()) {
      const text = await this.screenText();
      if (active() && !this.answering && text !== null) {
        const status = readAgyWorkingStatus(text);
        if (status) {
          this.sawWorkingScreen = true;
          this.interruptedNow = null;
          this.setActivityText(this.enrichWorkingStatus(status, text));
        } else {
          this.setActivityText(null);
          if (this.handleScreenInterruption(text)) {
            this.workTimer = null;
            return;
          }
          const warn = readAgyQuotaWarning(text);
          if (warn) {
            this.settle();
            this.setQuotaWarning(warn);
            this.workTimer = null;
            return;
          }
          if (/\besc to cancel\b/i.test(text)) {
            this.sawWorkingScreen = true;
            this.interruptedNow = null;
          }
        }
      }
    }
    this.workTimer = null;
    if (active()) {
      this.workTimer = setTimeout(() => void this.pollWorkStatus(), WORK_STATUS_MS());
      this.workTimer.unref();
    }
  }

  private publishQueue(): void {
    this.emit({
      type: "queue_changed",
      steering: this.queued.map((q) => q.text),
      followUp: [],
      steeringIds: this.queued.map((q) => q.id),
      followUpIds: [],
    });
  }

  private clearQueued(): void {
    if (!this.queued.length) return;
    this.queued = [];
    this.publishQueue();
  }

  private gone(why: string): void {
    if (!this.live) return;
    this.live = false;
    this.log(why);
    this.settleAllBangRuns();
    this.setQuotaWarning(null);
    this.stopWorkStatus();
    this.settle(true);
    this.clearQueued();
    this.clearSwarm();
    this.emit({ type: "notice", level: "warning", source: "host", text: "Antigravity's terminal has ended." });
  }

  private runOn(): void {
    if (this.running) return;
    this.running = true;
    this.abortRequested = false;
    this.sawWorkingScreen = false;
    this.setQuotaWarning(null);
    this.emit({ type: "run_started" });
    if (this.status !== "blocked") this.watchWorkStatus();
  }

  private settle(aborted = false): void {
    if (!this.running || this.settling) return;
    const wasAborted = aborted || this.abortRequested;
    this.abortRequested = false;
    this.sawWorkingScreen = false;
    this.stopWorkStatus();
    this.settling = true;
    try {
      this.tail();
    } finally {
      this.settling = false;
    }
    this.running = false;
    if (wasAborted && this.queued.length) {
      const restored = this.queued.map((q) => q.raw);
      this.clearQueued();
      this.emit({ type: "editor_text", text: restored.join("\n\n") });
    }
    this.emit({ type: "run_settled", aborted: wasAborted });
    if (!wasAborted && this.queued.length && this.live && !this.disposed && this.status !== "blocked") {
      void this.drainQueued();
    }
  }

  /** Deliver the next held steering message after a run settles naturally. */
  private async drainQueued(): Promise<void> {
    if (this.drainingQueue || this.running || !this.queued.length || !this.live || this.disposed || this.status === "blocked") return;
    if (!this.agyRuns()) return;
    this.drainingQueue = true;
    const next = this.queued.shift()!;
    this.publishQueue();
    const sent = { id: next.id, text: next.raw, at: Date.now() };
    this.sent.push(sent);
    try {
      const r = await this.hc(["send", "--json", this.opts.terminal, next.sendText], 70_000);
      if (r.code !== 0) {
        this.sent = this.sent.filter((x) => x !== sent);
        this.emit({ type: "editor_text", text: next.raw });
        this.emit({ type: "notice", level: "error", source: "host", text: `Couldn't send the queued message: ${sendError(r.stdout || r.stderr) || `hc exit ${r.code}`}` });
      }
    } finally {
      this.drainingQueue = false;
    }
  }

  // ---------------------------------------------------------------- the conversation

  private tuiPid(): number | null {
    const fg = this.fg;
    return fg ? this.io.tree(fg.pid).find((p) => isAgyTui(this.io.argv(p))) ?? null : null;
  }

  private agyRuns(): boolean {
    return this.tuiPid() !== null;
  }

  awaitPrompt(): Promise<PromptWait> {
    const mine = ++this.promptWaits;
    return waitForPrompt(() => this.screenText(), agyAtPrompt, { cancelled: () => this.disposed || !this.live || mine !== this.promptWaits })
      .then((res) => {
        if (res.back && !this.disposed) void this.syncFromScreen();
        return res;
      });
  }

  private async screenText(lines = 0): Promise<string | null> {
    const argv = lines > 0 ? ["read", "--lines", String(lines), "--json", this.opts.terminal] : ["read", "--json", this.opts.terminal];
    const r = await this.hc(argv, 5000);
    try {
      const text = JSON.parse(r.stdout)?.text;
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  }

  /** Sync model, effort, execution mode and any idle quota warning from the TUI screen. */
  private async syncFromScreen(): Promise<void> {
    if (this.disposed || !this.live || !this.agyRuns()) return;
    const text = await this.screenText();
    if (!text || this.disposed) return;
    if (this.status !== "working" && this.status !== "blocked") {
      const warn = readAgyQuotaWarning(text);
      if (warn && this.running) this.settle();
      this.setQuotaWarning(warn);
      this.handleScreenInterruption(text);
    }
    const bar = readAgyStatusBar(text);
    if (!bar) return;
    if (bar.mode !== this.modeNow) this.emit({ type: "permission_mode", mode: bar.mode });
    if (bar.modelName) {
      const g = findModelGroup(this.catalog, bar.modelName);
      if (g) {
        if (g.baseId !== this.modelNow) {
          this.emit({ type: "model", model: { provider: g.provider, id: g.baseId, name: g.name, reasoning: g.efforts.length > 0 || Boolean(bar.effort), contextWindow: null, input: ["text", "image"] } });
        }
      } else {
        const clean = parseModelLabel(bar.modelName).name;
        const curName = this.modelNow ? modelInfoOf(this.modelNow, this.catalog).info.name : null;
        if (!this.modelNow || (clean.toLowerCase() !== this.modelNow.toLowerCase() && clean.toLowerCase() !== (curName ?? "").toLowerCase())) {
          this.emit({ type: "model", model: { provider: "google", id: clean, name: clean, reasoning: Boolean(bar.effort), contextWindow: null, input: ["text", "image"] } });
        }
      }
    }
    if (bar.effort && bar.effort !== this.effortNow) this.emit({ type: "thinking", level: bar.effort });
  }

  private async checkSession(): Promise<void> {
    if (this.binding || this.disposed) return;
    this.binding = true;
    try {
      if (!this.fg) return;
      const b: AgyBinding = bindConversation(this.fg.pid, this.io);
      this.dataDir = b.dataDir;
      if (b.path === null) {
        if (b.why === "not_running") {
          if (!this.quitSaid && this.file) {
            this.quitSaid = true;
            this.stopWorkStatus();
            this.settle();
            this.clearSwarm();
            this.emit({ type: "notice", level: "info", source: "host", text: "Antigravity quit in its terminal. Start it there again and this view follows it." });
          }
        } else {
          this.quitSaid = false;
        }
        return;
      }
      this.quitSaid = false;
      if (b.path === this.file) return;
      const first = this.file === null;
      this.log(`conversation ${b.id} (${b.how})`);
      this.file = b.path;
      this.conversationId = b.id;
      this.follower = null;
      this.offset = 0;
      this.fullOffset = 0;
      this.fullCache.clear();
      this.fullWait = null;
      this.setQuotaWarning(null);
      this.setActivityText(null);
      this.interruptedNow = null;
      this.abortRequested = false;
      this.sawWorkingScreen = false;
      this.abortAllBangRuns();
      this.recentBangs.length = 0;
      this.clearQueued();
      this.swarmEtag = null;
      if (!first) this.awaitingHistory = true;
      this.emit({ type: "session", id: b.id, file: b.path, ...(first ? {} : { reload: true }) });
      this.syncSwarm(true);
    } catch (e) {
      this.log(`binding: ${(e as Error).message}`);
    } finally {
      this.binding = false;
    }
  }

  /** Whole JSONL lines of `file` from byte offset `from`, each with the byte offset after its newline. */
  private readLines(file: string, from: number): { lines: Array<{ text: string; end: number }>; next: number } {
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
    const lines: Array<{ text: string; end: number }> = [];
    let pos = 0;
    while (pos <= end) {
      const nl = buf.indexOf(0x0a, pos);
      const stop = nl < 0 || nl > end ? end : nl;
      lines.push({ text: buf.subarray(pos, stop).toString("utf8"), end: from + stop + 1 });
      pos = stop + 1;
    }
    return { lines, next: from + end + 1 };
  }

  /** Incrementally index records from sibling `transcript_full.jsonl` (only `wanted` steps when given). */
  private syncFull(fullFile: string, wanted?: Set<number>): void {
    try {
      if (statSync(fullFile).size < this.fullOffset) {
        this.fullOffset = 0;
        this.fullCache.clear();
      }
    } catch {
      return;
    }
    const { lines, next } = this.readLines(fullFile, this.fullOffset);
    this.fullOffset = next;
    for (const { text } of lines) {
      if (!text.trim()) continue;
      let r: unknown;
      try {
        r = JSON.parse(text);
      } catch {
        continue;
      }
      if (r && typeof r === "object" && !Array.isArray(r) && typeof (r as Rec).step_index === "number") {
        const step = (r as Rec).step_index as number;
        if (!wanted || wanted.has(step)) this.fullCache.set(step, r as Rec);
      }
    }
  }

  private tail(): void {
    if (!this.file || this.disposed || this.awaitingHistory) return;
    if (!this.follower) {
      if (!existsSync(this.file)) return;
      this.follower = new AgyTranscriptFollower({ catalog: () => this.catalog });
      this.offset = 0;
      this.fullOffset = 0;
      this.fullCache.clear();
      this.fullWait = null;
    }
    try {
      if (statSync(this.file).size < this.offset) {
        this.offset = 0;
        this.fullOffset = 0;
        this.fullCache.clear();
        this.fullWait = null;
      }
    } catch {
      return;
    }
    const { lines } = this.readLines(this.file, this.offset);
    const fullFile = fullTranscriptPath(this.file);
    let ended = false;
    for (const { text, end } of lines) {
      if (!text.trim()) {
        this.offset = end;
        continue;
      }
      let r: unknown;
      try {
        r = JSON.parse(text);
      } catch {
        this.offset = end;
        continue;
      }
      if (r && typeof r === "object" && !Array.isArray(r) && isTruncatedRecord(r as Rec) && typeof (r as Rec).step_index === "number") {
        const step = (r as Rec).step_index as number;
        if (fullFile && existsSync(fullFile)) {
          if (!this.fullCache.has(step)) this.syncFull(fullFile);
          const full = this.fullCache.get(step);
          if (full) {
            r = full;
            this.fullWait = null;
          } else if (!this.fullWait || this.fullWait.step !== step) {
            // Compact line arrived ahead of transcript_full.jsonl: pause before it until the next tick.
            this.fullWait = { step, since: Date.now() };
            break;
          } else if (Date.now() - this.fullWait.since < FULL_WAIT_MS) {
            break;
          } else {
            this.fullWait = null;
          }
        }
      }
      this.offset = end;
      if (r && typeof r === "object" && !Array.isArray(r) && typeof (r as Rec).step_index === "number") {
        const step = (r as Rec).step_index as number;
        for (const k of this.fullCache.keys()) if (k <= step) this.fullCache.delete(k);
      }
      const before = this.follower.turn;
      const fed = this.follower.feed(r);
      if (r && typeof r === "object" && !Array.isArray(r) && (r as Rec).type === "USER_INPUT" && this.bangWatchers.size > 0) {
        this.settleAllBangRuns();
      }
      if (r && typeof r === "object" && !Array.isArray(r) && (r as Rec).type === "SHELL_EXEC" && this.consumeNativeShellExec(r as Rec, fed)) {
        continue;
      }
      for (const ev of fed) this.emit(this.matchEcho(withImages(ev)));
      if (this.follower.turn !== before) ended = this.follower.turn === "ended";
    }
    this.usageNow = this.follower.usage();
    if (ended && this.running && this.status !== "working" && this.status !== "blocked") this.settle();
  }

  private matchEcho(ev: NormalizedEvent): NormalizedEvent {
    if (ev.type !== "user_message") return ev;
    if (!this.running) this.runOn();
    const now = Date.now();
    this.sent = this.sent.filter((s) => now - s.at < SENT_TTL_MS);
    const target = norm(ev.text);
    const i = this.sent.findIndex((s) => norm(s.text) === target || norm(imageLines(s.text).text) === target);
    if (i >= 0) {
      const [s] = this.sent.splice(i, 1);
      const qi = this.queued.findIndex((q) => q.id === s!.id);
      if (qi >= 0) {
        this.queued.splice(qi, 1);
        this.publishQueue();
      }
      const { source: _source, ...rest } = ev;
      return { ...rest, clientId: s!.id };
    }
    // Antigravity concatenates multiple queued messages with "\n" into one USER_INPUT record.
    for (let start = 0; start < this.sent.length; start++) {
      let joined = "";
      for (let end = start; end < this.sent.length; end++) {
        const part = imageLines(this.sent[end]!.text).text || this.sent[end]!.text;
        joined = end === start ? part : `${joined}\n${part}`;
        if (end > start && norm(joined) === target) {
          const matched = this.sent.splice(start, end - start + 1);
          const ids = new Set(matched.map((m) => m.id));
          const before = this.queued.length;
          this.queued = this.queued.filter((q) => !ids.has(q.id));
          if (this.queued.length !== before) this.publishQueue();
          const { source: _source, ...rest } = ev;
          return { ...rest, clientId: matched[0]!.id };
        }
      }
    }
    // Mixed merge (e.g. a chat-queued message combined with a terminal-typed one).
    if (this.queued.length) {
      const evLines = ev.text.split("\n").map(norm).filter(Boolean);
      const matchedIds = new Set<string>();
      for (const q of this.queued) {
        const qLines = (imageLines(q.raw).text || q.raw).split("\n").map(norm).filter(Boolean);
        if (!qLines.length) continue;
        for (let k = 0; k <= evLines.length - qLines.length; k++) {
          if (qLines.every((l, j) => evLines[k + j] === l)) {
            matchedIds.add(q.id);
            break;
          }
        }
      }
      if (matchedIds.size) {
        const firstId = this.queued.find((q) => matchedIds.has(q.id))!.id;
        this.queued = this.queued.filter((q) => !matchedIds.has(q.id));
        this.sent = this.sent.filter((s) => !matchedIds.has(s.id));
        this.publishQueue();
        const { source: _source, ...rest } = ev;
        return { ...rest, clientId: firstId };
      }
    }
    return { ...ev, source: "external" };
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

  private async screenPrompt(): Promise<AgyPrompt | null | undefined> {
    const text = await this.screenText();
    return text === null ? undefined : readAgyPrompt(text);
  }

  private matchPendingCommand(screenCommand: string): string | null {
    const pending = this.follower?.pendingCommands() ?? [];
    if (!pending.length) return null;
    const needle = screenCommand.replace(COMPACT_WS, "");
    const truncated = /(?:…|\.\.\.)$/.test(needle) ? needle.replace(/(?:…|\.\.\.)$/, "") : null;
    for (let i = pending.length - 1; i >= 0; i--) {
      const candidate = pending[i]!;
      const norm = candidate.replace(COMPACT_WS, "");
      if (norm === needle || (truncated && truncated.length >= 16 && norm.startsWith(truncated))) return candidate;
    }
    return null;
  }

  private showAsk(p: AgyPrompt | null): void {
    const key = p ? agyPromptKey(p) : null;
    if (this.ask && key === this.ask.key) {
      this.ask.prompt = p!;
      return;
    }
    this.closeAsk();
    if (!p || !key) return;
    // Pull any freshly-flushed pending tool call so command approvals can recover exact verbatim CommandLine text.
    if (p.kind === "permission") this.tail();
    const id = `tv-ask-${++this.askSeq}`;
    this.ask = { id, key, prompt: p };
    this.emit({ type: "ask", ask: this.askOf(id, p) });
  }

  private closeAsk(): void {
    if (!this.ask) return;
    this.emit({ type: "ask_closed", id: this.ask.id });
    this.ask = null;
  }

  private askOf(id: string, p: AgyPrompt): Ask {
    if (p.kind === "question") {
      const options = p.rows.map((r) => ({ label: r.label, ...(r.description ? { description: r.description } : {}) }));
      const title = p.progress && !/^Question 1\/1\b/i.test(p.progress)
        ? `Antigravity has a question (${p.progress.replace(/^Question\s+/i, "").replace(/\s*\(.*$/, "")})`
        : "Antigravity has a question";
      return {
        id,
        kind: "questions",
        title,
        questions: [{ id: "q", question: p.question, options, multiSelect: p.multi, allowOther: Boolean(p.other) }],
      };
    }
    let firstYes = true;
    const choice = (r: AgyRow) => {
      const yes = /^(?:Yes|Allow|Approve|Run|Accept)\b/i.test(r.label);
      const kind = /^(?:No|Deny|Reject|Cancel)\b/i.test(r.label) ? "deny" as const
        : yes && firstYes ? "allow" as const
          : /\b(?:always|don't ask|session|future)\b/i.test(r.label) ? "allow_always" as const : "other" as const;
      if (yes) firstYes = false;
      const formatted = formatAgyChoiceLabel(r.label);
      const desc = [formatted.description, r.description].filter(Boolean).join(" · ");
      return { id: `r${r.stop}`, label: formatted.label, kind, ...(desc ? { description: desc } : {}) };
    };
    if (p.kind === "permission") {
      const parsed = parseAgyPermissionBody(p.title, p.body);
      if (parsed.command) {
        const command = this.matchPendingCommand(parsed.command) ?? parsed.command;
        return {
          id,
          kind: "permission",
          title: p.title,
          ...(parsed.reason ? { message: parsed.reason } : {}),
          tool: { name: "run_command", args: { CommandLine: command } },
          choices: p.rows.map(choice),
        };
      }
    }
    return {
      id,
      kind: "permission",
      title: p.title,
      ...(p.body ? { message: p.body } : {}),
      choices: p.rows.map(choice),
    };
  }

  private async pressKeys(keys: string[]): Promise<void> {
    if (!keys.length) return;
    this.log(`dialog: keys ${keys.join(" ")}`);
    const r = await this.hc(["keys", "--json", this.opts.terminal, ...keys], 10_000);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc keys: exit ${r.code}`);
  }

  private async screenShows(what: (p: AgyPrompt) => boolean, ms = 2500): Promise<AgyPrompt> {
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 80))) {
      const p = await this.screenPrompt();
      if (p && what(p)) return p;
      if (Date.now() - t0 > ms) throw new Error("Antigravity didn't take the keys: answer in its terminal (Ctrl+Shift+J)");
    }
  }

  private async typeAnswer(text: string): Promise<void> {
    this.log(`dialog: typed ${text.length} chars`);
    const r = await this.hc(["send", "--json", "--force", this.opts.terminal, text.replace(/\s*\n\s*/g, " ").trim()], 20_000);
    if (r.code !== 0) throw new Error(sendError(r.stdout || r.stderr) || `hc send: exit ${r.code}`);
  }

  private async answerAsk(key: string, a: AskAnswer): Promise<void> {
    const p = await this.screenPrompt();
    if (!p || agyPromptKey(p) !== key) throw new Error(CHANGED);
    if ("cancelled" in a) return this.pressKeys(["esc"]);
    if (p.kind === "question") return this.answerQuestion(p, "answers" in a ? a.answers.q : undefined);
    if (!("choice" in a)) return this.pressKeys(["esc"]);
    const row = p.stops.find((r) => `r${r.stop}` === a.choice);
    if (!row) throw new Error(CHANGED);
    const reason = a.message?.trim() ?? "";
    if (reason && p.kind === "permission" && /^(?:No|Deny|Reject)\b/i.test(row.label)) {
      // Highlight No, press Tab to attach rejection feedback, then type & Enter (modes.md).
      const moves = agyMovesTo(p, row);
      if (moves.length) {
        await this.pressKeys(moves);
        await this.screenShows((now) => now.stops.find((r) => r.selected)?.stop === row.stop);
      }
      await this.pressKeys(["tab"]);
      await new Promise((r) => setTimeout(r, 200));
      return this.typeAnswer(reason);
    }
    return this.pressKeys([...agyMovesTo(p, row), "enter"]);
  }

  private async answerQuestion(p: Extract<AgyPrompt, { kind: "question" }>, v: string | string[] | undefined): Promise<void> {
    if (v === undefined) return this.pressKeys(["esc"]);
    const picks = (Array.isArray(v) ? v : [v]).map((x) => x.trim()).filter(Boolean);
    const typed = picks.filter((x) => !p.rows.some((r) => r.label === x)).join(", ");
    if (typed && !p.other) throw new Error("This question takes one of its options only.");
    if (!p.multi) {
      const row = p.rows.find((r) => r.label === picks[0]);
      if (row) return this.pressKeys([...agyMovesTo(p, row), "enter"]);
      if (p.other && typed) {
        await this.pressKeys([...agyMovesTo(p, p.other), "enter"]);
        await new Promise((r) => setTimeout(r, 200));
        return this.typeAnswer(typed);
      }
      return this.pressKeys(["enter"]);
    }
    const keys: string[] = [];
    let at = p.stops.find((r) => r.selected)?.stop ?? 0;
    const move = (to: number) => {
      for (; at !== to; at += to > at ? 1 : -1) keys.push(to > at ? "down" : "up");
    };
    for (const r of p.rows) if (Boolean(r.checked) !== picks.includes(r.label)) {
      move(r.stop);
      keys.push("space");
    }
    if (keys.length) await this.pressKeys(keys);
    if (typed && p.other) {
      const now = await this.screenShows((x) => x.kind === "question");
      await this.pressKeys([...agyMovesTo(now, p.other), "enter"]);
      await new Promise((r) => setTimeout(r, 200));
      await this.typeAnswer(typed);
      await new Promise((r) => setTimeout(r, 200));
    }
    const final = await this.screenPrompt();
    if (final?.kind !== "question") {
      if (!typed) return this.pressKeys(["enter"]);
      return;
    }
    if (final.submit) return this.pressKeys([...agyMovesTo(final, final.submit), "enter"]);
    // In Antigravity 1.5 multi-select without a Submit row, Enter on Write-in... opens the editor instead of submitting.
    if (final.other && final.rows.length && final.stops.find((r) => r.selected)?.stop === final.other.stop) {
      return this.pressKeys([...agyMovesTo(final, final.rows[0]!), "enter"]);
    }
    return this.pressKeys(["enter"]);
  }

  // ---------------------------------------------------------------- models & commands

  private async loadCatalog(force = false): Promise<AgyModelGroup[]> {
    if (!force && this.catalog.length && Date.now() - this.catalogAt < MODELS_TTL_MS) return this.catalog;
    if (this.catalogLoading) return this.catalogLoading;
    const work = (async () => {
      try {
        const list = this.opts.fetchModels ? await this.opts.fetchModels() : await this.runModelsCmd();
        if (list.length) {
          this.catalog = list;
          this.catalogAt = Date.now();
          this.publishEfforts();
        }
        return this.catalog;
      } catch (e) {
        this.log(`agy models: ${(e as Error).message}`);
        return this.catalog;
      } finally {
        this.catalogLoading = null;
      }
    })();
    this.catalogLoading = work;
    return work;
  }

  private runModelsCmd(): Promise<AgyModelGroup[]> {
    return new Promise((resolve) => {
      const p = spawn(this.opts.command || "agy", ["models"], { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      const timer = setTimeout(() => p.kill(), 12_000);
      p.stdout.on("data", (d) => (stdout += d));
      p.on("error", () => {
        clearTimeout(timer);
        resolve([]);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? parseModelsOutput(stdout) : []);
      });
    });
  }

  private async typeInlineCommand(line: string, check: (bar: ReturnType<typeof readAgyStatusBar>) => boolean): Promise<void> {
    if (!this.live) throw new AgentError("Antigravity's terminal has ended.", true);
    if (!this.agyRuns()) throw new Error("Antigravity isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    const before = await this.screenText();
    let sent: { code: number | null; out: string } | null = null;
    let sentAt = 0;
    void this.hc(["send", "--json", this.opts.terminal, line], 70_000).then((r) => {
      sent = { code: r.code, out: r.stdout || r.stderr };
      sentAt = Date.now();
    });
    for (const t0 = Date.now(); Date.now() - t0 < 75_000; ) {
      await new Promise((res) => setTimeout(res, 250));
      const done = sent as { code: number | null; out: string } | null;
      if (done && done.code !== 0) throw new Error(`Couldn't type into the terminal: ${sendError(done.out) || `hc exit ${done.code}`}`);
      const after = await this.screenText();
      if (after !== null) {
        const answer = commandAnswer(newLines(before, after));
        if (answer && "refused" in answer) throw new Error(`Antigravity: ${answer.refused}`);
        if (answer || check(readAgyStatusBar(after))) return;
      }
      if (done && Date.now() - sentAt > 1000) return;
    }
  }

  // ---------------------------------------------------------------- the adapter

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    this.host = host;
    this.watch();
    await Promise.race([this.snapshot, new Promise((r) => setTimeout(r, 5000))]);
    if (!this.live) throw new AgentError(`Terminal ${this.opts.terminal} has ended.`, true);
    // Warm the model catalog in the background so effort tiers and model names populate quickly.
    void this.loadCatalog();
    await this.checkSession();
    if (!this.file && session && existsSync(session)) {
      this.file = session;
      this.emit({ type: "session", id: this.conversationId, file: session });
    }
    if (!this.file) this.log("no Antigravity conversation found yet: waiting for one");
    await this.syncFromScreen();
    if (!this.modelNow || !this.effortNow || !this.modeNow) {
      const tui = this.tuiPid();
      const start = tui ? startingState(this.io.argv(tui), this.defaultDataDir()) : null;
      if (!this.modelNow && start?.model) {
        const parsed = parseModelLabel(start.model);
        const info = modelInfoOf(start.model, this.catalog);
        // If `settings.json` stored a display label like "Gemini 4 Neon (XHigh)", keep its clean name.
        const name = start.model.includes(" ") ? parsed.name : info.info.name;
        this.emit({ type: "model", model: { ...info.info, name } });
      }
      if (!this.effortNow && start?.effort) this.emit({ type: "thinking", level: start.effort });
      if (!this.modeNow && start?.mode) this.emit({ type: "permission_mode", mode: start.mode });
      else if (!this.modeNow && this.agyRuns()) this.emit({ type: "permission_mode", mode: "default" });
    }
    this.tailTimer = setInterval(() => this.tail(), TAIL_MS());
    this.tailTimer.unref();
    this.sessionTimer = setInterval(() => {
      void this.checkSession();
      this.syncSwarm();
      if (this.status !== "working" && this.status !== "blocked" && !this.answering) void this.syncFromScreen();
    }, SESSION_MS());
    this.sessionTimer.unref();
    const streaming = this.status === "working" || this.status === "blocked";
    if (streaming) this.running = true;
    if (this.status === "blocked") this.watchAsk();
    else if (this.status === "working") this.watchWorkStatus();
    const hasHistory = Boolean(this.file && existsSync(this.file));
    this.awaitingHistory = Boolean(session) || hasHistory;
    return { streaming, hasHistory };
  }

  async history(): Promise<NormalizedEvent[]> {
    this.awaitingHistory = false;
    const file = this.file;
    if (!file || !existsSync(file)) return [];
    const { lines, next } = this.readLines(file, 0);
    this.offset = next;
    this.fullOffset = 0;
    this.fullCache.clear();
    this.fullWait = null;
    const parsed: Rec[] = [];
    const truncated = new Set<number>();
    for (const { text } of lines) {
      if (!text.trim()) continue;
      let r: unknown;
      try {
        r = JSON.parse(text);
      } catch {
        continue;
      }
      if (!r || typeof r !== "object" || Array.isArray(r)) continue;
      const rec = r as Rec;
      parsed.push(rec);
      if (isTruncatedRecord(rec) && typeof rec.step_index === "number") truncated.add(rec.step_index);
    }
    const fullFile = fullTranscriptPath(file);
    if (fullFile && existsSync(fullFile)) {
      if (truncated.size > 0) {
        this.syncFull(fullFile, truncated);
      } else {
        try {
          this.fullOffset = statSync(fullFile).size;
        } catch {}
      }
    }
    const past = new AgyTranscriptFollower({ history: true, catalog: () => this.catalog });
    const out: NormalizedEvent[] = [];
    const now = new Map<string, NormalizedEvent>();
    for (const rec of parsed) {
      const full = typeof rec.step_index === "number" ? this.fullCache.get(rec.step_index) ?? rec : rec;
      for (const ev of past.feed(full)) {
        if (ev.type === "model" || ev.type === "thinking") now.set(ev.type, ev);
        else out.push(withImages(ev));
      }
    }
    this.fullCache.clear();
    for (const ev of now.values()) this.emit(ev);
    this.usageNow = past.usage();
    if (this.usageNow.contextTokens !== null) queueMicrotask(() => this.emit({ type: "turn_end" }));
    past.setLive();
    this.follower = past;
    return out;
  }

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean; noBang?: boolean }): Promise<{ disposition: Disposition }> {
    if (!this.live) throw new AgentError("Antigravity's terminal has ended.", true);
    if (!this.agyRuns()) throw new Error("Antigravity isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    const trimmed = p.text.trim();
    const bang = !p.noBang && !/[\r\n]/.test(trimmed) && trimmed.length <= 4000 ? /^!\s*([^\s=!].*)$/.exec(trimmed) : null;
    if (bang && this.status === "working") throw new Error(BUSY);
    const command = Boolean(bang) || /^\/\S/.test(trimmed);
    if (command && p.images.length) throw new Error("Images go with a message, not a command: send them on their own or with words.");
    if (bang) {
      // `hc send` bracketed-pastes `!cmd`, which `agy` treats as a literal LLM prompt instead of
      // opening bash mode; type raw `!` over `hc connect` (`terminal.attach`), verify bash mode,
      // then paste the command and press Enter. Antigravity CLI keeps `!` shell output on its TUI
      // screen without writing `SHELL_EXEC` to `transcript.jsonl`, so we mirror it live into a
      // standalone `you-bash-live-*` Bash card by observing `hc read` against the pre-run screen.
      const cmd = bang[1]!.trim();
      const { before } = await sendAgyBang({ hc: this.opts.hc, terminal: this.opts.terminal, command: cmd });
      this.startBangRun(cmd, before);
      return { disposition: "handled" };
    }
    if (p.images.length && !this.opts.sentDir) throw new Error(NO_IMAGES);
    const files = p.images.length ? saveImages(this.opts.sentDir!, p.images) : [];
    const text = files.length ? withImageLines(p.text, files) : p.text;
    const display = p.text.trim() || (p.images.length === 1 ? "[1 image]" : `[${p.images.length} images]`);
    // Hold steering messages locally while Antigravity is working so they stay cleanly editable/removable
    // in the chat UI and can be flushed on demand via Send immediately or drained when the turn settles.
    if (p.busy && !command) {
      this.queued.push({ id: p.id, text: display, raw: p.text, sendText: text });
      this.publishQueue();
      return { disposition: "queued" };
    }
    const sent = { id: p.id, text: p.text, at: Date.now() };
    if (!command) this.sent.push(sent);
    const r = await this.hc(["send", "--json", this.opts.terminal, text], 70_000);
    if (r.code !== 0) {
      this.sent = this.sent.filter((x) => x !== sent);
      throw new Error(`Couldn't type into the terminal: ${sendError(r.stdout || r.stderr) || `hc exit ${r.code}`}`);
    }
    if (command) return { disposition: "handled" };
    return { disposition: "started" };
  }

  async clearQueue(): Promise<string[]> {
    const restored = this.queued.map((q) => q.raw);
    this.clearQueued();
    return restored;
  }

  canRemoveQueued(id: string): boolean {
    return this.queued.some((q) => q.id === id);
  }

  async removeQueued(id: string): Promise<boolean> {
    const idx = this.queued.findIndex((q) => q.id === id);
    if (idx < 0) return false;
    this.queued.splice(idx, 1);
    this.publishQueue();
    return true;
  }

  canSendQueuedNow(): boolean {
    return this.live && !this.disposed && !this.quitSaid && this.status !== "blocked" && this.queued.length > 0;
  }

  /** Flush held steering message(s) into Antigravity now and press its send-immediately shortcut (default `alt+m`). */
  async sendQueuedNow(id?: string): Promise<boolean> {
    if (!this.live) throw new AgentError("Antigravity's terminal has ended.", true);
    if (!this.agyRuns()) throw new Error("Antigravity isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    const batch = id ? this.queued.filter((q) => q.id === id) : [...this.queued];
    if (!batch.length) return false;
    const batchIds = new Set(batch.map((q) => q.id));
    this.queued = this.queued.filter((q) => !batchIds.has(q.id));
    this.publishQueue();
    const sentEntries = batch.map((q) => ({ id: q.id, text: q.raw, at: Date.now() }));
    this.sent.push(...sentEntries);
    const payload = batch.map((q) => q.sendText).join("\n");
    const sr = await this.hc(["send", "--json", this.opts.terminal, payload], 70_000);
    if (sr.code !== 0) {
      const sentSet = new Set(sentEntries);
      this.sent = this.sent.filter((x) => !sentSet.has(x));
      this.queued = [...batch, ...this.queued];
      this.publishQueue();
      throw new Error(`Couldn't type into the terminal: ${sendError(sr.stdout || sr.stderr) || `hc exit ${sr.code}`}`);
    }
    if (this.status === "working") {
      const screen = await this.screenText();
      const key = (screen ? readAgySendNowKey(screen) : null) ?? "alt+m";
      this.log(`queue: send now via ${key}`);
      const kr = await this.hc(["keys", "--json", this.opts.terminal, key], 10_000);
      if (kr.code !== 0) throw new Error((kr.stderr || kr.stdout).trim() || `hc keys: exit ${kr.code}`);
    }
    return true;
  }

  abort(): void {
    this.abortRequested = true;
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
      .catch((e: Error) => this.emit({ type: "notice", level: "warning", source: "host", text: `Couldn't answer in Antigravity's terminal: ${e.message}` }))
      .finally(() => {
        this.answering = false;
        this.askHold = Date.now() + ASK_SETTLE_MS;
      });
  }

  async dispose(): Promise<void> {
    this.kill();
  }

  private sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(!this.disposed && !signal.aborted);
      }, ms);
      timer.unref();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Start a standalone `you-bash-live-*` card and mirror the `!` command's TUI output until it settles. */
  private startBangRun(command: string, beforeScreen: string): void {
    if (this.bangWatchers.size > 0) this.settleAllBangRuns();
    const callId = `you-bash-live-${++this.bangSeq}`;
    const args: Rec = { CommandLine: command };
    const entry = {
      callId,
      command,
      normCmd: norm(command),
      args,
      startedAt: Date.now(),
      controller: new AbortController(),
      done: false,
      output: "",
      exitCode: null as number | null,
    };
    this.bangWatchers.set(callId, entry);
    this.emit({ type: "tool_call", callId, name: "run_command", args });
    this.emit({ type: "tool_started", callId, name: "run_command", args });
    void this.watchBangRun(entry, beforeScreen);
  }

  private finishBangRun(
    entry: {
      callId: string;
      normCmd: string;
      args: Rec;
      startedAt: number;
      controller: AbortController;
      done: boolean;
      output: string;
      exitCode: number | null;
    },
    res: { output: string; exitCode: number | null; isError: boolean },
  ): void {
    if (entry.done) return;
    entry.done = true;
    entry.controller.abort();
    this.bangWatchers.delete(entry.callId);
    const now = Date.now();
    this.recentBangs = this.recentBangs.filter((x) => now - x.at < BANG_DEDUP_TTL_MS);
    this.recentBangs.push({ normCmd: entry.normCmd, at: now });
    this.emit({
      type: "tool_ended",
      callId: entry.callId,
      name: "run_command",
      args: entry.args,
      isError: res.isError,
      output: res.output,
      durationMs: Math.max(0, now - entry.startedAt),
      ...(res.exitCode !== null ? { result: { structuredContent: { exit_code: res.exitCode } } } : {}),
    });
  }

  private settleAllBangRuns(): void {
    for (const entry of [...this.bangWatchers.values()]) {
      this.finishBangRun(entry, {
        output: entry.output,
        exitCode: entry.exitCode,
        isError: entry.exitCode !== null && entry.exitCode !== 0,
      });
    }
  }

  private abortAllBangRuns(): void {
    for (const entry of [...this.bangWatchers.values()]) {
      entry.done = true;
      entry.controller.abort();
    }
    this.bangWatchers.clear();
  }

  /** Deduplicate a native `SHELL_EXEC` transcript step 1-to-1 against an active or recently settled live `!` run. */
  private consumeNativeShellExec(r: Rec, fed: NormalizedEvent[]): boolean {
    const normCmd = norm(typeof r.command === "string" ? r.command : "");
    if (!normCmd) return false;
    for (const entry of this.bangWatchers.values()) {
      if (entry.normCmd !== normCmd) continue;
      const ended = fed.find((e) => e.type === "tool_ended") as Extract<NormalizedEvent, { type: "tool_ended" }> | undefined;
      const exitCode = typeof r.exit_code === "number" && Number.isFinite(r.exit_code) ? r.exit_code : entry.exitCode;
      const isError = ended ? ended.isError : r.status === "ERROR" || (exitCode !== null && exitCode !== 0);
      this.finishBangRun(entry, {
        output: ended?.output ?? entry.output,
        exitCode,
        isError,
      });
      return true;
    }
    const now = Date.now();
    this.recentBangs = this.recentBangs.filter((x) => now - x.at < BANG_DEDUP_TTL_MS);
    const idx = this.recentBangs.findIndex((x) => x.normCmd === normCmd);
    if (idx >= 0) {
      this.recentBangs.splice(idx, 1);
      return true;
    }
    return false;
  }

  private async watchBangRun(
    entry: {
      callId: string;
      command: string;
      normCmd: string;
      args: Rec;
      startedAt: number;
      controller: AbortController;
      done: boolean;
      output: string;
      exitCode: number | null;
    },
    beforeScreen: string,
  ): Promise<void> {
    const signal = entry.controller.signal;
    const pollMs = BANG_POLL_MS();
    const slowMs = BANG_SLOW_MS();
    const settleActiveMs = BANG_SETTLE_ACTIVE_MS();
    const settleOutputMs = BANG_SETTLE_OUTPUT_MS();
    const settleQuietMs = BANG_SETTLE_QUIET_MS();
    let sawActive = false;
    let lastOutput = "";
    let stableSince = 0;

    if (!(await this.sleepAbortable(pollMs, signal))) return;
    while (!signal.aborted && !this.disposed && !entry.done) {
      if (!this.live) {
        this.finishBangRun(entry, {
          output: entry.output,
          exitCode: entry.exitCode,
          isError: entry.exitCode !== null && entry.exitCode !== 0,
        });
        return;
      }
      const elapsed = Date.now() - entry.startedAt;
      const screen = await this.screenText(80);
      if (signal.aborted || this.disposed || entry.done) return;

      let screenRunning = false;
      if (screen !== null) {
        const parsed = extractAgyShellOutput(beforeScreen, screen, entry.command);
        if (parsed.output.length > 0 && parsed.output !== entry.output) {
          entry.output = parsed.output;
          this.emit({ type: "tool_progress", callId: entry.callId, name: "run_command", args: entry.args, output: entry.output });
        }
        if (parsed.exitCode !== null) entry.exitCode = parsed.exitCode;
        screenRunning = parsed.running;
      }

      const active = this.status === "working" || screenRunning;
      if (active) {
        sawActive = true;
        stableSince = 0;
      } else if (this.status === "blocked") {
        stableSince = 0;
      } else {
        const now = Date.now();
        if (entry.output !== lastOutput) {
          lastOutput = entry.output;
          stableSince = now;
        } else if (stableSince === 0) {
          stableSince = now;
        }
        const stableFor = now - stableSince;
        const settled = (sawActive && stableFor >= settleActiveMs)
          || (entry.output.length > 0 && stableFor >= settleOutputMs)
          || (elapsed >= settleQuietMs && stableFor >= settleOutputMs);
        if (settled) {
          this.finishBangRun(entry, {
            output: entry.output,
            exitCode: entry.exitCode,
            isError: entry.exitCode !== null && entry.exitCode !== 0,
          });
          return;
        }
      }

      if (elapsed >= BANG_MAX_MS) {
        this.finishBangRun(entry, {
          output: entry.output,
          exitCode: entry.exitCode,
          isError: entry.exitCode !== null && entry.exitCode !== 0,
        });
        return;
      }
      const delay = elapsed < BANG_FAST_WINDOW_MS ? pollMs : slowMs;
      if (!(await this.sleepAbortable(delay, signal))) return;
    }
  }

  kill(): void {
    this.disposed = true;
    this.abortAllBangRuns();
    for (const t of [this.tailTimer, this.sessionTimer, this.eventsRetry, this.askTimer, this.workTimer]) if (t) clearTimeout(t);
    this.events?.kill();
    this.events = null;
  }

  async listModels(): Promise<AgentModel[]> {
    const groups = await this.loadCatalog();
    const out: AgentModel[] = groups.map((g) => ({
      provider: g.provider,
      id: g.baseId,
      name: g.name,
      reasoning: g.efforts.length > 0,
      enabled: true,
    }));
    if (this.modelNow && !findModelGroup(groups, this.modelNow)) {
      const { info } = modelInfoOf(this.modelNow);
      out.unshift({ provider: info.provider, id: info.id, name: info.name, reasoning: Boolean(this.effortNow), enabled: true });
    }
    return out;
  }

  async setModel(_provider: string, id: string): Promise<void> {
    const groups = await this.loadCatalog();
    const g = findModelGroup(groups, id);
    if (!g) throw new Error(`Antigravity's model list has no "${id}".`);
    if (g.baseId === this.modelNow) return;
    const effort = this.effortNow && g.efforts.includes(this.effortNow) ? this.effortNow : g.defaultEffort;
    const variantId = (effort && g.variants[effort]) || g.defaultId;
    await this.typeInlineCommand(`/model ${variantId}`, (bar) => Boolean(bar?.modelName && bar.modelName.toLowerCase() === g.name.toLowerCase()));
    this.emit({ type: "model", model: { provider: g.provider, id: g.baseId, name: g.name, reasoning: g.efforts.length > 0, contextWindow: null, input: ["text", "image"] } });
    if (effort) this.emit({ type: "thinking", level: effort });
  }

  async setThinking(level: string): Promise<void> {
    const g = this.modelNow ? findModelGroup(this.catalog, this.modelNow) : undefined;
    if (g && !g.efforts.length) throw new Error(`${g.name} has a fixed reasoning effort.`);
    if (g && !g.efforts.includes(level)) throw new Error(`${g.name} has ${g.efforts.join(", ")}.`);
    await this.typeInlineCommand(`/effort ${level}`, (bar) => bar?.effort === level);
    this.emit({ type: "thinking", level });
  }

  /** Cycle execution mode in the TUI with Shift+Tab until the status bar shows `mode`. */
  async setPermissionMode(mode: string): Promise<void> {
    if (!this.live) throw new AgentError("Antigravity's terminal has ended.", true);
    if (!this.agyRuns()) throw new Error("Antigravity isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    const want = (mode === "acceptEdits" ? "accept-edits" : mode) as AgyMode;
    if (!MODES.some((m) => m.id === want)) throw new Error(`Unknown Antigravity mode "${mode}".`);
    const cur = readAgyStatusBar((await this.screenText()) ?? "");
    if (cur?.mode === want) {
      this.emit({ type: "permission_mode", mode: want });
      return;
    }
    let prev: AgyMode | null = cur?.mode ?? null;
    for (let step = 0; step < 4; step++) {
      await this.pressKeys(["shift+tab"]);
      for (let tries = 0; tries < 8; tries++) {
        await new Promise((r) => setTimeout(r, 100));
        const bar = readAgyStatusBar((await this.screenText()) ?? "");
        if (!bar) continue;
        if (bar.mode === want) {
          this.emit({ type: "permission_mode", mode: want });
          return;
        }
        if (bar.mode !== prev) {
          prev = bar.mode;
          break;
        }
      }
    }
    const final = readAgyStatusBar((await this.screenText()) ?? "");
    if (final) this.emit({ type: "permission_mode", mode: final.mode });
    throw new Error(`Antigravity didn't switch to ${want} mode (it may not be available on this account).`);
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

  // ---------------------------------------------------------------- native /swarm

  private clearSwarm(): void {
    if (this.swarmEtag === null) return;
    this.swarmEtag = null;
    this.emit({ type: "swarm", swarm: null });
  }

  private swarmModelList(): string[] {
    const out: string[] = [];
    for (const g of this.catalog) {
      if (g.defaultId) out.push(g.defaultId);
      else if (g.baseId) out.push(g.baseId);
    }
    return out;
  }

  private syncSwarm(force = false): SwarmSnapshot | null {
    if (this.disposed || !this.live || !this.dataDir || !this.conversationId) {
      if (!this.live) this.clearSwarm();
      return null;
    }
    const snap = readSwarmSnapshot(this.dataDir, this.conversationId, Date.now(), this.swarmModelList());
    if (!snap) {
      this.clearSwarm();
      return null;
    }
    if (this.opts.imageDir) {
      materializeSwarmFrames(snap, this.dataDir, this.opts.imageDir);
    }
    if (force || snap.etag !== this.swarmEtag) {
      this.swarmEtag = snap.etag;
      this.emit({ type: "swarm", swarm: snap });
    }
    return snap;
  }

  swarmRefresh(): SwarmSnapshot | null {
    return this.syncSwarm(true);
  }

  swarmMember(member: string, limit?: number): SwarmMemberTranscript | null {
    if (!this.dataDir || !this.conversationId) return null;
    return readSwarmMemberTranscript(this.dataDir, this.conversationId, member, { limit });
  }

  async swarmAction(raw: SwarmActionRequest): Promise<void> {
    if (!this.live) throw new AgentError("Antigravity's terminal has ended.", true);
    if (!this.agyRuns()) throw new Error("Antigravity isn't running in its terminal. Start it there (Ctrl+Shift+J flips to it).");
    if (this.status === "blocked") throw new Error(this.ask ? ASKING_CARD : ASKING);
    const req = parseSwarmAction(raw);
    const prompt = buildSwarmActionPrompt(req);
    this.log(`swarm action: ${req.action}`);
    const r = await this.hc(["send", "--json", this.opts.terminal, prompt], 70_000);
    if (r.code !== 0) {
      throw new Error(`Couldn't send swarm action: ${sendError(r.stdout || r.stderr) || `hc exit ${r.code}`}`);
    }
    setTimeout(() => {
      if (!this.disposed) this.syncSwarm();
    }, 400).unref();
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
