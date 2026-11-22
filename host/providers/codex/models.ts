// The terminal view's model picker for a Codex TUI (terminal.ts): the models its own
// /model picker lists, from the catalog the TUI last fetched ($CODEX_HOME/models_cache.json,
// the same file Codex 0.171 reads it from), and the model it starts on before its
// rollout says (its command line, else config.toml). A pick is typed into the TUI as
// `/model <model> --reasoning=<level>` (Codex 0.171 takes them inline:
// codex-rs/tui/src/chatwidget/model_command.rs), so no picker opens there.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type CodexModel = {
  id: string;
  name: string;
  description: string;
  /** Shown in Codex's picker (visibility "list"); a hidden one only when it's the current model. */
  listed: boolean;
  efforts: string[];
  defaultEffort: string | null;
  contextWindow: number | null;
  priority: number;
};

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

let cached: { path: string; mtime: number; models: CodexModel[] } | null = null;

/** The catalog, in Codex's order (its `priority`); [] when the TUI never fetched one. */
export function codexModels(home: string): CodexModel[] {
  const path = join(home, "models_cache.json");
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return [];
  }
  if (cached && cached.path === path && cached.mtime === mtime) return cached.models;
  let models: CodexModel[] = [];
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    const list: unknown[] = Array.isArray(d?.models) ? d.models : [];
    models = list.flatMap((m: any) => {
      const id = str(m?.slug);
      if (!id) return [];
      const efforts = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((x: any) => str(x?.effort)).filter(Boolean) as string[] : [];
      return [{
        id, name: str(m.display_name) ?? id, description: str(m.description) ?? "", listed: m.visibility === "list",
        efforts, defaultEffort: str(m.default_reasoning_level), contextWindow: typeof m.context_window === "number" ? m.context_window : null,
        priority: typeof m.priority === "number" ? m.priority : 1e9,
      }];
    }).sort((a, b) => a.priority - b.priority);
  } catch {
    models = [];
  }
  cached = { path, mtime, models };
  return models;
}

/** A `key = "value"` of config.toml's top level (before its first [table]), or null. */
function topLevel(toml: string, key: string): string | null {
  for (const line of toml.split("\n")) {
    const l = line.trim();
    if (l.startsWith("[")) break;
    const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * The model and effort a TUI started on, as Codex picks them: its command line (`-m`, `--model`,
 * `-c model=…`, `-c model_reasoning_effort=…`), else config.toml's top level. Null where neither
 * says, or where a profile could (a `--profile`, or config.toml's `profile`): the rollout's first
 * turn tells then.
 */
export function startingModel(argv: string[], home: string): { model: string | null; effort: string | null } {
  let model: string | null = null;
  let effort: string | null = null;
  let profile = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if ((a === "-m" || a === "--model") && next) model = next;
    else if (a.startsWith("--model=")) model = a.slice(8);
    else if ((a === "-p" || a === "--profile" || a.startsWith("--profile="))) profile = true;
    else if ((a === "-c" || a === "--config") && next) {
      const m = /^(model|model_reasoning_effort)\s*=\s*"?([^"]*)"?$/.exec(next);
      if (m?.[1] === "model") model = m[2]!;
      else if (m?.[1] === "model_reasoning_effort") effort = m[2]!;
    }
  }
  let toml = "";
  try {
    toml = readFileSync(join(home, "config.toml"), "utf8");
  } catch {}
  if (profile || topLevel(toml, "profile")) return { model, effort };
  return { model: model ?? topLevel(toml, "model"), effort: effort ?? topLevel(toml, "model_reasoning_effort") };
}

// What Codex prints for a /model it refuses (model_command.rs, and the composer's own refusal), and
// for one it took ("• Model changed to gpt-6 high for this session only": app/model_defaults.rs).
const REFUSED_RE = /(Model '[^']*' is unavailable\..*|Reasoning level '[^']*' is unavailable.*|Session is still starting.*|Model arguments are unavailable.*|Unexpected argument '[^']*'.*|'\/model' is disabled while a task is in progress\.)/;
const CHANGED_RE = /^•?\s*Model changed to \S+/;

/** The lines a screen shows more often than the one before did (so an old line stays old, and the same words again are new). */
export function newLines(before: string | null, after: string): string[] {
  const had = new Map<string, number>();
  for (const l of (before ?? "").split("\n")) had.set(l.trim(), (had.get(l.trim()) ?? 0) + 1);
  const seen = new Map<string, number>();
  return after.split("\n").map((l) => l.trim()).filter((l) => {
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return l && n > (had.get(l) ?? 0);
  });
}

/** What Codex answered a /model line with, from the lines new since it was typed: its refusal, that it took it, or nothing yet. */
export function modelAnswer(news: string[]): { refused: string } | { changed: true } | null {
  for (const l of [...news].reverse()) {
    const m = REFUSED_RE.exec(l);
    if (m) return { refused: m[1]!.trim() };
    if (CHANGED_RE.test(l)) return { changed: true };
  }
  return null;
}
