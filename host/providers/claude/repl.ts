// What a Code Mode Poll waits for (Claude Code 2.1.33x, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE): the model's `REPL` call
// hands a script over and its result says "(dispatched #N)" at once; the script runs on, and its end comes back as an
// `<event kind="repl-eval" eval="N" … status="settled">` in a later Poll's result (or the session's queue, or a user
// message). A `Poll` call has no input of its own; the TUI's spinner shows the script's description meanwhile. This
// follows the records to label each Poll with the scripts still running when it was made ("Waiting for #12 Run the
// tests"), and to give a REPL row its description.
//
// Only the event tags are read (their kind, eval and status), never what the scripts returned.

type Rec = Record<string, any>;

const DESC_MAX = 80;

/** A REPL call's words: its description, else its code's first line. */
export function scriptTitle(input: unknown): string {
  const a: Rec = input && typeof input === "object" ? (input as Rec) : {};
  const d = typeof a.description === "string" ? a.description.trim() : "";
  const line = d || (typeof a.code === "string" ? a.code.trim().split("\n")[0]!.trim() : "");
  return line.length > DESC_MAX ? line.slice(0, DESC_MAX - 1) + "…" : line;
}

/** The scripts whose end a text announces: each `repl-eval` event's number, unless it says the script still runs. */
export function scriptEnds(text: string): number[] {
  if (!text.includes("repl-eval")) return [];
  const out: number[] = [];
  for (const m of text.matchAll(/<event\b([^>]*)>/g)) {
    const attrs = m[1]!;
    if (!/\bkind="repl-eval"/.test(attrs)) continue;
    const n = /\beval="(\d+)"/.exec(attrs)?.[1];
    const status = /\bstatus="([^"]*)"/.exec(attrs)?.[1] ?? "settled";
    if (n && status !== "running" && status !== "detached") out.push(Number(n));
  }
  return out;
}

/** The text of a tool result's content (a string, or text blocks). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: Rec) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
}

export type Relabel = { callId: string; name: string; label: string };

/** The texts of a record a script's end can come in: the session's queue, a delivery of events, a user message. */
export function endTexts(r: Rec): string[] {
  if (!r || typeof r !== "object") return [];
  if (r.type === "queue-operation") return typeof r.content === "string" ? [r.content] : [];
  if (r.type === "attachment") return Array.isArray(r.attachment?.envelopes) ? r.attachment.envelopes.filter((x: unknown) => typeof x === "string") : [];
  if (r.type !== "user") return [];
  const c = r.message?.content;
  if (typeof c === "string") return [c];
  if (!Array.isArray(c)) return [];
  return c.map((b: Rec) => (b?.type === "tool_result" ? resultText(b.content) : b?.type === "text" && typeof b.text === "string" ? b.text : ""));
}

/** Every script end a whole transcript holds, by number: when each came (the history's records, read once). */
export function scriptEndTimes(records: Rec[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of records) {
    const at = typeof r?.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
    if (!Number.isFinite(at)) continue;
    for (const s of endTexts(r)) for (const n of scriptEnds(s)) (out.get(n) ?? out.set(n, []).get(n)!).push(at);
  }
  return out;
}

export class ReplScripts {
  /** REPL calls without their result yet: their words. */
  private calls = new Map<string, string>();
  /** Scripts dispatched and not ended: number → words, and when it was dispatched. */
  private open = new Map<number, { words: string; at: number }>();
  /** Polls without their result yet. */
  private polls = new Set<string>();
  /**
   * History: every end the transcript holds (scriptEndTimes). An end can be off the branch the history follows (a
   * delivery beside it), so a Poll drops the scripts that ended before it, whatever the branch says.
   */
  private readonly endTimes: Map<number, number[]> | null;

  constructor(endTimes: Map<number, number[]> | null = null) {
    this.endTimes = endTimes;
  }

  /** A tool call (`at`: its time). A Poll's label, else null. */
  call(callId: string, name: string, input: unknown, at?: number): string | null {
    if (name === "REPL") {
      this.calls.set(callId, scriptTitle(input));
      return null;
    }
    if (name !== "Poll") return null;
    this.polls.add(callId);
    if (this.endTimes && at !== undefined) {
      for (const [n, o] of this.open) if (this.endTimes.get(n)?.some((t) => t >= o.at && t <= at)) this.open.delete(n);
    }
    return this.label();
  }

  /**
   * A tool result (`at`: its time): a dispatch, or the ends a Poll brought. Returns the waiting Polls' new labels when a
   * dispatch gave a script they wait for its number. (An end never relabels a Poll: the Poll returns with it, and its
   * row keeps saying what it waited for.)
   */
  result(callId: string, content: unknown, at = 0): Relabel[] {
    const text = resultText(content);
    this.polls.delete(callId);
    let changed = false;
    this.ends(text);
    const words = this.calls.get(callId);
    if (words !== undefined) {
      this.calls.delete(callId);
      const m = /^\(dispatched #(\d+)\)/.exec(text.trim());
      if (m) {
        const n = Number(m[1]);
        // Numbers count up within a REPL; a number not above the ones still open is a new REPL (Claude Code started
        // again, or its REPL did): the old scripts went with the old one.
        if ([...this.open.keys()].some((k) => k >= n)) this.open.clear();
        this.open.set(n, { words, at });
      }
      changed = true;
    }
    return changed ? this.relabels() : [];
  }

  /** Any other text an end can arrive in (the queue, a user message): the scripts it ends. No Poll changes its label. */
  text(s: string): Relabel[] {
    this.ends(s);
    return [];
  }

  /** What a Poll made now waits for. */
  label(): string {
    const parts = [...this.open].map(([n, o]) => `#${n}${o.words ? ` ${o.words}` : ""}`);
    for (const w of this.calls.values()) parts.push(w || "a script");
    return parts.length ? `Waiting for ${parts.join(", ")}` : "Waiting";
  }

  /** The scripts still running, oldest first. */
  running(): { n: number; title: string }[] {
    return [...this.open].map(([n, o]) => ({ n, title: o.words }));
  }

  private ends(text: string): boolean {
    let any = false;
    for (const n of scriptEnds(text)) if (this.open.delete(n)) any = true;
    return any;
  }

  private relabels(): Relabel[] {
    const label = this.label();
    return [...this.polls].map((callId) => ({ callId, name: "Poll", label }));
  }
}
