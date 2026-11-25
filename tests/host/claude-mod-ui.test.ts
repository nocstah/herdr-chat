// Claude Code mods drawn in the chat (protocol.md v3.10): the host joins the session as a
// surface, draws a mod's band and pane, and passes on what the person does with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { idle } from "./harness.ts";
import { startClaude } from "../fake-claude/host.ts";

/** Every node of a drawing, depth first. */
function nodes(tree: any): any[] {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...(tree.children ?? []).flatMap(nodes)];
}
const texts = (tree: any) => nodes(tree).flatMap((n) => (n.type === "Text" ? n.children.filter((c: any) => typeof c === "string") : []));
const find = (tree: any, type: string) => nodes(tree).find((n) => n.type === type);

test("claude mod ui: the band, a pane, a press, a field, a pick and a close reach the mod", async () => {
  const h = await startClaude({ name: "claude-mod-ui", speed: 4, scenario: { mods: true, turns: [] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    // The chat joined as a VS Code surface, and the mod's status line (sent before initialize answered) shows.
    const attach = h.controls("ui_attach")[0]?.request;
    assert.equal(attach?.surface, "vscode");
    assert.equal(attach?.client_id, "herdr-chat");
    await c.waitFor((x) => x.state.statuses.some((s: any) => s.key === "mod:probe"), 5000, "the mod's status line");
    await c.waitFor((x) => x.state.capabilities.extensionUi === true, 5000, "statuses are shown once mods can draw");

    // The band, then the pane the mod opened by itself, with its code highlighted and its SVG on disk.
    await c.waitFor((x) => texts(x.state.modUi?.band).includes("count 0"), 5000, "the band");
    await c.waitFor((x) => x.state.modUi?.bodies?.probe, 5000, "the pane's body");
    const ui = c.state.modUi;
    assert.deepEqual(ui.panes, [{ id: "probe", title: "Probe", plugin: "probe", closeOnEscape: true }]);
    assert.equal(ui.shown, "probe");
    const code = find(ui.bodies.probe, "Code");
    assert.ok(code.lines?.length >= 1, "Code arrives as highlighted lines");
    assert.ok(code.lines[0].some((s: any) => s.fg?.startsWith("syn:")), "with syntax colors");
    const svg = find(ui.bodies.probe, "Svg");
    assert.equal(svg.props.source, undefined, "the SVG's markup stays off the wire");
    assert.ok(svg.path && existsSync(svg.path), "it is a file the app can show");
    assert.deepEqual(svg.size, { w: 48, h: 48, ratio: 1 }, "with the markup's own size");

    // A press: the band redraws with the new count. The old handle is then stale.
    const button = find(c.state.modUi.band, "Button");
    assert.deepEqual(await c.req("mod_ui", { action: "press", ...button.press, key: "inc" }), { handled: true });
    await c.waitFor((x) => texts(x.state.modUi?.band).includes("count 1"), 5000, "the band after a press");
    assert.deepEqual(await c.req("mod_ui", { action: "press", ...button.press, key: "inc" }), { handled: false });
    const press = h.controls("ui_press")[0].request;
    assert.equal(press.surface, "vscode", "a press names the surface its drawing came from");

    // A field's Enter (the mod toasts it) and a pick (the pane redraws with it).
    const input = find(c.state.modUi.bodies.probe, "Input");
    await c.req("mod_ui", { action: "input", ...input.press, key: "name", kind: "submit", value: "Ada", component: "Pane", instance: "probe" });
    await c.waitFor((x) => x.toasts.some((t: any) => t.text === "probe: hi Ada"), 5000, "the mod's toast");
    const select = find(c.state.modUi.bodies.probe, "Select");
    await c.req("mod_ui", { action: "select", ...select.press, key: "pick", value: "b" });
    await c.waitFor((x) => find(x.state.modUi?.bodies?.probe, "Select")?.props.value === "b", 5000, "the pick");

    // The person closes the pane: gone from the roster and the bodies; the band stays.
    assert.deepEqual(await c.req("mod_ui", { action: "close", pane: "probe" }), { closed: true });
    await c.waitFor((x) => x.state.modUi?.panes.length === 0, 5000, "the pane closed");
    assert.deepEqual(c.state.modUi.bodies, {});
    assert.ok(texts(c.state.modUi.band).includes("count 1"));
    h.artifact("claude-mod-ui");
  } finally {
    await h.stop();
  }
});

test("claude mod ui: a Claude Code without the surface messages, and HERDR_CHAT_MOD_UI=0, leave the chat as it was", async () => {
  // The default fake answers ui_attach with "Unsupported", as a CLI from before mods does.
  const old = await startClaude({ name: "claude-mod-ui-old", speed: 4, scenario: { turns: [] } });
  try {
    await old.client.waitFor(idle, 10_000);
    await old.client.waitFor(() => old.controls("ui_attach").length === 1, 5000, "one attach, refused");
    assert.equal(old.client.state.modUi, null);
    assert.equal(old.client.state.capabilities.extensionUi, false);
    await assert.rejects(old.client.req("mod_ui", { action: "press", plugin: "probe", handle: 1 }), /mods aren't drawn/);
  } finally {
    await old.stop();
  }
  const off = await startClaude({ name: "claude-mod-ui-off", speed: 4, scenario: { mods: true, turns: [] }, env: { HERDR_CHAT_MOD_UI: "0" } });
  try {
    await off.client.waitFor(idle, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(off.controls("ui_attach").length, 0, "never attached");
    assert.equal(off.client.state.modUi, null);
  } finally {
    await off.stop();
  }
});
