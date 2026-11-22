// Antigravity CLI's model list, effort tiers, starting state and inline command
// replies for the terminal view (terminal.ts).
//
// `agy models` lists every model variant as `<id>\t<Display Name>`, e.g.:
//   gemini-4-neon-high     Gemini 4 Neon (High)
//   gemini-4-neon-xhigh    Gemini 4 Neon (XHigh)
//   gemini-pro-orchestrator-neon  Orchestrator (Neon)
//
// Variants that differ only by effort suffix (`-low`, `-medium`, `-high`,
// `-xhigh`, `-max`) belong to one base model (just as `agy`'s own /model picker
// groups them), with the model's adjustable effort levels. Selecting a model
// types `/model <variant-id>`; selecting an effort types `/effort <level>`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripAnsi } from "../../ansi.ts";

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
const EFFORT_SET = new Set<string>(EFFORT_ORDER);

export type AgyModelGroup = {
  /** Base model id (e.g. `gemini-4-neon`, or full id when the model has a single variant). */
  baseId: string;
  /** Human-readable name (e.g. `Gemini 4 Neon`, `Orchestrator (Neon)`). */
  name: string;
  /** Vendor group for model picker tabs (`google`, `anthropic`, `openai`). */
  provider: string;
  /** effort level → full variant model id (`"xhigh"` → `"gemini-4-neon-xhigh"`). */
  variants: Record<string, string>;
  /** Adjustable effort levels in order; empty when the model has only one variant. */
  efforts: string[];
  /** Default effort (the first variant `agy models` lists for this base model), or null. */
  defaultEffort: string | null;
  /** Full variant id to pass to `/model` when no matching effort is chosen. */
  defaultId: string;
};

export type ParsedModel = {
  baseId: string;
  name: string;
  provider: string;
  effort: string | null;
};

export function providerOf(id: string): string {
  const lower = id.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt")) return "openai";
  return "google";
}

/** Human-readable fallback name from a raw variant/base id when no catalog entry is available. */
export function humanizeModelId(baseId: string): string {
  const m = /^gemini-pro-orchestrator-(.+)$/i.exec(baseId);
  if (m) {
    const suffix = m[1] === "g1-pro" ? "Argon" : m[1]![0]!.toUpperCase() + m[1]!.slice(1);
    return `Orchestrator (${suffix})`;
  }
  return baseId
    .split("-")
    .map((w, i, arr) => {
      if (/^\d+$/.test(w) && i > 0 && /^\d+$/.test(arr[i - 1]!)) return null; // joined with previous as `5.5`
      if (/^\d+$/.test(w) && i + 1 < arr.length && /^\d+$/.test(arr[i + 1]!)) return `${w}.${arr[i + 1]}`;
      if (w.toLowerCase() === "gpt") return "GPT";
      if (w.toLowerCase() === "oss") return "OSS";
      return w ? w[0]!.toUpperCase() + w.slice(1) : "";
    })
    .filter((x): x is string => Boolean(x))
    .join(" ");
}

/** Split a full variant id (`gemini-4-neon-xhigh`) into base id, effort, provider and fallback name. */
export function parseModelId(id: string): ParsedModel {
  const m = /^(.+)-(low|medium|high|xhigh|max)$/i.exec(id.trim());
  if (m) {
    const baseId = m[1]!;
    const effort = m[2]!.toLowerCase();
    return { baseId, effort, provider: providerOf(baseId), name: humanizeModelId(baseId) };
  }
  const clean = id.trim();
  return { baseId: clean, effort: null, provider: providerOf(clean), name: humanizeModelId(clean) };
}

/** Split a display label (`"Gemini 4 Neon (XHigh)"`) into base display name and effort, if present. */
export function parseModelLabel(label: string): { name: string; effort: string | null } {
  const m = /^(.+?)\s+\((low|medium|high|xhigh|max)\)$/i.exec(label.trim());
  if (m) return { name: m[1]!.trim(), effort: m[2]!.toLowerCase() };
  return { name: label.trim(), effort: null };
}

/**
 * Parse `agy models` stdout (may contain carriage-return spinner frames) into
 * grouped models, preserving `agy`'s order.
 */
export function parseModelsOutput(stdout: string): AgyModelGroup[] {
  const raw: { id: string; label: string }[] = [];
  for (const chunk of stdout.split("\n")) {
    // Spinner frames use `\r` on the same line: keep only what follows the last `\r` before stripping ANSI.
    const tail = chunk.includes("\r") ? chunk.slice(chunk.lastIndexOf("\r") + 1) : chunk;
    const line = stripAnsi(tail).trim();
    if (!line || /^Fetching available models/i.test(line)) continue;
    const m = /^([a-z0-9][a-z0-9._-]+)(?:\t+|\s{2,})(.+)$/i.exec(line);
    if (!m) continue;
    raw.push({ id: m[1]!, label: m[2]!.trim() });
  }

  const order: string[] = [];
  const buckets = new Map<string, { id: string; label: string; baseName: string; effort: string | null }[]>();
  for (const item of raw) {
    const byId = parseModelId(item.id);
    const byLabel = parseModelLabel(item.label);
    const effort = byLabel.effort ?? byId.effort;
    const key = effort ? byId.baseId : item.id;
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
      order.push(key);
    }
    list.push({ ...item, baseName: byLabel.name, effort });
  }

  const groups: AgyModelGroup[] = [];
  for (const key of order) {
    const list = buckets.get(key)!;
    const first = list[0]!;
    if (list.length === 1) {
      // Single variant: effort isn't adjustable (e.g. Orchestrator (Neon), GPT-OSS 120B (Medium)).
      groups.push({
        baseId: first.id,
        name: first.label,
        provider: providerOf(first.id),
        variants: first.effort ? { [first.effort]: first.id } : {},
        efforts: [],
        defaultEffort: first.effort,
        defaultId: first.id,
      });
      continue;
    }
    const variants: Record<string, string> = {};
    for (const item of list) if (item.effort) variants[item.effort] = item.id;
    const efforts = EFFORT_ORDER.filter((e) => e in variants);
    const defaultEffort = first.effort && EFFORT_SET.has(first.effort) ? first.effort : efforts[0] ?? null;
    groups.push({
      baseId: key,
      name: first.baseName,
      provider: providerOf(key),
      variants,
      efforts,
      defaultEffort,
      defaultId: (defaultEffort && variants[defaultEffort]) || first.id,
    });
  }
  return groups;
}

/** Find a model group by baseId, variant id, or display name (case-insensitive). */
export function findModelGroup(groups: AgyModelGroup[], query: string): AgyModelGroup | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  return groups.find((g) =>
    g.baseId.toLowerCase() === q
    || g.defaultId.toLowerCase() === q
    || g.name.toLowerCase() === q
    || Object.values(g.variants).some((v) => v.toLowerCase() === q));
}

export type StartingState = {
  model: string | null;
  effort: string | null;
  mode: string | null;
};

/**
 * The model, effort and execution mode `agy` started on before its first turn
 * writes a transcript record: command-line flags first, else `settings.json`.
 */
export function startingState(argv: string[], dataDir: string): StartingState {
  let model: string | null = null;
  let effort: string | null = null;
  let mode: string | null = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === "--model" && next) { model = next; i++; }
    else if (a.startsWith("--model=")) model = a.slice("--model=".length);
    else if (a === "--effort" && next) { effort = next.toLowerCase(); i++; }
    else if (a.startsWith("--effort=")) effort = a.slice("--effort=".length).toLowerCase();
    else if (a === "--mode" && next) { mode = next; i++; }
    else if (a.startsWith("--mode=")) mode = a.slice("--mode=".length);
  }
  try {
    const s = JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8"));
    if (!model && typeof s?.model === "string" && s.model.trim()) model = s.model.trim();
    if (!mode && typeof s?.agentMode === "string" && s.agentMode.trim()) mode = s.agentMode.trim();
  } catch {}
  if (model && !effort) {
    const fromLabel = parseModelLabel(model).effort;
    const fromId = parseModelId(model).effort;
    effort = fromLabel ?? fromId;
  }
  return { model, effort, mode };
}

/** Lines appearing more times on `after` than on `before`. */
export function newLines(before: string | null, after: string): string[] {
  const had = new Map<string, number>();
  for (const l of (before ?? "").split("\n")) had.set(l.trim(), (had.get(l.trim()) ?? 0) + 1);
  const seen = new Map<string, number>();
  return after.split("\n").map((l) => l.trim()).filter((l) => {
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return Boolean(l) && n > (had.get(l) ?? 0);
  });
}

const REFUSED_RE = /(Invalid model\b.*|Invalid effort\b.*|\S+ has no "[^"]*" effort\b.*|Effort (?:is not|isn't) adjustable\b.*|Model .* is (?:not available|unavailable)\b.*|Cannot change (?:model|effort)\b.*)/i;
const CHANGED_RE = /(?:Model (?:changed|switched|set) to\b|Effort (?:changed|switched|set) to\b|Switched (?:model|effort) to\b)/i;

/** What `agy` answered an inline `/model` or `/effort` command with, from new screen lines. */
export function commandAnswer(news: string[]): { refused: string } | { changed: true } | null {
  for (const l of [...news].reverse()) {
    const m = REFUSED_RE.exec(l);
    if (m) return { refused: m[1]!.replace(/^⎿\s*/, "").trim() };
    if (CHANGED_RE.test(l)) return { changed: true };
  }
  return null;
}
