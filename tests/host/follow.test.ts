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
import { isNarration } from "../../host/providers/claude/mapper.ts";
// @ts-expect-error a plain JS module of the mod's
import { buildRows } from "../../herdr-app/mods/chat/rows.js";

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

// Code Mode (thinking display "updates"): the words Claude Code shows between tool calls come as a thinking block
// whose signature names it a narration. A made-up signature envelope: field 2 { field 1 { field 8: kind } }.
function sig(kind: string): string {
  const k = [...Buffer.from(kind)], inner = [0x08, 0x14, 0x42, k.length, ...k], mid = [0x0a, inner.length, ...inner];
  return Buffer.from([0x08, 0x04, 0x12, mid.length, ...mid]).toString("base64");
}

/** A made-up Code Mode turn as Claude Code 2.1.330 writes it: each record carries its message's stop reason and usage. */
function updatesSession(): Rec[] {
  let n = 0;
  const base = () => ({ parentUuid: n ? `u${n}` : null, uuid: `u${++n}`, timestamp: `2026-11-21T09:00:${String(n).padStart(2, "0")}.000Z`, sessionId: "s", cwd: "/tmp/demo" });
  const asst = (id: string, block: Rec, stop = "tool_use") => ({ ...base(), type: "assistant", thinkingDisplay: "updates", message: { id, model: "claude-opus-5-5", role: "assistant", content: [block], stop_reason: stop, usage: { input_tokens: 7, output_tokens: 3 } } });
  return [
    { ...base(), type: "user", message: { role: "user", content: "Merge the branch" } },
    asst("m1", { type: "thinking", thinking: "", signature: sig("thinking") }),
    asst("m1", { type: "thinking", thinking: "Step one is merged.", signature: sig("narration") }),
    asst("m1", { type: "tool_use", id: "toolu_1", name: "REPL", input: { code: "1" } }),
    { ...base(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } },
    asst("m2", { type: "thinking", thinking: "Compare the two lists.", signature: sig("thinking") }),
    asst("m2", { type: "text", text: "Done." }, "end_turn"),
  ];
}

test("words Claude Code sends as a narration show as the agent's text, mid-turn, after it and in history", () => {
  const recs = updatesSession();
  const live = new Timeline("/tmp/demo", null, CLAUDE_TOOLS), f = new TranscriptFollower(FILE);
  live.apply({ type: "run_started" });
  for (const ev of feedAll(f, recs.slice(0, 5))) live.apply(ev);
  // mid-turn: its own row in the chat, not a Thought folded in the work group
  const rows: any[] = buildRows(live.items, { phase: "working" });
  assert.ok(rows.some((r) => r.kind === "item" && r.item.kind === "assistant" && r.item.text === "Step one is merged."));
  for (const ev of [...feedAll(f, recs.slice(5)), ...f.close()]) live.apply(ev);
  const hist = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  hist.load(historyOf(recs, FILE));
  const want = ["user|Merge the branch|", "assistant|Step one is merged.|", "tool|REPL|done", "thinking|Compare the two lists.|", "assistant|Done.|"];
  assert.deepEqual(shape(live.items), want);
  assert.deepEqual(shape(hist.items), want);
});

test("only a signature that names a narration makes thinking text: reasoning, and signatures it can't read, stay thinking", () => {
  const think = (signature: unknown, thinking = "Read the file first.") => ({ type: "thinking", thinking, signature });
  assert.equal(isNarration(think(sig("narration"))), true);
  assert.equal(isNarration(think(sig("thinking"))), false);
  assert.equal(isNarration(think(sig("narration"), "  ")), false);
  for (const odd of ["x", "", undefined, 42, Buffer.from([0x12, 0x05, 0x0a]).toString("base64"), Buffer.from([0x12, 0xff]).toString("base64")]) {
    assert.equal(isNarration(think(odd)), false, String(odd));
  }
  assert.equal(isNarration({ type: "text", text: "Done.", signature: sig("narration") }), false);
});

test("a message whose every record carries its stop reason counts its usage once", () => {
  const f = new TranscriptFollower(FILE);
  const ends = feedAll(f, updatesSession()).filter((e): e is Extract<NormalizedEvent, { type: "assistant_end" }> => e.type === "assistant_end");
  // m1 ends after each of its three records, m2 after each of its two: one usage each
  assert.equal(ends.length, 5);
  assert.deepEqual(ends.map((e) => Boolean(e.usage)), [true, false, false, true, false]);
  const hist = historyOf(updatesSession(), FILE).filter((e) => e.type === "assistant_end" && e.usage);
  assert.equal(hist.length, 2);
});
