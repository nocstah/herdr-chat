// Glass (see-through theme) math for the chat view: reads live tuning from
// shared("herdr.glass") or <appHome>/glass.json while staying backwards
// compatible with a plain translucent theme (no config file). Supports
// independent dark (`cfg.chat`) and light (`cfg.lightTheme.chat`) profiles.

export const GLASS_SHARED = "herdr.glass";
export const DEFAULT_GLASS_TEXT = 0.8;
export const DEFAULT_GLASS_FADE = 120;
export const DEFAULT_LIGHT_GLASS_TEXT = 0.9;
export const DEFAULT_LIGHT_GLASS_FADE = 140;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Whether `#rrggbb[aa]` is a light color (same relative-luminance rule as herdr-app's settings.rs). */
export function isLightHex(color) {
  const s = String(color ?? "");
  if (!/^#[0-9a-f]{6}/i.test(s)) return false;
  const r = parseInt(s.slice(1, 3), 16) / 255;
  const g = parseInt(s.slice(3, 5), 16) / 255;
  const b = parseInt(s.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

/** Alpha (0..1) of an 8-digit hex color with transparency, or null when solid. */
export function glassTint(color) {
  const s = String(color ?? "");
  return /^#[0-9a-f]{8}$/i.test(s) && !/ff$/i.test(s) ? parseInt(s.slice(7, 9), 16) / 255 : null;
}

/**
 * Overlay hex over a window already tinted to `under` (0..1) so the combined
 * opacity lands at `target` (0..1). Returns `#00000000` when `target <= under`
 * and opaque `#rrggbb` when `target >= 1` or `under === null`.
 */
export function glassOverlay(baseColor, target, under) {
  const rgb = String(baseColor ?? "#000000").slice(0, 7);
  if (under === null || target >= 0.995) return rgb;
  if (target <= under + 0.002) return "#00000000";
  const add = clamp((target - under) / (1 - under), 0, 1);
  return rgb + Math.round(add * 255).toString(16).padStart(2, "0");
}

/**
 * Resolves the chat view's background and text-column scrim from the theme's
 * background color and optional live glass config (`shared("herdr.glass")`).
 *
 * @param {string} background - `t.background`
 * @param {any} [cfg] - optional glass config `{ enabled?, light?, chat?, lightTheme?: { chat? } }`
 */
export function resolveChatGlass(background, cfg = null) {
  const bg = String(background ?? "");
  const rgb = bg.slice(0, 7);
  const under = glassTint(bg);
  if (under === null) {
    return { active: false, chatBg: bg, columnAdd: 0, fadePx: 0, rgb };
  }
  const light = isLightHex(bg);
  if (cfg && (cfg.enabled === false || (light && cfg.light === false))) {
    return { active: false, chatBg: rgb, columnAdd: 0, fadePx: 0, rgb };
  }
  const chatCfg = light && cfg?.lightTheme?.chat ? cfg.lightTheme.chat : cfg?.chat;
  if (chatCfg?.enabled === false) {
    return { active: false, chatBg: rgb, columnAdd: 0, fadePx: 0, rgb };
  }
  const sides = typeof chatCfg?.sides === "number" && Number.isFinite(chatCfg.sides)
    ? clamp(chatCfg.sides / 100, under, 1)
    : under;
  const column = typeof chatCfg?.column === "number" && Number.isFinite(chatCfg.column)
    ? clamp(chatCfg.column / 100, 0, 1)
    : (light ? DEFAULT_LIGHT_GLASS_TEXT : DEFAULT_GLASS_TEXT);
  const fadePx = typeof chatCfg?.fade === "number" && Number.isFinite(chatCfg.fade)
    ? Math.max(0, Math.min(300, Math.round(chatCfg.fade / 2) * 2))
    : (light ? DEFAULT_LIGHT_GLASS_FADE : DEFAULT_GLASS_FADE);
  const chatBg = glassOverlay(rgb, sides, under);
  const columnAdd = sides >= 0.995 || column <= sides + 0.002
    ? 0
    : clamp((column - sides) / (1 - sides), 0, 1);
  return { active: sides < 0.995, chatBg, columnAdd, fadePx, rgb };
}
