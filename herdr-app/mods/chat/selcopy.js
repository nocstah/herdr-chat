// Text selection state and actions for chat prose (rich.js and cards.js TextViews).
// Herdr 0.1.18+ reports settled selections through TextView.on_selection_change({ text, range, position }),
// so copy, right-click menus, and quoting read the live selection directly without shelling out or touching
// the system clipboard.

/**
 * Updates the active TextView selection snapshot.
 * Only clears when `viewId` matches the currently tracked view so a blur/clear from a previously
 * selected TextView cannot clobber a newer selection in another TextView.
 *
 * @typedef {{ viewId: string, itemId: string | null, text: string, markdown: string | null, range: { start: number, end: number } | null, position: { x: number, y: number } | null }} ChatSelection
 * @param {ChatSelection | null | undefined} current
 * @param {string} viewId
 * @param {{ text?: string, range?: { start: number, end: number } | null, position?: { x: number, y: number } | null } | null | undefined} sel
 * @param {{ itemId?: string | null, source?: string | null }} [meta]
 * @returns {ChatSelection | null}
 */
export function updateSelection(current, viewId, sel, meta = {}) {
  const text = typeof sel?.text === "string" ? sel.text : "";
  if (!text) return current?.viewId === viewId ? null : (current ?? null);
  const src = typeof meta.source === "string" ? meta.source : null;
  const r = sel?.range;
  const markdown = src != null && r && Number.isInteger(r.start) && Number.isInteger(r.end)
    && r.start >= 0 && r.end <= src.length && r.end > r.start
    ? src.slice(r.start, r.end)
    : null;
  return {
    viewId,
    itemId: meta.itemId ?? null,
    text,
    markdown,
    range: r ? { start: r.start, end: r.end } : null,
    position: sel?.position ? { x: sel.position.x, y: sel.position.y } : null,
  };
}

/**
 * Picks the passage to quote for an assistant message:
 * 1. The live selection inside that message (preferring its Markdown slice when available),
 * 2. Else a clipboard snippet that matches part of the message (`plainText` fallback),
 * 3. Else `null` (caller quotes the whole message).
 *
 * @param {ChatSelection | null | undefined} sel
 * @param {string | null | undefined} itemId
 * @param {string} whole
 * @param {string | null | undefined} clipboard
 * @param {(s: string) => string} plainText
 * @returns {{ body: string, source: "selection" | "clipboard" } | null}
 */
export function selectionForQuote(sel, itemId, whole, clipboard, plainText) {
  if (sel?.text && (!sel.itemId || sel.itemId === itemId)) {
    const picked = (sel.markdown ?? sel.text).trim();
    if (picked) return { body: picked, source: "selection" };
  }
  const clip = String(clipboard ?? "").trim();
  if (clip && plainText(clip).length >= 8 && clip.length < whole.length && plainText(whole).includes(plainText(clip))) {
    return { body: clip, source: "clipboard" };
  }
  return null;
}

/** A message's right-click menu: Copy for the active selection (its start in the label), then Copy message.
 *  @param {string | null} selection @param {string | null | undefined} message */
export function messageMenuItems(selection, message) {
  /** @type {{ id: string, label: string, text: string }[]} */
  const items = [];
  if (selection) {
    const flat = selection.replace(/\s+/g, " ").trim();
    items.push({ id: "copy", label: `Copy “${flat.length > 28 ? flat.slice(0, 27) + "…" : flat}”`, text: selection });
  }
  if (message) items.push({ id: "copy-message", label: "Copy message", text: message });
  return items;
}
