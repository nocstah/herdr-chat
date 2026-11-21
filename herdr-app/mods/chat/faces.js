// A Claude Code terminal's two faces, as in Ovis: the terminal itself and
// its chat view (the terminal view: a chat pane whose host reads the TUI's
// session and types into it, never runs it; host/providers/claude/terminal.ts).
// Both are panes of the terminal's tab, in the same place: the view sits
// right after the terminal in the tree, with its size, and one of the two is
// marked `hidden: true` in the core's layout document. Herdr doesn't draw a
// hidden pane and gives it no room (as with a chat's host pane, hostpane.js),
// and the hidden terminal keeps running at its size. So a flip swaps which
// face shows, in place, through splits and restarts. No command reaches a
// pane's `hidden`: the document is read, edited and written with the version
// read; a conflict reads again. The app takes the change in at its next read
// of the document (within half a second).
//
// The same file is in mods/chat and mods/new-chat (a mod can't import
// another's): keep the two equal (tests/host/faces.test.ts checks).

import { exec, panes, setShared, shared, spaces } from "herdr";
import { randomBytes } from "crypto";

export const VIEW_MOD = "chat";

const HELLO = '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}';
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// One request over `hc connect`: its result, or a thrown error (`kind` from the core's error data).
async function rpc(method, params) {
  const req = JSON.stringify({ jsonrpc: "2.0", id: 2, method, params });
  const r = await exec("/bin/sh", ["-c", `{ printf '%s\\n' ${q(HELLO)}; printf '%s\\n' ${q(req)}; } | hc connect`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc connect: exit ${r.code}`);
  const res = r.stdout.trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x?.id === 2);
  if (!res) throw new Error(`${method}: no answer`);
  if (res.error) throw Object.assign(new Error(res.error.message ?? `${method} failed`), { kind: res.error.data?.kind ?? null });
  return res.result;
}

function walk(n, f, parent = null) {
  if (!n) return;
  f(n, parent);
  for (const c of n.children ?? []) walk(c, f, n);
}

/**
 * A terminal's faces in the document: {space, tab, term, parent, view} (the
 * terminal's node, its parent, the view's node or null), or null when the
 * terminal has no pane. This computer's document only.
 */
export function facesOf(doc, terminal) {
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) {
    /** @type {any} */ let term = null;
    /** @type {any} */ let parent = null;
    /** @type {any} */ let view = null;
    walk(t.root, (n, p) => {
      if (!term && n.content?.terminal === terminal) { term = n; parent = p; }
      if (!view && n.content?.mod === VIEW_MOD && n.content?.props?.attach === terminal) view = n;
    });
    if (term) return { space: s.id, tab: t.id, term, parent, view };
  }
  return null;
}

/** Which face shows now: "chat" when the view is in the document and the terminal is hidden, else "terminal". */
export function faceOf(f) {
  return f?.view && f.term.hidden && !f.view.hidden ? "chat" : "terminal";
}

// The app writes the document after its own changes; ours waits until the
// app's latest is in it, or it would undo that change (hostpane.js inStep).
function inStep(doc) {
  const docTabs = new Set();
  const docPanes = new Set();
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) {
    docTabs.add(t.id);
    walk(t.root, (n) => { if (!n.children?.length) docPanes.add(n.id); });
  }
  const local = (id) => !String(id).includes("/");
  const appTabs = spaces().flatMap((s) => s.tabs.map((t) => t.id)).filter(local);
  const appPanes = panes().map((p) => p.pane).filter(local);
  return appTabs.length === docTabs.size && appTabs.every((t) => docTabs.has(t))
    && appPanes.length === docPanes.size && appPanes.every((p) => docPanes.has(p));
}

/** The face each terminal shows, as the last flip left it (shared by the mods: a hidden view never takes the keyboard). */
export const FACES = "herdr-chat.faces";

export function sharedFace(terminal) {
  return shared(FACES)?.[terminal] ?? null;
}

/**
 * Shows `face` ("chat" | "terminal" | "toggle": the other one) of `terminal`.
 * `props`: the chat view's, when it has none yet (it's added beside the
 * terminal, with its size). Resolves {face, pane (the view's), term (the
 * terminal's pane), tab, created}; throws why not. `cx`: the calling view's
 * context (its sleep, between tries).
 */
/** @param {any} cx @param {string} terminal @param {"chat" | "terminal" | "toggle"} face @param {object | null} [props] */
export async function flip(cx, terminal, face, props = null) {
  for (let i = 0; ; i++) {
    const { value, version } = await rpc("doc.get", { name: "herdr-app" });
    if (!value?.spaces) throw new Error("no layout document");
    if (!inStep(value) && i < 8) {
      await cx.sleep(150);
      continue;
    }
    const f = facesOf(value, terminal);
    if (!f) throw new Error(`terminal ${terminal} has no pane here`);
    /** @type {any} */ let view = f.view;
    let created = false;
    const want = face === "toggle" ? (faceOf(f) === "chat" ? "terminal" : "chat") : face;
    if (want === "chat") {
      if (!view) {
        if (!props) throw new Error("this terminal has no chat view yet");
        const sibs = f.parent?.children;
        if (!sibs) throw new Error("the terminal's pane has no place in its tab");
        view = { id: `p${randomBytes(16).toString("hex")}`, type: "block", content: { mod: VIEW_MOD, props }, ...(f.term.size ? { size: f.term.size } : {}) };
        sibs.splice(sibs.indexOf(f.term) + 1, 0, view);
        created = true;
      }
      delete view.hidden;
      f.term.hidden = true;
    } else {
      delete f.term.hidden;
      if (view) view.hidden = true;
    }
    try {
      await rpc("doc.set", { name: "herdr-app", value, version });
      setShared(FACES, { ...(shared(FACES) ?? {}), [terminal]: want });
      return { face: want, pane: view?.id ?? null, term: f.term.id, tab: f.tab, created };
    } catch (/** @type {any} */ e) {
      if (e?.kind !== "conflict" || i >= 10) throw e;
    }
  }
}

/** The terminal a chat view pane (by its pane id) is the face of, else null. */
export async function viewTerminal(pane) {
  const { value } = await rpc("doc.get", { name: "herdr-app" });
  /** @type {string | null} */ let out = null;
  for (const s of value?.spaces ?? []) for (const t of s.tabs ?? []) walk(t.root, (n) => {
    if (!out && n.id === pane && n.content?.mod === VIEW_MOD && typeof n.content?.props?.attach === "string") out = n.content.props.attach;
  });
  return out;
}

/** The chat view's props for a terminal: a new chat id, Claude Code, the terminal and its folder. */
export function viewProps(terminal, cwd) {
  return { chat: `tv-${randomBytes(6).toString("hex")}`, provider: "claude", attach: terminal, ...(cwd ? { cwd } : {}) };
}

/** Until `pane` is in the app (it takes a document change in at its next read): true, or false after `ms`. */
export async function appHas(cx, pane, ms = 2000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await cx.sleep(50)) if (panes().some((p) => p.pane === pane)) return true;
  return false;
}
