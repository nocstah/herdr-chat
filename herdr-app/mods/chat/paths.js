// File paths in an answer's prose as links (no toolkit imports: tests/host/paths.test.ts runs it in Node).
// An inline `! command` is a link too (bang.js): the chat asks where to run it.

import { bangOf, runHref } from "./bang.js";

const FENCE = /^\s*(`{3,}|~{3,})/;

// File paths in an answer, as links the chat opens in Herdr's files viewer or an
// editor (a tool's path opens the same way): an inline code span that is one
// (`src/upload.ts:14`, `/etc/hosts.conf`, `~/docs/plan.md`, `README.md:3`: a
// folder or a line number), or a bare one with a folder and an extension
// (src/upload.ts:14). Not inside code fences, links, autolinks or URLs. A link
// is FILE_LINK and the path, its line after a colon.
export const FILE_LINK = "herdr-chat-file:";
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]{0,9}`;
const LINE = String.raw`(?::\d+(?:[:-]\d+)?)?`;
const NAME = String.raw`[\w@+-][\w.@+-]*`;
const CODE_PATH = new RegExp(String.raw`^(?:~/|\.{1,2}/|/)?(?:[\w.@+-]+/)*${NAME}${EXT}${LINE}$`);
const BARE_PATH = new RegExp(String.raw`(?<![\w/.:~@-])((?:~/|\.{1,2}/|/)?(?:[\w.@+-]+/)+${NAME}${EXT}${LINE})(?![\w/])`, "g");
const SKIP = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|\b[a-zA-Z][\w+.-]*:\/\/[^\s)>\]]+/g;
const fileHref = (/** @type {string} */ p) => FILE_LINK + encodeURIComponent(p);

const LINE_FRAG = /^L?(\d+)(?:C\d+)?(?:[-–]L?\d+(?:C\d+)?)?$/i;
const TRAILING_LINE = /^(.*?):(\d+)(?:[:-]\d+)?$/;

/** Decodes percent-escapes safely, falling back to raw text on malformed sequences. */
function safeDecode(/** @type {string} */ s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Splits an optional trailing `:line` (never a Windows drive like `C:`) off a path. */
function splitTrailingLine(/** @type {string} */ p) {
  const m = TRAILING_LINE.exec(p);
  if (m?.[1] && !/^[A-Za-z]$/.test(m[1])) return { path: m[1], line: Number(m[2]) };
  return { path: p, line: null };
}

/** Parses `#L10`, `#L10-L20`, `#L10C5`, `#10`, or a heading `#anchor`. */
function parseFragment(/** @type {string} */ rawFrag) {
  if (!rawFrag) return { line: null, anchor: null };
  const frag = safeDecode(rawFrag).trim();
  if (!frag) return { line: null, anchor: null };
  const lm = LINE_FRAG.exec(frag);
  if (lm) return { line: Number(lm[1]), anchor: null };
  return { line: null, anchor: frag };
}

/** @param {string} text markdown @returns {string} */
export function linkPaths(text) {
  /** @type {string | null} */
  let fence = null;
  return text.split("\n").map((/** @type {string} */ line) => {
    const f = FENCE.exec(line);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return line; }
    if (f) { fence = f[1]; return line; }
    if (/^( {4}|\t)/.test(line)) return line; // an indented code block's line (or a nested list's: left as written)
    let out = "", at = 0;
    const bare = (/** @type {string} */ s) => s.replace(BARE_PATH, (/** @type {string} */ _m, /** @type {string} */ p) => `[${p}](${fileHref(p)})`);
    for (const m of line.matchAll(SKIP)) {
      out += bare(line.slice(at, m.index));
      const code = m[1] ? m[2].trim() : null;
      const bang = code ? bangOf(code) : null;
      out += bang ? `[${m[0]}](${runHref(bang)})`
        : code && CODE_PATH.test(code) && (code.includes("/") || /:\d+/.test(code)) ? `[${m[0]}](${fileHref(code)})` : m[0];
      at = m.index + m[0].length;
    }
    return out + bare(line.slice(at));
  }).join("\n");
}

// A clickable file link → {path, line (explicit 1-based line or null), anchor (heading anchor or null)};
// null for web URLs, unknown schemes, or pure same-doc #anchors.
// Recognizes:
// - `herdr-chat-file:<encoded>` (links synthesized by linkPaths)
// - `file:///path/to/file.md`, `file://localhost/path/to/file.md` (with `#L10-L20`, `#anchor`, or `:10`)
// - relative or absolute file paths in markdown links (`docs/plan.md`, `./a.ts#L5`, `/tmp/x.md`, `~/x.md`)
/** @param {string} url @returns {{path: string, line: number | null, anchor: string | null} | null} */
export function fileLink(url) {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (!raw) return null;

  if (raw.startsWith(FILE_LINK)) {
    let p;
    try { p = decodeURIComponent(raw.slice(FILE_LINK.length)); } catch { return null; }
    if (!p) return null;
    const { path, line } = splitTrailingLine(p);
    return path ? { path, line, anchor: null } : null;
  }

  let body;
  if (/^file:/i.test(raw)) {
    const rest = raw.slice(5);
    if (rest.startsWith("//")) {
      const afterSlashes = rest.slice(2);
      if (afterSlashes.startsWith("/")) body = afterSlashes;
      else if (/^localhost\//i.test(afterSlashes)) body = afterSlashes.slice("localhost".length);
      else return null; // remote host in file://host/path
    } else if (rest.startsWith("/")) {
      body = rest; // file:/abs/path
    } else {
      return null;
    }
  } else {
    if (raw.startsWith("#") || raw.startsWith("//")) return null;
    const isFilenameLine = /^[A-Za-z0-9_.@-]+\.[A-Za-z0-9]+:\d+(?:[:-]\d+)?$/.test(raw);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) && !/^[a-zA-Z]:[\\/]/.test(raw) && !isFilenameLine) return null;
    body = raw;
  }

  const hashAt = body.indexOf("#");
  const rawFrag = hashAt >= 0 ? body.slice(hashAt + 1) : "";
  const beforeHash = hashAt >= 0 ? body.slice(0, hashAt) : body;
  const queryAt = beforeHash.indexOf("?");
  const rawPath = queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash;
  if (!rawPath) return null;

  let decoded = safeDecode(rawPath);
  if (/^\/[A-Za-z]:\//.test(decoded)) decoded = decoded.slice(1);

  const frag = parseFragment(rawFrag);
  const { path, line: colonLine } = splitTrailingLine(decoded);
  if (!path) return null;
  const line = frag.line ?? colonLine;
  return { path, line, anchor: line ? null : frag.anchor };
}

/**
 * Resolves `path` against `cwd` (and optional `homeDir` for `~/`), normalizing `.` and `..`.
 * Leaves `~/...` intact when `homeDir` is omitted (e.g. a remote machine whose `$HOME` differs).
 * @param {string} path
 * @param {string | null | undefined} cwd
 * @param {string | null | undefined} [homeDir]
 * @returns {string}
 */
export function resolveFilePath(path, cwd, homeDir = null) {
  let p = String(path ?? "");
  if (!p) return "";
  if (p === "~" || p.startsWith("~/")) {
    if (!homeDir) return p;
    p = homeDir.replace(/\/+$/, "") + p.slice(1);
  }
  const base = p.startsWith("/") ? "" : String(cwd ?? "").replace(/\/+$/, "");
  const full = p.startsWith("/") ? p : base ? `${base}/${p}` : p;
  if (!full.startsWith("/")) return full;
  const parts = [];
  for (const seg of full.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (parts.length) parts.pop(); }
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}
