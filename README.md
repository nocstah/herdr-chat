# herdr-chat

[![CI](https://github.com/ChmaraX/herdr-chat/actions/workflows/ci.yml/badge.svg)](https://github.com/ChmaraX/herdr-chat/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/ChmaraX/herdr-chat)](https://github.com/ChmaraX/herdr-chat/releases/latest)
[![License](https://img.shields.io/github/license/ChmaraX/herdr-chat)](LICENSE)

<p align="center">
  <a href="#features">features</a> · <a href="#install">install</a> · <a href="#quick-start">quick start</a> · <a href="#keys">keys</a> · <a href="#configuration">configuration</a> · <a href="#limitations">limitations</a> · <a href="CHANGELOG.md">changelog</a>
</p>

A native chat for **Pi, Claude Code and Codex** in the
[Herdr](https://herdr.dev) desktop app, in place of their terminal UIs. Each
agent is the CLI you already use, with your login, settings, extensions,
skills and sessions. The chat only draws it.

https://github.com/user-attachments/assets/cefe4c53-19f6-4c3b-8188-f8480f4c2816

> **Pairs well with**
> - [herdr-gitview](https://github.com/ChmaraX/herdr-gitview): review, stage, and commit agent changes
> - [herdr-nvim](https://github.com/ChmaraX/herdr-nvim): a persistent nvim sidebar, one key away

## Features

- **One chat for three agents** - the same timeline, keys and pickers for Pi,
  Claude Code and Codex. Each control shows only where the agent supports it.
- **Readable answers** - streaming markdown, highlighted code, Mermaid
  diagrams you can zoom, and tool cards with diffs and exit codes.
- **Approvals** - allow once, always, or deny with a reason, by key.
- **Steer or queue** - while the agent works, Enter steers it and ⌥Enter
  queues a follow-up. Queued messages can be edited, moved or removed.
- **Pickers** - model, thinking effort and permission mode, from the chips
  under the composer or by key.
- **The branch** - under the composer, a click copies it. It follows
  switches made anywhere, the agent's own included.
- **Slash commands and skills** - your commands, prompt templates and
  skills, plus the built-ins (`/model`, `/compact`, `/resume`, `/fork`,
  `/tui`…). A skill becomes a pill in your message.
- **The agent's own screens** - `/login`, `/settings` and the commands that
  only exist in the agent's terminal UI open in a dialog over the chat.
  `/tui` continues the session there.
- **`/fork`** - a new session up to any earlier message, with that message
  back in the composer.
- **Continue as chat** - right-click a running Pi, Claude Code or Codex
  terminal → **Continue as chat**: the chat takes over its session.
- **Sub-agent chats** - your agents start their helpers as chats. Click a
  helper's row in the agents list to read along or type to it.
- **A normal Herdr agent** - each chat has a status in the agents list and
  tab bar, `hc send` reaches it and `hc read` prints its transcript.

## Requirements

- The **Herdr desktop app** (0.1.12 or later), and herdr-core (`hc`) on
  `PATH`.
- **Node 20** or later.
- At least one agent on `PATH`, signed in: `pi` (1.5 or later), `claude` or
  `codex`.
- macOS or Linux. On Linux, pasting an image needs `wl-paste`
  (wl-clipboard, Wayland) or `xclip` (X11), and large images are shrunk with
  ImageMagick when it's installed (else sent as they are).

## Install

With the Herdr app open:

```sh
curl -fsSL https://raw.githubusercontent.com/ChmaraX/herdr-chat/main/install.sh | sh -s -- --app
```

It downloads the release, checks it, adds its mods, binds ⌘I
(Ctrl+Alt+N on Linux) to the launcher and ⌘⇧J (Ctrl+Shift+J) to the chat view where they're free, and points the agents list and the right-click
menu at the chat. No clone, no npm install. Or ask the agent in your Herdr
window to "add the mod at github.com/ChmaraX/herdr-chat".

- **Update:** once a day the app looks for a new release and offers it
  (**Update** installs it), or run the same command again. Then it asks to
  restart the open chats on the new version: each keeps its conversation,
  and one that's working restarts when it's done. **Later** leaves a
  Restart button in each of them; `/reload` does the same.
- **Uninstall:** the same command with `--uninstall`. It puts back exactly
  what install changed.
- **Options:** `--no-subagents` (no sub-agent templates or notes),
  `--no-layout` (leave your layout alone). The full list of what install
  changes is in [herdr-app/RECIPE.md](herdr-app/RECIPE.md).

## Quick start

1. **Open a chat.** ⌘I, then **P**i, **C**laude Code or Code**X**. It opens
   in a new tab, in the focused terminal's folder.
2. **Talk to it.** Enter sends. `@` finds files; paste or drop an image to
   attach it. While it works, Enter steers and ⌥Enter queues; Esc stops.
3. **Pick a model or effort.** Click the chips under the composer, or
   `/model` and `/thinking`.
4. **Approve.** An approval card takes 1, 2 or 3: allow once, always, deny.
5. **Go further.** `/fork` from an earlier message, `/resume` another
   session, `/tui` for the agent's own terminal UI on the same session.

## Keys

| Key | Where | What |
|---|---|---|
| ⌘I | anywhere | The launcher (⌘J A when ⌘I is taken) |
| Enter / ⌥Enter | composer | Send; while the agent works, steer / queue a follow-up |
| Esc, ⌃C | chat | Stop the run (Esc also closes a menu or dialog) |
| 1–9, ↑↓, Space, Enter | an approval or question card | Answer it, with nothing typed |
| ⇧⌘M / ⇧⌘T / ⇧⌘A | chat | Model, effort, permission-mode picker |
| ⇧Tab | composer | Next permission mode (next thinking level for Pi) |
| ⌥⌘T | chat | `/tui` |
| ⇧⌘R | chat | Resume another session |
| ⇧⌘N | chat | A new chat with the same agent, same folder |

On Linux the chat's keys use Ctrl where macOS uses ⌘, on chords Herdr's own
Linux keys leave free: Ctrl+Shift+M / Ctrl+Shift+I / Ctrl+Shift+A for the
pickers, Ctrl+Alt+T for `/tui`, Ctrl+Shift+R to resume, Ctrl+Alt+N for a new
chat. Ctrl+C copies in the composer and stops the run elsewhere in the chat;
Esc stops it anywhere.

Change them, or bind a key per agent, in
`~/.config/herdr-app/data/herdr-chat/keys.json`:
[herdr-app/mods/chat/KEYS.md](herdr-app/mods/chat/KEYS.md).

## Configuration

The model, effort, permissions, MCP servers and the rest stay in each
agent's own settings: the chat runs the same CLI you use in a terminal.
What the chat itself takes goes in
`~/.config/herdr-app/data/herdr-chat/settings.json` (install never writes
it; every key is optional):

```json
{
  "env": { "KEY": "value" },
  "pi":     { "command": "/path/to/pi", "args": ["--model", "anthropic/claude-sonnet-4-5"] },
  "claude": { "env": { "CLAUDE_CONFIG_DIR": "/path/to/config" }, "face": "chat" },
  "codex":  { "tui": ["my-wrapper", "codex"] },
  "updates": { "check": false },
  "machines": { "box": { "direct": true } }
}
```

`env` is for every agent. Per agent: `command` (instead of the one install
found), `args` (added to the agent's), `env`, and `tui` (the program `/tui`
runs). A new chat picks up a change. `updates.check: false` stops the daily
look for a new release (a release install only); `updates.feed` points it at
another URL with GitHub's release JSON. `machines.<name>.direct: true` is for
a machine that shares this computer's loopback (a second herdr-core here):
its chats connect to the host's port as it is, with no ssh forward.

Claude Code opens in its chat view: a terminal of this computer where
Claude Code starts (a new tab, or `claude` typed in a shell) shows its chat
view at once, as ⌘⇧J (Ctrl+Shift+J) would flip it. `claude.face: "terminal"`
keeps it in the terminal (`"chat"`, or no `face`, is the chat view). Once per
start: flipping back to the terminal stays until Claude Code starts there
again, and terminals already running it when the app starts keep their face.
The `new-chat.first-face:chat` and `new-chat.first-face:terminal` commands
set it (a key, or another mod's settings).

### Spaces on another machine

A chat in a space of another machine (`hc machine add`) runs where that
space's terminals do: its host starts on that machine (`hc run --on`), from
herdr-chat installed there, so install it on both. The agent, its files, its
sessions and its hooks are that machine's, and so are its settings above.
This computer only draws the chat. It reaches the host through an ssh port
forward of its own (one ssh connection per machine, to the machine's `hc
machine` target, with your ssh keys and config). A machine added with
`--via` (reached through a command, not ssh) can have chats only when it is
`direct`.

Images and diagrams the host saves are copied here when the chat shows them
(up to 6 MB each). A pasted or dropped image goes there first (`hc put`,
up to 8 MB). Continue as chat and `/tui` work on that machine's agents as on
this computer's, except for sub-agents, which still open their TUI.

A Claude Code terminal there flips to its chat view too (⌘⇧J, or the top
bar's Chat/Terminal switch): the view's host runs on that machine and types
into the terminal there. Which face shows is the tab's, kept in that
machine's layout, so a flip shows on every window that shows the tab,
that machine's own included. Each window that shows a chat starts its host
when none answers; the first to start serves, and the others connect to it.

### Plan limits for other tools

Claude Code tells a chat its plan limits as it runs (it hands them to a status
line otherwise, and a chat has none). The last ones any chat heard are in
`~/.config/herdr-app/data/herdr-chat/limits/claude.json`, in the shape Claude
Code gives a status line, with the time they were seen:
`{"at": 1795000000, "five_hour": {"used_percentage": 25, "resets_at": …},
"seven_day": {…}}`. Nothing else goes there; a panel or a status bar can read
it.

## Limitations

- **Another machine's spaces need ssh** to that machine, and herdr-chat
  installed there (above). Its sub-agents can't continue as chats yet.
- **The end-to-end tests drive macOS only** (`tests/e2e/`); on Linux the
  host's tests run, and the mods were tried by hand.
- **Run the install again after a Herdr update.** The agents list and the
  right-click menu are copies of Herdr's, made at install time.
- **Continue as chat on Codex guesses the session** when Codex runs on its
  shared daemon (the default): the newest session in that folder. With
  `codex --no-daemon` it's exact.
- **Codex reports no cost**, so its meter shows tokens only.
- **Not in the command palette.** Use the keys.

## Development

```sh
git clone https://github.com/ChmaraX/herdr-chat
cd herdr-chat && npm ci            # Node 24: a checkout runs the TypeScript itself
./install.sh --app                 # installs this checkout into the running app
```

`npm test` runs the host's tests (fake agents; `LIVE=1` for the real ones),
`npm run e2e` drives a private Herdr app. How it's built:
[docs/dev/](docs/dev/), [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
