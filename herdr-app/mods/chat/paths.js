// File paths in an answer's prose as links (no toolkit imports: tests/host/paths.test.ts runs it in Node).
// An inline `! command` is a link too (bang.js): the chat asks where to run it.

import { bangOf, runHref } from "./bang.js";

const FENCE = /^\s*(`{3,}|~{3,})/;

// File paths in an answer, as links the chat opens in an editor (a tool's path
// opens the same way): an inline code span that is one (`src/upload.ts:14`,
// `/etc/hosts.conf`, `README.md:3`: a folder or a line number), or a bare one
// with a folder and an extension (src/upload.ts:14). Not inside code fences,
// links, autolinks or URLs. A link is FILE_LINK and the path, its line after a colon.
export const FILE_LINK = "herdr-chat-file:";
const EXT = String.raw`\.[A-Za-z][A-Za-z0-9]{0,9}`;
const LINE = String.raw`(?::\d+(?:[:-]\d+)?)?`;
const NAME = String.raw`[\w@+-][\w.@+-]*`;
const CODE_PATH = new RegExp(String.raw`^(?:\.{1,2}/|/)?(?:[\w.@+-]+/)*${NAME}${EXT}${LINE}$`);
const BARE_PATH = new RegExp(String.raw`(?<![\w/.:~@-])((?:\.{1,2}/|/)?(?:[\w.@+-]+/)+${NAME}${EXT}${LINE})(?![\w/])`, "g");
const SKIP = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|\b[a-zA-Z][\w+.-]*:\/\/[^\s)>\]]+/g;
const fileHref = (/** @type {string} */ p) => FILE_LINK + encodeURIComponent(p);

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

// A link linkPaths made → {path, line}; null for any other link.
/** @param {string} url @returns {{path: string, line: number} | null} */
export function fileLink(url) {
  if (!url?.startsWith(FILE_LINK)) return null;
  let p;
  try { p = decodeURIComponent(url.slice(FILE_LINK.length)); } catch { return null; }
  const m = /^(.*?)(?::(\d+)(?:[:-]\d+)?)?$/.exec(p);
  return m?.[1] ? { path: m[1], line: m[2] ? Number(m[2]) : 1 } : null;
}
