// Which conversation a Codex TUI shows, for the terminal view (terminal.ts).
//
// Since Codex 0.157 a TUI runs its threads in the shared app-server daemon,
// which holds the rollout files open, so the TUI's process no longer says
// which one is its. What does tell, in order:
//
// 1. a rollout the TUI's own processes hold open (`codex --no-daemon`, older
//    Codex): its own;
// 2. the threads loaded right now: Codex locks `thread-writer-locks/<id>.lock`
//    while a thread is loaded and removes it when it unloads (codex-rs
//    rollout/src/writer_lock.rs, as Ovis reads it: server/codex.ts
//    heldThreadIds), its change time is when it was loaded. A TUI's thread is
//    one of them, of its folder, interactive (not `codex exec`, not a
//    subagent), loaded since the TUI started, or the one its command line
//    resumed. With no other Codex TUI in the folder the newest is its (a /new
//    or /resume there loads another, which is newer);
// 3. with others in the folder, what its screen shows: the thread whose last
//    messages are on it. Nothing certain: no binding (the view says so and
//    waits), never a guess.
//
// Linux reads (/proc); elsewhere only the first and the command line.
import { closeSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { processTree } from "../tui.ts";

type Rec = Record<string, any>;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ROLLOUT = /\/rollout-[^/]*\.jsonl$/;
const LOCK = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
/** Codex subcommands that aren't a TUI (a TUI's first argument is a flag, a prompt, `resume` or `fork`). */
const NOT_TUI = new Set(["app-server", "exec", "e", "mcp-server", "mcp", "login", "logout", "apply", "a", "cloud", "completion", "sandbox", "debug", "features", "remote-control", "daemon", "proto", "responses-api-proxy", "stdio-to-uds", "help", "doctor", "update", "upgrade"]);
/** Codex flags that take the next word as their value. */
const VALUE_FLAGS = new Set(["-c", "--config", "-m", "--model", "-p", "--profile", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "-i", "--image", "--enable", "--disable", "--remote", "--local-provider", "--add-dir"]);
/** A thread loaded this long before its TUI started is an earlier TUI's. */
const SLACK_MS = 2000;

/** A rollout's first record: what thread, where, and whether a person talks to it. */
export type RolloutMeta = { id: string; cwd: string | null; interactive: boolean };
export type LoadedThread = { id: string; loadedAt: number; holder: number };
export type CodexTui = { pid: number; cwd: string | null; start: number | null };

/** What the binding reads, so tests can stand in for /proc. */
export interface BindIO {
  tree(pid: number): number[];
  argv(pid: number): string[];
  cwd(pid: number): string | null;
  /** When it started (ms since 1970), or null. */
  start(pid: number): number | null;
  env(pid: number, name: string): string | null;
  /** The rollouts these processes hold open. */
  openRollouts(pids: number[]): string[];
  /** Threads loaded now in this Codex home, with who holds each; null: can't be read here. */
  loaded(home: string): LoadedThread[] | null;
  /** A thread's rollout file, or null. */
  rolloutOf(home: string, id: string): string | null;
  meta(path: string): RolloutMeta | null;
  /** Every Codex TUI process on this computer of this home (the native one, not a launcher). */
  tuis(home: string): CodexTui[];
  /** The user messages of a rollout, oldest first. */
  prompts(path: string): string[];
}

export type Binding =
  | { path: string; id: string; how: "open" | "resumed" | "loaded" | "screen" }
  | { path: null; why: "none" | "ambiguous"; candidates: string[] };

const real = (p: string | null) => {
  if (!p) return p;
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Whether this argv is a Codex TUI's (the native binary or its npm launcher's script). */
export function isCodexTui(argv: string[]): boolean {
  const prog = basename(argv[0] ?? "");
  let rest: string[];
  if (/^codex(?:-[\w.-]+)?$/.test(prog)) rest = argv.slice(1);
  else if (/^(?:node|bun)$/.test(prog) && /\/codex(?:\.js)?$/.test(argv[1] ?? "")) rest = argv.slice(2);
  else return false;
  // The first word that isn't a flag or a flag's value (`-c key=value app-server` is a server).
  let sub: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") break;
    if (VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-")) {
      sub = a;
      break;
    }
  }
  return sub === null || !NOT_TUI.has(sub);
}

/** The thread a command line resumes (`codex resume <id>`, `fork <id>` starts another). */
export function resumedId(argvs: string[][]): string | null {
  for (const argv of argvs) {
    const at = argv.indexOf("resume");
    const id = at < 0 ? undefined : argv[at + 1];
    if (id && UUID.test(id) && UUID.exec(id)![0] === id) return id.toLowerCase();
  }
  return null;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** How many of the conversation's last messages show on the screen as Codex draws them (`› text`). */
export function screenScore(screen: string, prompts: string[]): number {
  const lines = screen.split("\n").map((l) => norm(l.replace(/^\s*›\s?/, "")));
  const shown = (p: string) => {
    const head = norm(p).slice(0, 48);
    return head.length >= 4 && lines.some((l) => l.length >= 4 && (l.startsWith(head) || head.startsWith(l)));
  };
  let score = 0;
  for (const p of prompts.slice(-3)) if (shown(p)) score++;
  return score;
}

/**
 * The conversation the Codex TUI under `pid` (the terminal's foreground) shows.
 * `screen`: its screen now, read when the threads alone don't tell.
 */
export function bindRollout(pid: number, io: BindIO, screen?: () => string | null): Binding {
  const tree = io.tree(pid);
  const tui = tree.find((p) => isCodexTui(io.argv(p))) ?? pid;
  const home = io.env(tui, "CODEX_HOME") ?? join(io.env(tui, "HOME") ?? homedir(), ".codex");
  const none = (why: "none" | "ambiguous", candidates: string[] = []): Binding => ({ path: null, why, candidates });

  // 1. One it holds open itself.
  const open = [...new Set(io.openRollouts(tree).filter((f) => ROLLOUT.test(f)))].filter((f) => io.meta(f)?.interactive !== false);
  if (open.length === 1) {
    const m = io.meta(open[0]!);
    return { path: open[0]!, id: m?.id ?? UUID.exec(basename(open[0]!))?.[0] ?? "", how: "open" };
  }

  const cwd = real(io.cwd(tui));
  const start = io.start(tui);
  const resumed = resumedId(tree.map((p) => io.argv(p)));
  const loaded = io.loaded(home);
  if (loaded === null) {
    if (!resumed) return none("none");
    const path = io.rolloutOf(home, resumed);
    return path ? { path, id: resumed, how: "resumed" } : none("none");
  }

  // 2. The threads loaded now, of its folder, since it started (or the one it resumed); not one another TUI holds itself.
  const tuiPids = new Set(io.tuis(home).map((t) => t.pid));
  type Cand = { id: string; path: string; loadedAt: number };
  const cands: Cand[] = [];
  for (const t of loaded) {
    if (tuiPids.has(t.holder) && !tree.includes(t.holder)) continue; // another TUI's own (--no-daemon)
    const path = io.rolloutOf(home, t.id);
    if (!path) continue;
    const m = io.meta(path);
    if (!m || !m.interactive) continue;
    const mine = t.id === resumed || (cwd !== null && real(m.cwd) === cwd && (start === null || t.loadedAt >= start - SLACK_MS));
    if (mine) cands.push({ id: t.id, path, loadedAt: t.loadedAt });
  }
  if (!cands.length) return none("none");
  cands.sort((a, b) => b.loadedAt - a.loadedAt);
  const peers = io.tuis(home).filter((t) => !tree.includes(t.pid) && cwd !== null && real(t.cwd) === cwd);
  if (!peers.length) return { path: cands[0]!.path, id: cands[0]!.id, how: cands[0]!.id === resumed && cands.length === 1 ? "resumed" : "loaded" };

  // 3. Others in its folder: what its screen shows.
  const text = screen?.() ?? null;
  if (text) {
    const scored = cands.map((c) => ({ c, s: screenScore(text, io.prompts(c.path)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (scored.length && (scored.length === 1 || scored[0]!.s > scored[1]!.s)) return { path: scored[0]!.c.path, id: scored[0]!.c.id, how: "screen" };
  }
  return none("ambiguous", cands.map((c) => c.path));
}

// ---------------------------------------------------------------- this computer

const metaCache = new Map<string, RolloutMeta | null>();

function readHead(path: string, max = 256 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** A rollout's session_meta: thread, folder, whether it's a person's conversation. */
export function rolloutMeta(path: string): RolloutMeta | null {
  if (metaCache.has(path)) return metaCache.get(path)!;
  let out: RolloutMeta | null = null;
  try {
    const first = readHead(path).split("\n", 1)[0] ?? "";
    const r = JSON.parse(first);
    const p: Rec = r?.type === "session_meta" && r.payload && typeof r.payload === "object" ? r.payload : {};
    if (typeof p.id === "string") {
      const source = p.source;
      const exec = source === "exec" || p.originator === "codex_exec";
      const sub = (source && typeof source === "object") || p.thread_source === "subagent" || p.thread_source === "guardian_review";
      out = { id: p.id.toLowerCase(), cwd: typeof p.cwd === "string" ? p.cwd : null, interactive: !exec && !sub };
    }
  } catch {
    return null; // not written yet: ask again
  }
  if (out) metaCache.set(path, out);
  return out;
}

/** A UUIDv7's time (ms), for the day folder a thread's rollout is in. */
function uuidTime(id: string): number | null {
  const hex = id.replace(/-/g, "").slice(0, 12);
  const t = parseInt(hex, 16);
  return id[14] === "7" && Number.isFinite(t) ? t : null;
}

const rolloutPaths = new Map<string, string>();

/** The rollout of a thread: under sessions/YYYY/MM/DD, the day its id was made (and the days around it), then the last week. */
export function findRollout(home: string, id: string): string | null {
  const key = `${home}\0${id}`;
  const known = rolloutPaths.get(key);
  if (known) return known;
  const root = join(home, "sessions");
  const t = uuidTime(id);
  const now = Date.now();
  const seen = new Set<string>();
  const days = [...(t !== null ? [0, -1, 1].map((d) => new Date(t + d * 86_400_000)) : []), ...[0, -1, -2, -3, -4, -5, -6].map((d) => new Date(now + d * 86_400_000))];
  for (const d of days) {
    const day = d.toDateString();
    if (seen.has(day)) continue;
    seen.add(day);
    const dir = join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const f = names.find((n) => n.startsWith("rollout-") && n.toLowerCase().endsWith(`-${id.toLowerCase()}.jsonl`));
    if (f) {
      const path = join(dir, f);
      rolloutPaths.set(key, path);
      return path;
    }
  }
  return null;
}

/**
 * The threads loaded now: each lock file in `thread-writer-locks` the kernel
 * shows a write flock on (/proc/locks) by a process that has that very file
 * open, with when it was made and who holds it. null off Linux.
 */
export function loadedThreads(home: string): LoadedThread[] | null {
  if (process.platform !== "linux") return null;
  let folder: string;
  try {
    folder = realpathSync(join(home, "thread-writer-locks"));
  } catch {
    return [];
  }
  const byIno = new Map<string, { id: string; born: number }>();
  for (const name of readdirSync(folder)) {
    const m = LOCK.exec(name);
    if (!m) continue;
    try {
      const st = statSync(join(folder, name), { bigint: true });
      byIno.set(st.ino.toString(), { id: m[1]!.toLowerCase(), born: Number(st.ctimeMs) });
    } catch {}
  }
  if (!byIno.size) return [];
  const out = new Map<string, LoadedThread>();
  // A lock taken or dropped between two pages of /proc/locks can hide another: three reads.
  for (let read = 0; read < 3 && out.size < byIno.size; read++) {
    let table: string;
    try {
      table = readFileSync("/proc/locks", "utf8");
    } catch {
      return null;
    }
    const openBy = new Map<string, Set<string>>();
    for (const line of table.split("\n")) {
      const m = /^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/.exec(line);
      const lock = m ? byIno.get(m[2]!) : undefined;
      if (!m || !lock || out.has(lock.id)) continue;
      let names = openBy.get(m[1]!);
      if (!names) {
        names = new Set();
        openBy.set(m[1]!, names);
        try {
          for (const fd of readdirSync(`/proc/${m[1]}/fd`)) {
            try {
              const target = readlinkSync(`/proc/${m[1]}/fd/${fd}`);
              if (target.startsWith(`${folder}/`)) names.add(basename(target));
            } catch {}
          }
        } catch {}
      }
      if (names.has(`${lock.id}.lock`) || [...names].some((n) => n.toLowerCase() === `${lock.id}.lock`)) out.set(lock.id, { id: lock.id, loadedAt: lock.born, holder: Number(m[1]) });
    }
  }
  return [...out.values()];
}

const argvOf = (pid: number): string[] => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a, i, all) => a || i < all.length - 1);
  } catch {
    return [];
  }
};

function envOf(pid: number, name: string): string | null {
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) if (kv.startsWith(`${name}=`)) return kv.slice(name.length + 1) || null;
  } catch {}
  return null;
}

let ticks: number | null = null;
let boot: number | null = null;
/** When a process started (ms), from /proc/<pid>/stat and the boot time. */
export function startOf(pid: number): number | null {
  try {
    if (boot === null) boot = Number(/^btime (\d+)/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]) * 1000;
    ticks ??= 100; // USER_HZ on Linux
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const t = Number(fields[19]);
    return Number.isFinite(t) && boot ? boot + (t * 1000) / ticks : null;
  } catch {
    return null;
  }
}

function openRolloutsOf(pids: number[]): string[] {
  const out: string[] = [];
  for (const pid of pids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          const t = readlinkSync(`/proc/${pid}/fd/${fd}`);
          if (ROLLOUT.test(t)) out.push(t);
        } catch {}
      }
    } catch {}
  }
  return out;
}

function codexTuis(home: string): CodexTui[] {
  const out: CodexTui[] = [];
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return out;
  }
  for (const p of pids) {
    const pid = Number(p);
    const argv = argvOf(pid);
    // The native binary, not its npm launcher (node codex.js), so each TUI counts once.
    if (!argv.length || !/^codex(?:-[\w.-]+)?$/.test(basename(argv[0]!)) || !isCodexTui(argv)) continue;
    const h = envOf(pid, "CODEX_HOME") ?? join(envOf(pid, "HOME") ?? homedir(), ".codex");
    if (real(h) !== real(home)) continue;
    let cwd: string | null = null;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {}
    out.push({ pid, cwd, start: startOf(pid) });
  }
  return out;
}

/** A rollout's user messages (UserMessage items), oldest first; the last 64 kB of it is enough for a screen's worth. */
export function rolloutPrompts(path: string): string[] {
  let text: string;
  try {
    const size = statSync(path).size;
    const from = Math.max(0, size - 512 * 1024);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - from);
      readSync(fd, buf, 0, buf.length, from);
      text = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"UserMessage"')) continue;
    try {
      const it = JSON.parse(line)?.payload?.item;
      if (it?.type !== "UserMessage" || !Array.isArray(it.content)) continue;
      const t = it.content.filter((c: Rec) => c?.type === "text").map((c: Rec) => String(c.text ?? "")).join("\n").trim();
      if (t) out.push(t);
    } catch {}
  }
  return out;
}

export const LINUX_IO: BindIO = {
  tree: processTree,
  argv: argvOf,
  cwd: (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  start: startOf,
  env: envOf,
  openRollouts: openRolloutsOf,
  loaded: loadedThreads,
  rolloutOf: findRollout,
  meta: rolloutMeta,
  tuis: codexTuis,
  prompts: rolloutPrompts,
};
