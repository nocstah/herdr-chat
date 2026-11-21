// The top bar's Chat | Terminal switch, as in Ovis's header: for the agent
// whose pane has the keyboard, a Claude Code or Codex terminal or its chat view (the
// terminal view, mods/chat/faces.js), the face that shows and the other one to
// flip to. The installer puts it at the right end of the layout's top bar, in
// a row with the tabs block (install/layout.ts); the chat view then leaves out
// its own pill. Herdr draws a terminal pane itself, so a mod can't put the
// switch on the pane: this is the nearest place that shows in both faces.
//
// Which agent a chat view shows: the chat's pane says (shared
// "herdr-chat.views", pane → terminal, written by mods/chat/main.js). A flip
// is new-chat's (`new-chat.flip:<terminal>`, its always-shown copy in the
// layout's floating list), with its errors.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, keys, run, shared, terminals, theme, window as appWindow } from "herdr";

const VIEWS = "herdr-chat.views";
// Herdr's names for the agents with a chat view → how the switch names them.
const AGENTS = { claude: "Claude Code", "claude-code": "Claude Code", codex: "Codex" };
const agentName = (t) => [t?.program?.key, t?.app, t?.status?.app, t?.report?.app, t?.agent].map((a) => AGENTS[a]).find(Boolean) ?? null;
const stop = (_e, cx) => cx.stop_propagation();

// Herdr's binding for the flip ("ctrl-shift-j"), as Herdr writes keys for people.
function flipKey() {
  const k = (keys() ?? []).find((b) => b.action === "new-chat.flip")?.keys;
  if (!k) return null;
  const mac = appWindow()?.platform === "macos";
  const GLYPH = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
  const WORD = { cmd: "Super", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  return k.split(" ").map((step) => {
    const parts = step.split("-");
    const key = parts.pop() ?? "";
    const name = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
    const mods = ["ctrl", "alt", "shift", "cmd"].filter((m) => parts.includes(m));
    return mac ? mods.map((m) => GLYPH[m]).join("") + name : [...mods.map((m) => WORD[m]), name].join("+");
  }).join(" ");
}

export default class ChatSwitch extends View {
  // The agent of the pane with the keyboard: {address, face, term}, or null (no switch).
  target() {
    const f = focused();
    if (!f?.pane) return null;
    // Another machine's ("cypherpunk/t5") too: its view flips in that machine's document (faces.js).
    const address = f.terminal ?? shared(VIEWS)?.[f.pane] ?? null;
    if (!address) return null;
    const term = terminals().find((x) => x.address === address);
    if (!term) return null;
    const name = agentName(term);
    if (f.terminal && (term.state !== "live" || !name)) return null;
    return { address, face: f.terminal ? "terminal" : "chat", term, name: name ?? "Claude Code" };
  }

  render() {
    const t = theme();
    const bar = h_flex().id("chat-switch").size_full().pl(2).pr(10).items_center().justify_start().bg(t.chrome).border_b(1).border_color(t.border);
    const it = this.target();
    if (!it) return bar;
    const live = it.term.state === "live";
    const st = live ? it.term.status ?? null : "ended";
    const word = st === "blocked" ? "needs you" : st === "ended" ? "ended" : "";
    const color = st === "blocked" ? t.blocked : st === "ended" ? t.dim : t[st] ?? t.dim;
    const said = { working: "working", blocked: "needs you", done: "finished", idle: "idle", ended: "terminal ended" }[st] ?? "";
    const flip = () => run(`new-chat.flip:${it.address}`);
    const seg = (id, label, on) => div().id(id).flex_none().px(10).py(2).rounded(5).text_size(11.5)
      .when(on, (e) => e.bg(t.background).text_color(t.foreground).font_semibold())
      .when(!on, (e) => e.text_color(t.muted).cursor_pointer().hover((x) => x.text_color(t.foreground)).on_mouse_down("left", stop).on_click(flip))
      .child(label);
    const key = flipKey();
    return bar.child(h_flex().id("switch-pill").flex_none().h(28).pl(10).pr(2).gap(8).items_center().rounded(8)
      .bg(t.surface).border_1().border_color(t.border).text_size(12).on_mouse_down("left", stop)
      .child(h_flex().id("switch-status").flex_none().gap(6).items_center().tooltip(`${it.name}${said ? ` · ${said}` : ""}`)
        .child(st === "working"
          ? svg("mods/chat/icons/spinner.svg").size(11).flex_none().text_color(color).spin(900)
          : div().w(10).flex_none().text_color(color).child(st === "idle" || !st ? "○" : st === "ended" ? "·" : "●"))
        .when(Boolean(word), (e) => e.child(div().text_color(color).child(word))))
      .child(h_flex().id("switch-faces").flex_none().p(2).gap(2).rounded(6).bg(t.hover).tooltip(key ? `Switch · ${key}` : "Switch")
        .child(seg("switch-chat", "Chat", it.face === "chat"))
        .child(seg("switch-terminal", "Terminal", it.face === "terminal"))));
  }
}
