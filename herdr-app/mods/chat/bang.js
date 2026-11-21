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

/**
 * The script a new tab runs (bash -c): each command shown, then run, stopping
 * at the first that fails; then its exit status, open until Enter.
 * @param {string[]} commands
 */
export function tabScript(commands) {
  const end = `printf '\\n[exit %s] Enter closes this tab.' "$status"\nread -r _`;
  const steps = commands.map((c, i) => `${i ? '[ "$status" -ne 0 ] || ' : ""}{ printf '${i ? "\\n" : ""}$ %s\\n' ${quoted(c)}; {\n${c}\n}; status=$?; }`);
  return `status=0\n${steps.join("\n")}\n${end}`;
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
