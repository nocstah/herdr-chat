// Native file picker and @-mention formatting for uploaded/dropped files.
// Kept free of gpui-kit / herdr imports so Node unit tests exercise it directly.

export const PICKER_TIMEOUT_MS = 600_000; // herdr exec() max: 10 minutes

const APPLESCRIPT = [
  "on run argv",
  "  if (count of argv) > 0 then",
  "    try",
  '      set picked to choose file with prompt "Upload files" default location (POSIX file (item 1 of argv)) with multiple selections allowed',
  "    on error number -128",
  '      return ""',
  "    on error",
  "      try",
  '        set picked to choose file with prompt "Upload files" with multiple selections allowed',
  "      on error number -128",
  '        return ""',
  "      end try",
  "    end try",
  "  else",
  "    try",
  '      set picked to choose file with prompt "Upload files" with multiple selections allowed',
  "    on error number -128",
  '      return ""',
  "    end try",
  "  end if",
  "  set out to {}",
  "  repeat with f in picked",
  "    set end of out to POSIX path of f",
  "  end repeat",
  "  set AppleScript's text item delimiters to linefeed",
  "  return out as text",
  "end run",
].join("\n");

/**
 * Formats a file path as an `@` mention. Paths inside `cwd` become relative to it;
 * paths containing whitespace or quotes are wrapped in `@"…"`.
 * @param {string} path
 * @param {string | null | undefined} [cwd]
 * @returns {string}
 */
export function formatMention(path, cwd = null) {
  let shown = String(path ?? "");
  const base = cwd ? String(cwd).replace(/\/+$/, "") : "";
  if (base && base !== "/" && shown.startsWith(base + "/")) shown = shown.slice(base.length + 1);
  if (/[\s"]/.test(shown)) return `@"${shown.replace(/"/g, '\\"')}"`;
  return `@${shown}`;
}

/**
 * Appends attached non-image file paths to a prompt so leading `/command` and skill
 * tokens stay at the start while every agent receives unambiguous `@` file mentions.
 * @param {string} text
 * @param {string[]} files
 * @param {string | null | undefined} [cwd]
 * @returns {string}
 */
export function composeWithFiles(text, files, cwd = null) {
  const list = (files ?? []).filter(Boolean);
  if (!list.length) return text;
  const mentions = list.map((p) => formatMention(p, cwd)).join(" ");
  return text.trim() ? `${text}\n\n${mentions}` : mentions;
}

/**
 * Ordered native file-picker commands to try for the given platform.
 * @param {{ platform: string; startDir?: string | null }} opts
 * @returns {{ kind: "osascript" | "zenity" | "kdialog"; cmd: string; args: string[] }[]}
 */
export function pickerCandidates({ platform, startDir = null }) {
  const dir = typeof startDir === "string" && startDir.startsWith("/") ? startDir.replace(/\/+$/, "") || "/" : null;
  if (/^(darwin|macos)$/i.test(platform)) {
    return [{
      kind: "osascript",
      cmd: "osascript",
      args: ["-e", APPLESCRIPT, ...(dir ? ["--", dir] : [])],
    }];
  }
  const zenityDir = dir ? (dir === "/" ? "/" : `${dir}/`) : null;
  return [
    {
      kind: "zenity",
      cmd: "zenity",
      args: ["--file-selection", "--multiple", "--separator=\n", "--title=Upload files", ...(zenityDir ? [`--filename=${zenityDir}`] : [])],
    },
    {
      kind: "kdialog",
      cmd: "kdialog",
      args: ["--getopenfilename", dir ?? ".", "--multiple", "--separate-output", "--title", "Upload files"],
    },
  ];
}

/**
 * Interprets the exit status and output of a file-picker process.
 * @param {"osascript" | "zenity" | "kdialog"} kind
 * @param {{ code: number; stdout?: string; stderr?: string }} result
 * @returns {{ status: "ok"; paths: string[] } | { status: "cancelled"; paths: [] } | { status: "error"; error: string }}
 */
export function parsePickerResult(kind, result) {
  const code = result?.code ?? 1;
  const stdout = String(result?.stdout ?? "");
  const stderr = String(result?.stderr ?? "");
  if (code === 0) {
    const paths = stdout.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
    return { status: "ok", paths };
  }
  if (kind === "zenity") {
    if ((code === 1 || code === 5) && !/cannot open display|unable to init server|failed to open display/i.test(stderr)) {
      return { status: "cancelled", paths: [] };
    }
  } else if (kind === "kdialog") {
    if (code === 1 && !/cannot connect to|could not connect to display|no display/i.test(stderr)) {
      return { status: "cancelled", paths: [] };
    }
  } else if (kind === "osascript") {
    if (code === 1 && /-128|user cancel/i.test(stderr)) {
      return { status: "cancelled", paths: [] };
    }
  }
  const detail = stderr.trim().split("\n")[0] || stdout.trim().split("\n")[0] || `exit ${code}`;
  return { status: "error", error: `${kind}: ${detail}` };
}

/**
 * Opens the OS file picker and resolves to the chosen absolute paths (or `[]` on cancel).
 * @param {(cmd: string, args: string[], opts: { timeout: number }) => Promise<{ code: number; stdout: string; stderr: string }>} execFn
 * @param {{ platform: string; startDir?: string | null }} opts
 * @returns {Promise<string[]>}
 */
export async function pickFiles(execFn, opts) {
  const candidates = pickerCandidates(opts);
  let missing = 0;
  /** @type {Error | null} */
  let lastErr = null;
  for (const cand of candidates) {
    let res;
    try {
      res = await execFn(cand.cmd, cand.args, { timeout: PICKER_TIMEOUT_MS });
    } catch (e) {
      missing++;
      lastErr = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (res?.code === 127) {
      missing++;
      continue;
    }
    const parsed = parsePickerResult(cand.kind, res);
    if (parsed.status === "ok") return parsed.paths;
    if (parsed.status === "cancelled") return [];
    lastErr = new Error(parsed.error);
  }
  if (missing === candidates.length) {
    throw new Error("No file picker found (install zenity or kdialog), or drag and drop files into the chat");
  }
  throw lastErr ?? new Error("Could not open the file picker");
}
