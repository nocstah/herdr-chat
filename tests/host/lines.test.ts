// Your message's line breaks stay as you wrote them (herdr-app/mods/chat/lines.js),
// as in Ovis's chat: markdown would join a paragraph's lines into one.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { keepBreaks } from "../../herdr-app/mods/chat/lines.js";

test("each line of a paragraph ends in a hard break, the last one doesn't", () => {
  assert.equal(keepBreaks("first line\nsecond line\nthird"), "first line  \nsecond line  \nthird");
});

test("blank lines, code fences, indented code and existing breaks stay as written", () => {
  const md = "para one\n\npara two\n```\na\nb\n```\n    code\n    more\nends in two  \nends in slash\\\nlast";
  assert.equal(keepBreaks(md), "para one\n\npara two  \n```\na\nb\n```\n    code\n    more\nends in two  \nends in slash\\\nlast");
});

test("a list keeps its items, and a pasted log keeps its lines", () => {
  assert.equal(keepBreaks("- a\n- b"), "- a  \n- b");
  assert.equal(keepBreaks("12:00 start\n12:01 503\n12:02 retry"), "12:00 start  \n12:01 503  \n12:02 retry");
});
