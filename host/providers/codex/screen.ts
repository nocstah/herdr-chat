// Codex's own dialogs, read from its screen for the terminal view
// (terminal.ts): an approval (a command, edits, network access, permissions,
// an MCP server's request), request_user_input's questions, and its other
// lists (Implement this plan?, an MCP form's Allow/Cancel, Submit with
// unanswered questions?). Shapes as Codex 0.171 draws them
// (codex-rs/tui/src/bottom_pane approval_overlay.rs, request_user_input/,
// mcp_server_elicitation.rs, and their snapshot tests).
//
// Each is a title, what it asks about, numbered rows the cursor (`›`) moves
// over with ↑/↓, and a footer of keys. An approval's rows show their
// shortcut in brackets ("Yes, proceed (y)", "No, and tell Codex what to do
// differently (esc)"): its answer is that key. Other rows: the moves from the
// cursor's row, then Enter.

export type CodexRow = {
  n: number | null;
  label: string;
  description?: string;
  /** The key that picks it at once (an approval's `(y)`). */
  key?: string;
  selected: boolean;
  /** A row that takes typed text (Type your answer). */
  input?: boolean;
  /** Its index in `stops`. */
  stop: number;
};

export type CodexPrompt =
  | { kind: "approval"; title: string; body: string; rows: CodexRow[]; stops: CodexRow[] }
  | {
      kind: "question"; progress: string | null; question: string;
      /** The options; `other`: None of the above; `freeform`: the answer field when there are no options. */
      rows: CodexRow[]; other: CodexRow | null; freeform: CodexRow | null; stops: CodexRow[];
    }
  | { kind: "choice"; title: string; body: string; rows: CodexRow[]; stops: CodexRow[] };

const ROW_RE = /^(\s*)(›\s*)?(\d+)\.\s+(.*)$/;
const FREEFORM_RE = /^(\s*)(›\s*)?(Type your answer.*)$/;
const FOOTER_RE = /(?:Press enter to confirm or esc to cancel|enter to submit answer|esc to interrupt|enter select\s*·\s*esc back|enter to submit\s*\|\s*esc to cancel|enter to confirm)/i;
const TITLE_RE = /^\s*(Would you like to .+\?|Do you want to .+\?|.+ needs your approval\.|Question \d+\/\d+.*|Implement this plan\?|Field \d+\/\d+|Submit with unanswered questions\?)\s*$/;
const SHORTCUT_RE = /\s+\(([a-z0-9]|esc|enter|tab|ctrl\+[a-z]|alt\+[a-z]|shift\+[a-z])\)$/i;
const QUESTION_RE = /^\s*(Question \d+\/\d+.*)$/;
const OTHER_RE = /^None of the above$/i;

const blank = (l: string) => !l.trim();
const indent = (l: string) => /^\s*/.exec(l)![0].length;

function screenLines(screen: string): string[] {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && blank(lines.at(-1)!)) lines.pop();
  return lines;
}

/** "Option 1           First choice." → label and description (two spaces or more between them). */
function columns(text: string): { label: string; description?: string } {
  const m = /^(.+?)\s{2,}(\S.*)$/.exec(text);
  return m ? { label: m[1]!.trim(), description: m[2]!.trim() } : { label: text.trim() };
}

/** The dialog on Codex's screen, or null when none is (or the screen shows one this doesn't know). */
export function readCodexPrompt(screen: string): CodexPrompt | null {
  const lines = screenLines(screen);
  let f = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) if (FOOTER_RE.test(lines[i]!)) {
    f = i;
    break;
  }
  if (f < 0) return null;
  let t = -1;
  for (let i = f - 1; i >= Math.max(0, f - 80); i--) if (TITLE_RE.test(lines[i]!)) {
    t = i;
    break;
  }
  if (t < 0) return null;
  const title = lines[t]!.trim();

  // Rows (a long one wraps onto lines indented under its text), and what comes before them.
  const rows: CodexRow[] = [];
  const before: string[] = [];
  let last: { row: CodexRow; at: number } | null = null;
  for (let i = t + 1; i < f; i++) {
    const l = lines[i]!;
    const m = ROW_RE.exec(l);
    const ff = !m ? FREEFORM_RE.exec(l) : null;
    if (m || ff) {
      const text = (m ? m[4]! : ff![3]!).trim();
      const at = l.indexOf(text);
      const row: CodexRow = { n: m ? Number(m[3]) : null, label: text, selected: Boolean(m ? m[2] : ff![2]), stop: rows.length };
      if (ff) row.input = true;
      rows.push(row);
      last = { row, at };
      continue;
    }
    if (blank(l)) {
      last = null;
      continue;
    }
    if (last && indent(l) >= last.at - 1 && rows.length) {
      last.row.label = `${last.row.label} ${l.trim()}`;
      continue;
    }
    if (!rows.length) before.push(l.trim());
  }
  if (!rows.length) return null;
  const approval = /^(Would you like|Do you want|.+ needs your approval\.)/.test(title);
  for (const r of rows) {
    // An approval's rows end in their shortcut; other lists' rows are a label and a description.
    const k = approval ? SHORTCUT_RE.exec(r.label) : null;
    if (k) {
      r.key = k[1]!.toLowerCase();
      r.label = r.label.slice(0, k.index).trim();
    } else if (r.n !== null) Object.assign(r, columns(r.label));
  }
  const body = before.join("\n").trim();

  if (QUESTION_RE.test(title)) {
    const options = rows.filter((r) => !r.input);
    const other = options.find((r) => OTHER_RE.test(r.label)) ?? null;
    const freeform = rows.find((r) => r.input) ?? null;
    return { kind: "question", progress: title, question: body, rows: options.filter((r) => r !== other), other, freeform, stops: rows };
  }
  if (approval) return { kind: "approval", title, body, rows, stops: rows };
  return { kind: "choice", title, body, rows, stops: rows };
}

/** What a card stands for: the same dialog keeps its card while the cursor moves. */
export function codexPromptKey(p: CodexPrompt): string {
  const head = p.kind === "question" ? `${p.progress}\n${p.question}` : `${p.title}\n${p.body}`;
  return `${p.kind}\n${head}\n${p.stops.map((r) => r.label).join("\n")}`;
}

/** ↑/↓ from the cursor's row to `to`. */
export function codexMovesTo(p: CodexPrompt, to: CodexRow): string[] {
  const at = p.stops.find((r) => r.selected)?.stop ?? 0;
  const n = to.stop - at;
  return Array.from({ length: Math.abs(n) }, () => (n > 0 ? "down" : "up"));
}

// A screen open over the prompt ends in one of these key hints (the model and reasoning pickers'
// "enter select · esc back", the questions' "enter to submit answer", an approval's "Press enter to
// confirm"); a running turn's "esc to interrupt" isn't one: the prompt is still there.
const OPEN_HINT_RE = /\b(?:esc back|esc to (?:cancel|go back|close|dismiss|exit)|enter (?:select|default)|enter to (?:confirm|select|submit|resume|continue)|press enter)\b/i;
// The composer's line: `› ` and what's typed (or its placeholder), never a list's `› 3. High`.
const COMPOSER_RE = /^›(?:\s|$)(?!\s*\d+\.\s)/;

/** Whether Codex shows its prompt with nothing over it (no picker, list, pager or dialog): its composer near the bottom. */
export function codexAtPrompt(screen: string): boolean {
  if (readCodexPrompt(screen)) return false;
  const tail = screenLines(screen).slice(-14);
  if (tail.some((l) => OPEN_HINT_RE.test(l))) return false;
  return tail.some((l) => COMPOSER_RE.test(l));
}
