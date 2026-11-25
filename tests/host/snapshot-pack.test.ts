import { test } from "node:test";
import assert from "node:assert/strict";
import { packWireItems } from "../../host/chat.ts";
import type { WireItem } from "../../host/timeline.ts";

function makeReadTool(id: string, lines: number): WireItem {
  const outputLines = Array.from({ length: lines }, (_, i) => [
    { text: `const value_${i} = `, fg: "#c678dd" },
    { text: `"payload_${"x".repeat(40)}_${i}";`, fg: "#98c379" },
  ]);
  const output = outputLines.map((l) => l.map((s) => s.text).join("")).join("\n");
  return {
    id,
    kind: "tool",
    ts: 1,
    toolCallId: `call_${id}`,
    name: "read_file",
    title: `Read ${id}.ts`,
    status: "done",
    args: `{"path":"${id}.ts"}`,
    output,
    outputTruncated: false,
    outputLines,
    detail: { type: "read", path: `${id}.ts` },
  };
}

function makeEditTool(id: string, lines: number): WireItem {
  const diffLines = Array.from({ length: lines }, (_, i) => ({
    kind: "add" as const,
    new: i + 1,
    spans: [{ text: `+line_${i}_${"y".repeat(30)}`, fg: "#98c379" }],
  }));
  const diff = diffLines.map((l) => l.spans[0]!.text).join("\n");
  return {
    id,
    kind: "tool",
    ts: 2,
    toolCallId: `call_${id}`,
    name: "edit_file",
    title: `Edit ${id}.ts`,
    status: "done",
    args: `{"path":"${id}.ts"}`,
    output: "",
    outputTruncated: false,
    detail: { type: "edit", path: `${id}.ts`, diff, added: lines, removed: 0, diffLines },
  };
}

test("packWireItems strips rich tool spans from older tools while keeping newest within rich budget", () => {
  const items: WireItem[] = [];
  for (let i = 0; i < 40; i++) items.push(makeReadTool(`r${i}`, 120));
  items.push(makeEditTool("e1", 60));
  items.push({ id: "u1", kind: "user", ts: 3, text: "latest prompt", images: 0, source: "composer" });

  const fullBytes = Buffer.byteLength(JSON.stringify(items));
  assert.ok(fullBytes > 500 * 1024, `raw fixture should be large, got ${fullBytes}`);

  const packed = packWireItems(items, 512 * 1024, 64 * 1024, 5);
  const wireBytes = Buffer.byteLength(JSON.stringify(packed.items));
  assert.ok(wireBytes <= 512 * 1024, `packed wire bytes ${wireBytes} exceeded budget`);
  assert.equal(packed.trimmed, false, "compacting older tool spans fits all items without trimming");
  assert.equal(packed.items.length, items.length);
  assert.equal(packed.items.at(-1)!.id, "u1");

  const editItem = packed.items.at(-2)!;
  assert.equal(editItem.kind, "tool");
  assert.equal(editItem.detail.type, "edit");
  assert.ok(Array.isArray(editItem.detail.diffLines), "newest edit keeps diffLines within rich budget");
  assert.equal(editItem.detail.added, 60);

  const oldest = packed.items[0]!;
  assert.equal(oldest.kind, "tool");
  assert.equal(oldest.outputLines, undefined, "older read tool drops outputLines");
  assert.ok(oldest.output.includes("const value_0"), "older read tool preserves plain output");
});

test("packWireItems preserves edit stats/diff when compacting older edit tools and trims when total budget is tight", () => {
  const items: WireItem[] = [
    makeEditTool("e0", 80),
    makeReadTool("r1", 80),
    makeReadTool("r2", 80),
    { id: "a1", kind: "assistant", ts: 4, text: "done", streaming: false },
  ];

  // Rich budget = 0 forces every tool to compact; generous total budget keeps all items.
  const compacted = packWireItems(items, 256 * 1024, 0, 0);
  assert.equal(compacted.trimmed, false);
  const e0 = compacted.items[0]!;
  assert.equal(e0.kind, "tool");
  assert.equal(e0.detail.type, "edit");
  assert.equal(e0.detail.diffLines, undefined);
  assert.equal(e0.detail.added, 80);
  assert.equal(e0.detail.removed, 0);
  assert.ok(e0.detail.diff?.includes("+line_0"));

  // Tight total budget trims oldest items and keeps newest contiguous tail.
  const tight = packWireItems(items, 8 * 1024, 0, 0);
  assert.equal(tight.trimmed, true);
  assert.equal(tight.items.at(-1)!.id, "a1");
  assert.ok(tight.items.length < items.length);
  assert.ok(Buffer.byteLength(JSON.stringify(tight.items)) <= 8 * 1024);
});

test("packWireItems always keeps the newest item even if it exceeds the byte budget", () => {
  const big = makeReadTool("solo", 100);
  const packed = packWireItems([big], 128, 0, 0);
  assert.equal(packed.trimmed, false);
  assert.equal(packed.items.length, 1);
  assert.equal(packed.items[0]!.id, "solo");
  assert.equal(packed.items[0]!.kind === "tool" ? packed.items[0]!.outputLines : null, undefined);
});
