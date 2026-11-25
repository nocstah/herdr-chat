// Opening files and folders from chat links in Herdr's files viewer mod
// (`my-files` or `better-files`) via herdr-app/mods/chat/files-mod.js.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { findFilesMod, hasFilesPanel, openInFilesMod, pageOpener, revealFolderInFilesPanel, rootFor } from "../../herdr-app/mods/chat/files-mod.js";

function makeApi({
  spaces = [{ id: "s1", active: true, tabs: [{ id: "t1" }] }],
  panes = [{ pane: "p1", tab: "t1", mod: "chat" }],
  shared = {} as Record<string, any>,
  layout = { id: "root", children: [{ id: "files", content: { mod: "my-files" } }] },
  now = 1_700_000_000_000,
  nonce = "abc123",
} = {}) {
  const store: Record<string, any> = structuredClone(shared);
  const runs: Array<{ name: string; args?: Record<string, any> }> = [];
  return {
    store,
    runs,
    api: {
      spaces: () => spaces,
      panes: () => panes,
      layout: () => layout,
      shared: (k: string) => store[k],
      setShared: (k: string, v: any) => { store[k] = v; },
      run: (name: string, args?: Record<string, any>) => { runs.push({ name, args }); },
      now: () => now,
      nonce: () => nonce,
    },
  };
}

test("findFilesMod prefers my-files, detects better-files, and ignores built-in files", () => {
  assert.equal(findFilesMod({ id: "root", children: [{ id: "files", content: { mod: "my-files" } }] }), "my-files");
  assert.equal(findFilesMod({ id: "root", children: [{ id: "files", content: { mod: "better-files" } }] }), "better-files");
  assert.equal(
    findFilesMod({ id: "root", children: [{ id: "a", content: { mod: "better-files" } }, { id: "b", content: { mod: "my-files" } }] }),
    "my-files",
  );
  assert.equal(findFilesMod({ id: "root", children: [{ id: "files", content: { mod: "files" } }] }), null);
  assert.equal(hasFilesPanel({ id: "root", children: [{ id: "files", content: { mod: "files" } }] }), true);
  assert.equal(hasFilesPanel({ id: "root", children: [{ id: "main", content: { tab: "active" } }] }), false);
});

test("rootFor keeps project cwd for project files and uses parent dir for external artifacts", () => {
  assert.equal(rootFor("/home/noc/code/omarelay/docs/herdr-app.md", "/home/noc/code/omarelay"), "/home/noc/code/omarelay");
  assert.equal(
    rootFor("/home/noc/.gemini/antigravity-cli/brain/id/desktop-mobile-parity-plan.md", "/home/noc/code/omarelay"),
    "/home/noc/.gemini/antigravity-cli/brain/id",
  );
});

test("openInFilesMod opens an external markdown artifact in a new my-files preview tab without forcing a line jump", () => {
  const { api, store, runs } = makeApi();
  const path = "/home/noc/.gemini/antigravity-cli/brain/id/desktop-mobile-parity-plan.md";
  const res = openInFilesMod("my-files", { path, line: null, anchor: null, cwd: "/home/noc/code/omarelay", space: "s1", machine: null }, api);

  assert.equal(res?.how, "my-files");
  assert.equal(res?.action, "new");
  assert.equal(store["my-files.jump"], undefined, "no line/anchor jump so markdown opens in Preview");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.name, "tab.new");
  assert.equal(runs[0]!.args?.mod, "my-files");
  assert.equal(runs[0]!.args?.name, "desktop-mobile-parity-plan.md");
  assert.deepEqual(runs[0]!.args?.props?.file, {
    path,
    root: "/home/noc/.gemini/antigravity-cli/brain/id",
    on: null,
  });
  const viewerId = runs[0]!.args?.props?.viewer;
  assert.equal(store["my-files.viewers"][viewerId].preview, true);
});

test("openInFilesMod jumps to explicit line or heading anchor in my-files", () => {
  const { api, store, runs } = makeApi();
  openInFilesMod("my-files", {
    path: "/home/noc/code/omarelay/integrations/herdr-app/inapse-spaces/usage.js",
    line: 85,
    anchor: null,
    cwd: "/home/noc/code/omarelay",
    space: "s1",
    machine: null,
  }, api);

  assert.equal(store["my-files.jump"].line, 85);
  assert.equal(store["my-files.jump"].path, "/home/noc/code/omarelay/integrations/herdr-app/inapse-spaces/usage.js");
  assert.equal(runs[0]!.args?.props?.file.root, "/home/noc/code/omarelay");

  const { api: api2, store: store2 } = makeApi();
  openInFilesMod("my-files", {
    path: "/home/noc/code/omarelay/docs/herdr-app.md",
    line: null,
    anchor: "links",
    cwd: "/home/noc/code/omarelay",
    space: "s1",
    machine: null,
  }, api2);
  assert.equal(store2["my-files.jump"].line, 0);
  assert.equal(store2["my-files.jump"].anchor, "links");
});

test("openInFilesMod selects an already-open tab and reuses a preview tab while clearing sticky markdown mode", () => {
  const pathA = "/home/noc/code/omarelay/docs/a.md";
  const pathB = "/home/noc/code/omarelay/docs/b.md";
  const { api, store, runs } = makeApi({
    spaces: [{ id: "s1", active: true, tabs: [{ id: "t1" }, { id: "t2" }] }],
    panes: [
      { pane: "p1", tab: "t1", mod: "chat" },
      { pane: "p2", tab: "t2", mod: "my-files" },
    ],
    shared: {
      "my-files.viewers": {
        v1: { space: "s1", tab: "t2", preview: true, markdown: "code", file: { path: pathA, root: "/home/noc/code/omarelay", on: null } },
      },
    },
  });

  // Same file -> selects existing tab
  const r1 = openInFilesMod("my-files", { path: pathA, line: null, anchor: null, cwd: "/home/noc/code/omarelay", space: "s1", machine: null }, api);
  assert.equal(r1?.action, "select");
  assert.deepEqual(runs, [{ name: "tab.select", args: { id: "t2" } }]);

  // Different file -> reuses preview tab and resets sticky `markdown: "code"`
  runs.length = 0;
  const r2 = openInFilesMod("my-files", { path: pathB, line: null, anchor: null, cwd: "/home/noc/code/omarelay", space: "s1", machine: null }, api);
  assert.equal(r2?.action, "reuse");
  assert.equal(store["my-files.viewers"].v1.file.path, pathB);
  assert.equal("markdown" in store["my-files.viewers"].v1, false);
  assert.deepEqual(runs, [
    { name: "tab.rename", args: { id: "t2", name: "b.md" } },
    { name: "tab.select", args: { id: "t2" } },
  ]);
});

test("openInFilesMod supports remote spaces and better-files", () => {
  const { api, store, runs } = makeApi({
    spaces: [{ id: "cypherpunk/s1", active: true, tabs: [{ id: "cypherpunk/t1" }] }],
    panes: [{ pane: "cypherpunk/p1", tab: "cypherpunk/t1", mod: "chat" }],
  });
  const res = openInFilesMod("better-files", {
    path: "/remote/proj/README.md",
    line: 12,
    anchor: null,
    cwd: "/remote/proj",
    space: "cypherpunk/s1",
    machine: "cypherpunk",
  }, api);
  assert.equal(res?.how, "better-files");
  assert.equal(store["my-files.jump"], undefined, "better-files does not write my-files.jump");
  assert.equal(runs[0]!.args?.mod, "better-files");
  assert.equal(runs[0]!.args?.space, "cypherpunk/s1");
  assert.deepEqual(runs[0]!.args?.props?.file, { path: "/remote/proj/README.md", root: "/remote/proj", on: "cypherpunk" });
});

test("revealFolderInFilesPanel opens the Files panel for folders inside cwd and ignores external ones", () => {
  const { api, store, runs } = makeApi();
  const r1 = revealFolderInFilesPanel({ path: "/home/noc/code/omarelay/docs", cwd: "/home/noc/code/omarelay", machine: null }, api);
  assert.deepEqual(r1, { how: "my-files" });
  assert.equal(store["my-files.reveal"].path, "/home/noc/code/omarelay/docs");
  assert.deepEqual(runs, [
    { name: "layout.select", args: { stack: "panel-body", child: "files" } },
    { name: "layout.show", args: { id: "panel" } },
  ]);

  const { api: api2, runs: runs2 } = makeApi();
  const r2 = revealFolderInFilesPanel({ path: "/etc", cwd: "/home/noc/code/omarelay", machine: null }, api2);
  assert.equal(r2, null);
  assert.equal(runs2.length, 0);
});

test("pageOpener: a page of this computer goes to the opener another mod shares for clicks on its type, not a line of its source", () => {
  const browser = { name: "this space's browser", command: ["/usr/bin/python3", "/o/scripts/ovis.py", "workspace-browsers", "app-browse"], types: ["html", "pdf"], clicks: ["html", "htm"] };
  const { api } = makeApi({ shared: { "my-files.open-with": { other: { name: "x", command: ["x"], types: ["md"] }, "inapse-spaces": browser } } });
  assert.deepEqual(pageOpener({ path: "/tmp/a/Report.HTML", line: null, machine: null }, api), { name: "this space's browser", command: browser.command });
  // a type it opens from a menu only, a line, another machine's file, no extension: the viewer as before
  assert.equal(pageOpener({ path: "/tmp/a/doc.pdf", line: null, machine: null }, api), null);
  assert.equal(pageOpener({ path: "/tmp/a/page.html", line: 42, machine: null }, api), null);
  assert.equal(pageOpener({ path: "/srv/page.html", line: null, machine: "box" }, api), null);
  assert.equal(pageOpener({ path: "/tmp/a/html", line: null, machine: null }, api), null);
  // nothing shared, or an entry without a whole command: none
  assert.equal(pageOpener({ path: "/tmp/a/page.html", machine: null }, makeApi().api), null);
  assert.equal(pageOpener({ path: "/tmp/a/page.html", machine: null }, makeApi({ shared: { "my-files.open-with": { b: { name: "b", command: ["x", ""], clicks: ["html"] } } } }).api), null);
});
