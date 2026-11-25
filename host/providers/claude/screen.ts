// Claude Code's own dialogs, read from its screen for the terminal view
// (terminal.ts): a tool's permission prompt, a plan's approval,
// AskUserQuestion's questions and their review, and an Enter-to-confirm menu
// such as the folder trust check. The screen is the only source while one
// waits: Claude Code 2.1.330 writes the pending AskUserQuestion or
// ExitPlanMode call to the transcript only once it's answered. The shapes
// follow Ovis's readers (devswha/ovis server/dialogs/claude.ts, MIT) and were
// measured on Claude Code 2.1.330.
//
// Each dialog is a list of rows the cursor (`❯`) moves over with ↑/↓, in
// screen order (`stops`): numbered rows, a multiple choice's unnumbered
// Submit, a confirm menu's plain rows. An answer is the moves from the row
// the cursor is on to the one wanted, then Enter (terminal.ts).

/** A row the cursor stops on. `input`: a row that takes typed text (Type something, Tell Claude what to change). */
export type Row = {
  n: number | null;
  label: string;
  description?: string;
  selected: boolean;
  /** A multiple choice's box: [✔] or [ ]. */
  checked?: boolean;
  input?: boolean;
  /** A question's preview of this option, its lines as the box shows them: only the row the cursor is on has one. */
  preview?: string;
  /** Its index in `stops`. */
  stop: number;
};

export type ScreenPrompt =
  | { kind: "permission"; title: string; question: string; body: string; rows: Row[]; stops: Row[] }
  | { kind: "plan"; question: string; body: string; planFile: string | null; rows: Row[]; stops: Row[] }
  | {
      kind: "question"; header: string | null; tabs: { label: string; answered: boolean }[] | null; question: string;
      /** The options, then the Type something row when there is one (`other`). */
      rows: Row[]; other: Row | null; submit: Row | null; multi: boolean; stops: Row[];
    }
  | { kind: "review"; answers: { question: string; answer: string }[]; rows: Row[]; stops: Row[] }
  | { kind: "confirm"; title: string; body: string; rows: Row[]; stops: Row[] };

const ROW_RE = /^(\s*)(❯\s*)?(\d+)\.\s+(.*)$/;
// A multiple choice's button: "Submit" on the last question, "Next" before it (Claude Code 2.1.332).
const SUBMIT_RE = /^\s*(❯\s*)?(?:Submit|Next)$/;
const SOLID_RE = /^\s*─{8,}/;
const DASHED_RE = /^\s*╌{8,}\s*$/;
const BOX_RE = /^\[([ ✔✓xX])\]\s+(.*)$/;
const QUESTION_HINT_RE = /enter to select.*to navigate.*esc to cancel/i;
const CONFIRM_HINT_RE = /enter to confirm.*esc to (?:cancel|exit|go back)/i;
const CHIP_RE = /^\s*[☐☒☑✔]\s+(\S.*)$/;
const TABS_RE = /^\s*←\s+[☐☒☑✔]/;
const TYPE_RE = /^Type something\.?$/i;
const INPUT_RE = /^(?:Tell Claude what to change|No, and tell Claude what to do differently)\b/i;
const NOTE_RE = /^(?:shift\+tab|tab|ctrl\+\S+) to /i;

const blank = (l: string) => !l.trim();
const indent = (l: string) => /^\s*/.exec(l)![0].length;

/** The screen's lines, without trailing spaces or the blank rows under the last text. */
function screenLines(screen: string): string[] {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length && blank(lines.at(-1)!)) lines.pop();
  return lines;
}

/** The screen's last text lines (rules left out): the dialog's key hint is among them (a narrow pane wraps it, a status line may follow). */
function tailLines(lines: string[], n = 6): string[] {
  return lines.filter((l) => !blank(l) && !SOLID_RE.test(l)).slice(-n).map((l) => l.trim());
}

type Found = { stops: Row[]; first: number; last: number };

/**
 * The numbered rows nearest the screen's bottom, 1..N in order, with what's
 * under each (a description, or the rest of a wrapped label), a multiple
 * choice's Submit between them, and a divider before "Chat about this".
 * `describe`: lines under a row describe it (questions); else they continue its label.
 */
function numberedRows(lines: string[], describe: boolean): Found | null {
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 80; i--) if (ROW_RE.test(lines[i]!)) { end = i; break; }
  if (end < 0) return null;
  // Up from the last row to row 1: each row the number before the one below.
  const at: number[] = [];
  let want = Number(ROW_RE.exec(lines[end]!)![3]);
  for (let i = end; i >= 0 && want >= 1; i--) {
    const m = ROW_RE.exec(lines[i]!);
    if (!m) continue;
    if (Number(m[3]) !== want) return null;
    at.unshift(i);
    want--;
  }
  if (want !== 0) return null;
  const stops: Row[] = [];
  for (let k = 0; k < at.length; k++) {
    const i = at[k]!;
    const m = ROW_RE.exec(lines[i]!)!;
    const col = m[1]!.length + (m[2]?.length ?? 0) + m[3]!.length + 2;
    let label = m[4]!.trim();
    const notes: string[] = [];
    const next = at[k + 1] ?? lines.length;
    let submit: Row | null = null;
    for (let j = i + 1; j < next; j++) {
      const l = lines[j]!;
      if (SUBMIT_RE.test(l)) {
        submit = { n: null, label: "Submit", selected: Boolean(SUBMIT_RE.exec(l)![1]), stop: 0 };
        break;
      }
      if (blank(l) || SOLID_RE.test(l) || DASHED_RE.test(l)) {
        if (k === at.length - 1) break; // the last row: what's under it is the hint
        continue;
      }
      if (indent(l) < col - 2) break;
      const text = l.trim();
      if (describe || NOTE_RE.test(text) || notes.length) notes.push(text);
      else label = `${label} ${text}`;
    }
    stops.push(rowOf(Number(m[3]), label, notes, Boolean(m[2]), stops.length));
    if (submit) stops.push({ ...submit, stop: stops.length });
  }
  return { stops, first: at[0]!, last: at.at(-1)! };
}

function rowOf(n: number | null, label: string, notes: string[], selected: boolean, stop: number): Row {
  return { n, label, ...(notes.length ? { description: notes.join(" ") } : {}), selected, stop };
}

/** What's above the dialog's rows, up to its top rule: its text lines, the margin taken off. */
function above(lines: string[], first: number): string[] {
  let top = first - 1;
  while (top >= 0 && !SOLID_RE.test(lines[top]!)) top--;
  const block = lines.slice(top + 1, first);
  while (block.length && blank(block[0]!)) block.shift();
  while (block.length && blank(block.at(-1)!)) block.pop();
  const margin = Math.min(...block.filter((l) => !blank(l) && !DASHED_RE.test(l)).map(indent), 1);
  return block.map((l) => (DASHED_RE.test(l) ? "╌" : l.slice(Math.min(margin, indent(l)))));
}

/** Lines as Markdown: what stands between dashed rules (a command, a diff) as code. */
function markdown(block: string[]): string {
  const out: string[] = [];
  let code = false;
  for (const l of block) {
    if (l === "╌") {
      out.push("```");
      code = !code;
    } else if (code || !/^Tip: /.test(l)) out.push(code ? l : l.trim());
  }
  if (code) out.push("```");
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** The question over the rows: the text lines just above row 1 (a long one wraps). */
function questionAbove(block: string[]): { question: string; rest: string[] } {
  let i = block.length;
  while (i > 0 && block[i - 1] !== "╌" && !blank(block[i - 1]!)) i--;
  return { question: block.slice(i).map((l) => l.trim()).join(" "), rest: block.slice(0, i) };
}

/**
 * A question whose options have previews (Claude Code 2.1.332): the options
 * in a column on the left, a box beside them with the preview of the option
 * the cursor is on, and "Notes: press n to add notes" under the box. The
 * column's lines wrap a label (no descriptions show), and a bar (`│`) marks
 * the question. This takes the box and what's under it out of the lines, so
 * the options read as in the plain layout, and keeps the box's text.
 */
function cutPreview(lines: string[], from: number): { lines: string[]; text: string } | null {
  let top = -1;
  for (let i = Math.max(0, from - 2); i < lines.length && top < 0; i++) if (/┌─+┐$/.test(lines[i]!)) top = i;
  if (top < 0) return null;
  const x = lines[top]!.lastIndexOf("┌");
  const width = lines[top]!.length - x;
  // A border's column: where the top's corner is, else as far from the line's end as the box is wide (a wide character on the left).
  const border = (l: string, chars: string) => [x, l.length - width].find((c) => c >= 0 && chars.includes(l[c] ?? "")) ?? -1;
  const out = lines.slice();
  const text: string[] = [];
  let i = top;
  out[i] = lines[i]!.slice(0, x).replace(/\s+$/, "");
  for (i = top + 1; i < lines.length; i++) {
    const l = lines[i]!;
    const at = border(l, "│└");
    if (at < 0) break; // cut off at the screen's bottom
    out[i] = l.slice(0, at).replace(/\s+$/, "");
    if (l[at] === "└") break;
    text.push(l.slice(at + 1).replace(/\s*│$/, "").replace(/^ /, "").replace(/\s+$/, ""));
  }
  // Under the box, to the dialog's rule: its notes, beside the column's last rows.
  for (i++; i < lines.length && !SOLID_RE.test(lines[i]!); i++) {
    const l = lines[i]!;
    const left = l.slice(0, x);
    if (l.length > x && (!left.trim() || /\s{2}$/.test(left))) out[i] = left.replace(/\s+$/, "");
  }
  while (text.length && !text[0]!.trim()) text.shift();
  while (text.length && !text.at(-1)!.trim()) text.pop();
  return { lines: out, text: text.join("\n") };
}

function parseQuestion(screen: string[]): ScreenPrompt | null {
  let lines = screen;
  let found = numberedRows(lines, true);
  if (!found) return null;
  const preview = cutPreview(lines, found.first);
  if (preview) {
    lines = preview.lines;
    found = numberedRows(lines, false);
    if (!found) return null;
    const on = found.stops.find((r) => r.selected && r.n !== null);
    if (on && preview.text) on.preview = preview.text;
  }
  const { stops } = found;
  // "Chat about this" (after a divider) isn't an answer.
  const chat = stops.find((r) => /^Chat about this$/i.test(r.label));
  const answers = chat ? stops.filter((r) => r.stop < chat.stop) : stops;
  const submit = answers.find((r) => r.n === null && r.label === "Submit") ?? null;
  let rows = answers.filter((r) => r !== submit);
  const multi = rows.some((r) => BOX_RE.test(r.label));
  if (multi) rows = rows.map((r) => {
    const b = BOX_RE.exec(r.label);
    return b ? Object.assign(r, { label: b[2]!, checked: b[1] !== " " }) : r;
  });
  // Type something: the last row (a multiple choice's is the one above Submit, and shows what was typed).
  const last = rows.at(-1);
  const other = last && (TYPE_RE.test(last.label) || (multi && submit && last.stop === submit.stop - 1)) ? last : null;
  if (other) other.input = true;
  // The header: a single question's chip, or the tab bar over several (and a multiple choice).
  let head = found.first - 1;
  while (head >= 0 && !CHIP_RE.test(lines[head]!) && !TABS_RE.test(lines[head]!) && !SOLID_RE.test(lines[head]!)) head--;
  const headLine = head >= 0 ? lines[head]! : "";
  let header: string | null = null;
  let tabs: { label: string; answered: boolean }[] | null = null;
  if (TABS_RE.test(headLine)) {
    tabs = [...headLine.replace(/^\s*←/, "").replace(/→\s*$/, "").matchAll(/([☐☒☑✔])\s+(.+?)(?=\s{2,}|\s*$)/g)]
      .filter((m) => m[1] !== "✔").map((m) => ({ label: m[2]!.trim(), answered: m[1] !== "☐" }));
  } else if (CHIP_RE.test(headLine)) header = CHIP_RE.exec(headLine)![1]!.trim();
  const asked = lines.slice(head + 1, found.first).map((l) => l.trim()).filter(Boolean);
  // A bar before each of its lines (beside a preview): not part of it.
  const barred = asked.length > 0 && asked.every((l) => /^│(?:\s|$)/.test(l));
  const question = (barred ? asked.map((l) => l.replace(/^│\s?/, "")) : asked).join(" ");
  if (!question || !rows.length) return null;
  return { kind: "question", header, tabs, question, rows, other, submit, multi, stops };
}

function parseReview(lines: string[], found: Found): ScreenPrompt | null {
  if (found.stops.map((r) => r.label).join("\n") !== "Submit answers\nCancel") return null;
  let i = found.first - 1;
  while (i >= 0 && !/^\s*Review your answers\s*$/.test(lines[i]!)) i--;
  if (i < 0) return null;
  const answers: { question: string; answer: string }[] = [];
  for (const l of lines.slice(i + 1, found.first)) {
    const q = /^\s*●\s+(.*)$/.exec(l);
    const a = /^\s*→\s+(.*)$/.exec(l);
    if (q) answers.push({ question: q[1]!.trim(), answer: "" });
    else if (a && answers.length) answers.at(-1)!.answer = a[1]!.trim();
    else if (!blank(l) && answers.length) {
      const last = answers.at(-1)!;
      if (last.answer) last.answer += ` ${l.trim()}`;
      else last.question += ` ${l.trim()}`;
    }
  }
  return { kind: "review", answers, rows: found.stops, stops: found.stops };
}

/** A confirm menu's plain rows: the `❯` row and the rows beside it at its column. */
function parseConfirm(lines: string[]): ScreenPrompt | null {
  let hint = lines.length - 1;
  while (hint >= 0 && !CONFIRM_HINT_RE.test(lines[hint]!)) hint--;
  let sel = hint - 1;
  while (sel >= 0 && !/^\s*❯\s+\S/.test(lines[sel]!)) sel--;
  if (hint < 0 || sel < 0 || hint - sel > 20) return null;
  const col = lines[sel]!.indexOf("❯") + 2;
  const rowAt = (i: number) => {
    const l = lines[i] ?? "";
    return !blank(l) && (i === sel || (indent(l) >= col - 1 && indent(l) <= col + 1 && !/^\s*❯/.test(l)));
  };
  let first = sel;
  while (first > 0 && rowAt(first - 1)) first--;
  let last = sel;
  while (last < hint - 1 && rowAt(last + 1)) last++;
  const stops: Row[] = [];
  for (let i = first; i <= last; i++) stops.push({ n: null, label: lines[i]!.replace(/^\s*❯?\s*/, "").replace(/^\d+\.\s+/, "").trim(), selected: i === sel, stop: stops.length });
  if (stops.length < 2) return null;
  const block = above(lines, first).filter((l) => l !== "╌");
  const text = block.map((l) => l.trim()).filter(Boolean);
  if (!text.length) return null;
  return { kind: "confirm", title: text[0]!, body: text.slice(1).join("\n"), rows: stops, stops };
}

/**
 * The dialog Claude Code shows at the bottom of its screen (plain text, as
 * `hc read` prints it), or null: none, or one this doesn't know.
 */
export function readPrompt(screen: string): ScreenPrompt | null {
  const lines = screenLines(screen);
  if (!lines.length) return null;
  const last = tailLines(lines);
  const hint = last.join(" ");
  if (QUESTION_HINT_RE.test(hint)) return parseQuestion(lines);
  const found = numberedRows(lines, false);
  if (found) {
    const review = parseReview(lines, found);
    if (review) return review;
    const block = above(lines, found.first);
    const { question, rest } = questionAbove(block);
    if (/Would you like to proceed\?$/.test(question) && /plan/i.test(question)) {
      const file = /(~?\/\S*\/plans\/\S+?\.md)\b/.exec(lines.slice(found.last).join(" "))?.[1] ?? null;
      // The plan: over the question, or (2.1.330) in a box of its own above a rule.
      let shown = rest;
      if (!shown.some((l) => l.trim())) {
        let rule = found.first - 1;
        while (rule >= 0 && !SOLID_RE.test(lines[rule]!)) rule--;
        if (rule > 0) shown = above(lines, rule);
      }
      const inner = shown.filter((l) => !/^(Ready to code\?|Here is Claude's plan:)$/.test(l.trim()));
      const plan = inner.join("\n").replace(/^╌\n?|\n?╌$/g, "").replace(/\n╌\n/g, "\n\n").trim();
      for (const r of found.stops) if (INPUT_RE.test(r.label)) r.input = true;
      return { kind: "plan", question, body: plan, planFile: file, rows: found.stops, stops: found.stops };
    }
    if (/^Do you want to /i.test(question) || last.some((l) => /^Esc to cancel\b/i.test(l))) {
      for (const r of found.stops) if (INPUT_RE.test(r.label)) r.input = true;
      const title = rest.find((l) => l !== "╌" && l.trim())?.trim() ?? question;
      const body = markdown(rest.slice(rest.findIndex((l) => l.trim() === title) + 1));
      return { kind: "permission", title, question, body, rows: found.stops, stops: found.stops };
    }
  }
  if (CONFIRM_HINT_RE.test(hint)) return parseConfirm(lines);
  return null;
}

/** What a dialog asks, without where its cursor is or what's checked: the same while only those change. */
export function promptKey(p: ScreenPrompt): string {
  const rows = p.rows.map((r) => `${r.n ?? ""}${r.input ? "*" : ""}:${r === (p as { other?: Row | null }).other ? "" : r.label}`);
  const what = p.kind === "question" ? `${p.question}|${(p.tabs ?? []).map((t) => t.label).join(",")}` : p.kind === "review" ? JSON.stringify(p.answers) : p.kind === "permission" ? `${p.title}|${p.question}|${p.body}` : p.kind === "plan" ? p.question : `${p.title}|${p.body}`;
  return `${p.kind}|${what}|${rows.join("|")}`;
}

/** The keys that move the cursor from where it is to `to`. */
export function movesTo(p: ScreenPrompt, to: Row): string[] {
  const from = p.stops.find((r) => r.selected)?.stop ?? 0;
  const d = to.stop - from;
  return Array.from({ length: Math.abs(d) }, () => (d > 0 ? "down" : "up"));
}

// A screen open over the prompt (the /model picker, /config, a list) ends in one of these hints.
const OPEN_HINT_RE = /\b(?:Esc to (?:cancel|exit|go back|close)|Enter to (?:confirm|select|continue))\b/i;

/**
 * Whether Claude Code shows its prompt with nothing over it: its input line (`❯ ` and what's typed,
 * never a list's `❯ 1. Yes`) right under a rule, and no dialog or picker on the screen.
 */
export function claudeAtPrompt(screen: string): boolean {
  if (readPrompt(screen)) return false;
  const tail = screenLines(screen).slice(-12);
  if (tail.some((l) => OPEN_HINT_RE.test(l))) return false;
  for (let i = 1; i < tail.length; i++) {
    if (SOLID_RE.test(tail[i - 1]!) && /^\s*[❯>](?:\s|$)/.test(tail[i]!) && !/^\s*[❯>]\s*\d+\.\s/.test(tail[i]!)) return true;
  }
  return false;
}

const VALID_CLAUDE_KEY_RE = /^(?:(?:ctrl|alt|shift)\+)*(?:[a-z0-9]|enter|tab|esc|space|up|down|left|right|f(?:[1-9]|1[0-2]))$/;

/**
 * Read Claude Code's `chat:sendNow` chord from its queued-message hint, e.g.:
 *   `Queued · ctrl+x ctrl+s send now` or `Queued · ctrl+enter send now`.
 * Returns the sequence of `hc keys` names, or null when no keyboard hint is shown.
 */
export function readClaudeSendNowKeys(screen: string): string[] | null {
  const lines = screenLines(screen);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const m = /\bQueued\s*·\s*([^·\n]{1,32}?)\s+send\s+now\b/i.exec(lines[i]!);
    if (!m) continue;
    const raw = m[1]!.trim();
    if (!raw || /\bclick\s+to\b/i.test(raw)) continue;
    const parts = raw
      .toLowerCase()
      .replace(/⌥\s*/g, "alt+")
      .replace(/⌃\s*/g, "ctrl+")
      .replace(/⇧\s*/g, "shift+")
      .replace(/\b(?:opt|option|meta)\s*\+/g, "alt+")
      .replace(/\bcontrol\s*\+/g, "ctrl+")
      .replace(/\s*\+\s*/g, "+")
      .replace(/↩/g, "enter")
      .split(/\s+/)
      .filter(Boolean)
      .map((k) => k.replace(/(?:^|\+)return$/g, (x) => x.replace("return", "enter")).replace(/(?:^|\+)escape$/g, (x) => x.replace("escape", "esc")));
    if (parts.length && parts.every((k) => VALID_CLAUDE_KEY_RE.test(k))) return parts;
  }
  return null;
}
