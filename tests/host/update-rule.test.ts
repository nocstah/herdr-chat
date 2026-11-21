// The restart question's rule (herdr-app/mods/new-chat/update-rule.js): each chat is asked about once, whatever the
// answer. update.js's own look (shared keys, the window) is the app's: the rig.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a mod's plain JavaScript, with no declarations (it loads as is in the app)
import { restartQuestion } from "../../herdr-app/mods/new-chat/update-rule.js";

test("restartQuestion: each chat asked about once, after Later and after Restart alike", () => {
  // the first look after an install: two chats on old code, nobody asked yet
  let q = restartQuestion(["c-a", "c-b"], ["c-a", "c-b"], undefined);
  assert.deepEqual(q, { ask: true, asked: ["c-a", "c-b"] });
  // the next look (a reload, the hourly one), whatever was answered: not again
  q = restartQuestion(["c-a", "c-b"], ["c-a", "c-b"], q.asked);
  assert.equal(q.ask, false);
  // Restart: the chats restarted onto that install, none outdated: they stay remembered while they run
  q = restartQuestion([], ["c-a", "c-b"], q.asked);
  assert.deepEqual(q, { ask: false, asked: ["c-a", "c-b"] });
  // another install makes them outdated again: no question (their own bars say it)
  q = restartQuestion(["c-a", "c-b"], ["c-a", "c-b"], q.asked);
  assert.equal(q.ask, false);
  // a chat started since is asked about, the others counted with it
  q = restartQuestion(["c-a", "c-b", "c-c"], ["c-a", "c-b", "c-c"], q.asked);
  assert.deepEqual(q, { ask: true, asked: ["c-a", "c-b", "c-c"] });
});

test("restartQuestion: a closed chat is forgotten; nothing outdated, nothing asked; the person's own check asks", () => {
  // c-b's host is gone (the chat closed): it leaves the list, so the list never grows
  assert.deepEqual(restartQuestion(["c-a"], ["c-a"], ["c-a", "c-b"]), { ask: false, asked: ["c-a"] });
  assert.deepEqual(restartQuestion([], [], ["c-a"]), { ask: false, asked: [] });
  // `new-chat.update-check`, or the update the person started ended: asked regardless
  assert.equal(restartQuestion(["c-a"], ["c-a"], ["c-a"], true).ask, true);
  assert.equal(restartQuestion([], ["c-a"], [], true).ask, false);
  // whatever was kept before (an older build kept nothing, or something odd): as nothing asked
  assert.equal(restartQuestion(["c-a"], ["c-a"], null).ask, true);
  assert.equal(restartQuestion(["c-a"], ["c-a"], { "c-a": true }).ask, true);
  assert.equal(restartQuestion(["c-a"], ["c-a"], ["c-a", 7]).ask, false);
});

test("restartQuestion: the first look under this rule, where the old one's question was answered, doesn't ask again", () => {
  // nothing remembered yet, but a Later or Restart from before: the chats running now count as asked
  assert.deepEqual(restartQuestion(["c-a"], ["c-a", "c-b"], undefined, false, true), { ask: false, asked: ["c-a", "c-b"] });
  // a chat started after that still gets asked about, at its first look
  assert.equal(restartQuestion(["c-a", "c-c"], ["c-a", "c-b", "c-c"], ["c-a", "c-b"], false, true).ask, true);
  // never answered before: asked as usual
  assert.equal(restartQuestion(["c-a"], ["c-a"], undefined, false, false).ask, true);
  // something remembered under this rule: the old answer doesn't matter any more
  assert.equal(restartQuestion(["c-a"], ["c-a"], [], false, true).ask, true);
});
