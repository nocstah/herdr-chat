// A message typed while Claude Code works (2.1.3xx): handed to the agent mid-turn as an attachment record, never a
// user record, and held in the TUI's queue till then (queue-operation records). History and the terminal view show it
// as the person's message where it went in (sessions.ts queuedPrompt), the terminal view's steering lane shows it while
// it waits (tui-queue.ts). A made-up session in Claude Code's record shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptFollower } from "../../host/providers/claude/follow.ts";
import { historyOf } from "../../host/providers/claude/history.ts";
import { queuedPrompt } from "../../host/providers/claude/sessions.ts";
import { TuiQueue } from "../../host/providers/claude/tui-queue.ts";
import { modelName } from "../../host/providers/claude/terminal.ts";
import { Timeline } from "../../host/timeline.ts";
import { CLAUDE_TOOLS } from "../../host/providers/claude/tools.ts";

type Rec = Record<string, any>;
const FILE = "/tmp/queued-test/-tmp-demo/5e1f0c2a-0000-4000-8000-000000000002.jsonl";
// An image the terminal view sent (named in the message as an @ mention): a made-up one-pixel PNG.
const IMG = join(mkdtempSync(join(tmpdir(), "herdr-chat-queued-")), "herdr-chat-0123456789abcdef.png");
writeFileSync(IMG, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

function session(): Rec[] {
  let n = 0;
  const base = () => ({ parentUuid: n ? `u${n}` : null, uuid: `u${++n}`, timestamp: `2026-11-21T09:00:${String(n).padStart(2, "0")}.000Z`, sessionId: "s", cwd: "/tmp/demo" });
  const asst = (id: string, block: Rec, stop = "tool_use", index = 0) => ({ ...base(), type: "assistant", apiBlockIndex: index, message: { id, model: "claude-opus-5-5", role: "assistant", content: [block], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 5 } } });
  const result = (id: string) => ({ ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: { stdout: "ok", stderr: "" } });
  const op = (operation: string, content?: string) => ({ type: "queue-operation", operation, timestamp: "2026-11-21T09:00:30.000Z", sessionId: "s", ...(content === undefined ? {} : { content }) });
  const queued = (prompt: string, extra: Rec = {}) => ({ ...base(), type: "attachment", attachment: { type: "queued_command", prompt, source_uuid: "x", delivery_id: "d", commandMode: "prompt", origin: { kind: "human" }, timestamp: "t", humanTurn: true, ...extra } });
  return [
    { ...base(), type: "user", message: { role: "user", content: "Run the made-up suite" } },
    asst("m1", { type: "text", text: "Running it." }, "tool_use", 0),
    asst("m1", { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "make test" } }, "tool_use", 1),
    op("enqueue", "Also check the lint"),
    op("enqueue", '<event kind="repl-eval">made up</event>'),
    op("enqueue", `@${IMG} What is this?`),
    result("toolu_1"),
    op("remove", "Also check the lint"),
    queued("Also check the lint"),
    // Not messages: a finished task's notification, another session's message.
    { ...queued("<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>"), attachment: { type: "queued_command", prompt: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>", commandMode: "task-notification", origin: { kind: "task-notification" } } },
    queued("a message from another session", { origin: { kind: "peer", from: "uds:/run/made-up.sock" } }),
    asst("m2", { type: "text", text: "Lint too, then." }, "tool_use", 0),
    asst("m2", { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "make lint" } }, "tool_use", 1),
    result("toolu_2"),
    op("remove", `@${IMG} What is this?`),
    queued(`@${IMG} What is this?`),
    asst("m3", { type: "text", text: "Both pass. That's a made-up picture." }, "end_turn", 0),
  ];
}

const users = (evs: any[]) => evs.filter((e) => e.type === "user_message").map((e) => [e.text, e.images]);

test("a message typed mid-turn shows where it went in, once, its @ image as its image; notifications and other sessions' messages don't", () => {
  const recs = session();
  const f = new TranscriptFollower(FILE);
  const live = recs.flatMap((r) => f.feed(r));
  assert.deepEqual(users(live), [["Run the made-up suite", 0], ["Also check the lint", 0], ["What is this?", 1]]);
  assert.equal((live.find((e: any) => e.type === "user_message" && e.images) as any).imageBlocks[0].mimeType, "image/png");
  const hist = historyOf(recs, FILE);
  assert.deepEqual(users(hist), users(live));
  assert.ok(hist.filter((e) => e.type === "user_message").every((e: any) => e.source === "composer"));
  // In order: after the tool result it came with, before the answer to it.
  const order = live.filter((e) => e.type === "user_message" || e.type === "tool_ended").map((e: any) => e.type === "user_message" ? e.text : e.callId);
  assert.deepEqual(order, ["Run the made-up suite", "toolu_1", "Also check the lint", "toolu_2", "What is this?"]);
});

test("followed live, the timeline is the one the history shows", () => {
  const recs = session();
  const live = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  const f = new TranscriptFollower(FILE);
  live.apply({ type: "run_started" });
  for (const ev of [...recs.flatMap((r) => f.feed(r)), ...f.close()]) live.apply(ev);
  live.apply({ type: "run_settled", aborted: false });
  const hist = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  hist.load(historyOf(recs, FILE));
  const shape = (items: any[]) => items.map((i) => [i.kind, i.text ?? i.name ?? ""].join("|"));
  assert.deepEqual(shape(live.items), shape(hist.items));
  assert.deepEqual(live.items.filter((i: any) => i.kind === "user").map((i: any) => i.text), ["Run the made-up suite", "Also check the lint", "What is this?"]);
});

test("queuedPrompt: only a person's message handed over mid-turn", () => {
  assert.deepEqual(queuedPrompt({ type: "attachment", attachment: { type: "queued_command", prompt: "hi", commandMode: "prompt" } }), { text: "hi", content: "hi" });
  assert.equal(queuedPrompt({ type: "attachment", isSidechain: true, attachment: { type: "queued_command", prompt: "hi", commandMode: "prompt" } }), null);
  assert.equal(queuedPrompt({ type: "attachment", attachment: { type: "queued_command", prompt: "  ", commandMode: "prompt" } }), null);
  assert.equal(queuedPrompt({ type: "attachment", attachment: { type: "poll_events" } }), null);
  assert.equal(queuedPrompt({ type: "queue-operation", operation: "enqueue", content: "hi" }), null);
});

test("the TUI's queue: what was typed waits in the lane till the agent takes it; what the agent queues by itself never shows", () => {
  const q = new TuiQueue();
  const recs = session();
  const lanes: string[][] = [];
  for (const r of recs) {
    let changed = q.feed(r);
    const typed = queuedPrompt(r);
    if (typed && q.shown(typed.text)) changed = true;
    if (changed) lanes.push(q.waiting);
  }
  assert.deepEqual(lanes, [["Also check the lint"], ["Also check the lint", "What is this?"], ["What is this?"], []]);
  // A message the next turn starts on (a dequeue, then a user record): gone when it shows.
  q.feed({ type: "queue-operation", operation: "enqueue", content: "next one" });
  assert.equal(q.feed({ type: "queue-operation", operation: "dequeue" }), false);
  assert.deepEqual(q.waiting, ["next one"]);
  assert.equal(q.shown("next  one"), true);
  // An Esc takes them back into the TUI's prompt: the run settles, the lane empties.
  q.feed({ type: "queue-operation", operation: "enqueue", content: "taken back" });
  assert.equal(q.clear(), true);
  assert.deepEqual(q.waiting, []);
  assert.equal(q.feed({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>x</task-id>" }), false);
  assert.equal(q.feed({ type: "queue-operation", operation: "enqueue", isSidechain: true, content: "a subagent's" }), false);
});

test("the terminal view names the model as the TUI does", () => {
  assert.deepEqual(["claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-haiku-4", "claude-opus-5-5[1m]", "some-other-model"].map(modelName),
    ["Opus 5.5", "Sonnet 4.5", "Haiku 4", "Opus 5.5 (1M context)", "some-other-model"]);
});
