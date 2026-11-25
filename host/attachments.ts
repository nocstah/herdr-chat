// The composer's attachments (protocol.md "Attachments"): a pasted or dropped image
// (or an uploaded file copied from another machine) is a file of the chat's own, so
// the chat can show it before it's sent and keep it alive for queued messages. They
// live with the chat, not one host.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { clipboardImage, readImage } from "./clipboard.ts";
import { imageSize, type ImageFile } from "./imagesize.ts";

// A copy's name is `<ms>-<hex>-<name>`: room for the prefix under the usual 255-byte limit.
const MAX_NAME_BYTES = 200;
/** Size cap for non-image files copied into the chat's attachments folder (e.g. uploaded from another machine). */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
/** Size cap for pasted text uploaded over the host RPC channel (kept under the 8 MiB framing limit). */
export const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export type AttachedFile = { path: string; name: string; sizeBytes: number; isDir?: boolean };

function shortened(name: string): string {
  const ext = extname(name);
  let stem = [...name.slice(0, name.length - ext.length)];
  while (stem.length && Buffer.byteLength(stem.join("") + ext) > MAX_NAME_BYTES) stem.pop();
  return stem.join("") + ext;
}

export class Attachments {
  readonly dir: string;
  private closed = new Set<string>();

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  private newPath(name: string): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return join(this.dir, `${Date.now()}-${randomBytes(3).toString("hex")}-${shortened(name)}`);
  }

  /** The clipboard's image; null when it holds none. */
  async fromClipboard(): Promise<ImageFile | null> {
    const path = await clipboardImage(this.newPath("paste.png"));
    return path ? { path, size: imageSize(readFileSync(path)) } : null;
  }

  /** A copy of an image file. Throws with a user-facing message. */
  fromFile(path: string): ImageFile {
    const { bytes } = readImage(path);
    const out = this.newPath(basename(path));
    writeFileSync(out, bytes, { mode: 0o600 });
    return { path: out, size: imageSize(bytes) };
  }

  /**
   * Validates any file (or local folder) to attach to a message. With `copy: true`
   * (used for files transferred from another machine), copies the file into this chat's
   * attachments folder so it outlives the transfer temp file and cleans up on detach/close.
   * Throws with a user-facing message.
   */
  attachFile(path: string, { copy = false }: { copy?: boolean } = {}): AttachedFile {
    if (!path) throw new Error("No file path given");
    if (/^[a-z]+:\/\//i.test(path)) throw new Error("File URLs aren't supported: save the file and attach it");
    let st;
    try {
      st = statSync(path);
    } catch {
      throw new Error(`Could not read file: ${path}`);
    }
    const name = basename(path) || path;
    if (!copy) {
      if (!st.isFile() && !st.isDirectory()) throw new Error(`Not a file or folder: ${path}`);
      return { path: resolve(path), name, sizeBytes: st.isFile() ? st.size : 0, ...(st.isDirectory() ? { isDir: true } : {}) };
    }
    if (st.isDirectory()) throw new Error("Folders can't be uploaded to another machine: pick files inside it");
    if (!st.isFile()) throw new Error(`Not a regular file: ${path}`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`File is larger than ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MiB: ${name}`);
    const out = this.newPath(name);
    copyFileSync(path, out);
    try {
      chmodSync(out, 0o600);
    } catch {}
    return { path: out, name, sizeBytes: st.size };
  }

  /**
   * Saves pasted text verbatim as a UTF-8 `.txt` file inside this chat's
   * attachments folder (`0o600`), so huge pastes or pastes with terminal control
   * characters can be attached via `@path` across local and remote hosts.
   */
  fromText(text: string, name = "pasted-text.txt"): AttachedFile {
    if (typeof text !== "string" || !text.length) throw new Error("No pasted text given");
    const rawName = String(name || "pasted-text.txt").replace(/\\/g, "/");
    const cleaned = basename(rawName)
      .replace(/[\x00-\x1f\x7f]/g, "")
      .replace(/^\.+/, "")
      .trim();
    const base = cleaned || "pasted-text.txt";
    const fileName = /\.[A-Za-z0-9]{1,10}$/.test(base) ? base : `${base}.txt`;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > MAX_TEXT_BYTES) {
      throw new Error(`Pasted text is larger than ${Math.round(MAX_TEXT_BYTES / (1024 * 1024))} MiB`);
    }
    const out = this.newPath(fileName);
    writeFileSync(out, bytes, { mode: 0o600 });
    return { path: out, name: fileName, sizeBytes: bytes.length };
  }

  /** Removes one. Any other path (the person's own file) is left alone. */
  remove(path: string): void {
    if (dirname(resolve(path)) === this.dir) rmSync(path, { force: true });
  }

  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  /**
   * Removes the folders of other chats that are closed: no pane (not in `open`, from the app's layout)
   * and no live host, in two sweeps in a row, since a layout read mid-change may miss a pane.
   */
  sweepClosed(open: Set<string>, live: (chat: string) => boolean): string[] {
    const root = dirname(this.dir);
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const closed = names.filter((c) => c !== basename(this.dir) && !open.has(c) && !live(c));
    const removed = closed.filter((c) => this.closed.has(c));
    for (const c of removed) rmSync(join(root, c), { recursive: true, force: true });
    this.closed = new Set(closed.filter((c) => !removed.includes(c)));
    return removed;
  }
}
