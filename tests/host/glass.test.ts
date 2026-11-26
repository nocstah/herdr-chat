// Live glass config resolution (herdr-app/mods/chat/glass.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { DEFAULT_GLASS_FADE, DEFAULT_GLASS_TEXT, glassOverlay, glassTint, resolveChatGlass } from "../../herdr-app/mods/chat/glass.js";

test("glassTint: alpha of #rrggbbaa below ff, null for opaque or invalid colors", () => {
  assert.equal(glassTint("#1e1222"), null);
  assert.equal(glassTint("#1e1222ff"), null);
  assert.equal(glassTint("#1e1222FF"), null);
  assert.equal(glassTint(""), null);
  assert.ok(Math.abs((glassTint("#1e12224d") ?? 0) - 0x4d / 255) < 1e-6);
  assert.equal(glassTint("#1e122200"), 0);
});

test("glassOverlay: composites over window tint to land on target opacity", () => {
  const under = 0.3;
  assert.equal(glassOverlay("#1e1222", 0.3, under), "#00000000");
  assert.equal(glassOverlay("#1e1222", 0.2, under), "#00000000");
  assert.equal(glassOverlay("#1e1222", 1.0, under), "#1e1222");
  assert.equal(glassOverlay("#1e1222", 0.72, null), "#1e1222");
  const over = glassOverlay("#1e1222", 0.72, under);
  const a = parseInt(over.slice(7, 9), 16) / 255;
  const combined = 1 - (1 - under) * (1 - a);
  assert.ok(Math.abs(combined - 0.72) < 0.01, `expected ~0.72, got ${combined}`);
});

test("resolveChatGlass: opaque theme stays solid; translucent theme without config keeps defaults", () => {
  const solid = resolveChatGlass("#1e1222");
  assert.deepEqual(solid, { active: false, chatBg: "#1e1222", columnAdd: 0, fadePx: 0, rgb: "#1e1222" });

  const def = resolveChatGlass("#1e12224d");
  const under = 0x4d / 255;
  assert.equal(def.active, true);
  assert.equal(def.chatBg, "#00000000");
  assert.equal(def.fadePx, DEFAULT_GLASS_FADE);
  assert.ok(Math.abs(1 - (1 - under) * (1 - def.columnAdd) - DEFAULT_GLASS_TEXT) < 1e-6);
});

test("resolveChatGlass: respects live chat sides, column, fade, and chat-off toggle", () => {
  const off = resolveChatGlass("#1e12224d", { enabled: true, chat: { enabled: false, sides: 30, column: 80, fade: 120 } });
  assert.deepEqual(off, { active: false, chatBg: "#1e1222", columnAdd: 0, fadePx: 0, rgb: "#1e1222" });

  // Window under=0.20 (#33), chat sides=40%, column=85%, fade=60px
  const custom = resolveChatGlass("#1e122233", { enabled: true, chat: { enabled: true, sides: 40, column: 85, fade: 61 } });
  assert.equal(custom.active, true);
  assert.equal(custom.fadePx, 62);
  const under = 0x33 / 255;
  const sideAdd = parseInt(custom.chatBg.slice(7, 9), 16) / 255;
  const sideTotal = 1 - (1 - under) * (1 - sideAdd);
  assert.ok(Math.abs(sideTotal - 0.4) < 0.01);
  const colTotal = 1 - (1 - sideTotal) * (1 - custom.columnAdd);
  assert.ok(Math.abs(colTotal - 0.85) < 0.01);

  // Column <= sides => no column layer needed
  const flat = resolveChatGlass("#1e12224d", { enabled: true, chat: { enabled: true, sides: 50, column: 40, fade: 0 } });
  assert.equal(flat.active, true);
  assert.equal(flat.columnAdd, 0);
  assert.equal(flat.fadePx, 0);
});
