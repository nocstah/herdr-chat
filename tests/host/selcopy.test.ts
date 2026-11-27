// Native TextView selection state, quoting, and message context menu (herdr-app/mods/chat/selcopy.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { messageMenuItems, selectionForQuote, updateSelection } from "../../herdr-app/mods/chat/selcopy.js";

const plainText = (s: string) =>
  s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~#>|•]/g, " ").replace(/^\s*[-+]\s+/gm, " ")
    .replace(/\s+/g, " ").trim().toLowerCase();

test("updateSelection tracks active TextView selection, extracts Markdown slice, and ignores clears from other views", () => {
  const src = "See **important** and `code` here.";
  const start = src.indexOf("**important**");
  const end = start + "**important**".length;
  const s1 = updateSelection(null, "md-1-0", { text: "important", range: { start, end }, position: { x: 120, y: 240 } }, { itemId: "m1", source: src });
  assert.deepEqual(s1, {
    viewId: "md-1-0",
    itemId: "m1",
    text: "important",
    markdown: "**important**",
    range: { start, end },
    position: { x: 120, y: 240 },
  });

  // A null/clear from a different TextView must not wipe out the newer selection.
  assert.deepEqual(updateSelection(s1, "md-0-0", null), s1);
  // Clearing the owning TextView clears it.
  assert.equal(updateSelection(s1, "md-1-0", null), null);
  // Out-of-bounds range falls back cleanly to markdown: null while keeping plain text.
  const s2 = updateSelection(null, "md-2-0", { text: "hello", range: { start: 0, end: 999 } }, { itemId: "m2", source: "hi" });
  assert.equal(s2.markdown, null);
  assert.equal(s2.text, "hello");
});

test("selectionForQuote prefers live selection on the target message, then clipboard substring, else null", () => {
  const whole = "First line with **bold words** and more details here.";
  const sel = updateSelection(null, "md-a-0", { text: "bold words", range: { start: 16, end: 30 } }, { itemId: "a1", source: whole });
  assert.deepEqual(selectionForQuote(sel, "a1", whole, "unrelated clipboard", plainText), {
    body: "**bold words**",
    source: "selection",
  });
  // Selection from another message does not bleed into a different message's Quote.
  assert.equal(selectionForQuote(sel, "a2", whole, "unrelated clipboard", plainText), null);
  // Falls back to clipboard snippet matching the message when no live selection exists.
  assert.deepEqual(selectionForQuote(null, "a1", whole, "bold words and more", plainText), {
    body: "bold words and more",
    source: "clipboard",
  });
});

test("messageMenuItems: Copy for the selection (its start in the label), then Copy message; none without either", () => {
  const items = messageMenuItems("Alpha  beta\ngamma delta epsilon zeta eta theta", "The whole answer.");
  assert.deepEqual(items.map((i: { id: string }) => i.id), ["copy", "copy-message"]);
  assert.equal(items[0].label, "Copy “Alpha beta gamma delta epsi…”");
  assert.equal(items[0].text, "Alpha  beta\ngamma delta epsilon zeta eta theta");
  assert.equal(items[1].text, "The whole answer.");
  assert.deepEqual(messageMenuItems(null, "x").map((i: { id: string }) => i.id), ["copy-message"]);
  assert.deepEqual(messageMenuItems(null, ""), []);
});
