// Glass (see-through theme) math for the chat view: reads live tuning from
// shared("herdr.glass") or <appHome>/glass.json while staying backwards
// compatible with a plain translucent theme (no config file).

export const GLASS_SHARED = "herdr.glass";
export const DEFAULT_GLASS_TEXT = 0.8;
export const DEFAULT_GLASS_FADE = 120;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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
 * @param {any} [cfg] - optional glass config `{ enabled?, chat?: { enabled?, sides?, column?, fade? } }`
 */
export function resolveChatGlass(background, cfg = null) {
  const bg = String(background ?? "");
  const rgb = bg.slice(0, 7);
  const under = glassTint(bg);
  if (under === null) {
    return { active: false, chatBg: bg, columnAdd: 0, fadePx: 0, rgb };
  }
  if (cfg && (cfg.enabled === false || cfg.chat?.enabled === false)) {
    return { active: false, chatBg: rgb, columnAdd: 0, fadePx: 0, rgb };
  }
  const sides = typeof cfg?.chat?.sides === "number" && Number.isFinite(cfg.chat.sides)
    ? clamp(cfg.chat.sides / 100, under, 1)
    : under;
  const column = typeof cfg?.chat?.column === "number" && Number.isFinite(cfg.chat.column)
    ? clamp(cfg.chat.column / 100, 0, 1)
    : DEFAULT_GLASS_TEXT;
  const fadePx = typeof cfg?.chat?.fade === "number" && Number.isFinite(cfg.chat.fade)
    ? Math.max(0, Math.min(300, Math.round(cfg.chat.fade / 2) * 2))
    : DEFAULT_GLASS_FADE;
  const chatBg = glassOverlay(rgb, sides, under);
  const columnAdd = sides >= 0.995 || column <= sides + 0.002
    ? 0
    : clamp((column - sides) / (1 - sides), 0, 1);
  return { active: sides < 0.995, chatBg, columnAdd, fadePx, rgb };
}
