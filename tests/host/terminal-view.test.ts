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
  const adapter = new ClaudeTerminalAdapter({ cwd, command: "claude", args: [], log: (m) => logs.push(m), terminal: "t9", hc });
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
