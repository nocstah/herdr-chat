// Collapsed large-paste chips, hybrid inline/.txt rebalancing, verbatim user-bubble
// formatting (herdr-app/mods/chat/paste.js), and host `attach_text` / `detach_file` lifecycle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { idle, startHost } from "./harness.ts";
import {
  PASTE_COLLAPSE_LINES,
  PASTE_COLLAPSE_MULTI_CHARS,
  PASTE_COLLAPSE_SINGLE_CHARS,
  PASTE_INLINE_MAX_CHARS,
  assembleMessageWithPastes,
  canUnpackInline,
  createPastedChip,
  detectInsertedSpan,
  normalizeLineEndings,
  pasteChipTitle,
  pastePreviewLine,
  rebalancePasteModes,
  shouldCollapsePaste,
  tokenizeUserMessage,
  verbatimUserMarkdown,
  // @ts-expect-error plain JS module of the mod
} from "../../herdr-app/mods/chat/paste.js";
// @ts-expect-error plain JS module of the mod
import { FILE_LINK, fileLink } from "../../herdr-app/mods/chat/paths.js";

const SCENARIO = {
  prompts: [
    {
      match: "^long",
      once: false,
      steps: [
        { assistant: { text: "Running long task.", tools: [{ name: "bash", args: { command: "sleep 10" } }] } },
        { tool: { name: "bash", until: "abort", every: 100, tick: "tick {n}\n" } },
        { assistant: { text: "unreachable" } },
      ],
    },
  ],
};

const running = (x: any) => x.items.some((i: any) => i.kind === "tool" && i.status === "running");

test("shouldCollapsePaste keeps short pastes/URLs/dictation inline and collapses large or control-char pastes", () => {
  assert.equal(shouldCollapsePaste(""), false);
  assert.equal(shouldCollapsePaste("https://example.com/docs/guide?tab=1"), false);
  assert.equal(shouldCollapsePaste("Just a short dictated sentence with no line breaks."), false);
  assert.equal(shouldCollapsePaste(Array(PASTE_COLLAPSE_LINES - 1).fill("short line").join("\n")), false);
  assert.equal(shouldCollapsePaste("a".repeat(PASTE_COLLAPSE_SINGLE_CHARS - 1)), false);
  assert.equal(shouldCollapsePaste("line1\n" + "a".repeat(PASTE_COLLAPSE_MULTI_CHARS - 7)), false);

  // Triggers
  assert.equal(shouldCollapsePaste(Array(PASTE_COLLAPSE_LINES).fill("line").join("\n")), true);
  assert.equal(shouldCollapsePaste(Array(PASTE_COLLAPSE_LINES).fill("line").join("\r\n")), true);
  assert.equal(shouldCollapsePaste("line1\n" + "a".repeat(PASTE_COLLAPSE_MULTI_CHARS - 6)), true);
  assert.equal(shouldCollapsePaste("x".repeat(PASTE_COLLAPSE_SINGLE_CHARS)), true);
  assert.equal(shouldCollapsePaste("\x1b[31mERROR\x1b[0m failed"), true);
  assert.equal(shouldCollapsePaste("nul\x00byte"), true);
  // Tabs and newlines alone are clean text, not terminal control chars.
  assert.equal(shouldCollapsePaste("\tindented\n\tline"), false);
});

test("detectInsertedSpan isolates pasted text at start, middle, end, and over a selection", () => {
  assert.equal(detectInsertedSpan("hello", "hello"), null);
  assert.equal(detectInsertedSpan("hello world", "hello"), null);
  assert.deepEqual(detectInsertedSpan("Check:\n", "Check:\nline1\nline2"), {
    start: 7,
    end: 18,
    inserted: "line1\nline2",
  });
  assert.deepEqual(detectInsertedSpan("before after", "before PASTED after"), {
    start: 7,
    end: 14,
    inserted: "PASTED ",
  });
  // Replacing a larger highlighted selection with a shorter paste still extracts the paste.
  const before = "head " + "X".repeat(200) + " tail";
  const pasted = Array(12).fill("row").join("\n");
  const after = "head " + pasted + " tail";
  assert.deepEqual(detectInsertedSpan(before, after), {
    start: 5,
    end: 5 + pasted.length,
    inserted: pasted,
  });
});

test("hybrid rebalance switches between inline and .txt file mode as combined size changes", () => {
  const mediumA = createPastedChip("A".repeat(10_000), 1);
  const mediumB = createPastedChip("B".repeat(10_000), 2);
  const ansi = createPastedChip("\x1b[32mok\x1b[0m\nline2", 3);

  assert.equal(pasteChipTitle(mediumA), "Pasted text · 10,000 chars");
  assert.equal(pasteChipTitle(ansi), "Pasted text · 2 lines");
  assert.equal(pastePreviewLine("\n   \x1b[32mok\x1b[0m   world\nsecond"), "ok world");

  // Clean paste fits inline; second overflows 16k; ANSI is always file-backed.
  const r1 = rebalancePasteModes("Please review:", [mediumA, mediumB, ansi]);
  assert.equal(mediumA.mode, "inline");
  assert.equal(mediumB.mode, "file");
  assert.equal(ansi.mode, "file");
  assert.deepEqual(r1.toUpload.map((c: any) => c.id), ["paste-2", "paste-3"]);
  assert.equal(r1.toDetach.length, 0);

  // Simulate host uploads completing for paste-2 and paste-3.
  mediumB.path = "/tmp/att/pasted-text-2.txt";
  ansi.path = "/tmp/att/pasted-text-3.txt";

  // Removing paste-1 frees inline budget: paste-2 rebalances back to inline and detaches its temp file;
  // ANSI stays file-backed and never unpacks inline.
  const r2 = rebalancePasteModes("Please review:", [mediumB, ansi]);
  assert.equal(mediumB.mode, "inline");
  assert.equal(ansi.mode, "file");
  assert.deepEqual(r2.toDetach.map((c: any) => c.id), ["paste-2"]);
  assert.equal(canUnpackInline(mediumB, 14), true);
  assert.equal(canUnpackInline(ansi, 0), false);
  assert.equal(canUnpackInline(mediumB, PASTE_INLINE_MAX_CHARS), false);

  // Typing a long draft pushes mediumB back into file mode.
  mediumB.path = null;
  const r3 = rebalancePasteModes("x".repeat(7_000), [mediumB]);
  assert.equal(mediumB.mode, "file");
  assert.deepEqual(r3.toUpload.map((c: any) => c.id), ["paste-2"]);
});

test("assembleMessageWithPastes preserves verbatim formatting, leading commands, and @path mentions", () => {
  const indented = createPastedChip("  # Title\n    indented  \n\n\ttabbed", 1);
  const huge = createPastedChip("Z".repeat(20_000), 2);
  huge.mode = "file";
  huge.path = "/repo/att/pasted-text-2.txt";

  const out = assembleMessageWithPastes(
    "/review check this   ",
    [indented, huge],
    ["/tmp/my report (v2).pdf"],
    "/repo",
  );
  assert.equal(
    out,
    '/review check this\n\n  # Title\n    indented  \n\n\ttabbed\n\n@att/pasted-text-2.txt @"/tmp/my report (v2).pdf"',
  );

  // Empty draft with only an inline paste preserves leading indentation verbatim.
  assert.equal(assembleMessageWithPastes("   ", [indented], [], "/repo"), "  # Title\n    indented  \n\n\ttabbed");
  // Empty draft with only a file-backed paste emits clean @mention.
  assert.equal(assembleMessageWithPastes("", [huge], [], "/repo"), "@att/pasted-text-2.txt");
});

test("verbatim user-bubble tokenizer preserves every char and linkifies URLs, localhost, @mentions, and paths", () => {
  const sample = [
    "# Heading with *stars* and _underscores_ and --flags and \"quotes\"",
    "  - bullet 1",
    "    1. nested <div class=\"x\">&amp;</div>",
    "",
    "",
    "See https://en.wikipedia.org/wiki/Foo_(bar). and `https://example.com/a_b`",
    "Local: localhost:3847/chat and 127.0.0.1:8080/health",
    'Files: @src/app.ts:14 @"docs/my spec (v2).md" /etc/hosts.conf ~/notes/plan.md',
    "Ignore user@example.com and @alice and https://example.com/src/not-a-file.ts",
  ].join("\n");

  const tokens = tokenizeUserMessage(sample);
  assert.equal(tokens.map((t: any) => t.text).join(""), normalizeLineEndings(sample));

  const links = tokens.filter((t: any) => t.kind !== "text");
  assert.deepEqual(
    links.map((t: any) => ({ kind: t.kind, text: t.text, href: t.href })),
    [
      { kind: "url", text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_%28bar%29" },
      { kind: "url", text: "https://example.com/a_b", href: "https://example.com/a_b" },
      { kind: "url", text: "localhost:3847/chat", href: "http://localhost:3847/chat" },
      { kind: "url", text: "127.0.0.1:8080/health", href: "http://127.0.0.1:8080/health" },
      { kind: "file", text: "@src/app.ts:14", href: FILE_LINK + encodeURIComponent("src/app.ts:14") },
      {
        kind: "file",
        text: '@"docs/my spec (v2).md"',
        href: (FILE_LINK + encodeURIComponent("docs/my spec (v2).md")).replace(/\(/g, "%28").replace(/\)/g, "%29"),
      },
      { kind: "file", text: "/etc/hosts.conf", href: FILE_LINK + encodeURIComponent("/etc/hosts.conf") },
      { kind: "file", text: "~/notes/plan.md", href: FILE_LINK + encodeURIComponent("~/notes/plan.md") },
      { kind: "url", text: "https://example.com/src/not-a-file.ts", href: "https://example.com/src/not-a-file.ts" },
    ],
  );

  // Verify every emitted file href round-trips cleanly through paths.js fileLink().
  const quotedLink = links.find((l: any) => l.text === '@"docs/my spec (v2).md"');
  assert.deepEqual(fileLink(quotedLink.href), { path: "docs/my spec (v2).md", line: null, anchor: null });
  const lineLink = links.find((l: any) => l.text === "@src/app.ts:14");
  assert.deepEqual(fileLink(lineLink.href), { path: "src/app.ts", line: 14, anchor: null });

  // Verify verbatimUserMarkdown escapes syntax triggers, preserves indentation & consecutive blank lines.
  const md = verbatimUserMarkdown(sample);
  const mdLines = md.split("\n");
  assert.equal(mdLines.length, sample.split("\n").length);
  assert.ok(mdLines[0]!.startsWith("\\# Heading with \\*stars\\* and \\_underscores\\_ and \\-\\-flags"));
  assert.ok(mdLines[1]!.startsWith("\u00a0\u00a0\\- bullet 1"));
  assert.ok(mdLines[2]!.startsWith("\u00a0\u00a0\u00a0\u00a01\\. nested \\<div"));
  assert.equal(mdLines[3], "\u00a0  ");
  assert.equal(mdLines[4], "\u00a0  ");
  assert.ok(mdLines[5]!.includes("[https\\:\\/\\/en\\.wikipedia\\.org\\/wiki\\/Foo\\_\\(bar\\)](https://en.wikipedia.org/wiki/Foo_%28bar%29)") ||
    mdLines[5]!.includes("(https://en.wikipedia.org/wiki/Foo_%28bar%29)"));
  assert.ok(mdLines[7]!.includes(`(${quotedLink.href})`));
});

test("host attach_text saves verbatim UTF-8 text with 0600 permissions and obeys detach/queue lifecycle", async () => {
  const h = await startHost({ name: "paste-text-attach", scenario: SCENARIO, speed: 1 });
  const dir = join(h.stateDir, "attachments", h.chat);
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);

    const payload = "  # Header\n\t\x1b[31mANSI log\x1b[0m\n\nline with emoji 🚀\n";
    const res = await c.req("attach_text", { text: payload, name: "../weird/paste\x07name" });
    assert.equal(dirname(res.path), dir);
    assert.match(basename(res.path), /pastename\.txt$/);
    assert.equal(res.sizeBytes, Buffer.byteLength(payload, "utf8"));
    assert.equal(readFileSync(res.path, "utf8"), payload);
    assert.equal(statSync(res.path).mode & 0o777, 0o600);

    // Rejects empty text.
    await assert.rejects(c.req("attach_text", { text: "" }), /No pasted text/);

    // Unused paste attachment is deleted on detach_file.
    await c.req("detach_file", { path: res.path });
    assert.ok(!existsSync(res.path), "detach_file removes unused pasted text file");

    // A paste attachment referenced in a held follow-up is protected until taken out of the queue.
    const held = await c.req("attach_text", { text: "L".repeat(20_000), name: "pasted-text-2.txt" });
    await c.req("send", { text: "long task" });
    await c.waitFor(running, 5000, "tool running");
    await c.req("send", { text: `Analyze log\n\n@${held.path}`, mode: "followUp" });
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 3000, "follow-up queued");

    await c.req("detach_file", { path: held.path });
    assert.ok(existsSync(held.path), "held follow-up keeps its pasted text file");

    await c.req("queue_edit", { message: c.state.queue.followUpIds[0] });
    await c.req("detach_file", { path: held.path });
    assert.ok(!existsSync(held.path), "once removed from queue, detach_file removes the copy");

    await c.req("abort");
    await c.waitFor(idle, 5000, "aborted");
  } finally {
    await h.stop();
  }
});
