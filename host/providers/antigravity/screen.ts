// Antigravity CLI's TUI screen reader for the terminal view (terminal.ts):
// - status bar: execution mode (`default`, `accept-edits`, `auto`, `plan`),
//   model display name and effort level;
// - idle prompt detection (`agyAtPrompt`): for returning to the chat view once
//   an interactive TUI overlay (/resume, /config, /permissions, /model…) closes;
// - blocking dialogs (`readAgyPrompt`): workspace trust confirmation, numbered
//   tool/edit/create permission prompts, and `ask_question` prompts.

export type AgyMode = "default" | "accept-edits" | "auto" | "plan";

export type AgyStatusBar = {
  mode: AgyMode;
  modelName: string | null;
  effort: string | null;
};

export type AgyRow = {
  n: number | null;
  label: string;
  description?: string;
  /** Shortcut key if shown in parentheses or numbered row (e.g. "1", "2"). */
  key?: string;
  selected: boolean;
  checked?: boolean;
  input?: boolean;
  stop: number;
};

export type AgyPrompt =
  | { kind: "permission"; title: string; body: string; rows: AgyRow[]; stops: AgyRow[] }
  | { kind: "question"; progress: string | null; question: string; rows: AgyRow[]; other: AgyRow | null; submit: AgyRow | null; multi: boolean; stops: AgyRow[] }
  | { kind: "confirm"; title: string; body: string; rows: AgyRow[]; stops: AgyRow[] };

export type AgyPermissionDetail = {
  /** Shell command extracted from a command permission prompt, or null for non-command approvals. */
  command: string | null;
  /** Human explanation ("Reason: …"), cleanly separated from the command. */
  reason: string | null;
  /** Original body text (fallback for non-command prompts such as diffs or trust dialogs). */
  body: string;
};

export type AgyQuotaWarning = {
  id: string;
  title: string;
  message: string;
  errorId: string | null;
};

const SOLID_RE = /^\s*─{8,}\s*$/;
const COMPOSER_RE = /^>\s*(?:$|Auto mode:|Plan mode:|Accept-edits mode:|Type a message|Ask anything|[^\d])/i;
const STATUS_LEFT_RE = /^(?:\?\s+for shortcuts|esc to cancel|Press up to edit queued messages)\b/i;
const STATUS_RIGHT_RE = /^(?:(auto|plan|accept-edits)\s*·\s*)?(.+?)(?:\s*·\s*(low|medium|high|xhigh|max))?$/i;

// Overlays opened by slash commands (/model, /effort, /config, /permissions, /resume, /help…).
const OVERLAY_HINT_RE = /(?:Keyboard:.*\besc\b|enter\s+Select\s+esc\b|\besc\s+Go\s+Back\b|\besc\s+to\s+(?:go\s+back|close)\b)/i;

// Dialog footers when `agy` is blocked waiting for a confirmation or answer.
const DIALOG_FOOTER_RE = /(?:↑\/↓\s*Navigate\s*·\s*enter\s*Confirm|enter\s*(?:to\s*)?(?:confirm|select|submit)|esc\s*(?:to\s*)?(?:cancel|deny|reject|skip)|tab\s*(?:to\s*)?(?:add\s*(?:notes|feedback|instructions)|reject)|space\s*(?:to\s*)?toggle|press\s+1|f\s+to\s+view\s+full\s+diff)/i;
const NUMBERED_ROW_RE = /^(\s*)([>›❯▸]\s*)?(\d+)\.\s+(.*)$/;
const PLAIN_CURSOR_RE = /^(\s*)([>›❯▸])\s+(.+)$/;
const BOX_RE = /^\[([ ✔✓xX])\]\s+(.*)$/;
const SUBMIT_RE = /^\s*([>›❯▸]\s*)?Submit\s*$/i;
const OTHER_RE = /^(?:Other(?:\b|\s*\(|:|$)|Type (?:your answer|something)|Write-in(?:\b|\.{3}|…))/i;
const QUESTION_HEADER_RE = /^(?:Question\s+\d+\/\d+.*|.*(?:\?|:))$/i;

const blank = (l: string) => !l.trim();
const indent = (l: string) => /^\s*/.exec(l)![0].length;

function screenLines(screen: string): string[] {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && blank(lines.at(-1)!)) lines.pop();
  return lines;
}

/** Split `"Option A   Description text"` on two or more spaces. */
function columns(text: string): { label: string; description?: string } {
  const m = /^(.+?)\s{2,}(\S.*)$/.exec(text);
  return m ? { label: m[1]!.trim(), description: m[2]!.trim() } : { label: text.trim() };
}

/**
 * Parse Antigravity CLI's bottom status line, e.g.:
 *   `? for shortcuts                                 auto · Gemini 4 Neon · xhigh`
 *   `esc to cancel                                   accept-edits · Gemini 4 Neon · high`
 *   `? for shortcuts                                        Gemini 4 Neon · xhigh`
 */
export function readAgyStatusBar(screen: string): AgyStatusBar | null {
  const lines = screenLines(screen);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
    const raw = lines[i]!;
    if (SOLID_RE.test(raw) || OVERLAY_HINT_RE.test(raw)) continue;
    // Right segment sits after 2+ spaces (or is the whole trimmed line when left side is empty).
    const parts = raw.trim().split(/\s{2,}/);
    const right = parts.at(-1)?.trim() ?? "";
    if (!right || !right.includes("·") && !STATUS_LEFT_RE.test(parts[0] ?? "")) continue;
    // Ignore status lines where the right part is clearly a hint rather than a model/mode line.
    if (STATUS_LEFT_RE.test(right) || /Navigate|Confirm|shortcuts/i.test(right)) continue;
    const m = STATUS_RIGHT_RE.exec(right);
    if (!m) continue;
    const mode = (m[1]?.toLowerCase() ?? "default") as AgyMode;
    const modelName = m[2]?.trim() || null;
    const effort = m[3]?.toLowerCase() ?? null;
    if (!modelName) continue;
    return { mode, modelName, effort };
  }
  return null;
}

/** Strip a trailing status bar line (if present) so dialog scanning looks at the dialog itself. */
function stripStatusBar(lines: string[]): string[] {
  if (!lines.length) return lines;
  const last = lines.at(-1)!;
  if (readAgyStatusBar(last)) return lines.slice(0, -1);
  return lines;
}

/** Parse numbered dialog rows (1..N in order), returning them and their start/end line indices. */
function parseNumberedDialog(lines: string[]): { rows: AgyRow[]; first: number; last: number; footer: number } | null {
  // Scan from bottom up for either a dialog footer or the last numbered row.
  let footer = lines.length;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (DIALOG_FOOTER_RE.test(lines[i]!)) {
      footer = i;
      break;
    }
  }
  let end = -1;
  for (let i = footer - 1; i >= Math.max(0, footer - 50); i--) {
    if (NUMBERED_ROW_RE.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  // Walk upwards from row N to row 1, checking strictly sequential numbering.
  const at: number[] = [];
  let want = Number(NUMBERED_ROW_RE.exec(lines[end]!)![3]);
  if (want < 2) return null;
  for (let i = end; i >= Math.max(0, end - 60) && want >= 1; i--) {
    const m = NUMBERED_ROW_RE.exec(lines[i]!);
    if (!m) continue;
    if (Number(m[3]) !== want) return null;
    at.unshift(i);
    want--;
  }
  if (want !== 0) return null;

  // Require either a cursor marker (`>` / `›` / `❯`) on one of the rows OR a recognized dialog footer
  // so an ordinary numbered markdown list in assistant output is never mistaken for a prompt.
  const hasCursor = at.some((idx) => Boolean(NUMBERED_ROW_RE.exec(lines[idx]!)![2]));
  if (!hasCursor && footer === lines.length) return null;

  const rows: AgyRow[] = [];
  for (let k = 0; k < at.length; k++) {
    const i = at[k]!;
    const m = NUMBERED_ROW_RE.exec(lines[i]!)!;
    const col = m[1]!.length + (m[2]?.length ?? 0) + m[3]!.length + 2;
    let text = m[4]!.trim();
    const notes: string[] = [];
    const next = at[k + 1] ?? footer;
    let submit: AgyRow | null = null;
    for (let j = i + 1; j < next; j++) {
      const l = lines[j]!;
      if (SUBMIT_RE.test(l)) {
        submit = { n: null, label: "Submit", selected: Boolean(SUBMIT_RE.exec(l)![1]), stop: 0 };
        break;
      }
      if (blank(l) || SOLID_RE.test(l) || DIALOG_FOOTER_RE.test(l)) break;
      if (indent(l) < col - 2) break;
      notes.push(l.trim());
    }
    const box = BOX_RE.exec(text);
    const checked = box ? box[1] !== " " : undefined;
    if (box) text = box[2]!.trim();
    else text = text.replace(/^✓\s+/, "").trim();
    const split = columns(text);
    const desc = [split.description, ...notes].filter(Boolean).join(" ");
    rows.push({
      n: Number(m[3]),
      label: split.label,
      ...(desc ? { description: desc } : {}),
      key: m[3]!,
      selected: Boolean(m[2]),
      ...(checked !== undefined ? { checked } : {}),
      stop: rows.length,
    });
    if (submit) rows.push({ ...submit, stop: rows.length });
  }
  return { rows, first: at[0]!, last: end, footer };
}

/** Parse an unnumbered cursor confirm dialog (e.g. Workspace trust: `> Yes, I trust this folder` / `  No, exit`). */
function parseConfirmDialog(lines: string[]): AgyPrompt | null {
  let footer = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    if (DIALOG_FOOTER_RE.test(lines[i]!)) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return null;

  // Find the contiguous block of choice rows right above the footer, one of which has a cursor `>`.
  let cur = -1;
  for (let i = footer - 1; i >= Math.max(0, footer - 15); i--) {
    if (PLAIN_CURSOR_RE.test(lines[i]!)) {
      cur = i;
      break;
    }
  }
  if (cur < 0) return null;
  const curMatch = PLAIN_CURSOR_RE.exec(lines[cur]!)!;
  const textCol = curMatch[1]!.length + 2; // column where the option text starts after `> `

  // Collect options around `cur` at matching text indent (no blank/rule boundaries).
  let first = cur;
  while (first > 0) {
    const prev = lines[first - 1]!;
    if (blank(prev) || SOLID_RE.test(prev)) break;
    if (PLAIN_CURSOR_RE.test(prev) || (indent(prev) === textCol && prev.trim().length <= 80 && !/[?:]$/.test(prev.trim()))) first--;
    else break;
  }
  let last = cur;
  while (last + 1 < footer) {
    const next = lines[last + 1]!;
    if (blank(next) || SOLID_RE.test(next)) break;
    if (PLAIN_CURSOR_RE.test(next) || (indent(next) === textCol && next.trim().length <= 80)) last++;
    else break;
  }

  const rows: AgyRow[] = [];
  for (let i = first; i <= last; i++) {
    const l = lines[i]!;
    const m = PLAIN_CURSOR_RE.exec(l);
    rows.push({ n: null, label: (m ? m[3]! : l).trim(), selected: Boolean(m), stop: rows.length });
  }
  if (rows.length < 2) return null;

  // Gather title & body lines above `first` back to top or horizontal rule.
  let top = first - 1;
  while (top >= 0 && !SOLID_RE.test(lines[top]!)) top--;
  const above = lines.slice(top + 1, first).map((l) => l.trim()).filter(Boolean);
  const qIdx = above.findIndex((l) => /\?$/.test(l));
  const title = qIdx >= 0 ? above[qIdx]! : above[0] ?? "Antigravity needs confirmation";
  const body = above.filter((_, idx) => idx !== (qIdx >= 0 ? qIdx : 0)).join("\n");
  return { kind: "confirm", title, body, rows, stops: rows };
}

/**
 * The interactive blocking dialog currently shown on Antigravity's screen,
 * or null when none is shown (or the screen shows an unrecognized overlay).
 */
export function readAgyPrompt(screen: string): AgyPrompt | null {
  const lines = stripStatusBar(screenLines(screen));
  if (!lines.length) return null;
  // Don't treat the slash-command pickers (/model, /effort, /config) as blocking asks.
  if (lines.slice(-6).some((l) => OVERLAY_HINT_RE.test(l))) return null;

  const num = parseNumberedDialog(lines);
  if (num) {
    // Gather lines above row 1 up to a horizontal rule (or at most 40 lines).
    let top = num.first - 1;
    const minTop = Math.max(-1, num.first - 40);
    while (top > minTop && !SOLID_RE.test(lines[top]!)) top--;
    const above = lines.slice(top + 1, num.first);
    while (above.length && blank(above[0]!)) above.shift();
    while (above.length && blank(above.at(-1)!)) above.pop();

    const submit = num.rows.find((r) => r.n === null && r.label === "Submit") ?? null;
    const optRows = num.rows.filter((r) => r !== submit);
    const multi = optRows.some((r) => r.checked !== undefined);
    const other = optRows.find((r) => OTHER_RE.test(r.label)) ?? null;
    if (other) other.input = true;

    const looksApproval = optRows.some((r) => /^(?:Yes|Allow|Approve|Run|Accept)\b/i.test(r.label))
      && optRows.some((r) => /^(?:No|Deny|Reject|Cancel)\b/i.test(r.label));

    if (!looksApproval && (multi || other || above.some((l) => /^Question\s+\d+\/\d+/i.test(l.trim())))) {
      const progressIdx = above.findIndex((l) => /^Question\s+\d+\/\d+/i.test(l.trim()));
      let progress: string | null = null;
      let question: string;
      if (progressIdx >= 0) {
        const m = /^(Question\s+\d+\/\d+)(?:\s*:\s*(.*))?$/i.exec(above[progressIdx]!.trim())!;
        progress = m[1]!;
        const inlineText = m[2]?.trim() ?? "";
        const after = above.slice(progressIdx + 1).map((l) => l.trim()).filter(Boolean);
        if (inlineText) {
          question = [inlineText, ...after].join(" ");
        } else {
          const before = above.slice(0, progressIdx).map((l) => l.trim()).filter((l) => l && !/^Question$/i.test(l));
          question = after.join(" ") || before.at(-1) || "Antigravity has a question";
        }
      } else {
        const qLines = above.map((l) => l.trim()).filter((l) => l && !/^Question$/i.test(l));
        question = qLines.at(-1) ?? "Antigravity has a question";
      }
      return {
        kind: "question",
        progress,
        question,
        rows: optRows.filter((r) => r !== other),
        other,
        submit,
        multi,
        stops: num.rows,
      };
    }

    // Permission / approval dialog: last question line above rows is the title; everything before it is the body.
    let qIdx = -1;
    for (let i = above.length - 1; i >= 0; i--) {
      if (QUESTION_HEADER_RE.test(above[i]!.trim())) {
        qIdx = i;
        break;
      }
    }
    const title = qIdx >= 0 ? above[qIdx]!.trim() : above.at(-1)?.trim() || "Antigravity needs approval";
    const bodyLines = qIdx >= 0 ? above.slice(0, qIdx) : above.slice(0, -1);
    const body = bodyLines.join("\n").trim();
    return { kind: "permission", title, body, rows: optRows, stops: num.rows };
  }

  return parseConfirmDialog(lines);
}

/** Stable identity of a dialog: stays the same as the cursor moves between choices. */
export function agyPromptKey(p: AgyPrompt): string {
  const head = p.kind === "question" ? `${p.progress ?? ""}\n${p.question}` : `${p.title}\n${p.body}`;
  return `${p.kind}\n${head}\n${p.stops.map((r) => r.label).join("\n")}`;
}

/** Join terminal-wrapped prose paragraphs cleanly while keeping paragraph breaks. */
function unwrapProse(text: string): string {
  return text
    .trim()
    .split(/\n\s*\n/)
    .map((para) => {
      let out = "";
      for (const raw of para.split("\n")) {
        const part = raw.trim();
        if (!part) continue;
        if (!out) out = part;
        else if (/[A-Za-z0-9]-$/.test(out) && /^[A-Za-z0-9]/.test(part)) out += part;
        else out += ` ${part}`;
      }
      return out;
    })
    .filter(Boolean)
    .join("\n\n");
}

/** Join terminal-wrapped single-command text without corrupting mid-path wraps like `/omarelay\n/scripts`. */
function unwrapCommand(text: string): string {
  const rawLines = text.replace(/\r/g, "").split("\n");
  while (rawLines.length && blank(rawLines[0]!)) rawLines.shift();
  while (rawLines.length && blank(rawLines.at(-1)!)) rawLines.pop();
  if (rawLines.length <= 1) return (rawLines[0] ?? "").trim();
  // Preserve intentional multi-line scripts (blank lines inside, or varying inner indentation).
  const firstIndent = indent(rawLines[0]!);
  const hasStructure = rawLines.some((l, i) => blank(l) || (i > 0 && indent(l) > firstIndent + 1));
  if (hasStructure) {
    const minIndent = Math.min(...rawLines.filter((l) => !blank(l)).map(indent));
    return rawLines.map((l) => (blank(l) ? "" : l.slice(minIndent))).join("\n").trim();
  }
  let out = "";
  for (const raw of rawLines) {
    const part = raw.trim();
    if (!part) continue;
    if (!out) {
      out = part;
    } else if (out.endsWith("\\")) {
      out += `\n${part}`;
    } else if (
      (part.startsWith("/") && /[A-Za-z0-9._~-]$/.test(out))
      || (out.endsWith("/") && /^[A-Za-z0-9._~-]/.test(part))
      || (/[A-Za-z0-9._]-$/.test(out) && /^[A-Za-z0-9]/.test(part))
    ) {
      out += part;
    } else {
      out += ` ${part}`;
    }
  }
  return out;
}

const REQ_PERM_RE = /(?:^|\s)Requesting permission for:\s*/i;
const REASON_PREFIX_RE = /^Reason:\s*/i;
const CMD_LINE_RE = /(?:^|\n)\s*(?:Command:\s*|\$\s+)/i;

/**
 * Split an Antigravity permission prompt body into its structured `command` and
 * `reason` when asking to run a command (e.g. `Reason: … Requesting permission
 * for: <cmd>`), so the chat card can show the command in a dedicated monospace
 * block separate from the explanation.
 */
export function parseAgyPermissionBody(title: string, body: string): AgyPermissionDetail {
  const trimmed = body.trim();
  if (!trimmed) return { command: null, reason: null, body: "" };

  const req = REQ_PERM_RE.exec(trimmed);
  if (req) {
    const before = trimmed.slice(0, req.index).trim();
    const after = trimmed.slice(req.index + req[0].length).trim();
    if (after) {
      const reason = before ? unwrapProse(before.replace(REASON_PREFIX_RE, "")) || null : null;
      return { command: unwrapCommand(after), reason, body: trimmed };
    }
  }

  if (/\bcommand\b/i.test(title) && !/^\s*[+-]\s/m.test(trimmed)) {
    if (REASON_PREFIX_RE.test(trimmed)) {
      const cmdMatch = CMD_LINE_RE.exec(trimmed);
      if (cmdMatch && cmdMatch.index > 0) {
        const reason = unwrapProse(trimmed.slice(0, cmdMatch.index).replace(REASON_PREFIX_RE, "")) || null;
        const cmd = unwrapCommand(trimmed.slice(cmdMatch.index + cmdMatch[0].length));
        if (cmd) return { command: cmd, reason, body: trimmed };
      }
      const paras = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      if (paras.length >= 2) {
        const reason = unwrapProse(paras.slice(0, -1).join("\n\n").replace(REASON_PREFIX_RE, "")) || null;
        const cmd = unwrapCommand(paras.at(-1)!.replace(/^(?:Command:\s*|\$\s+)/i, ""));
        if (cmd) return { command: cmd, reason, body: trimmed };
      }
    } else {
      const cmd = unwrapCommand(trimmed.replace(/^(?:Command:\s*|\$\s+)/i, ""));
      if (cmd) return { command: cmd, reason: null, body: trimmed };
    }
  }

  return { command: null, reason: null, body: trimmed };
}

/** ↑/↓ arrow key presses from the currently selected row to `to`. */
export function agyMovesTo(p: AgyPrompt, to: AgyRow): string[] {
  const at = p.stops.find((r) => r.selected)?.stop ?? 0;
  const n = to.stop - at;
  return Array.from({ length: Math.abs(n) }, () => (n > 0 ? "down" : "up"));
}

/**
 * Whether `agy` is at its main prompt with no overlay/picker/dialog open over it.
 * In `agy`, the composer sits between two `────` rules right above the single
 * bottom status line; when an overlay (/model, /effort, /config, /permissions,
 * /resume…) is open, the overlay's rows and `Keyboard: … esc Go Back` appear
 * BELOW the bottom rule.
 */
export function agyAtPrompt(screen: string): boolean {
  if (readAgyPrompt(screen)) return false;
  const lines = screenLines(screen);
  if (lines.length < 3) return false;
  const tail = lines.slice(-12);
  // Find the last horizontal rule near the bottom.
  let bottomRule = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (SOLID_RE.test(tail[i]!)) {
      bottomRule = i;
      break;
    }
  }
  if (bottomRule < 1) return false;
  const below = tail.slice(bottomRule + 1).filter((l) => !blank(l));
  // At prompt: at most 1 status-bar line below the bottom rule, and no overlay hints.
  if (below.length > 1) return false;
  if (below.some((l) => OVERLAY_HINT_RE.test(l))) return false;
  // Find the top rule of the prompt box and verify the `>` prompt line lies between them.
  let topRule = -1;
  for (let i = bottomRule - 1; i >= 0; i--) {
    if (SOLID_RE.test(tail[i]!)) {
      topRule = i;
      break;
    }
  }
  const box = tail.slice(topRule >= 0 ? topRule + 1 : Math.max(0, bottomRule - 4), bottomRule);
  return box.some((l) => COMPOSER_RE.test(l));
}

/**
 * Whether `agy` is currently in `!` bash/shell mode: its composer chevron switched
 * from `>` to `!` between the horizontal rules and/or the status line below the
 * composer shows `activated bash mode`.
 */
export function agyInShellMode(screen: string): boolean {
  if (readAgyPrompt(screen)) return false;
  const lines = screenLines(screen);
  if (lines.length < 3) return false;
  const tail = lines.slice(-12);
  let bottomRule = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (SOLID_RE.test(tail[i]!)) {
      bottomRule = i;
      break;
    }
  }
  if (bottomRule < 1) return false;
  const below = tail.slice(bottomRule + 1).filter((l) => !blank(l));
  if (below.some((l) => OVERLAY_HINT_RE.test(l))) return false;
  let topRule = -1;
  for (let i = bottomRule - 1; i >= 0; i--) {
    if (SOLID_RE.test(tail[i]!)) {
      topRule = i;
      break;
    }
  }
  const box = tail.slice(topRule >= 0 ? topRule + 1 : Math.max(0, bottomRule - 4), bottomRule);
  const first = box.find((l) => !blank(l));
  if (first && /^!(?:\s|$)/.test(first)) return true;
  if (first && /^>/.test(first)) return false;
  return below.some((l) => /\bactivated\s+bash\s+mode\b/i.test(l));
}

const QUOTA_SIGNAL_RE = /\b(?:individual\s+quota|quota\s+(?:reached|exceeded|exhausted|limit)|out\s+of\s+(?:quota|credits)|insufficient\s+(?:quota|credits)|credits?\s+(?:exhausted|depleted|reached)|usage\s+limit(?:\s+(?:reached|exceeded))?|hit\s+your\s+(?:limit|quota|usage\s+limit)|reached\s+(?:your|the)\s+(?:daily|weekly|hourly|monthly|plan|usage|rate|message|request)?\s*(?:quota|limit)|rate\s+limit(?:\s+(?:reached|exceeded))?|too\s+many\s+requests|upgrade\s+your\s+(?:subscription|plan)\s+to\s+increase\s+your\s+limits?)\b/i;
const QUOTA_EXCLUDE_RE = /\b(?:context\s+(?:window|length)\s+(?:limit|reached|exceeded)|token\s+limit\s+(?:reached|exceeded)|max(?:imum)?\s+(?:output\s+)?tokens?\s+(?:limit|reached|exceeded)|rate[- ]limit\s+retry|retrying\s+in)\b/i;
const QUOTA_TITLE_RE = /\b(?:rate\s+limit|too\s+many\s+requests)\b/i;
const ERROR_ID_RE = /^Error\s+ID:\s*(\S*)\s*$/i;
const ERROR_ID_CONT_RE = /^[A-Za-z0-9._:-]+$/;
const NEWER_TURN_RE = /^(?:[>›❯]\s+\S|[●•✦◆]\s+\S)/;

function stableId(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function joinWrapped(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const part = raw.trim();
    if (!part) continue;
    if (!out) out = part;
    else if (out.endsWith("-") && /^[A-Za-z0-9]/.test(part)) out += part;
    else out += ` ${part}`;
  }
  return out;
}

/**
 * Reads an active quota/usage-limit warning printed directly above Antigravity's idle composer
 * (e.g. `⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h50m10s.`
 * followed by `Error ID: …`). Antigravity prints this on the terminal screen without writing an
 * error step to `transcript.jsonl`, so the terminal view surfaces it from the screen instead.
 */
export function readAgyQuotaWarning(screen: string): AgyQuotaWarning | null {
  if (readAgyPrompt(screen)) return null;
  const lines = screenLines(screen);
  if (lines.length < 4) return null;

  // Locate Antigravity's idle composer (`────` / `> ...` / `────` / status line(s) without `esc to cancel`).
  let bottomRule = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    if (SOLID_RE.test(lines[i]!)) {
      bottomRule = i;
      break;
    }
  }
  if (bottomRule < 2) return null;
  const below = lines.slice(bottomRule + 1).filter((l) => !blank(l));
  // Allow up to 2 wrapped status rows below the bottom rule on narrow panes; reject overlays and active turns.
  if (below.length === 0 || below.length > 2) return null;
  if (below.some((l) => OVERLAY_HINT_RE.test(l) || /^esc to cancel\b/i.test(l.trim()))) return null;
  if (!below.some((l) => STATUS_LEFT_RE.test(l.trim()) || Boolean(readAgyStatusBar(l)))) return null;

  let topRule = -1;
  for (let i = bottomRule - 1; i >= Math.max(0, bottomRule - 8); i--) {
    if (SOLID_RE.test(lines[i]!)) {
      topRule = i;
      break;
    }
  }
  if (topRule < 1) return null;
  const box = lines.slice(topRule + 1, bottomRule);
  if (!box.some((l) => COMPOSER_RE.test(l))) return null;

  // Scan up to 16 lines above the composer's top rule for an unindented column-0 `⚠ ` warning.
  let end = topRule - 1;
  while (end >= 0 && blank(lines[end]!)) end--;
  if (end < 0) return null;

  let start = -1;
  const minLine = Math.max(0, end - 16);
  for (let i = end; i >= minLine; i--) {
    const raw = lines[i]!;
    if (SOLID_RE.test(raw)) break;
    if (/^⚠\s+\S/.test(raw)) {
      start = i;
      break;
    }
    if (NEWER_TURN_RE.test(raw)) return null;
  }
  if (start < 0) return null;

  const block = lines.slice(start, end + 1);
  let errorId: string | null = null;
  const bodyLines: string[] = [];
  for (let i = 0; i < block.length; i++) {
    const raw = block[i]!;
    const trimmed = raw.trim();
    if (!trimmed) {
      if (errorId !== null) break;
      continue;
    }
    const errMatch = ERROR_ID_RE.exec(trimmed);
    if (errMatch) {
      let idVal = errMatch[1] ?? "";
      while (i + 1 < block.length) {
        const cont = block[i + 1]!.trim();
        if (!cont || !ERROR_ID_CONT_RE.test(cont) || /^Error$/i.test(cont)) break;
        idVal += cont;
        i++;
      }
      errorId = idVal.trim() || null;
      continue;
    }
    if (errorId !== null) return null; // newer output below Error ID -> warning is stale
    bodyLines.push(i === 0 ? trimmed.replace(/^⚠\s+/, "") : trimmed);
  }

  const message = joinWrapped(bodyLines);
  if (!message || QUOTA_EXCLUDE_RE.test(message) || !QUOTA_SIGNAL_RE.test(message)) return null;
  const title = QUOTA_TITLE_RE.test(message) && !/\bquota\b/i.test(message) ? "Usage limit reached" : "Quota reached";
  const key = errorId ? `agy:err:${errorId}` : `agy:msg:${message.toLowerCase().replace(/\s+/g, " ")}`;
  return { id: `agy-quota-${stableId(key)}`, title, message, errorId };
}

const SPINNER_LINE_RE = /^\s{0,2}[\u2801-\u28FF]{1,2}\s+(\S.*)$/u;
const IDLE_STATUS_RE = /^\s*\?\s+for shortcuts\b/i;
const TIP_START_RE = /^\s*(?:[│┃]\s*)?Tip:\s/i;
const CALLOUT_LINE_RE = /^\s*(?:[│┃](?:\s|$)|esc to dismiss\s*$)/i;
const WORK_BLOCK_START_RE = /^\s*(?:[●•✦◆▸▾▶▼⚠✓✗✕?]|>\s|[›❯]\s)/;

/**
 * Reads Antigravity CLI's live updating working/thinking status line (prefixed by
 * a braille spinner, e.g. `⣿ The \`usage.test.ts\` file seems crucial…` or
 * `⠋ Thinking…`) sitting directly above the optional `│ Tip:` line and composer.
 * Returns null when idle, blocked on a dialog, in a slash overlay, or when no
 * active spinner sits at the bottom of the transcript area.
 */
export function readAgyWorkingStatus(screen: string): string | null {
  if (readAgyPrompt(screen)) return null;
  const lines = screenLines(screen);
  if (!lines.length) return null;
  if (lines.slice(-6).some((l) => OVERLAY_HINT_RE.test(l))) return null;
  if (lines.slice(-3).some((l) => IDLE_STATUS_RE.test(l))) return null;

  // Locate the bottom of the live transcript area (above the composer box if drawn, else above the status bar).
  let scanEnd = lines.length - 1;
  let bottomRule = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    if (SOLID_RE.test(lines[i]!)) {
      bottomRule = i;
      break;
    }
  }
  if (bottomRule >= 1) {
    const below = lines.slice(bottomRule + 1).filter((l) => !blank(l));
    if (below.some((l) => OVERLAY_HINT_RE.test(l) || IDLE_STATUS_RE.test(l))) return null;
    const isComposerFooter = below.length <= 2
      && !below.some((l) => SPINNER_LINE_RE.test(l))
      && (below.length === 0 || below.some((l) => STATUS_LEFT_RE.test(l.trim()) || Boolean(readAgyStatusBar(l))));
    if (isComposerFooter) {
      let topRule = -1;
      for (let i = bottomRule - 1; i >= Math.max(0, bottomRule - 14); i--) {
        if (SOLID_RE.test(lines[i]!)) {
          topRule = i;
          break;
        }
      }
      if (topRule >= 0) {
        const box = lines.slice(topRule + 1, bottomRule);
        if (!box.some((l) => SPINNER_LINE_RE.test(l))) scanEnd = topRule - 1;
      }
    }
  }
  if (scanEnd === lines.length - 1) {
    while (scanEnd >= 0) {
      const raw = lines[scanEnd]!;
      const trimmed = raw.trim();
      if (blank(raw) || STATUS_LEFT_RE.test(trimmed) || Boolean(readAgyStatusBar(raw))) {
        scanEnd--;
        continue;
      }
      break;
    }
  }

  // Skip trailing blank lines, callout/tip lines (`│ Tip: …`, `┃ …`), and wrapped `Tip:` blocks right above the composer.
  while (scanEnd >= 0) {
    const raw = lines[scanEnd]!;
    if (blank(raw) || CALLOUT_LINE_RE.test(raw) || TIP_START_RE.test(raw)) {
      scanEnd--;
      continue;
    }
    let tipAt = -1;
    for (let j = scanEnd - 1; j >= Math.max(0, scanEnd - 4); j--) {
      const prev = lines[j]!;
      if (TIP_START_RE.test(prev)) {
        tipAt = j;
        break;
      }
      if (blank(prev) || SOLID_RE.test(prev) || SPINNER_LINE_RE.test(prev) || WORK_BLOCK_START_RE.test(prev)) break;
    }
    if (tipAt >= 0) {
      scanEnd = tipAt - 1;
      continue;
    }
    break;
  }
  if (scanEnd < 0) return null;

  // The bottommost active block must start with a braille spinner line (possibly wrapped across a few lines).
  let start = -1;
  for (let i = scanEnd; i >= Math.max(0, scanEnd - 6); i--) {
    const raw = lines[i]!;
    if (SPINNER_LINE_RE.test(raw)) {
      start = i;
      break;
    }
    if (blank(raw) || SOLID_RE.test(raw) || CALLOUT_LINE_RE.test(raw) || TIP_START_RE.test(raw) || WORK_BLOCK_START_RE.test(raw)) {
      return null;
    }
  }
  if (start < 0) return null;

  const first = SPINNER_LINE_RE.exec(lines[start]!)![1]!;
  const text = joinWrapped([first, ...lines.slice(start + 1, scanEnd + 1)]).replace(/\s+/g, " ").trim();
  return text || null;
}
