// `! <command>` lines in an answer, as OmaRelay's "Run what it asked" (Ctrl+!)
// finds them: lines of fenced blocks that start with `!` (one after another:
// a group, run in order) and inline code spans that do. The chat offers each
// to run in the agent (the terminal view types `!command` into Claude Code,
// which runs it and sees what it printed) or in a new tab of the space (for a
// command that asks something, such as sudo's password). No imports:
// tests/host/bang.test.ts runs it in Node.

/** `!` then the command: never `!=`, `!!` or nothing. */
const BANG = /^!\s*([^\s=!].*)$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const placeholder = (/** @type {string} */ c) => /^<[^<>]+>$/.test(c);

/**
 * A fenced block's code → its `!` commands as runs: lines one after another
 * (blank lines between them too) are one run; a line that is no `!` command
 * ends it. A line ending in a backslash goes on in the next.
 * @param {string} code @returns {string[][]}
 */
export function runsInCode(code) {
  /** @type {string[][]} */
  const runs = [];
  /** @type {string[] | null} */
  let run = null;
  const lines = String(code).replace(/\n$/, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = BANG.exec(lines[i].trim());
    if (!m) { if (lines[i].trim()) run = null; continue; }
    let command = m[1].trim();
    while (/\\$/.test(command) && i + 1 < lines.length) command = `${command.slice(0, -1).trimEnd()} ${lines[++i].trim()}`;
    if (!command || command.length > 4000 || placeholder(command)) { run = null; continue; }
    if (!run) runs.push(run = []);
    run.push(command);
  }
  return runs;
}

/** An inline code span's text → its command, when it's `! <command>`; else null. @param {string} span */
export function bangOf(span) {
  const m = BANG.exec(String(span).trim());
  const c = m ? m[1].trim() : "";
  return c && c.length <= 4000 && !placeholder(c) ? c : null;
}

/** Whether a command ends cleanly where ` && ` would join it to the next (no comment, open quote, here-document or trailing `&;|\`). @param {string} command */
function joins(command) {
  /** @type {string | null} */
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (ch === "\\") { i++; continue; }
    if (quote) { if (ch === '"') quote = null; continue; }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "#" && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) return false;
  }
  return quote === null && !/(^|[^<])<<(?!<)/.test(command) && !/[&;|\\]\s*$/.test(command);
}

/** A run as the one line typed after `!`: `a && b`, in one shell, stopping at the first that fails; null when it can't be joined. @param {string[]} commands */
export function oneLine(commands) {
  return commands.every(joins) ? commands.join(" && ") : null;
}

const quoted = (/** @type {string} */ s) => `'${s.replaceAll("'", "'\\''")}'`;

/** First line of every run tab's script so the closing step verifies this terminal belongs to it. */
export const RUN_MARK = "# herdr-chat: a command an agent asked for";

/**
 * The script a new tab runs (bash -c): RUN_MARK, then each command shown and run,
 * stopping at the first that fails; then its exit status, open until Enter.
 * Enter closes the tab: Herdr wraps tab.new programs in an interactive shell that
 * stays open after the command exits (and herdr-core may have `keep` on), so the
 * script disables `keep` and kills its own terminal once `hc get` confirms RUN_MARK
 * in its argv (leaving any other terminal, such as a test runner, untouched).
 * @param {string[]} commands
 */
export function tabScript(commands) {
  const end = `set +eu 2>/dev/null || true
printf '\\n[exit %s] Enter closes this tab.' "$status"
read -r _ || true
__hc_t=\${HC_TERMINAL_ID-}
if [ -n "$__hc_t" ]; then
  [ -z "\${HC_TERMINAL_SOCKET-}" ] || export HC_SOCKET="$HC_TERMINAL_SOCKET"
  __hc_bin=$(command -v hc 2>/dev/null || true)
  if [ -z "$__hc_bin" ]; then
    for __hc_p in "$HOME/.local/bin/hc" /opt/homebrew/bin/hc /usr/local/bin/hc "$HOME/.cargo/bin/hc"; do
      [ -x "$__hc_p" ] && { __hc_bin=$__hc_p; break; }
    done
  fi
  if [ -n "$__hc_bin" ] && "$__hc_bin" get "$__hc_t" --json 2>/dev/null | grep -qF ${quoted(RUN_MARK)}; then
    "$__hc_bin" keep "$__hc_t" --off >/dev/null 2>&1 || true
    "$__hc_bin" kill "$__hc_t" >/dev/null 2>&1 || true
    sleep 2
  fi
fi`;
  const steps = commands.map((c, i) => `${i ? '[ "$status" -ne 0 ] || ' : ""}{ printf '${i ? "\\n" : ""}$ %s\\n' ${quoted(c)}; {\n${c}\n}; status=$?; }`);
  return `${RUN_MARK}\nstatus=0\n${steps.join("\n")}\n${end}`;
}

/** An inline `! command` in prose is a link to this (paths.js linkPaths); the chat asks where to run it. */
export const RUN_LINK = "herdr-chat-run:";
/** @param {string} command */
export const runHref = (command) => RUN_LINK + encodeURIComponent(command);
/** @param {string} url @returns {string | null} */
export function runLink(url) {
  if (!url?.startsWith(RUN_LINK)) return null;
  try { return decodeURIComponent(url.slice(RUN_LINK.length)) || null; } catch { return null; }
}

const normCmd = (/** @type {string} */ c) => String(c ?? "").replace(/\s+/g, " ").trim();

/** Normalized canonical key for a `!` command run. @param {string | string[]} commands */
export function bangKey(commands) {
  const list = Array.isArray(commands) ? commands : [commands];
  return list.map(normCmd).filter(Boolean).join("\n");
}

/** Compact non-reversible FNV-1a hash so persisted run markers never write raw command text to localStorage. @param {string} text */
export function bangHash(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `b-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Checks whether `commands` has already been executed in the conversation timeline after `afterMessageId`
 * (e.g. via a clicked Run button, an automatically drained Follow-up queue item, Ctrl+!, Wrap up, or manual `!cmd`).
 * @param {any[]} items
 * @param {string | null | undefined} afterMessageId
 * @param {string[]} commands
 * @returns {{ ran: true, where: "agent" } | null}
 */
export function findAutoRan(items, afterMessageId, commands) {
  if (!Array.isArray(items) || !items.length || !Array.isArray(commands) || !commands.length) return null;
  let start = 0;
  if (afterMessageId) {
    const idx = items.findIndex((it) => it?.id === afterMessageId);
    if (idx >= 0) start = idx + 1;
  }
  const joined = oneLine(commands);
  const joinedNorm = joined ? normCmd(joined) : null;
  const parts = commands.map(normCmd).filter(Boolean);
  if (!parts.length) return null;
  const seenParts = new Set();
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (!it || it.kind !== "tool") continue;
    if (it.status === "pending") continue;
    const isBash = it.detail?.type === "bash" || /^bash$/i.test(String(it.name ?? "")) || String(it.toolCallId ?? "").startsWith("you-bash");
    if (!isBash) continue;
    const cmd = normCmd(it.detail?.command ?? it.args?.command ?? "");
    if (!cmd) continue;
    if (joinedNorm && cmd === joinedNorm) return { ran: true, where: "agent" };
    if (parts.length === 1 && cmd === parts[0]) return { ran: true, where: "agent" };
    for (const p of parts) if (cmd === p) seenParts.add(p);
  }
  return seenParts.size === parts.length ? { ran: true, where: "agent" } : null;
}
