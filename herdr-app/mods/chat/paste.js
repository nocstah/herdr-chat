// Terminal-style collapsed large pastes and verbatim user-bubble formatting.
// Kept free of gpui-kit / herdr imports so Node unit tests exercise it directly.

import { formatMention } from "./file-picker.js";
import { FILE_LINK } from "./paths.js";

/** Auto-collapse threshold: 10+ lines. */
export const PASTE_COLLAPSE_LINES = 10;
/** Auto-collapse threshold: 2+ lines with at least 600 chars. */
export const PASTE_COLLAPSE_MULTI_CHARS = 600;
/** Auto-collapse threshold: single line with at least 1,500 chars. */
export const PASTE_COLLAPSE_SINGLE_CHARS = 1500;
/** Max combined inline chars (draft + inline pastes) before switching to `.txt` file attachment. */
export const PASTE_INLINE_MAX_CHARS = 16_000;
/** Max raw UTF-8 byte size for a pasted `.txt` attachment sent over the host RPC channel. */
export const MAX_TEXT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

// C0 control characters excluding \t (0x09), \n (0x0a), \r (0x0d), plus DEL (0x7f).
const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const CONTROL_CHAR_GLOBAL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// CommonMark §2.4 ASCII punctuation characters that can trigger Markdown, GFM, HTML,
// math, or smart-punctuation syntax when unescaped inside TextView.markdown.
const MD_ESCAPE_RE = /[\\`*_{}[\]()#+\-.!|>~"'&$:=<]/g;

/** Normalizes CRLF and stray CR line endings to LF without altering indentation or content. */
export function normalizeLineEndings(raw) {
  return String(raw ?? "").replace(/\r\n?/g, "\n");
}

/** Number of lines in normalized text (0 when empty). */
export function countLines(text) {
  if (!text) return 0;
  return text.split("\n").length;
}

/** True when `text` contains terminal control characters (ANSI escapes, NUL, BEL, etc.). */
export function hasTerminalControlChars(text) {
  return CONTROL_CHAR_RE.test(String(text ?? ""));
}

/**
 * Decides whether pasted plain text should auto-collapse into a composer chip
 * instead of dumping directly into the textarea. Short pastes, URLs, and normal
 * dictation stay inline and editable.
 * @param {string} raw
 * @returns {boolean}
 */
export function shouldCollapsePaste(raw) {
  const text = normalizeLineEndings(raw);
  if (!text) return false;
  if (hasTerminalControlChars(text)) return true;
  const lines = countLines(text);
  if (lines >= PASTE_COLLAPSE_LINES) return true;
  if (lines >= 2 && text.length >= PASTE_COLLAPSE_MULTI_CHARS) return true;
  if (text.length >= PASTE_COLLAPSE_SINGLE_CHARS) return true;
  return false;
}

/**
 * Computes the single contiguous inserted substring between `before` and `after`
 * (used as a fallback when a paste arrives via middle-click or context menu
 * without passing through the keyboard paste action).
 * @param {string} before
 * @param {string} after
 * @returns {{ start: number, end: number, inserted: string } | null}
 */
export function detectInsertedSpan(before, after) {
  if (before === after || !after) return null;
  let prefix = 0;
  const minLen = Math.min(before.length, after.length);
  while (prefix < minLen && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  const maxSuffix = minLen - prefix;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  const end = after.length - suffix;
  if (end <= prefix) return null;
  return { start: prefix, end, inserted: after.slice(prefix, end) };
}

/** Formats an integer with comma separators (QuickJS-safe without relying on ICU locale). */
export function formatCount(n) {
  return String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Human-readable chip title matching terminal paste placeholders. */
export function pasteChipTitle(chip) {
  const lines = chip?.lineCount ?? 0;
  if (lines <= 1) return `Pasted text · ${formatCount(chip?.charCount ?? 0)} chars`;
  return `Pasted text · ${formatCount(lines)} lines`;
}

/** Compact single-line snippet of the first non-empty line, for tooltips. */
export function pastePreviewLine(text, maxLen = 72) {
  const first = normalizeLineEndings(text)
    .split("\n")
    .map((l) => l.replace(ANSI_CSI_RE, "").replace(CONTROL_CHAR_GLOBAL_RE, "").trim())
    .find((l) => l.length > 0) ?? "";
  const compact = first.replace(/\s+/g, " ");
  if (compact.length <= maxLen) return compact;
  return compact.slice(0, Math.max(1, maxLen - 1)).trimEnd() + "…";
}

/**
 * Creates a composer paste chip record.
 * @param {string} rawText
 * @param {number} seq 1-based monotonic paste counter for this chat
 */
export function createPastedChip(rawText, seq = 1) {
  const text = normalizeLineEndings(rawText);
  const lineCount = countLines(text);
  const charCount = text.length;
  const hasControlChars = hasTerminalControlChars(text);
  const id = `paste-${seq}`;
  const chip = {
    kind: "paste",
    id,
    text,
    lineCount,
    charCount,
    hasControlChars,
    mode: hasControlChars || charCount > PASTE_INLINE_MAX_CHARS ? "file" : "inline",
    path: null,
    fileName: seq > 1 ? `pasted-text-${seq}.txt` : "pasted-text.txt",
    sizeBytes: null,
    pending: false,
    error: null,
    label: "",
  };
  chip.label = pasteChipTitle(chip);
  return chip;
}

/**
 * Rebalances hybrid delivery mode (`"inline"` vs `"file"`) across all paste chips
 * given the current composer draft text.
 * - Any paste with terminal control characters is always `"file"`.
 * - Clean pastes stay `"inline"` greedily in order while the combined payload stays
 *   at or under `PASTE_INLINE_MAX_CHARS`; overflow switches to `"file"`.
 *
 * Returns arrays of chips that transitioned into needing upload (`toUpload`) or
 * no longer needing an already-uploaded host copy (`toDetach`).
 * @param {string} draftText
 * @param {Array<any>} pasteChips
 * @returns {{ changed: boolean, toUpload: Array<any>, toDetach: Array<any> }}
 */
export function rebalancePasteModes(draftText, pasteChips) {
  const draft = String(draftText ?? "").replace(/\s+$/, "");
  let runningChars = draft.length;
  let hasInlineContent = draft.length > 0;
  let changed = false;
  const toUpload = [];
  const toDetach = [];

  for (const chip of pasteChips ?? []) {
    let nextMode;
    if (chip.hasControlChars) {
      nextMode = "file";
    } else {
      const sep = hasInlineContent ? 2 : 0;
      if (runningChars + sep + chip.charCount <= PASTE_INLINE_MAX_CHARS) {
        nextMode = "inline";
        runningChars += sep + chip.charCount;
        hasInlineContent = true;
      } else {
        nextMode = "file";
      }
    }
    if (chip.mode !== nextMode) {
      chip.mode = nextMode;
      changed = true;
    }
    if (nextMode === "file") {
      if (!chip.path && !chip.pending && !chip.error) toUpload.push(chip);
    } else if (chip.path || chip.error) {
      if (chip.path) toDetach.push(chip);
      chip.error = null;
      changed = true;
    }
  }

  return { changed, toUpload, toDetach };
}

/**
 * Whether a paste chip can safely be unpacked inline into the composer textarea
 * for direct editing.
 * @param {any} chip
 * @param {number} currentDraftLength
 * @returns {boolean}
 */
export function canUnpackInline(chip, currentDraftLength = 0) {
  if (!chip || chip.hasControlChars) return false;
  return (Number(currentDraftLength) || 0) + (chip.charCount ?? 0) <= PASTE_INLINE_MAX_CHARS;
}

/**
 * Assembles the exact prompt sent to the agent from composer draft text,
 * paste chips (inline verbatim + `@path` for file-backed chips), and attached files.
 * Leading `/command` or skill tokens stay at the start of `draftText`, and every
 * inline paste's internal formatting (leading spaces, blank lines, trailing spaces)
 * is preserved verbatim.
 * @param {string} draftText
 * @param {Array<any>} pasteChips
 * @param {string[]} [filePaths]
 * @param {string | null | undefined} [cwd]
 * @returns {string}
 */
export function assembleMessageWithPastes(draftText, pasteChips, filePaths = [], cwd = null) {
  const base = String(draftText ?? "").replace(/\s+$/, "");
  const parts = [];
  if (base) parts.push(base);

  const attachedFiles = [];
  for (const chip of pasteChips ?? []) {
    if (chip.mode === "file") {
      if (chip.path) attachedFiles.push(chip.path);
    } else if (chip.text) {
      parts.push(chip.text);
    }
  }
  for (const p of filePaths ?? []) {
    if (p) attachedFiles.push(p);
  }

  let body = parts.join("\n\n");
  if (attachedFiles.length) {
    const mentions = attachedFiles.map((p) => formatMention(p, cwd)).join(" ");
    body = body ? `${body}\n\n${mentions}` : mentions;
  }
  return body;
}

// -----------------------------------------------------------------------------
// Verbatim user-bubble tokenizer & CommonMark-escaped renderer
// -----------------------------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|file:\/\/)[^\s<>`]+/g;
const LOCALHOST_RE = /\b(?:localhost|127\.0\.0\.1)(?::\d{1,5})(?:\/[^\s<>`]*)?/g;
const QUOTED_MENTION_RE = /@"((?:\\"|[^"\n])+)"/g;
const UNQUOTED_MENTION_RE = /@((?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*(?::\d+(?:[:-]\d+)?)?)/g;
const BARE_FILE_RE = /(?:~\/|\.{1,2}\/|\/)?(?:[\w.@+-]+\/)+[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?:[:-]\d+)?)?/g;

const TRAILING_PUNCT_RE = /[.,;:!?'"`]+$/;
const HAS_EXT_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}(?::\d+(?:[:-]\d+)?)?$/;

function isWordBoundaryBefore(str, index, extraBlocked = "") {
  if (index <= 0) return true;
  const ch = str[index - 1];
  if (/[A-Za-z0-9_]/.test(ch)) return false;
  if (extraBlocked && extraBlocked.includes(ch)) return false;
  return true;
}

function isWordBoundaryAfter(str, end, extraBlocked = "") {
  if (end >= str.length) return true;
  const ch = str[end];
  if (/[A-Za-z0-9_]/.test(ch)) return false;
  if (extraBlocked && extraBlocked.includes(ch)) return false;
  return true;
}

/** Strips trailing sentence punctuation and unmatched closing brackets from URLs. */
function trimUrlCandidate(raw) {
  let s = raw;
  while (s.length > 0) {
    const trimmed = s.replace(TRAILING_PUNCT_RE, "");
    if (trimmed !== s) {
      s = trimmed;
      continue;
    }
    const last = s[s.length - 1];
    if (last === ")" || last === "]" || last === "}") {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < s.length; i++) {
        if (s[i] === open) opens++;
        else if (s[i] === last) closes++;
      }
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return s;
}

function encodeMarkdownHref(url) {
  return String(url)
    .replace(/\\/g, "%5C")
    .replace(/ /g, "%20")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
}

function fileHref(path) {
  return encodeMarkdownHref(FILE_LINK + encodeURIComponent(path));
}

function tokenizeLine(line) {
  if (!line) return [];
  /** @type {Array<{ start: number, end: number, priority: number, token: any }>} */
  const candidates = [];

  for (const m of line.matchAll(URL_RE)) {
    const clean = trimUrlCandidate(m[0]);
    if (!clean) continue;
    const isFileUrl = /^file:\/\//i.test(clean);
    candidates.push({
      start: m.index,
      end: m.index + clean.length,
      priority: 1,
      token: {
        kind: isFileUrl ? "file" : "url",
        text: clean,
        href: encodeMarkdownHref(clean),
      },
    });
  }

  for (const m of line.matchAll(LOCALHOST_RE)) {
    if (!isWordBoundaryBefore(line, m.index, "/:@")) continue;
    const clean = trimUrlCandidate(m[0]);
    if (!clean) continue;
    candidates.push({
      start: m.index,
      end: m.index + clean.length,
      priority: 2,
      token: {
        kind: "url",
        text: clean,
        href: encodeMarkdownHref(`http://${clean}`),
      },
    });
  }

  for (const m of line.matchAll(QUOTED_MENTION_RE)) {
    if (!isWordBoundaryBefore(line, m.index)) continue;
    const rawPath = m[1].replace(/\\"/g, '"');
    if (!rawPath) continue;
    candidates.push({
      start: m.index,
      end: m.index + m[0].length,
      priority: 3,
      token: {
        kind: "file",
        text: m[0],
        path: rawPath,
        href: fileHref(rawPath),
      },
    });
  }

  for (const m of line.matchAll(UNQUOTED_MENTION_RE)) {
    if (!isWordBoundaryBefore(line, m.index, ".:/-")) continue;
    const raw = trimUrlCandidate(m[1]);
    if (!raw) continue;
    // Require a directory separator or a file extension so `@username` isn't linkified.
    if (!raw.includes("/") && !HAS_EXT_RE.test(raw)) continue;
    const full = `@${raw}`;
    candidates.push({
      start: m.index,
      end: m.index + full.length,
      priority: 4,
      token: {
        kind: "file",
        text: full,
        path: raw,
        href: fileHref(raw),
      },
    });
  }

  for (const m of line.matchAll(BARE_FILE_RE)) {
    if (!isWordBoundaryBefore(line, m.index, "/.:~@-")) continue;
    const end = m.index + m[0].length;
    if (!isWordBoundaryAfter(line, end, "/")) continue;
    candidates.push({
      start: m.index,
      end,
      priority: 5,
      token: {
        kind: "file",
        text: m[0],
        path: m[0],
        href: fileHref(m[0]),
      },
    });
  }

  if (!candidates.length) return [{ kind: "text", text: line }];

  candidates.sort((a, b) => a.start - b.start || a.priority - b.priority || b.end - a.end);

  const tokens = [];
  let cursor = 0;
  for (const c of candidates) {
    if (c.start < cursor) continue;
    if (c.start > cursor) tokens.push({ kind: "text", text: line.slice(cursor, c.start) });
    tokens.push(c.token);
    cursor = c.end;
  }
  if (cursor < line.length) tokens.push({ kind: "text", text: line.slice(cursor) });
  return tokens;
}

/**
 * Splits a user message into verbatim tokens preserving every single character,
 * while identifying clickable URLs, localhost links, `@path` mentions, and file paths.
 * @param {string} text
 * @returns {Array<{ kind: "text" | "url" | "file", text: string, href?: string, path?: string }>}
 */
export function tokenizeUserMessage(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const lineTokens = tokenizeLine(lines[i]);
    for (const tok of lineTokens) {
      if (tok.kind === "text" && out.length && out[out.length - 1].kind === "text") {
        out[out.length - 1].text += tok.text;
      } else {
        out.push(tok);
      }
    }
    if (i < lines.length - 1) {
      if (out.length && out[out.length - 1].kind === "text") out[out.length - 1].text += "\n";
      else out.push({ kind: "text", text: "\n" });
    }
  }
  return out;
}

function escapeMarkdownText(s) {
  return String(s).replace(MD_ESCAPE_RE, "\\$&");
}

function preserveWhitespace(s, { atLineStart = false, atLineEnd = false } = {}) {
  let out = s.replace(/\t/g, "\u00a0\u00a0\u00a0\u00a0");
  if (atLineStart) {
    out = out.replace(/^ +/, (m) => "\u00a0".repeat(m.length));
  }
  if (atLineEnd) {
    out = out.replace(/ +$/, (m) => "\u00a0".repeat(m.length));
  }
  // Keep a single breakable space followed by non-breaking spaces for interior runs.
  out = out.replace(/ {2,}/g, (m) => " " + "\u00a0".repeat(m.length - 1));
  return out;
}

/**
 * Converts a user message into CommonMark-safe verbatim Markdown for GPUI's
 * `TextView.markdown`:
 * - All Markdown, GFM, HTML, and smart-punctuation characters are backslash-escaped
 *   so `#`, `*`, `_`, `---`, `>`, lists, tags, and code syntax render literally.
 * - Leading indentation, tabs, repeated interior spaces, and blank lines are preserved.
 * - URLs, localhost refs, `@path` mentions, and bare file paths become clickable links.
 * @param {string} text
 * @returns {string}
 */
export function verbatimUserMarkdown(text) {
  const normalized = normalizeLineEndings(text);
  if (!normalized) return "";
  const lines = normalized.split("\n");
  return lines
    .map((line, lineIdx) => {
      const isLast = lineIdx === lines.length - 1;
      if (!line) {
        // Keep blank lines as an explicit single-height line inside the paragraph.
        return isLast ? "\u00a0" : "\u00a0  ";
      }
      const tokens = tokenizeLine(line);
      const rendered = tokens
        .map((tok, i) => {
          const atLineStart = i === 0;
          const atLineEnd = i === tokens.length - 1;
          if (tok.kind === "text") {
            return preserveWhitespace(escapeMarkdownText(tok.text), { atLineStart, atLineEnd });
          }
          const label = preserveWhitespace(escapeMarkdownText(tok.text), { atLineStart, atLineEnd });
          return `[${label}](${tok.href})`;
        })
        .join("");
      return isLast ? rendered : `${rendered}  `;
    })
    .join("\n");
}
