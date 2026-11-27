// Silent auto-restart & banner removal for outdated chat hosts (herdr-app/mods/chat/update-logic.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS mod helper
import { UpdaterCore, isQuiet, older } from "../../herdr-app/mods/chat/update-logic.js";

const cfg = { build: "build-new", installedAt: 2000, version: "0.5.0" };
const oldWelcome = { host: { build: "build-old", startedAt: 1000, pid: 100 } };
const newWelcome = { host: { build: "build-new", startedAt: 2500, pid: 200 } };
const host = { address: "t1" };

test("UpdaterCore never shows a top update banner (idle, working, or wanted)", () => {
  const u = new UpdaterCore();
  u.cfg = cfg;
  assert.equal(u.bar(), null);
  u.want();
  assert.equal(u.bar(), null);
});

test("UpdaterCore auto-restarts silently once idle, without waiting for manual want()", () => {
  let live: any[] = [];
  const u = new UpdaterCore({ getTerminals: () => live });
  u.cfg = cfg;

  // Busy or blocked states must not restart.
  for (const state of [
    { phase: "working" },
    { phase: "compacting" },
    { phase: "handoff" },
    { phase: "conflict" },
    { phase: "idle", dialog: { method: "artifact" } },
    { phase: "idle", dialogsPending: 1 },
    { phase: "idle", queue: { steering: ["x"], followUp: [] } },
    { phase: "idle", queue: { steering: [], followUp: ["y"] } },
  ]) {
    assert.equal(u.due({ welcome: oldWelcome, state, host, replacing: false }), false);
  }

  // Live sub-agent owned by this host delays restart.
  live = [{ state: "live", parent: "t1" }];
  assert.equal(u.due({ welcome: oldWelcome, state: { phase: "idle" }, host, replacing: false }), false);
  live = [];

  // Once quiet, auto-restarts immediately (no want() needed) and tries only once per build.
  assert.equal(u.due({ welcome: oldWelcome, state: { phase: "idle" }, host, replacing: false }), true);
  assert.equal(u.due({ welcome: oldWelcome, state: { phase: "idle" }, host, replacing: false }), false);

  // Silent auto-restart produces no flash message on welcome.
  assert.equal(u.finishWelcome(newWelcome, 100), null);
});

test("UpdaterCore flashes on welcome only for explicit /reload want(), and never restarts sub-agents", () => {
  const u = new UpdaterCore();
  u.cfg = cfg;
  u.want();
  assert.equal(u.due({ welcome: oldWelcome, state: { phase: "idle" }, host, replacing: false }), true);
  assert.equal(u.finishWelcome(newWelcome, 100), "Restarted on herdr-chat 0.5.0");

  const sub = new UpdaterCore({ sub: true });
  sub.cfg = cfg;
  assert.equal(sub.canRestart(oldWelcome), false);
  assert.equal(sub.due({ welcome: oldWelcome, state: { phase: "idle" }, host, replacing: false }), false);
});

test("older() and isQuiet() preserve restart safety rules", () => {
  assert.equal(older(oldWelcome.host, cfg), true);
  assert.equal(older(newWelcome.host, cfg), false);
  assert.equal(older({ build: "dev", startedAt: 3000 }, cfg), false);
  assert.equal(isQuiet({ phase: "exited" }, "t1", []), true);
  assert.equal(isQuiet({ phase: "error" }, "t1", []), true);
});
