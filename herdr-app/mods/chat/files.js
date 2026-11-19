// Open a file a tool touched (visual-v2.md §6, "clickable file paths"):
// 1. herdr-nvim installed (mods/herdr-nvim/bin/herdr-nvim, as gitview's
//    nvim.js finds it): `herdr-nvim open --tab <tab> --space <space> <file>:<line>`;
// 2. else $EDITOR (the login shell's; vi without one) in a terminal pane
//    of the chat's tab (beside it, like the TUI hand-off), in the chat's folder.
// A chat in another machine's space (machines.js): its files are there, so the
// editor runs there (that machine's $EDITOR, `hc run --on`); herdr-nvim is this
// computer's.

import { appHome, exec, hc, readTextFile } from "herdr";
import { bare } from "./machines.js";

const editorCache = new Map(); // machine ("" for this computer) → argv

async function herdrNvim() {
  const bin = `${appHome()}/mods/herdr-nvim/bin/herdr-nvim`;
  try {
    return (await readTextFile(bin)) !== null ? bin : null;
  } catch {
    return null;
  }
}

async function editorArgv(machine) {
  const key = machine ?? "";
  if (editorCache.has(key)) return editorCache.get(key);
  let ed = "";
  try {
    ed = (await exec("/bin/sh", ["-lc", 'printf %s "${VISUAL:-$EDITOR}"'], machine ? { on: machine, timeout: 20000 } : {})).stdout.trim();
  } catch {}
  const argv = (ed || "vi").split(/\s+/).filter(Boolean);
  editorCache.set(key, argv);
  return argv;
}

// {path (absolute), line, cwd, tab, space, machine (the space's, null for this computer)}
//   → {how: "herdr-nvim" | "editor", terminal?}
export async function openFile(o) {
  const machine = o.machine ?? null;
  const nvim = machine ? null : await herdrNvim();
  if (nvim && o.tab) {
    const args = ["open", "--tab", String(o.tab)];
    if (o.space) args.push("--space", String(o.space));
    args.push(`${o.path}:${o.line || 1}`);
    const r = await exec(nvim, args, { cwd: o.cwd });
    if (r.code === 0) return { how: "herdr-nvim" };
  }
  const ed = await editorArgv(machine);
  const argv = /(^|\/)(n?vim?|vi|hx|helix|kak|micro|nano|emacs)$/.test(ed[0]) ? [...ed, `+${o.line || 1}`, o.path] : [...ed, o.path];
  if (!o.space || !o.tab) throw new Error("no tab to open the editor in");
  // The labels name the tab as its own machine's document does.
  const r = await hc(["run", "--bg", "--json", "--no-parent", ...(machine ? ["--on", machine] : []), "--cwd", o.cwd ?? "/",
    "--label", `herdr.space=${bare(o.space)}`, "--label", `herdr.tab=${bare(o.tab)}`, "--label", "herdr-chat.editor=1", "--", ...argv]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || "hc run failed");
  return { how: "editor", terminal: JSON.parse(r.stdout).address, argv };
}
