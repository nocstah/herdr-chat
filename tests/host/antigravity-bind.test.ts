// Binding a running Antigravity CLI (`agy`) TUI to its conversation (host/providers/antigravity/bind.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindConversation, conversationArg, isAgyTui, transcriptPath } from "../../host/providers/antigravity/bind.ts";
import type { AgyBindIO } from "../../host/providers/antigravity/bind.ts";

const A = "b4eb6fd9-0bac-43cb-843d-45b695b83656";
const B = "5ced34d3-3860-4269-90cc-73f7049209da";
const DATA = "/home/me/.gemini/antigravity-cli";

function io(overrides: Partial<AgyBindIO> = {}): AgyBindIO {
  return {
    tree: (p) => [p],
    argv: () => ["agy"],
    cwd: () => "/proj",
    env: (_p, k) => (k === "HOME" ? "/home/me" : null),
    openFiles: () => [],
    exists: () => true,
    mtime: () => 1000,
    ...overrides,
  };
}

test("isAgyTui distinguishes interactive TUI invocations from headless print mode and subcommands", () => {
  assert.equal(isAgyTui(["agy"]), true);
  assert.equal(isAgyTui(["/home/me/.local/share/mise/installs/antigravity-cli/latest/agy", "--mode", "auto"]), true);
  assert.equal(isAgyTui(["agy", "--conversation", A]), true);
  assert.equal(isAgyTui(["agy", "--model=gemini-4-neon-xhigh", "--effort", "xhigh"]), true);
  assert.equal(isAgyTui(["agy", "-i", "fix the bug"]), true);
  assert.equal(isAgyTui(["agy", "--dangerously-skip-permissions", "-c"]), true);

  assert.equal(isAgyTui(["agy", "-p", "hello"]), false);
  assert.equal(isAgyTui(["agy", "--print", "hello"]), false);
  assert.equal(isAgyTui(["agy", "--prompt=hello"]), false);
  assert.equal(isAgyTui(["agy", "models"]), false);
  assert.equal(isAgyTui(["agy", "acp"]), false);
  assert.equal(isAgyTui(["agy", "mcp", "list"]), false);
  assert.equal(isAgyTui(["agy", "--model", "gemini-4-neon-high", "models"]), false);
  assert.equal(isAgyTui(["agy", "--version"]), false);
  assert.equal(isAgyTui(["claude"]), false);
  assert.equal(isAgyTui(["codex"]), false);
  assert.equal(isAgyTui([]), false);
});

test("conversationArg reads --conversation <uuid> and --conversation=<uuid>", () => {
  assert.equal(conversationArg([["agy", "--conversation", A]]), A);
  assert.equal(conversationArg([["agy", `--conversation=${A.toUpperCase()}`]]), A);
  assert.equal(conversationArg([["agy", "--conversation", "not-a-uuid"]]), null);
  assert.equal(conversationArg([["agy"]]), null);
});

test("bindConversation resolves via presence lock, then conversation DB, then --conversation argv", () => {
  // Wrapped under fish -ic (like Herdr spawns agents): walks process tree to find agy.
  const b1 = bindConversation(100, io({
    tree: (p) => (p === 100 ? [100, 101] : [101]),
    argv: (p) => (p === 100 ? ["/usr/bin/fish", "-ic", "agy"] : ["agy"]),
    openFiles: (pids) => (pids.includes(101) ? [`${DATA}/presence/${A}.lock`, `${DATA}/conversations/${A}.db`] : []),
  }));
  assert.deepEqual(b1, { id: A, path: transcriptPath(DATA, A), dataDir: DATA, tuiPid: 101, how: "lock" });

  // No presence lock yet, conversation DB open.
  const b2 = bindConversation(200, io({
    openFiles: () => [`${DATA}/conversations/${B}.db`],
  }));
  assert.equal(b2.path, transcriptPath(DATA, B));
  assert.equal(b2.path !== null && b2.how, "db");

  // Fallback to --conversation flag when /proc/fd has neither.
  const b3 = bindConversation(300, io({
    argv: () => ["agy", "--conversation", A],
  }));
  assert.equal(b3.path, transcriptPath(DATA, A));
  assert.equal(b3.path !== null && b3.how, "argv");

  // Multiple open lock files: picks the one with the newest existing transcript.
  const b4 = bindConversation(400, io({
    openFiles: () => [`${DATA}/presence/${A}.lock`, `${DATA}/presence/${B}.lock`],
    mtime: (p) => (p.includes(B) ? 5000 : 2000),
  }));
  assert.equal(b4.id, B);

  // Fresh TUI before first prompt: running, no conversation yet.
  const b5 = bindConversation(500, io());
  assert.deepEqual(b5, { id: null, path: null, dataDir: DATA, tuiPid: 500, why: "none" });

  // Quit back to shell.
  const b6 = bindConversation(600, io({ argv: () => ["fish"] }));
  assert.deepEqual(b6, { id: null, path: null, dataDir: DATA, tuiPid: null, why: "not_running" });

  // Custom ANTIGRAVITY_CLI_DATA_DIR env override.
  const b7 = bindConversation(700, io({
    env: (_p, k) => (k === "ANTIGRAVITY_CLI_DATA_DIR" ? "/custom/agy" : "/home/me"),
    openFiles: () => [`/custom/agy/presence/${A}.lock`],
  }));
  assert.equal(b7.path, transcriptPath("/custom/agy", A));
});
