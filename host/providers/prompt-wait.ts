// The terminal view (providers/claude/terminal.ts, providers/codex/terminal.ts): a
// command the chat typed into the TUI opened a screen there (a picker, a list, a
// pager), so the chat showed the terminal for it. This waits for the TUI to show its
// prompt again, so the chat can come back by itself: Esc in the picker, or a pick,
// ends the trip. Agent-neutral: `read` gives the screen as `hc read` prints it, and
// `atPrompt` says whether it shows the TUI's prompt with nothing over it.

export type PromptWait = { back: boolean };

export type PromptWaitOptions = {
  /** How long the screen has to leave the prompt: past this, the command opened nothing (it printed its result in the
   *  terminal, as Codex's /status does: the person stays there to read it). */
  openMs?: number;
  /** How long a screen may stay open before the wait gives up. */
  limitMs?: number;
  everyMs?: number;
  /** True once the wait no longer matters (a newer one, the view gone). */
  cancelled: () => boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `{back: true}` once the screen left the prompt and came back to it (two reads in a
 * row, so a redraw between two screens doesn't count); `{back: false}` when it never
 * left it within `openMs`, when cancelled, or past `limitMs`.
 */
export async function waitForPrompt(read: () => Promise<string | null>, atPrompt: (screen: string) => boolean, o: PromptWaitOptions): Promise<PromptWait> {
  const every = o.everyMs ?? 400;
  const t0 = Date.now();
  let opened = false;
  let idle = 0;
  while (!o.cancelled()) {
    const screen = await read();
    if (o.cancelled()) break;
    if (screen !== null) {
      const at = atPrompt(screen);
      if (!opened) {
        if (!at) opened = true;
        else if (Date.now() - t0 > (o.openMs ?? 5000)) return { back: false };
      } else if (at) {
        if (++idle >= 2) return { back: true };
      } else idle = 0;
    }
    if (Date.now() - t0 > (o.limitMs ?? 15 * 60_000)) break;
    await sleep(every);
  }
  return { back: false };
}
