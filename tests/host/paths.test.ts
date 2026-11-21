// File paths in an answer's prose become links the chat opens in an editor
// (herdr-app/mods/chat/paths.js): inline code that is a path, bare paths with
// a folder, never inside fences, links or URLs.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { linkPaths, fileLink, FILE_LINK } from "../../herdr-app/mods/chat/paths.js";

const href = (p: string) => FILE_LINK + encodeURIComponent(p);

test("inline code that is a path, with a folder or a line, is a link", () => {
  assert.equal(linkPaths("See `src/upload.ts:14` and `README.md:3`."),
    `See [\`src/upload.ts:14\`](${href("src/upload.ts:14")}) and [\`README.md:3\`](${href("README.md:3")}).`);
  assert.equal(linkPaths("Call `upload()` or `npm test`, or `README.md`."), "Call `upload()` or `npm test`, or `README.md`.");
});

test("a bare path with a folder and an extension is a link", () => {
  assert.equal(linkPaths("The stub is in test/upload.test.ts:14, see ./a/b.js."),
    `The stub is in [test/upload.test.ts:14](${href("test/upload.test.ts:14")}), see [./a/b.js](${href("./a/b.js")}).`);
  assert.equal(linkPaths("Open /etc/hosts.conf now"), `Open [/etc/hosts.conf](${href("/etc/hosts.conf")}) now`);
  assert.equal(linkPaths("version 1.2.3 and e.g. and a/b"), "version 1.2.3 and e.g. and a/b");
});

test("fences, indented code, links and URLs stay as written", () => {
  const md = "```ts\nimport x from \"src/a.ts\";\n```\n    src/b.ts\n[docs](https://x.io/src/c.ts) <https://x.io/d.ts> https://x.io/e.ts\n![p](img/f.png)";
  assert.equal(linkPaths(md), md);
});

test("fileLink reads a path and its line back, and leaves other links alone", () => {
  assert.deepEqual(fileLink(href("src/upload.ts:14")), { path: "src/upload.ts", line: 14 });
  assert.deepEqual(fileLink(href("src/upload.ts:14-20")), { path: "src/upload.ts", line: 14 });
  assert.deepEqual(fileLink(href("/etc/hosts.conf")), { path: "/etc/hosts.conf", line: 1 });
  assert.equal(fileLink("https://example.com/a.ts"), null);
});
