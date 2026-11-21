// The background strip's words (chrome.js backgroundStrip draws them): what the agent runs in the background, as
// Claude Code's agents panel shows it under its prompt (protocol.md v3.8, state.background). No GPUI here, so tests
// read it.

// As the TUI writes a time: "45s", "10m42s", "1h02m", "2d03h".
export function bgElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${pad(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d${pad(Math.floor((s % 86400) / 3600))}h`;
}

// As the TUI writes tokens: "950", "303.0k", "1.2m".
export function bgTokens(n) {
  if (n == null || !(n > 0)) return null;
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}m`;
  return `${(n / 1e9).toFixed(1)}b`;
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// The strip's heading, like the TUI's footer: "1 background agent", "3 background tasks · 1 shell".
export function bgSummary(b) {
  if (!b) return "";
  const running = b.tasks.filter((x) => x.state === "running");
  const agents = running.filter((x) => x.kind === "agent").length;
  const runs = running.filter((x) => x.kind === "workflow").length;
  const parts = [];
  if (agents && runs) parts.push(plural(agents + runs, "background task"));
  else if (agents) parts.push(plural(agents, "background agent"));
  else if (runs) parts.push(plural(runs, "workflow"));
  if (b.shells) parts.push(plural(b.shells, "shell"));
  if (b.monitors) parts.push(plural(b.monitors, "monitor"));
  if (!parts.length) {
    const ended = b.tasks.length;
    return ended ? `${plural(ended, "background task")} ended` : "";
  }
  return parts.join(" · ");
}

// Each row's parts. `now` is the host's time now (state.background.at, moved on by the time since it came).
export function bgRows(b, now) {
  if (!b) return [];
  return b.tasks.map((x) => {
    const end = x.endedAt ?? now;
    const time = bgElapsed(end - x.startedAt);
    const tokens = bgTokens(x.tokens);
    const meta = [];
    if (x.kind === "workflow" && x.total) meta.push(`${x.done ?? 0}/${x.total}`);
    if (x.failed) meta.push(`${x.failed} failed`);
    if (x.state !== "running") meta.push(x.state);
    meta.push(time);
    if (tokens) meta.push(`↓ ${tokens} tokens`);
    return {
      id: x.id, kind: x.kind, state: x.state,
      name: x.name,
      title: x.kind === "agent" ? x.title ?? "" : "",
      activity: x.state === "running" ? x.activity ?? "" : "",
      worktree: x.worktree ?? null,
      progress: x.kind === "workflow" && x.total ? Math.min(1, (x.done ?? 0) / x.total) : null,
      meta: meta.join(" · "),
    };
  });
}

// The tick that moves the times on: while something runs, once a second.
export function bgTicking(b) {
  return Boolean(b?.tasks?.some((x) => x.state === "running"));
}
