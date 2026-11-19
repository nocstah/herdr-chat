// Where a chat lives, for certain. `props()` names no pane and `panes()`
// lists mod panes without their props, so `focused()` was the only clue,
// and a chat that started while another tab had focus took that tab (two
// hosts in one tab, a Pi tab with Claude's icon). The core's layout
// document ("herdr-app", the one the app saves) has every mod pane with its
// props: the pane whose props name this chat is this chat's.

import { machines } from "herdr";
import { getDoc } from "./hostpane.js";
import { qualify } from "./machines.js";

// The app's layout document, or null (no hc, no core). `machine`: another machine's.
export async function readDoc(machine = null) {
  return (await getDoc(machine)).value;
}

// Every mod pane of `mod`: [{pane, tab, space, props}]. `machine`: the document is that
// machine's, and its ids come back as the app names them ("box/p1").
export function modPanes(doc, mod, machine = null) {
  const out = [];
  const q = (id) => qualify(machine, id);
  const walk = (space, tab, n) => {
    const c = n?.content;
    if (c?.mod === mod) out.push({ pane: q(n.id), tab: q(tab), space: q(space), props: c.props ?? {} });
    for (const ch of n?.children ?? []) walk(space, tab, ch);
  };
  for (const s of doc?.spaces ?? []) for (const t of s.tabs ?? []) walk(s.id, t.id, t.root);
  return out;
}

// The other machines whose spaces the app shows now (their layout documents are ready).
export function otherMachines() {
  try {
    return machines().filter((m) => m.name && m.layout === "ready").map((m) => m.name);
  } catch {
    return [];
  }
}

// Every mod pane of `mod` in this computer's document and the shown machines' ({…, machine}).
// A machine that doesn't answer is left out.
export async function allModPanes(mod) {
  const out = modPanes(await readDoc(), mod).map((x) => ({ ...x, machine: null }));
  for (const machine of otherMachines()) {
    try {
      out.push(...modPanes(await readDoc(machine), mod, machine).map((x) => ({ ...x, machine })));
    } catch {}
  }
  return out;
}
