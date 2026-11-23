// The terminal view of an Antigravity CLI (`agy`) TUI (host/providers/antigravity/terminal.ts):
// against a fake `hc` and a stand-in /proc reader. No Herdr, no live `agy`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AntigravityTerminalAdapter } from "../../host/providers/antigravity/terminal.ts";
import { transcriptPath } from "../../host/providers/antigravity/bind.ts";
import type { AgyBindIO } from "../../host/providers/antigravity/bind.ts";
import { parseModelsOutput } from "../../host/providers/antigravity/models.ts";
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
  if (cmd === "keys" && rest.includes("shift+tab") && fs.existsSync(dir + "/modes.json")) {
    const m = JSON.parse(fs.readFileSync(dir + "/modes.json", "utf8"));
    m.i = (m.i + 1) % m.list.length;
    fs.writeFileSync(dir + "/modes.json", JSON.stringify(m));
    const mode = m.list[m.i];
    const prefix = mode === "default" ? "" : mode + " · ";
    fs.writeFileSync(dir + "/screen.txt", "────────────────────────────────────\\n> \\n────────────────────────────────────\\n? for shortcuts      " + prefix + "Gemini 4 Neon · xhigh\\n");
  }
  process.stdout.write("{}\\n");
}
`;

const A = "b4eb6fd9-0bac-43cb-843d-45b695b83656";
const B = "5ced34d3-3860-4269-90cc-73f7049209da";

const CATALOG = parseModelsOutput(`
gemini-4-neon-high     Gemini 4 Neon (High)
gemini-4-neon-xhigh    Gemini 4 Neon (XHigh)
gemini-4-neon-medium   Gemini 4 Neon (Medium)
gemini-4-neon-low      Gemini 4 Neon (Low)
gemini-3.8-flash-high  Gemini 3.8 Flash (High)
gemini-3.8-flash-low   Gemini 3.8 Flash (Low)
`);

const IDLE_SCREEN = `────────────────────────────────────
> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)
────────────────────────────────────
? for shortcuts        auto · Gemini 4 Neon · xhigh`;

const EDIT_APPROVAL = `Edit src/app.ts
  - a
  + b

Accept this file edit?
> 1. Yes, accept this change
  2. No, reject this change
  Press 1-2, enter to confirm, tab to reject with feedback`;

const QUESTION = `Question 1/1
Which store?
> 1. Postgres   Primary
  2. SQLite     Simple
  3. Other (write your answer)
  ↑/↓ Navigate · enter to select · esc to cancel`;

function rig(o: { sent?: boolean } = {}) {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-agy-"));
  const cwd = join(d, "proj");
  const dataDir = join(d, "agy-data");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "events.jsonl"), "");
  writeFileSync(join(d, "screen.txt"), IDLE_SCREEN);

  let shown: string | null = A;
  let running = true;
  const io: AgyBindIO = {
    tree: (pid) => (pid === 4000 ? [4000, 4001] : [pid]),
    argv: (pid) => (pid === 4000 ? ["fish", "-ic", "agy"] : pid === 4001 && running ? ["agy"] : ["fish"]),
    cwd: () => cwd,
    env: (_p, n) => (n === "ANTIGRAVITY_CLI_DATA_DIR" ? dataDir : null),
    openFiles: (pids) => (shown && running && pids.includes(4001) ? [join(dataDir, "presence", `${shown}.lock`)] : []),
    exists: existsSync,
    mtime: () => Date.now(),
  };

  const file = (id: string) => transcriptPath(dataDir, id);
  const write = (id: string, recs: Rec[]) => {
    const p = file(id);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, recs.map((r) => JSON.stringify(r) + "\n").join(""));
  };
  const event = (m: Rec) => appendFileSync(join(d, "events.jsonl"), JSON.stringify(m) + "\n");
  const status = (state: string | null) => event({ method: "event", params: { type: "status", terminal: "t5", data: { status: state ? { app: "antigravity", state } : null } } });
  const screen = (text: string) => writeFileSync(join(d, "screen.txt"), text);
  const calls = () => (existsSync(join(d, "calls.jsonl")) ? readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const events: NormalizedEvent[] = [];
  const logs: string[] = [];
  const host = { emit: (ev: NormalizedEvent) => events.push(ev), log: (m: string) => logs.push(m), running: false, working: false };
  const adapter = new AntigravityTerminalAdapter({
    cwd, command: "agy", args: [], log: (m) => logs.push(m), terminal: "t5", hc, io,
    ...(o.sent ? { sentDir: join(d, "sent") } : {}),
    fetchModels: async () => CATALOG,
  });
  const done = () => {
    adapter.kill();
    rmSync(d, { recursive: true, force: true });
  };
  return { d, file, write, event, status, screen, calls, events, logs, host, adapter, done, show: (id: string | null) => (shown = id), quit: () => (running = false) };
}

const until = async (what: string, f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); await new Promise((r) => setTimeout(r, 20))) if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
};
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("the Antigravity view: history, live send/echo, tools, dialogs, images, pickers, mode switch, /clear and quit", async () => {
  const r = rig({ sent: true });
  try {
    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", created_at: "2026-11-22T23:15:32Z", content: "<USER_REQUEST>\nExplain app.ts\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-22T23:15:35Z", model: "gemini-4-neon-xhigh", input_tokens: 4000, cache_read_tokens: 500, output_tokens: 80, content: "It starts the server." },
    ]);
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "idle" } }] });
    const info = await r.adapter.start(null, r.host);
    assert.deepEqual(info, { streaming: false, hasHistory: true });
    assert.equal((r.events.find((e) => e.type === "session") as any).file, r.file(A));
    assert.ok(r.events.some((e) => e.type === "permission_mode" && (e as any).mode === "auto"));

    const hist = await r.adapter.history();
    assert.deepEqual(hist.filter((e) => e.type === "user_message").map((e: any) => [e.text, e.source]), [["Explain app.ts", "composer"]]);
    assert.ok(hist.some((e) => e.type === "assistant_end" && (e as any).content.some((b: any) => b?.text === "It starts the server.")));
    assert.ok(r.events.some((e) => e.type === "model" && (e as any).model.id === "gemini-4-neon"));
    assert.ok(r.events.some((e) => e.type === "thinking" && (e as any).level === "xhigh"));
    assert.ok(r.events.some((e) => e.type === "capabilities" && (e as any).capabilities.thinkingLevels?.includes("xhigh")));
    assert.equal((await r.adapter.usage()).contextTokens, 4500);

    // Send a prompt with an image: saved to sentDir, typed with marker, echoed as image block.
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    r.events.length = 0;
    const sentRes = await r.adapter.prompt({ id: "u-1", text: "What is this?", images: [{ data: PNG, mimeType: "image/png" }], mode: "steer", busy: false });
    assert.equal(sentRes.disposition, "started");
    const typed = r.calls().at(-1)!.at(-1) as string;
    assert.match(typed, /What is this\?\n\n\[Image available at: \/.*herdr-chat-[0-9a-f]{16}\.png\]/);
    r.status("working");
    await until("run_started", () => r.events.some((e) => e.type === "run_started"));
    r.write(A, [
      { step_index: 2, type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n${typed}\n</USER_REQUEST>` },
      { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }] },
      { step_index: 4, type: "GENERIC", status: "DONE", content: "Created At: 2026-11-23T06:16:00+07:00\nCommand exited with code 0.\n\nCommand output:\napp.ts\n" },
      { step_index: 5, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: "A 1x1 pixel." },
    ]);
    await until("tool_ended and answer", () => r.events.some((e) => e.type === "assistant_end" && (e as any).stopReason === "stop"));
    const echo = r.events.find((e) => e.type === "user_message") as any;
    assert.equal(echo.clientId, "u-1");
    assert.equal(echo.text, "What is this?");
    assert.equal(echo.images, 1);
    r.status("done");
    await until("run_settled", () => r.events.some((e) => e.type === "run_settled"));
    await pause();
    assert.equal(r.events.filter((e) => e.type === "run_settled").length, 1);

    // Blocking edit approval dialog -> permission card -> answered with enter.
    r.events.length = 0;
    r.screen(EDIT_APPROVAL);
    r.status("blocked");
    await until("permission ask", () => r.events.some((e) => e.type === "ask"));
    const ask = (r.events.find((e) => e.type === "ask") as any).ask;
    assert.equal(ask.kind, "permission");
    assert.equal(ask.title, "Accept this file edit?");
    await assert.rejects(r.adapter.prompt({ id: "u-b", text: "hi", images: [], mode: "steer", busy: true }), /answer its card/);
    r.adapter.answer(ask.id, { choice: ask.choices[0].id });
    await until("enter sent", () => r.calls().some((c) => c[0] === "keys" && c.at(-1) === "enter"));

    // Question card -> answered with down + enter.
    r.status("idle");
    await pause(800);
    r.events.length = 0;
    r.screen(QUESTION);
    r.status("blocked");
    await until("question ask", () => r.events.some((e) => e.type === "ask"));
    const q = (r.events.find((e) => e.type === "ask") as any).ask;
    assert.equal(q.kind, "questions");
    r.adapter.answer(q.id, { answers: { q: "SQLite" } });
    await until("down enter sent", () => r.calls().some((c) => c[0] === "keys" && c.slice(-2).join(" ") === "down enter"));

    // Antigravity 1.5 single-line Question 1/1 + Write-in... custom answer.
    r.status("idle");
    await pause(800);
    r.events.length = 0;
    r.screen(`Question\n────────────────────────────────────\n\nQuestion 1/1: Which file?\n\n> 1. (Recommended) hello.txt\n  2. bye.txt\n  3. Write-in...\n\n  ↑/↓ Navigate · enter Select · esc Skip\nesc to cancel        auto · Gemini 4 Neon · xhigh`);
    r.status("blocked");
    await until("agy 1.5 question ask", () => r.events.some((e) => e.type === "ask"));
    const q15 = (r.events.find((e) => e.type === "ask") as any).ask;
    assert.equal(q15.kind, "questions");
    assert.equal(q15.questions[0].question, "Which file?");
    assert.deepEqual(q15.questions[0].options.map((o: any) => o.label), ["(Recommended) hello.txt", "bye.txt"]);
    assert.equal(q15.questions[0].allowOther, true);
    r.adapter.answer(q15.id, { answers: { q: "custom.txt" } });
    await until("write-in typed", () => r.calls().some((c) => c[0] === "send" && c.at(-1) === "custom.txt"));
    r.screen(IDLE_SCREEN);
    r.status("idle");
    await pause();

    // Model & effort pickers type /model and /effort inline.
    const models = await r.adapter.listModels();
    assert.deepEqual(models.map((m) => m.id), ["gemini-4-neon", "gemini-3.8-flash"]);
    const setModelP = r.adapter.setModel("google", "gemini-3.8-flash");
    await until("/model typed", () => r.calls().some((c) => c[0] === "send" && c.at(-1) === "/model gemini-3.8-flash-high"));
    r.screen("────────────────────────────────────\n> \n────────────────────────────────────\n? for shortcuts        auto · Gemini 3.8 Flash · high");
    await setModelP;

    const setEffP = r.adapter.setThinking("low");
    await until("/effort typed", () => r.calls().some((c) => c[0] === "send" && c.at(-1) === "/effort low"));
    r.screen("────────────────────────────────────\n> \n────────────────────────────────────\n? for shortcuts        auto · Gemini 3.8 Flash · low");
    await setEffP;

    // Permission mode switch cycles Shift+Tab (hc `shift+tab`) until status bar matches.
    writeFileSync(join(r.d, "modes.json"), JSON.stringify({ i: 0, list: ["auto", "plan", "default", "accept-edits"] }));
    r.screen(IDLE_SCREEN);
    await r.adapter.setPermissionMode("plan");
    assert.ok(r.events.some((e) => e.type === "permission_mode" && (e as any).mode === "plan"));
    assert.ok(r.calls().some((c) => c[0] === "keys" && c.includes("shift+tab")));
    assert.ok(!r.calls().some((c) => c[0] === "keys" && c.includes("shift-tab")));

    // Idle screen sync reflects terminal-side Shift+Tab and /effort changes.
    r.events.length = 0;
    r.screen("────────────────────────────────────\n> \n────────────────────────────────────\n? for shortcuts        accept-edits · Gemini 3.8 Flash · max");
    await until("idle screen sync", () => r.events.some((e) => e.type === "permission_mode" && (e as any).mode === "accept-edits")
      && r.events.some((e) => e.type === "thinking" && (e as any).level === "max"));

    // /new / /resume -> presence lock moves to B -> reload session emitted.
    r.events.length = 0;
    r.write(B, [{ step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nFresh\n</USER_REQUEST>" }]);
    r.show(B);
    await until("session reload", () => r.events.some((e) => e.type === "session" && (e as any).reload));
    assert.equal((r.events.find((e) => e.type === "session") as any).id, B);

    // Antigravity quits back to shell.
    r.events.length = 0;
    r.quit();
    r.event({ method: "event", params: { type: "foreground", terminal: "t5", data: { pid: 5000, name: "fish", argv: ["fish"] } } });
    await until("quit notice", () => r.events.some((e) => e.type === "notice" && /Antigravity quit/.test((e as any).text)));
    await assert.rejects(r.adapter.prompt({ id: "u-q", text: "hi", images: [], mode: "steer", busy: false }), /isn't running in its terminal/);
  } finally {
    r.done();
  }
});

test("uncataloged models still expose all five effort tiers and startup falls back to default mode when screen has no status bar", async () => {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-agy-uncat-"));
  const cwd = join(d, "proj");
  const dataDir = join(d, "agy-data");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "events.jsonl"), JSON.stringify({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4001, name: "antigravity", argv: ["antigravity"] }, status: { app: "antigravity", state: "idle" } }] }) + "\n");
  writeFileSync(join(d, "screen.txt"), "scrolled output with no status bar\n");
  const p = transcriptPath(dataDir, A);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-high", content: "hi" }) + "\n");
  const io: AgyBindIO = {
    tree: (pid) => [pid],
    argv: () => ["antigravity"],
    cwd: () => cwd,
    env: (_p, n) => (n === "ANTIGRAVITY_CLI_DATA_DIR" ? dataDir : null),
    openFiles: () => [join(dataDir, "presence", `${A}.lock`)],
    exists: existsSync,
    mtime: () => Date.now(),
  };
  const events: NormalizedEvent[] = [];
  const adapter = new AntigravityTerminalAdapter({
    cwd, command: "agy", args: [], log: () => {}, terminal: "t5", hc, io,
    fetchModels: async () => [],
  });
  try {
    await adapter.start(null, { emit: (ev) => events.push(ev), log: () => {}, running: false, working: false });
    assert.ok(events.some((e) => e.type === "permission_mode" && (e as any).mode === "default"));
    await adapter.history();
    const caps = [...events].reverse().find((e) => e.type === "capabilities") as any;
    assert.deepEqual(caps?.capabilities?.thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
  } finally {
    adapter.kill();
    rmSync(d, { recursive: true, force: true });
  }
});
