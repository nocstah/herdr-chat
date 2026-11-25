// Composer card click-to-focus regression tests: clicking any non-button area of the
// rounded composer card (bottom toolbar strip, chips strip background, card padding)
// focuses the textarea, while buttons and chips stop mouse-down propagation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

test("composer card focuses textarea on click anywhere outside buttons and chips", async () => {
  const gpuiKitSrc = `
    function makeNode(tag) {
      const node = {
        _tag: tag,
        _id: null,
        _cursor: null,
        _children: [],
        _mouseDown: new Map(),
        _clicks: [],
      };
      const proxy = new Proxy(node, {
        get(target, prop) {
          if (prop in target) return target[prop];
          if (prop === "id") return (v) => { target._id = v; return proxy; };
          if (prop === "cursor_text" || prop === "cursor_pointer") return () => { target._cursor = prop; return proxy; };
          if (prop === "on_mouse_down") return (btn, fn) => { target._mouseDown.set(btn, fn); return proxy; };
          if (prop === "on_click") return (fn) => { target._clicks.push(fn); return proxy; };
          if (prop === "child") return (ch) => { if (ch != null) target._children.push(ch); return proxy; };
          if (prop === "children") return (chs) => { if (Array.isArray(chs)) for (const ch of chs) if (ch != null) target._children.push(ch); return proxy; };
          if (prop === "when") return (cond, fn) => (cond ? fn(proxy) : proxy);
          if (prop === "hover") return (fn) => { fn(makeNode("hover")); return proxy; };
          return () => proxy;
        },
      });
      return proxy;
    }
    export const div = () => makeNode("div");
    export const image = () => makeNode("image");
    export const svg = () => makeNode("svg");
  `;

  const gpuiBaseSrc = `
    import { div } from "gpui-kit";
    export const v_flex = () => div();
    export const h_flex = () => div();
    export const TextareaState = {
      new(opts = {}) {
        const handlers = new Map();
        const state = {
          _value: opts.value ?? "",
          _focusCount: 0,
          _emit(ev, cx) { for (const fn of handlers.get(ev) ?? []) fn({}, cx); },
          value() { return state._value; },
          set_value(v) { state._value = typeof v === "string" ? v : v.text; },
          set_auto_grow() {},
          set_selected_range() {},
          selected_range() { return { start: 0, end: 0 }; },
          replace(t) { state._value += t; },
          focus() { state._focusCount++; },
          on(ev, fn) {
            if (!handlers.has(ev)) handlers.set(ev, []);
            handlers.get(ev).push(fn);
            return true;
          },
        };
        return state;
      },
    };
    export const Textarea = { new: () => div() };
    export const InputState = { new: () => ({ focus() {}, value() { return ""; }, set_value() {}, on() { return true; } }) };
    export const Input = { new: () => div() };
  `;

  const herdrSrc = `
    export const appHome = () => "/tmp/herdr-test-home";
    export const readTextFile = async () => "";
    export const settings = () => ({});
    export const platform = () => "linux";
  `;

  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "gpui-kit" || specifier === "gpui-base" || specifier === "herdr") {
        return { url: `composer-focus-mock:${specifier}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === "composer-focus-mock:gpui-kit") return { format: "module", source: gpuiKitSrc, shortCircuit: true };
      if (url === "composer-focus-mock:gpui-base") return { format: "module", source: gpuiBaseSrc, shortCircuit: true };
      if (url === "composer-focus-mock:herdr") return { format: "module", source: herdrSrc, shortCircuit: true };
      return nextLoad(url, context);
    },
  });

  const findPathById = (node: any, id: string, trail: any[] = []): any[] | null => {
    if (!node || typeof node !== "object") return null;
    const next = [...trail, node];
    if (node._id === id) return next;
    for (const ch of node._children ?? []) {
      const hit = findPathById(ch, id, next);
      if (hit) return hit;
    }
    return null;
  };

  /** Dispatches a GPUI bubble-phase left mouse_down from target up to root. */
  const bubbleLeftMouseDown = (root: any, targetId: string) => {
    const path = findPathById(root, targetId);
    assert.ok(path, `expected element #${targetId} to be rendered`);
    let stopped = false;
    let notified = 0;
    const cx = {
      stop_propagation() { stopped = true; },
      notify() { notified++; },
    };
    for (let i = path.length - 1; i >= 0; i--) {
      const handler = path[i]._mouseDown?.get("left");
      if (handler) handler({ button: "left", click_count: 1 }, cx);
      if (stopped) break;
    }
    return { stopped, notified, target: path[path.length - 1] };
  };

  try {
    const modUrl = new URL("../../herdr-app/mods/chat/composer.js", import.meta.url).href + `?t=${Date.now()}`;
    const { Composer }: any = await import(modUrl);
    // @ts-expect-error mocked via registerHooks
    const { div }: any = await import("gpui-kit");

    const theme = {
      background: "#111111",
      surface: "#181818",
      raised: "#222222",
      hover: "#2a2a2a",
      border: "#333333",
      input: "#444444",
      foreground: "#eeeeee",
      muted: "#aaaaaa",
      dim: "#777777",
      accent: "#5599ff",
      solid: "#ffffff",
      solid_foreground: "#000000",
      ansi1: "#ff5555",
    };

    const composer = new Composer({}, {
      onChange: () => {},
      onPasteOther: () => {},
      onPasteCollapse: () => {},
      onRemoveChip: () => {},
      skills: () => [],
    });
    composer.chips = [
      { kind: "paste", id: "p1", text: "line 1\nline 2", mode: "inline", lineCount: 2, charCount: 13 },
      { kind: "file", label: "notes.txt", path: "/tmp/notes.txt" },
    ];

    const render = () => composer.view(theme, {
      t: theme,
      working: false,
      plus: div().id("compose-plus"),
      mic: div().id("compose-mic"),
      hint: "Enter sends",
      action: () => {},
      previewPaste: () => {},
    });

    const tree = render();

    // Text cursor affordance on non-button surfaces.
    for (const id of ["composer-card", "composer-box", "composer-chips", "composer-bar", "composer-hint"]) {
      const path = findPathById(tree, id);
      assert.ok(path, `missing #${id}`);
      assert.equal(path[path.length - 1]._cursor, "cursor_text", `#${id} should show text cursor`);
    }

    // 1. Clicking the empty middle bottom bar focuses the textarea when unfocused.
    assert.equal(composer.ta._focusCount, 0);
    const barRes = bubbleLeftMouseDown(tree, "composer-hint");
    assert.equal(composer.ta._focusCount, 1);
    assert.equal(barRes.stopped, true);
    assert.equal(barRes.notified, 1);

    // 2. Clicking empty space in the chips strip focuses the textarea.
    const chipsRes = bubbleLeftMouseDown(tree, "composer-chips");
    assert.equal(composer.ta._focusCount, 2);
    assert.equal(chipsRes.stopped, true);

    // 3. Clicking the outer card while unfocused focuses the textarea.
    bubbleLeftMouseDown(tree, "composer-card");
    assert.equal(composer.ta._focusCount, 3);

    // 4. Once focused, clicking inside the textarea box does NOT trigger redundant focus/notify,
    //    while clicking the bottom bar still re-focuses (protecting against blur on mouse_down_out).
    composer.ta._emit("focus", { notify() {} });
    assert.equal(composer.focused, true);
    const treeFocused = render();
    const boxRes = bubbleLeftMouseDown(treeFocused, "composer-box");
    assert.equal(composer.ta._focusCount, 3);
    assert.equal(boxRes.notified, 0);

    bubbleLeftMouseDown(treeFocused, "composer-bar");
    assert.equal(composer.ta._focusCount, 4);

    // 5. Clicking buttons or chips stops propagation and never steals focus into the composer.
    composer.ta._emit("blur", { notify() {} });
    assert.equal(composer.focused, false);
    const treeBlurred = render();
    for (const controlId of ["compose-plus", "compose-mic", "send", "chip-0", "chip-x-0", "chip-1", "chip-x-1"]) {
      const res = bubbleLeftMouseDown(treeBlurred, controlId);
      assert.equal(res.stopped, true, `#${controlId} should stop mouse_down propagation`);
      assert.equal(composer.ta._focusCount, 4, `#${controlId} must not trigger card focus`);
    }
  } finally {
    hooks.deregister();
  }
});
