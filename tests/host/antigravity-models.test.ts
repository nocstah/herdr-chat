// Antigravity CLI's models, effort tiers, startup state and inline command replies (models.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandAnswer, findModelGroup, newLines, parseModelsOutput, startingState } from "../../host/providers/antigravity/models.ts";

const SAMPLE_OUTPUT = `\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high              Gemini 4 Neon (High)
gemini-4-neon-xhigh             Gemini 4 Neon (XHigh)
gemini-4-neon-medium            Gemini 4 Neon (Medium)
gemini-4-neon-low               Gemini 4 Neon (Low)
gemini-pro-orchestrator-neon    Orchestrator (Neon)
gemini-3.8-flash-high           Gemini 3.8 Flash (High)
gemini-3.8-flash-medium         Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low            Gemini 3.8 Flash (Low)
claude-opus-5-5-low             Claude Opus 5.5 (Low)
claude-opus-5-5-medium          Claude Opus 5.5 (Medium)
claude-opus-5-5-high            Claude Opus 5.5 (High)
gpt-oss-120b-medium             GPT-OSS 120B (Medium)
`;

test("parseModelsOutput groups multi-effort models and keeps single-variant models fixed", () => {
  const groups = parseModelsOutput(SAMPLE_OUTPUT);
  assert.deepEqual(groups.map((g) => g.baseId), [
    "gemini-4-neon",
    "gemini-pro-orchestrator-neon",
    "gemini-3.8-flash",
    "claude-opus-5-5",
    "gpt-oss-120b-medium",
  ]);

  const neon = findModelGroup(groups, "gemini-4-neon-xhigh")!;
  assert.equal(neon.name, "Gemini 4 Neon");
  assert.equal(neon.provider, "google");
  assert.deepEqual(neon.efforts, ["low", "medium", "high", "xhigh"]);
  assert.equal(neon.defaultEffort, "high");
  assert.equal(neon.defaultId, "gemini-4-neon-high");
  assert.equal(neon.variants.xhigh, "gemini-4-neon-xhigh");

  const orch = findModelGroup(groups, "Orchestrator (Neon)")!;
  assert.deepEqual(orch.efforts, []);
  assert.equal(orch.defaultId, "gemini-pro-orchestrator-neon");

  const opus = findModelGroup(groups, "claude-opus-5-5")!;
  assert.equal(opus.provider, "anthropic");
  assert.deepEqual(opus.efforts, ["low", "medium", "high"]);

  const gpt = findModelGroup(groups, "gpt-oss-120b-medium")!;
  assert.equal(gpt.provider, "openai");
  assert.equal(gpt.name, "GPT-OSS 120B (Medium)");
  assert.deepEqual(gpt.efforts, []);
});

test("startingState reads argv flags over settings.json", () => {
  const d = mkdtempSync(join(tmpdir(), "hc-agy-models-"));
  try {
    writeFileSync(join(d, "settings.json"), JSON.stringify({ model: "Gemini 4 Neon (XHigh)", agentMode: "accept-edits" }));
    assert.deepEqual(startingState(["agy"], d), { model: "Gemini 4 Neon (XHigh)", effort: "xhigh", mode: "accept-edits" });
    assert.deepEqual(
      startingState(["agy", "--model", "gemini-3.8-flash-medium", "--mode=plan"], d),
      { model: "gemini-3.8-flash-medium", effort: "medium", mode: "plan" },
    );
    assert.deepEqual(
      startingState(["agy", "--effort", "low"], d),
      { model: "Gemini 4 Neon (XHigh)", effort: "low", mode: "accept-edits" },
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("commandAnswer detects inline /model and /effort refusals", () => {
  const before = "> \n? for shortcuts   auto · Gemini 3.8 Flash · high";
  const after = `${before}\n> /effort turbo\n  ⎿  Invalid effort "turbo" (valid: low, medium, high, xhigh, max)`;
  assert.deepEqual(commandAnswer(newLines(before, after)), { refused: 'Invalid effort "turbo" (valid: low, medium, high, xhigh, max)' });

  assert.deepEqual(
    commandAnswer(['gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)']),
    { refused: 'gemini-3.8-flash has no "xhigh" effort (available: low, medium, high)' },
  );
  assert.deepEqual(
    commandAnswer(['  ⎿  Invalid model "bogus" (available: gemini-3.8-flash-high)']),
    { refused: 'Invalid model "bogus" (available: gemini-3.8-flash-high)' },
  );
});
