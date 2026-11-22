// The shell commands a Claude Code process runs now, as its TUI counts them in its footer ("2 background tasks") and
// lists them under ↓ (Claude Code 2.1.33x). The TUI keeps that list in memory; the processes say the same: Claude Code
// runs each command (a Bash call, a Monitor, a Code Mode script's `$`) as a child `bash -c '… eval '<command>' …'` of
// its own, in a session of its own, writing to `<tmp>/claude-<uid>/<project>/<session>/tasks/<task id>.output` (the
// `taskId` a backgrounded call's result names). So the children of its process whose stdout is such a file are its
// running commands: their task ids, commands, starts and output files. Linux only (/proc); elsewhere, none.
import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync } from "node:fs";

export type ShellProc = {
  /** The shell's process (its own session and process group: a stop signals the group). */
  pid: number;
  /** The task id: the output file's name. */
  id: string;
  /** Its output file. */
  output: string;
  /** The command as it was given (the eval's word), or null when the command line says otherwise. */
  command: string | null;
  /** When the process started (ms), or null. */
  startedAt: number | null;
};

const TASK_FILE = /\/tasks\/([A-Za-z0-9_-]+)\.output$/;

/** The children of `pid`, from every thread's list (a spawn can come from any). */
export function childrenOf(pid: number, proc = "/proc"): number[] {
  const out = new Set<number>();
  let threads: string[];
  try {
    threads = readdirSync(`${proc}/${pid}/task`);
  } catch {
    return [];
  }
  for (const t of threads) {
    let s = "";
    try {
      s = readFileSync(`${proc}/${pid}/task/${t}/children`, "utf8");
    } catch {
      continue;
    }
    for (const w of s.split(/\s+/)) if (/^\d+$/.test(w)) out.add(Number(w));
  }
  return [...out];
}

let boot: number | null | undefined;
/** The boot time (ms), for process start times. */
function bootTime(proc: string): number | null {
  if (boot !== undefined && proc === "/proc") return boot;
  let b: number | null = null;
  try {
    const m = /^btime (\d+)$/m.exec(readFileSync(`${proc}/stat`, "utf8"));
    b = m ? Number(m[1]) * 1000 : null;
  } catch {}
  if (proc === "/proc") boot = b;
  return b;
}

/** A process's start (ms): /proc/<pid>/stat's starttime, in clock ticks (100 a second on Linux) after boot. */
export function startOf(pid: number, proc = "/proc"): number | null {
  try {
    const s = readFileSync(`${proc}/${pid}/stat`, "utf8");
    // The name is in parentheses and may hold spaces: the fields after its closing one.
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(rest[19]); // field 22 overall
    const b = bootTime(proc);
    return Number.isFinite(ticks) && b !== null ? b + ticks * 10 : null;
  } catch {
    return null;
  }
}

/**
 * The command a Claude Code shell runs: the word after `eval` in `bash -c '…'`'s script, unquoted as the shell
 * would (Claude Code quotes it in single quotes, a quote inside as `'"'"'`). Null when there is no eval.
 */
export function evalCommand(script: string): string | null {
  const at = script.lastIndexOf(" eval ");
  if (at < 0) return null;
  let i = at + 6;
  let out = "";
  let any = false;
  while (i < script.length) {
    const ch = script[i]!;
    if (ch === "'") {
      const end = script.indexOf("'", i + 1);
      if (end < 0) return null;
      out += script.slice(i + 1, end);
      i = end + 1;
      any = true;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < script.length && script[j] !== '"'; j++) {
        if (script[j] === "\\" && j + 1 < script.length && '"\\$`'.includes(script[j + 1]!)) j++;
        out += script[j];
      }
      if (j >= script.length) return null;
      i = j + 1;
      any = true;
    } else if (ch === "\\" && i + 1 < script.length) {
      out += script[i + 1];
      i += 2;
      any = true;
    } else if (/\s/.test(ch)) break;
    else {
      out += ch;
      i++;
      any = true;
    }
  }
  return any ? out : null;
}

/** A process's command line: its arguments joined by spaces (bash -c's script is the last). */
function cmdline(pid: number, proc: string): string[] {
  try {
    return readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0").filter((x, i, a) => x || i < a.length - 1);
  } catch {
    return [];
  }
}

/** The commands `pid` (a Claude Code process) runs now. */
export function shellsOf(pid: number, proc = "/proc"): ShellProc[] {
  if (process.platform !== "linux" && proc === "/proc") return [];
  const out: ShellProc[] = [];
  for (const child of childrenOf(pid, proc)) {
    let target: string;
    try {
      target = readlinkSync(`${proc}/${child}/fd/1`);
    } catch {
      continue;
    }
    const m = TASK_FILE.exec(target);
    if (!m) continue;
    const argv = cmdline(child, proc);
    const script = argv.length >= 3 && argv[argv.length - 2] === "-c" ? argv[argv.length - 1]! : argv.join(" ");
    out.push({ pid: child, id: m[1]!, output: target, command: evalCommand(script), startedAt: startOf(child, proc) });
  }
  return out;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** The end of an output file: at most `max` bytes, from a line's start, without terminal codes; `cut` when it started later. */
export function outputTail(path: string, max = 48 * 1024): { text: string; cut: boolean; size: number } | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const from = Math.max(0, size - max);
    const buf = Buffer.alloc(size - from);
    const got = readSync(fd, buf, 0, buf.length, from);
    let text = buf.subarray(0, got).toString("utf8");
    if (from > 0) text = text.slice(text.indexOf("\n") + 1);
    // A progress bar's carriage returns: each line as it was left.
    text = text.replace(ANSI, "").split("\n").map((l) => l.slice(l.lastIndexOf("\r", l.length - 2) + 1).replace(/\r$/, "")).join("\n");
    return { text, cut: from > 0, size };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
