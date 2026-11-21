// The terminal view follows Claude Code's transcript as the TUI writes it
// (host/providers/claude/follow.ts): records in, the events a live stream
// would give out, and the same timeline the history would show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptFollower } from "../../host/providers/claude/follow.ts";
import { historyOf } from "../../host/providers/claude/history.ts";
import { Timeline } from "../../host/timeline.ts";
import { CLAUDE_TOOLS } from "../../host/providers/claude/tools.ts";
import type { NormalizedEvent } from "../../host/providers/types.ts";

type Rec = Record<string, any>;
const FILE = "/tmp/follow-test/-tmp-demo/5e1f0c2a-0000-4000-8000-000000000001.jsonl";

// A made-up session in Claude Code's record shapes: one record per content block.
function session(): Rec[] {
  let n = 0;
  // Each record names the one before it (the active branch is this chain).
  const base = () => ({ parentUuid: n ? `u${n}` : null, uuid: `u${++n}`, timestamp: `2026-11-21T09:00:${String(n).padStart(2, "0")}.000Z`, sessionId: "s", cwd: "/tmp/demo" });
  const asst = (id: string, block: Rec, extra: Rec = {}) => ({ ...base(), type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [block], stop_reason: null, usage: { input_tokens: 10, output_tokens: 5 }, ...extra } });
  return [
    { ...base(), type: "user", message: { role: "user", content: "Add a retry to upload.ts" } },
    asst("m1", { type: "thinking", thinking: "Read the file first.", signature: "x" }),
    asst("m1", { type: "text", text: "I'll read it." }),
    asst("m1", { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/tmp/demo/upload.ts" } }),
    { ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1\texport {}" }] }, toolUseResult: { type: "text", file: { filePath: "/tmp/demo/upload.ts", content: "export {}" } } },
    asst("m2", { type: "text", text: "Done: it retries **three** times." }, { stop_reason: "end_turn" }),
    { ...base(), type: "user", isSidechain: true, message: { role: "user", content: "a subagent's own prompt" } },
  ];
}

const feedAll = (f: TranscriptFollower, recs: Rec[]) => recs.flatMap((r) => f.feed(r));
const shape = (items: any[]) => items.map((i) => [i.kind, i.text ?? i.name ?? "", i.status ?? ""].join("|"));

test("a message written a block at a time opens with its first record and closes at the tool result", () => {
  const f = new TranscriptFollower(FILE);
  const recs = session();
  const evs = feedAll(f, recs.slice(0, 5));
  assert.deepEqual(evs.map((e) => e.type), [
    "user_message", "assistant_start", "assistant_block_start", "assistant_block_end", "assistant_block_start", "assistant_block_end",
    "tool_call", "assistant_end", "tool_ended",
  ]);
  const end = evs.find((e) => e.type === "assistant_end") as Extract<NormalizedEvent, { type: "assistant_end" }>;
  assert.equal(end.stopReason, "toolUse");
  assert.equal(end.content.length, 3);
  assert.equal(end.model, "claude-opus-5-5");
  const read = evs.find((e) => e.type === "tool_ended") as Extract<NormalizedEvent, { type: "tool_ended" }>;
  assert.equal(read.name, "Read");
  assert.equal(read.output, "export {}");
});

test("end_turn closes the message at once; a sidechain record and a record seen before show nothing", () => {
  const f = new TranscriptFollower(FILE);
  const recs = session();
  feedAll(f, recs.slice(0, 5));
  const last = f.feed(recs[5]!);
  assert.deepEqual(last.map((e) => e.type), ["assistant_start", "assistant_block_start", "assistant_block_end", "assistant_end"]);
  assert.equal(f.opened, false);
  assert.deepEqual(f.feed(recs[6]!), []);
  assert.deepEqual(f.feed(recs[0]!), []);
});

test("records the history already showed are skipped, and a tool result still finds its call's name", () => {
  const recs = session();
  const f = new TranscriptFollower(FILE);
  f.prime(recs.slice(0, 4));
  const evs = feedAll(f, recs);
  assert.equal(evs.filter((e) => e.type === "user_message").length, 0);
  const read = evs.find((e) => e.type === "tool_ended") as Extract<NormalizedEvent, { type: "tool_ended" }>;
  assert.equal(read.name, "Read");
});

test("followed live, the timeline is the one the history shows", () => {
  const recs = session();
  const live = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  const f = new TranscriptFollower(FILE);
  live.apply({ type: "run_started" });
  for (const ev of [...feedAll(f, recs), ...f.close()]) live.apply(ev);
  live.apply({ type: "run_settled", aborted: false });
  const hist = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  hist.load(historyOf(recs, FILE));
  assert.deepEqual(shape(live.items), shape(hist.items));
  assert.ok(live.items.every((i: any) => !i.streaming));
});

test("compaction and a local command's output, as the history shows them", () => {
  const f = new TranscriptFollower(FILE);
  const evs = feedAll(f, [
    { uuid: "c1", type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 150000 } },
    { uuid: "c2", type: "system", subtype: "local_command", content: "<local-command-stdout>Total cost: $0.12</local-command-stdout>" },
    { uuid: "c3", type: "user", message: { role: "user", content: "/compact keep the plan" } },
  ]);
  assert.equal(evs[0]!.type, "notice");
  assert.match((evs[0] as any).text, /150k tokens before/);
  assert.equal(evs[1]!.type, "assistant_end");
  assert.equal(evs.length, 2);
});
