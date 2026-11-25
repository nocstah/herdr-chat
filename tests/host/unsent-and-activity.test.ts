// Unit tests for:
// 1. Retained unsent/rejected messages (unsent.js helpers + late Chat sink sendRejected).
// 2. Activity log timer collapsing & real command enrichment (chat.ts mergeActivityLog,
//    antigravity/screen.ts readAgyRunningCommand, and live AntigravityTerminalAdapter polling).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Chat, activityElapsed, activityStem, mergeActivityLog } from "../../host/chat.ts";
import type { ActivityEntry } from "../../host/chat.ts";
import { Attachments } from "../../host/attachments.ts";
import { AntigravityTerminalAdapter } from "../../host/providers/antigravity/terminal.ts";
import { transcriptPath } from "../../host/providers/antigravity/bind.ts";
import type { AgyBindIO } from "../../host/providers/antigravity/bind.ts";
import { readAgyRunningCommand } from "../../host/providers/antigravity/screen.ts";
import {
  cleanRejectionReason,
  failedSendSummary,
  mergeDraftIntoComposer,
  removeFailedSend,
  retainFailedSend,
  // @ts-expect-error plain JS module of the mod
} from "../../herdr-app/mods/chat/unsent.js";

const CONV_ID = "11111111-1111-4111-8111-111111111111";

const until = async (what: string, fn: () => boolean, ms = 4000) => {
  for (const t0 = Date.now(); !fn(); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
  }
};

test("unsent.js retains rejected drafts with chips, merges back into composer, and formats clean previews", () => {
  assert.equal(
    cleanRejectionReason("send: Antigravity rejected the message: Antigravity is asking something: answer its card above the composer first, then send."),
    "Antigravity is asking something: answer its card above the composer first, then send.",
  );

  const draft = {
    id: "s-1",
    rawText: "Please deploy after checking the diff.\nLine 2\nLine 3\nLine 4\nLine 5",
    text: "Please deploy after checking the diff.\nLine 2\nLine 3\nLine 4\nLine 5",
    chips: [
      { kind: "paste", id: "p1", text: "big log", mode: "file", path: "/tmp/p1.txt" },
      { kind: "image", path: "/tmp/shot.png", label: "shot.png" },
    ],
    images: ["/tmp/shot.png"],
    files: [],
    pastes: [{ kind: "paste", id: "p1", text: "big log", mode: "file", path: "/tmp/p1.txt" }],
    mode: "auto",
  };

  let list = retainFailedSend([], draft, "Antigravity is asking something: answer its card above the composer first, then send.");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "s-1");
  assert.equal(list[0].chips.length, 2);

  // Re-failing the same draft id updates reason in place without duplicating it.
  list = retainFailedSend(list, draft, "Still waiting on dialog");
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "Still waiting on dialog");

  const summary = failedSendSummary(list[0]);
  assert.equal(summary.truncated, true);
  assert.match(summary.preview, /Line 4…$/);
  assert.deepEqual(summary.attachments, ["1 paste", "1 image"]);

  // Editing into a composer that already has a partial draft preserves both text and chips.
  const merged = mergeDraftIntoComposer("Wait also check", [{ kind: "file", path: "/tmp/a.ts" }], list[0]);
  assert.equal(merged.text, `Wait also check\n\n${draft.rawText}`);
  assert.equal(merged.chips.length, 3);

  assert.deepEqual(removeFailedSend(list, "s-1"), []);
});

test("mergeActivityLog collapses ticking elapsed timers, preserves timer resets, and pairs command updates onto tool rows", () => {
  assert.deepEqual(activityElapsed("Running command... 12s"), { label: "12s", seconds: 12 });
  assert.deepEqual(activityElapsed("$ npm test · 1m 5s"), { label: "1m 5s", seconds: 65 });
  assert.equal(activityStem("Running command... 12s"), "Running command");
  assert.equal(activityStem("$ git push origin main · 7s"), "$ git push origin main");

  // Generic "Running command... 7s -> 8s -> 16s" collapses to 1 row, then 16s -> 1s appends a new row.
  let log: ActivityEntry[] = [];
  for (const s of [7, 8, 9, 16]) {
    log = mergeActivityLog(log, `Running command... ${s}s`, "status", 1000 + s * 1000) ?? log;
  }
  assert.equal(log.length, 1);
  assert.equal(log[0]!.text, "Running command... 16s");
  assert.equal(log[0]!.ts, 8000); // kept original start timestamp

  log = mergeActivityLog(log, "Running command... 1s", "status", 20000) ?? log;
  assert.equal(log.length, 2);
  assert.equal(log[1]!.text, "Running command... 1s");

  // Tool row `$ git push origin main` absorbs ticking status updates into ONE tool row.
  let toolLog: ActivityEntry[] = [];
  toolLog = mergeActivityLog(toolLog, "$ git push origin main", "tool", 5000) ?? toolLog;
  toolLog = mergeActivityLog(toolLog, "$ git push origin main · Push OmaRelay · 1s", "status", 6000) ?? toolLog;
  toolLog = mergeActivityLog(toolLog, "$ git push origin main · Push OmaRelay · 9s", "status", 14000) ?? toolLog;
  assert.equal(toolLog.length, 1);
  assert.equal(toolLog[0]!.kind, "tool");
  assert.equal(toolLog[0]!.text, "$ git push origin main · Push OmaRelay · 9s");
  assert.equal(toolLog[0]!.ts, 5000);

  // Generic "Running command... 4s" also folds into a preceding `$ ...` tool row cleanly.
  let genericFold: ActivityEntry[] = [];
  genericFold = mergeActivityLog(genericFold, "$ npm run build", "tool", 1000) ?? genericFold;
  genericFold = mergeActivityLog(genericFold, "Running command... 4s", "status", 5000) ?? genericFold;
  genericFold = mergeActivityLog(genericFold, "Running command... 11s", "status", 12000) ?? genericFold;
  assert.equal(genericFold.length, 1);
  assert.equal(genericFold[0]!.kind, "tool");
  assert.equal(genericFold[0]!.text, "$ npm run build · 11s");

  // Reverse order: if screen poll recorded "Running command... 2s" right before tool_started arrived, tool upgrades it in place.
  let reverseOrder: ActivityEntry[] = [];
  reverseOrder = mergeActivityLog(reverseOrder, "Running command... 2s", "status", 1000) ?? reverseOrder;
  reverseOrder = mergeActivityLog(reverseOrder, "$ pnpm test", "tool", 1200) ?? reverseOrder;
  assert.equal(reverseOrder.length, 1);
  assert.equal(reverseOrder[0]!.kind, "tool");
  assert.equal(reverseOrder[0]!.text, "$ pnpm test · 2s");
});

test("readAgyRunningCommand extracts active command above spinner and ignores completed Ran lines", () => {
  const active = [
    "● Ran (git status) (ctrl+o to expand)",
    "○ Running (npm run build && npm test)",
    "⣯  Running command... 4s",
    "────────────────────────────────────",
    ">",
    "────────────────────────────────────",
    "esc to cancel        auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyRunningCommand(active), "npm run build && npm test");

  const completedOnly = [
    "● Ran (git status) (ctrl+o to expand)",
    "⣯  Running command... 4s",
    "────────────────────────────────────",
    ">",
    "────────────────────────────────────",
    "esc to cancel        auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyRunningCommand(completedOnly), null);
});

test("Antigravity enriches 'Running command... Ns' from pending run_command tool call and collapses ticks into one tool entry", async () => {
  const prevPoll = process.env.HERDR_CHAT_WORK_STATUS_MS;
  const prevTail = process.env.HERDR_CHAT_TAIL_MS;
  process.env.HERDR_CHAT_WORK_STATUS_MS = "35";
  process.env.HERDR_CHAT_TAIL_MS = "35";
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-cmd-activity-"));
  const dataDir = join(d, "agy-data");
  const hc = join(d, "hc");
  const fakeHc = `#!/usr/bin/env node
const fs = require("fs");
const dir = ${JSON.stringify(d)};
const [cmd] = process.argv.slice(2);
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
  process.stdout.write("{}\\n");
}
`;
  writeFileSync(hc, fakeHc);
  chmodSync(hc, 0o755);

  const cmdScreen = (sec: number) => [
    `⣯ Running command... ${sec}s`,
    "────────────────────────────────────",
    ">",
    "────────────────────────────────────",
    "esc to cancel        auto · Gemini 4 Neon · xhigh",
  ].join("\n");

  const trFile = transcriptPath(dataDir, CONV_ID);
  mkdirSync(dirname(trFile), { recursive: true });
  writeFileSync(
    trFile,
    [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nPush changes\n</USER_REQUEST>" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{
          name: "run_command",
          args: {
            CommandLine: JSON.stringify("git push origin main"),
            toolSummary: JSON.stringify("Push OmaRelay main branch"),
          },
        }],
      },
    ].map((x) => JSON.stringify(x)).join("\n") + "\n",
  );
  writeFileSync(join(d, "screen.txt"), cmdScreen(7));
  writeFileSync(
    join(d, "events.jsonl"),
    JSON.stringify({
      terminals: [{ address: "t5", state: "live", foreground: { pid: 4000, name: "fish", argv: ["fish", "-ic", "agy"] }, status: { app: "antigravity", state: "working" } }],
    }) + "\n",
  );

  const io: AgyBindIO = {
    tree: (pid) => (pid === 4000 ? [4000, 4001] : [pid]),
    argv: (pid) => (pid === 4000 ? ["fish", "-ic", "agy"] : ["agy"]),
    cwd: () => d,
    env: (_p, n) => (n === "ANTIGRAVITY_CLI_DATA_DIR" ? dataDir : null),
    openFiles: (pids) => (pids.includes(4001) ? [join(dataDir, "presence", `${CONV_ID}.lock`)] : []),
    exists: existsSync,
    mtime: () => Date.now(),
  };

  const adapter = new AntigravityTerminalAdapter({ cwd: d, command: "agy", args: [], log: () => {}, terminal: "t5", hc, io, fetchModels: async () => [] });
  const chat = new Chat({
    chat: "c-cmd-act",
    cwd: d,
    session: null,
    adapter,
    terminal: null,
    attachments: new Attachments(join(d, "att")),
    view: "t5",
    log: () => {},
  });

  try {
    chat.start(null);
    await chat.whenReady(5000);

    await until("enriched command activity recorded", () =>
      chat.state.activityLog.some((e) => e.text.includes("$ git push origin main") && e.text.includes("Push OmaRelay main branch") && e.text.includes("7s")),
    );

    // Tick 8s -> 15s: MUST collapse into the same single entry instead of spamming rows.
    writeFileSync(join(d, "screen.txt"), cmdScreen(8));
    await until("updated to 8s", () => chat.state.activityLog.some((e) => e.text.includes("8s")));
    writeFileSync(join(d, "screen.txt"), cmdScreen(15));
    await until("updated to 15s", () => chat.state.activityLog.some((e) => e.text.includes("15s")));

    assert.equal(chat.state.activityLog.length, 1);
    assert.equal(chat.state.activityLog[0]!.text, "$ git push origin main · Push OmaRelay main branch · 15s");

    await chat.shutdown();
  } finally {
    if (prevPoll === undefined) delete process.env.HERDR_CHAT_WORK_STATUS_MS;
    else process.env.HERDR_CHAT_WORK_STATUS_MS = prevPoll;
    if (prevTail === undefined) delete process.env.HERDR_CHAT_TAIL_MS;
    else process.env.HERDR_CHAT_TAIL_MS = prevTail;
    adapter.kill();
    rmSync(d, { recursive: true, force: true });
  }
});
