// Terminal color flavor helpers (herdr-app/mods/chat/flavor.js):
// palette derivation, inline code decoration, structured markdown chunking,
// pipe table parsing, and tool verb splitting.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { isDarkBg, themeSig, flavorPalette, decorateInlineCode, mdChunks, parseTableRow, splitToolVerb, toolVerb } from "../../herdr-app/mods/chat/flavor.js";
import { CODEX_PERMISSION_MODES } from "../../host/providers/codex/adapter.ts";

const DARK = {
  background: "#1e1222",
  foreground: "#eeeeef",
  muted: "#9c96a0",
  dim: "#6c6472",
  border: "#ffffff18",
  accent: "#f1a3f0",
  ansi1: "#f69088",
  ansi2: "#69be7d",
  ansi3: "#cea655",
  ansi4: "#7faeed",
  ansi5: "#e191d1",
  ansi6: "#4cbbbe",
};

const LIGHT = {
  background: "#f2f2f7",
  foreground: "#1b1b1e",
  muted: "#636366",
  dim: "#8e8e93",
  border: "#00000017",
  accent: "#3e6b96",
  ansi1: "#ff3b30",
  ansi2: "#34c759",
  ansi3: "#ff9500",
  ansi4: "#007aff",
  ansi5: "#af52de",
  ansi6: "#32ade6",
};

test("isDarkBg and flavorPalette adapt cleanly to dark and light themes", () => {
  assert.equal(isDarkBg(DARK.background), true);
  assert.equal(isDarkBg(LIGHT.background), false);
  assert.equal(isDarkBg(null), true);

  const d = flavorPalette(DARK);
  assert.equal(d.dark, true);
  assert.equal(d.heading(1), DARK.ansi4);
  assert.equal(d.heading(2), DARK.ansi6);
  assert.equal(d.heading(3), DARK.ansi5);
  assert.equal(d.heading(4), DARK.ansi3);
  assert.equal(d.heading(5), DARK.ansi2);
  assert.equal(d.heading(6), DARK.muted);
  assert.match(d.codeBg, /^#cea655[0-9a-f]{2}$/);
  assert.equal(d.tool("bash"), DARK.ansi3);
  assert.equal(d.tool("read"), DARK.ansi4);
  assert.equal(d.tool("edit"), DARK.ansi5);
  assert.equal(d.tool("write"), DARK.ansi2);
  assert.equal(d.tool("search"), DARK.ansi6);
  assert.equal(d.mode("auto"), DARK.ansi2);
  assert.equal(d.mode("plan"), DARK.ansi5);
  assert.equal(d.mode("accept-edits"), DARK.ansi4);
  assert.equal(d.mode("default"), null);

  const l = flavorPalette(LIGHT);
  assert.equal(l.dark, false);
  assert.equal(l.heading(1), LIGHT.ansi4);
  assert.equal(l.heading(2), LIGHT.ansi4); // darker high-contrast blue on light bg
  assert.equal(l.heading(3), LIGHT.ansi5);
  assert.match(l.codeBg, /^#ff9500[0-9a-f]{2}$/);
  assert.notEqual(themeSig(DARK), themeSig(LIGHT));
});

test("decorateInlineCode wraps standalone inline code spans without breaking links, fences or marks", () => {
  const c = "#cea65538";
  assert.equal(decorateInlineCode("Run `npm test` now.", c), `Run <mark color="${c}">\`npm test\`</mark> now.`);
  assert.equal(decorateInlineCode("Use ``foo ` bar`` and `x`.", c), `Use <mark color="${c}">\`\`foo \` bar\`\`</mark> and <mark color="${c}">\`x\`</mark>.`);
  // Already-linked code spans (from linkPaths) and markdown links stay untouched.
  const linked = "See [`src/a.ts:10`](herdr-chat-file:src%2Fa.ts%3A10) and [docs `x`](https://example.com) and `flag`.";
  assert.equal(
    decorateInlineCode(linked, c),
    `See [\`src/a.ts:10\`](herdr-chat-file:src%2Fa.ts%3A10) and [docs \`x\`](https://example.com) and <mark color="${c}">\`flag\`</mark>.`,
  );
  // Existing <mark>, fenced blocks, and 4-space indented code are never touched.
  const complex = [
    `<mark color="#11223344">\`keep\`</mark>`,
    "```ts",
    "const s = `template`;",
    "```",
    "    indented `code`",
    "Normal `ok`.",
  ].join("\n");
  assert.equal(
    decorateInlineCode(complex, c),
    [
      `<mark color="#11223344">\`keep\`</mark>`,
      "```ts",
      "const s = `template`;",
      "```",
      "    indented `code`",
      `Normal <mark color="${c}">\`ok\`</mark>.`,
    ].join("\n"),
  );
  // Invalid color or empty code leaves input untouched.
  assert.equal(decorateInlineCode("Run `x`", "not-a-color"), "Run `x`");
  assert.equal(decorateInlineCode("Empty `` ticks", c), "Empty `` ticks");
});

test("mdChunks classifies headings, hrs, blockquotes, GitHub callouts, tables, lists and prose", () => {
  const doc = [
    "# Title",
    "",
    "Intro paragraph.",
    "",
    "---",
    "",
    "> Plain quote line 1",
    "> Plain quote line 2",
    "",
    "> [!TIP]",
    "> Helpful hint with `code`.",
    "",
    "| Name | Value |",
    "| :--- | ---: |",
    "| `a \\| b` | 42 |",
    "| two | 99 |",
    "",
    "- First item",
    "  - Nested bullet",
    "- [x] Done task",
    "- [ ] Open task",
    "",
    "1. Step one",
    "2. Step two",
  ].join("\n");

  const chunks = mdChunks(doc);
  assert.deepEqual(
    chunks.map((x: any) => x.kind),
    ["heading", "prose", "hr", "blockquote", "callout", "table", "list", "list"],
  );
  assert.equal(chunks[0].level, 1);
  assert.equal(chunks[0].heading, true);
  assert.equal(chunks[3].body, "Plain quote line 1\nPlain quote line 2");
  assert.equal(chunks[4].alert, "tip");
  assert.equal(chunks[4].body, "Helpful hint with `code`.");
  assert.deepEqual(chunks[5].headers, ["Name", "Value"]);
  assert.deepEqual(chunks[5].aligns, ["left", "right"]);
  assert.deepEqual(chunks[5].rows, [["`a \\| b`", "42"], ["two", "99"]]);
  assert.equal(chunks[6].items.length, 4);
  assert.equal(chunks[6].items[0].depth, 0);
  assert.equal(chunks[6].items[1].depth, 1);
  assert.equal(chunks[6].items[2].checked, true);
  assert.equal(chunks[6].items[3].checked, false);
  assert.equal(chunks[7].items[0].ordered, true);
  assert.equal(chunks[7].items[0].marker, "1.");
});

test("mdChunks keeps setext underlines, reference links and fenced-list blocks as prose", () => {
  const setext = "Heading\n---";
  assert.deepEqual(mdChunks(setext).map((x: any) => x.kind), ["prose"]);

  const refdef = "See [docs][1].\n\n[1]: https://example.com";
  assert.deepEqual(mdChunks(refdef), [{ kind: "prose", text: refdef, heading: false }]);

  const fencedList = "- item\n  ```sh\n  echo hi\n  ```";
  assert.deepEqual(mdChunks(fencedList).map((x: any) => x.kind), ["prose"]);
});

test("parseTableRow handles escaped pipes and inline code pipes", () => {
  assert.deepEqual(parseTableRow("| `a | b` | c \\| d | plain |"), ["`a | b`", "c | d", "plain"]);
});

test("splitToolVerb extracts leading semantic tool verbs", () => {
  assert.deepEqual(splitToolVerb("$ git status"), { verb: "$", rest: "git status" });
  assert.deepEqual(splitToolVerb("Grep foo in src/"), { verb: "Grep", rest: "foo in src/" });
  assert.deepEqual(splitToolVerb("Fetch https://example.com"), { verb: "Fetch", rest: "https://example.com" });
  assert.equal(splitToolVerb("mcp server · query"), null);
});

test("every provider's permission modes get a color of their own, on dark and light; Manual and custom stay plain", () => {
  const claude = ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"];
  const codex = CODEX_PERMISSION_MODES.map((m: { id: string }) => m.id);
  const antigravity = ["default", "accept-edits", "auto", "plan"];
  assert.deepEqual(codex, ["untrusted", "read-only", "auto", "auto-review", "full", "plan"], "the Codex list this test covers");
  for (const [name, t] of [["dark", DARK], ["light", LIGHT]] as const) {
    const f = flavorPalette(t);
    for (const id of [...claude, ...codex, ...antigravity]) {
      if (id === "default") assert.equal(f.mode(id), null, `${name}: Manual is plain`);
      else assert.match(f.mode(id) ?? "", /^#[0-9a-f]{6}$/, `${name}: ${id} has a color`);
    }
    assert.equal(f.mode("custom"), null, `${name}: a Codex configuration of your own is plain`);
    // Within one provider's picker, each mode its own color (Auto-review is Auto with a reviewer: Auto's green).
    for (const [p, ids] of [["claude", claude], ["codex", codex.filter((id: string) => id !== "auto-review")], ["antigravity", antigravity]] as const) {
      const colors = ids.filter((id) => id !== "default").map((id) => f.mode(id));
      assert.equal(new Set(colors).size, colors.length, `${name}/${p}: ${colors.join(" ")}`);
    }
    assert.equal(f.mode("auto-review"), f.mode("auto"));
    assert.equal(f.mode("full"), t.ansi1, "no sandbox, no approvals: red, as bypassPermissions");
    assert.equal(f.mode("bypassPermissions"), t.ansi1);
    assert.equal(f.mode("untrusted"), t.ansi3);
  }
  assert.equal(flavorPalette(DARK).mode("read-only"), DARK.ansi6);
  assert.equal(flavorPalette(LIGHT).mode("read-only"), LIGHT.ansi4, "cyan is too faint on a light background");
});

test("a REPL row is REPL and its description, whatever word the description starts with", () => {
  const script = { type: "script", code: "await $`npm test`" };
  assert.deepEqual(toolVerb("Run the tests", script), { verb: "REPL", rest: "Run the tests", kind: "script" });
  assert.deepEqual(toolVerb("Read flavor.js reference implementation", script), { verb: "REPL", rest: "Read flavor.js reference implementation", kind: "script" });
  assert.deepEqual(toolVerb("REPL", script), { verb: "REPL", rest: "", kind: "script" }, "no description: the name alone");
  assert.deepEqual(toolVerb("", script), { verb: "REPL", rest: "", kind: "script" });
  // A tool that really is Read keeps its verb and its own color.
  assert.deepEqual(toolVerb("Read src/a.ts", { type: "read" }), { verb: "Read", rest: "src/a.ts", kind: "read" });
  assert.deepEqual(toolVerb("$ git status", { type: "bash" }), { verb: "$", rest: "git status", kind: "bash" });
  assert.equal(toolVerb("mcp server · query", { type: "generic" }), null);
});

test("a Poll's Waiting row has the wait color, with what it waits for after it", () => {
  const poll = { type: "generic", tool: "Poll" };
  assert.deepEqual(toolVerb("Waiting", poll), { verb: "Waiting", rest: "", kind: "wait" });
  assert.deepEqual(toolVerb("Waiting for #12 Run the tests, #13 Build", poll), { verb: "Waiting", rest: "for #12 Run the tests, #13 Build", kind: "wait" });
  assert.equal(flavorPalette(DARK).tool("wait"), DARK.ansi6);
  assert.equal(flavorPalette(LIGHT).tool("wait"), LIGHT.ansi4);
  assert.notEqual(flavorPalette(DARK).tool("wait"), flavorPalette(DARK).tool("script"), "a wait and the script it waits for read apart");
  assert.notEqual(flavorPalette(DARK).tool("wait"), flavorPalette(DARK).tool("generic"));
});
