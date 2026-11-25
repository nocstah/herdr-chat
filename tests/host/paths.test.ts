// File paths in an answer's prose become links the chat opens in Herdr's files
// viewer or an editor (herdr-app/mods/chat/paths.js): inline code that is a
// path, bare paths with a folder, never inside fences, links or URLs.
// fileLink parses herdr-chat-file:, file://, and relative/absolute markdown
// file links (with optional #L10-L20, :10, or #anchor).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { linkPaths, fileLink, resolveFilePath, FILE_LINK } from "../../herdr-app/mods/chat/paths.js";

const href = (p: string) => FILE_LINK + encodeURIComponent(p);

test("inline code that is a path, with a folder or a line, is a link", () => {
  assert.equal(linkPaths("See `src/upload.ts:14` and `README.md:3` and `~/docs/plan.md`."),
    `See [\`src/upload.ts:14\`](${href("src/upload.ts:14")}) and [\`README.md:3\`](${href("README.md:3")}) and [\`~/docs/plan.md\`](${href("~/docs/plan.md")}).`);
  assert.equal(linkPaths("Call `upload()` or `npm test`, or `README.md`."), "Call `upload()` or `npm test`, or `README.md`.");
});

test("a bare path with a folder and an extension is a link", () => {
  assert.equal(linkPaths("The stub is in test/upload.test.ts:14, see ./a/b.js."),
    `The stub is in [test/upload.test.ts:14](${href("test/upload.test.ts:14")}), see [./a/b.js](${href("./a/b.js")}).`);
  assert.equal(linkPaths("Open /etc/hosts.conf and ~/docs/plan.md now"),
    `Open [/etc/hosts.conf](${href("/etc/hosts.conf")}) and [~/docs/plan.md](${href("~/docs/plan.md")}) now`);
  assert.equal(linkPaths("version 1.2.3 and e.g. and a/b"), "version 1.2.3 and e.g. and a/b");
});

test("fences, indented code, links and URLs stay as written", () => {
  const md = "```ts\nimport x from \"src/a.ts\";\n```\n    src/b.ts\n[docs](https://x.io/src/c.ts) [plan](file:///tmp/plan.md) <https://x.io/d.ts> https://x.io/e.ts\n![p](img/f.png)";
  assert.equal(linkPaths(md), md);
});

test("fileLink reads herdr-chat-file:, file://, and markdown path links, and leaves web/other schemes alone", () => {
  assert.deepEqual(fileLink(href("src/upload.ts:14")), { path: "src/upload.ts", line: 14, anchor: null });
  assert.deepEqual(fileLink(href("src/upload.ts:14-20")), { path: "src/upload.ts", line: 14, anchor: null });
  assert.deepEqual(fileLink(href("/etc/hosts.conf")), { path: "/etc/hosts.conf", line: null, anchor: null });

  // file:// URLs (artifacts, line ranges, anchors, percent-encoding, localhost)
  assert.deepEqual(
    fileLink("file:///home/noc/.gemini/antigravity-cli/brain/abc/desktop-mobile-parity-plan.md"),
    { path: "/home/noc/.gemini/antigravity-cli/brain/abc/desktop-mobile-parity-plan.md", line: null, anchor: null },
  );
  assert.deepEqual(
    fileLink("file:///home/noc/code/omarelay/usage.js#L85-L102"),
    { path: "/home/noc/code/omarelay/usage.js", line: 85, anchor: null },
  );
  assert.deepEqual(
    fileLink("file:///home/noc/code/omarelay/usage.js#L85C4"),
    { path: "/home/noc/code/omarelay/usage.js", line: 85, anchor: null },
  );
  assert.deepEqual(
    fileLink("file:///home/noc/code/omarelay/docs/herdr-app.md#chat-view-herdr-chat"),
    { path: "/home/noc/code/omarelay/docs/herdr-app.md", line: null, anchor: "chat-view-herdr-chat" },
  );
  assert.deepEqual(
    fileLink("file:///home/noc/my%20notes/plan%201.md:12"),
    { path: "/home/noc/my notes/plan 1.md", line: 12, anchor: null },
  );
  assert.deepEqual(
    fileLink("file://localhost/home/noc/notes.md#L3"),
    { path: "/home/noc/notes.md", line: 3, anchor: null },
  );
  assert.deepEqual(
    fileLink("file:///C:/Users/noc/plan.md#L7"),
    { path: "C:/Users/noc/plan.md", line: 7, anchor: null },
  );
  assert.equal(fileLink("file://other-host/share/plan.md"), null);

  // Relative and absolute markdown links
  assert.deepEqual(fileLink("docs/herdr-app.md"), { path: "docs/herdr-app.md", line: null, anchor: null });
  assert.deepEqual(fileLink("./docs/herdr-app.md#L10-L20"), { path: "./docs/herdr-app.md", line: 10, anchor: null });
  assert.deepEqual(fileLink("../README.md#links"), { path: "../README.md", line: null, anchor: "links" });
  assert.deepEqual(fileLink("README.md:14"), { path: "README.md", line: 14, anchor: null });
  assert.deepEqual(fileLink("/tmp/notes.md:5"), { path: "/tmp/notes.md", line: 5, anchor: null });
  assert.deepEqual(fileLink("~/docs/plan.md"), { path: "~/docs/plan.md", line: null, anchor: null });

  // Non-file links stay null
  assert.equal(fileLink("https://example.com/a.ts"), null);
  assert.equal(fileLink("http://127.0.0.1:3847/"), null);
  assert.equal(fileLink("mailto:user@example.com"), null);
  assert.equal(fileLink("conversation://2842c585"), null);
  assert.equal(fileLink("herdr-chat-run:ls"), null);
  assert.equal(fileLink("#same-doc-anchor"), null);
  assert.equal(fileLink("//example.com/foo.js"), null);
  assert.equal(fileLink(""), null);
});

test("resolveFilePath normalizes relative, dot, parent, and home paths", () => {
  assert.equal(resolveFilePath("docs/herdr-app.md", "/home/noc/code/omarelay", "/home/noc"), "/home/noc/code/omarelay/docs/herdr-app.md");
  assert.equal(resolveFilePath("./docs/../README.md", "/home/noc/code/omarelay/", "/home/noc"), "/home/noc/code/omarelay/README.md");
  assert.equal(resolveFilePath("~/docs/plan.md", "/tmp", "/home/noc"), "/home/noc/docs/plan.md");
  assert.equal(resolveFilePath("~/docs/plan.md", "/remote/proj", null), "~/docs/plan.md");
  assert.equal(resolveFilePath("/home/noc/.gemini/brain/a/plan.md", "/home/noc/code/omarelay", "/home/noc"), "/home/noc/.gemini/brain/a/plan.md");
});
