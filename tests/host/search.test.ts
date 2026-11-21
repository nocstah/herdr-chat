// Find in the chat (protocol `search`): the host looks through the whole
// timeline, history the chat hasn't loaded too, and says where and how often.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Timeline } from "../../host/timeline.ts";

function chat() {
  const tl = new Timeline("/tmp");
  tl.apply({ type: "user_message", text: "The upload fails on a 503", images: 0 });
  tl.apply({ type: "assistant_start" });
  tl.apply({ type: "assistant_end", content: [{ type: "text", text: "Upload retries now. A 503 waits, then UPLOAD tries again." }] });
  tl.addNotice("info", "plan", "Plan created · 3 steps");
  return tl;
}

test("search finds every message holding the text, any case, oldest first, with counts", () => {
  const tl = chat();
  const r = tl.search("upload");
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.matches.map((m) => tl.get(m.id)?.kind), ["user", "assistant"]);
  assert.deepEqual(r.matches.map((m) => m.n), [1, 2]);
  assert.equal(r.total, 3);
  assert.equal(r.capped, false);
  assert.equal(tl.search("plan created").matches.length, 1);
});

test("an empty query finds nothing, and a limit caps the list", () => {
  const tl = chat();
  assert.deepEqual(tl.search("  ").matches, []);
  const r = tl.search("503", 1);
  assert.equal(r.matches.length, 1);
  assert.equal(r.capped, true);
});
