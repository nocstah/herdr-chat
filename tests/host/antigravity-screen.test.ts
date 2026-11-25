// Antigravity CLI's TUI screen reader (host/providers/antigravity/screen.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { agyAtPrompt, agyInShellMode, agyMovesTo, agyPromptKey, extractAgyShellOutput, parseAgyPermissionBody, parseAgyShellExitCode, readAgyInterrupted, readAgyPrompt, readAgyQuotaWarning, readAgySendNowKey, readAgyStatusBar, readAgyWorkingStatus, screenShowsAgyShellRunning, stripAgyTerminalChrome } from "../../host/providers/antigravity/screen.ts";

const IDLE_AUTO = `
────────────────────────────────────────────────────────────────────────
 ┃ Introducing Gemini 4 Neon
 ┃ esc to dismiss
────────────────────────────────────────────────────────────────────────
> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)
────────────────────────────────────────────────────────────────────────
? for shortcuts                               auto · Gemini 4 Neon · xhigh
`;

const IDLE_DEFAULT = `
────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────
? for shortcuts                                      Gemini 4 Neon · xhigh
`;

const MODEL_OVERLAY = `
────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────
Switch Model
  Search:
───────── ────────────────────
> Gemini 4 Neon         (current)
  Gemini 4 Argon
Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back
                                        accept-edits · Gemini 4 Neon · xhigh
`;

const TRUST_DIALOG = `Accessing workspace:
/tmp/agy-untrusted-q78_ke6l
Do you trust the contents of this project?
Antigravity CLI requires permission to read, edit, and execute files here.
> Yes, I trust this folder
  No, exit
  ↑/↓ Navigate · enter Confirm
                                              auto · Gemini 4 Neon · xhigh`;

const EDIT_DIALOG = `────────────────────────────────────────────────────────────────────────
Edit src/app.ts
  - const a = 1;
  + const a = 2;

Accept this file edit?
> 1. Yes, accept this change
  2. No, reject this change
  Press 1-2, enter to confirm, tab to reject with feedback, f to view full diff`;

const CREATE_DIALOG = `Create file
src/utils/formatter.py
  + export const fmt = () => "";

Allow creation of this file?
> 1. Yes, allow creation
  2. No, deny creation`;

const QUESTION_DIALOG = `Question 1/2
Which database should we use?
> 1. Postgres           Primary relational store
  2. SQLite             Zero-config embedded DB
  3. Other (write your answer)
  ↑/↓ Navigate · enter to select · esc to cancel`;

const MULTI_QUESTION = `Question 1/1
Which checks should run?
> 1. [x] Unit tests
  2. [ ] Lint
  3. [ ] Typecheck
  Submit
  space to toggle · enter to submit · esc to cancel`;

test("readAgyStatusBar reads mode, model and effort across all modes", () => {
  assert.deepEqual(readAgyStatusBar(IDLE_AUTO), { mode: "auto", modelName: "Gemini 4 Neon", effort: "xhigh" });
  assert.deepEqual(readAgyStatusBar(IDLE_DEFAULT), { mode: "default", modelName: "Gemini 4 Neon", effort: "xhigh" });
  assert.deepEqual(
    readAgyStatusBar("? for shortcuts          accept-edits · Gemini 3.8 Flash · high"),
    { mode: "accept-edits", modelName: "Gemini 3.8 Flash", effort: "high" },
  );
  assert.deepEqual(
    readAgyStatusBar("esc to cancel            plan · Orchestrator (Neon)"),
    { mode: "plan", modelName: "Orchestrator (Neon)", effort: null },
  );
  assert.deepEqual(
    readAgyStatusBar("  Press up to edit queued messages                         Orchestrator (Neon)"),
    { mode: "default", modelName: "Orchestrator (Neon)", effort: null },
  );
});

test("agyAtPrompt distinguishes idle prompt from overlays and blocking dialogs", () => {
  assert.equal(agyAtPrompt(IDLE_AUTO), true);
  assert.equal(agyAtPrompt(IDLE_DEFAULT), true);
  assert.equal(agyAtPrompt(MODEL_OVERLAY), false);
  assert.equal(agyAtPrompt(TRUST_DIALOG), false);
  assert.equal(agyAtPrompt(EDIT_DIALOG), false);
});

test("readAgyPrompt parses workspace trust, edit/create approvals, and single/multi questions", () => {
  const trust = readAgyPrompt(TRUST_DIALOG);
  assert.ok(trust && trust.kind === "confirm");
  assert.equal(trust.title, "Do you trust the contents of this project?");
  assert.match(trust.body, /\/tmp\/agy-untrusted/);
  assert.deepEqual(trust.rows.map((r) => [r.label, r.selected]), [
    ["Yes, I trust this folder", true],
    ["No, exit", false],
  ]);
  assert.deepEqual(agyMovesTo(trust, trust.rows[1]!), ["down"]);

  const edit = readAgyPrompt(EDIT_DIALOG);
  assert.ok(edit && edit.kind === "permission");
  assert.equal(edit.title, "Accept this file edit?");
  assert.match(edit.body, /Edit src\/app\.ts/);
  assert.deepEqual(edit.rows.map((r) => [r.n, r.label, r.selected]), [
    [1, "Yes, accept this change", true],
    [2, "No, reject this change", false],
  ]);
  // Key stays stable when cursor moves.
  const moved = readAgyPrompt(EDIT_DIALOG.replace("> 1.", "  1.").replace("  2.", "> 2."));
  assert.ok(moved);
  assert.equal(agyPromptKey(moved!), agyPromptKey(edit));

  const create = readAgyPrompt(CREATE_DIALOG);
  assert.ok(create && create.kind === "permission");
  assert.equal(create.title, "Allow creation of this file?");
  assert.equal(create.rows.length, 2);

  const q = readAgyPrompt(QUESTION_DIALOG);
  assert.ok(q && q.kind === "question");
  assert.equal(q.progress, "Question 1/2");
  assert.equal(q.question, "Which database should we use?");
  assert.deepEqual(q.rows.map((r) => [r.label, r.description]), [
    ["Postgres", "Primary relational store"],
    ["SQLite", "Zero-config embedded DB"],
  ]);
  assert.ok(q.other && q.other.input);

  const mq = readAgyPrompt(MULTI_QUESTION);
  assert.ok(mq && mq.kind === "question");
  assert.equal(mq.multi, true);
  assert.deepEqual(mq.rows.map((r) => [r.label, r.checked]), [
    ["Unit tests", true],
    ["Lint", false],
    ["Typecheck", false],
  ]);
  assert.equal(mq.submit?.label, "Submit");

  // Regular markdown numbered list at idle prompt is NOT a dialog.
  assert.equal(readAgyPrompt("Here are two steps:\n1. Build\n2. Test\n" + IDLE_DEFAULT), null);
});

test("readAgyPrompt parses Antigravity 1.5 single-line Question N/M and Write-in... rows", () => {
  const ask15 = `Question
────────────────────────────────────────────────────────────────────────

Question 1/1: Which file would you like to create?

> 1. (Recommended) hello.txt
  2. bye.txt
  3. Write-in...

  ↑/↓ Navigate · enter Select · esc Skip
esc to cancel                                        Gemini 3.8 Flash · high`;

  const q = readAgyPrompt(ask15);
  assert.ok(q && q.kind === "question");
  assert.equal(q.progress, "Question 1/1");
  assert.equal(q.question, "Which file would you like to create?");
  assert.deepEqual(q.rows.map((r) => [r.n, r.label, r.selected]), [
    [1, "(Recommended) hello.txt", true],
    [2, "bye.txt", false],
  ]);
  assert.ok(q.other && q.other.input && q.other.label === "Write-in...");
  assert.equal(q.multi, false);

  const multi15 = `Question
────────────────────────────────────────────────────────────────────────

Question 1/2: Which targets would you like to build
for this release?

  1. [ ] (Recommended) Desktop
▸ 2. [x] Mobile
  3. [ ] Web
  4. Write-in...

  ↑/↓ Navigate · → Next · space Toggle · enter Submit · esc Skip
esc to cancel                                        Gemini 3.8 Flash · high`;

  const mq = readAgyPrompt(multi15);
  assert.ok(mq && mq.kind === "question");
  assert.equal(mq.progress, "Question 1/2");
  assert.equal(mq.question, "Which targets would you like to build for this release?");
  assert.equal(mq.multi, true);
  assert.equal(mq.submit, null);
  assert.deepEqual(mq.rows.map((r) => [r.label, r.selected, r.checked]), [
    ["(Recommended) Desktop", false, false],
    ["Mobile", true, true],
    ["Web", false, false],
  ]);
  assert.ok(mq.other && mq.other.input && mq.other.label === "Write-in...");
});

test("readAgyQuotaWarning reads active quota warning above idle composer and ignores stale/quoted/non-quota screens", () => {
  const quotaScreen = `● Ran (bun test) (ctrl+o to expand)

⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in
1h50m10s.
Error ID: 0b64d408-0b25-43c1-90a3-095569e7b843-235

────────────────────────────────────────────────────────────────────────
>
────────────────────────────────────────────────────────────────────────
? for shortcuts                               auto · Gemini 4 Neon · xhigh`;

  const w = readAgyQuotaWarning(quotaScreen);
  assert.ok(w);
  assert.equal(w.title, "Quota reached");
  assert.equal(w.message, "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h50m10s.");
  assert.equal(w.errorId, "0b64d408-0b25-43c1-90a3-095569e7b843-235");

  // Narrow wrapped Error ID and wrapped status row.
  const narrow = `⚠ Individual quota reached. Please upgrade your
subscription to increase your limits. Resets in
1h50m10s.
Error ID: 0b64d408-0b25-43c1-90a3-
095569e7b843-235

────────────────────────────────────────
>
────────────────────────────────────────
? for shortcuts
auto · Gemini 4 Neon · xhigh`;
  const wn = readAgyQuotaWarning(narrow);
  assert.ok(wn);
  assert.equal(wn.errorId, "0b64d408-0b25-43c1-90a3-095569e7b843-235");
  assert.equal(wn.id, w.id);

  // Active turn (`esc to cancel`), stale warning before a newer turn, indented quote, and context window limit return null.
  assert.equal(readAgyQuotaWarning(quotaScreen.replace("? for shortcuts", "esc to cancel")), null);
  assert.equal(readAgyQuotaWarning(`${quotaScreen.split("────")[0]}\n> Try again\n\nAll good.\n${IDLE_DEFAULT}`), null);
  assert.equal(readAgyQuotaWarning(`  ⚠ Individual quota reached.\n${IDLE_DEFAULT}`), null);
  assert.equal(readAgyQuotaWarning(`⚠ Context window limit reached.\n${IDLE_DEFAULT}`), null);
  assert.equal(readAgyQuotaWarning(EDIT_DIALOG), null);
});

test("parseAgyPermissionBody separates Reason from Requesting permission for command and unwraps mid-path breaks", () => {
  const systemdScreen = [
    "────────────────────────────────────────────────────────────────────────",
    "Reason: Restarting the pre-existing systemd user service omarelay.service stops and restarts a host-configured",
    "service process that was not created by the agent in this session. Requesting permission for: systemctl --user restart",
    "omarelay.service && systemctl --user status omarelay.service --no-pager -n 12 && systemctl --user list-units --all",
    "--no-legend 'hc-shutdown-*'",
    "",
    "Run this command?",
    "> 1. Yes, run command",
    "  2. No, cancel",
    "  ↑/↓ Navigate · enter Confirm · esc Cancel",
  ].join("\n");
  const p1 = readAgyPrompt(systemdScreen);
  assert.ok(p1 && p1.kind === "permission");
  assert.equal(p1.title, "Run this command?");
  const d1 = parseAgyPermissionBody(p1.title, p1.body);
  assert.equal(
    d1.reason,
    "Restarting the pre-existing systemd user service omarelay.service stops and restarts a host-configured service process that was not created by the agent in this session.",
  );
  assert.equal(
    d1.command,
    "systemctl --user restart omarelay.service && systemctl --user status omarelay.service --no-pager -n 12 && systemctl --user list-units --all --no-legend 'hc-shutdown-*'",
  );

  // Mid-path wrap (`/omarelay\n/scripts`) rejoins without inserting a stray space.
  const wrappedPath = [
    "Reason: Overriding ovis.SHUTDOWN_AT_START = set() causes ovis.stop_left_shutdown_units() to run systemctl --user",
    "stop on pre-existing hc-shutdown-* transient systemd user units. Requesting permission for: python3 -c \"import sys; sys.path.insert(0, '/home/noc/code/omarelay",
    "/scripts'); import ovis; print('OK')\"",
  ].join("\n");
  const d2 = parseAgyPermissionBody("Run this command?", wrappedPath);
  assert.equal(d2.reason, "Overriding ovis.SHUTDOWN_AT_START = set() causes ovis.stop_left_shutdown_units() to run systemctl --user stop on pre-existing hc-shutdown-* transient systemd user units.");
  assert.equal(d2.command, `python3 -c "import sys; sys.path.insert(0, '/home/noc/code/omarelay/scripts'); import ovis; print('OK')"`);

  // Requesting permission without Reason, and bare command body under a command title.
  assert.deepEqual(parseAgyPermissionBody("Run this command?", "Requesting permission for: git push origin main"), {
    command: "git push origin main",
    reason: null,
    body: "Requesting permission for: git push origin main",
  });
  assert.equal(parseAgyPermissionBody("Run this command?", "rm -rf dist").command, "rm -rf dist");

  // Non-command edit diff stays unstructured.
  const editParsed = parseAgyPermissionBody("Accept this file edit?", "Edit src/app.ts\n  - const a = 1;\n  + const a = 2;");
  assert.equal(editParsed.command, null);
  assert.equal(editParsed.reason, null);
});

test("readAgyWorkingStatus reads live braille-spinner status/thinking ticker and rejects idle, stale, dialog and overlay screens", () => {
  const workingScreen = [
    '● Ran (echo "PATH=$PATH" && ls -la /home/noc/.local/bin/agentctl 2>&1 || true) (ctrl+o to expand)',
    "⣿ The `usage.test.ts` file seems crucial to understanding the path resolution logic as the tests configure environment variables directly. Reviewing the test cases provides critical insights into...",
    "│ Tip: Use /settings to configure your preferred model",
    "",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(
    readAgyWorkingStatus(workingScreen),
    "The `usage.test.ts` file seems crucial to understanding the path resolution logic as the tests configure environment variables directly. Reviewing the test cases provides critical insights into...",
  );

  // Narrow terminal with wrapped spinner text, wrapped Tip, and 2-row wrapped status bar.
  const narrowWrapped = [
    "● Ran (npm test) (ctrl+o to expand)",
    "⣷ The `usage.test.ts` file seems crucial to understanding the path",
    "  resolution logic as the tests configure environment variables",
    "  directly...",
    "│ Tip: Use /settings to configure your default model and",
    "  effort settings at any time.",
    "────────────────────────────────────────",
    ">",
    "────────────────────────────────────────",
    "esc to cancel",
    "auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(
    readAgyWorkingStatus(narrowWrapped),
    "The `usage.test.ts` file seems crucial to understanding the path resolution logic as the tests configure environment variables directly...",
  );

  // Compact layout without a composer box (spinner directly above status bar).
  const noComposer = [
    "● Read host/chat.ts",
    "⠋ Thinking...",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyWorkingStatus(noComposer), "Thinking...");

  // Idle prompt with stale braille spinner in scrollback -> null.
  assert.equal(readAgyWorkingStatus(`⠋ Installing packages...\n${IDLE_AUTO}`), null);

  // Stale spinner above a newer completed tool call -> null.
  const staleAboveTool = [
    "⠋ Checking tests...",
    "● Ran (npm test) (ctrl+o to expand)",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyWorkingStatus(staleAboveTool), null);

  // Collapsed finished thought (`▸ Thought for 6s`) without an active spinner -> null.
  const collapsedThought = [
    "▸ Thought for 6s, 492 tokens",
    "  Initial hypothesis: The task requires determining the preferred file name...",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyWorkingStatus(collapsedThought), null);

  // Box-corner `└ Tip:` callout under spinner must be skipped (Antigravity 1.5.15+).
  const cornerTip = [
    "○ Exploring 1 file (antigravity-terminal.test.ts) (ctrl+o to expand)",
    "⣯  Running command...",
    "└ Tip: Press ctrl+g to open an external editor for long prompts.",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyWorkingStatus(cornerTip), "Running command...");

  // Blocking dialogs and overlays -> null.
  assert.equal(readAgyWorkingStatus(EDIT_DIALOG), null);
  assert.equal(readAgyWorkingStatus(QUESTION_DIALOG), null);
  assert.equal(readAgyWorkingStatus(MODEL_OVERLAY), null);
});

test("readAgyInterrupted catches idle interruption banner and ignores active turns, user prompts and prose", () => {
  const plain = [
    "● Explored 6 files (antigravity-screen.test.ts, main.js, cards.js, +3) (ctrl+o to expand)",
    "Interrupted · What should Antigravity CLI do instead?",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                             auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyInterrupted(plain), "Interrupted · What should Antigravity CLI do instead?");

  const prefixedAndWrapped = [
    "● Ran (npm test) (ctrl+o to expand)",
    "⎿  Interrupted · What should Antigravity CLI",
    "   do instead?",
    "└ Tip: Press ctrl+g to open an external editor",
    "────────────────────────────────────────",
    ">",
    "────────────────────────────────────────",
    "? for shortcuts",
    "auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyInterrupted(prefixedAndWrapped), "Interrupted · What should Antigravity CLI do instead?");

  const userTypedIt = [
    "────────────────────────────────────────────────────────────────────────",
    "> Interrupted · What should Antigravity CLI do instead?",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                             auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyInterrupted(userTypedIt), null);

  const prose = [
    "The user interrupted the build earlier.",
    "Interrupted · What should Antigravity CLI do instead?",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                             auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyInterrupted(prose), null);

  const working = [
    "Interrupted · What should Antigravity CLI do instead?",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgyInterrupted(working), null);
  assert.equal(readAgyInterrupted(IDLE_AUTO), null);
  assert.equal(readAgyInterrupted(EDIT_DIALOG), null);
  assert.equal(readAgyInterrupted(MODEL_OVERLAY), null);
});

test("agyInShellMode detects active `!` bash mode and rejects normal prompt, drafts, overlays and dialogs", () => {
  const shellEmpty = `────────────────────────────────────────────────────────────────────────
!
────────────────────────────────────────────────────────────────────────
 activated bash mode · esc to cancel        auto · Gemini 4 Neon · xhigh`;
  const shellTyped = `────────────────────────────────────────────────────────────────────────
! echo hello
────────────────────────────────────────────────────────────────────────
 activated bash mode · esc to cancel        auto · Gemini 4 Neon · xhigh`;
  const normalDraft = `────────────────────────────────────────────────────────────────────────
> !echo hello
────────────────────────────────────────────────────────────────────────
? for shortcuts                             auto · Gemini 4 Neon · xhigh`;
  assert.equal(agyInShellMode(shellEmpty), true);
  assert.equal(agyInShellMode(shellTyped), true);
  assert.equal(agyInShellMode(IDLE_AUTO), false);
  assert.equal(agyInShellMode(IDLE_DEFAULT), false);
  assert.equal(agyInShellMode(normalDraft), false);
  assert.equal(agyInShellMode(MODEL_OVERLAY), false);
  assert.equal(agyInShellMode(EDIT_DIALOG), false);
});

test("readAgySendNowKey reads default and custom immediate-send hints from the queued-messages box", () => {
  const withHint = (hint: string) => [
    "⠋ Running tests...",
    `Queued (1) ${hint}`,
    "  fix the lint error",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.equal(readAgySendNowKey(withHint("(alt+m to send immediately)")), "alt+m");
  assert.equal(readAgySendNowKey(withHint("(ctrl+m to send immediately)")), "ctrl+m");
  assert.equal(readAgySendNowKey(withHint("(⌥m to send immediately)")), "alt+m");
  assert.equal(readAgySendNowKey(withHint("(Ctrl+Enter to send immediately)")), "ctrl+enter");
  assert.equal(readAgySendNowKey(withHint("(not a valid key to send immediately)")), null);
  assert.equal(readAgySendNowKey(IDLE_AUTO), null);
});

test("extractAgyShellOutput strips TUI chrome, Tips, ANSI escapes, and command echo while capturing live and finished output", () => {
  const before = [
    "Ready to install:",
    "! sample-install --from ./dist",
    "│ Tip: Press ctrl+o to expand",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                             auto · Gemini 4 Neon · xhigh",
  ].join("\n");

  const running = [
    "Ready to install:",
    "! sample-install --from ./dist",
    "! sample-install --from ./dist",
    "\x1b[32mUnpacking archive...\x1b[0m",
    "⠋ Running command... 1s",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel                               auto · Gemini 4 Neon · xhigh",
  ].join("\n");

  const done = [
    "Ready to install:",
    "! sample-install --from ./dist",
    "! sample-install --from ./dist",
    "\x1b[32mUnpacking archive...\x1b[0m",
    "Installed sample-app 1.0.0",
    "│ Tip: Use /model to switch models",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                             auto · Gemini 4 Neon · xhigh",
  ].join("\n");

  assert.deepEqual(stripAgyTerminalChrome(before), ["Ready to install:", "! sample-install --from ./dist"]);
  assert.equal(screenShowsAgyShellRunning(running), true);
  assert.equal(screenShowsAgyShellRunning(done), false);

  const mid = extractAgyShellOutput(before, running, "sample-install --from ./dist");
  assert.deepEqual(mid, { output: "Unpacking archive...", exitCode: null, running: true });

  const fin = extractAgyShellOutput(before, done, "sample-install --from ./dist");
  assert.deepEqual(fin, { output: "Unpacking archive...\nInstalled sample-app 1.0.0", exitCode: null, running: false });

  // Unchanged screen produces empty output.
  assert.equal(extractAgyShellOutput(before, before, "sample-install --from ./dist").output, "");

  // Wrapped command echo + scrolled-past baseline falls back cleanly to command echo.
  const longCmd = "sample-tool --workspace /tmp/example-project --flag alpha --output build/out.tar.gz";
  const scrolled = [
    "! sample-tool --workspace /tmp/example-project --flag",
    "  alpha --output build/out.tar.gz",
    "step 1 ok",
    "Exit code: 2",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts                             auto · Gemini 4 Neon · xhigh",
  ].join("\n");
  assert.deepEqual(extractAgyShellOutput(before, scrolled, longCmd), {
    output: "step 1 ok\nExit code: 2",
    exitCode: 2,
    running: false,
  });

  // Explicit exit code parsing variants.
  assert.equal(parseAgyShellExitCode("ok\n[exit 0]"), 0);
  assert.equal(parseAgyShellExitCode("error: missing file\nProcess exited with code 127"), 127);
  assert.equal(parseAgyShellExitCode("Command exited with code 1."), 1);
  assert.equal(parseAgyShellExitCode("all good"), null);
});
