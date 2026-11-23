// Which conversation an Antigravity CLI (`agy`) TUI shows, for the terminal view
// (terminal.ts).
//
// Each interactive `agy` process holds open its own presence lock
// (`~/.gemini/antigravity-cli/presence/<id>.lock`) and active conversation DB
// (`~/.gemini/antigravity-cli/conversations/<id>.db`), so inspecting its open
// file descriptors identifies the exact conversation — even when multiple `agy`
// terminals run in the same folder. Before the first message of a fresh session
// no lock exists yet (`why: "none"`); `--conversation <id>` serves as fallback.
import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { processTree } from "../tui.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LOCK_RE = /\/presence\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/i;
const DB_RE = /\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/i;

/** `agy` subcommands that aren't the interactive TUI. */
const NOT_TUI = new Set([
  "acp", "agent", "agents", "changelog", "help", "install", "mcp",
  "mic-serve", "models", "plugin", "plugins", "remote-control", "update",
]);

/** Flags that take the next word as their value. */
const VALUE_FLAGS = new Set([
  "--add-dir", "--agent", "--conversation", "--effort", "--input-format",
  "--json-schema", "--log-file", "--mode", "--model", "--output-format",
  "--print-timeout", "--project", "--settings", "-i", "--prompt-interactive",
]);

/** Flags that indicate headless / non-TUI invocations. */
const HEADLESS_FLAGS = new Set(["-p", "--print", "--prompt", "--version", "-v", "--help", "-h"]);

export interface AgyBindIO {
  tree(pid: number): number[];
  argv(pid: number): string[];
  cwd(pid: number): string | null;
  env(pid: number, name: string): string | null;
  /** Open file descriptor targets for these PIDs (Linux: /proc/<pid>/fd). */
  openFiles(pids: number[]): string[];
  exists(path: string): boolean;
  mtime(path: string): number | null;
}

export type AgyBinding =
  | { id: string; path: string; dataDir: string; tuiPid: number; how: "lock" | "db" | "argv" }
  | { id: null; path: null; dataDir: string; tuiPid: number | null; why: "not_running" | "none" };

/** Whether `argv` is an interactive `agy` / `antigravity` TUI process (not headless `-p` or a subcommand). */
export function isAgyTui(argv: string[]): boolean {
  const prog = basename(argv[0] ?? "");
  if (!/^(?:agy|antigravity)(?:-[\w.-]+)?$/.test(prog)) return false;
  const rest = argv.slice(1);
  let sub: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") break;
    const eq = a.indexOf("=");
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (HEADLESS_FLAGS.has(flag)) return false;
    if (VALUE_FLAGS.has(flag)) {
      if (eq < 0) i++;
      continue;
    }
    if (!a.startsWith("-")) {
      sub = a;
      break;
    }
  }
  return sub === null || !NOT_TUI.has(sub);
}

/** `--conversation <id>` from the process's argv, if present. */
export function conversationArg(argvs: string[][]): string | null {
  for (const argv of argvs) {
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      let val: string | undefined;
      if (a === "--conversation") val = argv[i + 1];
      else if (a.startsWith("--conversation=")) val = a.slice("--conversation=".length);
      if (val && UUID.test(val) && UUID.exec(val)![0] === val) return val.toLowerCase();
    }
  }
  return null;
}

/** Where `agy` keeps its data for `pid` (default `~/.gemini/antigravity-cli`). */
export function dataDirOf(pid: number, io: AgyBindIO): string {
  const override = io.env(pid, "ANTIGRAVITY_CLI_DATA_DIR") ?? process.env.ANTIGRAVITY_CLI_DATA_DIR;
  if (override) return override;
  const home = io.env(pid, "HOME") ?? homedir();
  return join(home, ".gemini", "antigravity-cli");
}

/** The compact JSONL transcript written live for conversation `id`. */
export function transcriptPath(dataDir: string, id: string): string {
  return join(dataDir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
}

function pickId(ids: string[], dataDir: string, io: AgyBindIO): string | null {
  const uniq = [...new Set(ids.map((x) => x.toLowerCase()))];
  if (!uniq.length) return null;
  if (uniq.length === 1) return uniq[0]!;
  // Multiple open files: prefer the one whose transcript exists and was updated most recently.
  return uniq.sort((a, b) => {
    const pa = transcriptPath(dataDir, a);
    const pb = transcriptPath(dataDir, b);
    const ea = io.exists(pa) ? 1 : 0;
    const eb = io.exists(pb) ? 1 : 0;
    if (ea !== eb) return eb - ea;
    return (io.mtime(pb) ?? 0) - (io.mtime(pa) ?? 0);
  })[0]!;
}

/**
 * Find the conversation currently shown by the `agy` TUI running under `pid`
 * (the terminal's foreground process or one of its descendants).
 */
export function bindConversation(pid: number, io: AgyBindIO): AgyBinding {
  const tree = io.tree(pid);
  const tui = tree.find((p) => isAgyTui(io.argv(p))) ?? null;
  const dataDir = dataDirOf(tui ?? pid, io);
  if (tui === null) return { id: null, path: null, dataDir, tuiPid: null, why: "not_running" };

  // Only inspect FDs of the `agy` process (and its children) so we don't pick up unrelated shell siblings.
  const agyPids = io.tree(tui);
  const files = io.openFiles(agyPids);

  const lockIds: string[] = [];
  const dbIds: string[] = [];
  for (const f of files) {
    const lm = LOCK_RE.exec(f);
    if (lm) {
      lockIds.push(lm[1]!);
      continue;
    }
    const dm = DB_RE.exec(f);
    if (dm) dbIds.push(dm[1]!);
  }

  const fromLock = pickId(lockIds, dataDir, io);
  if (fromLock) return { id: fromLock, path: transcriptPath(dataDir, fromLock), dataDir, tuiPid: tui, how: "lock" };

  const fromDb = pickId(dbIds, dataDir, io);
  if (fromDb) return { id: fromDb, path: transcriptPath(dataDir, fromDb), dataDir, tuiPid: tui, how: "db" };

  const fromArg = conversationArg(agyPids.map((p) => io.argv(p)));
  if (fromArg) return { id: fromArg, path: transcriptPath(dataDir, fromArg), dataDir, tuiPid: tui, how: "argv" };

  return { id: null, path: null, dataDir, tuiPid: tui, why: "none" };
}

// ---------------------------------------------------------------- Linux /proc

function argvOf(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter((a, i, all) => a || i < all.length - 1);
  } catch {
    return [];
  }
}

function envOf(pid: number, name: string): string | null {
  try {
    for (const kv of readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) if (kv.startsWith(`${name}=`)) return kv.slice(name.length + 1) || null;
  } catch {}
  return null;
}

function openFilesOf(pids: number[]): string[] {
  const out: string[] = [];
  for (const pid of pids) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        try {
          out.push(readlinkSync(`/proc/${pid}/fd/${fd}`));
        } catch {}
      }
    } catch {}
  }
  return out;
}

export const LINUX_IO: AgyBindIO = {
  tree: processTree,
  argv: argvOf,
  cwd: (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
  env: envOf,
  openFiles: openFilesOf,
  exists: existsSync,
  mtime: (p) => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  },
};
