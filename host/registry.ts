// The chat registry (<stateDir>/chats/<chat>.json), the chat's claim
// (<stateDir>/chats/<chat>.host) and the session lock (<sessionFile>.herdr-chat.lock).
import { mkdirSync, writeFileSync, renameSync, readFileSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export type RegistryEntry = {
  v: 1;
  chat: string;
  /** The provider (pi, claude, codex); reopening the chat uses the same one. Absent in entries written before v3 (= pi). */
  provider?: string;
  pid: number | null;
  /** JSONL over TCP (the CLI, tests, other hosts). */
  port: number | null;
  /** WebSocket, for the Herdr mod (protocol.md "Transport"). Absent before 0.4: such a host speaks only JSONL. */
  wsPort?: number | null;
  token: string;
  cwd: string;
  sessionFile: string | null;
  terminal: string | null;
  startedAt: number;
  agentVersion: string | null;
  /** The host's herdr-chat version and build (build.ts): the chat asks for a restart when the install's differs. Absent before 0.3. */
  version?: string;
  build?: string;
};

export function registryPath(stateDir: string, chat: string): string {
  return join(stateDir, "chats", `${chat}.json`);
}

export function atomicWrite(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeRegistry(stateDir: string, entry: RegistryEntry): void {
  atomicWrite(registryPath(stateDir, entry.chat), JSON.stringify(entry, null, 2) + "\n");
}

export function readRegistry(stateDir: string, chat: string): RegistryEntry | null {
  try {
    return JSON.parse(readFileSync(registryPath(stateDir, chat), "utf8"));
  } catch {
    return null;
  }
}

export type LockInfo = { pid: number; chat: string; terminal: string | null; startedAt: number };

export function lockPath(sessionFile: string): string {
  return `${sessionFile}.herdr-chat.lock`;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLock(sessionFile: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(lockPath(sessionFile), "utf8"));
  } catch {
    return null;
  }
}

/** Takes the lock. Returns the other live holder if there is one (the lock is taken anyway). */
export function takeLock(sessionFile: string, info: LockInfo): LockInfo | null {
  const prev = readLock(sessionFile);
  const other = prev && prev.pid !== info.pid && pidAlive(prev.pid) ? prev : null;
  try {
    atomicWrite(lockPath(sessionFile), JSON.stringify(info) + "\n", 0o644);
  } catch {}
  return other;
}

/**
 * The chat's one host. Every app showing the chat's tab runs its own copy of
 * the chat (its machine's own app, and one on another computer showing that
 * machine's spaces), and each starts a host when none answers: two may start
 * at the same moment. The first to claim the chat serves it; another finds
 * the claim of a live host for the same chat (`isHost`) and steps aside, and
 * its chat connects to the one the registry names. A claim whose pid is gone
 * or isn't such a host is stale and taken over. Returns the serving host's
 * pid when that's another, else null (claimed, or the claim can't be made:
 * then it serves anyway, as before claims).
 */
export function claimChat(stateDir: string, chat: string, isHost: (pid: number) => boolean, pid = process.pid): number | null {
  const path = join(stateDir, "chats", `${chat}.host`);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {}
  for (let i = 0; i < 3; i++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: "wx", mode: 0o600 });
      return null;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
    let other = 0;
    try {
      other = Number(readFileSync(path, "utf8").trim());
    } catch {}
    if (other && other !== pid && pidAlive(other) && isHost(other)) return other;
    try {
      unlinkSync(path);
    } catch {}
  }
  return null;
}

/** Gives the chat's claim back, if this process holds it. */
export function releaseChat(stateDir: string, chat: string, pid = process.pid): void {
  const path = join(stateDir, "chats", `${chat}.host`);
  try {
    if (Number(readFileSync(path, "utf8").trim()) === pid) unlinkSync(path);
  } catch {}
}

/** Whether `pid` is a herdr-chat host serving `chat` (its command line: `serve … --chat <chat>`). Linux's /proc; elsewhere, false. */
export function servesChat(pid: number, chat: string): boolean {
  try {
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    const at = argv.indexOf("--chat");
    return argv.includes("serve") && at >= 0 && argv[at + 1] === chat;
  } catch {
    return false;
  }
}

/** Removes the lock only if this process holds it. */
export function releaseLock(sessionFile: string, pid = process.pid): void {
  const prev = readLock(sessionFile);
  if (prev && prev.pid !== pid) return;
  try {
    unlinkSync(lockPath(sessionFile));
  } catch {}
}
