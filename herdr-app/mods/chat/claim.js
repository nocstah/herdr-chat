// The composer claims the keyboard, as in Claude's app: a character typed or a paste anywhere in the chat goes into
// the composer (main.js typeAnywhere, pasteAnywhere), and the pointer coming back to rest over the chat after a click on
// the sidebar or a panel gives the chat the keyboard (hoverClaim), so typing goes there.

/** How long the pointer rests over the chat before the composer takes the keyboard: a pass over it takes nothing. */
export const HOVER_CLAIM_MS = 250;

/** The text a keystroke types into the composer from elsewhere in the chat, else null: a printable character, with
 *  Shift at most (a Ctrl, Alt, Super or Fn chord stays a shortcut; Enter, Tab, Esc and Backspace type nothing here).
 *  @param {{ key_char?: string, modifiers?: { control?: boolean, alt?: boolean, platform?: boolean, function?: boolean } } | null | undefined} e */
export function typedChar(e) {
  const m = e?.modifiers ?? {};
  if (m.control || m.alt || m.platform || m.function) return null;
  const ch = e?.key_char;
  if (typeof ch !== "string" || ch === "") return null;
  for (const c of ch) {
    const n = c.codePointAt(0) ?? 0;
    if (n < 32 || n === 127) return null;
  }
  return ch;
}

/** Whether the pointer over the chat may give its composer the keyboard: only after a press outside the chat (one
 *  inside keeps the keys where it put them, as a text view a selection was made in), not while the composer has them
 *  or something else in the chat has them (a question card, a picker, a dialog, find), and only while Herdr's focus is
 *  on this chat's pane in its tab, so a terminal clicked in a split keeps its keys.
 *  @param {{ composerFocused: boolean, busy: boolean, keysElsewhere: boolean, focused: { pane: string | null, tab: string } | null, pane: string | null, tab: string | null }} s */
export function mayClaim(s) {
  if (!s.keysElsewhere || s.composerFocused || s.busy || !s.focused || !s.pane) return false;
  return s.focused.pane === s.pane && (!s.tab || s.focused.tab === s.tab);
}
