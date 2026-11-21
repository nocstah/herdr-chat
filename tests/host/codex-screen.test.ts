// Codex's dialogs as the terminal view reads them (host/providers/codex/screen.ts).
// The screens are Codex 0.171's own snapshot tests (codex-rs/tui, Apache-2.0), laid
// under a bit of conversation and the composer's last lines as a terminal shows them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexMovesTo, codexPromptKey, readCodexPrompt } from "../../host/providers/codex/screen.ts";

const above = "› run the tests\n\n• I'll run them now.\n\n";

test("a command's approval: its title, what it runs, each row's shortcut", () => {
  const p = readCodexPrompt(`${above}
  Would you like to run the following command?

  Reason: this is a test reason such as one that would be produced by the model

  $ echo hello world


› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`echo hello world\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
`);
  assert.ok(p && p.kind === "approval");
  assert.equal(p.title, "Would you like to run the following command?");
  assert.equal(p.body, "Reason: this is a test reason such as one that would be produced by the model\n$ echo hello world");
  assert.deepEqual(p.rows.map((r) => [r.n, r.label, r.key, r.selected]), [
    [1, "Yes, proceed", "y", true],
    [2, "Yes, and don't ask again for commands that start with `echo hello world`", "p", false],
    [3, "No, and tell Codex what to do differently", "esc", false],
  ]);
  assert.deepEqual(codexMovesTo(p, p.rows[2]!), ["down", "down"]);
});

test("edits, network access and permissions approvals", () => {
  const patch = readCodexPrompt(`

  Would you like to make the following edits?

  Description: The model wants to apply changes
  Destination: /tmp/project/README.md


› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`);
  assert.ok(patch?.kind === "approval");
  assert.equal(patch.body, "Description: The model wants to apply changes\nDestination: /tmp/project/README.md");
  assert.deepEqual(patch.rows.map((r) => r.key), ["y", "a", "esc"]);

  const net = readCodexPrompt(`
  Do you want to approve network access to "example.com"?

  Reason: network request blocked



› 1. Yes, just this once (y)
  2. Yes, and allow this host for this conversation (a)
  3. Yes, and allow this host in the future (p)
  4. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`);
  assert.ok(net?.kind === "approval");
  assert.equal(net.title, 'Do you want to approve network access to "example.com"?');
  assert.deepEqual(net.rows.map((r) => r.key), ["y", "a", "p", "esc"]);

  const perm = readCodexPrompt(`
  Would you like to grant these permissions?

  Reason: need workspace access

  Permission rule: network; read \`/tmp/readme.txt\`; write \`/tmp/out.txt\`


› 1. Yes, grant these permissions for this turn (y)
  2. Yes, grant for this turn with strict auto review (r)
  3. Yes, grant these permissions for this session (a)
  4. No, continue without permissions (d)

  Press enter to confirm or esc to cancel`);
  assert.ok(perm?.kind === "approval");
  assert.deepEqual(perm.rows.map((r) => r.key), ["y", "r", "a", "d"]);
});

test("a question with options and None of the above; a free-form one; the plan's implement list", () => {
  const q = readCodexPrompt(`${above}
  Question 1/2 (2 unanswered)
  Choose an option.

  › 1. Option 1           First choice.
    2. Option 2           Second choice.
    3. Option 3           Third choice.
    4. None of the above  Optionally, add details in notes (tab)

  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt`);
  assert.ok(q?.kind === "question");
  assert.equal(q.progress, "Question 1/2 (2 unanswered)");
  assert.equal(q.question, "Choose an option.");
  assert.deepEqual(q.rows.map((r) => [r.label, r.description]), [["Option 1", "First choice."], ["Option 2", "Second choice."], ["Option 3", "Third choice."]]);
  assert.equal(q.other?.label, "None of the above");
  assert.equal(q.freeform, null);

  const free = readCodexPrompt(`
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)



  enter to submit answer | esc to interrupt`);
  assert.ok(free?.kind === "question");
  assert.equal(free.question, "Share details.");
  assert.equal(free.rows.length, 0);
  assert.equal(free.freeform?.input, true);
  assert.equal(free.freeform?.selected, true);

  const plan = readCodexPrompt(`  Implement this plan?


› 1. Yes, implement this plan          Switch to Default and start coding
  2. Yes, clear context and implement  Fresh thread with this plan
  3. No, stay in Plan mode             Continue planning with the model

  enter select · esc back`);
  assert.ok(plan?.kind === "choice");
  assert.deepEqual(plan.rows.map((r) => [r.label, r.description]), [
    ["Yes, implement this plan", "Switch to Default and start coding"],
    ["Yes, clear context and implement", "Fresh thread with this plan"],
    ["No, stay in Plan mode", "Continue planning with the model"],
  ]);
});

test("an MCP server's form; nothing on a plain screen; the same dialog keeps its key while the cursor moves", () => {
  const mcp = readCodexPrompt(`
  Field 1/1
  Allow Calendar to create an event

  Calendar: primary
  Title: Roadmap review

  › 1. Allow   Run the tool and continue
    2. Cancel  Cancel this tool call




  enter to submit | esc to cancel`);
  assert.ok(mcp?.kind === "choice");
  assert.equal(mcp.title, "Field 1/1");
  assert.match(mcp.body, /^Allow Calendar to create an event\nCalendar: primary/);
  assert.deepEqual(mcp.rows.map((r) => r.label), ["Allow", "Cancel"]);

  assert.equal(readCodexPrompt(`${above}› Ask Codex to do anything\n\n  ? for shortcuts            100% context left`), null);

  const a = readCodexPrompt("  Would you like to run the following command?\n\n  $ ls\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel");
  const b = readCodexPrompt("  Would you like to run the following command?\n\n  $ ls\n\n  1. Yes, proceed (y)\n› 2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel");
  assert.ok(a && b);
  assert.equal(codexPromptKey(a), codexPromptKey(b));
  assert.equal(b.stops.find((r) => r.selected)?.stop, 1);
});

test("a long row wraps onto the next line and stays one row", () => {
  const p = readCodexPrompt(`  Would you like to run the following command?

  $ npm test

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`npm test --
     workspace=packages/one\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`);
  assert.ok(p?.kind === "approval");
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[1]!.label, "Yes, and don't ask again for commands that start with `npm test -- workspace=packages/one`");
  assert.equal(p.rows[1]!.key, "p");
});
