// Antigravity CLI's TUI screen reader (host/providers/antigravity/screen.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { agyAtPrompt, agyMovesTo, agyPromptKey, readAgyPrompt, readAgyStatusBar } from "../../host/providers/antigravity/screen.ts";

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
