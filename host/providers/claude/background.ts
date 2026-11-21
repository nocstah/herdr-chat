// What a Claude Code session runs in the background, as its TUI's agents panel shows it under the prompt (Claude Code
// 2.1.3xx): a row per background agent and per Workflow run, and the shells and monitors counted in the footer.
// The TUI keeps that panel in memory; this reads the same from the session's files, for the chat view of the
// session (a chat's own Claude Code, and the terminal view of one in a terminal), Code Mode or not (a call a REPL
// script makes leaves the same files):
//
// - A background agent: `<session>/subagents/agent-<id>.meta.json` (`requestShape: "background"`, its `agentType`,
//   `description`, `worktreeBranch` when it works in a worktree of its own; `finished: true` once it ended) beside its
//   transcript `agent-<id>.jsonl` (its first record's time is its start; its last model call's usage its tokens, as the
//   TUI counts them: input + cache writes + cache reads + output; its last tool call what it does now).
// - A Workflow run: `<session>/subagents/workflows/<run id>/journal.jsonl` (a `started` row per agent, with its id and
//   label, then `result` or `failed`), each agent's transcript beside it, the script Claude Code saved as the run
//   started (`<session>/workflows/scripts/<name>-<run id>.js`, whose time is the start), and `<session>/workflows/<run
//   id>.json` once it ended. The TUI's row: `<name> <bar> <done>/<total> · <elapsed> · ↓ <tokens> tokens`: done is the
//   agents that answered, total the agents started (the TUI also counts those its script queued, which no file names),
//   tokens the sum of each agent's last call.
// - Shells and monitors: a `Bash` call's result with `backgroundTaskId`, a `Monitor` call's with `taskId` and
//   `timeoutMs`, in the session's transcript.
// - An end: a `<task-notification>` (`<task-id>`, `<status>`) the session's queue gets (a `queue-operation` record,
//   an attachment or a user record), a `TaskStop` call's result, or the files above.
//
// Only what started after `since` (the Claude Code process's start: background work dies with its process) counts.
// Of the files, only these fields are read: never a prompt, an answer or a result (a run's `result` rows and its
// `<run id>.json` are read for their type and id only, a notification for its id and status).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Background, BackgroundState, BackgroundTask } from "../types.ts";

export type { Background, BackgroundState, BackgroundTask };

type Rec = Record<string, any>;

/** How long an ended task stays on the panel, marked done or failed. */
export const LINGER_MS = 8_000;
/** Of a transcript, the end read at first (later, what it grows by): a launch older than this is missed (counts only). */
const TAIL_START_BYTES = 8 * 1024 * 1024;
/** The most read of a transcript or journal per look. */
const READ_STEP = 4 * 1024 * 1024;
/** Of an agent's transcript, the end read for its last call and usage. */
const AGENT_TAIL_BYTES = 64 * 1024;
const ACTIVITY_MAX = 160;
/** A clock's slack between a process start and its first files. */
const SLACK_MS = 5_000;

const ENDS: Record<string, BackgroundState> = { completed: "done", failed: "failed", killed: "stopped", stopped: "stopped", cancelled: "stopped", timeout: "stopped" };

function readAt(path: string, from: number, max: number): { text: string; size: number; next: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.min(from, size);
    const n = Math.min(size - start, max);
    const buf = Buffer.alloc(n);
    const got = n ? readSync(fd, buf, 0, n, start) : 0;
    return { text: buf.subarray(0, got).toString("utf8"), size, next: start + got };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Whole lines of `text`, and how many bytes they take (a last line without its newline waits for the next read). */
function wholeLines(text: string): { lines: string[]; used: number } {
  const end = text.lastIndexOf("\n");
  if (end < 0) return { lines: [], used: 0 };
  return { lines: text.slice(0, end).split("\n"), used: Buffer.byteLength(text.slice(0, end + 1)) };
}

function parse(line: string): Rec | null {
  try {
    const r = JSON.parse(line);
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

function tsOf(r: Rec | null): number | null {
  const t = typeof r?.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A model call's tokens as the TUI counts them. */
export function usageTokens(u: Rec | null | undefined): number | null {
  if (!u || typeof u !== "object") return null;
  const n = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens) + num(u.output_tokens);
  return n > 0 ? n : null;
}

/** What a tool call does, in its own words: its description, else the command, file, pattern, address or query. */
export function activityOf(name: string, input: unknown): string | null {
  const i = input && typeof input === "object" ? (input as Rec) : {};
  if (name === "StructuredOutput") return null; // its input is the agent's answer
  const v = [i.description, i.command, i.file_path, i.path, i.pattern, i.url, i.query].find((x) => typeof x === "string" && x.trim());
  const text = typeof v === "string" ? v.trim().split("\n")[0]!.trim() : "";
  const line = text.length > ACTIVITY_MAX ? text.slice(0, ACTIVITY_MAX - 1) + "…" : text;
  return line ? `${name} · ${line}` : name;
}

/** Notifications in a string: each task's id and how it ended (a monitor's event has no status: not an end). */
function notifications(s: string, out: Map<string, BackgroundState>): void {
  if (!s.includes("<task-notification>")) return;
  for (const m of s.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const id = /<task-id>([^<]*)<\/task-id>/.exec(m[1]!)?.[1]?.trim();
    const status = /<status>([^<]*)<\/status>/.exec(m[1]!)?.[1]?.trim();
    if (id && status && ENDS[status]) out.set(id, ENDS[status]);
  }
}

/** The strings of a record a notification can be in. */
function stringsOf(r: Rec): string[] {
  if (r.type === "queue-operation") return typeof r.content === "string" ? [r.content] : [];
  if (r.type === "attachment") return typeof r.attachment?.prompt === "string" ? [r.attachment.prompt] : [];
  if (r.type !== "user") return [];
  const c = r.message?.content;
  if (typeof c === "string") return [c];
  if (!Array.isArray(c)) return [];
  return c.flatMap((b: Rec) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : b?.type === "tool_result" && typeof b.content === "string" ? [b.content] : []));
}

type FileMark = { size: number; mtime: number };
type AgentTail = { tokens: number | null; activity: string | null; first: number | null };
type Agent = { meta: Rec; mark: FileMark; tail: AgentTail | null; tailMark: FileMark | null };
type Run = {
  offset: number;
  agents: Map<string, { label: string; state: "running" | "done" | "failed" }>;
  name: string | null;
  startedAt: number | null;
  tokens: Map<string, { mark: FileMark; tokens: number | null }>;
};

function mark(path: string): FileMark | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return null;
  }
}
const same = (a: FileMark | null, b: FileMark | null) => Boolean(a && b && a.size === b.size && a.mtime === b.mtime);

/** An agent transcript's start, last call and usage: its head and its end. */
function agentTail(path: string): AgentTail | null {
  const head = readAt(path, 0, 8192);
  if (!head) return null;
  const nl = head.text.indexOf("\n");
  const first = tsOf(parse(nl >= 0 ? head.text.slice(0, nl) : head.text));
  const from = Math.max(0, head.size - AGENT_TAIL_BYTES);
  const end = readAt(path, from, AGENT_TAIL_BYTES);
  let tokens: number | null = null;
  let activity: string | null = null;
  if (end) {
    const lines = end.text.split("\n");
    if (from > 0) lines.shift(); // cut
    for (let i = lines.length - 1; i >= 0 && (tokens === null || activity === null); i--) {
      const l = lines[i]!;
      if (!l.includes('"assistant"')) continue;
      const r = parse(l);
      if (r?.type !== "assistant") continue;
      if (tokens === null) tokens = usageTokens(r.message?.usage);
      if (activity === null && Array.isArray(r.message?.content)) {
        const calls = r.message.content.filter((b: Rec) => b?.type === "tool_use");
        const last = calls.at(-1);
        if (last) activity = activityOf(String(last.name ?? "tool"), last.input);
      }
    }
  }
  return { tokens, activity, first };
}

/**
 * One session's background work, read anew at each `read()` (only what changed since the last: the files' sizes and
 * times say). No timers: the caller looks as often as it likes.
 */
export class BackgroundWatch {
  readonly dir: string;
  private offset: number | null = null;
  private ended = new Map<string, BackgroundState>();
  private shells = new Map<string, number>();
  private monitors = new Map<string, { at: number; until: number | null }>();
  /** A run's task id (what its notification names), from its launch's result or its end file. */
  private runTasks = new Map<string, string>();
  private runNames = new Map<string, string>();
  private agents = new Map<string, Agent>();
  private runs = new Map<string, Run>();
  /** Tasks seen running, and when an ended one was first seen ended. */
  private seenRunning = new Set<string>();
  private endedAt = new Map<string, number>();

  readonly file: string;
  readonly since: number;

  constructor(file: string, since: number) {
    this.file = file;
    this.since = since;
    this.dir = file.replace(/\.jsonl$/, "");
  }

  read(now = Date.now()): Background | null {
    this.readTranscript();
    const tasks = [...this.readRuns(now), ...this.readAgents(now)].sort((a, b) => a.startedAt - b.startedAt);
    let shells = 0;
    for (const [id, at] of this.shells) if (at >= this.since - SLACK_MS && !this.ended.has(id)) shells++;
    let monitors = 0;
    for (const [id, m] of this.monitors) if (m.at >= this.since - SLACK_MS && !this.ended.has(id) && (m.until === null || m.until > now)) monitors++;
    if (!tasks.length && !shells && !monitors) return null;
    return { at: now, tasks, shells, monitors };
  }

  /** The session transcript's new records: launches and ends. */
  private readTranscript(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    let skipCut = false;
    if (this.offset === null || size < this.offset) {
      this.offset = Math.max(0, size - TAIL_START_BYTES);
      skipCut = this.offset > 0;
    }
    if (size === this.offset) return;
    const got = readAt(this.file, this.offset, READ_STEP);
    if (!got) return;
    const { lines, used } = wholeLines(got.text);
    if (!used && got.next - this.offset >= READ_STEP) {
      this.offset = got.next; // one record longer than a whole step: skipped
      return;
    }
    this.offset += used;
    if (skipCut) lines.shift();
    for (const l of lines) {
      if (!/task-notification|backgroundTaskId|"timeoutMs"|"task_id"|"runId"/.test(l)) continue;
      const r = parse(l);
      if (!r || r.isSidechain) continue;
      for (const s of stringsOf(r)) notifications(s, this.ended);
      const res = r.type === "user" ? r.toolUseResult : null;
      if (!res || typeof res !== "object") continue;
      const at = tsOf(r) ?? 0;
      if (typeof res.backgroundTaskId === "string") this.shells.set(res.backgroundTaskId, at);
      if (typeof res.taskId === "string" && "timeoutMs" in res) {
        this.monitors.set(res.taskId, { at, until: res.persistent === true || typeof res.timeoutMs !== "number" ? null : at + res.timeoutMs });
      }
      if (typeof res.task_id === "string" && typeof res.task_type === "string") this.ended.set(res.task_id, "stopped"); // TaskStop
      if (typeof res.runId === "string" && typeof res.taskId === "string") {
        this.runTasks.set(res.runId, res.taskId);
        if (typeof res.workflowName === "string" && res.workflowName) this.runNames.set(res.runId, res.workflowName);
      }
    }
  }

  private linger(id: string, running: boolean, now: number): boolean {
    if (running) {
      this.seenRunning.add(id);
      return true;
    }
    if (!this.seenRunning.has(id)) return false; // ended before this watch saw it run
    const at = this.endedAt.get(id) ?? now;
    this.endedAt.set(id, at);
    return now - at < LINGER_MS;
  }

  private readAgents(now: number): BackgroundTask[] {
    const sub = join(this.dir, "subagents");
    let names: string[];
    try {
      names = readdirSync(sub);
    } catch {
      return [];
    }
    const out: BackgroundTask[] = [];
    for (const f of names) {
      const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(f);
      if (!m) continue;
      const id = m[1]!;
      const metaPath = join(sub, f);
      const mk = mark(metaPath);
      if (!mk) continue;
      let a = this.agents.get(id);
      if (!a || !same(a.mark, mk)) {
        const meta = parse(readAt(metaPath, 0, 64 * 1024)?.text ?? "") ?? {};
        a = { meta, mark: mk, tail: a?.tail ?? null, tailMark: a?.tailMark ?? null };
        this.agents.set(id, a);
      }
      const meta = a.meta;
      if (meta.requestShape !== "background") continue;
      // An agent that ended before this watch saw it is never read again.
      const finished = meta.finished === true || this.ended.has(id);
      if (finished && !this.seenRunning.has(id)) continue;
      const tp = join(sub, `agent-${id}.jsonl`);
      const tm = mark(tp);
      if (tm && (!a.tail || !same(a.tailMark, tm))) {
        a.tail = agentTail(tp);
        a.tailMark = tm;
      }
      const startedAt = a.tail?.first ?? mk.mtime;
      if (startedAt < this.since - SLACK_MS) continue;
      const state: BackgroundState = finished ? this.ended.get(id) ?? "done" : "running";
      if (!this.linger(id, state === "running", now)) continue;
      out.push({
        id, kind: "agent", name: typeof meta.agentType === "string" && meta.agentType ? meta.agentType : "agent",
        title: typeof meta.description === "string" && meta.description.trim() ? meta.description.trim() : null,
        activity: state === "running" ? a.tail?.activity ?? null : null,
        worktree: typeof meta.worktreeBranch === "string" && meta.worktreeBranch ? meta.worktreeBranch : null,
        state, startedAt, endedAt: state === "running" ? null : this.endedAt.get(id) ?? now,
        done: null, failed: null, total: null, tokens: a.tail?.tokens ?? null,
      });
    }
    return out;
  }

  /** The run's name and start from the script Claude Code saved as it started (`<name>-<run id>.js`). */
  private script(runId: string): { name: string | null; at: number | null } {
    const dir = join(this.dir, "workflows", "scripts");
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(`-${runId}.js`)) continue;
        const mk = mark(join(dir, f));
        return { name: f.slice(0, -(runId.length + 4)) || null, at: mk?.mtime ?? null };
      }
    } catch {}
    return { name: null, at: null };
  }

  private readRuns(now: number): BackgroundTask[] {
    const wf = join(this.dir, "subagents", "workflows");
    let ids: string[];
    try {
      ids = readdirSync(wf);
    } catch {
      return [];
    }
    const out: BackgroundTask[] = [];
    for (const runId of ids) {
      const folder = join(wf, runId);
      const endFile = join(this.dir, "workflows", `${runId}.json`);
      const endedFile = existsSync(endFile);
      if (endedFile && !this.runTasks.has(runId)) {
        // Its head names the task (the rest is the script and its result, never read).
        const head = readAt(endFile, 0, 512)?.text ?? "";
        const t = /"taskId"\s*:\s*"([^"]+)"/.exec(head)?.[1];
        if (t) this.runTasks.set(runId, t);
      }
      const task = this.runTasks.get(runId);
      const note = task ? this.ended.get(task) : undefined;
      const ended = endedFile || note !== undefined;
      if (ended && !this.seenRunning.has(runId)) continue;
      let run = this.runs.get(runId);
      if (!run) {
        const s = this.script(runId);
        let startedAt = s.at;
        if (startedAt === null) {
          try {
            const st = statSync(folder);
            startedAt = st.birthtimeMs || st.ctimeMs;
          } catch {
            continue;
          }
        }
        run = { offset: 0, agents: new Map(), name: s.name, startedAt, tokens: new Map() };
        this.runs.set(runId, run);
      }
      if ((run.startedAt ?? 0) < this.since - SLACK_MS) continue;
      this.readJournal(join(folder, "journal.jsonl"), run);
      let tokens = 0;
      let any = false;
      for (const agentId of run.agents.keys()) {
        const p = join(folder, `agent-${agentId}.jsonl`);
        const mk = mark(p);
        if (!mk) continue;
        let t = run.tokens.get(agentId);
        if (!t || !same(t.mark, mk)) {
          t = { mark: mk, tokens: agentTail(p)?.tokens ?? null };
          run.tokens.set(agentId, t);
        }
        if (t.tokens !== null) {
          tokens += t.tokens;
          any = true;
        }
      }
      const agents = [...run.agents.values()];
      const failed = agents.filter((x) => x.state === "failed").length;
      const state: BackgroundState = !ended ? "running" : note && note !== "done" ? note : failed && agents.every((x) => x.state !== "running") && failed === agents.length ? "failed" : "done";
      if (!this.linger(runId, state === "running", now)) continue;
      const working = agents.filter((x) => x.state === "running").map((x) => x.label).filter(Boolean);
      out.push({
        id: runId, kind: "workflow", name: this.runNames.get(runId) ?? run.name ?? "workflow", title: null,
        activity: state === "running" && working.length ? working.join(", ").slice(0, ACTIVITY_MAX) : null,
        worktree: null, state, startedAt: run.startedAt ?? now, endedAt: state === "running" ? null : this.endedAt.get(runId) ?? now,
        done: agents.filter((x) => x.state === "done").length, failed, total: agents.length, tokens: any ? tokens : null,
      });
    }
    return out;
  }

  /** The journal's new rows: each agent's id, label and how it ended (a `result` row's answer is parsed and dropped). */
  private readJournal(path: string, run: Run): void {
    for (let step = 0; step < 4; step++) {
      const got = readAt(path, run.offset, READ_STEP);
      if (!got || got.next === run.offset) return;
      const { lines, used } = wholeLines(got.text);
      if (!used) {
        if (got.next - run.offset >= READ_STEP) run.offset = got.next; // a row longer than a step: skipped
        return;
      }
      run.offset += used;
      for (const l of lines) {
        const r = parse(l);
        const id = typeof r?.agentId === "string" ? r.agentId : null;
        if (!r || !id) continue;
        if (r.type === "started") run.agents.set(id, { label: typeof r.label === "string" ? r.label : "", state: "running" });
        else if (r.type === "result" || r.type === "failed") {
          const a = run.agents.get(id) ?? { label: "", state: "running" as const };
          run.agents.set(id, { ...a, state: r.type === "result" ? "done" : "failed" });
        }
      }
      if (got.next >= got.size) return;
    }
  }
}

/** Looks every `everyMs` and reports a change (`null`: nothing runs in the background). */
export class BackgroundPoller {
  private watch: BackgroundWatch | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = "null";

  private report: (b: Background | null) => void;
  private everyMs: number;

  constructor(report: (b: Background | null) => void, everyMs = 1000) {
    this.report = report;
    this.everyMs = everyMs;
  }

  /** Follow this session (null: none), whose process started at `since`. */
  follow(file: string | null, since: number): void {
    if (file === this.watch?.file && since === this.watch?.since) return;
    this.watch = file ? new BackgroundWatch(file, since) : null;
    if (!this.timer && file) {
      this.timer = setInterval(() => this.look(), this.everyMs);
      this.timer.unref();
    }
    this.look();
  }

  look(): void {
    let b: Background | null = null;
    try {
      b = this.watch?.read() ?? null;
    } catch {
      b = null;
    }
    // A change of what shows (not of the time it was read).
    const key = b ? JSON.stringify({ ...b, at: 0 }) : "null";
    if (key === this.last) return;
    this.last = key;
    this.report(b);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watch = null;
    if (this.last !== "null") {
      this.last = "null";
      this.report(null);
    }
  }
}
