// The terminal view of an Antigravity CLI (`agy`) TUI (host/providers/antigravity/terminal.ts):
// against a fake `hc` and a stand-in /proc reader. No Herdr, no live `agy`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AntigravityTerminalAdapter, fullTranscriptPath } from "../../host/providers/antigravity/terminal.ts";
import { Chat } from "../../host/chat.ts";
import { Attachments } from "../../host/attachments.ts";
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
} else if (cmd === "connect") {
  const enc = (ch, kind, payload) => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    const out = Buffer.allocUnsafe(9 + body.length);
    out.writeUInt32LE(ch, 0);
    out[4] = kind;
    out.writeUInt32LE(body.length, 5);
    body.copy(out, 9);
    return out;
  };
  let framed = false;
  let buf = Buffer.alloc(0);
  const handle = (ch, kind, payload) => {
    if (ch === 0 && kind === 0) {
      const m = JSON.parse(payload.toString("utf8"));
      const reply = (result) => process.stdout.write(enc(0, 0, JSON.stringify({ jsonrpc: "2.0", id: m.id, result })));
      if (m.method === "terminal.get") {
        let state = "idle";
        try {
          const evs = fs.readFileSync(dir + "/events.jsonl", "utf8").trim().split("\\n").filter(Boolean);
          for (const l of evs) {
            const e = JSON.parse(l);
            if (e.params && e.params.type === "status" && e.params.data && e.params.data.status) state = e.params.data.status.state || state;
          }
        } catch {}
        reply({ address: m.params.terminal, state: "live", cols: 100, rows: 30, status: { app: "antigravity", state } });
      } else if (m.method === "terminal.read") {
        let text = "";
        try { text = fs.readFileSync(dir + "/screen.txt", "utf8"); } catch {}
        reply({ complete: true, how: "screen", text });
      } else if (m.method === "terminal.attach") {
        reply({ channel: 7, terminal: { address: m.params.terminal, cols: 100, rows: 30 } });
      }
    } else if (ch === 7 && kind === 0) {
      const s = payload.toString("utf8");
      fs.appendFileSync(dir + "/attach.jsonl", JSON.stringify(s) + "\\n");
      if (s === "!") {
        if (fs.existsSync(dir + "/no-shell-mode")) {
          if (fs.existsSync(dir + "/draft-mode")) {
            fs.writeFileSync(dir + "/screen.txt", "────────────────────────────────────\\n> my draft!\\n────────────────────────────────────\\n? for shortcuts        auto · Gemini 4 Neon · xhigh\\n");
          }
        } else {
          fs.writeFileSync(dir + "/screen.txt", "────────────────────────────────────\\n!\\n────────────────────────────────────\\n activated bash mode · esc to cancel        auto · Gemini 4 Neon · xhigh\\n");
        }
      }
    } else if (ch === 7 && kind === 2) {
      process.stdout.write(enc(7, 2, Buffer.alloc(0)));
    }
  };
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!framed) {
      const nl = buf.indexOf(10);
      if (nl < 0) return;
      const m = JSON.parse(buf.subarray(0, nl).toString("utf8"));
      buf = buf.subarray(nl + 1);
      framed = true;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { generation: 1, framed: true, version: "0.1.21", core: { id: "c1", name: "test" }, methods: [], features: ["framed"] } }) + "\\n");
    }
    while (buf.length >= 9) {
      const len = buf.readUInt32LE(5);
      if (buf.length < 9 + len) break;
      const ch = buf.readUInt32LE(0);
      const kind = buf[4];
      const payload = buf.subarray(9, 9 + len);
      buf = buf.subarray(9 + len);
      handle(ch, kind, payload);
    }
  });
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

    // External screenshot uploaded via OmaRelay (`@<cwd>/.ovis/paste-….jpg`): shown as an image block without raw path text.
    const ovisDir = join(r.d, "proj", ".ovis");
    mkdirSync(ovisDir, { recursive: true });
    const ovisShot = join(ovisDir, "paste-20261123-031336-81ae7966.jpg");
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    writeFileSync(ovisShot, JPEG);
    r.events.length = 0;
    r.write(A, [
      { step_index: 6, type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>\n@${ovisShot}\n</USER_REQUEST>` },
    ]);
    await until("external screenshot message", () => r.events.some((e) => e.type === "user_message"));
    const extShot = r.events.find((e) => e.type === "user_message") as any;
    assert.equal(extShot.source, "external");
    assert.equal(extShot.text, "");
    assert.equal(extShot.images, 1);
    assert.equal(extShot.imageBlocks?.[0]?.mimeType, "image/jpeg");
    assert.equal(extShot.imageBlocks?.[0]?.data, JPEG.toString("base64"));

    // Quota warning printed above idle composer emits `quota_warning`, updates on new Error ID, and clears on run_started.
    r.events.length = 0;
    r.screen(`⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in\n1h50m10s.\nError ID: 0b64d408-0b25-43c1-90a3-095569e7b843-235\n\n${IDLE_SCREEN}`);
    await until("quota_warning emitted", () => r.events.some((e) => e.type === "quota_warning" && (e as any).warning !== null));
    const qw = (r.events.find((e) => e.type === "quota_warning" && (e as any).warning !== null) as any).warning;
    assert.equal(qw.title, "Quota reached");
    assert.equal(qw.errorId, "0b64d408-0b25-43c1-90a3-095569e7b843-235");
    r.events.length = 0;
    r.status("working");
    await until("quota_warning cleared on working", () => r.events.some((e) => e.type === "quota_warning" && (e as any).warning === null));
    r.screen(IDLE_SCREEN);
    r.status("idle");
    await pause();

    // Bang command (`! <cmd>`): enters Antigravity's bash mode via raw `!` over `hc connect`
    // (not bracketed-pasted via `hc send`, which agy would submit to the LLM), pastes the command,
    // presses Enter, refuses when bash mode does not open (undoing `!` on a draft without sending
    // the command or Enter), and refuses while working.
    const callsBeforeBang = r.calls().length;
    const bangRes = await r.adapter.prompt({ id: "u-bang", text: "! echo hello", images: [], mode: "auto", busy: false });
    assert.equal(bangRes.disposition, "handled");
    assert.equal(r.calls().length, callsBeforeBang);
    const attached = readFileSync(join(r.d, "attach.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(attached, ["!", "\x1b[200~echo hello\x1b[201~", "\r"]);
    // If Antigravity already has a draft and doesn't enter shell mode, `!` is undone and cmd/Enter are never sent.
    writeFileSync(join(r.d, "attach.jsonl"), "");
    r.screen("────────────────────────────────────\n> my draft\n────────────────────────────────────\n? for shortcuts        auto · Gemini 4 Neon · xhigh");
    writeFileSync(join(r.d, "no-shell-mode"), "");
    writeFileSync(join(r.d, "draft-mode"), "");
    await assert.rejects(
      r.adapter.prompt({ id: "u-bang-draft", text: "! echo never-sent", images: [], mode: "auto", busy: false }),
      /didn't enter shell mode/,
    );
    const aborted = readFileSync(join(r.d, "attach.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(aborted, ["!", "\x7f"]);
    rmSync(join(r.d, "no-shell-mode"));
    rmSync(join(r.d, "draft-mode"));
    r.screen(IDLE_SCREEN);
    r.events.length = 0;
    r.status("working");
    await until("working before bang refusal", () => r.events.some((e) => e.type === "run_started"));
    await assert.rejects(r.adapter.prompt({ id: "u-bang-busy", text: "! echo busy", images: [], mode: "auto", busy: true }), /Antigravity is working/);
    r.status("idle");
    await until("settled after bang check", () => r.events.some((e) => e.type === "run_settled"));

    // Queued messages while working show in the steering lane (`queue_changed`), clear when delivered
    // (including when Antigravity concatenates multiple queued messages with "\n" into one USER_INPUT),
    // and clear on settle if cancelled in the terminal.
    r.events.length = 0;
    r.status("working");
    await until("working for queue test", () => r.events.some((e) => e.type === "run_started"));
    const q1 = await r.adapter.prompt({ id: "u-q1", text: "first queued note", images: [], mode: "auto", busy: true });
    const q2 = await r.adapter.prompt({ id: "u-q2", text: "second queued note", images: [], mode: "auto", busy: true });
    assert.deepEqual([q1.disposition, q2.disposition], ["queued", "queued"]);
    const qEvents = r.events.filter((e) => e.type === "queue_changed") as any[];
    assert.deepEqual(qEvents.at(-1)?.steering, ["first queued note", "second queued note"]);
    assert.deepEqual(qEvents.at(-1)?.steeringIds, ["u-q1", "u-q2"]);
    r.events.length = 0;
    r.write(A, [
      { step_index: 7, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nfirst queued note\nsecond queued note\n</USER_REQUEST>" },
    ]);
    await until("merged queued echo", () => r.events.some((e) => e.type === "user_message"));
    const mergedEcho = r.events.find((e) => e.type === "user_message") as any;
    assert.equal(mergedEcho.clientId, "u-q1");
    assert.equal(mergedEcho.source, undefined);
    const clearedQ = r.events.filter((e) => e.type === "queue_changed").at(-1) as any;
    assert.deepEqual(clearedQ?.steering, []);
    // A queued message cancelled in the terminal clears when the run settles.
    r.events.length = 0;
    await r.adapter.prompt({ id: "u-q3", text: "cancelled in tui", images: [], mode: "auto", busy: true });
    assert.deepEqual((r.events.filter((e) => e.type === "queue_changed").at(-1) as any)?.steering, ["cancelled in tui"]);
    r.status("idle");
    await until("settled clears cancelled queue", () => r.events.some((e) => e.type === "run_settled"));
    assert.deepEqual((r.events.filter((e) => e.type === "queue_changed").at(-1) as any)?.steering, []);

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

test("command approval cards emit structured run_command tool, separate reason, recover verbatim pending CommandLine, and compact always-allow labels", async () => {
  const r = rig();
  try {
    const exactCmd = `python3 -c "import sys; sys.path.insert(0, '/home/noc/code/omarelay/scripts'); import ovis; print('OK')"`;
    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nRun tests\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", tool_calls: [{ name: "run_command", args: { CommandLine: JSON.stringify(exactCmd) } }] },
    ]);
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "idle" } }] });
    await r.adapter.start(null, r.host);
    await r.adapter.history();

    r.events.length = 0;
    r.screen([
      "────────────────────────────────────────────────────────────────────────",
      "Reason: Runs tests outside the workspace sandbox. Requesting permission for: python3 -c \"import sys; sys.path.insert(0, '/home/noc/code/oma",
      "relay/scripts'); import ovis; print('OK')\"",
      "",
      "Run this command?",
      "> 1. Yes, run command",
      "  2. Yes, and always allow in this conversation for commands that start with 'python3 -c \"import sys; sys.path.insert(0, '/home/noc/code/omarelay/scripts'); i...'",
      "  3. Yes, and always allow for commands that start with 'python3 -c \"import sys; sys.path.insert(0, '/home/noc/code/omarelay/scripts'); i...' (Persist to settings.json)",
      "  4. No, cancel",
      "  ↑/↓ Navigate · enter Confirm · esc Cancel",
    ].join("\n"));
    r.status("blocked");
    await until("command permission ask", () => r.events.some((e) => e.type === "ask"));

    const ask = (r.events.find((e) => e.type === "ask") as any).ask;
    assert.equal(ask.kind, "permission");
    assert.equal(ask.title, "Run this command?");
    // Exact verbatim command recovered from pending tool_call despite mid-word screen wrap (`oma\nrelay`).
    assert.deepEqual(ask.tool, { name: "run_command", args: { CommandLine: exactCmd } });
    assert.equal(ask.message, "Runs tests outside the workspace sandbox.");
    assert.deepEqual(ask.choices.map((c: any) => [c.kind, c.label]), [
      ["allow", "Yes, run command"],
      ["allow_always", `Always allow 'python3 -c "import sys; sys.path.…' (this chat)`],
      ["allow_always", `Always allow 'python3 -c "import sys; sys.path.…' (Persist to settings.json)`],
      ["deny", "No, cancel"],
    ]);
    assert.match(ask.choices[1].description, /Yes, and always allow in this conversation/);
    assert.match(ask.choices[2].description, /Persist to settings\.json/);

    // Answering the formatted always-allow option still navigates to row 2 cleanly.
    r.adapter.answer(ask.id, { choice: ask.choices[1].id });
    await until("down enter sent", () => r.calls().some((c) => c[0] === "keys" && c.slice(-2).join(" ") === "down enter"));
  } finally {
    r.done();
  }
});

test("live working status ticker polls screen while working, deduplicates frame ticks, and clears on blocked and settle", async () => {
  const prevPoll = process.env.HERDR_CHAT_WORK_STATUS_MS;
  process.env.HERDR_CHAT_WORK_STATUS_MS = "40";
  const r = rig();
  try {
    const workingScreen = (spinner: string, msg: string) => [
      "● Ran (ls -la) (ctrl+o to expand)",
      `${spinner} ${msg}`,
      "│ Tip: Use /settings to configure",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "esc to cancel        auto · Gemini 4 Neon · xhigh",
    ].join("\n");

    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nCheck usage.test.ts\n</USER_REQUEST>" },
    ]);
    // Start already working so initial poll kicks in immediately.
    r.screen(workingScreen("⣿", "Reviewing usage.test.ts to understand path resolution..."));
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "working" } }] });
    const info = await r.adapter.start(null, r.host);
    assert.equal(info.streaming, true);
    await r.adapter.history();

    await until("initial activity_text emitted", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === "Reviewing usage.test.ts to understand path resolution..."),
    );

    // Changing only the braille spinner frame must NOT re-emit the same activity_text.
    r.events.length = 0;
    r.screen(workingScreen("⣷", "Reviewing usage.test.ts to understand path resolution..."));
    await pause(120);
    assert.equal(r.events.filter((e) => e.type === "activity_text").length, 0);

    // Updating the status text emits the new message.
    r.screen(workingScreen("⠋", "Verifying Antigravity status bar parsing..."));
    await until("updated activity_text emitted", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === "Verifying Antigravity status bar parsing..."),
    );

    // Transitioning to blocked clears activity_text; returning to working resumes polling.
    r.events.length = 0;
    r.screen(EDIT_APPROVAL);
    r.status("blocked");
    await until("activity_text cleared on blocked", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === null),
    );
    r.events.length = 0;
    r.screen(workingScreen("⠙", "Applying the edit and running tests..."));
    r.status("working");
    await until("activity_text resumed after blocked", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === "Applying the edit and running tests..."),
    );

    // Settling to done clears activity_text.
    r.events.length = 0;
    r.screen(IDLE_SCREEN);
    r.status("done");
    await until("activity_text cleared on done", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === null)
      && r.events.some((e) => e.type === "run_settled"),
    );
  } finally {
    if (prevPoll === undefined) delete process.env.HERDR_CHAT_WORK_STATUS_MS;
    else process.env.HERDR_CHAT_WORK_STATUS_MS = prevPoll;
    r.done();
  }
});

test("catches Interrupted banner while working (even without status transition) and deduplicates on idle polls", async () => {
  const prevPoll = process.env.HERDR_CHAT_WORK_STATUS_MS;
  process.env.HERDR_CHAT_WORK_STATUS_MS = "40";
  const r = rig();
  try {
    const workingScreen = [
      "● Ran (ls -la) (ctrl+o to expand)",
      "⠋ Checking files...",
      "└ Tip: Press ctrl+g to open an external editor",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "esc to cancel        auto · Gemini 4 Neon · xhigh",
    ].join("\n");
    const interruptedScreen = [
      "● Ran (ls -la) (ctrl+o to expand)",
      "Interrupted · What should Antigravity CLI do instead?",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "? for shortcuts      auto · Gemini 4 Neon · xhigh",
    ].join("\n");

    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nDo work\n</USER_REQUEST>" },
    ]);
    r.screen(workingScreen);
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "working" } }] });
    await r.adapter.start(null, r.host);
    await r.adapter.history();

    await until("initial status read", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === "Checking files..."),
    );

    // Antigravity interrupts on screen without herdr-core transitioning status away from working.
    r.events.length = 0;
    r.screen(interruptedScreen);
    await until("interrupted settles as aborted and emits warning notice", () =>
      r.events.some((e) => e.type === "run_settled" && (e as any).aborted === true)
      && r.events.some((e) => e.type === "notice" && (e as any).text === "Interrupted · What should Antigravity CLI do instead?"),
    );

    // Subsequent status -> idle and idle polls must NOT duplicate the notice.
    r.events.length = 0;
    r.status("idle");
    await pause(280);
    assert.equal(r.events.filter((e) => e.type === "notice").length, 0);

    // A new working turn clears the guard so a later interruption is caught again.
    r.screen(workingScreen);
    r.status("working");
    await until("second turn working", () =>
      r.events.some((e) => e.type === "activity_text" && (e as any).text === "Checking files..."),
    );
    r.events.length = 0;
    r.screen(interruptedScreen);
    r.status("done");
    await until("second interruption caught on settle sync", () =>
      r.events.some((e) => e.type === "notice" && (e as any).text === "Interrupted · What should Antigravity CLI do instead?"),
    );
  } finally {
    if (prevPoll === undefined) delete process.env.HERDR_CHAT_WORK_STATUS_MS;
    else process.env.HERDR_CHAT_WORK_STATUS_MS = prevPoll;
    r.done();
  }
});

test("Chat accumulates activityLog with prefix collapsing, keeps it after settle, and resets on the next run", async () => {
  const prevPoll = process.env.HERDR_CHAT_WORK_STATUS_MS;
  process.env.HERDR_CHAT_WORK_STATUS_MS = "40";
  const r = rig();
  try {
    const workingScreen = (msg: string) => [
      "● Ran (ls -la) (ctrl+o to expand)",
      `⠋ ${msg}`,
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "esc to cancel        auto · Gemini 4 Neon · xhigh",
    ].join("\n");

    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nTrack activity\n</USER_REQUEST>" },
    ]);
    r.screen(workingScreen("Reviewing usage.test.ts..."));
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "working" } }] });

    const chat = new Chat({
      chat: "c-act",
      cwd: r.d,
      session: null,
      adapter: r.adapter,
      terminal: null,
      attachments: new Attachments(join(r.d, "att")),
      view: "t5",
      log: () => {},
    });
    chat.start(null);
    await chat.whenReady(5000);

    await until("first status recorded", () => chat.state.activityLog.some((e) => e.text === "Reviewing usage.test.ts..."));

    // Progressive prefix extension replaces the latest status entry in place.
    r.screen(workingScreen("Reviewing usage.test.ts to verify icon paths..."));
    await until("prefix collapsed", () => chat.state.activityLog.some((e) => e.text === "Reviewing usage.test.ts to verify icon paths..."));
    assert.equal(chat.state.activityLog.filter((e) => e.kind === "status").length, 1);

    // Distinct new status appends a second entry.
    r.screen(workingScreen("Running tests across both repos..."));
    await until("second status appended", () => chat.state.activityLog.some((e) => e.text === "Running tests across both repos..."));
    assert.equal(chat.state.activityLog.filter((e) => e.kind === "status").length, 2);

    // Settling clears activityText but keeps activityLog readable for Ctrl+O inspection.
    r.screen(IDLE_SCREEN);
    r.status("done");
    await until("settled with log preserved", () => chat.state.phase === "idle" && chat.state.activityText === null);
    assert.equal(chat.state.activityLog.length, 2);

    // Starting the next run clears the previous run's activityLog.
    r.screen(workingScreen("Starting fresh task..."));
    r.status("working");
    await until("next run resets log", () => chat.state.activityLog.length === 1 && chat.state.activityLog[0]!.text === "Starting fresh task...");

    await chat.shutdown();
  } finally {
    if (prevPoll === undefined) delete process.env.HERDR_CHAT_WORK_STATUS_MS;
    else process.env.HERDR_CHAT_WORK_STATUS_MS = prevPoll;
    r.done();
  }
});

test("Antigravity hydrates truncated compact transcript records from sibling transcript_full.jsonl in history and live tail", async () => {
  const r = rig();
  try {
    const compactPath = r.file(A);
    const fullPath = fullTranscriptPath(compactPath)!;
    assert.ok(fullPath.endsWith("transcript_full.jsonl"));
    const writeFull = (recs: Rec[]) => {
      mkdirSync(dirname(fullPath), { recursive: true });
      appendFileSync(fullPath, recs.map((x) => JSON.stringify(x) + "\n").join(""));
    };

    const fullReply1 = "1. **Bug: `herdr-app` strips `text_color(...)` from all `TextView.markdown` headings**\n   - Full details preserved.\n2. **Second item**";
    const compactReply1 = "1. **Bug: `herdr-app` stri\n<truncated 848 bytes>\n.markdown` headings**";

    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nCheck colors\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: compactReply1, truncated_fields: ["content"] },
    ]);
    writeFull([
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nCheck colors\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: fullReply1 },
    ]);

    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "idle" } }] });
    await r.adapter.start(null, r.host);

    const hist = await r.adapter.history();
    const histAnswer = hist.find((e) => e.type === "assistant_end") as any;
    assert.ok(histAnswer);
    assert.equal(histAnswer.content.find((b: any) => b?.type === "text")?.text, fullReply1);

    // Live tail: compact truncated record arrives slightly before transcript_full.jsonl flushes.
    const fullReply2 = "### Live Answer\n- Complete `code` and [link](file:///a.ts) without truncation.";
    const compactReply2 = "### Live Ans\n<truncated 400 bytes>\ntruncation.";
    r.events.length = 0;
    r.write(A, [
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: compactReply2, truncated_fields: ["content"] },
    ]);
    // Pause briefly before writing the full record so tail() exercises its wait-for-full path.
    await pause(200);
    assert.equal(r.events.filter((e) => e.type === "assistant_end").length, 0, "waits briefly for transcript_full.jsonl instead of emitting corrupted compact text");
    writeFull([
      { step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: fullReply2 },
    ]);
    await until("live hydrated answer", () => r.events.some((e) => e.type === "assistant_end"));
    const liveAnswer = r.events.find((e) => e.type === "assistant_end") as any;
    assert.equal(liveAnswer.content.find((b: any) => b?.type === "text")?.text, fullReply2);
  } finally {
    r.done();
  }
});

test("Chat queue_edit and queue_send_now on Antigravity hold steers editably, clear immediately on Send immediately, and drain on settle", async () => {
  const r = rig();
  try {
    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nRun the build\n</USER_REQUEST>" },
    ]);
    r.screen("⠋ Building...\n────────────────────────────────────\n>\n────────────────────────────────────\nesc to cancel        auto · Gemini 4 Neon · xhigh");
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "working" } }] });

    const chat = new Chat({
      chat: "c-send-now",
      cwd: r.d,
      session: null,
      adapter: r.adapter,
      terminal: null,
      attachments: new Attachments(join(r.d, "att")),
      view: "t5",
      log: () => {},
    });
    chat.start(null);
    await chat.whenReady(5000);

    // Nothing queued yet -> no-op `{ sent: false }`.
    assert.deepEqual(await chat.op("queue_send_now", {}), { sent: false });

    // Queue a steering message while working -> held locally so it is editable AND sendable immediately.
    await chat.op("send", { text: "Stop and fix tests first" });
    await until(
      "steering queued with removable + steeringSendNow",
      () =>
        chat.state.queue.steering[0] === "Stop and fix tests first" &&
        chat.state.queue.steeringRemovable?.[0] === true &&
        chat.state.queue.steeringSendNow === true,
    );
    assert.equal(r.calls().filter((c) => c[0] === "send").length, 0, "held locally until sent now or turn ends");

    // Edit pulls the queued steer cleanly back out of the lane with its exact text.
    const editId = chat.state.queue.steeringIds![0]!;
    const edited = (await chat.op("queue_edit", { message: editId })) as { text: string; images: string[] };
    assert.equal(edited.text, "Stop and fix tests first");
    assert.equal(chat.state.queue.steering.length, 0);

    // Re-queue after editing and send immediately with default `alt+m`: clears box immediately, calls send then keys.
    await chat.op("send", { text: "Stop and fix lint first" });
    await until("re-queued steer", () => chat.state.queue.steering[0] === "Stop and fix lint first");
    assert.deepEqual(await chat.op("queue_send_now", {}), { sent: true });
    assert.equal(chat.state.queue.steering.length, 0, "steer box clears immediately after Send immediately");
    assert.equal(chat.state.queue.steeringSendNow, undefined);
    const afterDefault = r.calls();
    assert.deepEqual(afterDefault.at(-2), ["send", "--json", "t5", "Stop and fix lint first"]);
    assert.deepEqual(afterDefault.at(-1), ["keys", "--json", "t5", "alt+m"]);

    // Custom key shown on Antigravity's screen: presses that exact key (`ctrl+m`).
    await chat.op("send", { text: "Also update docs" });
    await until("queued second steer", () => chat.state.queue.steering[0] === "Also update docs");
    r.screen("⠋ Building...\nQueued (1) (ctrl+m to send immediately)\n  Also update docs\n────────────────────────────────────\n>\n────────────────────────────────────\nesc to cancel        auto · Gemini 4 Neon · xhigh");
    assert.deepEqual(await chat.op("queue_send_now", {}), { sent: true });
    assert.equal(chat.state.queue.steering.length, 0);
    const afterCustom = r.calls();
    assert.deepEqual(afterCustom.at(-2), ["send", "--json", "t5", "Also update docs"]);
    assert.deepEqual(afterCustom.at(-1), ["keys", "--json", "t5", "ctrl+m"]);

    // While blocked on a dialog, steeringSendNow turns off and queue_send_now refuses, while message stays safely queued.
    await chat.op("send", { text: "After approval run e2e" });
    await until("queued third steer", () => chat.state.queue.steering[0] === "After approval run e2e");
    r.screen(EDIT_APPROVAL);
    r.status("blocked");
    await until("blocked clears steeringSendNow", () => !chat.state.queue.steeringSendNow);
    await assert.rejects(chat.op("queue_send_now", {}), /can't send queued messages immediately/);

    // Returning to working restores steeringSendNow; settling naturally drains the held steer into `hc send`.
    r.screen("⠋ Building...\n────────────────────────────────────\n>\n────────────────────────────────────\nesc to cancel        auto · Gemini 4 Neon · xhigh");
    r.status("working");
    await until("working restores steeringSendNow", () => chat.state.queue.steeringSendNow === true);

    r.screen(IDLE_SCREEN);
    r.status("done");
    await until("queued steer drained on turn settle", () =>
      chat.state.queue.steering.length === 0 && r.calls().some((c) => c[0] === "send" && c[3] === "After approval run e2e"),
    );
    assert.deepEqual(await chat.op("queue_send_now", {}), { sent: false });

    await chat.shutdown();
  } finally {
    r.done();
  }
});

test("Antigravity `!` bang runs mirror live TUI output into a standalone you-bash card and deduplicate native SHELL_EXEC", async () => {
  const prevPoll = process.env.HERDR_CHAT_BANG_POLL_MS;
  process.env.HERDR_CHAT_BANG_POLL_MS = "30";
  const r = rig();
  try {
    const beforeScreen = [
      "Run this command:",
      "! sample-install --from ./dist",
      "────────────────────────────────────",
      "> Auto mode: edits & safe commands auto-approved",
      "────────────────────────────────────",
      "? for shortcuts        auto · Gemini 4 Neon · xhigh",
    ].join("\n");
    r.write(A, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nBuild it\n</USER_REQUEST>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: "```bash\n! sample-install --from ./dist\n```" },
    ]);
    r.screen(beforeScreen);
    r.event({ terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "idle" } }] });

    const chat = new Chat({
      chat: "c-bang-live",
      cwd: r.d,
      session: null,
      adapter: r.adapter,
      terminal: null,
      attachments: new Attachments(join(r.d, "att")),
      view: "t5",
      log: () => {},
    });
    chat.start(null);
    await chat.whenReady(5000);

    // Click "Run in Antigravity" (`echo: false`): immediately adds a standalone running you-bash card.
    const res = (await chat.op("send", { text: "! sample-install --from ./dist", mode: "auto", echo: false })) as { disposition: string };
    assert.equal(res.disposition, "handled");
    await until("live you-bash card running", () =>
      chat.timeline.items.some((it) => it.kind === "tool" && it.toolCallId.startsWith("you-bash-live-") && it.status === "running"),
    );

    // Stream intermediate TUI output while command is still running (`esc to cancel`).
    r.screen([
      "Run this command:",
      "! sample-install --from ./dist",
      "! sample-install --from ./dist",
      "Unpacking bundle...",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "esc to cancel        auto · Gemini 4 Neon · xhigh",
    ].join("\n"));
    await until("live output streamed", () =>
      chat.timeline.items.some((it) => it.kind === "tool" && it.toolCallId.startsWith("you-bash-live-") && it.output.includes("Unpacking bundle...")),
    );

    // Command completes and returns to idle prompt -> card settles with complete output and exitCode 0.
    r.screen([
      "Run this command:",
      "! sample-install --from ./dist",
      "! sample-install --from ./dist",
      "Unpacking bundle...",
      "Installed sample-app 1.2.3",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "? for shortcuts        auto · Gemini 4 Neon · xhigh",
    ].join("\n"));
    await until("live card settled done", () =>
      chat.timeline.items.some((it) => it.kind === "tool" && it.toolCallId.startsWith("you-bash-live-") && it.status === "done"),
    );
    const bashCard = chat.timeline.items.find((it) => it.kind === "tool" && it.toolCallId.startsWith("you-bash-live-")) as any;
    assert.equal(bashCard.detail.type, "bash");
    assert.equal(bashCard.detail.command, "sample-install --from ./dist");
    assert.equal(bashCard.detail.exitCode, 0);
    assert.equal(bashCard.output, "Unpacking bundle...\nInstalled sample-app 1.2.3");

    // If Antigravity later also writes a matching native SHELL_EXEC record, it deduplicates 1-to-1 instead of duplicating the card.
    r.write(A, [
      { step_index: 2, type: "SHELL_EXEC", status: "DONE", command: "sample-install --from ./dist", exit_code: 0, output: "Installed sample-app 1.2.3" },
    ]);
    await pause(250);
    assert.equal(chat.timeline.items.filter((it) => it.kind === "tool" && it.toolCallId.startsWith("you-bash-")).length, 1);

    // A failing `!` command captures its non-zero exit code and renders with status "error".
    const failBefore = [
      "Installed sample-app 1.2.3",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "? for shortcuts        auto · Gemini 4 Neon · xhigh",
    ].join("\n");
    r.screen(failBefore);
    await chat.op("send", { text: "! sample-check --strict", mode: "auto", echo: false });
    r.screen([
      "Installed sample-app 1.2.3",
      "! sample-check --strict",
      "error: assertion failed",
      "Exit code: 1",
      "────────────────────────────────────",
      ">",
      "────────────────────────────────────",
      "? for shortcuts        auto · Gemini 4 Neon · xhigh",
    ].join("\n"));
    await until("failed bang card settled", () =>
      chat.timeline.items.some((it) => it.kind === "tool" && it.detail.type === "bash" && it.detail.command === "sample-check --strict" && it.status === "error"),
    );
    const failCard = chat.timeline.items.find((it) => it.kind === "tool" && it.detail.type === "bash" && it.detail.command === "sample-check --strict") as any;
    assert.equal(failCard.detail.exitCode, 1);
    assert.equal(failCard.output, "error: assertion failed\nExit code: 1");

    await chat.shutdown();
  } finally {
    if (prevPoll === undefined) delete process.env.HERDR_CHAT_BANG_POLL_MS;
    else process.env.HERDR_CHAT_BANG_POLL_MS = prevPoll;
    r.done();
  }
});
