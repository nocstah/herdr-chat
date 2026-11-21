// The face a terminal shows when Claude Code starts in it: settings.json's
// `claude.face`, "chat" for its chat view (the terminal view, faces.js), else
// the terminal as always. The commands block (main.js FirstFace) looks at the
// terminals every half second and flips one where Claude Code just started,
// as the flip key does: a new terminal, or `claude` typed in a shell. Once
// per start: flipping back to the terminal stays until Claude Code starts
// there again. Terminals that already ran it when the app started keep the
// face the layout document kept, and another machine's are its own app's.
// No imports, so the tests load it (tests/host/first-face.test.ts).

/** How recent a start is to count: a terminal made, or its agent's first report, within this. */
export const RECENT_MS = 60_000;

/** @param {any} settings data/herdr-chat/settings.json @returns {"chat" | "terminal"} */
export function faceOf(settings) {
  return settings?.claude?.face === "chat" ? "chat" : "terminal";
}

/** settings.json with `claude.face` set, the rest as it was. @param {any} settings @param {"chat" | "terminal"} face */
export function withFace(settings, face) {
  const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const claude = s.claude && typeof s.claude === "object" && !Array.isArray(s.claude) ? s.claude : {};
  return { ...s, claude: { ...claude, face } };
}

/**
 * Which terminals Claude Code started in since the last look: [address…]. `was`: address → ran it at the last look
 * (null at the first: nothing then). `list`: this computer's terminals as the app gives them; `runs(t)`: whether t
 * runs Claude Code now. A terminal counts when it runs it now and didn't at the last look, and its start is recent
 * (made, or its status last changed, within RECENT_MS: the core's created_ms and status_ms), so one the app only
 * lists late as it starts, running it for hours, doesn't. Without those times, only a change seen here counts.
 * @param {Map<string, boolean> | null} was @param {any[]} list @param {(t: any) => boolean} runs @param {number} now
 */
export function started(was, list, runs, now) {
  if (!was) return [];
  const out = [];
  for (const t of list) {
    if (!t?.address || !runs(t) || was.get(t.address)) continue;
    const times = [t.created_ms, t.status_ms].filter((x) => typeof x === "number");
    if (times.length ? Math.max(...times) >= now - RECENT_MS : was.has(t.address)) out.push(t.address);
  }
  return out;
}
