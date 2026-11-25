// Starting folder for a new chat tab (main.js openChat): when the focused pane is a
// mod pane (e.g. a Chat view hiding its terminal, or a file viewer), `focused().cwd`
// is null. Resolve the attached terminal's live cwd, else another terminal in the
// same tab, else the space's first terminal, else the space's saved folder.
// No imports, so tests load it directly (tests/host/new-chat-cwd.test.ts).

/**
 * @param {{ focused: any, spaces: any[], panes: any[], terminals: any[], chatPanes?: Record<string, string> | null }} state
 * @returns {string | null}
 */
export function cwdFor({ focused, spaces, panes, terminals, chatPanes }) {
  if (focused?.cwd) return focused.cwd;
  const listPanes = Array.isArray(panes) ? panes : [];
  const listTerms = Array.isArray(terminals) ? terminals : [];
  const termCwd = (addr) => {
    if (!addr) return null;
    const p = listPanes.find((x) => x?.terminal === addr && x?.cwd);
    if (p?.cwd) return p.cwd;
    const t = listTerms.find((x) => x?.address === addr);
    return t?.foreground?.cwd || t?.cwd || null;
  };
  if (focused?.pane && chatPanes && typeof chatPanes === "object") {
    const attached = termCwd(chatPanes[focused.pane]);
    if (attached) return attached;
  }
  if (focused?.tab) {
    const sameTab = listPanes.find((x) => x?.tab === focused.tab && x?.cwd);
    if (sameTab?.cwd) return sameTab.cwd;
  }
  const listSpaces = Array.isArray(spaces) ? spaces : [];
  const space = listSpaces.find((s) => s?.id === focused?.space) ?? listSpaces.find((s) => s?.active) ?? null;
  if (space) {
    const tabIds = new Set((space.tabs ?? []).map((t) => t?.id).filter(Boolean));
    const firstInSpace = listPanes.find((x) => tabIds.has(x?.tab) && x?.cwd);
    if (firstInSpace?.cwd) return firstInSpace.cwd;
    if (space.folder) return space.folder;
  }
  return null;
}
