// Claude Code mods drawn in the chat (protocol.md "v3.10: mod UI").
//
// A Claude Code mod draws by answering `ui.render` for a site: a pane, the band above
// the prompt. Claude Code hands the drawing to whatever surface asks for it as a
// plain-data tree (Box, Text, Button…). The Claude adapter asks for it
// (providers/claude/modui.ts); this module readies the trees for the wire, as
// render.ts readies items: code highlighted into spans, SVG written to a file the
// app can show, everything bounded.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { highlight, langForPath, resolveLang } from "./highlight.ts";
import type { Span } from "./ansi.ts";

/** One element of a mod's drawing, as Claude Code validated it. `press` names its handler. */
export type ModNode = {
  type: string;
  props?: Record<string, unknown>;
  children?: (ModNode | string)[];
  press?: { plugin: string; handle: number };
  /** Code: the source as highlighted lines (added by the host). */
  lines?: Span[][];
  /** Svg: the file the source was written to (added by the host; the source is dropped). */
  path?: string;
  /** Svg: the markup's own size (its width/height attributes) and shape (w/h, from them or its viewBox). */
  size?: { w?: number; h?: number; ratio?: number };
  [k: string]: unknown;
};
export type ModTree = ModNode | string;

/** A pane a mod opened, as Claude Code's roster gives it. */
export type ModPane = {
  id: string;
  title: string;
  plugin: string;
  /** Esc closes it (`$.ui.open({ closeOnEscape })`). */
  closeOnEscape?: true;
  /** The size it asked for: rows inline, columns docked. */
  rows?: number;
  columns?: number;
  /** What to paint under its body: a theme key or a color. */
  background?: string;
};

export type ModUi = {
  /** The band above the composer (every mod's `AbovePrompt` row, stacked); null: none. */
  band: ModTree | null;
  /** Open panes, in open order. The chat draws one container: tabs when several. */
  panes: ModPane[];
  /** The pane shown; null with none open. */
  shown: string | null;
  /** The pane that holds the keyboard; null: the composer does. */
  focused: string | null;
  /** Each pane's body by id, as last drawn. A pane not drawn yet has none. */
  bodies: Record<string, ModTree | null>;
};

/** A drawing bigger than this (JSON) is replaced by a line saying so. */
export const MAX_TREE_BYTES = 1 << 20;
const MAX_NODES = 5000;
const MAX_DEPTH = 64;
const CODE_CACHE = 200;

export type PrepareOptions = { svgDir: string | null; log?: (msg: string) => void };

const codeCache = new Map<string, { lines: Span[][] }>();

function codeLines(source: string, language: unknown, path: unknown): Span[][] {
  const lang = typeof language === "string" ? resolveLang(language) : typeof path === "string" ? langForPath(path) : null;
  const key = `${lang ?? ""}\0${source}`;
  const hit = codeCache.get(key);
  if (hit) return hit.lines;
  const { lines } = highlight(source, lang, !lang);
  codeCache.set(key, { lines });
  if (codeCache.size > CODE_CACHE) codeCache.delete(codeCache.keys().next().value!);
  return lines;
}

function svgFile(source: string, dir: string | null): string | null {
  if (!dir) return null;
  const file = join(dir, `mod-${createHash("sha1").update(source).digest("hex").slice(0, 16)}.svg`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, source);
  }
  return file;
}

/** An SVG's own width, height and shape, from its root element's attributes. */
export function svgSize(source: string): { w?: number; h?: number; ratio?: number } {
  const root = /<svg\b[^>]*>/i.exec(source.slice(0, 4000))?.[0] ?? "";
  const num = (name: string): number | undefined => {
    const m = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`, "i").exec(root);
    const v = m ? Number(m[1]) : NaN;
    return v > 0 ? v : undefined;
  };
  const vb = /\sviewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(root);
  const w = num("width"), h = num("height");
  const ratio = w && h ? w / h : vb && Number(vb[1]) > 0 && Number(vb[2]) > 0 ? Number(vb[1]) / Number(vb[2]) : undefined;
  return { ...(w ? { w } : {}), ...(h ? { h } : {}), ...(ratio ? { ratio } : {}) };
}

const tooLarge = (what: string): ModNode => ({ type: "Text", props: { dimColor: true }, children: [`(${what})`] });

/** A tree made ready for the wire: Code highlighted, Svg written out, bounded. Never throws. */
export function prepareTree(tree: unknown, opts: PrepareOptions): ModTree | null {
  if (tree == null) return null;
  let nodes = 0;
  const walk = (n: unknown, depth: number): ModTree | null => {
    if (typeof n === "string") return n;
    if (!n || typeof n !== "object" || Array.isArray(n)) return null;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return null;
    const node = n as ModNode;
    if (typeof node.type !== "string") return null;
    // Claude Code's own drawing of a site ("draw yours here"): nothing of a mod's to show.
    if (node.type === "engine") return null;
    const out: ModNode = { type: node.type };
    if (node.props && typeof node.props === "object") out.props = node.props;
    if (node.press && typeof node.press === "object") out.press = node.press;
    if (Array.isArray(node.children)) {
      const kids: ModTree[] = [];
      for (const c of node.children) {
        const k = walk(c, depth + 1);
        if (k !== null) kids.push(k);
      }
      out.children = kids;
    }
    try {
      if (node.type === "Code" && typeof out.props?.source === "string") {
        out.lines = codeLines(out.props.source, out.props.language, out.props.path);
      } else if (node.type === "Svg" && typeof out.props?.source === "string") {
        const path = svgFile(out.props.source, opts.svgDir);
        out.size = svgSize(out.props.source);
        const { source: _drop, ...rest } = out.props;
        out.props = rest;
        if (path) out.path = path;
      } else if (node.type === "Shader") {
        // A backdrop's GPU program: the chat can't run one, so its picture (the one Svg child) stands in.
        const svg = out.children?.find((c): c is ModNode => typeof c !== "string" && c.type === "Svg");
        return svg ?? null;
      }
    } catch (e) {
      opts.log?.(`mod ui: ${node.type}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return out;
  };
  const out = walk(tree, 0);
  if (nodes > MAX_NODES) return tooLarge(`this drawing has more than ${MAX_NODES} elements`);
  if (out && JSON.stringify(out).length > MAX_TREE_BYTES) return tooLarge("this drawing is too large to show");
  return out;
}

/** The whole mod UI readied for the wire. */
export function prepareModUi(ui: ModUi | null, opts: PrepareOptions): ModUi | null {
  if (!ui) return null;
  const bodies: Record<string, ModTree | null> = {};
  for (const [id, t] of Object.entries(ui.bodies)) bodies[id] = prepareTree(t, opts);
  return { ...ui, band: prepareTree(ui.band, opts), bodies };
}
