// The face a terminal shows when Claude Code or Codex starts in it:
// settings.json's `claude.face` and `codex.face`, "chat" for its chat view
// (the terminal view, faces.js) or "terminal" for the terminal as it is;
// DEFAULT_FACE without one. The commands block (main.js FirstFace) looks at
// the terminals every half second and flips one where the agent just
// started, as the flip key does: a new terminal, or `claude` or `codex` typed
// in a shell. Once per start: flipping back to the terminal stays until the
// agent starts there again. Terminals that already ran it when the app
// started keep the face the layout document kept.
//
// Another machine's terminal (a space of `hc machine`'s) is that machine's own
// app's to flip, with that machine's setting: its face is in its own layout
// document, which every app showing the space reads. While that app isn't
// running (only its core is: a closed lid's laptop, a server), the app that
// sees the start flips it there instead, with that machine's setting all the
// same (REMOTE_CHECK asks it). Never both: the check is that machine's app's
// socket, which answers while that app runs.
// No imports, so the tests load it (tests/host/first-face.test.ts).

/** How recent a start is to count: a terminal made, or its agent's first report, within this. */
export const RECENT_MS = 60_000;

/** The agents with a chat view of their terminal (their ids in settings.json and herdr-chat's providers). */
export const VIEW_AGENTS = ["claude", "codex", "antigravity"];

/** The face without a `claude.face` (or `codex.face`, or with one that's neither): its chat view. Other mods read this line as it is
 *  (OmaRelay's Settings window, to show the face a file without one gives): keep it one line. */
export const DEFAULT_FACE = "chat";

/** @param {any} settings data/herdr-chat/settings.json, null when it can't be read @param {string} [agent] @returns {"chat" | "terminal"} */
export function faceOf(settings, agent = "claude") {
  const face = settings?.[agent]?.face;
  return face === "chat" || face === "terminal" ? face : DEFAULT_FACE;
}

/** settings.json with the agent's `face` set, the rest as it was. @param {any} settings @param {"chat" | "terminal"} face @param {string} [agent] */
export function withFace(settings, face, agent = "claude") {
  const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
  const own = s[agent] && typeof s[agent] === "object" && !Array.isArray(s[agent]) ? s[agent] : {};
  return { ...s, [agent]: { ...own, face } };
}

/**
 * Which terminals an agent started in since the last look: [address…]. `was`: address → ran it at the last look
 * (null at the first: nothing then). `list`: this computer's terminals as the app gives them; `runs(t)`: whether t
 * runs it now. A terminal counts when it runs it now and didn't at the last look, and its start is recent
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

/**
 * What a machine says of its own first face, run there with /bin/sh (BSD sed too): whether its herdr-chat has the
 * setting (this file), whether its Herdr app runs (its socket answers a connection: tried with the node its install
 * named; a socket that can't be tried counts as running, so the two apps never both flip), its default (this file's
 * DEFAULT_FACE line, the terminal for a build from before it had one), the agents it has a view for (its VIEW_AGENTS
 * line, Claude Code alone before it had one), then its settings.json after a \x1e line.
 */
export const REMOTE_CHECK = [
  'h="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"; h="${h%/}"; f="$h/mods/new-chat/first-face.js"',
  '[ -f "$f" ] || { echo "herdr-chat=0"; exit 0; }',
  "d=$(sed -nE 's/^export const DEFAULT_FACE = \"(chat|terminal)\";$/\\1/p' \"$f\" | head -n 1)",
  "v=$(sed -nE 's/^export const VIEW_AGENTS = \\[(.*)\\];$/\\1/p' \"$f\" | head -n 1 | tr -d '\" ')",
  "n=$(sed -nE 's/^[[:space:]]*\"node\":[[:space:]]*\"([^\"]+)\".*/\\1/p' \"$h/mods/chat/config.json\" 2>/dev/null | head -n 1)",
  'a=0; if [ -S "$h/herdr-app.sock" ]; then a=1; "${n:-node}" -e \'const s=require("net").connect(process.argv[1]); s.on("connect",()=>process.exit(0)); s.on("error",()=>process.exit(1)); setTimeout(()=>process.exit(2),3000)\' "$h/herdr-app.sock" >/dev/null 2>&1; [ $? = 1 ] && a=0; fi',
  'printf "herdr-chat=1 app=%s default=%s agents=%s\\n\\036\\n" "$a" "${d:-terminal}" "${v:-claude}"',
  'cat "$h/data/herdr-chat/settings.json" 2>/dev/null; exit 0',
].join("\n");

/**
 * REMOTE_CHECK's answer: {herdrChat, app, agents, faces}, `faces` the face that machine's setting gives each agent
 * it has a view for (faceOf with its own default). Null when it isn't one (nothing then flips there from here).
 * @param {string} out @returns {{herdrChat: boolean, app: boolean, agents: string[], faces: Record<string, "chat" | "terminal">} | null}
 */
export function remoteAnswer(out) {
  const [head = "", rest = ""] = String(out ?? "").split("\n\x1e\n");
  const fields = Object.fromEntries(head.trim().split(/\s+/).map((w) => w.split("=")).filter((kv) => kv.length === 2));
  if (fields["herdr-chat"] === "0") return { herdrChat: false, app: false, agents: [], faces: {} };
  if (fields["herdr-chat"] !== "1" || !["0", "1"].includes(fields.app)) return null;
  let settings = null;
  try { settings = rest.trim() ? JSON.parse(rest) : {}; } catch {}
  const fallback = fields.default === "chat" ? "chat" : "terminal";
  const agents = (fields.agents || "claude").split(",").filter((a) => /^[a-z]+$/.test(a));
  /** @type {Record<string, "chat" | "terminal">} */
  const faces = {};
  for (const agent of agents) {
    const face = settings?.[agent]?.face;
    faces[agent] = face === "chat" || face === "terminal" ? face : fallback;
  }
  return { herdrChat: true, app: fields.app === "1", agents, faces };
}

/** Whether this app flips `agent`'s start on another machine: that machine's herdr-chat has a view for it and the
 *  setting, its own app doesn't run, and its setting for that agent is the chat view.
 *  @param {ReturnType<typeof remoteAnswer>} a @param {string} [agent] */
export function flipsThere(a, agent = "claude") {
  return Boolean(a?.herdrChat && !a.app && a.faces[agent] === "chat");
}
