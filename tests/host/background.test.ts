// What a Claude Code session runs in the background, read from its files as the TUI's agents panel shows it
// (host/providers/claude/background.ts), and the strip's words (herdr-app/mods/chat/background.js). A made-up session:
// every transcript, journal, script and answer here is test text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundPoller, BackgroundWatch, LINGER_MS, activityOf, usageTokens } from "../../host/providers/claude/background.ts";
// @ts-expect-error a plain JS module of the mod's
import { bgElapsed, bgRows, bgSummary, bgTicking, bgTokens } from "../../herdr-app/mods/chat/background.js";

type Rec = Record<string, any>;
const T0 = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const json = (o: unknown) => JSON.stringify(o) + "\n";
const SECRET = "an answer no panel may show";

function session() {
  const root = mkdtempSync(join(tmpdir(), "herdr-chat-bg-"));
  const file = join(root, "5e1f0c2a-0000-4000-8000-0000000000aa.jsonl");
  const dir = file.replace(/\.jsonl$/, "");
  const sub = join(dir, "subagents");
  mkdirSync(sub, { recursive: true });
  writeFileSync(file, json({ type: "user", uuid: "u0", timestamp: iso(T0), message: { role: "user", content: "Run the made-up suites" } }));
  const usage = (n: number) => ({ input_tokens: n, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 500 });
  const agentLog = (path: string, at: number, calls: { name: string; input: Rec; tokens: number }[]) => {
    writeFileSync(path, json({ type: "user", uuid: "a0", timestamp: iso(at), isSidechain: true, message: { role: "user", content: "a made-up task" } }));
    calls.forEach((c, i) => appendFileSync(path, json({ type: "assistant", uuid: `a${i + 1}`, timestamp: iso(at + (i + 1) * 1000), isSidechain: true,
      message: { id: `m${i}`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: c.name, input: c.input }], usage: usage(c.tokens) } })));
  };
  const s = {
    root, file, dir,
    append: (r: Rec) => appendFileSync(file, json(r)),
    agent(id: string, meta: Rec, at: number, calls: { name: string; input: Rec; tokens: number }[]) {
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", requestShape: "background", isBuiltIn: true, ...meta }));
      agentLog(join(sub, `agent-${id}.jsonl`), at, calls);
    },
    meta(id: string, meta: Rec) {
      writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: "general-purpose", requestShape: "background", ...meta }));
    },
    run(runId: string, name: string, at: number) {
      mkdirSync(join(sub, "workflows", runId), { recursive: true });
      writeFileSync(join(sub, "workflows", runId, "journal.jsonl"), json({ type: "launched" }));
      mkdirSync(join(dir, "workflows", "scripts"), { recursive: true });
      const script = join(dir, "workflows", "scripts", `${name}-${runId}.js`);
      writeFileSync(script, "export const meta = { name: 'made up' };\n");
      utimesSync(script, new Date(at), new Date(at));
    },
    started(runId: string, agentId: string, label: string, at: number, tokens: number) {
      appendFileSync(join(sub, "workflows", runId, "journal.jsonl"), json({ type: "started", key: `Phase:${label}`, agentId, label, phase: "Phase" }));
      agentLog(join(sub, "workflows", runId, `agent-${agentId}.jsonl`), at, [{ name: "Bash", input: { command: "make test", description: `Run ${label}` }, tokens }]);
    },
    answered(runId: string, agentId: string) {
      appendFileSync(join(sub, "workflows", runId, "journal.jsonl"), json({ type: "result", key: "k", agentId, result: { summary: SECRET }, toolsUsed: ["Bash"] }));
    },
    failed(runId: string, agentId: string) {
      appendFileSync(join(sub, "workflows", runId, "journal.jsonl"), json({ type: "failed", key: "k", agentId }));
    },
    ended(runId: string, taskId: string, at: number) {
      writeFileSync(join(dir, "workflows", `${runId}.json`), JSON.stringify({ runId, timestamp: iso(at), taskId, script: "made up", result: { summary: SECRET } }));
    },
    notify(id: string, status: string, where: "queue" | "attachment" | "user" = "queue") {
      const body = `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>made up</summary>\n<result>${SECRET}</result>\n</task-notification>`;
      if (where === "queue") s.append({ type: "queue-operation", operation: "enqueue", timestamp: iso(T0), content: body });
      else if (where === "attachment") s.append({ type: "attachment", uuid: `n${id}`, timestamp: iso(T0), attachment: { type: "queued_command", prompt: body, commandMode: "task-notification" } });
      else s.append({ type: "user", uuid: `n${id}`, timestamp: iso(T0), message: { role: "user", content: body } });
    },
    done: () => rmSync(root, { recursive: true, force: true }),
  };
  return s;
}

test("a background agent: its type, task, worktree, what it does now, its time and tokens, as the TUI's row has them", () => {
  const s = session();
  try {
    s.agent("a1", { description: "Check the made-up suites", worktreePath: "/tmp/wt", worktreeBranch: "agent-a1" }, T0 + 2000, [
      { name: "Read", input: { file_path: "/tmp/demo/a.ts" }, tokens: 10_000 },
      { name: "Bash", input: { command: "npm test\nmore", description: "Run the made-up tests" }, tokens: 40_000 },
    ]);
    // A foreground agent (inline in the transcript, not on the panel) and one from before this process started.
    s.agent("a2", { requestShape: "foreground", description: "inline" }, T0 + 2000, [{ name: "Read", input: {}, tokens: 5 }]);
    s.agent("a3", { description: "from an earlier process" }, T0 - 3_600_000, [{ name: "Read", input: {}, tokens: 5 }]);
    const w = new BackgroundWatch(s.file, T0);
    const b = w.read(T0 + 60_000)!;
    assert.equal(b.tasks.length, 1);
    assert.deepEqual(b.tasks[0], {
      id: "a1", kind: "agent", name: "general-purpose", title: "Check the made-up suites", activity: "Bash · Run the made-up tests",
      worktree: "agent-a1", state: "running", startedAt: T0 + 2000, endedAt: null, done: null, failed: null, total: null,
      tokens: 40_000 + 1000 + 2000 + 500,
    });
    assert.deepEqual([b.shells, b.monitors], [0, 0]);
  } finally {
    s.done();
  }
});

test("an agent's end: marked done or failed for a moment, then gone; one already over at the first look never shows", () => {
  const s = session();
  try {
    s.agent("a1", { description: "one" }, T0 + 1000, [{ name: "Bash", input: { command: "true" }, tokens: 100 }]);
    s.agent("a2", { description: "two" }, T0 + 1000, [{ name: "Bash", input: { command: "true" }, tokens: 100 }]);
    s.agent("old", { description: "over before", finished: true }, T0 + 1000, [{ name: "Bash", input: { command: "true" }, tokens: 100 }]);
    const w = new BackgroundWatch(s.file, T0);
    assert.deepEqual(w.read(T0 + 5000)!.tasks.map((t) => [t.id, t.state]), [["a1", "running"], ["a2", "running"]]);
    s.meta("a1", { description: "one", finished: true });
    s.notify("a2", "failed", "attachment");
    const ended = w.read(T0 + 9000)!;
    assert.deepEqual(ended.tasks.map((t) => [t.id, t.state, t.endedAt, t.activity]), [["a1", "done", T0 + 9000, null], ["a2", "failed", T0 + 9000, null]]);
    assert.equal(w.read(T0 + 9000 + LINGER_MS + 1), null);
    assert.ok(!JSON.stringify(ended).includes(SECRET), "a notification's result is never read out");
  } finally {
    s.done();
  }
});

test("a workflow run: its name and start from its script, done/total from its journal, tokens summed over its agents, its end", () => {
  const s = session();
  try {
    s.run("wf_0a1b2c3d-001", "made-up-gates", T0 + 1000);
    s.started("wf_0a1b2c3d-001", "w1", "core suite", T0 + 2000, 100_000);
    s.started("wf_0a1b2c3d-001", "w2", "browser suite", T0 + 2000, 200_000);
    s.started("wf_0a1b2c3d-001", "w3", "review", T0 + 3000, 1_000);
    s.answered("wf_0a1b2c3d-001", "w1");
    s.failed("wf_0a1b2c3d-001", "w2");
    // The launch's result names its task (what the end's notification names).
    s.append({ type: "user", uuid: "l1", timestamp: iso(T0 + 1000), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_w", content: "launched" }] },
      toolUseResult: { status: "async_launched", taskId: "wtask1", runId: "wf_0a1b2c3d-001", workflowName: "made-up-gates", summary: "made up" } });
    const w = new BackgroundWatch(s.file, T0);
    const t = w.read(T0 + 642_000)!.tasks[0]!;
    const per = 1000 + 2000 + 500;
    assert.deepEqual(t, {
      id: "wf_0a1b2c3d-001", kind: "workflow", name: "made-up-gates", title: null, activity: "review", worktree: null, state: "running",
      startedAt: T0 + 1000, endedAt: null, done: 1, failed: 1, total: 3, tokens: 100_000 + 200_000 + 1_000 + 3 * per,
    });
    s.answered("wf_0a1b2c3d-001", "w3");
    s.notify("wtask1", "killed");
    const end = w.read(T0 + 650_000)!.tasks[0]!;
    assert.deepEqual([end.state, end.done, end.total, end.activity], ["stopped", 2, 3, null]);
    assert.ok(!JSON.stringify(end).includes(SECRET), "a result row's answer is never read out");
    // Ended by its end file alone (no notification yet): done.
    s.run("wf_0a1b2c3d-002", "second", T0 + 700_000);
    s.started("wf_0a1b2c3d-002", "x1", "only", T0 + 700_000, 10);
    assert.equal(w.read(T0 + 701_000)!.tasks.find((x) => x.id === "wf_0a1b2c3d-002")!.state, "running");
    s.answered("wf_0a1b2c3d-002", "x1");
    s.ended("wf_0a1b2c3d-002", "wtask2", T0 + 702_000);
    assert.equal(w.read(T0 + 702_000)!.tasks.find((x) => x.id === "wf_0a1b2c3d-002")!.state, "done");
  } finally {
    s.done();
  }
});

test("shells and monitors are counted while they run; a notification, a TaskStop or a monitor's timeout ends one", () => {
  const s = session();
  try {
    const result = (id: string, tur: Rec, at = T0 + 1000) => s.append({ type: "user", uuid: `r${id}`, timestamp: iso(at), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: tur });
    result("t1", { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b1" });
    result("t2", { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "b2" });
    result("t3", { taskId: "m1", timeoutMs: 60_000, persistent: false });
    result("t4", { taskId: "m2", timeoutMs: 60_000, persistent: true });
    result("t5", { stdout: "", backgroundTaskId: "b0" }, T0 - 600_000); // an earlier process's
    const w = new BackgroundWatch(s.file, T0);
    assert.deepEqual(((b) => [b.shells, b.monitors])(w.read(T0 + 2000)!), [2, 2]);
    s.notify("b1", "completed", "user");
    result("t6", { task_id: "b2", task_type: "local_bash", message: "stopped", command: "sleep 99" });
    const b = w.read(T0 + 120_000)!;
    assert.deepEqual([b.shells, b.monitors, b.tasks.length], [0, 1, 0]);
    s.notify("m2", "completed");
    assert.equal(w.read(T0 + 121_000), null, "nothing left: null");
  } finally {
    s.done();
  }
});

test("Code Mode: work a REPL script started leaves the same files, and its ends come through the queue", () => {
  const s = session();
  try {
    // No launch record in the transcript at all: the files alone.
    s.agent("c1", { description: "from a script", enclosingToolUseId: "toolu_repl" }, T0 + 1000, [{ name: "Grep", input: { pattern: "made-up" }, tokens: 1 }]);
    s.run("wf_0a1b2c3d-009", "script-run", T0 + 1000);
    s.started("wf_0a1b2c3d-009", "c2", "phase one", T0 + 1000, 1);
    s.append({ type: "queue-operation", operation: "enqueue", timestamp: iso(T0), content: '<event kind="repl-eval">made up</event>' });
    const w = new BackgroundWatch(s.file, T0);
    assert.deepEqual(w.read(T0 + 2000)!.tasks.map((t) => [t.kind, t.name, t.activity]), [["workflow", "script-run", "phase one"], ["agent", "general-purpose", "Grep · made-up"]]);
    s.notify("c1", "completed");
    assert.equal(w.read(T0 + 3000)!.tasks.find((t) => t.id === "c1")!.state, "done");
  } finally {
    s.done();
  }
});

test("the poller reports a change of what shows, not of the time it was read", async () => {
  const s = session();
  try {
    const got: unknown[] = [];
    const p = new BackgroundPoller((b) => got.push(b), 60_000);
    s.agent("a1", { description: "one" }, Date.now(), [{ name: "Bash", input: { command: "true" }, tokens: 100 }]);
    p.follow(s.file, Date.now() - 1000);
    p.look();
    p.look();
    assert.equal(got.length, 1);
    s.agent("a1", { description: "one" }, Date.now(), [{ name: "Bash", input: { command: "true" }, tokens: 100 }, { name: "Read", input: { file_path: "/x" }, tokens: 200 }]);
    p.look();
    assert.equal(got.length, 2);
    p.stop();
    assert.equal(got.at(-1), null, "stopped: nothing runs");
  } finally {
    s.done();
  }
});

test("a tool call's activity and a call's tokens, as the TUI counts them", () => {
  assert.equal(activityOf("Bash", { command: "a\nb" }), "Bash · a");
  assert.equal(activityOf("Edit", { file_path: "/x/y.ts" }), "Edit · /x/y.ts");
  assert.equal(activityOf("StructuredOutput", { answer: SECRET }), null);
  assert.equal(activityOf("TodoWrite", {}), "TodoWrite");
  assert.equal(activityOf("Bash", { command: "x".repeat(400) })!.length, "Bash · ".length + 160);
  assert.equal(usageTokens({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }), 10);
  assert.equal(usageTokens(null), null);
});

test("the strip's words: the TUI's times and token counts, the footer's heading, each row", () => {
  assert.deepEqual([bgElapsed(45_000), bgElapsed(642_000), bgElapsed(3_720_000), bgElapsed(183_600_000)], ["45s", "10m42s", "1h02m", "2d03h"]);
  assert.deepEqual([bgTokens(950), bgTokens(303_000), bgTokens(1_234_567), bgTokens(0), bgTokens(null)], ["950", "303.0k", "1.2m", null, null]);
  const b = {
    at: T0 + 642_000, shells: 1, monitors: 0, tasks: [
      { id: "w", kind: "workflow", name: "made-up-gates", title: null, activity: "review", worktree: null, state: "running", startedAt: T0, endedAt: null, done: 0, failed: 0, total: 1, tokens: 303_000 },
      { id: "a", kind: "agent", name: "general-purpose", title: "Check things", activity: "Bash · npm test", worktree: "agent-a", state: "running", startedAt: T0 + 600_000, endedAt: null, done: null, failed: null, total: null, tokens: null },
      { id: "z", kind: "agent", name: "Explore", title: "Look", activity: "Read · x", worktree: null, state: "failed", startedAt: T0, endedAt: T0 + 30_000, done: null, failed: null, total: null, tokens: 1500 },
    ],
  };
  assert.equal(bgSummary(b), "2 background tasks · 1 shell");
  assert.equal(bgSummary({ ...b, tasks: [b.tasks[1]] }), "1 background agent · 1 shell");
  assert.equal(bgSummary({ ...b, shells: 0, tasks: [b.tasks[2]] }), "1 background task ended");
  const rows = bgRows(b, b.at);
  assert.deepEqual(rows.map((r: any) => r.meta), ["0/1 · 10m42s · ↓ 303.0k tokens", "42s", "failed · 30s · ↓ 1.5k tokens"]);
  assert.deepEqual(rows.map((r: any) => [r.title, r.activity, r.worktree, r.progress]), [["", "review", null, 0], ["Check things", "Bash · npm test", "agent-a", null], ["Look", "", null, null]]);
  assert.equal(bgTicking(b), true);
  assert.equal(bgTicking({ ...b, tasks: [b.tasks[2]] }), false);
});
