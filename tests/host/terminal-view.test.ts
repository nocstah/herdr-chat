// The terminal view (host/providers/claude/terminal.ts, mods/chat/faces.js):
// a chat that is the face of a Claude Code TUI in a terminal. Here against a
// fake `hc` (its event stream from a file the test appends to; sends logged),
// a stand-in process with Claude Code's registry entry, and a transcript that
// grows as the TUI would write it. No Herdr, no Claude Code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeTerminalAdapter } from "../../host/providers/claude/terminal.ts";
import { sessionPath } from "../../host/providers/claude/sessions.ts";
import { facesIn, unhide } from "../../host/panewatch.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.env.HERDR_CHAT_SESSION_MS ??= "200"; // the registry read for a /clear in the terminal, sooner than the 1 s default
type Rec = Record<string, any>;

test("the two copies of faces.js (chat, new-chat) are the same file", () => {
  const a = readFileSync(join(ROOT, "herdr-app", "mods", "chat", "faces.js"), "utf8");
  const b = readFileSync(join(ROOT, "herdr-app", "mods", "new-chat", "faces.js"), "utf8");
  assert.equal(a, b);
});

test("the pane watch finds both faces, and shows a hidden terminal again", () => {
  const doc: any = { spaces: [{ id: "s1", tabs: [{ id: "tb1", root: { type: "row", children: [
    { id: "pT", type: "block", hidden: true, content: { terminal: "t3" } },
    { id: "pC", type: "block", content: { mod: "chat", props: { chat: "tv-1", attach: "t3" } } },
    { id: "pX", type: "block", content: { terminal: "t4" } },
  ] } }] }] };
  assert.deepEqual(facesIn(doc, "tv-1", "t3"), { view: { pane: "pC", hidden: false, tab: "tb1", alone: false }, term: { pane: "pT", hidden: true, tab: "tb1" } });
  assert.equal(unhide(doc, "pT"), true);
  assert.equal(doc.spaces[0].tabs[0].root.children[0].hidden, undefined);
  assert.equal(unhide(doc, "nope"), false);
  doc.spaces[0].tabs[0].root.children = [doc.spaces[0].tabs[0].root.children[1]];
  assert.deepEqual(facesIn(doc, "tv-1", "t3"), { view: { pane: "pC", hidden: false, tab: "tb1", alone: true }, term: null });
});

// ---- the adapter against a fake hc ----------------------------------------------------

const FAKE_HC = (dir: string) => `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(dir)};
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "events") {
  // The snapshot and events the test appends, one JSON per line, as they come.
  let at = 0;
  const pump = () => {
    let s = "";
    try { s = fs.readFileSync(dir + "/events.jsonl", "utf8"); } catch {}
    if (s.length > at) { process.stdout.write(s.slice(at)); at = s.length; }
  };
  pump();
  setInterval(pump, 20);
} else if (cmd === "read") {
  // The screen the test wrote (Claude Code's dialogs are read from it).
  let text = "";
  try { text = fs.readFileSync(dir + "/screen.txt", "utf8"); } catch {}
  process.stdout.write(JSON.stringify({ complete: true, how: "screen", text }) + "\\n");
} else {
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify([cmd, ...rest]) + "\\n");
  process.stdout.write("{}\\n");
}
`;

function rig() {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-tv-"));
  const cfg = join(d, "claude");
  const cwd = join(d, "proj");
  mkdirSync(join(cfg, "sessions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "events.jsonl"), "");
  // The stand-in for Claude Code: its config folder in its environment, as the adapter reads it.
  const tui = spawn("sleep", ["60"], { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg }, stdio: "ignore" });
  const pid = tui.pid!;
  const register = (id: string) => writeFileSync(join(cfg, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId: id, cwd, status: "idle", kind: "interactive" }));
  const transcript = (id: string) => sessionPath(cwd, id, cfg);
  const write = (id: string, recs: Rec[]) => {
    mkdirSync(dirname(transcript(id)), { recursive: true });
    appendFileSync(transcript(id), recs.map((r) => JSON.stringify(r) + "\n").join(""));
  };
  const event = (m: Rec) => appendFileSync(join(d, "events.jsonl"), JSON.stringify(m) + "\n");
  const status = (state: string | null) => event({ method: "event", params: { type: "status", terminal: "t9", data: { status: state ? { app: "claude", state } : null } } });
  const calls = () => (existsSync(join(d, "calls.jsonl")) ? readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const events: NormalizedEvent[] = [];
  const logs: string[] = [];
  const host = { emit: (ev: NormalizedEvent) => events.push(ev), log: (m: string) => logs.push(m), running: false, working: false };
  const adapter = new ClaudeTerminalAdapter({ cwd, command: "claude", args: [], log: (m) => logs.push(m), terminal: "t9", hc, sentDir: join(d, "sent") });
  const done = () => {
    adapter.kill();
    tui.kill();
    rmSync(d, { recursive: true, force: true });
  };
  return { d, cwd, pid, register, transcript, write, event, status, calls, events, logs, host, adapter, done };
}

const until = async (what: string, f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
};

let n = 0;
const rec = (o: Rec, parent: string | null = null): Rec => ({ parentUuid: parent, uuid: `r${++n}`, timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(), ...o });
const prompt = (text: string, parent: string | null = null) => rec({ type: "user", message: { role: "user", content: text } }, parent);
const answer = (id: string, text: string, parent: string | null, stop: string | null = "end_turn") =>
  rec({ type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text }], stop_reason: stop, usage: { input_tokens: 1200, output_tokens: 30 } } }, parent);

test("the view: the TUI's session as history, a message typed into the terminal, the run with the terminal's status, and a /clear there followed", async () => {
  const r = rig();
  try {
    const S1 = "11111111-1111-4111-8111-111111111111";
    const S2 = "22222222-2222-4222-8222-222222222222";
    r.register(S1);
    const p1 = prompt("What does upload.ts do?");
    const a1 = answer("m1", "It uploads a file.", p1.uuid);
    r.write(S1, [p1, a1]);
    r.event({ terminals: [{ address: "t9", state: "live", foreground: { pid: r.pid, name: "claude", argv: ["claude"] }, status: { app: "claude", state: "idle" } }] });

    const info = await r.adapter.start(null, r.host);
    assert.deepEqual(info, { streaming: false, hasHistory: true });
    const sess = r.events.find((e) => e.type === "session") as any;
    assert.equal(sess.file, r.transcript(S1));
    assert.equal(sess.reload, undefined, "the first session isn't a reload");
    const hist = await r.adapter.history();
    assert.deepEqual(hist.filter((e) => e.type === "user_message").map((e: any) => e.text), ["What does upload.ts do?"]);
    assert.ok(r.events.some((e) => e.type === "model" && (e as any).model.id === "claude-opus-5-5"));

    // A send: typed into the terminal (hc send), its echo in the transcript confirms it.
    r.events.length = 0;
    const d = await r.adapter.prompt({ id: "u-1", text: "Add a retry", images: [], mode: "steer", busy: false });
    assert.equal(d.disposition, "started");
    assert.deepEqual(r.calls().at(-1), ["send", "--json", "t9", "Add a retry"]);
    r.status("working");
    await until("run_started", () => r.events.some((e) => e.type === "run_started"));
    const p2 = prompt("Add a retry", a1.uuid);
    const a2 = answer("m2", "Done: three retries.", p2.uuid, null);
    r.write(S1, [p2, a2]);
    await until("the echo", () => r.events.some((e) => e.type === "user_message"));
    const echo = r.events.find((e) => e.type === "user_message") as any;
    assert.equal(echo.clientId, "u-1");
    assert.equal(echo.source, undefined, "an echo (a source would make it a message of its own)");
    r.status("done");
    await until("run_settled", () => r.events.some((e) => e.type === "run_settled"));
    const types = r.events.map((e) => e.type);
    assert.ok(types.indexOf("assistant_end") < types.indexOf("run_settled"), "the open message closes before the run settles");

    // A message typed in the terminal itself: shown as the person's (external), a run of its own.
    r.events.length = 0;
    const p3 = prompt("And log each one", a2.uuid);
    r.write(S1, [p3, answer("m3", "Logged.", p3.uuid)]);
    await until("the external message's run", () => r.events.some((e) => e.type === "run_settled"));
    assert.equal((r.events.find((e) => e.type === "user_message") as any).source, "external");

    // A question on its screen: a send would answer it, so it's refused in words.
    r.status("blocked");
    await new Promise((res) => setTimeout(res, 150));
    await assert.rejects(r.adapter.prompt({ id: "u-9", text: "yes", images: [], mode: "steer", busy: true }), /asking something in its terminal/);
    r.status("idle");
    await new Promise((res) => setTimeout(res, 150));

    // A command is the TUI's: handled (no run of the chat's), still typed.
    assert.equal((await r.adapter.prompt({ id: "u-2", text: "/model", images: [], mode: "steer", busy: false })).disposition, "handled");
    assert.deepEqual(r.calls().at(-1), ["send", "--json", "t9", "/model"]);
    // Images: saved for Claude Code to read, @ mentions ahead of the words; the echo (mentions and all) confirms the message.
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    assert.equal((await r.adapter.prompt({ id: "u-5", text: "What is this?", images: [{ data: PNG, mimeType: "image/png" }], mode: "steer", busy: false })).disposition, "started");
    const typed = r.calls().at(-1)!.at(-1) as string;
    const m = /^@(\S+\/sent\/herdr-chat-[0-9a-f]{16}\.png) What is this\?$/.exec(typed);
    assert.ok(m, typed);
    assert.equal(readFileSync(m![1]!).toString("base64"), PNG);
    r.events.length = 0;
    const p5 = prompt(typed, a2.uuid);
    r.write(S1, [p5]);
    await until("the image message's echo", () => r.events.some((e) => e.type === "user_message"));
    const echo5 = r.events.find((e) => e.type === "user_message") as any;
    assert.equal(echo5.clientId, "u-5");
    assert.equal(echo5.text, "What is this?");
    assert.equal(echo5.images, 1);
    r.status("done");
    await until("its run settles", () => r.events.some((e) => e.type === "run_settled"));
    r.status("idle");
    await new Promise((res) => setTimeout(res, 150));
    // An image alone: the mentions and a space (the cursor out of the last mention).
    await r.adapter.prompt({ id: "u-6", text: "", images: [{ data: PNG, mimeType: "image/png" }], mode: "steer", busy: false });
    assert.match(r.calls().at(-1)!.at(-1) as string, /^@\S+\.png $/);
    await assert.rejects(r.adapter.prompt({ id: "u-7", text: "/model", images: [{ data: PNG, mimeType: "image/png" }], mode: "steer", busy: false }), /Images go with a message/);

    // A `!` command: Claude Code's bash mode runs it (its records come back as a Bash card); refused mid-run.
    assert.equal((await r.adapter.prompt({ id: "u-3", text: "! pnpm build", images: [], mode: "steer", busy: false })).disposition, "handled");
    assert.deepEqual(r.calls().at(-1), ["send", "--json", "t9", "!pnpm build"]);
    r.status("working");
    await new Promise((res) => setTimeout(res, 150));
    await assert.rejects(r.adapter.prompt({ id: "u-4", text: "!ls", images: [], mode: "steer", busy: true }), /working: run the command when it's done/);
    r.status("idle");
    await new Promise((res) => setTimeout(res, 150));

    // An agent's turn state on the stream isn't the terminal's end.
    r.event({ method: "event", params: { type: "turn", terminal: "t9", data: { state: "done", turn: 3 } } });
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(r.adapter.alive, true, "a turn event leaves the terminal live");

    // Stop: the agent's stop key.
    r.adapter.abort();
    await until("interrupt", () => r.calls().some((c) => c[0] === "interrupt"));

    // /clear in the terminal: a new session in the registry, followed (its history replaces the timeline).
    r.events.length = 0;
    r.register(S2);
    await until("the new session", () => r.events.some((e) => e.type === "session"), 4000);
    const s2 = r.events.find((e) => e.type === "session") as any;
    assert.equal(s2.file, r.transcript(S2));
    assert.equal(s2.reload, true);
    const p4 = prompt("Fresh start");
    r.write(S2, [p4]);
    await new Promise((res) => setTimeout(res, 400));
    assert.ok(!r.events.some((e) => e.type === "user_message"), "the tail waits for the core's history read");
    assert.deepEqual((await r.adapter.history()).filter((e) => e.type === "user_message").map((e: any) => e.text), ["Fresh start"]);

    // Claude Code quits back to the shell: said once, sends refused.
    r.events.length = 0;
    rmSync(join(r.d, "claude", "sessions", `${r.pid}.json`));
    r.event({ method: "event", params: { type: "foreground", terminal: "t9", data: { pid: process.pid, name: "fish", argv: ["fish"], cwd: r.cwd } } });
    await until("the quit notice", () => r.events.some((e) => e.type === "notice"), 4000);
    await assert.rejects(r.adapter.prompt({ id: "u-3", text: "hi", images: [], mode: "steer", busy: false }), /isn't running in its terminal/);
    assert.equal(r.adapter.alive, true, "the terminal lives on: the view waits for Claude Code to start there again");
  } finally {
    r.done();
  }
});

test("the view: the terminal's program exits: said once, the view's agent is gone", async () => {
  const r = rig();
  try {
    r.register("33333333-3333-4333-8333-333333333333");
    r.event({ terminals: [{ address: "t9", state: "live", foreground: { pid: r.pid, name: "claude", argv: ["claude"] }, status: null }] });
    await r.adapter.start(null, r.host);
    r.event({ method: "event", params: { type: "finished", terminal: "t9", data: { exit_code: 0, reason: "exited", signal: null } } });
    await until("the end", () => !r.adapter.alive);
    assert.equal(r.events.filter((e) => e.type === "notice").length, 1);
  } finally {
    r.done();
  }
});

test("the view: a terminal that has ended can't be a chat", async () => {
  const r = rig();
  try {
    r.event({ terminals: [{ address: "t9", state: "finished", foreground: null, status: null }] });
    await assert.rejects(r.adapter.start(null, r.host), /has ended/);
  } finally {
    r.done();
  }
});

test("the view: a message typed while the agent works waits in the steering lane, then shows where it went in; its background work on the strip", async () => {
  const r = rig();
  try {
    const S1 = "33333333-3333-4333-8333-333333333333";
    r.register(S1);
    const p1 = prompt("Run the made-up suite");
    r.write(S1, [p1]);
    r.event({ terminals: [{ address: "t9", state: "live", foreground: { pid: r.pid, name: "claude", argv: ["claude"] }, status: { app: "claude", state: "working" } }] });
    await r.adapter.start(null, r.host);
    await r.adapter.history();
    const call = rec({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "make test" } }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } } }, p1.uuid);
    const op = (operation: string, content: string) => ({ type: "queue-operation", operation, timestamp: new Date().toISOString(), sessionId: S1, content });
    // Typed into the TUI itself, then sent from the chat while it works (the TUI queues both).
    r.write(S1, [call, op("enqueue", "Also check the lint")]);
    const lane = () => r.events.filter((e) => e.type === "queue_changed").at(-1) as any;
    await until("the typed message in the lane", () => lane()?.steering.length === 1);
    assert.deepEqual(lane().steering, ["Also check the lint"]);
    assert.equal((await r.adapter.prompt({ id: "u-q", text: "And the docs", images: [], mode: "steer", busy: true })).disposition, "queued");
    r.write(S1, [op("enqueue", '<event kind="repl-eval">made up</event>'), op("enqueue", "And the docs")]);
    await until("the sent message in the lane", () => lane()?.steering.length === 2);
    assert.deepEqual([lane().steering, lane().steeringIds], [["Also check the lint", "And the docs"], [null, "u-q"]]);
    // Handed to the agent mid-turn: attachment records, never user records.
    const res = rec({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } }, call.uuid);
    const qa = rec({ type: "attachment", attachment: { type: "queued_command", prompt: "Also check the lint", commandMode: "prompt", origin: { kind: "human" } } }, res.uuid);
    const qb = rec({ type: "attachment", attachment: { type: "queued_command", prompt: "And the docs", commandMode: "prompt", origin: { kind: "human" } } }, qa.uuid);
    r.write(S1, [res, op("remove", "Also check the lint"), op("remove", "And the docs"), qa, qb]);
    await until("both messages", () => r.events.filter((e) => e.type === "user_message").length === 2);
    const msgs = r.events.filter((e) => e.type === "user_message") as any[];
    assert.deepEqual(msgs.map((m) => [m.text, m.source, m.clientId]), [["Also check the lint", "external", undefined], ["And the docs", undefined, "u-q"]]);
    assert.deepEqual(lane().steering, []);

    // A background agent the session started: on the strip, live.
    const sub = join(r.transcript(S1).replace(/\.jsonl$/, ""), "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-ab12.meta.json"), JSON.stringify({ agentType: "Explore", description: "Map the made-up repo", requestShape: "background" }));
    writeFileSync(join(sub, "agent-ab12.jsonl"), JSON.stringify({ type: "user", isSidechain: true, timestamp: new Date().toISOString(), message: { role: "user", content: "a made-up task" } }) + "\n");
    const bg = () => r.events.filter((e) => e.type === "background").at(-1) as any;
    await until("the background agent", () => bg()?.background?.tasks?.length === 1, 4000);
    assert.deepEqual(((t) => [t.kind, t.name, t.title, t.state])(bg().background.tasks[0]), ["agent", "Explore", "Map the made-up repo", "running"]);
    writeFileSync(join(sub, "agent-ab12.meta.json"), JSON.stringify({ agentType: "Explore", description: "Map the made-up repo", requestShape: "background", finished: true }));
    await until("its end", () => bg()?.background?.tasks?.[0]?.state === "done", 4000);

    // The run settles: nothing waits in the lane.
    r.write(S1, [op("enqueue", "one more")]);
    await until("one more in the lane", () => lane()?.steering.length === 1);
    r.status("idle");
    await until("the lane empties as the run settles", () => r.events.some((e) => e.type === "run_settled") && lane()?.steering.length === 0);
  } finally {
    r.done();
  }
});

test("Claude Code's dialogs: a card while it waits, the card's answer pressed as keys, the card gone when it moves on", async () => {
  const { SCREENS } = await import("./screen.test.ts");
  const r = rig();
  const screen = (s: string) => writeFileSync(join(r.d, "screen.txt"), s);
  const asks = () => r.events.filter((e) => e.type === "ask").map((e: any) => e.ask);
  const keys = () => r.calls().filter((c) => c[0] === "keys" || (c[0] === "send" && c.includes("--force")));
  process.env.HERDR_CHAT_ASK_MS = "40";
  try {
    const S1 = "11111111-1111-4111-8111-111111111111";
    r.register(S1);
    r.write(S1, [prompt("Clean up")]);
    r.event({ terminals: [{ address: "t9", state: "live", foreground: { pid: r.pid, name: "claude", argv: ["claude"] }, status: { app: "claude", state: "working" } }] });
    await r.adapter.start(null, r.host);
    await r.adapter.history();

    // A command's permission: a card with the rows as choices.
    screen(SCREENS.bash);
    r.status("blocked");
    await until("the permission card", () => asks().length === 1);
    const perm = asks()[0];
    assert.equal(perm.kind, "permission");
    assert.equal(perm.title, "Bash command");
    assert.match(perm.message, /```\nrm -rf build\/\n```/);
    assert.deepEqual(perm.choices.map((c: any) => [c.label, c.kind]), [
      ["Yes", "allow"], ["Yes, and always allow access to /tmp/demo from this project", "allow_always"],
      ["Yes, and switch to auto mode", "other"], ["No", "deny"],
    ]);
    await assert.rejects(r.adapter.prompt({ id: "u-2", text: "hi", images: [], mode: "steer", busy: false }), /answer its card/);
    // "No" with a reason: Tab, then (once the screen shows the row takes text) the reason typed into it.
    r.adapter.answer(perm.id, { choice: perm.choices[3].id, message: "Keep build/" });
    await until("Tab on No", () => keys().length === 1);
    assert.deepEqual(keys(), [["keys", "--json", "t9", "down", "down", "down", "tab"]]);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(keys().length, 1, "nothing typed before the screen shows the row");
    screen(SCREENS.bash.replace(" ❯ 1. Yes", "   1. Yes").replace("   4. No", " ❯ 4. No, and tell Claude what to do differently"));
    await until("the reason typed", () => keys().length === 2);
    assert.deepEqual(keys()[1], ["send", "--json", "--force", "t9", "Keep build/"]);

    // The next dialog (the same screen stays a while: no second card for it until the answer settles).
    screen(SCREENS.one);
    await until("the question card", () => asks().length === 2);
    const q = asks()[1];
    assert.equal(q.kind, "questions");
    assert.deepEqual(q.questions, [{ id: "q", header: "Fruit", question: "Which fruit?", options: [{ label: "Apple", description: "Crisp and sweet" }, { label: "Pear" }], multiSelect: false, allowOther: true }]);
    r.adapter.answer(q.id, { answers: { q: "Pear" } });
    await until("Pear picked", () => keys().length === 3);
    assert.deepEqual(keys().at(-1), ["keys", "--json", "t9", "down", "enter"]);

    // A multiple choice with a typed answer, then its review, sent as the last answer goes. The screen
    // follows the keys as Claude Code's would; each step waits for it.
    screen(SCREENS.tabs);
    await until("the multiple choice card", () => asks().length === 3);
    const m = asks()[2];
    assert.equal(m.title, "Claude Code has 2 questions (2 of 2)");
    r.adapter.answer(m.id, { answers: { q: ["Home", "Contact", "Blog"] } });
    const rows = (lines: string[]) => SCREENS.tabs.replace(/  1\. \[✔\] Home\n❯ 2\. \[ \] About\n  3\. \[ \] Contact\n  4\. \[ \] Type something\n     Submit/, lines.join("\n"));
    await until("Contact ticked", () => keys().length === 4);
    assert.deepEqual(keys()[3], ["keys", "--json", "t9", "down", "enter"]); // Home already is, About stays off
    screen(rows(["  1. [✔] Home", "  2. [ ] About", "❯ 3. [✔] Contact", "  4. [ ] Type something", "     Submit"]));
    await until("to Type something", () => keys().length === 5);
    assert.deepEqual(keys()[4], ["keys", "--json", "t9", "down"]);
    screen(rows(["  1. [✔] Home", "  2. [ ] About", "  3. [✔] Contact", "❯ 4. [ ] Type something", "     Submit"]));
    await until("Blog typed", () => keys().length === 6);
    assert.deepEqual(keys()[5], ["send", "--json", "--force", "t9", "Blog"]);
    screen(rows(["  1. [✔] Home", "  2. [ ] About", "  3. [✔] Contact", "❯ 4. [ ] Blog", "     Submit"]));
    await until("its box ticked", () => keys().length === 7);
    assert.deepEqual(keys()[6], ["keys", "--json", "t9", "enter"]);
    screen(rows(["  1. [✔] Home", "  2. [ ] About", "  3. [✔] Contact", "❯ 4. [✔] Blog", "     Submit"]));
    await until("Submit", () => keys().length === 8);
    assert.deepEqual(keys()[7], ["keys", "--json", "t9", "down", "enter"]);
    screen(SCREENS.review);
    await until("the review sent", () => keys().some((k) => k.join(" ") === "keys --json t9 enter"));
    assert.equal(asks().length, 3, "no card for the review");

    // It moves on: the card goes.
    screen(SCREENS.plan);
    await until("the plan card", () => asks().length === 4);
    r.status("working");
    await until("its card closed", () => r.events.some((e) => e.type === "ask_closed" && (e as any).id === asks()[3].id));
  } finally {
    delete process.env.HERDR_CHAT_ASK_MS;
    r.done();
  }
});
