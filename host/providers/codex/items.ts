// A Codex TUI's rollout as the chat's events, for the terminal view
// (terminal.ts). Codex 0.167 and later write each finished item of a turn
// as an `item_completed` event (protocol TurnItem: PascalCase types,
// snake_case fields); the app-server hands the same items to its clients as
// ThreadItems (camelCase), which map.ts maps for Codex chats. Here a TurnItem
// becomes that ThreadItem, so a terminal's conversation and a chat's look
// alike, live and in history. The turn's start, end and abort, its token
// counts and its plan updates come from the records around the items.
//
// A rollout holds no streaming deltas: an item shows once it's done.
import { CodexMapper } from "./map.ts";
import { planCalls, planOf } from "./rollout.ts";
import type { ImageBlock, ModelInfo, NormalizedEvent } from "../types.ts";

type Rec = Record<string, any>;

const isObj = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
/** `CommandExecution` → `commandExecution`, `in_progress` → `inProgress`. */
const lowerCamel = (s: string) => camel(s.charAt(0).toLowerCase() + s.slice(1));

/** Keys in camelCase all the way down (the app-server's spelling of the same structs). */
function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (!isObj(v)) return v;
  const out: Rec = {};
  for (const [k, x] of Object.entries(v)) out[camel(k)] = camelKeys(x);
  return out;
}

const SHELLS = /^(?:.*\/)?(?:ba|z|fi|da)?sh$/;
/** A command's argv as one line: a login shell's script as it is (`bash -lc 'x'` → `x`), else the words, quoted where needed. */
export function commandLine(argv: unknown): string {
  if (typeof argv === "string") return argv;
  if (!Array.isArray(argv)) return "";
  const a = argv.map(String);
  if (a.length === 3 && SHELLS.test(a[0]!) && /^-l?c$/.test(a[1]!)) return a[2]!;
  return a.map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** A ParsedCommand (`list_files`, `cmd`) → a CommandAction (`listFiles`, `command`). */
function commandAction(p: Rec): Rec {
  const { type, cmd, ...rest } = camelKeys(p) as Rec;
  return { ...rest, type: lowerCamel(String(type ?? "unknown")), command: cmd ?? "" };
}

const STATUS: Record<string, string> = { in_progress: "inProgress", completed: "completed", failed: "failed", declined: "declined", interrupted: "interrupted" };
const status = (s: unknown) => (typeof s === "string" ? STATUS[s] ?? lowerCamel(s) : undefined);

/** `{secs, nanos}` (a Rust Duration) or ms → ms. */
function durationMs(d: unknown): number | undefined {
  if (isObj(d) && typeof d.secs === "number") return d.secs * 1000 + Math.round((num(d.nanos) ?? 0) / 1e6);
  return num(d);
}

/** A user input (`text`, `image`, `local_image`, `skill`, `mention`) as the app-server spells it. */
function userInput(c: Rec): Rec {
  const t = str(c.type) ?? "";
  if (t === "text") return { type: "text", text: str(c.text) ?? "" };
  if (t === "image") return { type: "image", url: str(c.image_url) ?? str(c.url) ?? "" };
  if (t === "local_image") return { type: "localImage", path: str(c.path) ?? "" };
  return { ...(camelKeys(c) as Rec), type: lowerCamel(t) };
}

/** A rollout's TurnItem → the ThreadItem map.ts reads; null for what isn't an item. */
export function threadItem(item: unknown): Rec | null {
  if (!isObj(item) || typeof item.type !== "string" || typeof item.id !== "string") return null;
  const { id } = item;
  switch (item.type) {
    case "UserMessage":
      // No clientId: the TUI's own ids name nothing the chat sent (terminal.ts matches its sends by text).
      return { type: "userMessage", id, content: (Array.isArray(item.content) ? item.content : []).filter(isObj).map(userInput) };
    case "AgentMessage": {
      const parts = Array.isArray(item.content) ? item.content : [];
      const text = parts.map((p: Rec) => (isObj(p) && typeof p.text === "string" ? p.text : "")).join("");
      return { type: "agentMessage", id, text, ...(str(item.phase) ? { phase: item.phase } : {}) };
    }
    case "Reasoning":
      return { type: "reasoning", id, summary: Array.isArray(item.summary_text) ? item.summary_text : [], content: Array.isArray(item.raw_content) ? item.raw_content : [] };
    case "Plan":
      return { type: "plan", id, text: str(item.text) ?? "" };
    case "CommandExecution":
      return {
        type: "commandExecution", id, command: commandLine(item.command), cwd: str(item.cwd) ?? "",
        commandActions: (Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []).filter(isObj).map(commandAction),
        aggregatedOutput: str(item.aggregated_output) ?? "", exitCode: num(item.exit_code) ?? null,
        ...(durationMs(item.duration) !== undefined ? { durationMs: durationMs(item.duration) } : {}),
        status: status(item.status) ?? "completed",
      };
    case "FileChange": {
      // {path: {type: add|delete, content} | {type: update, unified_diff, move_path}} → [{path, kind, diff}]
      const changes = Object.entries(isObj(item.changes) ? item.changes : {}).map(([path, c]: [string, any]) => ({
        path,
        kind: { type: str(c?.type) ?? "update", ...(str(c?.move_path) ? { move_path: c.move_path } : {}) },
        diff: str(c?.unified_diff) ?? str(c?.content) ?? "",
      }));
      return { type: "fileChange", id, changes, status: status(item.status) ?? "completed" };
    }
    case "ImageView":
      return { type: "imageView", id, path: str(item.path) ?? "" };
    case "WebSearch":
      return { type: "webSearch", id, query: str(item.query) ?? "", ...(isObj(item.action) ? { action: camelKeys(item.action) } : {}) };
    case "Extension":
      // A built-in tool's extension item; its web search is a webSearch with results.
      if (item.kind === "web_search") return { type: "webSearch", id, query: str(item.query) ?? "", ...(isObj(item.action) ? { action: camelKeys(item.action) } : {}), results: Array.isArray(item.results) ? item.results : [] };
      return { ...(camelKeys(item) as Rec), type: lowerCamel(String(item.kind ?? "extension")) };
    case "McpToolCall": {
      const r = isObj(item.result) ? item.result : null;
      return {
        type: "mcpToolCall", id, server: str(item.server) ?? "", tool: str(item.tool) ?? "", arguments: item.arguments ?? null,
        ...(r ? { result: { content: Array.isArray(r.content) ? camelKeys(r.content) : [], ...(r.structured_content != null ? { structuredContent: r.structured_content } : {}) } } : {}),
        ...(item.error != null ? { error: typeof item.error === "string" ? { message: item.error } : camelKeys(item.error) } : {}),
        status: status(item.status) ?? "completed",
      };
    }
    case "ImageGeneration":
      return { ...(camelKeys(item) as Rec), type: "imageGeneration", status: status(item.status) ?? "completed" };
    case "ContextCompaction":
      return { type: "contextCompaction", id };
    default: {
      const out = camelKeys(item) as Rec;
      return { ...out, type: lowerCamel(item.type), ...(out.status !== undefined ? { status: status(item.status) } : {}) };
    }
  }
}

/** A Codex model as the chat names it. */
function modelInfo(id: string, contextWindow: number | null): ModelInfo {
  return { provider: "openai", id, name: id, reasoning: true, contextWindow, input: ["text", "image"] };
}

/** The `rate_limits` of a token count as the status the Codex chat shows ("limits 5h 12% · week 30%"). */
export function limitsText(rl: unknown): string | null {
  if (!isObj(rl)) return null;
  const part = (w: unknown) => (isObj(w) && typeof w.used_percent === "number" ? `${typeof w.window_minutes === "number" && w.window_minutes <= 600 ? `${Math.round(w.window_minutes / 60)}h` : "week"} ${Math.round(w.used_percent)}%` : null);
  const text = [part(rl.primary), part(rl.secondary)].filter(Boolean).join(" · ");
  return text ? `limits ${text}` : null;
}

export type FollowerOptions = { history?: boolean; readImage?: (p: string) => ImageBlock | null };

/**
 * One rollout's records → the chat's events, a record at a time (history: the
 * whole file; live: what was appended). `turnEnded` says whether the last
 * record that told was a turn's end.
 */
export class RolloutFollower {
  readonly mapper: CodexMapper;
  thread: string | null = null;
  model: string | null = null;
  effort: string | null = null;
  contextWindow: number | null = null;
  /** The last turn record seen: started, ended (done or aborted), or none yet. */
  turn: "running" | "ended" | null = null;
  /** The plan-limit status the last token count gave. */
  limits: string | null = null;
  private history: boolean;

  constructor(opts: FollowerOptions = {}) {
    this.history = Boolean(opts.history);
    this.mapper = new CodexMapper({ history: this.history, model: () => (this.model ? `openai/${this.model}` : undefined), readImage: opts.readImage });
  }

  private main(): string {
    return this.thread ?? "";
  }

  feed(r: unknown): NormalizedEvent[] {
    if (!isObj(r) || !isObj(r.payload)) return [];
    const p = r.payload;
    const ts = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    this.mapper.ts = this.history && Number.isFinite(ts) ? ts : undefined;
    const out: NormalizedEvent[] = [];
    switch (r.type) {
      case "session_meta":
        // A fork's file has its own meta after its source's: the first one names the thread.
        if (this.thread === null && typeof p.id === "string") {
          this.thread = p.id;
          this.mapper.reset(p.id);
        }
        if (typeof p.context_window === "number") this.contextWindow = p.context_window;
        return out;
      case "turn_context": {
        const model = str(p.model);
        const effort = str(p.effort);
        if (model && model !== this.model) {
          this.model = model;
          out.push({ type: "model", model: modelInfo(model, this.contextWindow) });
        }
        if (effort && effort !== this.effort) {
          this.effort = effort;
          out.push({ type: "thinking", level: effort });
        }
        return out;
      }
      case "response_item": {
        for (const args of planCalls(p)) {
          const plan = planOf(args, Number.isFinite(ts) ? ts : undefined);
          if (plan) out.push(plan);
        }
        return out;
      }
      case "event_msg":
        break;
      default:
        return out;
    }
    switch (p.type) {
      case "task_started":
        this.turn = "running";
        if (typeof p.model_context_window === "number") this.contextWindow = p.model_context_window;
        return out;
      case "item_completed": {
        const item = threadItem(p.item);
        if (!item) return out;
        const thread = str(p.thread_id) ?? this.main();
        return this.mapper.item(this.thread ?? thread, "completed", item);
      }
      case "task_complete":
        this.turn = "ended";
        return this.mapper.turnCompleted(this.main(), { status: "completed" });
      case "turn_aborted":
        this.turn = "ended";
        return this.mapper.turnCompleted(this.main(), { status: "interrupted" });
      case "token_count": {
        const info = isObj(p.info) ? p.info : null;
        const total = isObj(info?.total_token_usage) ? camelKeys(info!.total_token_usage) : null;
        const last = isObj(info?.last_token_usage) ? camelKeys(info!.last_token_usage) : null;
        if (total && last) {
          const window = num(info!.model_context_window) ?? this.contextWindow;
          this.mapper.notification("thread/tokenUsage/updated", { threadId: this.main(), tokenUsage: { total, last, modelContextWindow: window ?? null } });
        }
        const limits = limitsText(p.rate_limits);
        if (limits && limits !== this.limits) {
          this.limits = limits;
          out.push({ type: "status", key: "codex-limits", text: limits });
        }
        return out;
      }
      case "error":
      case "stream_error":
        if (str(p.message)) out.push({ type: "notice", level: "warning", source: "notify", text: String(p.message) });
        return out;
    }
    return out;
  }

  /** The latest token usage of the conversation. */
  usage(): { contextTokens: number | null; contextWindow: number | null } {
    const u = this.mapper.usage.get(this.main());
    return { contextTokens: u ? u.last.inputTokens ?? null : null, contextWindow: u?.modelContextWindow ?? this.contextWindow };
  }
}
