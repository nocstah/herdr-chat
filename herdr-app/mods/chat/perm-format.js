// Pure command-formatting helpers for permission cards (dialogs.js):
// splits chained single-line shell commands on top-level unquoted `&&`, `||`, `;`
// so each command in a chain is easy to scan before approving.

/**
 * Split a shell command into scannable visual steps (`{ op, text }`).
 * - Multi-line scripts keep their exact line structure (`$` on the first line).
 * - Single-line chains split only at top-level unquoted `&&`, `||`, or `;`
 *   (never inside quotes, subshells `(...)`, command substitutions `$(...)`,
 *   brace groups `{...}`, or `case` terminators `;;`).
 *
 * @param {string} command
 * @returns {{ op: string, text: string }[]}
 */
export function commandSteps(command) {
  const trimmed = String(command ?? "").replace(/\r/g, "").replace(/\n+$/, "");
  if (!trimmed.trim()) return [];
  if (trimmed.includes("\n")) {
    return trimmed.split("\n").map((line, i) => ({ op: i === 0 ? "$" : "", text: line }));
  }

  /** @type {{ op: string, text: string }[]} */
  const steps = [];
  let start = 0;
  let op = "$";
  let quote = ""; // "'" | '"' | "`" | ""
  let paren = 0;
  let brace = 0;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      i++; // skip escaped char
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") { paren++; continue; }
    if (ch === ")" && paren > 0) { paren--; continue; }
    if (ch === "{") { brace++; continue; }
    if (ch === "}" && brace > 0) { brace--; continue; }

    if (paren === 0 && brace === 0) {
      const next = trimmed[i + 1];
      let sep = "";
      if (ch === "&" && next === "&") sep = "&&";
      else if (ch === "|" && next === "|") sep = "||";
      else if (ch === ";" && next !== ";") {
        // Ignore `;;` (case terminator) and trailing `;`.
        const rest = trimmed.slice(i + 1).trim();
        if (rest) sep = ";";
      }
      if (sep) {
        const seg = trimmed.slice(start, i).trim();
        if (seg) {
          steps.push({ op, text: seg });
          op = sep;
          start = i + sep.length;
        }
        if (sep.length === 2) i++;
      }
    }
  }

  const tail = trimmed.slice(start).trim();
  if (tail) steps.push({ op, text: tail });
  return steps;
}
