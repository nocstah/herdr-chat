# Chat shortcuts

The chat binds these keys in its own key context only: they work while the
chat pane has the keyboard, never in a terminal pane, and none of them is one
of Herdr's keys or a key in the shipped `keys.json`. The same actions work for
every agent. An action the agent can't do (permission modes for Pi, effort for
a model without levels) says so in the hint line under the composer.

The defaults below are macOS's (`keys.default.json`). On Linux they come from
`keys.default.linux.json`: Ctrl where macOS has ⌘, on chords Herdr's own Linux
keys leave free (`model` Ctrl+Shift+M, `effort` Ctrl+Shift+I, `mode`
Ctrl+Shift+A, `tui` Ctrl+Alt+T, `resume` Ctrl+Shift+R, `top` Ctrl+Home, `latest` Ctrl+End,
`find` Ctrl+F, `focusComposer` Ctrl+L, `newChat` Ctrl+Alt+N, `flip` Ctrl+Shift+J). There Ctrl+C is a text field's
copy, so `stop` on Ctrl+C works only outside the composer and the pickers'
fields; Esc stops the run anywhere.

| Action | Default | What it does |
|---|---|---|
| `steer` | ↩ (`enter`) | Sends the message. While the agent works, it **steers**: the message joins the blue "Steer: next turn" lane and reaches the agent at its next step. |
| `followUp` | ⌥↩ (`alt-enter`) | Sends the message. While the agent works, it **queues a follow-up**: the message waits in the yellow "Follow-up: after this run" lane and is sent when the run ends, one per run. |
| `model` | ⇧⌘M (`cmd-shift-m`) | Opens the model picker. Press it again to close the picker. |
| `effort` | ⇧⌘T (`cmd-shift-t`) | Opens the thinking-level (effort) picker. |
| `cycleEffort` | none | Switches to the next thinking level the model allows, wrapping around, and says it in the hint line ("Thinking: high"). It works only in the composer, and not while a menu is open. |
| `mode` | ⇧⌘A (`cmd-shift-a`) | Opens the permission-mode picker (Claude Code, Codex). |
| `cycleMode` | ⇧⇥ (`shift-tab`) | Switches to the next permission mode. For an agent with no permission modes (Pi), it switches to the next thinking level. It works only in the composer, and not while a menu is open. |
| `stop` | ⌃C (`ctrl-c`) | Stops the agent's run. Esc stops it too. |
| `tui` | ⌥⌘T (`cmd-alt-t`) | Continues the chat in the agent's own terminal UI (`/tui`). |
| `resume` | ⇧⌘R (`cmd-shift-r`) | Opens the sessions picker (`/resume`). |
| `pageUp` | ⇞ (`pageup`) | Scrolls the conversation up a page, also from the composer (not in a menu or picker). |
| `pageDown` | ⇟ (`pagedown`) | Scrolls the conversation down a page; at the end it follows new messages again. |
| `top` | none (Linux: Ctrl+Home) | Scrolls to the top of the conversation. Older messages load in front as it gets there; press it again to go further back. |
| `latest` | ⇧⌘B (`cmd-shift-b`) | Scrolls to the latest message. |
| `find` | ⌘F (`cmd-f`) | Opens find in the chat (Linux: Ctrl+F). It looks through the whole conversation, older messages too: your messages, the answers, notices and a tool's title. It starts at the latest match and marks its row; Enter or ↑ goes to the match before, Shift+Enter or ↓ to the one after, and Esc closes it. A match in folded work opens its group. On macOS ⌘F is also Herdr's terminal find, which a chat pane has no terminal for. |
| `focusComposer` | ⌘L (`cmd-l`) | Puts the keyboard back in the composer and closes an open picker. |
| `newChat` | ⇧⌘N (`cmd-shift-n`) | Opens a new chat tab with the same agent in the same folder. |
| `flip` | ⇧⌘J (`cmd-shift-j`) | In a terminal's chat view: shows the Claude Code, Codex or Antigravity terminal in its place (as Ovis's Mod+Shift+J). The same chord in that terminal, Herdr's global `flip` key, shows the chat again. |

`steer` and `followUp` work in the composer only. In a menu Enter picks, and
on an approval card with nothing typed it answers. Shift+Enter is always a new
line. If you unbind `steer` (or move it to another chord), Enter in the composer
types a new line.

## Cards

With nothing typed in the composer, a card the agent waits on takes the keys:

- An approval card: 1–9 pick a choice, Enter the allow choice, Esc denies.
- A question card: one option is highlighted, at first the one the agent
  recommends (else the first). ↑↓ move the highlight through every question's
  options and its Other field. Enter answers the question with the highlighted
  option and moves on to the next unanswered question; when none is left, it
  sends the answers. Space ticks options of a multi-select question (Enter
  takes the highlighted one only when none is ticked); on a single-select
  question it does nothing. 1–9 pick an option of the highlighted question.
  On an Other field, Enter puts the keyboard in it. There, Enter answers with
  what you typed, and Esc hands the keyboard back to the composer. On a
  single-select question an option and Other text exclude each other: the
  card shows what it sends. Esc in the composer cancels the card.

## The queue

The lanes above the composer hold what you sent while the agent works, oldest
first. On each row you can:
- click it: the text (and its images) goes back into the composer and leaves
  the queue. Sending puts it back: a follow-up back with the follow-ups, a
  steer as a steer;
- ⇄: a follow-up steers now; a steer waits for the run's end instead;
- ×: remove it.

Esc while the agent works stops it, and both lanes come back into the composer.

A steer that the agent already has can't always be taken back. Pi and Claude
Code let it go until the agent takes it. Codex has no way back, so its steer
rows have no ×, ⇄ or click. Follow-ups always do: the chat holds them, not
the agent.

The keys that open a chat (the launcher, ⌘I by default, and one per agent)
aren't chat keys: they are Herdr's global keys. Set them in the `"global"`
part of the same file, then run `./install.sh` again (it puts them in Herdr's
`keys.json`):

```json
{ "global": { "open": "cmd-i", "pi": "cmd-j p", "claude": null, "codex": null } }
```

`open` is the launcher (`mod.open:new-chat`), `pi`/`claude`/`codex` open that
agent's chat at once (`new-chat.pi`…), `flip` shows a Claude Code or Codex terminal's chat
view in its place, or the terminal again (`new-chat.flip`). Left out: the default
(⌘I for `open`, ⌘J A when ⌘I is taken; on Linux Ctrl+Alt+N, else Ctrl+Alt+Shift+P;
`flip` ⌘⇧J, on Linux Ctrl+Shift+J; the others unbound). A chord you choose replaces what
had it, and uninstall puts that back. In the launcher, P, C and X pick.

## The terminal view

A Claude Code, Codex or Antigravity terminal can show as a chat, in the same place, the way
Ovis flips between a pane's terminal and its chat. Ctrl+Shift+J (⌘⇧J) in the
terminal shows its chat view; the same key in the view, or its Chat | Terminal
switch, shows the terminal again. Nothing restarts: the agent you started stays
the one agent, and the view reads its conversation as it writes it and types
what you send into it. A slash command that opens a screen in the TUI
(`/resume`, `/config`, `/permissions`) shows the terminal for it, and the chat
comes back by itself once the TUI is at its prompt again (Esc there, or a
pick); a command that only prints something (`/status`) leaves you in the
terminal to read it. Codex's and Antigravity's model and effort chips (and `/model`) open the
chat's own pickers: Codex types `/model <model> --reasoning=<level>`, Antigravity types
`/model <id>` or `/effort <level>` (and cycles execution modes via `Shift+Tab`), and the
TUI's answer shows in the chat. Claude Code's `/model` still opens its picker in the terminal,
and comes back the same way. Its permission prompts and questions show as cards above
the composer; an answer is the keys you would press in the terminal.

Codex runs its conversations in a shared background server, so its terminal
doesn't say which conversation it shows: the view takes the one that server
loaded for it, in its folder, since it started (or the one `codex resume <id>`
named). With two Codex terminals in one folder it compares what each shows,
and until a message tells, it says it can't tell rather than guess. An image
sent from the view is saved as a file and named in the message, and Codex
opens it with its image viewer; the chat shows it as the message's image (for
a week, while the file is kept).

macOS turns ⌘. into Esc before an app sees it, so `stop` uses ⌃C.

## Your own keys

Put your overrides in `~/.config/herdr-app/data/herdr-chat/keys.json`. It uses the
same shape as `keys.default.json` in this folder:

```json
{
  "model": "cmd-shift-y",
  "stop": null,
  "latest": ["cmd-shift-b", "cmd-shift-down"]
}
```

- A string binds one chord. A list binds several.
- `null` unbinds the action.
- Actions you leave out keep their defaults.
- Chords use Herdr's spelling: `cmd`, `ctrl`, `alt`, `shift`, joined with `-`.
  A space separates the steps of a sequence.
- A chord you give one action leaves the action that has it by default. For
  example `{"cycleEffort": "shift-tab"}` takes Shift+Tab from `cycleMode`, so
  you don't have to unbind `cycleMode` too.
- If a chord is invalid, only its own action loses its binding. The chat's
  debug dump lists the error under `keyErrors`, along with a chord you bound
  to two actions.

Pi's TUI keys, for example:

```json
{
  "model": "ctrl-l",
  "cycleEffort": "shift-tab",
  "cycleMode": null
}
```

Nothing in the composer binds ⌃L, so `ctrl-l` reaches the chat's action.

The chat reads the file when it starts. After you edit it, restart the app.
A mod reload rebinds your keys too, but a key that you removed can stay bound
until the app restarts.

Tooltips (the model, effort and mode chips, the Stop button), picker titles and
the `/` menu (`/model`, `/thinking`, `/resume`, `/tui`) show the key that is
bound now.
