// Which conversation a Codex TUI shows (host/providers/codex/bind.ts), against a
// stand-in for /proc: its own open rollout, the daemon's loaded threads of its
// folder since it started, the one its command line resumed, and its screen when
// another Codex TUI shares the folder. The converter of rollout items (items.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { bindRollout, isCodexTui, resumedId, screenScore } from "../../host/providers/codex/bind.ts";
import type { BindIO, LoadedThread, RolloutMeta } from "../../host/providers/codex/bind.ts";
import { commandLine, limitsText, RolloutFollower, threadItem } from "../../host/providers/codex/items.ts";

const A = "019a0000-0000-7000-8000-00000000000a";
const B = "019a0000-0000-7000-8000-00000000000b";
const C = "019a0000-0000-7000-8000-00000000000c";
const path = (id: string) => `/h/.codex/sessions/2026/11/21/rollout-2026-11-21T10-00-00-${id}.jsonl`;

type World = {
  argv: Record<number, string[]>; cwd: Record<number, string>; start: Record<number, number>; tree: Record<number, number[]>;
  open?: string[]; loaded: LoadedThread[] | null; meta: Record<string, RolloutMeta>; prompts?: Record<string, string[]>; others?: { pid: number; cwd: string }[];
};

function io(w: World): BindIO {
  return {
    tree: (pid) => w.tree[pid] ?? [pid],
    argv: (pid) => w.argv[pid] ?? [],
    cwd: (pid) => w.cwd[pid] ?? null,
    start: (pid) => w.start[pid] ?? null,
    env: (_pid, name) => (name === "HOME" ? "/h" : null),
    openRollouts: () => w.open ?? [],
    loaded: () => w.loaded,
    rolloutOf: (_home, id) => (w.meta[path(id)] ? path(id) : null),
    meta: (p) => w.meta[p] ?? null,
    tuis: () => [{ pid: 11, cwd: w.cwd[11] ?? null, start: w.start[11] ?? null }, ...(w.others ?? []).map((o) => ({ pid: o.pid, cwd: o.cwd, start: 0 }))],
    prompts: (p) => w.prompts?.[p] ?? [],
  };
}

// The terminal's foreground: npm's launcher (node codex.js) with the native TUI under it.
const base = (): World => ({
  argv: { 10: ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"], 11: ["/usr/lib/node_modules/@openai/codex/vendor/codex", "-c", "model=x"] },
  cwd: { 10: "/proj", 11: "/proj" }, start: { 11: 1_000_000 }, tree: { 10: [10, 11] },
  loaded: [], meta: {},
});
const meta = (id: string, cwd = "/proj", interactive = true): RolloutMeta => ({ id, cwd, interactive });

test("a TUI's process, not Codex's servers or runs", () => {
  assert.equal(isCodexTui(["codex"]), true);
  assert.equal(isCodexTui(["/x/codex", "-c", "model=gpt", "fix the bug"]), true);
  assert.equal(isCodexTui(["codex", "resume", A]), true);
  assert.equal(isCodexTui(["node", "/x/bin/codex.js", "--yolo"]), true);
  assert.equal(isCodexTui(["codex", "app-server", "--listen", "unix://"]), false);
  assert.equal(isCodexTui(["/usr/lib/chatgpt/resources/codex", "-c", "features.code_mode_host=true", "app-server"]), false);
  assert.equal(isCodexTui(["codex", "exec", "hi"]), false);
  assert.equal(isCodexTui(["bash", "-c", "codex"]), false);
  assert.equal(resumedId([["node", "codex.js"], ["codex", "resume", A.toUpperCase()]]), A);
  assert.equal(resumedId([["codex", "resume", "--last"]]), null);
});

test("the rollout it holds open is its own; else the newest of its folder the daemon loaded since it started", () => {
  const w = base();
  w.open = [path(A)];
  w.meta[path(A)] = meta(A);
  assert.deepEqual(bindRollout(10, io(w)), { path: path(A), id: A, how: "open" });

  const d = base();
  d.meta = { [path(A)]: meta(A), [path(B)]: meta(B), [path(C)]: meta(C, "/elsewhere") };
  d.loaded = [
    { id: A, loadedAt: 900_000, holder: 99 }, // an earlier TUI's, loaded before this one started
    { id: B, loadedAt: 1_000_500, holder: 99 },
    { id: C, loadedAt: 1_000_900, holder: 99 }, // another folder's
  ];
  assert.deepEqual(bindRollout(10, io(d)), { path: path(B), id: B, how: "loaded" });

  // A /new in the terminal loads another: newer, so it's the one now.
  const D = "019a0000-0000-7000-8000-00000000000d";
  d.meta[path(D)] = meta(D);
  d.loaded.push({ id: D, loadedAt: 1_005_000, holder: 99 });
  assert.equal(bindRollout(10, io(d)).path, path(D));

  // Not a `codex exec` run's or a subagent's thread, nor one another TUI holds itself (--no-daemon).
  const e = base();
  e.meta = { [path(A)]: meta(A, "/proj", false), [path(B)]: meta(B) };
  e.loaded = [{ id: A, loadedAt: 1_000_100, holder: 99 }, { id: B, loadedAt: 1_000_200, holder: 12 }];
  e.others = [{ pid: 12, cwd: "/other" }];
  assert.deepEqual(bindRollout(10, io(e)), { path: null, why: "none", candidates: [] });
});

test("a resumed thread is its own though it was loaded before; nothing loaded yet is none", () => {
  const w = base();
  w.argv[11] = ["codex", "resume", A];
  w.meta[path(A)] = meta(A, "/somewhere-else");
  w.loaded = [{ id: A, loadedAt: 500_000, holder: 99 }];
  assert.deepEqual(bindRollout(10, io(w)), { path: path(A), id: A, how: "resumed" });
  assert.deepEqual(bindRollout(10, io(base())), { path: null, why: "none", candidates: [] });
  // Off Linux (no lock table): only the command line tells.
  const off = base();
  off.loaded = null;
  off.argv[11] = ["codex", "resume", B];
  off.meta[path(B)] = meta(B);
  assert.deepEqual(bindRollout(10, io(off)), { path: path(B), id: B, how: "resumed" });
});

test("another Codex TUI in the folder: the screen tells, else no guess", () => {
  const w = base();
  w.meta = { [path(A)]: meta(A), [path(B)]: meta(B) };
  w.loaded = [{ id: A, loadedAt: 1_000_100, holder: 99 }, { id: B, loadedAt: 1_000_200, holder: 99 }];
  w.others = [{ pid: 12, cwd: "/proj" }];
  w.prompts = { [path(A)]: ["write the parser", "now add tests for it"], [path(B)]: ["what does this repo do?"] };
  assert.deepEqual(bindRollout(10, io(w)), { path: null, why: "ambiguous", candidates: [path(B), path(A)] });
  const screen = "› write the parser\n\n• Done.\n\n› now add tests for it\n\n• Working (3s • esc to interrupt)\n";
  assert.deepEqual(bindRollout(10, io(w), () => screen), { path: path(A), id: A, how: "screen" });
  assert.equal(bindRollout(10, io(w), () => "› something else entirely\n").path, null);
  assert.equal(screenScore(screen, ["now add tests for it"]), 1);
  assert.equal(screenScore(screen, ["no"]), 0); // too short to tell
});

// ---- the rollout's items as a chat's -----------------------------------------------------

test("TurnItems become the ThreadItems map.ts reads", () => {
  assert.deepEqual(threadItem({ type: "UserMessage", id: "u1", client_id: "tui-7", content: [{ type: "text", text: "hi", text_elements: [] }, { type: "local_image", path: "/a.png" }] }),
    { type: "userMessage", id: "u1", content: [{ type: "text", text: "hi" }, { type: "localImage", path: "/a.png" }] });
  assert.deepEqual(threadItem({ type: "AgentMessage", id: "m1", content: [{ type: "Text", text: "Hello " }, { type: "Text", text: "there" }], phase: "final_answer" }),
    { type: "agentMessage", id: "m1", text: "Hello there", phase: "final_answer" });
  assert.deepEqual(threadItem({ type: "Reasoning", id: "r1", summary_text: ["Thinking"], raw_content: [] }), { type: "reasoning", id: "r1", summary: ["Thinking"], content: [] });
  assert.deepEqual(threadItem({
    type: "CommandExecution", id: "c1", process_id: "7", command: ["/bin/bash", "-lc", "ls -la"], cwd: "/p", source: "agent", status: "failed",
    parsed_cmd: [{ type: "list_files", cmd: "ls -la", path: null }], aggregated_output: "x", exit_code: 2, duration: { secs: 1, nanos: 500_000_000 },
  }), { type: "commandExecution", id: "c1", command: "ls -la", cwd: "/p", commandActions: [{ type: "listFiles", command: "ls -la", path: null }], aggregatedOutput: "x", exitCode: 2, durationMs: 1500, status: "failed" });
  assert.deepEqual(threadItem({ type: "FileChange", id: "f1", changes: { "/p/a.txt": { type: "add", content: "one\n" }, "/p/b.txt": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: null } }, status: "completed", stdout: "", stderr: "" }),
    { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "/p/a.txt", kind: { type: "add" }, diff: "one\n" }, { path: "/p/b.txt", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }] });
  assert.deepEqual(threadItem({ type: "Extension", id: "w1", kind: "web_search", query: "q", action: { type: "search", query: null, queries: ["q"] }, results: [{ title: "T", url: "u" }] }),
    { type: "webSearch", id: "w1", query: "q", action: { type: "search", query: null, queries: ["q"] }, results: [{ title: "T", url: "u" }] });
  assert.deepEqual(threadItem({ type: "ContextCompaction", id: "k1" }), { type: "contextCompaction", id: "k1" });
  assert.equal(threadItem({ type: "AgentMessage" }), null);
  assert.equal(commandLine(["git", "commit", "-m", "it's done"]), "git commit -m 'it'\\''s done'");
  assert.equal(limitsText({ primary: { used_percent: 12.4, window_minutes: 300 }, secondary: { used_percent: 30, window_minutes: 10080 } }), "limits 5h 12% · week 30%");
});

test("a turn's records as the chat's events: its message, its command card, its end, the model", () => {
  const f = new RolloutFollower();
  const ev = (type: string, payload: Record<string, unknown>) => f.feed({ timestamp: "2026-11-21T10:00:00Z", type, payload });
  ev("session_meta", { id: A, cwd: "/proj", source: "cli" });
  const model = ev("turn_context", { model: "gpt-5.5", effort: "high", cwd: "/proj" });
  assert.deepEqual(model.map((e) => e.type), ["model", "thinking"]);
  ev("event_msg", { type: "task_started", turn_id: "t1" });
  const user = ev("event_msg", { type: "item_completed", thread_id: A, item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "list files" }] } });
  assert.deepEqual(user.map((e) => [e.type, (e as any).text]), [["user_message", "list files"]]);
  const think = ev("event_msg", { type: "item_completed", item: { type: "Reasoning", id: "r1", summary_text: ["Looking"], raw_content: [] } });
  assert.deepEqual(think.map((e) => e.type), ["assistant_start", "assistant_block_end"]);
  const cmd = ev("event_msg", { type: "item_completed", item: { type: "CommandExecution", id: "c1", command: ["bash", "-lc", "ls"], cwd: "/proj", status: "completed", parsed_cmd: [], aggregated_output: "a\nb\n", exit_code: 0, duration: { secs: 0, nanos: 1000 } } });
  assert.deepEqual(cmd.map((e) => e.type), ["assistant_end", "tool_started", "tool_ended"]);
  assert.equal((cmd[2] as any).output, "a\nb\n");
  const answer = ev("event_msg", { type: "item_completed", item: { type: "AgentMessage", id: "m1", content: [{ type: "Text", text: "Two files." }] } });
  assert.deepEqual(answer.map((e) => e.type), ["assistant_start", "assistant_block_end"]);
  assert.equal(f.turn, "running");
  const end = ev("event_msg", { type: "task_complete", turn_id: "t1" });
  assert.deepEqual(end.map((e) => e.type), ["assistant_end"]);
  assert.equal((end[0] as any).model, "openai/gpt-5.5");
  assert.equal(f.turn, "ended");
  const plan = ev("response_item", { type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "Read", status: "completed" }, { step: "Write", status: "in_progress" }] }) });
  assert.deepEqual(plan, [{ type: "plan", ts: Date.parse("2026-11-21T10:00:00Z"), steps: [{ text: "Read", status: "completed" }, { text: "Write", status: "in_progress" }] }]);
  const limits = ev("event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11 }, last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 11 }, model_context_window: 1000 }, rate_limits: { primary: { used_percent: 1, window_minutes: 10080 } } });
  assert.deepEqual(limits, [{ type: "status", key: "codex-limits", text: "limits week 1%" }]);
  assert.deepEqual(f.usage(), { contextTokens: 10, contextWindow: 1000 });
});
