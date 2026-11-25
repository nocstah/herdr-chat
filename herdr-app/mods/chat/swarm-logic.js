// Pure helpers for Antigravity `/swarm` state in Herdr Chat view.
// Kept free of gpui-kit / herdr imports so Node unit tests exercise it directly.

const SCREENSHOT_LINE_RE = /^\s*Screenshot:\s*\/[^\s|]+\.(?:png|jpe?g|webp|gif)(?:\s*\|\s*.*)?$/i;
const SEQ_REF_RE = /(?:^|[^a-zA-Z0-9_])#(\d{1,5})\b/g;

/** Concise status counts + busiest worker's live activity for the docked swarm strip. */
export function swarmStatusSummary(swarm) {
  if (!swarm) return null;
  const c = swarm.counts ?? {};
  const members = Array.isArray(swarm.members) ? swarm.members : [];
  const lead =
    members.find((m) => !m.role_worker && !m.killed && m.status === "blocked") ??
    members.find((m) => !m.role_worker && !m.killed && m.status === "working" && m.activity) ??
    members.find((m) => !m.role_worker && !m.killed && m.status === "working") ??
    null;
  return {
    title: swarm.title || "Swarm",
    headSeq: swarm.head_seq ?? 0,
    working: c.working ?? 0,
    waiting: c.waiting ?? 0,
    blocked: c.blocked ?? 0,
    killed: c.killed ?? 0,
    active: c.active ?? 0,
    attention: c.attention ?? 0,
    workersWorking: c.workers_working ?? 0,
    workersTotal: c.workers_total ?? 0,
    leadMember: lead?.name ?? null,
    leadStatus: lead?.status ?? null,
    leadActivity: lead?.activity ?? lead?.failure?.message ?? null,
  };
}

/** Deterministic theme-aware accent color for a swarm member name. */
export function memberToneColor(name, t) {
  const palette = [t?.accent, t?.ansi5, t?.ansi2, t?.ansi3, t?.ansi6, t?.ansi4].filter(Boolean);
  if (!palette.length) return "#38bdf8";
  if (name === "coordinator") return palette[0];
  let hash = 0;
  const s = String(name ?? "");
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export function statusToneColor(status, t) {
  if (status === "blocked") return t?.ansi1 ?? t?.blocked ?? "#f87171";
  if (status === "working") return t?.ansi2 ?? t?.accent ?? "#34d399";
  if (status === "waiting") return t?.muted ?? "#9ca3af";
  return t?.dim ?? "#6b7280";
}

export function workstreamToneColor(state, t) {
  if (state === "blocked" || state === "failed") return t?.ansi1 ?? "#f87171";
  if (state === "done") return t?.ansi2 ?? "#34d399";
  if (state === "review") return t?.ansi3 ?? "#fbbf24";
  if (state === "active") return t?.accent ?? "#60a5fa";
  return t?.dim ?? "#6b7280";
}

export function statusLabel(status) {
  if (status === "working") return "working";
  if (status === "waiting") return "waiting";
  if (status === "blocked") return "needs approval";
  if (status === "killed") return "stopped";
  return String(status || "unknown");
}

/** Strips `Screenshot: /path | caption` lines from board prose when thumbnail cards already show them. */
export function stripScreenshotLines(text) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => !SCREENSHOT_LINE_RE.test(line))
    .join("\n")
    .trim();
}

/** Extracts unique cited `#seq` numbers from a message's prose. */
export function extractSeqRefs(text, headSeq = 0) {
  const out = [];
  const s = String(text ?? "");
  for (const m of s.matchAll(SEQ_REF_RE)) {
    const n = Number(m[1]);
    if (Number.isSafeInteger(n) && n >= 1 && (headSeq <= 0 || n <= headSeq) && !out.includes(n)) {
      out.push(n);
    }
  }
  return out.slice(0, 8);
}

/** Filters board messages by channel, sender, and substring search. */
export function filterSwarmMessages(swarm, { channel = "all", sender = "all", search = "" } = {}) {
  const list = Array.isArray(swarm?.messages) ? swarm.messages : [];
  const q = String(search ?? "").trim().toLowerCase();
  return list.filter((m) => {
    if (channel && channel !== "all" && m.channel !== channel) return false;
    if (sender && sender !== "all" && m.agent !== sender) return false;
    if (q) {
      const hay = `${m.agent} #${m.seq} #${m.channel} ${m.text}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const SEV_RANK = { high: 0, med: 1, low: 2 };

/** Combines deterministic system alerts + narrator attention items, high severity first. */
export function collectAttention(swarm) {
  if (!swarm) return [];
  const items = [
    ...(Array.isArray(swarm.system_attention) ? swarm.system_attention : []),
    ...(Array.isArray(swarm.narrator?.attention) ? swarm.narrator.attention : []),
  ];
  for (const th of swarm.narrator?.threads ?? []) {
    if (Array.isArray(th.attention)) items.push(...th.attention);
  }
  return items.sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9));
}

/** Returns narrator workstreams (or synthesized plan/member workstreams when no narrator view exists). */
export function collectWorkstreams(swarm) {
  if (!swarm) return [];
  const fromNarrator = [];
  if (Array.isArray(swarm.narrator?.workstreams)) fromNarrator.push(...swarm.narrator.workstreams);
  for (const th of swarm.narrator?.threads ?? []) {
    if (Array.isArray(th.workstreams)) fromNarrator.push(...th.workstreams);
  }
  if (fromNarrator.length) return fromNarrator;

  const membersByName = new Map((swarm.members ?? []).map((m) => [m.name, m]));
  if (swarm.plan?.threads?.length) {
    return swarm.plan.threads.map((th) => {
      const owners = th.tasks ?? [];
      const states = owners.map((n) => membersByName.get(n)?.status);
      const state = states.includes("blocked")
        ? "blocked"
        : states.includes("working")
          ? "active"
          : states.length && states.every((st) => st === "killed")
            ? "done"
            : "queued";
      return {
        id: th.id,
        title: th.title,
        owners,
        state,
        note: th.goal || "",
        refs: [],
      };
    });
  }

  return (swarm.members ?? [])
    .filter((m) => !m.role_worker && m.name !== "coordinator")
    .map((m) => ({
      id: `member-${m.name}`,
      title: swarm.plan?.tasks?.[m.name] || `@${m.name}`,
      owners: [m.name],
      state: m.killed ? "done" : m.status === "blocked" ? "blocked" : m.status === "working" ? "active" : "queued",
      note: m.activity || m.failure?.message || (m.status === "waiting" ? "Waiting on board" : ""),
      refs: [],
    }));
}

/** Groups roster into active (working/blocked), waiting, support roles (narrator/monitor), and stopped. */
export function groupSwarmMembers(swarm) {
  const members = Array.isArray(swarm?.members) ? swarm.members : [];
  const active = [];
  const waiting = [];
  const roles = [];
  const stopped = [];
  for (const m of members) {
    if (m.role_worker) roles.push(m);
    else if (m.killed) stopped.push(m);
    else if (m.status === "working" || m.status === "blocked") active.push(m);
    else waiting.push(m);
  }
  return { active, waiting, roles, stopped };
}

/** Pure step calculation for timeline replay (`null` means Live at `maxSeq`). */
export function nextReplaySeq(seqs, currentSeq, delta, maxSeq) {
  if (!Array.isArray(seqs) || !seqs.length) return null;
  const cur = currentSeq == null ? maxSeq : currentSeq;
  if (delta < 0) {
    const idx = seqs.findIndex((s) => s >= cur);
    const prevIdx = idx <= 0 ? 0 : idx - 1;
    return seqs[prevIdx];
  }
  const nextIdx = seqs.findIndex((s) => s > cur);
  if (nextIdx < 0 || seqs[nextIdx] >= maxSeq) return null;
  return seqs[nextIdx];
}

export function formatSwarmTime(ts, fallback = "") {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }
  if (typeof fallback === "string" && fallback.trim()) {
    const m = /\b(\d{2}:\d{2}(?::\d{2})?)\b/.exec(fallback);
    if (m) return m[1];
    return fallback.slice(0, 16);
  }
  return "";
}
