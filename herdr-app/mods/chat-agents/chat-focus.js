// Herdr marks an agent focused only while its own pane has the keyboard. A
// chat shows its agent from another pane: a chat's host runs hidden, and a
// terminal view's terminal hides behind its chat face. So the list marked no
// agent while you were in a chat. Each chat says which agent it shows, by its
// pane (shared "herdr-chat.panes", written by mods/chat/main.js): while that
// pane is focused, its agent counts as focused, as its terminal would.
//
// install/mods.ts points agents-base.js's `agents` import here.

import { agents as herdrAgents, focused, shared } from "herdr";

export const SHOWS = "herdr-chat.panes";

export function agents() {
  const list = herdrAgents();
  const f = focused();
  const map = /** @type {Record<string, string> | null} */ (shared(SHOWS));
  const via = f?.pane && !f.terminal ? map?.[f.pane] : null;
  if (!via || list.some((a) => a.focused)) return list;
  return list.map((a) => (a.address === via ? { ...a, focused: true } : a));
}
