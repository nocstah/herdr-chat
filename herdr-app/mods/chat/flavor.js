// Terminal-inspired color flavor for chat prose, markdown structure and work rows
// (no toolkit imports: tests/host/flavor.test.ts runs it directly in Node).
//
// Adopts Antigravity CLI's Glamour/terminal color hierarchy onto the active Herdr
// theme's ANSI palette so headings, inline code, lists, blockquotes, GitHub callouts,
// tables, horizontal rules, thinking blocks and tool calls read with crisp color
// flavor on both dark and light themes.

/** "#rrggbb" + alpha (0..1) → "#rrggbbaa". Scales existing alpha if present. */
function withAlpha(color, a) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}/.test(color)) return color;
  const base = color.length >= 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  return color.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a * base)) * 255).toString(16).padStart(2, "0");
}

/** True when a "#rrggbb" background is dark (luminance < 128). Defaults to true. */
export function isDarkBg(color) {
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}/.test(color)) return true;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

/** Compact theme fingerprint so retained CodeView markdown blocks refresh on theme changes. */
export function themeSig(t) {
  if (!t) return "";
  return [t.background, t.foreground, t.accent, t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6].join("|");
}

/** Semantic chat colors derived from Herdr's active theme palette. */
export function flavorPalette(t) {
  const th = t ?? {};
  const dark = isDarkBg(th.background);
  const red = th.ansi1 ?? th.blocked ?? th.foreground;
  const green = th.ansi2 ?? th.accent ?? th.foreground;
  const yellow = th.ansi3 ?? th.working ?? th.accent ?? th.foreground;
  const blue = th.ansi4 ?? th.accent ?? th.foreground;
  const magenta = th.ansi5 ?? th.accent ?? th.foreground;
  const cyan = th.ansi6 ?? th.ansi4 ?? th.accent ?? th.foreground;
  const accent = th.accent ?? blue;

  const h1 = blue;
  const h2 = dark ? cyan : blue;
  const h3 = magenta;
  const h4 = dark ? yellow : magenta;
  const h5 = dark ? green : blue;
  const h6 = th.muted ?? th.foreground;

  const quoteBar = dark ? cyan : blue;
  const codeBase = yellow ?? cyan ?? accent;

  return {
    dark,
    heading(level) {
      if (level <= 1) return h1;
      if (level === 2) return h2;
      if (level === 3) return h3;
      if (level === 4) return h4;
      if (level === 5) return h5;
      return h6;
    },
    h1Rule: withAlpha(h1, dark ? 0.30 : 0.24),
    codeBg: withAlpha(codeBase, dark ? 0.26 : 0.14),
    quoteBar,
    quoteBg: withAlpha(quoteBar, dark ? 0.08 : 0.06),
    bullet: dark ? cyan : blue,
    bulletSub: dark ? blue : magenta,
    bulletDeep: magenta,
    ordered: blue,
    check: green,
    hr: withAlpha(blue, dark ? 0.32 : 0.25),
    tableHead: blue,
    tableHeadBg: withAlpha(blue, dark ? 0.12 : 0.09),
    tableStripe: withAlpha(th.foreground ?? "#888888", dark ? 0.03 : 0.025),
    langTag: dark ? cyan : blue,
    codeBorder: withAlpha(blue, dark ? 0.26 : 0.22),
    thinking: magenta,
    thinkingDone: withAlpha(magenta, dark ? 0.82 : 0.85),
    thinkingRail: withAlpha(magenta, dark ? 0.45 : 0.35),
    userBorder: withAlpha(accent, dark ? 0.26 : 0.22),
    branch: withAlpha(magenta, dark ? 0.88 : 0.9),
    lineRange: withAlpha(dark ? cyan : blue, 0.85),
    callout(kind) {
      switch (kind) {
        case "tip": return { color: green, bg: withAlpha(green, dark ? 0.09 : 0.07), label: "Tip", icon: "sparkles" };
        case "important": return { color: magenta, bg: withAlpha(magenta, dark ? 0.09 : 0.07), label: "Important", icon: "alert" };
        case "warning": return { color: yellow, bg: withAlpha(yellow, dark ? 0.10 : 0.08), label: "Warning", icon: "alert" };
        case "caution": return { color: red, bg: withAlpha(red, dark ? 0.10 : 0.08), label: "Caution", icon: "alert" };
        default: return { color: blue, bg: withAlpha(blue, dark ? 0.09 : 0.07), label: "Note", icon: "info" };
      }
    },
    tool(type) {
      switch (type) {
        case "bash":
        case "script": return yellow;
        case "read": return blue;
        case "edit":
        case "agent": return magenta;
        case "write": return green;
        case "search":
        case "web":
        case "wait": return dark ? cyan : blue;
        default: return blue;
      }
    },
    // Every provider's modes (the claude, codex and antigravity adapters), by what the agent may do on its own: plan
    // magenta, read only cyan (blue on light), ask first yellow, accept edits blue, auto green (Codex's Auto-review is
    // Auto with a reviewer: green too), no sandbox or approvals red. Manual and a Codex configuration of your own
    // ("custom") stay uncolored.
    mode(id) {
      switch (id) {
        case "auto":
        case "auto-review": return green;
        case "plan": return magenta;
        case "acceptEdits":
        case "accept-edits": return blue;
        case "bypassPermissions":
        case "full": return red;
        case "dontAsk":
        case "untrusted": return yellow;
        case "read-only": return dark ? cyan : blue;
        default: return null;
      }
    },
  };
}

// Inline decoration: wraps standalone single-line backtick spans in `<mark color="…">`
// so gpui-base's TextView draws inline code with a warm tinted pill instead of flat gray,
// while copying as clean plain text (`SelectionFormat::Plain`). Skips code fences,
// 4-space indented code, links/images, autolinks, and existing `<mark>` elements.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const INLINE_TOKEN_RE = /<mark\b[^>]*>[\s\S]*?<\/mark>|!?\[[^\]]*\]\([^)]*\)|<[^>\s]+>|(`+)(?!`)(.+?)(?<!`)\1(?!`)/g;

/**
 * @param {string} text markdown (after linkPaths when links are active)
 * @param {string | null | undefined} bgColor `#rrggbb` or `#rrggbbaa`
 * @returns {string}
 */
export function decorateInlineCode(text, bgColor) {
  if (!text || typeof bgColor !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(bgColor)) return text;
  let fence = null;
  return text.split("\n").map((line) => {
    const f = FENCE_RE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
      return line;
    }
    if (f) { fence = f[1]; return line; }
    if (/^( {4}|\t)/.test(line)) return line;
    if (!line.includes("`")) return line;
    return line.replace(INLINE_TOKEN_RE, (whole, ticks, body) => {
      if (!ticks || !body || !body.trim()) return whole;
      return `<mark color="${bgColor}">${whole}</mark>`;
    });
  }).join("\n");
}

// Structured markdown chunker: splits markdown blocks into typed chunks (headings,
// horizontal rules, GitHub callouts, blockquotes, GFM pipe tables, clean lists, and
// prose) so rich.js can apply Antigravity-style color flavor while preserving spacing
// and native TextView selection. Reference-style link definitions stay one chunk.
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?)|$)/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE_RE = /^ {0,3}> ?(.*)$/;
const CALLOUT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const LIST_ITEM_RE = /^( *)([-*+]|(\d{1,9})([.)]))[ \t]+(.*)$/;
const TASK_RE = /^\[([ xX])\][ \t]+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const REFDEF_RE = /^ {0,3}\[[^\]]+\]:\s/m;

/** Splits one GFM pipe table row into trimmed cells, respecting `\|` and inline backticks. */
export function parseTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "", ticks = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && s[i + 1] === "|" && ticks === 0) {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "`") {
      let run = 1;
      while (i + run < s.length && s[i + run] === "`") run++;
      if (ticks === 0) ticks = run;
      else if (ticks === run) ticks = 0;
      cur += s.slice(i, i + run);
      i += run - 1;
      continue;
    }
    if (ch === "|" && ticks === 0) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableAligns(line) {
  return parseTableRow(line).map((c) => {
    const s = c.trim();
    const l = s.startsWith(":"), r = s.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
}

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  const head = lines[i], sep = lines[i + 1];
  if (!head.includes("|") || !sep.includes("|") && !/^:?-{3,}:?$/.test(sep.trim())) return false;
  if (!TABLE_SEP_RE.test(sep)) return false;
  const hCells = parseTableRow(head);
  const sCells = parseTableRow(sep);
  return hCells.length >= 2 && hCells.length === sCells.length;
}

function parseListBlock(rawLines) {
  const items = [];
  const indentLevels = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    if (FENCE_RE.test(line)) return null;
    const m = LIST_ITEM_RE.exec(line);
    if (m) {
      const spaces = m[1].length;
      const ordered = Boolean(m[3]);
      const marker = ordered ? `${m[3]}${m[4]}` : m[2];
      let body = m[5];
      if (HEADING_RE.test(body) || QUOTE_RE.test(body)) return null;
      let checked = null;
      if (!ordered) {
        const tm = TASK_RE.exec(body);
        if (tm) { checked = tm[1].toLowerCase() === "x"; body = tm[2]; }
      }
      // Map raw indentation to nesting depth (0, 1, 2…).
      while (indentLevels.length && spaces < indentLevels[indentLevels.length - 1]) indentLevels.pop();
      if (!indentLevels.length || spaces > indentLevels[indentLevels.length - 1]) indentLevels.push(spaces);
      const depth = Math.min(3, indentLevels.length - 1);
      items.push({ depth, ordered, marker, checked, text: body });
    } else if (items.length && /^[ \t]+/.test(line)) {
      const cont = line.trim();
      if (HEADING_RE.test(cont) || QUOTE_RE.test(cont) || TABLE_SEP_RE.test(cont)) return null;
      const prev = items[items.length - 1];
      const blankBefore = i > 0 && !rawLines[i - 1].trim();
      prev.text += (blankBefore ? "\n\n" : "\n") + cont;
    } else {
      return null;
    }
  }
  return items.length ? items : null;
}

/**
 * @param {string} text
 * @returns {Array<Record<string, any>>}
 */
export function mdChunks(text) {
  if (!text || !text.trim()) return [{ kind: "prose", text: " ", heading: false }];
  if (REFDEF_RE.test(text)) return [{ kind: "prose", text, heading: false }];
  const lines = text.split("\n");
  const out = [];
  let cur = [];
  let fence = null;

  const pushProse = () => {
    while (cur.length && !cur[0].trim()) cur.shift();
    while (cur.length && !cur[cur.length - 1].trim()) cur.pop();
    if (cur.length) out.push({ kind: "prose", text: cur.join("\n"), heading: false });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      cur.push(line);
      const f = FENCE_RE.exec(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) {
      fence = f[1];
      cur.push(line);
      continue;
    }
    if (!line.trim()) {
      pushProse();
      continue;
    }
    // Heading (single line, colored by level)
    const hm = HEADING_RE.exec(line);
    if (hm) {
      pushProse();
      out.push({ kind: "heading", level: hm[1].length, text: line, heading: true });
      continue;
    }
    // Horizontal rule (only at block boundary so setext `---` under a paragraph stays prose)
    if (cur.length === 0 && HR_RE.test(line)) {
      out.push({ kind: "hr", text: line, heading: false });
      continue;
    }
    // Blockquote / GitHub alert callout
    if (cur.length === 0 && QUOTE_RE.test(line)) {
      const raw = [];
      const stripped = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        raw.push(lines[i]);
        stripped.push(QUOTE_RE.exec(lines[i])[1]);
        i++;
      }
      i--;
      const cm = CALLOUT_RE.exec(stripped[0]?.trim() ?? "");
      if (cm) {
        const bodyLines = stripped.slice(1);
        while (bodyLines.length && !bodyLines[0].trim()) bodyLines.shift();
        out.push({ kind: "callout", alert: cm[1].toLowerCase(), body: bodyLines.join("\n") || " ", text: raw.join("\n"), heading: false });
      } else {
        out.push({ kind: "blockquote", body: stripped.join("\n") || " ", text: raw.join("\n"), heading: false });
      }
      continue;
    }
    // GFM pipe table
    if (cur.length === 0 && isTableStart(lines, i)) {
      const raw = [lines[i], lines[i + 1]];
      const headers = parseTableRow(lines[i]);
      const aligns = parseTableAligns(lines[i + 1]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !HEADING_RE.test(lines[i]) && !QUOTE_RE.test(lines[i]) && !FENCE_RE.test(lines[i])) {
        raw.push(lines[i]);
        const cells = parseTableRow(lines[i]);
        while (cells.length < headers.length) cells.push("");
        rows.push(cells.slice(0, headers.length));
        i++;
      }
      i--;
      out.push({ kind: "table", headers, aligns, rows, text: raw.join("\n"), heading: false });
      continue;
    }
    // Clean list block (unordered, ordered, or task list)
    if (cur.length === 0 && LIST_ITEM_RE.test(line)) {
      const firstM = LIST_ITEM_RE.exec(line);
      const firstIndent = firstM[1].length;
      const firstOrdered = Boolean(firstM[3]);
      const switchesListKind = (candidate) => {
        const lm = LIST_ITEM_RE.exec(candidate);
        return Boolean(lm && lm[1].length <= firstIndent && Boolean(lm[3]) !== firstOrdered);
      };
      const raw = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) {
          // Keep a blank line only if the next non-blank line continues the same list.
          let k = j + 1;
          while (k < lines.length && !lines[k].trim()) k++;
          if (k < lines.length && !switchesListKind(lines[k]) && (LIST_ITEM_RE.test(lines[k]) || /^[ \t]+/.test(lines[k]))) {
            raw.push(l);
            j++;
            continue;
          }
          break;
        }
        if (!switchesListKind(l) && (LIST_ITEM_RE.test(l) || /^[ \t]+/.test(l))) {
          raw.push(l);
          j++;
        } else {
          break;
        }
      }
      const items = parseListBlock(raw);
      i = j - 1;
      if (items) out.push({ kind: "list", items, text: raw.join("\n"), heading: false });
      else out.push({ kind: "prose", text: raw.join("\n"), heading: false });
      continue;
    }
    cur.push(line);
  }
  pushProse();
  return out.length ? out : [{ kind: "prose", text: " ", heading: false }];
}

const TOOL_VERB_RE = /^(\$|REPL|Read|Edit|Write|Grep|Find|List|Fetch|Search|Agent|Task|Question|Message|Schedule|Workflow|Run|Bash|Waiting)(\s+[\s\S]*|\s*)$/;

const VERB_KIND = {
  $: "bash",
  Bash: "bash",
  Run: "bash",
  REPL: "script",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Grep: "search",
  Find: "search",
  List: "search",
  Search: "search",
  Fetch: "web",
  Agent: "agent",
  Task: "agent",
  Waiting: "wait",
};

/** Strips leading `#` markers (and optional closing `#` markers) from an ATX heading line. */
export function stripHeading(line) {
  return String(line ?? "").replace(/^ {0,3}#{1,6}(?:\s+|$)/, "").replace(/[ \t]+#+[ \t]*$/, "").trim();
}

const INLINE_SPAN_RE = /(`+)(?!`)(.+?)(?<!`)\1(?!`)|\[((?:[^[\]`]|`[^`]*`)+)\]\(([^)\s]+)\)|\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__|(?<!\*)\*(?=\S)([^*]+?)(?<=\S)\*(?!\*)|~~(?=\S)(.+?)(?<=\S)~~/g;

/**
 * Parses a single-line markdown snippet (heading or table header) into flat inline runs
 * so GPUI native divs can paint it with a real foreground color (working around gpui-shell's
 * TextView resetting text color to theme.foreground) while keeping inline code pills, bold,
 * italic, strikethrough and clickable links intact.
 * @param {string} text
 * @param {{ bold?: boolean, italic?: boolean, strike?: boolean, url?: string }} [style]
 * @returns {Array<{ text: string, code?: boolean, bold?: boolean, italic?: boolean, strike?: boolean, url?: string }>}
 */
export function parseInlineSpans(text, style = {}) {
  const src = String(text ?? "");
  if (!src) return [];
  const out = [];
  const push = (run) => {
    if (!run.text) return;
    out.push(run);
  };
  let last = 0;
  const re = new RegExp(INLINE_SPAN_RE.source, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) push({ ...style, text: src.slice(last, m.index) });
    if (m[1]) {
      let body = m[2];
      if (m[1].length > 1 && body.startsWith(" ") && body.endsWith(" ") && body.trim()) body = body.slice(1, -1);
      push({ ...style, text: body, code: true });
    } else if (m[3] != null && m[4] != null) {
      out.push(...parseInlineSpans(m[3], { ...style, url: m[4] }));
    } else if (m[5] != null || m[6] != null) {
      out.push(...parseInlineSpans(m[5] ?? m[6], { ...style, bold: true }));
    } else if (m[7] != null) {
      out.push(...parseInlineSpans(m[7], { ...style, italic: true }));
    } else if (m[8] != null) {
      out.push(...parseInlineSpans(m[8], { ...style, strike: true }));
    }
    last = re.lastIndex;
  }
  if (last < src.length) push({ ...style, text: src.slice(last) });
  return out.length ? out : [{ ...style, text: src }];
}

/** Splits a tool's title into a colored leading verb and the rest, or null if none matches. */
export function splitToolVerb(title) {
  if (!title) return null;
  const m = TOOL_VERB_RE.exec(title);
  if (!m) return null;
  return { verb: m[1], rest: m[2].trimStart() };
}

/**
 * A tool row's colored verb, the rest of its title, and the kind its color comes from (`flavorPalette(t).tool(kind)`),
 * or null for a title without one. Code Mode's REPL row is titled with its script's description ("Run the tests",
 * "Read the config"), not a tool's verb: "REPL" goes before it, in the script color. A Poll's "Waiting" ("Waiting for
 * #12 Run the tests") is a wait's color, not a generic tool's.
 * @param {string | null | undefined} title
 * @param {{ type?: string } | null | undefined} [d] the tool's detail (inferred from verb when omitted)
 * @returns {{ verb: string, rest: string, kind: string } | null}
 */
export function toolVerb(title, d) {
  if (d?.type === "script") return { verb: "REPL", rest: title && title.trim() !== "REPL" ? title.trim() : "", kind: "script" };
  const sp = splitToolVerb(title);
  if (!sp) return null;
  return { ...sp, kind: sp.verb === "Waiting" ? "wait" : d?.type ?? VERB_KIND[sp.verb] ?? "generic" };
}

// A picture left in prose (inside a sentence, or one whose file the host didn't find: protocol
// v3.11) as a link with its words: the markdown view draws no pictures and would drop it whole.
// Code spans keep what they show.
export function picturesAsLinks(text) {
  if (!text.includes("![")) return text;
  return text.split(/(`+[^`\n]*`+)/).map((part, i) => (i % 2 ? part
    : part.replace(/!\[((?:[^\]\\\n]|\\.)*)\]\(/g, (_m, alt) => `[${alt || "picture"}](`))).join("");
}
