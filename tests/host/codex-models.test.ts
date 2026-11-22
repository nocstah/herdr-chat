// The Codex terminal view's models (host/providers/codex/models.ts): Codex's own catalog
// file, the model a TUI starts on, and the refusals Codex prints for a /model line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexModels, modelAnswer, newLines, startingModel } from "../../host/providers/codex/models.ts";

const levels = (...e: string[]) => e.map((effort) => ({ effort, description: effort }));

test("codexModels: Codex's catalog in its order, hidden ones marked, [] without a file", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-chat-cm-"));
  try {
    assert.deepEqual(codexModels(home), []);
    writeFileSync(join(home, "models_cache.json"), JSON.stringify({ fetched_at: "2026-11-22", models: [
      { slug: "gpt-b", display_name: "GPT-B", description: "Fast", visibility: "list", priority: 2, default_reasoning_level: "medium", supported_reasoning_levels: levels("low", "medium"), context_window: 200000 },
      { slug: "gpt-a", display_name: "GPT-A", description: "Deep", visibility: "list", priority: 1, default_reasoning_level: "low", supported_reasoning_levels: levels("low", "medium", "high") },
      { slug: "auto-review", display_name: "Auto Review", visibility: "hide", priority: 3 },
    ] }));
    const ms = codexModels(home);
    assert.deepEqual(ms.map((m) => [m.id, m.name, m.listed, m.efforts.join("/"), m.defaultEffort]), [
      ["gpt-a", "GPT-A", true, "low/medium/high", "low"],
      ["gpt-b", "GPT-B", true, "low/medium", "medium"],
      ["auto-review", "Auto Review", false, "", null],
    ]);
    assert.equal(ms[1]!.contextWindow, 200000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("startingModel: the command line first, then config.toml's top level; nothing where a profile could choose", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-chat-cm-"));
  try {
    assert.deepEqual(startingModel(["codex"], home), { model: null, effort: null });
    writeFileSync(join(home, "config.toml"), 'model = "gpt-a"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-b"\n');
    assert.deepEqual(startingModel(["codex", "--no-daemon"], home), { model: "gpt-a", effort: "high" });
    assert.deepEqual(startingModel(["codex", "-m", "gpt-b"], home), { model: "gpt-b", effort: "high" });
    assert.deepEqual(startingModel(["codex", "-c", "model_reasoning_effort=low", "--model=gpt-b"], home), { model: "gpt-b", effort: "low" });
    assert.deepEqual(startingModel(["codex", "-p", "fast"], home), { model: null, effort: null });
    writeFileSync(join(home, "config.toml"), 'profile = "fast"\nmodel = "gpt-a"\n');
    assert.deepEqual(startingModel(["codex"], home), { model: null, effort: null });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("newLines and modelAnswer: what Codex printed for this /model, not what was on the screen before (the same words again are new)", () => {
  const before = "› hi\n\n■ Model 'gpt-x' is unavailable. Use /model to see available models.\n\n› ";
  assert.equal(modelAnswer(newLines(before, before + "/model gpt-a --reasoning=high\n\n› ")), null);
  assert.deepEqual(modelAnswer(newLines(before, `${before}\n■ Model 'gpt-x' is unavailable. Use /model to see available models.\n\n› `)), { refused: "Model 'gpt-x' is unavailable. Use /model to see available models." });
  assert.deepEqual(modelAnswer(newLines(before, `${before}\n■ Reasoning level 'ultra' is unavailable for gpt-b. Available: low, medium.\n› `)), { refused: "Reasoning level 'ultra' is unavailable for gpt-b. Available: low, medium." });
  assert.deepEqual(modelAnswer(newLines(null, "■ Session is still starting; try /model again in a moment.\n› ")), { refused: "Session is still starting; try /model again in a moment." });
  assert.deepEqual(modelAnswer(newLines(before, `${before}\n• Model changed to gpt-6 high for this session only\n\n› `)), { changed: true });
});
