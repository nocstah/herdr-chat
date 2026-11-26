// Assistant text → render blocks (protocol.md "Block"): CommonMark fenced code
// (``` and ~~~, info strings, fences inside list items) split out of the prose,
// and lines of nothing but pictures (v3.11) when the caller finds their files.
// Pure; highlighting, mermaid rendering and the picture files are render.ts's.
import type { ImageSize } from "./imagesize.ts";

export type RawBlock =
  | { type: "markdown"; text: string }
  | { type: "code"; lang: string | null; code: string; open: boolean }
  | { type: "mermaid"; source: string; open: boolean }
  | { type: "image"; alt: string; src: string; path: string; size: ImageSize | null };

/** A picture's file as the mod can draw it, from the destination the answer wrote; null keeps the line as written. */
export type PictureOf = (src: string) => { path: string; size: ImageSize | null } | null;

// `![words](destination "title")`: a destination in <…>, or without spaces (one level of
// parentheses), the title optional, backslash escapes in both.
const PICTURE = /!\[((?:[^\]\\\n]|\\.)*)\]\([ \t]*(<[^<>\n]*>|(?:[^\s()\\<]|\\.|\((?:[^\s()\\]|\\.)*\))+)(?:[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*\)/y;
const unescape = (s: string) => s.replace(/\\([!-/:-@[-`{-~])/g, "$1");

/**
 * The pictures of a line that holds nothing else (`agentctl show --inline` prints one a line),
 * in order, each with its words and destination; null for any other line.
 */
export function pictureLine(line: string): { alt: string; src: string }[] | null {
  const s = line.trim();
  if (!s.startsWith("![")) return null;
  const out: { alt: string; src: string }[] = [];
  let i = 0;
  while (i < s.length) {
    PICTURE.lastIndex = i;
    const m = PICTURE.exec(s);
    if (!m) return null;
    const dest = m[2]!;
    out.push({ alt: unescape(m[1]!), src: dest.startsWith("<") ? dest.slice(1, -1) : unescape(dest) });
    i = PICTURE.lastIndex;
    while (s[i] === " " || s[i] === "\t") i++;
  }
  return out;
}

const OPEN_RE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

function width(ws: string): number {
  let n = 0;
  for (const c of ws) n += c === "\t" ? 4 - (n % 4) : 1;
  return n;
}

/** Removes up to `n` columns of leading whitespace. */
function dedent(line: string, n: number): string {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n && (line[i] === " " || line[i] === "\t")) {
    col += line[i] === "\t" ? 4 - (col % 4) : 1;
    i++;
  }
  return line.slice(i);
}

function langOf(info: string): string | null {
  const w = info.trim().split(/\s+/)[0] ?? "";
  const lang = w.replace(/^\{\.?/, "").replace(/[{}].*$/, "");
  return lang ? lang : null;
}

/**
 * Splits markdown into prose and fenced blocks, in order. A fence that isn't
 * closed by the end of `text` is `open` while `streaming` (afterwards it
 * runs to the end, as in CommonMark). With `picture`, a line of nothing but
 * pictures whose files it all finds is an image block per picture; the last
 * line of a streaming answer waits (it can still grow).
 */
export function splitBlocks(text: string, streaming: boolean, picture?: PictureOf): RawBlock[] {
  const out: RawBlock[] = [];
  let md: string[] = [];
  let fence: { char: string; len: number; indent: number; lang: string | null; lines: string[] } | null = null;
  // List context: the content column of the current list item, so an indented fence inside it counts.
  let listCol = -1;

  const flushMd = () => {
    while (md.length && !md[0]!.trim()) md.shift();
    while (md.length && !md[md.length - 1]!.trim()) md.pop();
    if (md.length) out.push({ type: "markdown", text: md.join("\n") });
    md = [];
  };
  const emitFence = (open: boolean) => {
    const f = fence!;
    const code = f.lines.join("\n");
    if (f.lang?.toLowerCase() === "mermaid") out.push({ type: "mermaid", source: code, open });
    else out.push({ type: "code", lang: f.lang, code, open });
    fence = null;
  };

  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (fence) {
      const f: { char: string; len: number; indent: number } = fence;
      const close = /^([ \t]*)(`+|~+)[ \t]*$/.exec(line);
      if (close && close[2]![0] === f.char && close[2]!.length >= f.len && width(close[1]!) <= f.indent + 3) {
        emitFence(false);
        continue;
      }
      fence.lines.push(dedent(line, f.indent));
      continue;
    }
    const m = OPEN_RE.exec(line);
    if (m) {
      const indent = width(m[1]!);
      const marker = m[2]!;
      const info = m[3]!;
      const valid = !(marker[0] === "`" && info.includes("`"));
      const placed = indent <= 3 || (listCol >= 0 && indent >= listCol && indent <= listCol + 3);
      if (valid && placed) {
        flushMd();
        fence = { char: marker[0]!, len: marker.length, indent, lang: langOf(info), lines: [] };
        continue;
      }
    }
    if (picture && !(streaming && n === lines.length - 1)) {
      const indent = width(/^[ \t]*/.exec(line)![0]);
      const placed = indent <= 3 || (listCol >= 0 && indent >= listCol && indent <= listCol + 3);
      const refs = placed ? pictureLine(line) : null;
      const files = refs?.map((r) => picture(r.src));
      if (refs && files?.every(Boolean)) {
        flushMd();
        refs.forEach((r, k) => out.push({ type: "image", alt: r.alt, src: r.src, ...files[k]! }));
        continue;
      }
    }
    md.push(line);
    const li = LIST_RE.exec(line);
    if (li) listCol = width(li[1]!) + li[2]!.length + Math.max(1, width(li[3]!));
    else if (line.trim() && width(/^[ \t]*/.exec(line)![0]) === 0) listCol = -1;
  }
  if (fence) emitFence(streaming);
  flushMd();
  return out;
}
