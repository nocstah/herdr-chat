// Claude Code's first face (herdr-app/mods/new-chat/first-face.js): which terminals Claude Code just started in, and
// settings.json's claude.face. The flip itself is faces.js's (terminal-view.test.ts, the rig).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a mod's plain JavaScript, with no declarations (it loads as is in the app)
import { DEFAULT_FACE, RECENT_MS, faceOf, started, withFace } from "../../herdr-app/mods/new-chat/first-face.js";

const runs = (t: any) => t.claude === true;
const NOW = 1_800_000_000_000;

test("started: nothing at the first look; then a new terminal running Claude Code, or a shell that started it", () => {
  const list = [
    { address: "t1", claude: true, created_ms: NOW - 3_600_000, status_ms: NOW - 3_600_000 },
    { address: "t2", claude: false, created_ms: NOW - 3_600_000, status_ms: NOW - 3_600_000 },
  ];
  assert.deepEqual(started(null, list, runs, NOW), [], "the first look sets what runs: it keeps its face");
  const was = new Map([["t1", true], ["t2", false]]);
  // t2's shell started claude (its status changed just now); t3 is a new tab that runs it
  const later = [list[0], { ...list[1], claude: true, status_ms: NOW - 400 }, { address: "t3", claude: true, created_ms: NOW - 900, status_ms: NOW - 800 }];
  assert.deepEqual(started(was, later, runs, NOW), ["t2", "t3"]);
  // already running at the last look: not again (flipping back to the terminal stays)
  assert.deepEqual(started(new Map([["t1", true], ["t2", true], ["t3", true]]), later, runs, NOW), []);
});

test("started: a terminal the app lists only late, running Claude Code for long, keeps its face", () => {
  const was = new Map([["t1", false]]);
  const old = { address: "t9", claude: true, created_ms: NOW - 2 * RECENT_MS, status_ms: NOW - 2 * RECENT_MS };
  assert.deepEqual(started(was, [old], runs, NOW), []);
  // its status reported late (the app listed it before its first report): the change is old too
  assert.deepEqual(started(new Map([["t9", false]]), [old], runs, NOW), []);
  // a start that ended again by the next look (claude exited) isn't one
  assert.deepEqual(started(was, [{ address: "t1", claude: false, created_ms: NOW, status_ms: NOW }], runs, NOW), []);
});

test("started: without the core's times, only a change seen here counts", () => {
  assert.deepEqual(started(new Map([["t1", false]]), [{ address: "t1", claude: true }, { address: "t2", claude: true }], runs, NOW), ["t1"]);
});

test("faceOf and withFace: the chat view unless set to the terminal; the rest of settings.json kept", () => {
  assert.equal(DEFAULT_FACE, "chat");
  assert.equal(faceOf({}), "chat");
  assert.equal(faceOf(null), "chat");
  assert.equal(faceOf({ claude: { env: { A: "1" } } }), "chat");
  assert.equal(faceOf({ claude: { face: "chat" } }), "chat");
  assert.equal(faceOf({ claude: { face: "terminal" } }), "terminal");
  assert.equal(faceOf({ claude: { face: "Terminal" } }), "chat", "neither: the default");
  const s = { updates: { check: false }, claude: { env: { A: "1" } } };
  assert.deepEqual(withFace(s, "chat"), { updates: { check: false }, claude: { env: { A: "1" }, face: "chat" } });
  assert.deepEqual(s, { updates: { check: false }, claude: { env: { A: "1" } } }, "the read settings unchanged");
  assert.deepEqual(withFace({ claude: "odd" }, "terminal"), { claude: { face: "terminal" } });
  assert.deepEqual(withFace([], "chat"), { claude: { face: "chat" } });
});
