import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS module of the mod
import { cwdFor } from "../../herdr-app/mods/new-chat/cwd.js";

test("cwdFor uses focused terminal cwd directly when present", () => {
  assert.equal(
    cwdFor({
      focused: { space: "sp1", tab: "tb1", pane: "p1", terminal: "t1", cwd: "/code/omarelay/apps" },
      spaces: [{ id: "sp1", folder: "/code/stale", active: true, tabs: [{ id: "tb1" }] }],
      panes: [{ pane: "p1", tab: "tb1", terminal: "t1", cwd: "/code/omarelay/apps" }],
      terminals: [],
      chatPanes: {},
    }),
    "/code/omarelay/apps",
  );
});

test("cwdFor resolves attached terminal cwd when focused pane is a Chat view mod pane", () => {
  assert.equal(
    cwdFor({
      focused: { space: "sp1", tab: "tb1", pane: "pChat", terminal: null, cwd: null },
      spaces: [{ id: "sp1", folder: "/code/omacards", active: true, tabs: [{ id: "tb1" }] }],
      panes: [
        { pane: "pTerm", tab: "tb1", terminal: "t3c", cwd: "/code/omarelay" },
        { pane: "pChat", tab: "tb1", terminal: null, mod: "chat", cwd: null },
      ],
      terminals: [{ address: "t3c", cwd: "/code/omarelay" }],
      chatPanes: { pChat: "t3c" },
    }),
    "/code/omarelay",
  );
});

test("cwdFor falls back to standalone chat host terminal cwd from terminals()", () => {
  assert.equal(
    cwdFor({
      focused: { space: "sp1", tab: "tb1", pane: "pChat", terminal: null, cwd: null },
      spaces: [{ id: "sp1", folder: "/code/stale", active: true, tabs: [{ id: "tb1" }] }],
      panes: [{ pane: "pChat", tab: "tb1", terminal: null, mod: "chat", cwd: null }],
      terminals: [{ address: "t9", cwd: "/code/omarelay", foreground: { cwd: "/code/omarelay/sub" } }],
      chatPanes: { pChat: "t9" },
    }),
    "/code/omarelay/sub",
  );
});

test("cwdFor falls back to same-tab terminal, then space first terminal, then space.folder", () => {
  // Same tab has a hidden terminal even without chatPanes entry
  assert.equal(
    cwdFor({
      focused: { space: "sp1", tab: "tb2", pane: "pMod", terminal: null, cwd: null },
      spaces: [{ id: "sp1", folder: "/code/stale", active: true, tabs: [{ id: "tb1" }, { id: "tb2" }] }],
      panes: [
        { pane: "p1", tab: "tb1", terminal: "t1", cwd: "/code/first" },
        { pane: "p2", tab: "tb2", terminal: "t2", cwd: "/code/same-tab" },
        { pane: "pMod", tab: "tb2", terminal: null, mod: "chat", cwd: null },
      ],
      terminals: [],
      chatPanes: {},
    }),
    "/code/same-tab",
  );

  // Viewer tab with no terminal: falls back to space's first terminal before stale space.folder
  assert.equal(
    cwdFor({
      focused: { space: "sp1", tab: "tbViewer", pane: "pView", terminal: null, cwd: null },
      spaces: [{ id: "sp1", folder: "/code/stale", active: true, tabs: [{ id: "tb1" }, { id: "tbViewer" }] }],
      panes: [
        { pane: "p1", tab: "tb1", terminal: "t1", cwd: "/code/omarelay" },
        { pane: "pView", tab: "tbViewer", terminal: null, mod: "my-files", cwd: null },
      ],
      terminals: [],
      chatPanes: {},
    }),
    "/code/omarelay",
  );

  // Empty space with no terminal cwds: falls back to space.folder
  assert.equal(
    cwdFor({
      focused: { space: "sp1", tab: "tb1", pane: "pView", terminal: null, cwd: null },
      spaces: [{ id: "sp1", folder: "/code/omarelay", active: true, tabs: [{ id: "tb1" }] }],
      panes: [{ pane: "pView", tab: "tb1", terminal: null, mod: "my-files", cwd: null }],
      terminals: [],
      chatPanes: {},
    }),
    "/code/omarelay",
  );
});
