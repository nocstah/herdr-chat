// Claude Code's session files: ~/.claude/projects/<cwd, non-alphanumerics → '-'>/<id>.jsonl
// ($CLAUDE_CONFIG_DIR instead of ~/.claude), and the CLI's live-process registry
// ~/.claude/sessions/<pid>.json.
import { readdirSync, statSync, readFileSync, realpathSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import type { NormalizedEvent, SessionInfo, SessionScope } from "../types.ts";
import { jsonlFiles, subdirs } from "../../jsonl.ts";

type Rec = Record<string, any>;

export function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/** The CLI resolves the cwd (macOS /tmp → /private/tmp), then replaces every non-alphanumeric with '-'. */
export function projectDir(cwd: string, dir: string = configDir()): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {}
  let enc = real.replace(/[^A-Za-z0-9]/g, "-");
  // Long names are cut and given a hash (sessions docs); 200 is the CLI's limit.
  if (enc.length > 200) enc = enc.slice(0, 200) + "-" + createHash("sha256").update(real).digest("hex").slice(0, 8);
  return join(dir, "projects", enc);
}

/** `dir`: the Claude config folder (another process's CLAUDE_CONFIG_DIR), else this one's. */
export function sessionPath(cwd: string, id: string, dir?: string): string {
  return join(projectDir(cwd, dir), `${id}.jsonl`);
}

export function sessionIdOf(path: string): string {
  return basename(path).replace(/\.jsonl$/, "");
}

const MAX_READ = 32 * 1024 * 1024;

/** The records of a transcript (at most 32 MiB of it); unparsable lines are skipped. */
export function readTranscript(path: string): Rec[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const n = Math.min(size, MAX_READ);
  const buf = Buffer.alloc(n);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, n, 0);
  } finally {
    closeSync(fd);
  }
  const out: Rec[] = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r);
    } catch {}
  }
  return out;
}

/**
 * Whether the session was started in Claude Code's Code Mode (experimental),
 * whose `repl-mode` records say so. Claude Code resumes such a session only in
 * its terminal (`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1 claude --resume <id>`):
 * `claude -p --resume` exits with "This session was started in Code Mode …
 * so it can't be resumed here" (2.1.329), so a chat can't take it over.
 */
export function codeModeSession(path: string): boolean {
  return readTranscript(path).some((r) => r.type === "repl-mode" && r.replMode === true);
}

/** A user record that a person typed (not a tool result, a CLI marker or a meta record). */
/**
 * A `!` command the person ran in Claude Code's TUI (its bash mode): the
 * command (`<bash-input>`), or what it printed (`<bash-stdout>` and
 * `<bash-stderr>`, the next record). Else null.
 */
export function bashOf(r: Rec): { input: string } | { stdout: string; stderr: string } | null {
  if (r?.type !== "user" || r.isSidechain) return null;
  const c = r.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) && c.length === 1 && c[0]?.type === "text" ? String(c[0].text ?? "") : null;
  if (text === null) return null;
  const t = text.trim();
  const input = /^<bash-input>([\s\S]*)<\/bash-input>$/.exec(t);
  if (input) return { input: input[1]! };
  if (!t.startsWith("<bash-stdout>") && !t.startsWith("<bash-stderr>")) return null;
  const part = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(t)?.[1] ?? "";
  return { stdout: part("bash-stdout"), stderr: part("bash-stderr") };
}

/**
 * bashOf's records as a Bash tool card, as Pi's own `!` runs show (pi/adapter.ts
 * bashExecution): the command starts a card (`callId`: the record's), its output
 * ends the open one. `open`: the card waiting for its output, carried from record
 * to record by the caller.
 */
export function bashEvents(r: Rec, open: { callId: string | null }, t: { ts?: number }): NormalizedEvent[] | null {
  const b = bashOf(r);
  if (!b) return null;
  if ("input" in b) {
    open.callId = `you-bash-${String(r.uuid ?? Date.now())}`; // "you-": the person's run, a card of its own (rows.js)
    return [{ type: "tool_call", callId: open.callId, name: "Bash", args: { command: b.input }, ...t }];
  }
  if (!open.callId) return [];
  const callId = open.callId;
  open.callId = null;
  const output = [b.stdout, b.stderr].filter((s) => s.trim()).join("\n");
  return [{ type: "tool_ended", callId, name: "Bash", isError: Boolean(b.stderr.trim()) && !b.stdout.trim(), output, ...t }];
}

export function promptText(r: Rec): string | null {
  if (r.type !== "user" || r.isSidechain || r.isMeta || r.isCompactSummary) return null;
  const c = r.message?.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: Rec) => b?.type === "tool_result")) return null;
    text = c.filter((b: Rec) => b?.type === "text").map((b: Rec) => b.text).join("\n");
    if (!text && !c.some((b: Rec) => b?.type === "image")) return null;
  } else return null;
  const cmd = /^<command-name>\/?([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/.exec(text.trim());
  if (cmd) return `/${cmd[1]!.trim()}${cmd[2]?.trim() ? " " + cmd[2].trim() : ""}`;
  if (/^<local-command-(stdout|stderr|caveat)>/.test(text.trim())) return null;
  if (bashOf(r)) return null;
  if (/^\[Request interrupted by user/.test(text.trim())) return null;
  return text;
}

export function describeSession(path: string): SessionInfo | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  let name: string | null = null;
  let first = "";
  let count = 0;
  let cwd: string | null = null;
  const ids = new Set<string>();
  for (const r of readTranscript(path)) {
    if (r.type === "custom-title" && typeof r.customTitle === "string") name = r.customTitle || null;
    if (!cwd && typeof r.cwd === "string" && r.cwd) cwd = r.cwd;
    if (r.isSidechain) continue;
    const p = promptText(r);
    if (p !== null) {
      count++;
      if (!first) first = p.slice(0, 200);
    } else if (r.type === "assistant" && !r.isVirtual && typeof r.message?.id === "string" && !ids.has(r.message.id)) {
      // (Code Mode records each call its code made as an assistant record of its own, `isVirtual`: not a message.)
      ids.add(r.message.id);
      count++;
    }
  }
  return { path, name, firstMessage: first, modified: st.mtimeMs, messageCount: count, cwd };
}

/**
 * This cwd's session files, or with `all` every project's (ours are `entrypoint:
 * sdk-cli`; the TUI's own picker hides them, ours doesn't).
 */
export function sessionFiles(cwd: string, scope: SessionScope): string[] {
  return jsonlFiles(scope === "all" ? subdirs(join(configDir(), "projects")) : [projectDir(cwd)]);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Another live Claude Code process on this session, from the CLI's own registry. */
export function liveHolder(sessionId: string, exceptPid?: number): { pid: number; kind?: string } | null {
  const dir = join(configDir(), "sessions");
  if (!existsSync(dir)) return null;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const r = JSON.parse(readFileSync(join(dir, n), "utf8"));
      if (r?.sessionId === sessionId && typeof r.pid === "number" && r.pid !== exceptPid && pidAlive(r.pid)) return { pid: r.pid, kind: r.kind };
    } catch {}
  }
  return null;
}

/** `effortLevel` and `permissions.defaultMode` from the user's settings, if set. */
export function readUserSettings(): { effortLevel?: string; defaultMode?: string } {
  try {
    const s = JSON.parse(readFileSync(join(configDir(), "settings.json"), "utf8"));
    return {
      ...(typeof s?.effortLevel === "string" ? { effortLevel: s.effortLevel } : {}),
      ...(typeof s?.permissions?.defaultMode === "string" ? { defaultMode: s.permissions.defaultMode } : {}),
    };
  } catch {
    return {};
  }
}
