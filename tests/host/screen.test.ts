// Claude Code's dialogs read from its screen (host/providers/claude/screen.ts),
// on screens written in the shapes Claude Code 2.1.330 draws, and the terminal
// view's cards and answers (keys) against a fake hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { movesTo, promptKey, readClaudeSendNowKeys, readPrompt } from "../../host/providers/claude/screen.ts";

const RULE = "─".repeat(78);
const DASH = "╌".repeat(78);
const FOOT = `${"─".repeat(60)} tidy-up ─`;

export const SCREENS = {
  bash: [
    "● Bash(rm -rf build/)", "  ⎿  Waiting…", "", RULE,
    " Bash command",
    ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
    " Remove the build folder", DASH, " rm -rf build/", DASH,
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to /tmp/demo from this project",
    "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
    "   4. No", "", " Esc to cancel · Tab to amend", FOOT,
  ].join("\n"),
  edit: [
    "● Write(notes.txt)", "", RULE, " Overwrite file", " notes.txt", DASH,
    "  1  first", "  2 -second", "  2 +second line", DASH,
    " Do you want to overwrite notes.txt?",
    " ❯ 1. Yes",
    "   2. Yes, and switch to accept edits (auto-approve file edits and common file",
    "      commands) for this session (shift+tab)",
    "   3. No", "", " Esc to cancel · Tab to amend", FOOT,
  ].join("\n"),
  plan: [
    "● Updated plan", "  ⎿  /plan to preview", "", RULE, " Ready to code?", " Here is Claude's plan:", DASH,
    " Plan: tidy the notes", " - Sort the lines", " - Drop the blank ones", DASH, RULE,
    " Claude has written up a plan and is ready to execute. Would you like to proceed?",
    " ❯ 1. Yes, and use auto mode",
    "   2. Yes, manually approve edits",
    "   3. Tell Claude what to change",
    "      shift+tab to approve with this feedback", "",
    " ctrl+g to edit in vim · ~/.claude/plans/tidy-the-notes.md",
  ].join("\n"),
  one: [
    "❯ Ask me about the fruit", RULE, " ☐ Fruit", "", "Which fruit?", "",
    "❯ 1. Apple", "     Crisp and sweet", "  2. Pear", "  3. Type something.", RULE,
    "  4. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to cancel", FOOT,
  ].join("\n"),
  tabs: [
    RULE, "←  ☒ Colour  ☐ Pages  ✔ Submit  →", "", "Which pages need it?", "",
    "  1. [✔] Home", "❯ 2. [ ] About", "  3. [ ] Contact", "  4. [ ] Type something", "     Submit", RULE,
    "  5. Chat about this", "", "Enter to select · Tab/Arrow keys to navigate · Esc to cancel", FOOT,
  ].join("\n"),
  review: [
    RULE, "←  ☒ Colour  ☒ Pages  ✔ Submit  →", "", "Review your answers", "",
    " ● Which colour for the header?", "   → Blue", " ● Which pages need it?", "   → Home, Contact", "",
    "❯ 1. Submit answers", "  2. Cancel", FOOT,
  ].join("\n"),
  trust: [
    RULE, " Accessing workspace:", "", " /tmp/demo", "", " Quick safety check: is this a project you trust?", "",
    " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel",
  ].join("\n"),
  idle: ["● Done. Three steps:", "  1. Sort", "  2. Dedupe", "", RULE, "❯ ", RULE, "  ⏸ manual mode on · ? for shortcuts"].join("\n"),
};

test("a tool's permission prompt: its title, what it runs as code, its rows", () => {
  const p = readPrompt(SCREENS.bash)!;
  assert.equal(p.kind, "permission");
  if (p.kind !== "permission") return;
  assert.equal(p.title, "Bash command");
  assert.equal(p.question, "Do you want to proceed?");
  assert.equal(p.body, "Remove the build folder\n```\nrm -rf build/\n```", "the tip left out");
  assert.deepEqual(p.rows.map((r) => r.label), ["Yes", "Yes, and always allow access to /tmp/demo from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
  assert.deepEqual(movesTo(p, p.rows[3]!), ["down", "down", "down"]);
});

test("an edit's prompt keeps its diff, and a wrapped row is one label", () => {
  const p = readPrompt(SCREENS.edit)!;
  assert.equal(p.kind, "permission");
  if (p.kind !== "permission") return;
  assert.equal(p.title, "Overwrite file");
  assert.match(p.body, /^notes\.txt\n```\n 1  first\n 2 -second\n 2 \+second line\n```$/);
  assert.equal(p.rows[1]!.label, "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)");
});

test("a plan's approval: the plan in its box, its file, the row that takes what to change", () => {
  const p = readPrompt(SCREENS.plan)!;
  assert.equal(p.kind, "plan");
  if (p.kind !== "plan") return;
  assert.equal(p.body, "Plan: tidy the notes\n- Sort the lines\n- Drop the blank ones");
  assert.equal(p.planFile, "~/.claude/plans/tidy-the-notes.md");
  assert.deepEqual(p.rows.map((r) => [r.label, r.input ?? false]), [["Yes, and use auto mode", false], ["Yes, manually approve edits", false], ["Tell Claude what to change", true]]);
  assert.equal(p.rows[2]!.description, "shift+tab to approve with this feedback");
});

test("one question: its chip, its options with descriptions, Type something, not Chat about this", () => {
  const p = readPrompt(SCREENS.one)!;
  assert.equal(p.kind, "question");
  if (p.kind !== "question") return;
  assert.equal(p.header, "Fruit");
  assert.equal(p.question, "Which fruit?");
  assert.deepEqual(p.rows.map((r) => [r.label, r.description ?? null]), [["Apple", "Crisp and sweet"], ["Pear", null], ["Type something.", null]]);
  assert.equal(p.other, p.rows[2]);
  assert.equal(p.multi, false);
});

test("a multiple choice among tabs: its boxes, its Submit row, the cursor's stop", () => {
  const p = readPrompt(SCREENS.tabs)!;
  assert.equal(p.kind, "question");
  if (p.kind !== "question") return;
  assert.deepEqual(p.tabs, [{ label: "Colour", answered: true }, { label: "Pages", answered: false }]);
  assert.equal(p.multi, true);
  assert.deepEqual(p.rows.map((r) => [r.label, r.checked]), [["Home", true], ["About", false], ["Contact", false], ["Type something", false]]);
  assert.equal(p.submit?.stop, 4);
  assert.deepEqual(movesTo(p, p.submit!), ["down", "down", "down"]);
  assert.deepEqual(movesTo(p, p.rows[0]!), ["up"]);
  // Moving the cursor or ticking a box doesn't make it another dialog.
  const moved = readPrompt(SCREENS.tabs.replace("  1. [✔] Home", "❯ 1. [ ] Home").replace("❯ 2. [ ] About", "  2. [ ] About"))!;
  assert.equal(promptKey(moved), promptKey(p));
});

test("the review of the answers, and a confirm menu's plain rows", () => {
  const r = readPrompt(SCREENS.review)!;
  assert.equal(r.kind, "review");
  if (r.kind === "review") assert.deepEqual(r.answers, [{ question: "Which colour for the header?", answer: "Blue" }, { question: "Which pages need it?", answer: "Home, Contact" }]);
  const c = readPrompt(SCREENS.trust)!;
  assert.equal(c.kind, "confirm");
  if (c.kind !== "confirm") return;
  assert.equal(c.title, "Accessing workspace:");
  assert.deepEqual(c.rows.map((x) => [x.label, x.selected]), [["No, exit", true], ["Yes, I trust this folder", false]]);
});

test("no dialog: a numbered list in an answer isn't one", () => {
  assert.equal(readPrompt(SCREENS.idle), null);
  assert.equal(readPrompt(""), null);
});

test("readClaudeSendNowKeys parses keyboard hints and ignores mouse-only hints", () => {
  const screen = (hint: string) => [
    "● Running tests…",
    `  ⎿  Queued · ${hint}`,
    RULE,
    "❯ ",
    RULE,
  ].join("\n");
  assert.deepEqual(readClaudeSendNowKeys(screen("ctrl+x ctrl+s send now")), ["ctrl+x", "ctrl+s"]);
  assert.deepEqual(readClaudeSendNowKeys(screen("ctrl+enter send now")), ["ctrl+enter"]);
  assert.deepEqual(readClaudeSendNowKeys(screen("meta+m send now")), ["alt+m"]);
  assert.equal(readClaudeSendNowKeys(screen("click to send now")), null);
  assert.equal(readClaudeSendNowKeys(SCREENS.idle), null);
});
