// A message's images for a TUI the chat can only type into (the terminal view of Codex:
// providers/codex/terminal.ts): each saved as a file of its own, named in the message as
// `[Image available at: <path>]` (the words the host writes for an agent that takes no
// images, chat.ts send), which Codex opens with its image viewer. The chat shows those
// files as the message's images again, from the echo and from history, while they're there.
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { imageFile } from "./claude/sessions.ts";
import type { ImageBlock } from "./types.ts";

/** How long a sent image's file is kept: the agent reads it as the message lands; the chat shows it again from it. */
export const SENT_KEEP_MS = 7 * 24 * 3600_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MARKER = /\n*\[Image available at: (\/[^\]\n]*?\.(?:png|jpe?g|gif|webp))\]/gi;

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

/** A message's text without its images' lines, and those files as image blocks (the ones still there). */
export function imageLines(text: string): { text: string; images: ImageBlock[] } {
  const files: string[] = [];
  const rest = text.replace(MARKER, (_m, p: string) => {
    files.push(p);
    return "";
  });
  if (!files.length) return { text, images: [] };
  return { text: rest.replace(/\s+$/, ""), images: files.map(imageFile).filter((b): b is ImageBlock => b !== null) };
}
