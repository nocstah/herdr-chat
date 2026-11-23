// A message's images for a TUI the chat can only type into (the terminal views of
// Codex, Antigravity and Claude Code):
// - `[Image available at: <path>]` (what this host writes when typing images into a TUI);
// - `@<path>` / `@"<path>"` mentions of existing local raster images (e.g. phone uploads
//   from OmaRelay/Ovis into `<cwd>/.ovis/paste-….jpg` or paths pasted into the terminal).
// The chat loads those files (checked by size and magic bytes) so the timeline renders
// actual thumbnails from its own image store.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { ImageBlock } from "./types.ts";

/** How long a sent image's file is kept: the agent reads it as the message lands; the chat shows it again from it. */
export const SENT_KEEP_MS = 7 * 24 * 3600_000;
const MAX_LOCAL_IMAGE_BYTES = 20 * 1024 * 1024;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MARKER = /\n*\[Image available at: (\/[^\]\n]*?\.(?:png|jpe?g|gif|webp))\]/gi;
// `@"/abs/path with spaces.png"`, unquoted `.ovis` upload paths (whose workspace folder may hold spaces),
// or unquoted absolute paths without spaces. Always preceded by start-of-line or horizontal whitespace so
// email addresses and mid-word `@` never match.
const MENTION = /(^|[ \t])@(?:"(\/[^"\r\n]+?\.(?:png|jpe?g|gif|webp))"|(\/(?:(?!\s(?:@\S|\/|~\/))[^\r\n\t]){0,1024}?\/\.ovis\/[^\s\/]*-\d{8}-\d{6}-[0-9a-f]{8}\.(?:png|jpe?g|gif|webp))|(\/\S+\.(?:png|jpe?g|gif|webp)))(?=[ \t]|$)/gi;

function sniffMime(b: Buffer): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

/** Reads an existing local raster image file (checked by regular-file stat, size cap and magic bytes), or null. */
export function readLocalImage(path: string): ImageBlock | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_LOCAL_IMAGE_BYTES) return null;
    const bytes = readFileSync(path);
    const mimeType = sniffMime(bytes);
    if (!mimeType) return null;
    return { data: bytes.toString("base64"), mimeType };
  } catch {
    return null;
  }
}

/** The images, each saved in `dir` (herdr-chat-<16 hex>.<ext>, private), and their paths. */
export function saveImages(dir: string, images: ImageBlock[]): string[] {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return images.map((img) => {
    const p = join(dir, `herdr-chat-${randomBytes(8).toString("hex")}.${EXT[img.mimeType] ?? "png"}`);
    writeFileSync(p, Buffer.from(img.data, "base64"), { mode: 0o600 });
    return p;
  });
}

/** Saved images older than SENT_KEEP_MS go. */
export function pruneImages(dir: string): void {
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (/^herdr-chat-[0-9a-f]{16}\./.test(f) && Date.now() - statSync(p).mtimeMs > SENT_KEEP_MS) rmSync(p, { force: true });
    }
  } catch {}
}

/** A message's words and its images' lines, as typed into the TUI. */
export function withImageLines(text: string, files: string[]): string {
  const lines = files.map((p) => `[Image available at: ${p}]`).join("\n");
  return text.trim() ? `${text}\n\n${lines}` : lines;
}

/**
 * Extracts images referenced via `[Image available at: <path>]` or `@<path>` / `@"<path>"`
 * mentions (only files that currently exist and sniff as valid raster images).
 * Standalone/edge mentions are removed from the displayed text; inline mid-sentence mentions
 * keep the sentence readable while still showing the images underneath. Missing files stay
 * as text so no message ever vanishes.
 */
export function imageLines(text: string): { text: string; images: ImageBlock[] } {
  const images: ImageBlock[] = [];
  const afterMarkers = text.replace(MARKER, (whole, p: string) => {
    const block = readLocalImage(p);
    if (!block) return whole;
    images.push(block);
    return "";
  });

  const lines = afterMarkers.split("\n");
  const outLines: string[] = [];
  let strippedMentionLine = false;

  for (const line of lines) {
    type Hit = { start: number; end: number; block: ImageBlock; strip: boolean };
    const hits: Hit[] = [];
    MENTION.lastIndex = 0;
    for (let m = MENTION.exec(line); m; m = MENTION.exec(line)) {
      const p = (m[2] ?? m[3] ?? m[4])!;
      const block = readLocalImage(p);
      if (!block) continue;
      hits.push({ start: m.index + m[1]!.length, end: m.index + m[0].length, block, strip: false });
    }
    if (!hits.length) {
      outLines.push(line);
      continue;
    }
    for (const h of hits) images.push(h.block);

    // Mark leading and trailing runs of image mentions on this line as strippable.
    let prevEnd = 0;
    for (const h of hits) {
      if (line.slice(prevEnd, h.start).trim() !== "") break;
      h.strip = true;
      prevEnd = h.end;
    }
    let nextStart = line.length;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i]!;
      if (line.slice(h.end, nextStart).trim() !== "") break;
      h.strip = true;
      nextStart = h.start;
    }
    // If any mention sits mid-sentence (neither leading nor trailing), keep the line verbatim
    // so prose like "Compare @/a.png with @/b.png" stays intact while both thumbnails still show.
    if (hits.some((h) => !h.strip)) {
      outLines.push(line);
      continue;
    }

    let rebuilt = "";
    let cursor = 0;
    for (const h of hits) {
      rebuilt += line.slice(cursor, h.start);
      cursor = h.end;
    }
    rebuilt += line.slice(cursor);
    const cleaned = rebuilt.trim();
    if (cleaned) outLines.push(cleaned);
    else strippedMentionLine = true;
  }

  if (!images.length) return { text, images: [] };
  let rest = outLines.join("\n");
  if (strippedMentionLine) rest = rest.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
  return { text: rest.replace(/\s+$/, ""), images };
}
