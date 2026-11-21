// The messages typed into Claude Code's TUI while it works, waiting there for the agent: the terminal view's steering
// lane. Claude Code (2.1.3xx) writes its queue's bookkeeping into the transcript as `queue-operation` records:
//   {"type":"queue-operation","operation":"enqueue","content":"<what was typed>"}  as it is queued,
//   {"type":"queue-operation","operation":"remove","content":"…","reason":"absorbed_mid_turn"}  as the agent takes it
//   mid-turn (an attachment record follows: sessions.ts queuedPrompt), and `dequeue` (no content) as the next turn
//   starts on it (a user record follows).
// The same queue carries what the agent gets by itself (a finished task's `<task-notification>`, Code Mode's
// `<event kind=…>`, another session's message), and those never show. Its dequeues name nothing and don't come in
// the order of its enqueues, so they aren't followed: a typed message leaves the lane when it is removed, when the
// agent's message for it shows (the attachment or the user record), or when the run settles (an Esc takes queued
// messages back into the TUI's prompt; the next turn takes them otherwise). No I/O, so tests feed it records.
import { sentImages } from "./sessions.ts";

type Rec = Record<string, any>;

/** What the agent queues by itself, never typed: shown nowhere. */
const AUTO = /^<(event kind=|task-notification>|cross-session|agent-message|teammate-message)/;
const norm = (s: string) => sentImages(s).text.replace(/\s+/g, " ").trim();

export class TuiQueue {
  private texts: string[] = [];

  /** The typed messages waiting, oldest first (`@` mentions of sent images taken out, as the message will show). */
  get waiting(): string[] {
    return this.texts.map((t) => sentImages(t).text);
  }

  /** A transcript record: whether the lane changed. */
  feed(r: Rec): boolean {
    if (!r || r.type !== "queue-operation" || r.isSidechain || typeof r.content !== "string") return false;
    const c: string = r.content;
    if (AUTO.test(c.trimStart()) || !c.trim()) return false;
    if (r.operation === "enqueue") {
      this.texts.push(c);
      return true;
    }
    if (r.operation === "remove") return this.drop(c);
    return false;
  }

  /** The agent's message for a typed one showed (`text` as shown): it leaves the lane. */
  shown(text: string): boolean {
    const n = norm(text);
    const i = this.texts.findIndex((t) => norm(t) === n);
    if (i < 0) return false;
    this.texts.splice(i, 1);
    return true;
  }

  /** The run settled: nothing waits now. */
  clear(): boolean {
    if (!this.texts.length) return false;
    this.texts = [];
    return true;
  }

  private drop(content: string): boolean {
    const i = this.texts.indexOf(content);
    if (i >= 0) {
      this.texts.splice(i, 1);
      return true;
    }
    return this.shown(content);
  }
}
