// Antigravity CLI artifact tracking, screen detection, UI review logic, and
// end-to-end Chat View approval/rejection/dismissal (synthetic fixtures only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgyArtifactTracker,
  artifactBrainDir,
  formatArtifactReviewSubmission,
  parseArtifactDecisionLine,
  parseArtifactReviewRequest,
  resolveArtifactPath,
} from "../../host/providers/antigravity/artifacts.ts";
import { readAgyArtifactReview } from "../../host/providers/antigravity/screen.ts";
import { AntigravityTerminalAdapter } from "../../host/providers/antigravity/terminal.ts";
import { transcriptPath } from "../../host/providers/antigravity/bind.ts";
import type { AgyBindIO } from "../../host/providers/antigravity/bind.ts";
import { parseModelsOutput } from "../../host/providers/antigravity/models.ts";
import { Chat } from "../../host/chat.ts";
import { Attachments } from "../../host/attachments.ts";
// @ts-ignore — plain JS mod helper tested directly in Node
import { artifactChoices, artifactShortName, artifactShortcutAnswer, artifactStatusLabel, artifactStatusTone, formatArtifactBytes, pendingArtifactsOf, pickActiveArtifact } from "../../herdr-app/mods/chat/artifact-logic.js";

process.env.HERDR_CHAT_ASK_MS = "40";
process.env.HERDR_CHAT_TAIL_MS = "30";
process.env.HERDR_CHAT_SESSION_MS = "200";

type Rec = Record<string, any>;

const CONV = "11111111-2222-3333-4444-555555555555";
const CATALOG = parseModelsOutput(`gemini-4-neon-xhigh  Gemini 4 Neon (XHigh)\n`);

const IDLE_SCREEN = [
  "────────────────────────────────────────────────────────────────────────",
  "> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)",
  "────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                               auto · Gemini 4 Neon · xhigh",
].join("\n");

const BANNER_SCREEN = (n: number) => [
  "Created the migration plan for your review.",
  "",
  `${n} ${n === 1 ? "artifact" : "artifacts"} · /artifact to review`,
  "────────────────────────────────────────────────────────────────────────",
  ">",
  "────────────────────────────────────────────────────────────────────────",
  "? for shortcuts                               auto · Gemini 4 Neon · xhigh",
].join("\n");

const PANEL_SCREEN = [
  "Action required (2 left)",
  "────────────────────────────────────────────────────────────────────────",
  "▸ plan.md        open   approve   reject",
  "  schema.md      open   approve   reject",
  "",
  "  Submit   Dismiss",
  "↑/↓ Navigate · a Approve · r Reject · A Approve all · esc Close",
].join("\n");

const DETAIL_SCREEN = [
  "plan.md",
  "────────────────────────────────────────────────────────────────────────",
  "# Migration Plan",
  "1. Update schema",
  "2. Backfill records",
  "────────────────────────────────────────────────────────────────────────",
  "c Comment · e Open in Editor · enter send + close · esc discard + close",
].join("\n");

const COMMAND_PERM_SCREEN = [
  "────────────────────────────────────────────────────────────────────────",
  "Requesting permission for: rm -rf tmp-cache",
  "",
  "Run this command?",
  "> 1. Yes, run command",
  "  2. No, cancel",
  "  ↑/↓ Navigate · enter Confirm · esc Cancel",
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
  setInterval(pump, 15);
} else if (cmd === "read") {
  let text = "";
  try { text = fs.readFileSync(dir + "/screen.txt", "utf8"); } catch {}
  process.stdout.write(JSON.stringify({ complete: true, how: "screen", text }) + "\\n");
} else {
  fs.appendFileSync(dir + "/calls.jsonl", JSON.stringify([cmd, ...rest]) + "\\n");
  if (cmd === "keys" && rest.includes("esc") && fs.existsSync(dir + "/esc-screen.txt")) {
    fs.writeFileSync(dir + "/screen.txt", fs.readFileSync(dir + "/esc-screen.txt", "utf8"));
  }
  process.stdout.write("{}\\n");
}
`;

function rig() {
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-agy-art-"));
  const cwd = join(d, "proj");
  const dataDir = join(d, "agy-data");
  const brainDir = artifactBrainDir(dataDir, CONV);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(brainDir, { recursive: true });
  const hc = join(d, "hc");
  writeFileSync(hc, FAKE_HC(d));
  chmodSync(hc, 0o755);
  writeFileSync(join(d, "events.jsonl"), "");
  writeFileSync(join(d, "screen.txt"), IDLE_SCREEN);

  const io: AgyBindIO = {
    tree: (pid) => (pid === 5000 ? [5000, 5001] : [pid]),
    argv: (pid) => (pid === 5000 ? ["fish", "-ic", "agy"] : ["agy"]),
    cwd: () => cwd,
    env: (_p, n) => (n === "ANTIGRAVITY_CLI_DATA_DIR" ? dataDir : null),
    openFiles: (pids) => (pids.includes(5001) ? [join(dataDir, "presence", `${CONV}.lock`)] : []),
    exists: existsSync,
    mtime: () => Date.now(),
  };

  const file = transcriptPath(dataDir, CONV);
  const writeTranscript = (recs: Rec[]) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, recs.map((r) => JSON.stringify(r) + "\n").join(""));
  };
  const writeArtifact = (rel: string, md: string, summary?: string) => {
    const abs = join(brainDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, md, "utf8");
    if (summary) {
      writeFileSync(`${abs}.metadata.json`, JSON.stringify({ summary, updatedAt: new Date().toISOString() }), "utf8");
    }
    return abs;
  };
  const event = (m: Rec) => appendFileSync(join(d, "events.jsonl"), JSON.stringify(m) + "\n");
  const status = (state: string | null, extra: Rec = {}) =>
    event({ method: "event", params: { type: "status", terminal: "t5", data: { status: state ? { app: "antigravity", state, ...extra } : null } } });
  const screen = (text: string) => writeFileSync(join(d, "screen.txt"), text);
  const onEscScreen = (text: string) => writeFileSync(join(d, "esc-screen.txt"), text);
  const calls = (): string[][] =>
    existsSync(join(d, "calls.jsonl")) ? readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];

  const adapter = new AntigravityTerminalAdapter({
    cwd,
    command: "agy",
    args: [],
    log: () => {},
    terminal: "t5",
    hc,
    io,
    fetchModels: async () => CATALOG,
  });
  const chat = new Chat({
    chat: "c-art",
    cwd,
    session: null,
    adapter,
    terminal: null,
    attachments: new Attachments(join(d, "att")),
    view: "t5",
    log: () => {},
  });

  const done = async () => {
    await chat.shutdown();
    rmSync(d, { recursive: true, force: true });
  };
  return { d, cwd, dataDir, brainDir, writeTranscript, writeArtifact, event, status, screen, onEscScreen, calls, adapter, chat, done };
}

const until = async (what: string, f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
  }
};

test("resolveArtifactPath, parseArtifactDecisionLine, AgyArtifactTracker, and submission formatting", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-art-unit-"));
  try {
    const brain = artifactBrainDir(dir, CONV);
    mkdirSync(join(brain, "scratch"), { recursive: true });
    mkdirSync(join(brain, ".system_generated", "logs"), { recursive: true });
    mkdirSync(join(brain, "specs"), { recursive: true });

    // Path safety and filtering.
    assert.deepEqual(resolveArtifactPath(brain, join(brain, "plan.md")), { name: "plan.md", path: join(brain, "plan.md") });
    assert.deepEqual(resolveArtifactPath(brain, `file://${join(brain, "specs", "api.md")}`), { name: "specs/api.md", path: join(brain, "specs", "api.md") });
    assert.equal(resolveArtifactPath(brain, join(brain, "scratch", "tmp.md")), null);
    assert.equal(resolveArtifactPath(brain, join(brain, ".system_generated", "logs", "transcript.jsonl")), null);
    assert.equal(resolveArtifactPath(brain, join(brain, "plan.md.metadata.json")), null);
    assert.equal(resolveArtifactPath(brain, join(brain, "..", "other.md")), null);
    assert.equal(resolveArtifactPath(brain, "../../etc/passwd"), null);

    // Decision line parsing.
    assert.deepEqual(parseArtifactDecisionLine("[Approved] plan.md"), { status: "approved", name: "plan.md" });
    assert.deepEqual(parseArtifactDecisionLine("  [Rejected] `specs/api.md`  "), { status: "rejected", name: "specs/api.md" });
    assert.equal(parseArtifactDecisionLine("[Approved] "), null);
    assert.equal(parseArtifactDecisionLine("Approved plan.md"), null);

    // Write synthetic files on disk.
    const planPath = join(brain, "plan.md");
    writeFileSync(planPath, "# Plan\n\n- Step 1\n- Step 2\n", "utf8");
    writeFileSync(`${planPath}.metadata.json`, JSON.stringify({ summary: "Synthetic plan summary" }), "utf8");
    writeFileSync(join(brain, "scratch", "ignore.md"), "scratch", "utf8");
    writeFileSync(join(brain, "extra.md"), "# Extra\n", "utf8");

    const tracker = new AgyArtifactTracker(dir, CONV);
    assert.equal(
      tracker.feed({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-27T01:00:00Z",
        tool_calls: [{
          name: "write_file",
          args: {
            Path: JSON.stringify(planPath),
            ArtifactMetadata: JSON.stringify({ RequestFeedback: true, Summary: "Initial rollout plan" }),
          },
        }],
      }),
      true,
    );
    assert.deepEqual(tracker.summaryList().map((a) => [a.name, a.status, a.summary]), [
      ["plan.md", "pending", "Initial rollout plan"],
    ]);

    // Approving flips status to approved.
    assert.equal(
      tracker.feed({
        step_index: 2,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\n[Approved] plan.md\n</USER_REQUEST>",
      }),
      true,
    );
    assert.equal(tracker.summaryList()[0]!.status, "approved");

    // Re-editing the artifact flips it back to pending.
    assert.equal(
      tracker.feed({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-27T01:05:00Z",
        tool_calls: [{ name: "edit_file", args: { Path: JSON.stringify(planPath) } }],
      }),
      true,
    );
    assert.equal(tracker.summaryList()[0]!.status, "pending");

    // scanDisk discovers untracked extra.md and promotes it when expectedPendingCount > 1.
    tracker.scanDisk(2);
    const list = tracker.summaryList();
    assert.equal(list.some((a) => a.name === "scratch/ignore.md"), false);
    assert.deepEqual(list.map((a) => [a.name, a.status]).sort(), [
      ["extra.md", "pending"],
      ["plan.md", "pending"],
    ]);

    // Bounded read + traversal rejection.
    const small = tracker.readArtifact("plan.md", 10);
    assert.ok(small);
    assert.equal(small!.content, "# Plan\n\n- ");
    assert.equal(small!.truncated, true);
    assert.equal(tracker.readArtifact("../escape.md"), null);

    // Formatting & validation.
    assert.equal(formatArtifactReviewSubmission({ action: "approve", artifact: "plan.md" }, ["plan.md"]), "[Approved] plan.md");
    assert.equal(
      formatArtifactReviewSubmission({ action: "approve", artifact: "plan.md", message: "Keep tests fast" }, ["plan.md"]),
      "[Approved] plan.md\n\nKeep tests fast",
    );
    assert.equal(
      formatArtifactReviewSubmission({ action: "approve_all", message: "Looks good" }, ["plan.md", "extra.md"]),
      "[Approved] plan.md\n[Approved] extra.md\n\nLooks good",
    );
    assert.equal(
      formatArtifactReviewSubmission({ action: "reject", artifact: "plan.md", message: "Revise step 2" }, ["plan.md"]),
      "[Rejected] plan.md\n\nRevise step 2",
    );
    assert.equal(
      formatArtifactReviewSubmission({ action: "comment", artifact: "plan.md", message: "What about rollback?" }, ["plan.md"]),
      "Comments on plan.md:\n\nWhat about rollback?",
    );
    assert.throws(() => parseArtifactReviewRequest({ action: "comment", artifact: "plan.md", message: "  " }), /comment/i);
    assert.throws(() => parseArtifactReviewRequest({ action: "bogus" }), /Unknown artifact review action/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAgyArtifactReview detects banner, open /artifact panel, and detail view while rejecting prose/idle", () => {
  assert.deepEqual(readAgyArtifactReview(BANNER_SCREEN(1)), { surface: "banner", pendingCount: 1, names: [] });
  assert.deepEqual(readAgyArtifactReview(BANNER_SCREEN(3)), { surface: "banner", pendingCount: 3, names: [] });
  assert.deepEqual(readAgyArtifactReview(PANEL_SCREEN), { surface: "panel", pendingCount: 2, names: ["plan.md", "schema.md"] });
  assert.deepEqual(readAgyArtifactReview(DETAIL_SCREEN), { surface: "detail", pendingCount: null, names: ["plan.md"] });

  const ctrlR = [
    "Press ctrl+r to review pending artifacts.",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.deepEqual(readAgyArtifactReview(ctrlR), { surface: "banner", pendingCount: null, names: [] });

  // False-positive guards: normal idle screen, command permission dialog, user-typed line, and distant scrollback.
  assert.equal(readAgyArtifactReview(IDLE_SCREEN), null);
  assert.equal(readAgyArtifactReview(COMMAND_PERM_SCREEN), null);
  assert.equal(
    readAgyArtifactReview([
      "────────────────────────────────────────────────────────────────────────",
      "> 1 artifact · /artifact to review",
      "────────────────────────────────────────────────────────────────────────",
      "? for shortcuts                               auto · Gemini 4 Neon · xhigh",
    ].join("\n")),
    null,
  );
  const oldProse = [
    "Earlier note: 1 artifact · /artifact to review is a banner.",
    ...Array.from({ length: 18 }, (_, i) => `Reply line ${i + 1}`),
    IDLE_SCREEN,
  ].join("\n");
  assert.equal(readAgyArtifactReview(oldProse), null);
});

test("artifact-logic.js computes choices, keyboard shortcuts, badges, and byte labels", () => {
  const one = [{ name: "plan.md", path: "/b/plan.md", status: "pending" as const, sizeBytes: 1536 }];
  const two = [
    { name: "plan.md", path: "/b/plan.md", status: "pending" as const },
    { name: "sub/api-design.md", path: "/b/sub/api-design.md", status: "pending" as const },
  ];

  assert.equal(pendingArtifactsOf(two).length, 2);
  assert.equal(pickActiveArtifact(two, "missing.md")?.name, "plan.md");
  assert.equal(pickActiveArtifact(two, "sub/api-design.md")?.name, "sub/api-design.md");
  assert.equal(artifactShortName("sub/api-design.md"), "api-design.md");
  assert.equal(formatArtifactBytes(512), "512 B");
  assert.equal(formatArtifactBytes(1536), "1.5 KB");
  assert.equal(artifactStatusLabel("approved"), "Approved");
  assert.equal(artifactStatusLabel("rejected"), "Changes requested");
  assert.equal(artifactStatusTone("pending", { blocked: "#f0a", ansi2: "#0f0", ansi1: "#f00" }), "#f0a");

  assert.deepEqual(artifactChoices(one, "plan.md", false).map((c: Rec) => [c.key, c.action, c.label]), [
    [1, "approve", "Approve"],
    [2, "reject", "Reject"],
  ]);
  assert.deepEqual(artifactChoices(one, "plan.md", true).map((c: Rec) => [c.key, c.action, c.label]), [
    [1, "approve", "Approve with note"],
    [2, "reject", "Request changes"],
    [3, "comment", "Comment only"],
  ]);
  assert.deepEqual(artifactChoices(two, "plan.md", false).map((c: Rec) => [c.key, c.action]), [
    [1, "approve_all"],
    [2, "approve"],
    [3, "reject"],
  ]);

  assert.deepEqual(artifactShortcutAnswer("enter", one, "plan.md", ""), { artifactAction: "approve", artifact: "plan.md" });
  assert.deepEqual(artifactShortcutAnswer(2, one, "plan.md", "Fix step 3"), { artifactAction: "reject", artifact: "plan.md", message: "Fix step 3" });
  assert.deepEqual(artifactShortcutAnswer("escape", one, "plan.md", ""), { artifactAction: "dismiss" });
  assert.deepEqual(artifactShortcutAnswer("enter", two, "plan.md", ""), { artifactAction: "approve_all" });
});

test("end-to-end Antigravity artifact review: surfaces Markdown card, rejects with feedback, approves, and never blocks chat", async () => {
  const r = rig();
  try {
    const planPath = r.writeArtifact("plan.md", "# Rollout Plan\n\n1. Add feature\n2. Verify tests\n", "Two-step rollout plan");
    r.writeTranscript([
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nDraft a rollout plan\n</USER_REQUEST>" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-27T01:00:00Z",
        model: "gemini-4-neon-xhigh",
        tool_calls: [{
          name: "write_file",
          args: { Path: JSON.stringify(planPath), ArtifactMetadata: JSON.stringify({ RequestFeedback: true, Summary: "Two-step rollout plan" }) },
        }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "Created file." },
      { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: "Please review the plan." },
    ]);
    r.screen(BANNER_SCREEN(1));
    r.event({
      terminals: [{
        address: "t5",
        state: "live",
        foreground: { pid: 5000, name: "fish", argv: ["fish", "-ic", "agy"] },
        status: { app: "antigravity", state: "blocked", kind: "permission", message: "Approve plan" },
      }],
    });

    r.chat.start(null);
    await r.chat.whenReady(5000);
    await until("artifact review dialog opened", () => r.chat.state.dialog?.method === "artifact");

    const dlg = r.chat.state.dialog!;
    assert.equal(dlg.method, "artifact");
    assert.equal(dlg.title, "Review plan.md");
    assert.equal(dlg.artifacts.length, 1);
    assert.equal(dlg.artifacts[0]!.name, "plan.md");
    assert.equal(dlg.artifacts[0]!.summary, "Two-step rollout plan");
    assert.match(dlg.artifacts[0]!.content ?? "", /# Rollout Plan/);
    // ChatState.artifacts stays lightweight (no content field).
    assert.equal(r.chat.state.artifacts.length, 1);
    assert.equal(r.chat.state.artifacts[0]!.content, undefined);

    // On-demand artifact_read returns full content.
    const readRes = (await r.chat.op("artifact_read", { name: "plan.md" })) as { artifact: { name: string; content: string } };
    assert.equal(readRes.artifact.name, "plan.md");
    assert.match(readRes.artifact.content, /Verify tests/);

    // Request changes with feedback via dialog_answer.
    await r.chat.op("dialog_answer", {
      dialog: dlg.id,
      artifactAction: "reject",
      artifact: "plan.md",
      message: "Add a rollback checklist",
    });
    await until("rejected review sent with --force", () =>
      r.calls().some((c) => c[0] === "send" && c.includes("--force") && c.at(-1) === "[Rejected] plan.md\n\nAdd a rollback checklist"),
    );
    assert.equal(r.chat.state.dialog, null);
    assert.equal(r.chat.state.artifacts[0]!.status, "rejected");

    // Agent revises plan.md in a new turn and asks for approval again.
    r.status("working");
    r.writeArtifact("plan.md", "# Rollout Plan v2\n\n1. Add feature\n2. Verify tests\n3. Rollback checklist\n", "Updated with rollback");
    r.writeTranscript([
      { step_index: 4, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\n[Rejected] plan.md\n\nAdd a rollback checklist\n</USER_REQUEST>" },
      {
        step_index: 5,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-27T01:02:00Z",
        model: "gemini-4-neon-xhigh",
        tool_calls: [{ name: "edit_file", args: { Path: JSON.stringify(planPath) } }],
      },
      { step_index: 6, type: "GENERIC", status: "DONE", content: "Edited file." },
      { step_index: 7, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: "Updated the plan." },
    ]);
    r.status("blocked", { kind: "permission", message: "Approve plan" });
    await until("updated artifact dialog opened", () =>
      r.chat.state.dialog?.method === "artifact" && Boolean(r.chat.state.dialog.artifacts[0]?.content?.includes("Rollback checklist")),
    );

    // Approve the revised plan!
    await r.chat.op("dialog_answer", {
      dialog: r.chat.state.dialog!.id,
      artifactAction: "approve",
      artifact: "plan.md",
    });
    await until("approved review sent with --force", () =>
      r.calls().some((c) => c[0] === "send" && c.includes("--force") && c.at(-1) === "[Approved] plan.md"),
    );
    assert.equal(r.chat.state.dialog, null);
    assert.equal(r.chat.state.artifacts[0]!.status, "approved");
  } finally {
    await r.done();
  }
});

test("end-to-end multi-artifact review: closes open /artifact panel on dismiss, unblocks normal chat sends, and approves all", async () => {
  const r = rig();
  try {
    const p1 = r.writeArtifact("plan.md", "# Plan\n");
    const p2 = r.writeArtifact("schema.md", "# Schema\n");
    r.writeTranscript([
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nCreate plan and schema\n</USER_REQUEST>" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-27T02:00:00Z",
        model: "gemini-4-neon-xhigh",
        tool_calls: [
          { name: "write_file", args: { Path: JSON.stringify(p1), ArtifactMetadata: JSON.stringify({ RequestFeedback: true }) } },
          { name: "write_file", args: { Path: JSON.stringify(p2), ArtifactMetadata: JSON.stringify({ RequestFeedback: true }) } },
        ],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "Created." },
      { step_index: 3, type: "GENERIC", status: "DONE", content: "Created." },
      { step_index: 4, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-4-neon-xhigh", content: "Both artifacts ready." },
    ]);
    // Terminal currently has `/artifact` panel open; pressing Esc returns to the banner prompt.
    r.screen(PANEL_SCREEN);
    r.onEscScreen(BANNER_SCREEN(2));
    r.event({
      terminals: [{
        address: "t5",
        state: "live",
        foreground: { pid: 5000, name: "fish", argv: ["fish", "-ic", "agy"] },
        status: { app: "antigravity", state: "blocked", kind: "permission", message: "Approve plan" },
      }],
    });

    r.chat.start(null);
    await r.chat.whenReady(5000);
    await until("multi-artifact dialog opened", () => r.chat.state.dialog?.method === "artifact" && r.chat.state.dialog.artifacts.length === 2);
    assert.equal(r.chat.state.dialog!.title, "Review 2 artifacts");

    // Dismissing closes the open `/artifact` overlay with Esc, settles chat to idle, and keeps pending artifacts in state.artifacts.
    await r.chat.op("dialog_answer", { dialog: r.chat.state.dialog!.id, cancelled: true });
    await until("Esc sent to close /artifact overlay and chat settled to idle", () =>
      r.calls().some((c) => c[0] === "keys" && c.includes("esc")) && r.chat.state.phase === "idle",
    );
    assert.equal(r.chat.state.dialog, null);
    assert.equal(r.chat.state.artifacts.filter((a) => a.status === "pending").length, 2);

    // Sending a normal follow-up message while still in `Approve plan` blocked state succeeds via --force!
    const sent = (await r.chat.op("send", { text: "Quick question about schema.md?" })) as { disposition: string };
    assert.equal(sent.disposition, "started");
    assert.ok(
      r.calls().some((c) => c[0] === "send" && c.includes("--force") && c.at(-1) === "Quick question about schema.md?"),
      "normal message should bypass artifact-only block using --force",
    );

    // Approve all via the `artifact_review` RPC (from the Artifact strip / `/artifact` modal).
    await r.chat.op("artifact_review", { action: "approve_all", message: "Proceed with both" });
    const approveCall = r.calls().find((c) => c[0] === "send" && c.includes("--force") && String(c.at(-1)).includes("[Approved] plan.md"));
    assert.ok(approveCall, "approve_all call sent");
    assert.ok(String(approveCall!.at(-1)).includes("[Approved] schema.md"));
    assert.ok(String(approveCall!.at(-1)).endsWith("\n\nProceed with both"));
    assert.equal(r.chat.state.artifacts.every((a) => a.status === "approved"), true);
  } finally {
    await r.done();
  }
});

test("real command permission dialog takes priority over artifact state and still blocks normal chat sends", async () => {
  const r = rig();
  try {
    const p1 = r.writeArtifact("plan.md", "# Plan\n");
    r.writeTranscript([
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nRun cleanup\n</USER_REQUEST>" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-neon-xhigh",
        tool_calls: [{ name: "write_file", args: { Path: JSON.stringify(p1), ArtifactMetadata: JSON.stringify({ RequestFeedback: true }) } }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "Created." },
    ]);
    r.screen(COMMAND_PERM_SCREEN);
    r.event({
      terminals: [{
        address: "t5",
        state: "live",
        foreground: { pid: 5000, name: "fish", argv: ["fish", "-ic", "agy"] },
        status: { app: "antigravity", state: "blocked", kind: "permission", message: "Approve command" },
      }],
    });

    r.chat.start(null);
    await r.chat.whenReady(5000);
    await until("command permission dialog opened", () => r.chat.state.dialog?.method === "permission");
    assert.equal(r.chat.state.dialog!.title, "Run this command?");

    // Normal send MUST still be rejected while a real command permission is open!
    await assert.rejects(() => r.chat.op("send", { text: "ignore the prompt" }), /answer its card above the composer first/i);
  } finally {
    await r.done();
  }
});
