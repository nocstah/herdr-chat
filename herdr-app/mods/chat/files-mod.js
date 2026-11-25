// Pure helpers for opening a file or folder in Herdr's files viewer mod (`my-files`
// or `better-files`) when one is active in the layout (no toolkit imports:
// tests/host/files-open.test.ts runs it in Node).

const FILES_MODS = ["my-files", "better-files"];
const OPENING_MS = 1500;

/** Finds the active files viewer mod in Herdr's layout tree, preferring `my-files` over `better-files`. */
export function findFilesMod(root) {
  const found = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const mod = node.content?.mod;
    if (typeof mod === "string" && FILES_MODS.includes(mod)) found.add(mod);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
    if (Array.isArray(node.floating)) for (const f of node.floating) walk(f);
  };
  walk(root);
  for (const name of FILES_MODS) if (found.has(name)) return name;
  return null;
}

/** Finds whether the active layout has a `files` side-panel block (any files mod). */
export function hasFilesPanel(root) {
  let has = false;
  const walk = (node) => {
    if (has || !node || typeof node !== "object") return;
    if (node.id === "files" && node.content?.mod) { has = true; return; }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c);
  };
  walk(root);
  return has;
}

export const baseName = (path) => String(path ?? "").split("/").pop() || String(path ?? "");

export const parentOf = (path) => {
  const s = String(path ?? "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : "/";
};

/** Computes the viewer's `root`: `cwd` when `path` is inside it, else `path`'s parent directory. */
export function rootFor(path, cwd) {
  const clean = String(path ?? "").replace(/\/+$/, "") || "/";
  const normCwd = cwd ? (String(cwd).replace(/\/+$/, "") || "/") : null;
  if (normCwd && (clean === normCwd || clean.startsWith(normCwd === "/" ? "/" : `${normCwd}/`))) {
    return normCwd;
  }
  return parentOf(clean);
}

/**
 * Opens `path` in `modName` (`my-files` or `better-files`) using Herdr's shared
 * viewer registry and tab commands — works even while the Files sidebar is hidden.
 * Returns `{ how: modName, action, ... }` on success, or `null` if no target space exists.
 */
export function openInFilesMod(modName, o, api) {
  const spaceList = api.spaces() ?? [];
  const targetSpace = o.space || spaceList.find((s) => s.active)?.id || null;
  if (!targetSpace) return null;

  const machine = o.machine ?? null;
  const file = { path: o.path, root: rootFor(o.path, o.cwd), on: machine };
  const name = baseName(o.path);
  const viewersKey = `${modName}.viewers`;
  const rawEntries = api.shared(viewersKey);
  const entries = rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries) ? rawEntries : {};
  const allPanes = api.panes() ?? [];
  const tabSpaces = new Map(spaceList.flatMap((s) => (s.tabs ?? []).map((t) => [t.id, s.id])));
  const now = api.now ? api.now() : Date.now();
  const nonce = api.nonce ? api.nonce() : Math.random().toString(36).slice(2, 8);

  const liveViewers = Object.entries(entries).filter(([, entry]) => {
    if (!entry || entry.space !== targetSpace) return false;
    const live = entry.tab
      ? allPanes.some((p) => p.tab === entry.tab && p.mod === modName)
      : now - (entry.at ?? 0) < OPENING_MS;
    if (!live) return false;
    return !entry.tab || (tabSpaces.get(entry.tab) ?? entry.space) === entry.space;
  });

  const jumpLine = typeof o.line === "number" && Number.isFinite(o.line) && o.line > 0 ? Math.floor(o.line) : 0;
  const jumpAnchor = !jumpLine && o.anchor ? String(o.anchor) : null;
  if (modName === "my-files" && (jumpLine > 0 || jumpAnchor)) {
    api.setShared("my-files.jump", {
      id: `j${now.toString(36)}${nonce.slice(0, 4)}`,
      at: now,
      path: o.path,
      on: machine,
      line: jumpLine,
      ...(jumpAnchor ? { anchor: jumpAnchor } : {}),
      whole: false,
    });
  }

  const existing = liveViewers.find(
    ([, entry]) => entry.file?.path === o.path && (entry.file?.on ?? null) === machine,
  );
  if (existing) {
    const [id, entry] = existing;
    if (jumpAnchor && entry.markdown === "code") {
      api.setShared(viewersKey, { ...entries, [id]: { ...entry, markdown: "preview" } });
    }
    if (entry.tab) api.run("tab.select", { id: entry.tab });
    return { how: modName, action: "select", tab: entry.tab ?? null };
  }

  const preview = liveViewers.find(([, entry]) => entry.preview);
  if (preview) {
    const [id, entry] = preview;
    const updated = { ...entry, file };
    delete updated.markdown;
    api.setShared(viewersKey, { ...entries, [id]: updated });
    if (entry.tab) {
      api.run("tab.rename", { id: entry.tab, name });
      api.run("tab.select", { id: entry.tab });
    }
    return { how: modName, action: "reuse", tab: entry.tab ?? null };
  }

  const id = `v${now.toString(36)}${nonce}`;
  const others = allPanes.filter((p) => p.mod === modName).map((p) => p.tab);
  api.setShared(viewersKey, {
    ...entries,
    [id]: { space: targetSpace, file, preview: true, tab: null, others, at: now },
  });
  api.run("tab.new", {
    space: targetSpace,
    name,
    mod: modName,
    props: { mode: "viewer", viewer: id, space: targetSpace, file },
  });
  return { how: modName, action: "new", viewer: id };
}

/**
 * Reveals a folder inside Herdr's Files side panel when it lies within `cwd`.
 * Returns `{ how: modName | "files" }` if shown, or `null` if outside `cwd` or no panel exists.
 */
export function revealFolderInFilesPanel(o, api) {
  const root = api.layout();
  if (!hasFilesPanel(root)) return null;
  const clean = String(o.path ?? "").replace(/\/+$/, "") || "/";
  const normCwd = o.cwd ? (String(o.cwd).replace(/\/+$/, "") || "/") : null;
  const inCwd = normCwd && (clean === normCwd || clean.startsWith(normCwd === "/" ? "/" : `${normCwd}/`));
  if (!inCwd) return null;
  const modName = findFilesMod(root);
  if (modName === "my-files") {
    const now = api.now ? api.now() : Date.now();
    api.setShared("my-files.reveal", { at: now, path: clean, on: o.machine ?? null });
  }
  api.run("layout.select", { stack: "panel-body", child: "files" });
  api.run("layout.show", { id: "panel" });
  return { how: modName ?? "files" };
}
