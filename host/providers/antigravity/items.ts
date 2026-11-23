// Antigravity CLI's transcript (`brain/<id>/.system_generated/logs/transcript.jsonl`)
// turned into herdr-chat's normalized events, for both history replay and live
// tailing in the terminal view (terminal.ts).
//
// Each line is one step with a monotonically increasing `step_index`:
// - USER_INPUT: the user's message wrapped in `<USER_REQUEST>…</USER_REQUEST>`
//   (plus optional `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` tags);
// - PLANNER_RESPONSE: one model response with optional `thinking`, `content`,
//   `tool_calls[]` (whose arg values are JSON-encoded strings), `model`, and
//   token counts (`input_tokens`, `cache_read_tokens`, `output_tokens`);
// - GENERIC: a tool call's result (paired 1-to-1 in order with the preceding
//   PLANNER_RESPONSE's `tool_calls`), status DONE | ERROR | RUNNING;
// - ERROR_MESSAGE: transient API/system error notice;
// - SYSTEM_MESSAGE: internal harness reminders (skipped) or background task
//   completion reports (surfaced as a compact info notice).
import { cleanToolOutput, decodeToolArgs } from "./tools.ts";
import { findModelGroup, parseModelId, type AgyModelGroup } from "./models.ts";
import type { AssistantBlock, ModelInfo, NormalizedEvent, StopReason, Usage } from "../types.ts";

type Rec = Record<string, any>;

const USER_REQUEST_RE = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/;
const TRAILING_TAG_RE = /\n*<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|SYSTEM_MESSAGE)>/g;
const BG_TASK_RE = /Task id "([^"]+)" (finished|was canceled|failed) with result:/;
const DECLINED_RE = /\b(?:permission denied|user (?:rejected|denied)|denied by (?:user|permission)|rejected by user|blocked by (?:a )?(?:deny )?rule)\b/i;

function tsOf(r: Rec): number | undefined {
  const t = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

/** Extract the user's actual message from a `USER_INPUT` record's `content`. */
export function extractUserText(content: string): string {
  const m = USER_REQUEST_RE.exec(content);
  if (m) return m[1]!.trim();
  return content.replace(TRAILING_TAG_RE, "").trim();
}

/** Build a chat `ModelInfo` from an Antigravity variant id, enriched with the model catalog if known. */
export function modelInfoOf(rawId: string, catalog: AgyModelGroup[] = []): { info: ModelInfo; effort: string | null } {
  const parsed = parseModelId(rawId);
  const group = findModelGroup(catalog, rawId) ?? findModelGroup(catalog, parsed.baseId);
  if (group) {
    const effort = Object.entries(group.variants).find(([, v]) => v === rawId)?.[0] ?? parsed.effort;
    return {
      info: {
        provider: group.provider,
        id: group.baseId,
        name: group.name,
        reasoning: group.efforts.length > 0 || Boolean(effort),
        contextWindow: null,
        input: ["text", "image"],
      },
      effort,
    };
  }
  return {
    info: {
      provider: parsed.provider,
      id: parsed.baseId,
      name: parsed.name,
      reasoning: Boolean(parsed.effort),
      contextWindow: null,
      input: ["text", "image"],
    },
    effort: parsed.effort,
  };
}

type PendingCall = { callId: string; name: string; args: Rec };

export type FollowerOptions = {
  history?: boolean;
  catalog?: () => AgyModelGroup[];
};

export class AgyTranscriptFollower {
  private history: boolean;
  private catalog: () => AgyModelGroup[];
  private seen = new Set<number>();
  private pending: PendingCall[] = [];
  private seq = 0;

  modelRaw: string | null = null;
  modelBase: string | null = null;
  effort: string | null = null;
  turn: "running" | "ended" | null = null;
  contextTokens: number | null = null;

  constructor(opts: FollowerOptions = {}) {
    this.history = Boolean(opts.history);
    this.catalog = opts.catalog ?? (() => []);
  }

  usage(): { contextTokens: number | null; contextWindow: number | null } {
    return { contextTokens: this.contextTokens, contextWindow: null };
  }

  /** Pending `run_command` tool-call command lines (for recovering exact unwrapped commands on approval screens). */
  pendingCommands(): string[] {
    const out: string[] = [];
    for (const c of this.pending) {
      if (c.name !== "run_command") continue;
      const cmd = typeof c.args.CommandLine === "string" ? c.args.CommandLine : typeof c.args.command === "string" ? c.args.command : "";
      if (cmd) out.push(cmd);
    }
    return out;
  }

  /** Switch from history replay to live tailing while keeping seen steps and pending tool calls. */
  setLive(): void {
    this.history = false;
  }

  /** Feed one parsed JSONL record from `transcript.jsonl`. */
  feed(raw: unknown): NormalizedEvent[] {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const r = raw as Rec;
    const step = typeof r.step_index === "number" ? r.step_index : null;
    if (r.type === "SHELL_EXEC" && r.status === "RUNNING") return [];
    if (step !== null) {
      if (this.seen.has(step)) return [];
      this.seen.add(step);
    }
    const ts = this.history ? tsOf(r) : undefined;
    const t = ts !== undefined ? { ts } : {};
    const out: NormalizedEvent[] = [];

    switch (r.type) {
      case "USER_INPUT": {
        this.pending.length = 0;
        const text = typeof r.content === "string" ? extractUserText(r.content) : "";
        if (!text) return out;
        this.turn = "running";
        out.push({
          type: "user_message",
          text,
          images: 0,
          ...(this.history ? { source: "composer" as const } : {}),
          ...t,
        });
        return out;
      }

      case "PLANNER_RESPONSE": {
        this.pending.length = 0;
        const modelId = typeof r.model === "string" && r.model.trim() ? r.model.trim() : null;
        if (modelId && modelId !== this.modelRaw) {
          this.modelRaw = modelId;
          const { info, effort } = modelInfoOf(modelId, this.catalog());
          if (info.id !== this.modelBase) {
            this.modelBase = info.id;
            out.push({ type: "model", model: info, ...t });
          }
          if (effort && effort !== this.effort) {
            this.effort = effort;
            out.push({ type: "thinking", level: effort, ...t });
          }
        }

        const inp = typeof r.input_tokens === "number" && Number.isFinite(r.input_tokens) ? r.input_tokens : 0;
        const cache = typeof r.cache_read_tokens === "number" && Number.isFinite(r.cache_read_tokens) ? r.cache_read_tokens : 0;
        const output = typeof r.output_tokens === "number" && Number.isFinite(r.output_tokens) ? r.output_tokens : 0;
        if (inp + cache > 0) this.contextTokens = inp + cache;
        const usage: Usage | undefined = inp || cache || output
          ? { input: inp, output, cacheRead: cache, cacheWrite: 0, cost: null }
          : undefined;

        const thinking = typeof r.thinking === "string" ? r.thinking.trim() : "";
        const text = typeof r.content === "string" ? r.content : "";
        const calls: Rec[] = Array.isArray(r.tool_calls) ? r.tool_calls.filter((x: unknown) => x && typeof x === "object") : [];

        if (!thinking && !text && !calls.length) return out;

        const content: (AssistantBlock | null)[] = [];
        out.push({ type: "assistant_start", ...t });

        if (thinking) {
          const index = content.length;
          content.push({ type: "thinking", text: thinking });
          out.push(
            { type: "assistant_block_start", index, kind: "thinking", ...t },
            { type: "assistant_block_end", index, kind: "thinking", text: thinking, ...t },
          );
        }

        if (text) {
          const index = content.length;
          content.push({ type: "text", text });
          out.push(
            { type: "assistant_block_start", index, kind: "text", ...t },
            { type: "assistant_block_end", index, kind: "text", text, ...t },
          );
        }

        const stepTag = step ?? ++this.seq;
        for (let i = 0; i < calls.length; i++) {
          const tc = calls[i]!;
          const name = typeof tc.name === "string" && tc.name ? tc.name : "tool";
          const args = decodeToolArgs(tc.args);
          const callId = `agy-${stepTag}-${i}`;
          const index = content.length;
          content.push({ type: "toolCall", callId, name, args });
          this.pending.push({ callId, name, args });
          out.push(
            { type: "tool_call", index, callId, name, args, ...t },
            { type: "tool_started", callId, name, args, ...t },
          );
        }

        const stopReason: StopReason = calls.length ? "toolUse" : "stop";
        const modelTag = this.modelBase ? `${modelInfoOf(this.modelRaw ?? this.modelBase, this.catalog()).info.provider}/${this.modelBase}` : undefined;
        out.push({
          type: "assistant_end",
          content,
          stopReason,
          ...(modelTag ? { model: modelTag } : {}),
          ...(usage ? { usage } : {}),
          ...t,
        });
        if (!this.history && this.contextTokens !== null) out.push({ type: "turn_end" });
        this.turn = calls.length ? "running" : "ended";
        return out;
      }

      case "GENERIC": {
        const call = this.pending.shift();
        if (!call) return out;
        const rawContent = typeof r.content === "string" ? cleanToolOutput(r.content) : "";
        const err = typeof r.error === "string" && r.error.trim() ? r.error.trim() : "";
        const isError = r.status === "ERROR" || Boolean(err);
        const output = rawContent || err;
        const declined = isError && DECLINED_RE.test(`${err}\n${rawContent}`);
        out.push({
          type: "tool_ended",
          callId: call.callId,
          name: call.name,
          args: call.args,
          isError,
          ...(declined ? { declined: true } : {}),
          output,
          ...t,
        });
        return out;
      }

      case "SHELL_EXEC": {
        // User-initiated `! <command>` run in Antigravity's TUI: rendered as a standalone
        // Bash card (`you-` prefix keeps rows.js from folding it into an agent work group).
        const cmd = typeof r.command === "string" ? r.command.trim() : "";
        if (!cmd) return out;
        const stepTag = step ?? ++this.seq;
        const callId = `you-bash-${stepTag}`;
        const rawOut = typeof r.output === "string" ? cleanToolOutput(r.output) : typeof r.content === "string" ? cleanToolOutput(r.content) : "";
        const err = typeof r.error === "string" && r.error.trim()
          ? r.error.trim()
          : typeof r.error_message === "string" && r.error_message.trim()
            ? r.error_message.trim()
            : "";
        const exitCode = typeof r.exit_code === "number" && Number.isFinite(r.exit_code) ? r.exit_code : null;
        const isError = r.status === "ERROR" || Boolean(err) || (exitCode !== null && exitCode !== 0);
        const body = [rawOut, err].filter((s) => s.trim()).join("\n");
        const output = exitCode !== null && !/Command exited with code \d+/i.test(body)
          ? `Command exited with code ${exitCode}.${body ? `\n\nCommand output:\n${body}` : ""}`
          : body;
        const args = { CommandLine: cmd };
        out.push(
          { type: "tool_call", callId, name: "run_command", args, ...t },
          { type: "tool_ended", callId, name: "run_command", args, isError, output, ...t },
        );
        return out;
      }

      case "ERROR_MESSAGE": {
        const err = typeof r.error === "string" ? r.error.trim() : "";
        if (err) out.push({ type: "notice", level: "warning", source: "retry", text: err, ...t });
        return out;
      }

      case "SYSTEM_MESSAGE": {
        const text = typeof r.content === "string" ? r.content : "";
        const bg = BG_TASK_RE.exec(text);
        if (bg) {
          const shortId = bg[1]!.split("/").pop() ?? bg[1]!;
          out.push({ type: "notice", level: "info", source: "notify", text: `Background task ${shortId} ${bg[2]}.`, ...t });
        }
        return out;
      }

      default:
        return out;
    }
  }
}
