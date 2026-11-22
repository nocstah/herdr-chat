// The terminal view's trips to the terminal (host/providers/prompt-wait.ts) and the
// two TUIs' prompts as it reads them: Codex 0.171's from its own snapshot tests
// (codex-rs/tui, Apache-2.0), Claude Code 2.1.330's from screen.test.ts's shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForPrompt } from "../../host/providers/prompt-wait.ts";
import { codexAtPrompt } from "../../host/providers/codex/screen.ts";
import { claudeAtPrompt } from "../../host/providers/claude/screen.ts";
import { SCREENS } from "./screen.test.ts";

const fast = { everyMs: 1, openMs: 30 };
const script = (screens: (string | null)[]) => {
  let i = 0;
  return async () => screens[Math.min(i++, screens.length - 1)]!;
};
const isPrompt = (s: string) => s === "prompt";

test("waitForPrompt: back once the screen left the prompt and showed it twice; a redraw between screens doesn't count", async () => {
  assert.deepEqual(await waitForPrompt(script(["prompt", "picker", "prompt", "picker", "prompt", "prompt"]), isPrompt, { ...fast, cancelled: () => false }), { back: true });
  // a read that fails (hc read gave nothing) neither opens nor closes it
  assert.deepEqual(await waitForPrompt(script([null, "picker", null, "prompt", "prompt"]), isPrompt, { ...fast, cancelled: () => false }), { back: true });
});

test("waitForPrompt: a command that opened nothing stays (its output is in the terminal); cancelled and too long give up", async () => {
  assert.deepEqual(await waitForPrompt(script(["prompt"]), isPrompt, { ...fast, cancelled: () => false }), { back: false });
  let n = 0;
  assert.deepEqual(await waitForPrompt(script(["picker"]), isPrompt, { ...fast, cancelled: () => ++n > 5 }), { back: false });
  assert.deepEqual(await waitForPrompt(script(["picker"]), isPrompt, { ...fast, limitMs: 20, cancelled: () => false }), { back: false });
});

const CONVERSATION = "› run the tests\n\n• I'll run them now.\n\n• Ran npm test\n  └ 12 passed\n\n";
const CODEX = {
  idle: `${CONVERSATION}› Ask Codex to do anything\n\n  ? for shortcuts                                                100% context left`,
  typed: `${CONVERSATION}› and the docs too\n\n  ? for shortcuts                                                 98% context left`,
  working: `${CONVERSATION}• Working (4s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  ? for shortcuts                                                 98% context left`,
  models: `${CONVERSATION}  Select Model and Effort

↑
  4. GPT-6.1-Sol         Previous generation model for coding and everyday work.
  5. GPT-6-Astra         Previous generation model for complex coding and
                         professional work.
  8. GPT-5.6-Sol         Legacy model for coding and everyday work.
      GPT-5.6-Luna       Legacy fast model for simpler tasks.
›     GPT-5.5 (current)  Legacy coding model.

  enter select · esc back`,
  efforts: `${CONVERSATION}  Select Reasoning Level for GPT-5.5


  1. Low               Fast responses with lighter reasoning
  2. Medium (default)  Balances speed and reasoning depth for everyday tasks
› 3. High (current)    Greater reasoning depth for complex problems

  enter default · s session · esc back`,
  approval: `${CONVERSATION}  Would you like to run the following command?

  $ rm -rf build

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`,
  resume: "  Resume a previous session\n\n  Updated   Conversation\n› 2m ago    fix the tests\n  1h ago    docs\n\n  enter to resume · esc to start new · ctrl+c to quit",
};

test("codexAtPrompt: the composer with nothing over it, typed in or working; never a picker, a dialog or the resume list", () => {
  for (const k of ["idle", "typed", "working"] as const) assert.equal(codexAtPrompt(CODEX[k]), true, k);
  for (const k of ["models", "efforts", "approval", "resume"] as const) assert.equal(codexAtPrompt(CODEX[k]), false, k);
});

test("claudeAtPrompt: its input line under a rule; never a dialog, a confirm menu or the /model picker", () => {
  assert.equal(claudeAtPrompt(SCREENS.idle), true);
  for (const k of ["bash", "trust"] as const) assert.equal(claudeAtPrompt(SCREENS[k]), false, k);
  const RULE = "─".repeat(78);
  const model = [RULE, " Select model", " Switch between Claude models. Applies to this session and future Claude Code sessions.", "",
    " ❯ 1. Default (recommended) ✔  Opus 5.5 for complex work", "   2. Sonnet                   Sonnet 5.5 for daily tasks", "",
    " Enter to confirm · Esc to exit"].join("\n");
  assert.equal(claudeAtPrompt(model), false);
});
