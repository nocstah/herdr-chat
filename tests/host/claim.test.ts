// The composer claims the keyboard (herdr-app/mods/chat/claim.js): what a keystroke types into it from elsewhere in
// the chat, and when the pointer over the chat may give it the keyboard.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { HOVER_CLAIM_MS, mayClaim, typedChar } from "../../herdr-app/mods/chat/claim.js";

const none = { control: false, alt: false, platform: false, function: false, shift: false };
const key = (key_char: string | undefined, mods: Partial<typeof none> = {}) => ({ key_char, modifiers: { ...none, ...mods } });

test("typedChar: a printable character, with Shift at most; chords and control keys type nothing", () => {
  assert.equal(typedChar(key("a")), "a");
  assert.equal(typedChar(key("A", { shift: true })), "A");
  assert.equal(typedChar(key(" ")), " ");
  assert.equal(typedChar(key("é")), "é");
  assert.equal(typedChar(key("/")), "/");
  assert.equal(typedChar(key("c", { control: true })), null);
  assert.equal(typedChar(key("v", { platform: true })), null);
  assert.equal(typedChar(key("x", { alt: true })), null);
  assert.equal(typedChar(key("\r")), null);
  assert.equal(typedChar(key("\t")), null);
  assert.equal(typedChar(key("\x1b")), null);
  assert.equal(typedChar(key("\x7f")), null);
  assert.equal(typedChar(key(undefined)), null);
  assert.equal(typedChar(null), null);
});

test("mayClaim: only after a press elsewhere, while Herdr's focus is on this chat's pane, and nothing in the chat has the keys", () => {
  const s = { composerFocused: false, busy: false, keysElsewhere: true, focused: { pane: "p1", tab: "t1" }, pane: "p1", tab: "t1" };
  assert.equal(mayClaim(s), true);
  assert.equal(mayClaim({ ...s, keysElsewhere: false }), false, "a press in the chat keeps the keys where it put them");
  assert.equal(mayClaim({ ...s, composerFocused: true }), false);
  assert.equal(mayClaim({ ...s, busy: true }), false);
  assert.equal(mayClaim({ ...s, focused: { pane: "p2", tab: "t1" } }), false, "a terminal clicked in a split keeps its keys");
  assert.equal(mayClaim({ ...s, focused: { pane: "p1", tab: "t2" } }), false);
  assert.equal(mayClaim({ ...s, focused: null }), false);
  assert.equal(mayClaim({ ...s, pane: null }), false);
  assert.ok(HOVER_CLAIM_MS >= 150 && HOVER_CLAIM_MS <= 500);
});
