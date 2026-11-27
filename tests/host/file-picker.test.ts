// Native file picker (herdr.pickFiles) and @-mention formatting (herdr-app/mods/chat/file-picker.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { composeWithFiles, formatMention, pickFiles } from "../../herdr-app/mods/chat/file-picker.js";

test("formatMention makes cwd-relative paths short and quotes paths with spaces or quotes", () => {
  assert.equal(formatMention("/repo/src/index.ts", "/repo"), "@src/index.ts");
  assert.equal(formatMention("/repo/src/index.ts", "/repo/"), "@src/index.ts");
  assert.equal(formatMention("/other/report.pdf", "/repo"), "@/other/report.pdf");
  assert.equal(formatMention("/repo/docs/my spec.md", "/repo"), '@"docs/my spec.md"');
  assert.equal(formatMention("/tmp/My Report (v2).pdf", "/repo"), '@"/tmp/My Report (v2).pdf"');
  assert.equal(formatMention('/tmp/say "hi".txt', null), '@"/tmp/say \\"hi\\".txt"');
  assert.equal(formatMention("/etc/hosts", "/"), "@/etc/hosts");
});

test("composeWithFiles preserves leading slash commands/skills and handles empty text", () => {
  assert.equal(composeWithFiles("hello", [], "/repo"), "hello");
  assert.equal(composeWithFiles("", ["/repo/a.txt", "/tmp/my file.pdf"], "/repo"), '@a.txt @"/tmp/my file.pdf"');
  assert.equal(
    composeWithFiles("Summarize these", ["/repo/docs/spec.md", "/tmp/data 1.csv"], "/repo"),
    'Summarize these\n\n@docs/spec.md @"/tmp/data 1.csv"',
  );
  assert.equal(
    composeWithFiles("/review", ["/repo/src/app.ts"], "/repo"),
    "/review\n\n@src/app.ts",
  );
});

test("pickFiles calls Herdr's native pickFiles with multi-select prompt, handles cancel, and guards older hosts", async () => {
  const calls: any[] = [];
  const picked = await pickFiles(async (opts: any) => {
    calls.push(opts);
    return ["/tmp/one.pdf", "/tmp/two words.md", ""];
  }, { prompt: "Upload files", multiple: true });
  assert.deepEqual(picked, ["/tmp/one.pdf", "/tmp/two words.md"]);
  assert.deepEqual(calls, [{ prompt: "Upload files", multiple: true }]);

  const cancelled = await pickFiles(async () => null);
  assert.deepEqual(cancelled, []);

  await assert.rejects(pickFiles(undefined), /Herdr 0\.1\.18\+/);
});
