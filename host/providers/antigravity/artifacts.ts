// Antigravity CLI artifact tracking, review folding, safe disk reading, and
// decision formatting (`[Approved] <name>` / `[Rejected] <name>`), mirroring
// Antigravity's `cli/artifactreview` state machine so Chat View can review,
// approve, reject, or comment on artifacts without flipping to the terminal.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { decodeToolArgs } from "./tools.ts";
import { extractUserText } from "./items.ts";

type Rec = Record<string, any>;

export type ArtifactReviewStatus = "pending" | "approved" | "rejected";
export type ArtifactReviewAction = "approve" | "approve_all" | "reject" | "comment" | "dismiss";

export type ArtifactEntry = {
  /** Posix-style relative path under `<dataDir>/brain/<conversationId>/`, e.g. `implementation_plan.md`. */
  name: string;
  /** Absolute path on the host machine (for opening in Herdr's files viewer or editor). */
  path: string;
  /** Human summary from `ArtifactMetadata.Summary` or sibling `.metadata.json`. */
  summary?: string | null;
  /** Folded review status (`pending` until `[Approved]` or `[Rejected]`, reset to `pending` on new edits). */
  status: ArtifactReviewStatus;
  /** True when the tool call explicitly passed `ArtifactMetadata.RequestFeedback: true`. */
  requestFeedback?: boolean;
  /** Last write/modification timestamp (ms since epoch), when known. */
  updatedAt?: number | null;
  /** Bounded UTF-8 Markdown content (included on demand in review dialogs and `artifact_read`). */
  content?: string;
  /** True if `content` was truncated to fit the wire budget. */
  truncated?: boolean;
  /** Total file size on disk in bytes, when known. */
  sizeBytes?: number | null;
};

export type ArtifactReviewRequest = {
  action: ArtifactReviewAction;
  artifact?: string;
  message?: string;
};

export const ARTIFACT_MAX_READ_BYTES = 128 * 1024;
const MAX_SCAN_DEPTH = 2;
const SKIP_DIRS = new Set([".system_generated", "scratch"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "replace_file_content", "multi_replace_file_content", "code_action"]);
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".toml", ".mermaid", ".mmd"]);

export function artifactBrainDir(dataDir: string, conversationId: string): string {
  return join(dataDir, "brain", conversationId);
}

/**
 * Resolve a raw tool/user path against `<dataDir>/brain/<conversationId>/`.
 * Returns `{ name, path }` only for non-internal artifact files inside `brainDir`
 * (excluding `.system_generated/`, `scratch/`, hidden dot-directories, and `*.metadata.json`).
 */
export function resolveArtifactPath(brainDir: string, rawPath: string): { name: string; path: string } | null {
  let cleaned = String(rawPath ?? "").trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("file://")) {
    try {
      cleaned = decodeURIComponent(cleaned.slice(7));
    } catch {
      cleaned = cleaned.slice(7);
    }
  }
  const root = resolve(brainDir);
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const posixRel = rel.replace(/\\/g, "/");
  const segs = posixRel.split("/");
  if (segs.some((s) => !s || s === "." || s === ".." || SKIP_DIRS.has(s) || s.startsWith("."))) return null;
  if (posixRel.endsWith(".metadata.json")) return null;
  return { name: posixRel, path: abs };
}

/**
 * Parse a single line of a `USER_INPUT` step matching Antigravity's `artifactreview.parseDecision`:
 * `[Approved] <name>` or `[Rejected] <name>` (trimming whitespace and surrounding backticks).
 */
export function parseArtifactDecisionLine(line: string): { status: "approved" | "rejected"; name: string } | null {
  const trimmed = line.trim();
  let status: "approved" | "rejected";
  let rest: string;
  if (trimmed.startsWith("[Approved] ")) {
    status = "approved";
    rest = trimmed.slice(11);
  } else if (trimmed.startsWith("[Rejected] ")) {
    status = "rejected";
    rest = trimmed.slice(11);
  } else {
    return null;
  }
  const name = rest.trim().replace(/^`+|`+$/g, "").trim();
  if (!name) return null;
  return { status, name };
}

/** Read a sibling `<artifact>.metadata.json` file's summary & timestamp if present. */
function readArtifactMetadata(artifactPath: string): { summary: string | null; updatedAt: number | null } {
  const metaPath = `${artifactPath}.metadata.json`;
  if (!existsSync(metaPath)) return { summary: null, updatedAt: null };
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Rec;
    const summary = typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : null;
    const updatedAt = typeof parsed.updatedAt === "string" ? Date.parse(parsed.updatedAt) : NaN;
    return { summary, updatedAt: Number.isFinite(updatedAt) ? updatedAt : null };
  } catch {
    return { summary: null, updatedAt: null };
  }
}

/** Read a bounded UTF-8 slice of an artifact file from disk. */
export function readBoundedFile(path: string, maxBytes = ARTIFACT_MAX_READ_BYTES): { content: string; truncated: boolean; sizeBytes: number } | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    const sizeBytes = st.size;
    if (sizeBytes === 0) return { content: "", truncated: false, sizeBytes: 0 };
    const toRead = Math.min(sizeBytes, maxBytes);
    const buf = Buffer.alloc(toRead);
    const fd = openSync(path, "r");
    try {
      const n = readSync(fd, buf, 0, toRead, 0);
      return { content: buf.subarray(0, n).toString("utf8"), truncated: sizeBytes > maxBytes, sizeBytes };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function parseMetaArg(raw: unknown): { summary: string | null; requestFeedback: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { summary: null, requestFeedback: false };
  const m = raw as Rec;
  const summary = typeof m.Summary === "string" && m.Summary.trim()
    ? m.Summary.trim()
    : typeof m.summary === "string" && m.summary.trim()
      ? m.summary.trim()
      : null;
  const requestFeedback = m.RequestFeedback === true || m.requestFeedback === true;
  return { summary, requestFeedback };
}

function parseTs(r: Rec): number | null {
  const t = typeof r.created_at === "string" ? Date.parse(r.created_at) : NaN;
  return Number.isFinite(t) ? t : null;
}

const STATUS_ORDER: Record<ArtifactReviewStatus, number> = { pending: 0, rejected: 1, approved: 2 };

export class AgyArtifactTracker {
  readonly brainDir: string;
  private entries = new Map<string, ArtifactEntry>();
  private seenSteps = new Set<number>();

  constructor(dataDir: string, conversationId: string) {
    this.brainDir = artifactBrainDir(dataDir, conversationId);
  }

  /** Fold one parsed record from `transcript.jsonl` (idempotent per `step_index`). */
  feed(raw: unknown): boolean {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const r = raw as Rec;
    const step = typeof r.step_index === "number" ? r.step_index : null;
    if (step !== null) {
      if (this.seenSteps.has(step)) return false;
      this.seenSteps.add(step);
    }
    const ts = parseTs(r) ?? Date.now();
    let changed = false;

    if (r.type === "PLANNER_RESPONSE" && Array.isArray(r.tool_calls)) {
      for (const tc of r.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const toolName = typeof tc.name === "string" ? tc.name : "";
        if (!EDIT_TOOLS.has(toolName)) continue;
        const args = decodeToolArgs(tc.args);
        const rawPath = typeof args.Path === "string"
          ? args.Path
          : typeof args.TargetFile === "string"
            ? args.TargetFile
            : typeof args.path === "string"
              ? args.path
              : "";
        if (!rawPath) continue;
        const resolved = resolveArtifactPath(this.brainDir, rawPath);
        if (!resolved) continue;
        const meta = parseMetaArg(args.ArtifactMetadata ?? args.artifactMetadata);
        const prev = this.entries.get(resolved.name);
        const next: ArtifactEntry = {
          name: resolved.name,
          path: resolved.path,
          summary: meta.summary ?? prev?.summary ?? null,
          status: "pending",
          requestFeedback: meta.requestFeedback || prev?.requestFeedback || false,
          updatedAt: ts,
          sizeBytes: prev?.sizeBytes ?? null,
        };
        this.entries.set(resolved.name, next);
        changed = true;
      }
      return changed;
    }

    if (r.type === "USER_INPUT" && typeof r.content === "string") {
      const text = extractUserText(r.content);
      if (!text) return false;
      for (const line of text.split(/\r?\n/)) {
        const dec = parseArtifactDecisionLine(line);
        if (!dec) continue;
        if (this.applyDecision(dec.name, dec.status, ts)) changed = true;
      }
      return changed;
    }

    return false;
  }

  /** Apply an `[Approved]` / `[Rejected]` decision to a tracked (or on-disk) artifact. */
  applyDecision(nameOrBase: string, status: "approved" | "rejected", at = Date.now()): boolean {
    const clean = nameOrBase.trim().replace(/^`+|`+$/g, "").trim();
    if (!clean) return false;
    let target = this.entries.get(clean);
    if (!target) {
      const matches = [...this.entries.values()].filter((e) => basename(e.name) === clean || e.name.toLowerCase() === clean.toLowerCase());
      if (matches.length === 1) target = matches[0];
    }
    if (!target) {
      const resolved = resolveArtifactPath(this.brainDir, clean);
      if (resolved && existsSync(resolved.path)) {
        const meta = readArtifactMetadata(resolved.path);
        target = {
          name: resolved.name,
          path: resolved.path,
          summary: meta.summary,
          status,
          updatedAt: meta.updatedAt ?? at,
        };
        this.entries.set(resolved.name, target);
        return true;
      }
      return false;
    }
    if (target.status === status) return false;
    this.entries.set(target.name, { ...target, status });
    return true;
  }

  /**
   * Hydrate tracked entries with on-disk size/mtime/`.metadata.json`, and discover any
   * disk artifacts not yet seen in `transcript.jsonl`.
   *
   * `expectedPendingCount`: when Antigravity's screen/OSC reports pending artifact review
   * (e.g. `Approve plan` or `2 artifacts · /artifact to review`) and transcript replay didn't
   * record that many pending entries (e.g. mid-session attach or truncated JSONL), the newest
   * untracked markdown artifacts on disk are surfaced as `pending`.
   */
  scanDisk(expectedPendingCount = 0): boolean {
    if (!existsSync(this.brainDir)) return false;
    let changed = false;

    const diskFiles: Array<{ name: string; path: string; mtimeMs: number; sizeBytes: number; isText: boolean }> = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_SCAN_DEPTH) return;
      let items;
      try {
        items = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        if (it.name.startsWith(".") || SKIP_DIRS.has(it.name) || it.name.endsWith(".metadata.json")) continue;
        const abs = join(dir, it.name);
        if (it.isDirectory()) {
          walk(abs, depth + 1);
          continue;
        }
        if (!it.isFile()) continue;
        const resolved = resolveArtifactPath(this.brainDir, abs);
        if (!resolved) continue;
        try {
          const st = statSync(abs);
          const ext = extname(it.name).toLowerCase();
          diskFiles.push({
            name: resolved.name,
            path: resolved.path,
            mtimeMs: st.mtimeMs,
            sizeBytes: st.size,
            isText: TEXT_EXTS.has(ext) || ext === "",
          });
        } catch {}
      }
    };
    walk(this.brainDir, 0);

    // Hydrate already-tracked entries with disk stats & sibling .metadata.json.
    for (const f of diskFiles) {
      const existing = this.entries.get(f.name);
      if (existing) {
        const meta = readArtifactMetadata(f.path);
        const summary = existing.summary ?? meta.summary;
        const updatedAt = Math.max(existing.updatedAt ?? 0, meta.updatedAt ?? 0, Math.round(f.mtimeMs)) || null;
        if (summary !== existing.summary || updatedAt !== existing.updatedAt || f.sizeBytes !== existing.sizeBytes) {
          this.entries.set(f.name, { ...existing, summary, updatedAt, sizeBytes: f.sizeBytes });
          changed = true;
        }
      }
    }

    // Discover untracked text artifacts on disk (newest first).
    const untracked = diskFiles
      .filter((f) => f.isText && !this.entries.has(f.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const currentPending = [...this.entries.values()].filter((e) => e.status === "pending").length;
    let needPending = Math.max(0, expectedPendingCount - currentPending);

    for (const f of untracked) {
      const meta = readArtifactMetadata(f.path);
      const status: ArtifactReviewStatus = needPending > 0 ? "pending" : "approved";
      if (needPending > 0) needPending--;
      this.entries.set(f.name, {
        name: f.name,
        path: f.path,
        summary: meta.summary,
        status,
        updatedAt: meta.updatedAt ?? Math.round(f.mtimeMs),
        sizeBytes: f.sizeBytes,
      });
      changed = true;
    }

    return changed;
  }

  /** All tracked artifacts sorted pending-first, newest-first (metadata only, without file body). */
  summaryList(): ArtifactEntry[] {
    return [...this.entries.values()]
      .filter((e) => existsSync(e.path) || e.status === "pending")
      .sort((a, b) => {
        const ds = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
        if (ds !== 0) return ds;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      })
      .map(({ content: _drop, truncated: _dropT, ...meta }) => meta);
  }

  /** Pending artifacts with bounded Markdown bodies attached (for the active review dialog). */
  pendingWithContent(maxArtifacts = 8, maxBytesPerFile = ARTIFACT_MAX_READ_BYTES): ArtifactEntry[] {
    const pending = this.summaryList().filter((e) => e.status === "pending").slice(0, maxArtifacts);
    return pending.map((entry) => {
      const body = readBoundedFile(entry.path, maxBytesPerFile);
      return body
        ? { ...entry, content: body.content, truncated: body.truncated, sizeBytes: body.sizeBytes }
        : { ...entry, content: "", truncated: false };
    });
  }

  /** Read one artifact (pending or already reviewed) safely inside `brainDir`. */
  readArtifact(name: string, maxBytes = ARTIFACT_MAX_READ_BYTES): ArtifactEntry | null {
    const resolved = resolveArtifactPath(this.brainDir, name);
    if (!resolved) return null;
    const existing = this.entries.get(resolved.name);
    const body = readBoundedFile(resolved.path, maxBytes);
    if (!body && !existing) return null;
    const meta = readArtifactMetadata(resolved.path);
    return {
      name: resolved.name,
      path: resolved.path,
      summary: existing?.summary ?? meta.summary,
      status: existing?.status ?? "approved",
      ...(existing?.requestFeedback ? { requestFeedback: true } : {}),
      updatedAt: existing?.updatedAt ?? meta.updatedAt,
      content: body?.content ?? "",
      truncated: body?.truncated ?? false,
      sizeBytes: body?.sizeBytes ?? existing?.sizeBytes ?? null,
    };
  }

  /** Stable cache/dismiss key representing the current pending artifact set and revisions. */
  pendingKey(): string | null {
    const pending = this.summaryList().filter((e) => e.status === "pending");
    if (!pending.length) return null;
    return pending.map((e) => `${e.name}@${e.updatedAt ?? 0}:${e.sizeBytes ?? 0}`).join("|");
  }
}

/** Validate and normalize an incoming `artifact_review` / `dialog_answer` payload. */
export function parseArtifactReviewRequest(raw: unknown): ArtifactReviewRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("artifact review needs an action");
  }
  const r = raw as Rec;
  const action = String(r.action ?? r.artifactAction ?? "").trim();
  if (action !== "approve" && action !== "approve_all" && action !== "reject" && action !== "comment" && action !== "dismiss") {
    throw new Error(`Unknown artifact review action "${action}"`);
  }
  const artifact = typeof r.artifact === "string" && r.artifact.trim() ? r.artifact.trim() : undefined;
  const message = typeof r.message === "string" && r.message.trim() ? r.message.trim() : undefined;
  if (action === "comment" && !message) {
    throw new Error("Add a comment before sending");
  }
  return { action, ...(artifact ? { artifact } : {}), ...(message ? { message } : {}) };
}

/**
 * Format the user message sent into Antigravity CLI so `artifactreview.(*State).fold`
 * parses `[Approved] <name>` / `[Rejected] <name>` on line 1+ and passes any user
 * comments/revision instructions verbatim right underneath.
 */
export function formatArtifactReviewSubmission(req: ArtifactReviewRequest, pendingNames: string[], fallbackName?: string | null): string {
  const note = req.message?.trim() ?? "";
  if (req.action === "approve_all") {
    const targets = pendingNames.length ? pendingNames : [req.artifact ?? fallbackName ?? ""].filter(Boolean);
    if (!targets.length) throw new Error("No pending artifacts to approve");
    const head = targets.map((n) => `[Approved] ${n}`).join("\n");
    return note ? `${head}\n\n${note}` : head;
  }
  const target = req.artifact || pendingNames[0] || fallbackName || "";
  if (!target) throw new Error("No artifact selected for review");
  if (req.action === "approve") {
    return note ? `[Approved] ${target}\n\n${note}` : `[Approved] ${target}`;
  }
  if (req.action === "reject") {
    return note ? `[Rejected] ${target}\n\n${note}` : `[Rejected] ${target}`;
  }
  if (req.action === "comment") {
    if (!note) throw new Error("Add a comment before sending");
    return `Comments on ${target}:\n\n${note}`;
  }
  return "";
}
