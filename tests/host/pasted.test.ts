// A block pasted into Claude Code's prompt, as its transcript writes it: <pasted_content> tags around the paste
// (sessions.ts unwrapPasted). A long message from the chat goes in as a paste, so its echo comes back that way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { historyOf } from "../../host/providers/claude/history.ts";
import { promptText, queuedPrompt, unwrapPasted } from "../../host/providers/claude/sessions.ts";

const wrap = (body: string, id = "f4fa") => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`;
const SPEC = "# Spec\n\n```ts\nconst a = \"<b>\";\n```\n\n| a | b \\| c |\n|---|---|\n| 1 | 2 |\n\n- one\n  - nested";

test("a paste alone is its text: tags and the blank lines Claude Code puts before it gone, the paste as it was", () => {
  assert.equal(unwrapPasted(`\n\n${wrap(SPEC)}\n`), SPEC);
  assert.equal(promptText({ type: "user", message: { role: "user", content: `\n\n${wrap(SPEC)}\n` } }), SPEC);
  assert.equal(promptText({ type: "user", message: { role: "user", content: [{ type: "text", text: `\n\n${wrap(SPEC)}\n` }] } }), SPEC);
});

test("typed words and pastes keep their order; two pastes each lose their own tags", () => {
  assert.equal(unwrapPasted(`Look at this:\n\n${wrap("line 1\nline 2")}\n`), "Look at this:\n\nline 1\nline 2");
  assert.equal(unwrapPasted(`${wrap("first", "a1")}\nand\n${wrap("second", "b2")}`), "first\nand\nsecond");
});

test("text that only mentions the tag, or a tag without its end, is left as it is", () => {
  for (const s of ["Why does <pasted_content> show up?", '<pasted_content id="x">\nno end', "plain words\n"]) assert.equal(unwrapPasted(s), s);
  assert.equal(promptText({ type: "user", message: { role: "user", content: "  plain, spaces kept  " } }), "  plain, spaces kept  ");
});

test("a message handed over mid-turn (a queued command) loses the tags too", () => {
  const q = queuedPrompt({ type: "attachment", attachment: { type: "queued_command", prompt: `\n\n${wrap("steer this")}\n`, commandMode: "prompt", origin: { kind: "human" } } });
  assert.equal(q?.text, "steer this");
});

test("history shows a pasted message as its text", () => {
  const recs = [
    { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-11-23T13:01:14.000Z", message: { role: "user", content: `\n\n${wrap(SPEC)}\n` } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-11-23T13:01:15.000Z", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "On it." }], stop_reason: "end_turn" } },
  ];
  const msgs = historyOf(recs, "/nowhere/s.jsonl").filter((e: any) => e.type === "user_message") as any[];
  assert.deepEqual(msgs.map((m) => m.text), [SPEC]);
});
