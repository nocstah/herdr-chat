// Pure, UI-agnostic logic for Antigravity artifact review & approval in Chat View
// (artifacts.js). Tested directly in Node without GPUI bindings.

/** @typedef {{ name: string, path: string, summary?: string | null, status: "pending" | "approved" | "rejected", requestFeedback?: boolean, updatedAt?: number | null, content?: string, truncated?: boolean, sizeBytes?: number | null }} ArtifactEntry */

/** @param {ArtifactEntry[] | null | undefined} list */
export function pendingArtifactsOf(list) {
  return Array.isArray(list) ? list.filter((a) => a && a.status === "pending") : [];
}

/** @param {string | null | undefined} name */
export function artifactShortName(name) {
  const s = String(name ?? "").trim();
  if (!s) return "artifact";
  const base = s.split("/").pop() || s;
  return base.length > 28 ? `${base.slice(0, 27).trimEnd()}…` : base;
}

/** @param {string} status */
export function artifactStatusLabel(status) {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Changes requested";
  return "Pending review";
}

/** @param {string} status @param {any} t */
export function artifactStatusTone(status, t) {
  if (status === "approved") return t.ansi2 ?? t.accent;
  if (status === "rejected") return t.ansi1 ?? t.blocked;
  return t.blocked ?? t.ansi3 ?? t.accent;
}

/** @param {number | null | undefined} bytes */
export function formatArtifactBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pick the active artifact to display: keep current if still present, else first pending, else first. */
/** @param {ArtifactEntry[]} list @param {string | null} currentName */
export function pickActiveArtifact(list, currentName) {
  if (!Array.isArray(list) || !list.length) return null;
  if (currentName) {
    const found = list.find((a) => a.name === currentName);
    if (found) return found;
  }
  return list.find((a) => a.status === "pending") ?? list[0] ?? null;
}

/**
 * Ordered review action buttons for the active artifact(s).
 * - Single pending artifact: `1 Approve` (or `Approve with note`), `2 Request changes`, optional `3 Comment only`.
 * - Multiple pending artifacts: `1 Approve all (N)`, `2 Approve <name>`, `3 Request changes`, optional `4 Comment only`.
 * - Non-pending (already approved/rejected in `/artifact` modal): `Approve`, `Request changes`, optional `Send comment`.
 */
/** @param {ArtifactEntry[]} artifacts @param {string | null} activeName @param {boolean} hasFeedback */
export function artifactChoices(artifacts, activeName, hasFeedback = false) {
  const list = Array.isArray(artifacts) ? artifacts : [];
  const active = pickActiveArtifact(list, activeName);
  if (!active) return [];
  const pending = pendingArtifactsOf(list);
  const multiPending = pending.length > 1;
  const out = [];
  if (multiPending) {
    out.push({
      id: "approve_all",
      action: "approve_all",
      artifact: null,
      label: `Approve all (${pending.length})`,
      kind: "allow",
      key: out.length + 1,
      description: `Approve all ${pending.length} pending artifacts`,
    });
    out.push({
      id: "approve",
      action: "approve",
      artifact: active.name,
      label: hasFeedback ? `Approve ${artifactShortName(active.name)} + note` : `Approve ${artifactShortName(active.name)}`,
      kind: "other",
      key: out.length + 1,
      description: `Approve only ${active.name}`,
    });
  } else {
    out.push({
      id: "approve",
      action: "approve",
      artifact: active.name,
      label: hasFeedback ? "Approve with note" : "Approve",
      kind: "allow",
      key: out.length + 1,
      description: `Approve ${active.name}`,
    });
  }
  out.push({
    id: "reject",
    action: "reject",
    artifact: active.name,
    label: hasFeedback ? "Request changes" : "Reject",
    kind: "deny",
    key: out.length + 1,
    description: hasFeedback ? `Request changes on ${active.name} with your feedback` : `Reject ${active.name}`,
  });
  if (hasFeedback) {
    out.push({
      id: "comment",
      action: "comment",
      artifact: active.name,
      label: "Comment only",
      kind: "other",
      key: out.length + 1,
      description: `Send comments on ${active.name} without approving or rejecting yet`,
    });
  }
  return out;
}

/**
 * Resolve a keyboard shortcut on an active artifact dialog (`1..9`, `"enter"`, `"escape"`)
 * into a `dialog_answer` payload, or null if the key doesn't apply.
 */
/** @param {number | "enter" | "escape"} key @param {ArtifactEntry[]} artifacts @param {string | null} activeName @param {string} [feedback] */
export function artifactShortcutAnswer(key, artifacts, activeName, feedback = "") {
  if (key === "escape") return { artifactAction: "dismiss" };
  const msg = String(feedback ?? "").trim();
  const choices = artifactChoices(artifacts, activeName, Boolean(msg));
  let picked = null;
  if (key === "enter") picked = choices.find((c) => c.kind === "allow") ?? choices[0] ?? null;
  else if (typeof key === "number") picked = choices[key - 1] ?? null;
  if (!picked) return null;
  return {
    artifactAction: picked.action,
    ...(picked.artifact ? { artifact: picked.artifact } : {}),
    ...(msg ? { message: msg } : {}),
  };
}
