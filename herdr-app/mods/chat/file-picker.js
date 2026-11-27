// Native file picker (Herdr 0.1.18+ herdr.pickFiles) and @-mention formatting for uploaded/dropped files.
// Kept free of gpui-kit / herdr imports so Node unit tests exercise it directly.

/**
 * Formats a file path as an `@` mention. Paths inside `cwd` become relative to it;
 * paths containing whitespace or quotes are wrapped in `@"…"`.
 * @param {string} path
 * @param {string | null | undefined} [cwd]
 * @returns {string}
 */
export function formatMention(path, cwd = null) {
  let shown = String(path ?? "");
  const base = cwd ? String(cwd).replace(/\/+$/, "") : "";
  if (base && base !== "/" && shown.startsWith(base + "/")) shown = shown.slice(base.length + 1);
  if (/[\s"]/.test(shown)) return `@"${shown.replace(/"/g, '\\"')}"`;
  return `@${shown}`;
}

/**
 * Appends attached non-image file paths to a prompt so leading `/command` and skill
 * tokens stay at the start while every agent receives unambiguous `@` file mentions.
 * @param {string} text
 * @param {string[]} files
 * @param {string | null | undefined} [cwd]
 * @returns {string}
 */
export function composeWithFiles(text, files, cwd = null) {
  const list = (files ?? []).filter(Boolean);
  if (!list.length) return text;
  const mentions = list.map((p) => formatMention(p, cwd)).join(" ");
  return text.trim() ? `${text}\n\n${mentions}` : mentions;
}

/**
 * Opens Herdr's native OS file picker and resolves to the chosen absolute paths (or `[]` on cancel).
 * @param {((options?: { prompt?: string; multiple?: boolean }) => Promise<string[] | null>) | null | undefined} nativePick
 * @param {{ prompt?: string; multiple?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function pickFiles(nativePick, opts = {}) {
  if (typeof nativePick !== "function") {
    throw new Error("Native file picker requires Herdr 0.1.18+, or drag and drop files into the chat");
  }
  const picked = await nativePick({
    prompt: opts.prompt ?? "Upload files",
    multiple: opts.multiple !== false,
  });
  return Array.isArray(picked) ? picked.filter((p) => typeof p === "string" && p.length > 0) : [];
}
