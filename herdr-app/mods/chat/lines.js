// A message's line breaks kept as written (no toolkit imports: tests/host/lines.test.ts runs it in Node).
//
// Markdown joins the lines of a paragraph into one ("soft breaks"), so a pasted
// log or a prompt written line by line ran together in its bubble. As in Ovis's
// chat, every line break in a message you (or another agent) sent is a line
// break: two spaces at a line's end make it a hard break. Code fences and
// indented code keep their lines anyway and are left as they are; so is a line
// that already ends in a hard break or is followed by a blank line.

const FENCE = /^\s*(`{3,}|~{3,})/;

/** @param {string} text markdown @returns {string} */
export function keepBreaks(text) {
  const lines = text.split("\n");
  /** @type {string | null} */
  let fence = null;
  return lines.map((line, i) => {
    const f = FENCE.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
      return line;
    }
    if (f) { fence = f[1]; return line; }
    const next = lines[i + 1];
    if (next === undefined || !next.trim() || !line.trim()) return line;
    if (/^( {4}|\t)/.test(line) || / {2}$|\\$/.test(line)) return line;
    return `${line}  `;
  }).join("\n");
}
