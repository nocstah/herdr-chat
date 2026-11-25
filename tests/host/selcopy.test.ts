// Copying text selected in the chat through Herdr's own Ctrl+C (herdr-app/mods/chat/selcopy.js): the command it
// asks Hyprland with, what it reads back from the clipboard, the Stop it keeps from stopping, and a message's menu.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { HANDOFF_MS, copiedText, ctrlCCommand, messageMenuItems, swallowsStop } from "../../herdr-app/mods/chat/selcopy.js";

test("ctrlCCommand: Hyprland sends the window Ctrl+C with explicit modifiers, down then up, never through a virtual keyboard", () => {
  const { program, args } = ctrlCCommand();
  assert.equal(program, "/bin/sh");
  assert.match(args[1], /^hyprctl dispatch "\$1" >\/dev\/null && sleep 0\.05 && hyprctl dispatch "\$2"/);
  assert.deepEqual(args.slice(3), [
    'hl.dsp.send_key_state({ mods = "CTRL", key = "C", state = "down" })',
    'hl.dsp.send_key_state({ mods = "CTRL", key = "C", state = "up" })',
  ]);
  assert.doesNotMatch(args.join(" "), /wtype|ydotool/);
});

test("copiedText: the clipboard's new text, else null (nothing selected, or nothing came)", () => {
  assert.equal(copiedText("old", "Alpha beta"), "Alpha beta");
  assert.equal(copiedText(null, "Alpha beta"), "Alpha beta");
  assert.equal(copiedText("same", "same"), null);
  assert.equal(copiedText("old", ""), null);
  assert.equal(copiedText("old", null), null);
});

test("swallowsStop: only inside the hand-off's window", () => {
  const now = 1_000_000;
  assert.equal(swallowsStop(now + HANDOFF_MS, now), true);
  assert.equal(swallowsStop(now, now), false);
  assert.equal(swallowsStop(0, now), false);
  assert.equal(swallowsStop(undefined, now), false);
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
