// Claude Code mods in the chat: the chat joins the session as a remote surface, the
// way Claude Code Desktop and Claude Code for VS Code do, over the same stream-json
// control channel the adapter already drives (protocol.md "v3.10: mod UI").
//
//   ui_attach            the chat joins as a surface (answered: the surfaces drawn on)
//   ui_render            "draw this site": the band (AbovePrompt) or a pane's body (Pane)
//   ui_press/_input/_select   a person used a Button, Input or Select a mod drew
//   ui_close/_pane_show/_pane_focus   a person closed, picked or focused a pane
//   system ui_invalidate  pushed: drawings may be stale, ask again
//   system ui_panes       pushed: the pane roster changed
//   system ui_toast/_notify/_status/_log   pushed: what `$.ui.toast` & co. said
//
// Claude Code marks all of this `@internal`: it is how its own apps talk to it, not a
// published API, so it can change in any release. Checked against 2.1.332. A surface
// must name itself `desktop`, `mobile` or `vscode`; the chat says `vscode`, whose
// element table (no shaders, no surface modules) is the closest to what it draws.
// HERDR_CHAT_MOD_UI=0 keeps the chat from attaching.
import type { NormalizedEvent } from "../types.ts";
import type { ModPane, ModTree, ModUi } from "../../modui.ts";

type Rec = Record<string, any>;
type Control = (request: Record<string, unknown> & { subtype: string }, timeoutMs?: number) => Promise<any>;
export type Viewport = { columns: number; rows: number; isFullscreen: boolean };

export const SURFACE = "vscode";
export const CLIENT_ID = "herdr-chat";
const BAND = "above-prompt";
const PANE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function modUiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_CHAT_MOD_UI !== "0";
}

export class ClaudeModSurface {
  /** Joined as a surface: drawings are asked for. */
  attached = false;
  private gone = false;
  private control: Control;
  private emit: (ev: NormalizedEvent) => void;
  private log: (msg: string) => void;
  private panes: ModPane[] = [];
  private shown: string | null = null;
  private focused: string | null = null;
  private refused = new Set<string>();
  private band: ModTree | null = null;
  private bodies = new Map<string, ModTree | null>();
  /** Sites no mod draws now (`hooked: false`): not asked again until the next invalidate. */
  private unhooked = new Set<string>();
  private statusKeys = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private drawing = false;
  private again = false;
  private sent = "";
  private viewports: { band: Viewport; pane: Viewport } = {
    band: { columns: 80, rows: 6, isFullscreen: true },
    pane: { columns: 48, rows: 30, isFullscreen: true },
  };

  constructor(control: Control, emit: (ev: NormalizedEvent) => void, log: (msg: string) => void) {
    this.control = control;
    this.emit = emit;
    this.log = log;
  }

  /** Joins the session as a surface, reads the panes open now and draws. False: this Claude Code can't. */
  async attach(): Promise<boolean> {
    try {
      const r: Rec = await this.control({ subtype: "ui_attach", surface: SURFACE, client_id: CLIENT_ID, viewport: this.viewports.pane }, 15_000);
      if (Array.isArray(r.unhooked)) for (const c of r.unhooked) this.unhooked.add(String(c));
    } catch (e) {
      this.log(`mod ui: ui_attach: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    if (this.gone) return false;
    this.attached = true;
    this.emit({ type: "capabilities", capabilities: { extensionUi: true } });
    try {
      this.roster(await this.control({ subtype: "ui_panes", client_id: CLIENT_ID }, 15_000));
    } catch (e) {
      this.log(`mod ui: ui_panes: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.schedule();
    return true;
  }

  /** A `system` record of subtype `ui_*`. Everything of that family is ours, known or not. */
  onSystem(rec: Rec): void {
    const plugin = typeof rec.plugin === "string" ? rec.plugin : "";
    switch (rec.subtype) {
      case "ui_invalidate":
        // `instances` names the only stale ones; drawing every site again is the same, a few more asks.
        this.unhooked.clear();
        if (Array.isArray(rec.unhooked)) for (const c of rec.unhooked) this.unhooked.add(String(c));
        this.schedule();
        return;
      case "ui_panes":
        this.roster(rec);
        return;
      case "ui_toast":
        if (typeof rec.text === "string" && rec.text.trim()) this.emit({ type: "toast", level: "info", text: withPlugin(plugin, rec.text) });
        return;
      case "ui_notify": {
        const title = typeof rec.title === "string" ? rec.title : plugin;
        const body = typeof rec.body === "string" ? rec.body : typeof rec.text === "string" ? rec.text : "";
        if (title || body) this.emit({ type: "toast", level: "info", text: [title, body].filter(Boolean).join(": ") });
        return;
      }
      case "ui_status": {
        const key = `mod:${plugin || "mod"}`;
        const text = typeof rec.text === "string" && rec.text.trim() ? rec.text : null;
        if (text) this.statusKeys.add(key);
        else this.statusKeys.delete(key);
        this.emit({ type: "status", key, text });
        return;
      }
      case "ui_log":
        if (typeof rec.text === "string" && rec.text.trim()) this.emit({ type: "notice", level: "info", source: "notify", text: withPlugin(plugin, rec.text) });
        return;
      default:
        // ui_placed (rows in the transcript), ui_scroll, ui_focus, ui_notify_cancel: not drawn yet.
        return;
    }
  }

  /** What the person did, from the chat's `mod_ui` op. A pane is named `pane` (`id` is the request's own). */
  async act(action: string, a: Rec): Promise<unknown> {
    if (!this.attached) throw new Error("Claude Code's mods aren't drawn in this chat");
    const handle = Number(a.handle);
    const press = () => ({ plugin: String(a.plugin ?? ""), handle, ...(typeof a.key === "string" ? { key: a.key } : {}), surface: SURFACE, client_id: CLIENT_ID });
    switch (action) {
      case "press": {
        const r: Rec = await this.control({ subtype: "ui_press", ...press(), ...(typeof a.href === "string" ? { href: a.href } : {}) });
        // A handle the engine no longer holds: what the chat shows is stale.
        if (r.handled === false) this.schedule();
        return { handled: r.handled !== false };
      }
      case "input": {
        const kind = a.kind === "submit" ? "submit" : "change";
        const extra = typeof a.instance === "string" ? { component: a.component === "AbovePrompt" ? "AbovePrompt" : "Pane", instance_id: a.instance } : {};
        const r: Rec = await this.control({ subtype: "ui_input", ...press(), kind, value: String(a.value ?? ""), ...extra });
        if (r.handled === false) this.schedule();
        return { handled: r.handled !== false };
      }
      case "select": {
        const r: Rec = await this.control({ subtype: "ui_select", ...press(), value: String(a.value ?? "") });
        if (r.handled === false) this.schedule();
        return { handled: r.handled !== false };
      }
      case "close": {
        const id = paneId(a.pane);
        const r: Rec = await this.control({ subtype: "ui_close", id, client_id: CLIENT_ID });
        return { closed: r.closed === true };
      }
      case "show": {
        const id = paneId(a.pane);
        const r: Rec = await this.control({ subtype: "ui_pane_show", id, surface: SURFACE, client_id: CLIENT_ID });
        if ("shown_id" in r) this.shown = r.shown_id ?? null;
        this.publish();
        return { shown: this.shown };
      }
      case "focus": {
        const id = a.pane == null ? null : paneId(a.pane);
        const r: Rec = await this.control({ subtype: "ui_pane_focus", id, surface: SURFACE, client_id: CLIENT_ID });
        if ("focused_id" in r) this.focused = r.focused_id ?? null;
        this.publish();
        return { focused: this.focused };
      }
      case "viewport": {
        // The room the chat gives the band and the pane, in cells of the code font.
        let changed = false;
        for (const site of ["band", "pane"] as const) {
          const v = a[site];
          if (!v || typeof v !== "object") continue;
          const next: Viewport = {
            columns: clampInt(v.columns, 10, 400, this.viewports[site].columns),
            rows: clampInt(v.rows, 1, 400, this.viewports[site].rows),
            isFullscreen: typeof a.docked === "boolean" ? a.docked : this.viewports[site].isFullscreen,
          };
          if (JSON.stringify(next) !== JSON.stringify(this.viewports[site])) {
            this.viewports[site] = next;
            changed = true;
          }
        }
        if (changed) this.schedule();
        return {};
      }
    }
    throw new Error(`Unknown mod_ui action: ${action}`);
  }

  /** The process is gone: nothing a mod drew stays. */
  dispose(): void {
    this.gone = true;
    this.attached = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const key of this.statusKeys) this.emit({ type: "status", key, text: null });
    this.statusKeys.clear();
    if (this.sent) this.emit({ type: "mod_ui", ui: null });
    this.sent = "";
  }

  private roster(r: Rec): void {
    const list = Array.isArray(r.panes) ? r.panes : [];
    this.panes = list
      .filter((p: Rec) => p && typeof p.id === "string" && PANE_ID.test(p.id))
      .map((p: Rec): ModPane => ({
        id: p.id,
        title: typeof p.title === "string" && p.title ? p.title : p.id,
        plugin: typeof p.plugin === "string" ? p.plugin : "",
        ...(p.close_on_escape === true ? { closeOnEscape: true as const } : {}),
        ...(Number.isInteger(p.rows) ? { rows: p.rows } : {}),
        ...(Number.isInteger(p.columns) ? { columns: p.columns } : {}),
        ...(typeof p.background_color === "string" ? { background: p.background_color } : {}),
      }));
    const ids = new Set(this.panes.map((p) => p.id));
    this.shown = typeof r.shown_id === "string" && ids.has(r.shown_id) ? r.shown_id : this.panes.at(-1)?.id ?? null;
    this.focused = typeof r.focused_id === "string" && ids.has(r.focused_id) ? r.focused_id : null;
    for (const id of [...this.bodies.keys()]) if (!ids.has(id)) this.bodies.delete(id);
    // A mod asked for the keyboard (`$.ui.open({ focus: true })`). The composer keeps it: typing never
    // lands in a pane by surprise. A click on the pane gives it the pane.
    const want = typeof r.focus_requested_id === "string" ? r.focus_requested_id : null;
    if (want && !this.refused.has(want) && this.attached) {
      this.refused.add(want);
      this.control({ subtype: "ui_pane_focus", id: null, surface: SURFACE, client_id: CLIENT_ID }).catch(() => {});
    }
    this.publish();
    this.schedule();
  }

  private schedule(): void {
    if (!this.attached || this.gone || this.timer) return;
    // Bumps fold: Claude Code sends at most one per 100 ms per mod, often several at once.
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.draw();
    }, 16);
  }

  private async draw(): Promise<void> {
    if (this.drawing) {
      this.again = true;
      return;
    }
    this.drawing = true;
    try {
      do {
        this.again = false;
        const asks: Promise<void>[] = [];
        if (!this.unhooked.has("AbovePrompt")) asks.push(this.ask("AbovePrompt", BAND, {}, this.viewports.band).then((t) => { if (t !== undefined) this.band = t; }));
        else this.band = null;
        if (!this.unhooked.has("Pane")) {
          const placement = this.viewports.pane.isFullscreen ? "dock" : "inline";
          for (const p of this.panes) asks.push(this.ask("Pane", p.id, { placement }, this.viewports.pane).then((t) => { if (t !== undefined) this.bodies.set(p.id, t); }));
        }
        await Promise.all(asks);
        this.publish();
      } while (this.again && !this.gone);
    } finally {
      this.drawing = false;
    }
  }

  /** One site's drawing; undefined: the ask failed (keep what's shown). */
  private async ask(component: string, instance: string, props: Rec, viewport: Viewport): Promise<ModTree | null | undefined> {
    try {
      const r: Rec = await this.control({ subtype: "ui_render", surface: SURFACE, client_id: CLIENT_ID, component, instance_id: instance, props, viewport }, 15_000);
      if (r.hooked === false) this.unhooked.add(component);
      const tree = r.tree;
      if (!tree || typeof tree !== "object" || tree.type === "engine") return null;
      return tree as ModTree;
    } catch (e) {
      if (!this.gone) this.log(`mod ui: ui_render ${component} ${instance}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  }

  private publish(): void {
    if (this.gone) return;
    const bodies: Record<string, ModTree | null> = {};
    for (const p of this.panes) if (this.bodies.has(p.id)) bodies[p.id] = this.bodies.get(p.id) ?? null;
    const empty = !this.band && !this.panes.length;
    const ui: ModUi | null = empty ? null : { band: this.band, panes: this.panes, shown: this.shown, focused: this.focused, bodies };
    const key = JSON.stringify(ui);
    if (key === this.sent || (!this.sent && !ui)) return;
    this.sent = ui ? key : "";
    this.emit({ type: "mod_ui", ui });
  }
}

function withPlugin(plugin: string, text: string): string {
  return plugin ? `${plugin}: ${text}` : text;
}

function paneId(v: unknown): string {
  const id = String(v ?? "");
  if (!PANE_ID.test(id)) throw new Error(`not a pane id: ${id}`);
  return id;
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : dflt;
  return Math.max(lo, Math.min(hi, n));
}
