// A Claude Code transcript followed as it grows: the terminal view
// (terminal.ts), where the agent is the person's own TUI in a terminal and
// the chat only reads what it writes. Claude Code appends one record per
// finished content block (an assistant message's thinking, text and tool
// calls arrive as separate records with the same message id), then a user
// record per tool result. Fed one record at a time, this gives the events a
// stream would: an assistant message opens with its first record, each block
// shows whole as it lands, and the message closes when another message, a
// user record or the run's end comes. No I/O, so tests feed it records.
// Claude Code 2.1.330 writes the message's stop reason and usage on each of its
// records (older versions on its last, when at all): a message ends at its
// stop reason, and a record of it that comes after opens it again, its usage
// already counted.
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AssistantBlock, ImageBlock, NormalizedEvent, StopReason, EventOf } from "../types.ts";
import { imagesOf, shownBlock, textOf, toolEnded, usageOf } from "./mapper.ts";
import { bashEvents, imageFile, promptText, queuedPrompt, readTranscript, sentImages } from "./sessions.ts";

type Rec = Record<string, any>;

const STOP: Record<string, StopReason> = { end_turn: "stop", stop_sequence: "stop", pause_turn: "stop", tool_use: "toolUse", max_tokens: "length", refusal: "error" };

type Open = { id: string | null; content: (AssistantBlock | null)[]; model?: string; usage?: Rec; stop?: string; error?: string; synthetic: boolean; again: boolean };

function tsOf(r: Rec): number | undefined {
  const t = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(t) ? t : undefined;
}

function localStdout(text: string): string | null {
  const m = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>\s*$/.exec(text);
  return m ? m[1]!.trim() : null;
}

/** A message the person typed: images the terminal view sent as @ mentions are shown as its images, as in history. */
function typedMessage(typed: string, content: unknown, t: { ts?: number }): EventOf<"user_message"> {
  const sent = sentImages(typed);
  const images = [...imagesOf(content), ...sent.files.map(imageFile).filter((b): b is ImageBlock => b !== null)];
  return { type: "user_message", text: sent.text, images: images.length, ...(images.length ? { imageBlocks: images } : {}), ...t };
}

export class TranscriptFollower {
  private names = new Map<string, string>();
  private open: Open | null = null;
  /** The id of the message that ended last: a record of it after that opens it again (`again`). */
  private closedId: string | null = null;
  /** Records already shown (the history, or a record written twice), by uuid. */
  private seen = new Set<string>();
  /** A `!` command's card waiting for its output (sessions.ts bashEvents). */
  private bash: { callId: string | null } = { callId: null };
  /** The session's folder of subagent transcripts (`<id>/subagents/agent-<id>.jsonl`). */
  private sessionDir: string;

  constructor(file: string) {
    this.sessionDir = join(file.replace(/\/[^/]*$/, ""), file.replace(/^.*\//, "").replace(/\.jsonl$/, ""));
  }

  /** The history's records: their uuids (not shown again) and their tool calls' names (for the results still to come). */
  prime(records: Rec[]): void {
    for (const r of records) {
      if (typeof r.uuid === "string") this.seen.add(r.uuid);
      if (r.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
      for (const b of r.message.content) if (b?.type === "tool_use") this.names.set(String(b.id), String(b.name ?? "tool"));
    }
  }

  /** Whether an assistant message is open (its end not seen yet). */
  get opened(): boolean {
    return this.open !== null;
  }

  /** One record's events. */
  feed(r: Rec): NormalizedEvent[] {
    if (!r || typeof r !== "object" || typeof r.uuid !== "string") return [];
    if (this.seen.has(r.uuid)) return [];
    this.seen.add(r.uuid);
    if (r.isSidechain) return [];
    const ts = tsOf(r);
    const t = ts ? { ts } : {};
    if (r.type === "assistant") return this.assistant(r);
    if (r.type === "system") return this.system(r, t);
    // A message typed while the agent worked, handed to it mid-turn (sessions.ts queuedPrompt).
    if (r.type === "attachment") {
      const q = queuedPrompt(r);
      return q ? [...this.close(), typedMessage(q.text, q.content, t)] : [];
    }
    if (r.type !== "user") return [];
    const c = r.message?.content;
    if (Array.isArray(c) && c.some((b: Rec) => b?.type === "tool_result")) {
      const out = this.close();
      for (const b of c) {
        if (b?.type !== "tool_result") continue;
        const declined = r.permissionDecision?.decision === "reject" || r.toolDenialKind === "permission-rule";
        const name = this.names.get(String(b.tool_use_id)) ?? "tool";
        out.push({ ...toolEnded(b, name, r.toolUseResult, declined), ...t });
        // A subagent's steps are in their own file, written by the time its result is: nested under its card, before it ends.
        const agentId = r.toolUseResult?.agentId;
        if ((name === "Agent" || name === "Task") && typeof agentId === "string") out.splice(out.length - 1, 0, ...this.subagent(agentId, String(b.tool_use_id)));
      }
      return out;
    }
    // A `!` command the person ran in the TUI: a Bash card, as in history (sessions.ts bashEvents).
    const bash = bashEvents(r, this.bash, t);
    if (bash) return [...this.close(), ...bash];
    const typed = promptText(r);
    // A /compact shows as the compaction's notice (the boundary record).
    if (typed === null || /^\/compact(\s|$)/.test(typed)) return [];
    return [...this.close(), typedMessage(typed, c, t)];
  }

  /** The open assistant message ends (the next record isn't part of it, or the run settled). */
  close(): NormalizedEvent[] {
    const o = this.open;
    if (!o) return [];
    this.open = null;
    this.closedId = o.id;
    const last = o.content.at(-1);
    const stop: StopReason = o.error ? "error" : o.stop ? STOP[o.stop] ?? "stop" : last?.type === "toolCall" ? "toolUse" : "stop";
    const usage = o.synthetic || o.again ? undefined : usageOf(o.usage);
    return [{
      type: "assistant_end", content: o.content, stopReason: stop, ...(o.error ? { error: o.error } : {}),
      ...(usage ? { usage } : {}), ...(!o.synthetic && o.model ? { model: o.model } : {}),
    }];
  }

  private assistant(r: Rec): NormalizedEvent[] {
    const m: Rec = r.message ?? {};
    const blocks: Rec[] = Array.isArray(m.content) ? m.content : [];
    const id = typeof m.id === "string" ? m.id : null;
    const out: NormalizedEvent[] = [];
    if (this.open && (this.open.id !== id || id === null)) out.push(...this.close());
    if (!this.open) {
      this.open = { id, content: [], synthetic: m.model === "<synthetic>", again: id !== null && id === this.closedId };
      out.push({ type: "assistant_start" });
    }
    const o = this.open;
    if (typeof m.model === "string") o.model = m.model;
    if (m.usage && typeof m.usage === "object") o.usage = m.usage;
    if (typeof m.stop_reason === "string") o.stop = m.stop_reason;
    if (typeof r.error === "string" || r.isApiErrorMessage === true) o.error = textOf(blocks) || String(r.error ?? "error");
    for (const b of blocks) {
      const index = o.content.length;
      if (b?.type === "text" || b?.type === "thinking") {
        const shown = shownBlock(b);
        // Redacted thinking: a block with nothing to show.
        if (!shown) {
          o.content.push(null);
          continue;
        }
        o.content.push(shown);
        out.push({ type: "assistant_block_start", index, kind: shown.type }, { type: "assistant_block_end", index, kind: shown.type, text: shown.text });
      } else if (b?.type === "tool_use") {
        const name = String(b.name ?? "tool");
        this.names.set(String(b.id), name);
        o.content.push({ type: "toolCall", callId: String(b.id), name, args: b.input });
        out.push({ type: "tool_call", index, callId: String(b.id), name, args: b.input });
      } else o.content.push(null);
    }
    if (o.stop || o.error) out.push(...this.close());
    return out;
  }

  private system(r: Rec, t: { ts?: number }): NormalizedEvent[] {
    if (r.subtype === "compact_boundary") {
      const md: Rec = r.compactMetadata ?? r.compact_metadata ?? {};
      const before = md.preTokens ?? md.pre_tokens;
      return [...this.close(), { type: "notice", level: "info", source: "compaction", text: `Compacted the conversation (${Math.round((typeof before === "number" ? before : 0) / 1000)}k tokens before).`, ...t }];
    }
    if (r.subtype !== "local_command" || typeof r.content !== "string") return [];
    const stdout = localStdout(r.content);
    if (stdout !== null) return stdout ? [...this.close(), { type: "assistant_end", content: [{ type: "text", text: stdout }], stopReason: "stop", ...t }] : [];
    const cmd = promptText({ type: "user", message: { content: r.content } });
    return cmd ? [...this.close(), { type: "user_message", text: cmd, images: 0, ...t }] : [];
  }

  /** A finished subagent's steps (its own transcript), nested under its card, as history shows them. */
  private subagent(agentId: string, callId: string): NormalizedEvent[] {
    const file = join(this.sessionDir, "subagents", `agent-${agentId}.jsonl`);
    if (!existsSync(file)) return [];
    const recs = readTranscript(file).filter((x) => x.type === "assistant" || (x.type === "user" && Array.isArray(x.message?.content) && x.message.content.some((b: Rec) => b?.type === "tool_result")));
    // Its final report is the card's output.
    while (recs.length && recs.at(-1)!.type === "assistant" && !recs.at(-1)!.message?.content?.some((b: Rec) => b?.type === "tool_use")) recs.pop();
    const out: NormalizedEvent[] = [];
    for (const r of recs) {
      const c: Rec[] = Array.isArray(r.message?.content) ? r.message.content : [];
      if (r.type === "assistant") {
        const texts = c.map(shownBlock);
        if (texts.some(Boolean)) out.push({ type: "assistant_end", content: texts, parent: callId });
        for (const b of c) {
          if (b.type !== "tool_use") continue;
          this.names.set(String(b.id), String(b.name ?? "tool"));
          out.push({ type: "tool_call", callId: String(b.id), name: String(b.name ?? "tool"), args: b.input, parent: callId });
        }
      } else {
        for (const b of c) if (b?.type === "tool_result") out.push(toolEnded(b, this.names.get(String(b.tool_use_id)) ?? "tool", r.toolUseResult, false, callId));
      }
    }
    return out;
  }
}
