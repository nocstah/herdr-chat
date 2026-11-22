// Claude Code's Code Mode in the chat view: what a Poll waits for (host/providers/claude/repl.ts, live and in history),
// the commands Claude Code runs as rows of the background strip (shells.ts, background.ts), and an opened row's detail
// (the mod's background.js). A made-up session and a made-up /proc: every command, output and script here is test text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplScripts, scriptEnds, scriptEndTimes, scriptTitle } from "../../host/providers/claude/repl.ts";
import { evalCommand, outputTail, shellsOf, type ShellProc } from "../../host/providers/claude/shells.ts";
import { BackgroundWatch, SHELL_LINGER_MS, SHELL_SHOW_MS, shownCommand } from "../../host/providers/claude/background.ts";
import { TranscriptFollower } from "../../host/providers/claude/follow.ts";
import { historyOf } from "../../host/providers/claude/history.ts";
import { Timeline } from "../../host/timeline.ts";
import { CLAUDE_TOOLS } from "../../host/providers/claude/tools.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";
// @ts-expect-error a plain JS module of the mod's
import { bgDetailEmpty, bgDetailLines, bgRows, bgSummary } from "../../herdr-app/mods/chat/background.js";

type Rec = Record<string, any>;
const T0 = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();
const ended = (n: number, status = "settled") => `<event kind="repl-eval" at="${iso(T0)}" eval="${n}" ms="12" status="${status}">\n<result>a made-up result</result>\n</event>`;

// ---------------------------------------------------------------- repl.ts

test("scriptTitle: a REPL call's description, else its code's first line, cut", () => {
  assert.equal(scriptTitle({ code: "await x()", description: "Run the made-up suite" }), "Run the made-up suite");
  assert.equal(scriptTitle({ code: "\n  const a = 1;\nmore()" }), "const a = 1;");
  assert.equal(scriptTitle({ code: "x".repeat(200) }).length, 80);
  assert.equal(scriptTitle(null), "");
});

test("scriptEnds: each repl-eval event's number, in any attribute order, never one that still runs", () => {
  const text = [ended(3), `<event nonce="ab" eval="4" kind="repl-eval" status="settled">`, `<event kind="repl-status" pending="1">`,
    `<event kind="repl-eval" eval="5" status="running">`, `<event kind="task-notification">`].join("\n");
  assert.deepEqual(scriptEnds(text), [3, 4]);
  assert.deepEqual(scriptEnds("no events"), []);
});

test("ReplScripts: a Poll made with its REPL call waits for the script, then knows its number", () => {
  const r = new ReplScripts();
  assert.equal(r.call("c1", "REPL", { code: "await run()", description: "Run the made-up suite" }), null);
  assert.equal(r.call("p1", "Poll", {}), "Waiting for Run the made-up suite");
  assert.deepEqual(r.result("c1", "(dispatched #3)"), [{ callId: "p1", name: "Poll", label: "Waiting for #3 Run the made-up suite" }]);
  // Its end in the Poll's own result: that Poll keeps its label; a later Poll waits for nothing.
  assert.deepEqual(r.result("p1", [{ type: "text", text: ended(3) }]), []);
  assert.equal(r.call("p2", "Poll", {}), "Waiting");
  assert.deepEqual(r.running(), []);
});

test("ReplScripts: an end in the queue ends the script, not a Poll's words; a number not above the open ones is a new REPL", () => {
  const r = new ReplScripts();
  r.call("c1", "REPL", { code: "a()", description: "First" });
  r.result("c1", "(dispatched #1)");
  r.call("c2", "REPL", { code: "b()", description: "Second" });
  r.result("c2", "(dispatched #2)");
  assert.equal(r.call("p1", "Poll", {}), "Waiting for #1 First, #2 Second");
  // Its end comes before the Poll's result: the Poll keeps saying what it waited for; the next one waits for #2 only.
  assert.deepEqual(r.text(ended(1)), []);
  assert.equal(r.call("p0", "Poll", {}), "Waiting for #2 Second");
  r.result("p0", ended(2));
  // Claude Code started again: #1 again, the old #2 went with the old REPL.
  r.result("p1", "(no pending events)");
  r.call("c3", "REPL", { code: "c()", description: "Third" });
  r.result("c3", "(dispatched #1)");
  assert.deepEqual(r.running(), [{ n: 1, title: "Third" }]);
});

test("ReplScripts in history: an end off the branch still counts, by its time", () => {
  const ends = scriptEndTimes([{ type: "queue-operation", timestamp: iso(T0 + 5000), content: ended(1) }]);
  const r = new ReplScripts(ends);
  r.call("c1", "REPL", { code: "a()", description: "First" }, T0);
  r.result("c1", "(dispatched #1)", T0);
  assert.equal(r.call("p1", "Poll", {}, T0 + 1000), "Waiting for #1 First");
  assert.equal(r.call("p2", "Poll", {}, T0 + 6000), "Waiting");
});

// A Code Mode turn as Claude Code 2.1.330 writes it: the REPL and Poll calls in one message, the dispatch's result
// beside the branch (the branch goes on from the Poll), the end in the queue, an attachment and the Poll's result.
function codeModeTurn(): Rec[] {
  let n = 0;
  const at = (s: number) => iso(T0 + s * 1000);
  const asst = (uuid: string, parent: string, block: Rec, s: number) => ({ type: "assistant", uuid, parentUuid: parent, timestamp: at(s), message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [block], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } } });
  void n;
  return [
    { type: "user", uuid: "u1", parentUuid: null, timestamp: at(0), message: { role: "user", content: "Run the made-up suite" } },
    asst("a1", "u1", { type: "tool_use", id: "toolu_repl", name: "REPL", input: { code: "await $`make test`", description: "Run the made-up suite" } }, 1),
    asst("a2", "a1", { type: "tool_use", id: "toolu_poll", name: "Poll", input: {} }, 1),
    { type: "user", uuid: "r1", parentUuid: "a2", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_repl", content: "(dispatched #7)" }] }, toolUseResult: { code: "x" } },
    { type: "queue-operation", operation: "enqueue", timestamp: at(40), content: ended(7) },
    { type: "attachment", uuid: "at1", parentUuid: "a2", timestamp: at(40), attachment: { type: "poll_events", envelopes: [ended(7)] } },
    { type: "user", uuid: "r2", parentUuid: "at1", timestamp: at(40), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_poll", content: ended(7) }] } },
    { type: "assistant", uuid: "a3", parentUuid: "r2", timestamp: at(41), message: { id: "m2", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "The made-up suite passed." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
}

const FILE = "/tmp/code-mode-test/-tmp-demo/5e1f0c2a-0000-4000-8000-0000000000c1.jsonl";
const titles = (tl: Timeline) => tl.items.filter((i: any) => i.kind === "tool").map((i: any) => [i.name, i.title, i.status]);

test("live: a Poll's row says what it waits for, the REPL's row its description and ends; the activity's words", () => {
  const f = new TranscriptFollower(FILE);
  const tl = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  const evs: NormalizedEvent[] = [];
  for (const r of codeModeTurn()) for (const ev of f.feed(r)) { evs.push(ev); tl.apply(ev); }
  const poll = evs.find((e) => e.type === "tool_call" && e.name === "Poll") as any;
  assert.equal(poll.label, "Waiting for Run the made-up suite");
  assert.ok(evs.some((e) => e.type === "tool_label" && e.label === "Waiting for #7 Run the made-up suite"));
  assert.deepEqual(titles(tl), [["REPL", "Run the made-up suite", "done"], ["Poll", "Waiting for #7 Run the made-up suite", "done"]]);
  const repl = tl.items.find((i: any) => i.name === "REPL") as any;
  assert.deepEqual(repl.detail, { type: "script", code: "await $`make test`" });
});

test("history: the same rows, the dispatch read from beside the branch", () => {
  const tl = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  for (const ev of historyOf(codeModeTurn(), FILE)) tl.apply(ev);
  assert.deepEqual(titles(tl), [["REPL", "Run the made-up suite", "done"], ["Poll", "Waiting for #7 Run the made-up suite", "done"]]);
});

test("a label outlasts the call's args shown again", () => {
  const tl = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  tl.apply({ type: "tool_call", callId: "p", name: "Poll", args: {}, label: "Waiting for #2 Build" });
  tl.apply({ type: "tool_call", callId: "p", name: "Poll", args: {} });
  assert.equal((tl.items.find((i: any) => i.kind === "tool") as any).title, "Waiting for #2 Build");
  tl.apply({ type: "tool_label", callId: "p", label: "Waiting for #3 Test" });
  assert.equal((tl.items.find((i: any) => i.kind === "tool") as any).title, "Waiting for #3 Test");
  tl.apply({ type: "tool_label", callId: "nobody", label: "x" }); // unknown call: nothing
});

// ---------------------------------------------------------------- shells.ts

test("evalCommand: the command as Claude Code quoted it", () => {
  const script = `source /tmp/snap.sh 2>/dev/null || true && eval 'echo '"'"'it'"'"'s; sleep 5' < /dev/null && pwd -P >| /tmp/claude-ab-cwd`;
  assert.equal(evalCommand(script), "echo 'it's; sleep 5");
  assert.equal(evalCommand(`eval "a \\"b\\"" < /dev/null`.replace(/^/, "x ")), 'a "b"');
  assert.equal(evalCommand("bash -c 'no eval here'"), null);
});

function fakeProc() {
  const root = mkdtempSync(join(tmpdir(), "herdr-chat-proc-"));
  const tasks = join(root, "tmp", "claude-1000", "-tmp-demo", "sess", "tasks");
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(root, "stat"), "cpu 1 2 3\nbtime 1800000000\n");
  const proc = (pid: number, ppid: number, cmd: string[], out: string | null, ticks: number) => {
    mkdirSync(join(root, String(pid), "fd"), { recursive: true });
    mkdirSync(join(root, String(pid), "task", String(pid)), { recursive: true });
    writeFileSync(join(root, String(pid), "cmdline"), cmd.join("\0") + "\0");
    // Fields after the name: state, ppid, … starttime is the 20th of them.
    const rest = ["S", String(ppid), ...Array(17).fill("0"), String(ticks), "0"];
    writeFileSync(join(root, String(pid), "stat"), `${pid} (bash (x)) ${rest.join(" ")}`);
    if (out) symlinkSync(out, join(root, String(pid), "fd", "1"));
    else symlinkSync("/dev/null", join(root, String(pid), "fd", "1"));
  };
  proc(100, 1, ["claude"], null, 1);
  writeFileSync(join(root, "100", "task", "100", "children"), "101 102 ");
  const out = join(tasks, "bshell01.output");
  writeFileSync(out, "\x1b[32mstep 1\x1b[0m\nprogress 10%\rprogress 90%\nstep 2\n");
  proc(101, 100, ["/bin/bash", "-c", "source /tmp/s.sh && eval 'make test' < /dev/null && pwd -P >| /tmp/c"], out, 250);
  proc(102, 100, ["bun", "mcp.ts"], null, 300);
  return { root, out, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("shellsOf: the children writing to a task file, with their commands and starts", () => {
  const p = fakeProc();
  try {
    assert.deepEqual(shellsOf(100, p.root), [{ pid: 101, id: "bshell01", output: p.out, command: "make test", startedAt: 1800000000 * 1000 + 2500 }]);
    assert.deepEqual(shellsOf(999, p.root), []);
  } finally {
    p.done();
  }
});

test("outputTail: without terminal codes, a progress line as it was left, cut at a line", () => {
  const p = fakeProc();
  try {
    assert.deepEqual(outputTail(p.out), { text: "step 1\nprogress 90%\nstep 2\n", cut: false, size: outputTail(p.out)!.size });
    const t = outputTail(p.out, 12)!;
    assert.equal(t.cut, true);
    assert.equal(t.text, "step 2\n");
    assert.equal(outputTail(join(p.root, "missing")), null);
  } finally {
    p.done();
  }
});

// ---------------------------------------------------------------- background.ts: commands as rows

test("shownCommand: no terminal codes or control characters; a row's first line", () => {
  assert.equal(shownCommand("echo \"\x1b[32mok\x1b[0m\"\tdone"), 'echo "ok" done');
  assert.equal(shownCommand("cd app\n\nnpm test", true), "cd app …");
  assert.equal(shownCommand("make", true), "make");
  assert.equal(shownCommand(null), null);
});

function transcript(lines: Rec[]) {
  const root = mkdtempSync(join(tmpdir(), "herdr-chat-cm-"));
  const file = join(root, "5e1f0c2a-0000-4000-8000-0000000000c2.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  return { root, file, append: (r: Rec) => appendFileSync(file, JSON.stringify(r) + "\n"), done: () => rmSync(root, { recursive: true, force: true }) };
}

test("Code Mode: every command that runs a while is a row, its last line what it does; it ends, lingers, goes", () => {
  const s = transcript([{ type: "repl-mode", replMode: true, sessionId: "s" }]);
  const out = join(s.root, "bcmd.output");
  writeFileSync(out, "compiling\nlinking\n");
  let live: ShellProc[] = [{ pid: 4242, id: "bcmd", output: out, command: "make all", startedAt: T0 }];
  const w = new BackgroundWatch(s.file, T0 - 60_000, 4000, () => live);
  try {
    assert.equal(w.read(T0 + 500), null, "a quick command never shows");
    const b = w.read(T0 + SHELL_SHOW_MS + 10)!;
    assert.equal(b.shells, 1);
    assert.deepEqual(b.tasks.map((x) => [x.kind, x.name, x.title, x.activity, x.state]), [["shell", "shell", "make all", "linking", "running"]]);
    const d = w.detail("bcmd")!;
    assert.deepEqual([d.kind, d.state, d.title, d.output, d.stoppable, d.outputFile], ["shell", "running", "make all", "compiling\nlinking\n", true, out]);
    assert.equal(w.detail("nothing"), null);
    // It ends with exit code 2: failed, then gone after a moment.
    live = [];
    s.append({ type: "queue-operation", operation: "enqueue", timestamp: iso(T0 + 3000), content: "<task-notification>\n<task-id>bcmd</task-id>\n<status>completed</status>\n<summary>Background command \"make all\" completed (exit code 2)</summary>\n</task-notification>" });
    const e = w.read(T0 + 3000)!;
    assert.equal(e.shells, 0);
    assert.deepEqual(e.tasks.map((x) => [x.kind, x.state]), [["shell", "failed"]]);
    assert.equal(w.detail("bcmd")!.stoppable, false);
    assert.equal(w.stop("bcmd"), false);
    assert.equal(w.read(T0 + 3000 + SHELL_LINGER_MS), null);
  } finally {
    s.done();
  }
});

test("not Code Mode: a foreground command is the timeline's, only a backgrounded one is a row", () => {
  const s = transcript([
    { type: "repl-mode", replMode: false, sessionId: "s" },
    { type: "user", uuid: "u1", timestamp: iso(T0), toolUseResult: { backgroundTaskId: "bbg" }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Command running in background" }] } },
  ]);
  const live: ShellProc[] = [
    { pid: 1, id: "bfg", output: join(s.root, "bfg.output"), command: "npm test", startedAt: T0 },
    { pid: 2, id: "bbg", output: join(s.root, "bbg.output"), command: "npm run dev", startedAt: T0 },
  ];
  const w = new BackgroundWatch(s.file, T0 - 60_000, 4000, () => live);
  try {
    const b = w.read(T0 + 10_000)!;
    assert.deepEqual(b.tasks.map((x) => x.title), ["npm run dev"]);
    assert.equal(b.shells, 1);
  } finally {
    s.done();
  }
});

// ---------------------------------------------------------------- the mod's words

test("the strip: a command's row; an opened row's lines", () => {
  const b = { at: T0, shells: 1, monitors: 0, tasks: [
    { id: "bcmd", kind: "shell", name: "shell", title: "make all", activity: "linking", worktree: null, state: "running", startedAt: T0 - 65_000, endedAt: null, done: null, failed: null, total: null, tokens: null },
  ] };
  const [row] = bgRows(b, T0);
  assert.equal(row.command, true);
  assert.equal(row.title, "make all");
  assert.equal(row.activity, "linking");
  assert.equal(row.meta, "1m05s");
  assert.equal(bgSummary(b), "1 shell");
  const lines = (d: Rec) => bgDetailLines(d, 3).map((l: Rec) => `${l.kind}:${l.text}`);
  assert.deepEqual(lines({ kind: "shell", output: "a\nb\nc\nd\n" }), ["output:b", "output:c", "output:d"]);
  assert.deepEqual(lines({ kind: "shell", output: "" }), []);
  assert.deepEqual(lines({ kind: "agent", steps: [{ kind: "tool", text: "$ make" }, { kind: "text", text: "\nAll green.\nMore." }] }), ["tool:$ make", "text:All green."]);
  assert.deepEqual(lines({ kind: "workflow", agents: [{ label: "tests", state: "done" }, { label: "", state: "running" }] }), ["done:tests", "running:agent"]);
  assert.equal(bgDetailEmpty(null), "Reading…");
  assert.equal(bgDetailEmpty({ kind: "shell", state: "running" }), "No output yet");
  assert.equal(bgDetailEmpty({ error: "It has ended" }), "It has ended");
});
