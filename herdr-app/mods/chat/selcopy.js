// Copying text selected in the chat: an answer's, a message's, a tool card's (rich.js and cards.js text views).
// Herdr's text views copy their selection on Ctrl+C only (the window's own copy, which runs before a mod's Ctrl+C and
// passes the key on when nothing is selected), and a mod can neither read that selection nor ask for that copy.
// Super+C sends a terminal app Ctrl+Shift+C (desktop terminal-clipboard bindings, for a window like Herdr's that holds
// terminals), which reached only the chat's inputs. So on Linux, a copy key the chat can't serve from an input of its
// own asks Hyprland to send the window Ctrl+C with explicit modifiers, as Omarchy's universal copy does (never a
// virtual keyboard: a held Super would join it), and reads the clipboard after to say what was copied. A right-click
// on a message looks the same way, to offer Copy for what is selected, then puts the clipboard's text back. With
// nothing selected, that Ctrl+C goes on to the chat's Stop, which swallowsStop keeps from stopping the agent.

/** How long after the chat asked for it a Ctrl+C reaching Stop is that one, not the person's. */
export const HANDOFF_MS = 1200;
/** How long after the Ctrl+C was sent the clipboard is read: Herdr has copied by then. */
export const SETTLE_MS = 200;

/** @param {"down" | "up"} state */
const key = (state) => `hl.dsp.send_key_state({ mods = "CTRL", key = "C", state = "${state}" })`;

/** Sends the focused window Ctrl+C through Hyprland: down, then up 50 ms later, as Omarchy's universal copy does. */
export function ctrlCCommand() {
  return { program: "/bin/sh", args: ["-c", 'hyprctl dispatch "$1" >/dev/null && sleep 0.05 && hyprctl dispatch "$2" >/dev/null', "sh", key("down"), key("up")] };
}

/** What a hand-off copied: the clipboard's text after it, when that changed; null for nothing new (nothing selected).
 *  @param {string | null | undefined} before @param {string | null | undefined} after */
export function copiedText(before, after) {
  return typeof after === "string" && after !== "" && after !== before ? after : null;
}

/** Whether a Ctrl+C reaching Stop at `now` is the hand-off's (`until`: when its window ends).
 *  @param {number | null | undefined} until @param {number} now */
export const swallowsStop = (until, now) => typeof until === "number" && now < until;

/** A message's right-click menu: Copy for the selection the look found (its start in the label), then Copy message.
 *  @param {string | null} selection @param {string | null | undefined} message */
export function messageMenuItems(selection, message) {
  /** @type {{ id: string, label: string, text: string }[]} */
  const items = [];
  if (selection) {
    const flat = selection.replace(/\s+/g, " ").trim();
    items.push({ id: "copy", label: `Copy “${flat.length > 28 ? flat.slice(0, 27) + "…" : flat}”`, text: selection });
  }
  if (message) items.push({ id: "copy-message", label: "Copy message", text: message });
  return items;
}
