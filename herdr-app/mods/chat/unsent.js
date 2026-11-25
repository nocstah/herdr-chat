// Pure helpers for retained unsent/rejected messages in Herdr Chat.
// Kept free of gpui-kit / herdr imports so Node unit tests exercise it directly.

const MAX_RETAINED_SENDS = 10;

/**
 * Strip noisy prefixes (`send: `, `Antigravity rejected the message: `) so the
 * unsent card's reason line stays concise and readable.
 */
export function cleanRejectionReason(raw) {
  let s = String(raw ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/^send:\s*/i, "");
  s = s.replace(/^[A-Za-z][A-Za-z0-9 _-]{0,30}\s+rejected the message:\s*/i, "");
  return s || "The message could not be sent.";
}

/**
 * Append (or update by id) a rejected draft in the retained unsent queue,
 * capping at `max` most recent entries.
 */
export function retainFailedSend(list, draft, reason, max = MAX_RETAINED_SENDS) {
  const prev = Array.isArray(list) ? list : [];
  const item = {
    ...draft,
    chips: Array.isArray(draft?.chips) ? draft.chips.map((c) => ({ ...c })) : [],
    images: Array.isArray(draft?.images) ? [...draft.images] : [],
    files: Array.isArray(draft?.files) ? [...draft.files] : [],
    pastes: Array.isArray(draft?.pastes) ? draft.pastes.map((c) => ({ ...c })) : [],
    reason: cleanRejectionReason(reason),
    failedAt: Date.now(),
  };
  const next = prev.filter((x) => x.id !== item.id);
  next.push(item);
  return next.length > max ? next.slice(-max) : next;
}

/** Remove one retained unsent entry by id. */
export function removeFailedSend(list, id) {
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x.id !== id);
}

/**
 * Restore a retained draft's text and chips back into the composer without
 * clobbering anything the user already started typing.
 */
export function mergeDraftIntoComposer(currentText, currentChips, failed) {
  const now = String(currentText ?? "");
  const restored = String(failed?.rawText ?? failed?.text ?? "");
  let text;
  if (!now.trim()) text = restored;
  else if (!restored.trim()) text = now;
  else text = `${now}\n\n${restored}`;

  const existing = Array.isArray(currentChips) ? currentChips : [];
  const added = Array.isArray(failed?.chips) ? failed.chips.map((c) => ({ ...c })) : [];
  return { text, chips: [...existing, ...added] };
}

/** Compact preview text + attachment summary badges for a retained unsent card. */
export function failedSendSummary(item, maxChars = 280, maxLines = 4) {
  const raw = String(item?.rawText ?? item?.text ?? "").trim();
  const lines = raw ? raw.split("\n") : [];
  let preview = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (preview.length > maxChars) {
    preview = `${preview.slice(0, maxChars - 1).trimEnd()}…`;
    truncated = true;
  } else if (truncated) {
    preview = `${preview.trimEnd()}…`;
  }

  const chips = Array.isArray(item?.chips) ? item.chips : [];
  let pastes = 0;
  let images = 0;
  let files = 0;
  if (chips.length) {
    for (const ch of chips) {
      if (ch.kind === "paste") pastes++;
      else if (ch.kind === "file") files++;
      else images++;
    }
  } else {
    images = Array.isArray(item?.images) ? item.images.length : 0;
    files = Array.isArray(item?.files) ? item.files.length : 0;
    pastes = Array.isArray(item?.pastes) ? item.pastes.length : 0;
  }

  const attachments = [];
  if (pastes) attachments.push(`${pastes} paste${pastes === 1 ? "" : "s"}`);
  if (images) attachments.push(`${images} image${images === 1 ? "" : "s"}`);
  if (files) attachments.push(`${files} file${files === 1 ? "" : "s"}`);

  return { preview, truncated, attachments };
}
