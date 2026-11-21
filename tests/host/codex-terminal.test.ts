// The terminal view of a Codex TUI (host/providers/codex/terminal.ts): against a fake
// `hc` (its event stream from a file the test appends to, its screen from another, its
// other calls logged) and a stand-in for /proc that says which rollout the TUI shows.
// The rollout grows as Codex 0.171 writes one. No Herdr, no Codex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexTerminalAdapter } from "../../host/providers/codex/terminal.ts";
import type { BindIO } from "../../host/providers/codex/bind.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";

process.env.HERDR_CHAT_SESSION_MS ??= "200";
type Rec = Record<string, any>;

const FAKE_HC = (dir: string) => `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "events") {
  let at = 0;
  const pump = () => {
    let s = "";
    try { s = fs.readFileSync(dir + "/events.jsonl", "utf8"); } catch {}
    if (s.length > at) { process.stdout.write(s.slice(at)); at = s.length; }
  };
  pump();
  setInterval(pump, 20);
} else if (cmd === "read") {
  let text = "";
  try { text = fs.readFileSync(dir + "/screen.txt", "utf8"); } catch {}
  process.stdout.write(JSON.stringify({ complete: true, how: "screen", text }) + "\\n");
} else {
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify([cmd, ...rest]) + "\\n");
  process.stdout.write("{}\\n");
}
`;

const A = "019a0000-0000-7000-8000-0000000000a1";
const B = "019a0000-0000-7000-8000-0000000000b2";

function rig() {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-cv-"));
  const cwd = join(d, "proj");
  const home = join(d, "codex");
  mkdirSync(cwd, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "events.jsonl"), "");
  const file = (id: string) => join(home, "sessions", "2026", "11", "21", `rollout-2026-11-21T10-00-00-${id}.jsonl`);
  mkdirSync(join(home, "sessions", "2026", "11", "21"), { recursive: true });
  let shown: string | null = file(A);
  let running = true;
  // The TUI's process (pid 4242), holding the rollout it shows open (as `codex --no-daemon` does).
  const io: BindIO = {
    tree: (pid) => [pid],
    argv: (pid) => (pid === 4242 && running ? ["codex"] : ["fish"]),
    cwd: () => cwd,
    start: () => Date.now() - 60_000,
    env: (_p, n) => (n === "CODEX_HOME" ? home : null),
    openRollouts: () => (shown && running ? [shown] : []),
    loaded: () => [],
    rolloutOf: () => null,
    meta: (p) => ({ id: p.includes(A) ? A : B, cwd, interactive: true }),
    tuis: () => [],
    prompts: () => [],
  };
  let n = 0;
  const write = (id: string, recs: [string, Rec][]) => appendFileSync(file(id), recs.map(([type, payload]) => JSON.stringify({ timestamp: new Date(1_800_000_000_000 + ++n * 1000).toISOString(), type, payload }) + "\n").join(""));
  const item = (it: Rec): [string, Rec] => ["event_msg", { type: "item_completed", thread_id: A, turn_id: "t", item: it }];
  const user = (id: string, text: string) => item({ type: "UserMessage", id, content: [{ type: "text", text, text_elements: [] }] });
  const said = (id: string, text: string) => item({ type: "AgentMessage", id, content: [{ type: "Text", text }], phase: "final_answer" });
  const event = (m: Rec) => appendFileSync(join(d, "events.jsonl"), JSON.stringify(m) + "\n");
  const status = (state: string | null) => event({ method: "event", params: { type: "status", terminal: "t5", data: { status: state ? { app: "codex", state } : null } } });
  const screen = (text: string) => writeFileSync(join(d, "screen.txt"), text);
  const calls = () => (existsSync(join(d, "calls.jsonl")) ? readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const events: NormalizedEvent[] = [];
  const logs: string[] = [];
  const host = { emit: (ev: NormalizedEvent) => events.push(ev), log: (m: string) => logs.push(m), running: false, working: false };
  const adapter = new CodexTerminalAdapter({ cwd, command: "codex", args: [], log: (m) => logs.push(m), terminal: "t5", hc, io });
  const done = () => {
    adapter.kill();
    rmSync(d, { recursive: true, force: true });
  };
  return {
    d, file, write, item, user, said, event, status, screen, calls, events, logs, host, adapter, done,
    show: (id: string | null) => (shown = id ? file(id) : null), quit: () => (running = false),
  };
}

const until = async (what: string, f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
};
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

const APPROVAL = `› list the files

  Would you like to run the following command?

  Reason: to see what's here

  $ ls -la


› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`ls -la\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

const QUESTION = `
  Question 1/1 (1 unanswered)
  Which database?

  › 1. Postgres           The one we run
    2. SQLite             Simpler
    3. None of the above  Optionally, add details in notes (tab)

  tab to add notes | enter to submit answer | esc to interrupt`;

test("the view: the TUI's conversation as history, a send typed in, the run with the terminal's status, its cards answered by key, a /new followed", async () => {
  const r = rig();
  try {
    r.write(A, [
      ["session_meta", { id: A, cwd: "/proj", source: "cli", originator: "codex-tui", cli_version: "0.171.0" }],
      ["turn_context", { model: "gpt-5.5", effort: "medium", cwd: "/proj" }],
      ["event_msg", { type: "task_started", turn_id: "t1" }],
      r.user("u1", "What does upload.ts do?"),
      r.said("m1", "It uploads a file."),
      ["event_msg", { type: "task_complete", turn_id: "t1" }],
    ]);
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4242, name: "codex", argv: ["codex"] }, status: { app: "codex", state: "idle" } }] });
    const info = await r.adapter.start(null, r.host);
    assert.deepEqual(info, { streaming: false, hasHistory: true });
    const sess = r.events.find((e) => e.type === "session") as any;
    assert.equal(sess.file, r.file(A));
    assert.equal(sess.id, A);
    const hist = await r.adapter.history();
    assert.deepEqual(hist.filter((e) => e.type === "user_message").map((e: any) => [e.text, e.source]), [["What does upload.ts do?", "composer"]]);
    assert.ok(hist.some((e) => e.type === "assistant_end" && (e as any).content.some((b: any) => b?.text === "It uploads a file.")));
    assert.ok(hist.some((e) => e.type === "model" && (e as any).model.id === "gpt-5.5"));

    // A send: typed in; its echo in the rollout confirms it; a command card; the run ends with the status.
    r.events.length = 0;
    assert.equal((await r.adapter.prompt({ id: "u-1", text: "List the files", images: [], mode: "steer", busy: false })).disposition, "started");
    assert.deepEqual(r.calls().at(-1), ["send", "--json", "t5", "List the files"]);
    r.status("working");
    await until("run_started", () => r.events.some((e) => e.type === "run_started"));
    r.write(A, [
      ["event_msg", { type: "task_started", turn_id: "t2" }],
      r.user("u2", "List the files"),
      r.item({ type: "CommandExecution", id: "c1", command: ["/bin/bash", "-lc", "ls"], cwd: "/proj", status: "completed", parsed_cmd: [{ type: "list_files", cmd: "ls", path: null }], aggregated_output: "a.ts\nb.ts\n", exit_code: 0, duration: { secs: 0, nanos: 9_000_000 } }),
      r.said("m2", "Two files."),
    ]);
    await until("the echo and the card", () => r.events.some((e) => e.type === "tool_ended"));
    const echo = r.events.find((e) => e.type === "user_message") as any;
    assert.equal(echo.clientId, "u-1");
    assert.equal(echo.source, undefined);
    const tool = r.events.find((e) => e.type === "tool_ended") as any;
    assert.equal(tool.name, "commandExecution");
    assert.equal(tool.output, "a.ts\nb.ts\n");
    r.write(A, [["event_msg", { type: "task_complete", turn_id: "t2" }]]);
    r.status("done");
    await until("run_settled", () => r.events.some((e) => e.type === "run_settled"));
    const types = r.events.map((e) => e.type);
    assert.ok(types.lastIndexOf("assistant_end") < types.indexOf("run_settled"), "the answer closes before the run settles");

    // A message typed in the terminal itself: the person's, from outside the chat.
    r.events.length = 0;
    r.write(A, [r.user("u3", "And their sizes?")]);
    await until("the external message", () => r.events.some((e) => e.type === "user_message"));
    assert.equal((r.events.find((e) => e.type === "user_message") as any).source, "external");
    r.write(A, [["event_msg", { type: "task_complete", turn_id: "t3" }]]);
    await pause();

    // An approval: a card; a send meanwhile is refused; Yes is its key.
    r.events.length = 0;
    r.screen(APPROVAL);
    r.status("blocked");
    await until("the approval card", () => r.events.some((e) => e.type === "ask"));
    const ask = (r.events.find((e) => e.type === "ask") as any).ask;
    assert.equal(ask.kind, "permission");
    assert.equal(ask.title, "Codex wants to run the following command");
    assert.match(ask.message, /Reason: to see what's here/);
    assert.match(ask.message, /```sh\nls -la\n```/);
    assert.deepEqual(ask.choices.map((c: any) => [c.label, c.kind]), [
      ["Yes, proceed", "allow"],
      ["Yes, and don't ask again for commands that start with `ls -la`", "allow_always"],
      ["No, and tell Codex what to do differently", "deny"],
    ]);
    await assert.rejects(r.adapter.prompt({ id: "u-9", text: "hi", images: [], mode: "steer", busy: true }), /answer its card/);
    r.adapter.answer(ask.id, { choice: ask.choices[0].id });
    await until("Yes pressed", () => r.calls().some((c) => c[0] === "keys" && c.at(-1) === "y"));
    // A No with a reason: its key, then the reason as a message once Codex is back at its prompt.
    await pause(800);
    r.events.length = 0;
    r.screen(APPROVAL.replace("ls -la", "rm -rf build").replace("`ls -la`", "`rm -rf build`"));
    await until("the next card", () => r.events.some((e) => e.type === "ask"));
    const ask2 = (r.events.find((e) => e.type === "ask") as any).ask;
    r.adapter.answer(ask2.id, { choice: ask2.choices[2].id, message: "keep the build folder" });
    await until("esc pressed", () => r.calls().some((c) => c[0] === "keys" && c.at(-1) === "esc"));
    r.screen("› rm -rf build\n\n■ Denied.\n\n› ");
    r.status("idle");
    await until("the reason sent", () => r.calls().some((c) => c[0] === "send" && c.at(-1) === "keep the build folder"));

    // A question: its options; an answer is the moves to it and Enter.
    await pause();
    r.events.length = 0;
    r.screen(QUESTION);
    r.status("blocked");
    await until("the question card", () => r.events.some((e) => e.type === "ask"));
    const q = (r.events.find((e) => e.type === "ask") as any).ask;
    assert.equal(q.kind, "questions");
    assert.equal(q.questions[0].question, "Which database?");
    assert.deepEqual(q.questions[0].options.map((o: any) => o.label), ["Postgres", "SQLite"]);
    assert.equal(q.questions[0].allowOther, true);
    r.adapter.answer(q.id, { answers: { q: "SQLite" } });
    await until("down, enter", () => r.calls().some((c) => c[0] === "keys" && c.slice(-2).join(" ") === "down enter"));
    r.status("idle");
    await pause();

    // Images: refused in words (Codex takes one only as a pasted path).
    await assert.rejects(r.adapter.prompt({ id: "u-7", text: "this", images: [{ data: "AA==", mimeType: "image/png" }], mode: "steer", busy: false }), /Images can't be typed into Codex's terminal/);
    // A command is the TUI's: handled, still typed.
    assert.equal((await r.adapter.prompt({ id: "u-8", text: "/model", images: [], mode: "steer", busy: false })).disposition, "handled");

    // /new there: another rollout; the chat reloads onto it.
    r.events.length = 0;
    r.write(B, [["session_meta", { id: B, cwd: "/proj", source: "cli" }]]);
    r.show(B);
    await until("the new conversation", () => r.events.some((e) => e.type === "session" && (e as any).reload));
    assert.equal((r.events.find((e) => e.type === "session") as any).file, r.file(B));

    // Codex quits back to the shell: said once; sends refused.
    r.quit();
    r.event({ method: "event", params: { type: "foreground", terminal: "t5", data: { pid: 4343, name: "fish", argv: ["fish"] } } });
    await until("the quit notice", () => r.events.some((e) => e.type === "notice" && /Codex quit in its terminal/.test((e as any).text)));
    await assert.rejects(r.adapter.prompt({ id: "u-10", text: "hi", images: [], mode: "steer", busy: false }), /Codex isn't running in its terminal/);
  } finally {
    r.done();
  }
});

test("a fork's conversation shows its source's turns before its own", async () => {
  const r = rig();
  try {
    r.write(B, [["session_meta", { id: B, cwd: "/proj", source: "cli" }]]);
    writeFileSync(r.file(B), "");
    appendFileSync(r.file(B), [
      { ordinal: 0, type: "session_meta", payload: { id: B, cwd: "/proj", source: "cli" } },
      { ordinal: 1, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "s1", content: [{ type: "text", text: "first, in the source" }] } } },
      { ordinal: 2, type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "s2", content: [{ type: "text", text: "after the fork point" }] } } },
    ].map((x) => JSON.stringify(x) + "\n").join(""));
    writeFileSync(r.file(A), [
      { type: "session_meta", payload: { id: A, cwd: "/proj", source: "cli", history_base: { thread_id: B, end_ordinal_exclusive: 2 } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "f1", content: [{ type: "text", text: "in the fork" }] } } },
    ].map((x) => JSON.stringify(x) + "\n").join(""));
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4242, name: "codex", argv: ["codex"] }, status: { app: "codex", state: "idle" } }] });
    await r.adapter.start(null, r.host);
    const hist = await r.adapter.history();
    assert.deepEqual(hist.filter((e) => e.type === "user_message").map((e: any) => e.text), ["first, in the source", "in the fork"]);
  } finally {
    r.done();
  }
});
