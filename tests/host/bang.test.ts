// `! <command>` lines in an answer (herdr-app/mods/chat/bang.js), found as
// OmaRelay's Ctrl+! finds them, and the runs Claude Code writes for them
// (sessions.ts bashOf/bashEvents): a Bash card, in history and live alike.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { RUN_MARK, bangHash, bangKey, bangOf, findAutoRan, oneLine, runHref, runLink, runsInCode, tabScript } from "../../herdr-app/mods/chat/bang.js";
// @ts-expect-error a plain JS module of the mod's
import { linkPaths } from "../../herdr-app/mods/chat/paths.js";
import { TranscriptFollower } from "../../host/providers/claude/follow.ts";
import { historyOf } from "../../host/providers/claude/history.ts";
import { bashOf, promptText } from "../../host/providers/claude/sessions.ts";
import { Timeline } from "../../host/timeline.ts";
import { CLAUDE_TOOLS } from "../../host/providers/claude/tools.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a block's `!` lines: one after another is one run; a line of text, a placeholder or `!=` ends it", () => {
  assert.deepEqual(runsInCode("! pnpm install\n! pnpm build\n"), [["pnpm install", "pnpm build"]]);
  assert.deepEqual(runsInCode("! a\n\n! b"), [["a", "b"]], "blank lines between keep the run");
  assert.deepEqual(runsInCode("! a\necho hi\n! b"), [["a"], ["b"]]);
  assert.deepEqual(runsInCode("! sudo pacman -S \\\n  foo bar"), [["sudo pacman -S foo bar"]], "a backslash goes on");
  assert.deepEqual(runsInCode("! <command>\n!= x\n!! y\nls"), []);
  assert.deepEqual(runsInCode("echo plain"), []);
});

test("an inline `! command` is a link the chat asks about; a path is still a path; a fence is left alone", () => {
  assert.equal(bangOf("! git status"), "git status");
  assert.equal(bangOf("!=x"), null);
  const md = linkPaths("Run `! git status` then open `src/a.ts:3`.\n```\n`! not in a fence`\n```");
  assert.ok(md.includes(`[\`! git status\`](${runHref("git status")})`));
  assert.ok(md.includes("herdr-chat-file:"));
  assert.ok(md.includes("`! not in a fence`\n```"));
  assert.equal(runLink(runHref("echo 'a & b'")), "echo 'a & b'");
  assert.equal(runLink("https://example.com"), null);
});

test("a run joins with && unless a command can't be joined; the tab's script stops at the first failure", () => {
  assert.equal(oneLine(["cd web", "pnpm build"]), "cd web && pnpm build");
  assert.equal(oneLine(["ls # all", "pwd"]), null);
  assert.equal(oneLine(["echo 'open", "x"]), null);
  const noHc = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HC_")));
  const out = spawnSync("bash", ["-c", tabScript(["echo one", "false", "echo never"])], { input: "\n", encoding: "utf8", env: noHc }).stdout;
  assert.match(out, /\$ echo one\none\n/);
  assert.match(out, /\$ false\n/);
  assert.doesNotMatch(out, /never/);
  assert.match(out, /\[exit 1\] Enter closes this tab\./);
});

test("Enter closes only a marked run tab (turning keep off and killing via HC_TERMINAL_SOCKET), leaving other terminals alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-bang-close-"));
  try {
    const log = join(dir, "hc.log");
    const fakeHc = join(dir, "hc");
    writeFileSync(fakeHc, `#!/bin/sh
echo "HC_SOCKET=\${HC_SOCKET-} $*" >> ${JSON.stringify(log)}
case "$1" in
  get) printf '{"argv":["/usr/bin/fish","-ic","...","bash","-c","%s"]}\n' "$FAKE_ARGV" ;;
  keep) exit 1 ;;
  kill) exit 0 ;;
esac
`, { mode: 0o755 });
    const noHc = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HC_")));
    const baseEnv = { ...noHc, PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`, HC_TERMINAL_ID: "t99", HC_TERMINAL_SOCKET: "/tmp/disposable-core.sock" };

    // Unmarked terminal: never disables keep or kills
    spawnSync("bash", ["-c", tabScript(["echo safe"])], { input: "\n", encoding: "utf8", env: { ...baseEnv, FAKE_ARGV: "normal shell" } });
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "HC_SOCKET=/tmp/disposable-core.sock get t99 --json",
    ]);

    // Marked run tab: propagates HC_TERMINAL_SOCKET into HC_SOCKET, disables keep, and kills even if keep fails
    writeFileSync(log, "");
    const fast = tabScript(["echo done"]).replace("sleep 2", ":");
    spawnSync("bash", ["-c", fast], { input: "\n", encoding: "utf8", env: { ...baseEnv, FAKE_ARGV: RUN_MARK } });
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "HC_SOCKET=/tmp/disposable-core.sock get t99 --json",
      "HC_SOCKET=/tmp/disposable-core.sock keep t99 --off",
      "HC_SOCKET=/tmp/disposable-core.sock kill t99",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Claude Code's records for a `!` run in its TUI (bash mode).
const FILE = "/tmp/bang-test/-tmp-demo/5e1f0c2a-0000-4000-8000-000000000002.jsonl";
function session() {
  let n = 0;
  const base = () => ({ parentUuid: n ? `b${n}` : null, uuid: `b${++n}`, timestamp: `2026-11-21T10:00:${String(n).padStart(2, "0")}.000Z`, sessionId: "s", cwd: "/tmp/demo" });
  return [
    { ...base(), type: "user", message: { role: "user", content: "Is the build clean?" } },
    { ...base(), type: "assistant", message: { id: "m1", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Run it:\n```bash\n! pnpm build\n```" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } },
    { ...base(), type: "user", message: { role: "user", content: "<bash-input>pnpm build</bash-input>" } },
    { ...base(), type: "user", message: { role: "user", content: "<bash-stdout>built in 2.1 s</bash-stdout><bash-stderr></bash-stderr>" } },
    { ...base(), type: "user", message: { role: "user", content: "<bash-input>false</bash-input>" } },
    { ...base(), type: "user", message: { role: "user", content: "<bash-stdout></bash-stdout><bash-stderr>exit 1</bash-stderr>" } },
  ];
}

test("a `!` run in the TUI is a Bash card with its output, never a message of the person's", () => {
  const recs = session();
  assert.deepEqual(bashOf(recs[2]!), { input: "pnpm build" });
  assert.deepEqual(bashOf(recs[3]!), { stdout: "built in 2.1 s", stderr: "" });
  assert.equal(promptText(recs[2]!), null);
  const evs = historyOf(recs, FILE);
  assert.equal(evs.filter((e) => e.type === "user_message").length, 1);
  const calls = evs.filter((e) => e.type === "tool_call") as any[];
  const ends = evs.filter((e) => e.type === "tool_ended") as any[];
  assert.deepEqual(calls.map((c) => [c.name, c.args.command]), [["Bash", "pnpm build"], ["Bash", "false"]]);
  assert.deepEqual(ends.map((e) => [e.callId === calls[ends.indexOf(e)].callId, e.output, e.isError]), [[true, "built in 2.1 s", false], [true, "exit 1", true]]);
});

test("followed live, a `!` run shows as the history shows it", () => {
  const recs = session();
  const shape = (items: any[]) => items.map((i) => [i.kind, i.text ?? i.name ?? "", i.status ?? ""].join("|"));
  const live = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  const f = new TranscriptFollower(FILE);
  live.apply({ type: "run_started" });
  for (const ev of [...recs.flatMap((r) => f.feed(r)), ...f.close()]) live.apply(ev);
  live.apply({ type: "run_settled", aborted: false });
  const hist = new Timeline("/tmp/demo", null, CLAUDE_TOOLS);
  hist.load(historyOf(recs, FILE));
  assert.deepEqual(shape(live.items), shape(hist.items));
  assert.ok(shape(live.items).some((s) => s.startsWith("tool|")), shape(live.items).join(", "));
});

test("images the terminal view sent as @ mentions show as the message's images, in history and live", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { sentImages } = await import("../../host/providers/claude/sessions.ts");
  const d = mkdtempSync(join(tmpdir(), "herdr-chat-sent-"));
  const img = join(d, "herdr-chat-0123456789abcdef.png");
  writeFileSync(img, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  try {
    assert.deepEqual(sentImages(`@${img} @"/a b/herdr-chat-fedcba9876543210.jpg" Look at these`), { text: "Look at these", files: [img, "/a b/herdr-chat-fedcba9876543210.jpg"] });
    assert.deepEqual(sentImages("@src/upload.ts what about this"), { text: "@src/upload.ts what about this", files: [] }, "the person's own mention stays");
    const recs = [{ uuid: "i1", parentUuid: null, type: "user", timestamp: "2026-11-21T10:00:00.000Z", message: { role: "user", content: `@${img} What is this?` } }];
    const hist = historyOf(recs, FILE).find((e) => e.type === "user_message") as any;
    assert.equal(hist.text, "What is this?");
    assert.equal(hist.images, 1);
    const live = new TranscriptFollower(FILE).feed(recs[0]!).find((e) => e.type === "user_message") as any;
    assert.equal(live.text, "What is this?");
    assert.equal(live.images, 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("bangHash and findAutoRan track executed `!` commands without storing raw command text", () => {
  const key = bangKey(["  sudo   inapse-spaces   repair ", "echo ok"]);
  assert.equal(key, "sudo inapse-spaces repair\necho ok");
  const h = bangHash(key);
  assert.match(h, /^b-[0-9a-f]{8}$/);
  assert.equal(h, bangHash(key));
  assert.ok(!h.includes("repair"));

  const items = [
    { id: "m0", kind: "tool", toolCallId: "you-bash-0", name: "Bash", status: "done", detail: { type: "bash", command: "inapse-spaces repair" } },
    { id: "m1", kind: "assistant", text: "Please run:\n```\n! inapse-spaces repair\n```" },
    { id: "m2", kind: "tool", toolCallId: "you-bash-live-1", name: "Bash", status: "pending", detail: { type: "bash", command: "inapse-spaces repair" } },
  ];
  // Prior run before m1 and pending run after m1 do not count
  assert.equal(findAutoRan(items, "m1", ["inapse-spaces repair"]), null);

  // Completed you-bash card after m1 counts as automatically executed in agent
  items.push({ id: "m3", kind: "tool", toolCallId: "you-bash-live-2", name: "Bash", status: "done", detail: { type: "bash", command: "inapse-spaces   repair" } });
  assert.deepEqual(findAutoRan(items, "m1", ["inapse-spaces repair"]), { ran: true, where: "agent" });

  // Multi-command group matches either joined && or individual runs after m1
  items.push({ id: "m4", kind: "tool", toolCallId: "you-bash-3", name: "Bash", status: "done", detail: { type: "bash", command: "cd app && pnpm build" } });
  assert.deepEqual(findAutoRan(items, "m1", ["cd app", "pnpm build"]), { ran: true, where: "agent" });
});
