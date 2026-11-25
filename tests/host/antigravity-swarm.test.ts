// Antigravity `/swarm` reader, host RPCs, themed SVG graph, pure UI helpers, and multi-line `!` bang-paste regression tests.
// Uses only disposable temp directories and synthetic fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Chat } from "../../host/chat.ts";
import { Attachments } from "../../host/attachments.ts";
import { AntigravityTerminalAdapter } from "../../host/providers/antigravity/terminal.ts";
import { sendAgyBang } from "../../host/providers/antigravity/bang.ts";
import { transcriptPath } from "../../host/providers/antigravity/bind.ts";
import type { AgyBindIO } from "../../host/providers/antigravity/bind.ts";
import {
  buildSwarmActionPrompt,
  clearSwarmReaderCache,
  computeSwarmGraph,
  materializeSwarmFrames,
  parseSwarmAction,
  readSwarmMemberTranscript,
  readSwarmSnapshot,
  resolveSwarmFrameFile,
  writeSwarmGraphSvg,
} from "../../host/providers/antigravity/swarm.ts";
import { DEFAULT_THEME } from "../../host/mermaid.ts";
import {
  collectAttention,
  collectWorkstreams,
  extractSeqRefs,
  filterSwarmMessages,
  groupSwarmMembers,
  nextReplaySeq,
  stripScreenshotLines,
  swarmStatusSummary,
  // @ts-expect-error plain JS module of the mod
} from "../../herdr-app/mods/chat/swarm-logic.js";

process.env.HERDR_CHAT_SESSION_MS ??= "150";

const COORD_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_A_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_B_ID = "33333333-3333-4333-8333-333333333333";
const WORKER_C_ID = "44444444-4444-4444-8444-444444444444";
const NARRATOR_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_CONV_ID = "66666666-6666-4666-8666-666666666666";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const IDLE_SCREEN = [
  "────────────────────────────────────",
  ">",
  "────────────────────────────────────",
  "? for shortcuts        auto · Gemini 4 Neon · xhigh",
].join("\n");

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
  fs.appendFileSync(dir + "/connect-called.txt", "1\\n");
  process.exit(1);
} else {
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify([cmd, ...rest]) + "\\n");
  process.stdout.write("{}\\n");
}
`;

function writeJsonl(path: string, recs: unknown[]) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function buildSyntheticSwarm(dataDir: string) {
  const swarmDir = join(dataDir, "brain", COORD_ID, ".system_generated", "swarm");
  mkdirSync(swarmDir, { recursive: true });

  const shotPath = join(dataDir, "brain", WORKER_A_ID, "progress.png");
  mkdirSync(dirname(shotPath), { recursive: true });
  writeFileSync(shotPath, PNG_BYTES);

  writeFileSync(
    join(swarmDir, "members.json"),
    JSON.stringify({
      title: "Auth migration swarm",
      members: {
        coordinator: {
          conversation_id: COORD_ID,
          model: "gemini-2.5-pro",
          role: "coordinator",
          wake_mode: "mentions",
          last_read_seq: 2,
          killed: false,
          channels: ["main", "backend"],
          workspace_mode: "inherit",
        },
        "api-1": {
          conversation_id: WORKER_A_ID,
          model: "gemini-2.5-pro",
          role: "worker",
          wake_mode: "",
          last_read_seq: 1,
          killed: false,
          channels: ["main", "backend"],
          workspace_mode: "share",
          workspace: "/tmp/wt-api-1",
        },
        "ui-1": {
          conversation_id: WORKER_B_ID,
          model: "claude-sonnet-4-5",
          role: "worker",
          wake_mode: "",
          last_read_seq: 3,
          killed: false,
          channels: ["main"],
          workspace_mode: "share",
        },
        "db-1": {
          conversation_id: WORKER_C_ID,
          model: "gemini-2.5-flash",
          role: "worker",
          wake_mode: "",
          last_read_seq: 1,
          killed: false,
          channels: ["main", "backend"],
          workspace_mode: "branch",
        },
        narrator: {
          conversation_id: NARRATOR_ID,
          model: "gemini-2.5-flash",
          role: "narrator",
          wake_mode: "anything",
          last_read_seq: 3,
          killed: false,
          channels: ["main"],
          workspace_mode: "inherit",
        },
      },
    }),
  );

  writeJsonl(join(swarmDir, "board.jsonl"), [
    {
      seq: 1,
      agent: "coordinator",
      channel: "main",
      time: "2026-11-25T09:00:00Z",
      text: "@all Starting auth migration. @api-1 owns tokens; @ui-1 owns login form.",
    },
    {
      seq: 2,
      agent: "api-1",
      channel: "backend",
      time: "2026-11-25T09:01:00Z",
      control: { op: "create", channel: "backend", topic: "API & DB changes", members: ["coordinator", "api-1", "db-1"] },
      text: `@coordinator Token middleware wired. See #1.\nScreenshot: ${shotPath} | Auth check green`,
    },
    {
      seq: 3,
      agent: "ui-1",
      channel: "main",
      time: "2026-11-25T09:02:00Z",
      text: "@api-1 Need the new session header name from #2.",
    },
  ]);

  writeFileSync(
    join(swarmDir, "plan.json"),
    JSON.stringify({
      goal: { title: "Migrate auth to JWT", line: "Replace legacy cookie sessions across API and UI" },
      tasks: { "api-1": "Token verification middleware", "ui-1": "Login UI updates" },
      threads: [{ id: "t-auth", title: "Core Auth", goal: "Ship JWT flow", tasks: ["api-1", "ui-1"] }],
    }),
  );

  writeFileSync(
    join(swarmDir, "view.json"),
    JSON.stringify({
      as_of_seq: 3,
      updated_at: "2026-11-25T09:02:10Z",
      headline: "API middleware ready; UI waiting on header contract",
      goal: { title: "Migrate auth to JWT", line: "Replace legacy cookie sessions across API and UI" },
      running_summary: "Two workers active; db-1 hit a quota limit.",
      phase: { label: "Implementation", index: 2, total: 4 },
      now: { "api-1": "Running integration tests", "ui-1": "Waiting for approval" },
      attention: [{ id: "n1", kind: "review", severity: "med", title: "Confirm token TTL", why: "Defaults to 15m", refs: [2] }],
      workstreams: [
        { id: "ws-api", title: "Backend JWT", owners: ["api-1"], state: "active", note: "Tests running", progress: { done: 2, total: 3 }, refs: [1, 2] },
      ],
      milestones: [{ title: "Middleware ready", state: "done", note: "Covered by unit tests" }],
      risks: [{ title: "Quota pressure on flash tier", severity: "high", note: "Switch db-1 model" }],
    }),
  );

  // Coordinator: waiting on swarm_wait
  writeJsonl(transcriptPath(dataDir, COORD_ID), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n/swarm migrate auth\n</USER_REQUEST>" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "swarm_wait", args: {} }] },
    { step_index: 2, type: "GENERIC", status: "DONE", content: "Waiting" },
  ]);

  // api-1: actively working with tool call
  writeJsonl(transcriptPath(dataDir, WORKER_A_ID), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nImplement JWT middleware\n</USER_REQUEST>" },
    {
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "RUNNING",
      thinking: "**Verifying token signatures**\nChecking key rotation.",
      tool_calls: [{ name: "edit_file", args: { Path: "/repo/src/auth.ts" } }],
    },
  ]);

  // ui-1: blocked awaiting approval
  writeJsonl(transcriptPath(dataDir, WORKER_B_ID), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nUpdate login screen\n</USER_REQUEST>" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }] },
    { step_index: 2, type: "GENERIC", status: "WAITING_FOR_USER", content: "Approval required" },
  ]);

  // db-1: hit 429 quota error
  writeJsonl(transcriptPath(dataDir, WORKER_C_ID), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nWrite DB migration\n</USER_REQUEST>" },
    { step_index: 1, type: "ERROR_MESSAGE", status: "ERROR", content: "HTTP 429 RESOURCE_EXHAUSTED: quota exceeded" },
  ]);

  // narrator: waiting
  writeJsonl(transcriptPath(dataDir, NARRATOR_ID), [
    { step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", content: "Updated view.json" },
  ]);

  return { swarmDir, shotPath };
}

const until = async (what: string, fn: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !fn(); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
  }
};

test("multi-line paste starting with `!` does NOT trigger Antigravity bash mode and sends as a normal prompt", async () => {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-bang-paste-"));
  const cwd = join(d, "proj");
  const dataDir = join(d, "agy-data");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "screen.txt"), IDLE_SCREEN);
  writeFileSync(
    join(d, "events.jsonl"),
    JSON.stringify({
      terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "idle" } }],
    }) + "\n",
  );
  writeJsonl(transcriptPath(dataDir, COORD_ID), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nhi\n</USER_REQUEST>" },
  ]);

  const io: AgyBindIO = {
    tree: (pid) => (pid === 4000 ? [4000, 4001] : [pid]),
    argv: (pid) => (pid === 4000 ? ["fish", "-ic", "agy"] : ["agy"]),
    cwd: () => cwd,
    env: (_p, n) => (n === "ANTIGRAVITY_CLI_DATA_DIR" ? dataDir : null),
    openFiles: (pids) => (pids.includes(4001) ? [join(dataDir, "presence", `${COORD_ID}.lock`)] : []),
    exists: existsSync,
    mtime: () => Date.now(),
  };

  const adapter = new AntigravityTerminalAdapter({ cwd, command: "agy", args: [], log: () => {}, terminal: "t5", hc, io, fetchModels: async () => [] });
  try {
    await adapter.start(null, { emit: () => {}, log: () => {}, running: false, working: false });

    // Multi-line pasted terminal output whose first line starts with ` ! python3 ...`
    const pastedBlock = [
      " ! python3 /tmp/inspect_swarm_schema.py",
      "=== AGY CLI ===",
      "$ agy --version (rc=0)",
      "1.5.16",
    ].join("\n");
    const res1 = await adapter.prompt({ id: "u-paste", text: pastedBlock, images: [], mode: "auto", busy: false });
    assert.equal(res1.disposition, "started");
    assert.equal(existsSync(join(d, "connect-called.txt")), false, "must NOT enter sendAgyBang for multi-line paste");

    // Single-line paste chip marked with `noBang: true` must also bypass bash mode.
    const res2 = await adapter.prompt({ id: "u-nobang", text: "! echo literal-pasted-line", images: [], mode: "auto", busy: false, noBang: true });
    assert.equal(res2.disposition, "started");
    assert.equal(existsSync(join(d, "connect-called.txt")), false, "must NOT enter sendAgyBang when noBang is true");

    const calls = readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.filter((c: any) => c[0] === "send").length, 2);
    assert.equal(calls[0].at(-1), pastedBlock);
    assert.equal(calls[1].at(-1), "! echo literal-pasted-line");

    // Defense-in-depth: sendAgyBang itself rejects multi-line commands immediately.
    await assert.rejects(
      sendAgyBang({ hc, terminal: "t5", command: "echo a\necho b" }),
      /Multi-line commands cannot run/,
    );
  } finally {
    adapter.kill();
    rmSync(d, { recursive: true, force: true });
  }
});

test("swarm reader, frame containment, action validation, and themed SVG graph renderer", () => {
  clearSwarmReaderCache();
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-swarm-reader-"));
  const dataDir = join(d, "agy-data");
  const imageDir = join(d, "images");
  try {
    const { shotPath } = buildSyntheticSwarm(dataDir);

    // Direct lookup from coordinator and reverse lookup from worker both work.
    const snap = readSwarmSnapshot(dataDir, COORD_ID);
    assert.ok(snap);
    assert.equal(snap.title, "Auth migration swarm");
    assert.equal(snap.me, "coordinator");
    assert.equal(snap.counts.working, 1);
    assert.equal(snap.counts.blocked, 1);
    assert.equal(snap.counts.waiting, 2); // coordinator + db-1 (errored)
    assert.equal(snap.counts.role_workers, 1); // narrator excluded from active counts
    assert.equal(snap.system_attention.some((a) => a.member === "ui-1" && a.kind === "approval"), true);
    assert.equal(snap.system_attention.some((a) => a.member === "db-1" && a.kind === "quota"), true);

    const fromWorker = readSwarmSnapshot(dataDir, WORKER_A_ID);
    assert.ok(fromWorker);
    assert.equal(fromWorker.coordinator_id, COORD_ID);
    assert.equal(fromWorker.me, "api-1");

    // Member transcript inspection
    const detail = readSwarmMemberTranscript(dataDir, COORD_ID, "api-1");
    assert.ok(detail);
    assert.equal(detail.member.status, "working");
    assert.equal(detail.member.activity, "Edit auth.ts");
    assert.ok(detail.events.some((e) => e.kind === "thinking" && e.text?.includes("Verifying token signatures")));
    assert.ok(detail.events.some((e) => e.kind === "tool" && e.tool_summary === "Edit auth.ts"));

    // Screenshot materialization & symlink escape protection
    materializeSwarmFrames(snap, dataDir, imageDir);
    assert.ok(snap.frames[0]?.local_path && existsSync(snap.frames[0].local_path));
    assert.equal(snap.messages[1]?.screenshots[0]?.local_path, snap.frames[0].local_path);
    assert.ok(resolveSwarmFrameFile(dataDir, COORD_ID, shotPath));

    const outside = join(d, "secret.png");
    writeFileSync(outside, PNG_BYTES);
    const evilLink = join(dataDir, "brain", WORKER_A_ID, "escape.png");
    symlinkSync(outside, evilLink);
    assert.equal(resolveSwarmFrameFile(dataDir, COORD_ID, evilLink), null);

    // Action validation + prompt generation
    assert.equal(buildSwarmActionPrompt(parseSwarmAction({ action: "start", task: "Audit auth" })), "/swarm Audit auth");
    assert.match(buildSwarmActionPrompt(parseSwarmAction({ action: "post", target: "api-1", channel: "backend", message: "Check TTL" })), /#backend for @api-1/);
    assert.equal(buildSwarmActionPrompt(parseSwarmAction({ action: "model", member: "coordinator", model: "gemini-2.5-pro" })), "/model gemini-2.5-pro");
    assert.match(buildSwarmActionPrompt(parseSwarmAction({ action: "kill", member: "db-1" })), /action:"kill", name:"db-1"/);
    assert.match(buildSwarmActionPrompt(parseSwarmAction({ action: "add", name: "qa-1", brief: "Write e2e tests", workspace: "share" })), /name:"qa-1", workspace:"share"/);
    assert.throws(() => parseSwarmAction({ action: "kill", member: "coordinator" }), /Cannot kill coordinator/);
    assert.throws(() => parseSwarmAction({ action: "add", name: "coordinator-2", brief: "nope" }), /reserved/);
    assert.throws(() => parseSwarmAction({ action: "post", target: "all", message: "bad\u0007bell" }), /Invalid message/);

    // Communication graph layout & themed SVG file output
    const directGraph = computeSwarmGraph(snap, { expandAll: false, hideInactive: false });
    assert.equal(directGraph.nodes.some((n) => n.name === "narrator"), false);
    assert.equal(directGraph.edges.some((e) => e.from === "api-1" && e.to === "coordinator"), true);
    const allGraph = computeSwarmGraph(snap, { expandAll: true, replaySeq: 1 });
    assert.equal(allGraph.activeMessage?.seq, 1);
    assert.equal(allGraph.edges.some((e) => e.from === "coordinator" && e.to === "db-1" && e.viaAll === 1), true);

    const svgRes = writeSwarmGraphSvg(snap, { expandAll: true }, DEFAULT_THEME, imageDir);
    assert.ok(svgRes.path && existsSync(svgRes.path));
    const svgText = readFileSync(svgRes.path, "utf8");
    assert.match(svgText, /<svg\b[^>]*viewBox="0 0 640 380"/);
    assert.match(svgText, /@coordinator/);
    assert.match(svgText, /@api-1/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("Chat + AntigravityTerminalAdapter stream live state.swarm, expose /swarm command, handle swarm ops, and never log bodies", async () => {
  clearSwarmReaderCache();
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-swarm-chat-"));
  const cwd = join(d, "proj");
  const dataDir = join(d, "agy-data");
  const imageDir = join(d, "images");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "screen.txt"), IDLE_SCREEN);
  writeFileSync(
    join(d, "events.jsonl"),
    JSON.stringify({
      terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "idle" } }],
    }) + "\n",
  );
  buildSyntheticSwarm(dataDir);
  writeJsonl(transcriptPath(dataDir, OTHER_CONV_ID), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nNo swarm here\n</USER_REQUEST>" },
  ]);

  let currentConv = COORD_ID;
  const io: AgyBindIO = {
    tree: (pid) => (pid === 4000 ? [4000, 4001] : [pid]),
    argv: (pid) => (pid === 4000 ? ["fish", "-ic", "agy"] : ["agy"]),
    cwd: () => cwd,
    env: (_p, n) => (n === "ANTIGRAVITY_CLI_DATA_DIR" ? dataDir : null),
    openFiles: (pids) => (pids.includes(4001) ? [join(dataDir, "presence", `${currentConv}.lock`)] : []),
    exists: existsSync,
    mtime: () => Date.now(),
  };

  const logs: string[] = [];
  const adapter = new AntigravityTerminalAdapter({
    cwd,
    command: "agy",
    args: [],
    log: (m) => logs.push(m),
    terminal: "t5",
    hc,
    io,
    imageDir,
    fetchModels: async () => [],
  });
  const chat = new Chat({
    chat: "c-swarm",
    cwd,
    session: null,
    adapter,
    terminal: null,
    imageDir,
    attachments: new Attachments(join(d, "att")),
    view: "t5",
    log: (m) => logs.push(m),
  });

  try {
    chat.start(null);
    await chat.whenReady(5000);
    await until("state.swarm populated", () => chat.state.swarm?.title === "Auth migration swarm");

    // `/swarm` is advertised in the slash command menu.
    assert.ok(chat.state.commands.some((c) => c.name === "swarm"));
    assert.ok(chat.state.swarm?.frames[0]?.local_path && existsSync(chat.state.swarm.frames[0].local_path));

    // `swarm_member` op returns bounded transcript.
    const memRes = (await chat.op("swarm_member", { member: "api-1", limit: 20 })) as any;
    assert.equal(memRes.detail?.member?.name, "api-1");
    assert.ok(memRes.detail?.events?.length >= 2);

    // `swarm_graph` op writes a themed SVG file into imageDir.
    const graphRes = (await chat.op("swarm_graph", { expandAll: true })) as any;
    assert.ok(graphRes.graph?.path && existsSync(graphRes.graph.path));

    // `swarm_action` sends sanitized prompt without logging the secret body text.
    const secret = "TOP_SECRET_STEERING_TOKEN_9911";
    const actRes = (await chat.op("swarm_action", { action: "post", target: "api-1", message: secret })) as any;
    assert.deepEqual(actRes, { ok: true, action: "post" });
    const calls = readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(calls.some((c: any) => c[0] === "send" && String(c.at(-1)).includes(secret)));
    assert.equal(logs.some((l) => l.includes(secret)), false, "must never log steering body text");
    assert.ok(logs.some((l) => l.includes("swarm action: post")));

    // Switching to a non-swarm conversation clears `state.swarm` back to null.
    currentConv = OTHER_CONV_ID;
    await until("state.swarm cleared on non-swarm session", () => chat.state.swarm === null);

    await chat.shutdown();
  } finally {
    adapter.kill();
    rmSync(d, { recursive: true, force: true });
  }
});

test("swarm-logic pure UI helpers summarize, filter, group, and step replay accurately", () => {
  clearSwarmReaderCache();
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-swarm-ui-"));
  const dataDir = join(d, "agy-data");
  try {
    buildSyntheticSwarm(dataDir);
    const snap = readSwarmSnapshot(dataDir, COORD_ID)!;

    const sum = swarmStatusSummary(snap)!;
    assert.equal(sum.title, "Auth migration swarm");
    assert.equal(sum.working, 1);
    assert.equal(sum.blocked, 1);
    assert.equal(sum.leadMember, "ui-1");

    assert.equal(filterSwarmMessages(snap, { channel: "backend" }).length, 1);
    assert.equal(filterSwarmMessages(snap, { sender: "ui-1" }).length, 1);
    assert.equal(filterSwarmMessages(snap, { search: "header name" }).length, 1);

    assert.equal(stripScreenshotLines("Hello\nScreenshot: /tmp/a.png | cap\nDone"), "Hello\nDone");
    assert.equal(stripScreenshotLines("Hello\n- Screenshot: `/tmp/a.png` | cap\nDone"), "Hello\nDone");
    assert.deepEqual(extractSeqRefs("See #1 and #2 and #999", 3), [1, 2]);

    const attn = collectAttention(snap);
    assert.equal(attn.length, 3);
    assert.equal(attn[0].severity, "high");

    const ws = collectWorkstreams(snap);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].id, "ws-api");

    const grp = groupSwarmMembers(snap);
    assert.deepEqual(grp.active.map((m: any) => m.name).sort(), ["api-1", "ui-1"]);
    assert.deepEqual(grp.roles.map((m: any) => m.name), ["narrator"]);

    assert.equal(nextReplaySeq([1, 2, 3], null, -1, 3), 2);
    assert.equal(nextReplaySeq([1, 2, 3], 2, -1, 3), 1);
    assert.equal(nextReplaySeq([1, 2, 3], 1, 1, 3), 2);
    assert.equal(nextReplaySeq([1, 2, 3], 2, 1, 3), null);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("swarm reader handles real Antigravity JSON-quoted args, step.error, view.json object refs/text items, bulleted screenshots, and wildcard channels", () => {
  clearSwarmReaderCache();
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-swarm-real-schema-"));
  const dataDir = join(d, "agy-data");
  try {
    const swarmDir = join(dataDir, "brain", COORD_ID, ".system_generated", "swarm");
    mkdirSync(swarmDir, { recursive: true });
    const workerShot = join(dataDir, "brain", WORKER_A_ID, "after.png");
    const coordExampleShot = join(dataDir, "brain", COORD_ID, "example.png");
    mkdirSync(dirname(workerShot), { recursive: true });
    writeFileSync(workerShot, PNG_BYTES);
    writeFileSync(coordExampleShot, PNG_BYTES);

    writeFileSync(
      join(swarmDir, "members.json"),
      JSON.stringify({
        title: "Real AGY format",
        members: {
          coordinator: {
            conversation_id: COORD_ID,
            model: "gemini-2.5-pro",
            role: "coordinator",
            wake_mode: "mentions",
            last_read_seq: 1,
            killed: false,
            channels: ["*"],
          },
          "api-1": {
            conversation_id: WORKER_A_ID,
            model: "gemini-2.5-pro",
            role: "worker",
            wake_mode: "working",
            last_read_seq: 1,
            killed: false,
            channels: ["main", "ui"],
          },
          "db-1": {
            conversation_id: WORKER_C_ID,
            model: "gemini-2.5-flash",
            role: "worker",
            wake_mode: "working",
            last_read_seq: 0,
            killed: false,
          },
          "narrator-1": {
            conversation_id: NARRATOR_ID,
            model: "gemini-2.5-flash",
            role: "narrator",
            wake_mode: "anything",
            last_read_seq: 3,
            killed: false,
          },
        },
      }),
    );

    writeJsonl(transcriptPath(dataDir, WORKER_A_ID), [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "edit_file", args: { Path: JSON.stringify("/repo/src/panel.tsx") } }],
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "RUNNING",
        thinking: "continuing without bold heading",
        tool_calls: [],
      },
    ]);

    writeJsonl(transcriptPath(dataDir, WORKER_C_ID), [
      {
        step_index: 0,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "code_search", args: { Query: JSON.stringify("swarm_wait") } }],
      },
      {
        step_index: 1,
        type: "ERROR_MESSAGE",
        status: "ERROR",
        content: "",
        error: "429 RESOURCE_EXHAUSTED: exhausted your capacity",
      },
    ]);

    writeJsonl(transcriptPath(dataDir, COORD_ID), [
      { step_index: 0, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "post_message", args: { message: JSON.stringify("hi") } }] },
    ]);

    writeJsonl(join(swarmDir, "board.jsonl"), [
      {
        seq: 1,
        agent: "coordinator",
        text: `Brief: report progress using\nScreenshot: ${coordExampleShot} | template`,
        time: "2026-11-24 10:00:00",
        channel: "main",
      },
      {
        seq: 2,
        agent: "coordinator",
        text: "Created #ui",
        time: "2026-11-24 10:01:00",
        channel: "ui",
        control: { op: "create", channel: "ui", topic: "UI", members: ["api-1"] },
      },
      {
        seq: 3,
        agent: "api-1",
        text: `@#ui updated card\n- Screenshot: \`${workerShot}\` | After polish`,
        time: "2026-11-24 10:02:00",
        channel: "ui",
      },
    ]);

    writeFileSync(
      join(swarmDir, "view.json"),
      JSON.stringify({
        version: 1,
        as_of_seq: 3,
        updated_at: "2026-11-24T10:02:10Z",
        headline: "UI polish complete",
        attention: [
          {
            id: "a1",
            kind: "review",
            severity: "high",
            title: "Verify UI screenshot",
            why: "api-1 posted final capture",
            refs: [{ seq: 3 }, { member: "api-1" }],
            actions: [
              { type: "open_conv", target: "api-1", label: "Inspect api-1" },
              { type: "board_post", target: 3, label: "Jump #3" },
            ],
          },
        ],
        workstreams: [
          { id: "w1", title: "UI pass", owners: ["api-1"], state: "review", note: "Ready", refs: [{ seq: 3 }] },
        ],
        milestones: [{ id: "m1", text: "Card polish landed", refs: [{ seq: 3 }] }],
        risks: [{ id: "r1", text: "db-1 rate limited", refs: [{ member: "db-1" }] }],
      }),
    );

    const snap = readSwarmSnapshot(dataDir, COORD_ID);
    assert.ok(snap);
    const byName = new Map(snap.members.map((m) => [m.name, m]));

    assert.equal(byName.get("api-1")?.activity, "Edit panel.tsx");
    assert.equal(byName.get("coordinator")?.activity, "Posting to board");
    assert.equal(byName.get("coordinator")?.unread, 1);
    assert.equal(byName.get("db-1")?.failure?.kind, "quota");
    assert.match(byName.get("db-1")?.failure?.message ?? "", /RESOURCE_EXHAUSTED/);

    const tr = readSwarmMemberTranscript(dataDir, COORD_ID, "db-1");
    assert.equal(tr?.events.find((e) => e.kind === "tool")?.tool_summary, "Search swarm_wait");
    assert.match(tr?.events.find((e) => e.kind === "error")?.text ?? "", /RESOURCE_EXHAUSTED/);

    assert.deepEqual(snap.frames.map((f) => f.path), [workerShot]);
    assert.equal(snap.frames[0]?.caption, "After polish");

    assert.deepEqual(snap.narrator.attention[0]?.refs, [3]);
    assert.equal(snap.narrator.attention[0]?.member, "api-1");
    assert.deepEqual(snap.narrator.attention[0]?.actions, [
      { kind: "open_member", label: "Inspect api-1", member: "api-1" },
      { kind: "jump_seq", label: "Jump #3", seq: 3 },
    ]);
    assert.deepEqual(snap.narrator.workstreams[0]?.refs, [3]);
    assert.deepEqual(snap.narrator.milestones, [{ title: "Card polish landed", state: "done", note: "" }]);
    assert.deepEqual(snap.narrator.risks, [{ title: "db-1 rate limited", severity: "med", note: "" }]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
