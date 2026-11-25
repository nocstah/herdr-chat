// Antigravity CLI's tools: its names, argument unwrapping (transcript.jsonl
// stores each arg value as a JSON-encoded string), diffs for edits, clean
// output, and exit codes for commands.
import { diffFromEdits, firstLine, num, str, type Presented, type Rel, type ToolMap } from "../../tools.ts";

type Rec = Record<string, any>;

const JSON_SCALAR = /^(?:"[\s\S]*"|\{[\s\S]*\}|\[[\s\S]*\]|true|false|null|-?\d+(?:\.\d+)?)$/;
const TRUNCATED_SUFFIX = /\n<truncated \d+ bytes>$/;

function decodeStringArg(v: string): unknown {
  if (JSON_SCALAR.test(v)) {
    try {
      return JSON.parse(v);
    } catch {}
  }
  // Antigravity's compact transcript truncates long JSON-encoded arg strings around 2 KB
  // by appending `\n<truncated N bytes>`, leaving a leading quote and JSON escapes.
  const tr = TRUNCATED_SUFFIX.exec(v);
  if (v.startsWith('"') && tr) {
    const body = v.slice(1, tr.index).replace(/\\+$/, (bs) => (bs.length % 2 ? bs.slice(0, -1) : bs));
    try {
      return `${JSON.parse(`"${body}"`)}${tr[0]}`;
    } catch {}
    return body.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\") + tr[0];
  }
  return v;
}

/**
 * Antigravity writes each tool_call argument value in transcript.jsonl as a
 * JSON-encoded string (e.g. `{"Path": "\"/a/b.ts\"", "StartLine": "10"}`).
 * Decode those values back into JS primitives/objects; pass already-decoded
 * values through untouched.
 */
export function decodeToolArgs(raw: unknown): Rec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Rec = {};
  for (const [k, v] of Object.entries(raw as Rec)) {
    out[k] = typeof v === "string" ? decodeStringArg(v) : v;
  }
  return out;
}

/**
 * Strip Antigravity's leading `Created At:` / `Completed At:` timestamp lines
 * (often emitted twice) and normalize CRLF so tool cards start at the real output.
 */
export function cleanToolOutput(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && /^(?:Created|Completed) At:\s+\d{4}-\d{2}-\d{2}T/.test(lines[i]!)) i++;
  return lines.slice(i).join("\n");
}

function editFromChunks(path: string, chunks: unknown): string | null {
  if (!Array.isArray(chunks) || !chunks.length) return null;
  const edits = chunks
    .filter((c): c is Rec => Boolean(c && typeof c === "object"))
    .map((c) => ({ oldText: str(c.TargetContent) ?? "", newText: str(c.ReplacementContent) ?? "" }));
  return edits.length ? diffFromEdits(path, { edits }) : null;
}

export const ANTIGRAVITY_TOOLS: ToolMap = {
  names: {
    run_command: "bash",
    read_file: "read",
    view_file: "read",
    edit_file: "edit",
    replace_file_content: "edit",
    multi_replace_file_content: "edit",
    write_file: "write",
    write_to_file: "write",
    grep_search: "search",
    find_by_name: "search",
    list_dir: "search",
    search_web: "web_search",
    read_url: "web_fetch",
    read_url_content: "web_fetch",
    invoke_subagent: "agent",
  },
  present(name, a, rel): Presented | null {
    switch (name) {
      case "run_command": {
        const command = str(a.CommandLine) ?? str(a.command) ?? "";
        const summary = str(a.toolSummary);
        return {
          title: command ? `$ ${firstLine(command)}` : summary ? `$ ${firstLine(summary)}` : "$",
          detail: { type: "bash", command: command || summary || "" },
        };
      }
      case "read_file":
      case "view_file": {
        const path = str(a.Path) ?? str(a.AbsolutePath) ?? str(a.path) ?? "";
        const start = num(a.StartLine);
        const end = num(a.EndLine);
        const offset = start;
        const limit = start !== undefined && end !== undefined && end >= start ? end - start + 1 : end;
        let range = "";
        if (start !== undefined && end !== undefined) range = `:${start}-${end}`;
        else if (start !== undefined) range = `:${start}`;
        else if (end !== undefined) range = `:1-${end}`;
        return {
          title: `Read ${rel(path)}${range}`.trim(),
          detail: { type: "read", path, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) },
        };
      }
      case "edit_file": {
        const path = str(a.Path) ?? str(a.path) ?? "";
        const diff = typeof a.Target === "string" || typeof a.Replacement === "string"
          ? diffFromEdits(rel(path), { oldText: str(a.Target) ?? "", newText: str(a.Replacement) ?? "" })
          : null;
        return { title: `Edit ${rel(path)}`.trim(), detail: { type: "edit", path, diff } };
      }
      case "replace_file_content": {
        const path = str(a.TargetFile) ?? str(a.Path) ?? "";
        const diff = typeof a.TargetContent === "string" || typeof a.ReplacementContent === "string"
          ? diffFromEdits(rel(path), { oldText: str(a.TargetContent) ?? "", newText: str(a.ReplacementContent) ?? "" })
          : null;
        return { title: `Edit ${rel(path)}`.trim(), detail: { type: "edit", path, diff } };
      }
      case "multi_replace_file_content": {
        const path = str(a.TargetFile) ?? str(a.Path) ?? "";
        return { title: `Edit ${rel(path)}`.trim(), detail: { type: "edit", path, diff: editFromChunks(rel(path), a.ReplacementChunks) } };
      }
      case "write_file":
      case "write_to_file": {
        const path = str(a.Path) ?? str(a.TargetFile) ?? str(a.path) ?? "";
        const content = str(a.Content) ?? str(a.CodeContent);
        return {
          title: `Write ${rel(path)}`.trim(),
          detail: { type: "write", path, ...(content !== undefined ? { bytes: Buffer.byteLength(content) } : {}) },
        };
      }
      case "grep_search": {
        const query = str(a.Query) ?? str(a.query);
        const path = str(a.SearchPath) ?? str(a.path);
        return {
          title: `Grep ${query ?? ""}${path ? ` in ${rel(path)}` : ""}`.trim(),
          detail: { type: "search", tool: "grep", ...(query !== undefined ? { query } : {}), ...(path !== undefined ? { path } : {}) },
        };
      }
      case "find_by_name": {
        const query = str(a.Pattern) ?? str(a.pattern);
        const path = str(a.SearchDirectory) ?? str(a.path);
        return {
          title: `Find ${query ?? ""}${path ? ` in ${rel(path)}` : ""}`.trim(),
          detail: { type: "search", tool: "find", ...(query !== undefined ? { query } : {}), ...(path !== undefined ? { path } : {}) },
        };
      }
      case "list_dir": {
        const path = str(a.DirectoryPath) ?? str(a.path) ?? ".";
        return { title: `List ${rel(path)}`, detail: { type: "search", tool: "ls", path } };
      }
      case "read_url":
      case "read_url_content": {
        const url = str(a.Url) ?? str(a.url);
        return { title: `Fetch ${url ?? ""}`.trim(), detail: { type: "web", tool: "fetch", ...(url ? { url } : {}) } };
      }
      case "invoke_subagent": {
        const role = str(a.Role);
        const agentType = str(a.TypeName);
        const prompt = str(a.Prompt) ?? "";
        const label = role ?? (prompt ? firstLine(prompt, 80) : agentType ?? "");
        return {
          title: `Agent ${label}`.trim(),
          detail: { type: "agent", description: prompt || role || "", ...(agentType ? { agentType } : {}) },
        };
      }
      case "manage_task": {
        const action = str(a.Action) ?? "status";
        const taskId = str(a.TaskId);
        const short = taskId ? taskId.split("/").pop() : "";
        return { title: `Task ${action}${short ? ` ${short}` : ""}`, detail: { type: "generic", tool: "manage_task" } };
      }
      case "ask_question": {
        const qs = Array.isArray(a.questions) ? a.questions : [];
        const first = str(qs[0]?.question);
        return { title: first ? `Question ${firstLine(first, 80)}` : "Question", detail: { type: "generic", tool: "ask_question" } };
      }
      case "send_message": {
        const to = str(a.Recipient);
        return { title: to ? `Message ${firstLine(to, 40)}` : "Message", detail: { type: "generic", tool: "send_message" } };
      }
      case "schedule": {
        const what = str(a.CronExpression) ?? (num(a.DurationSeconds) !== undefined ? `${a.DurationSeconds}s` : "");
        return { title: what ? `Schedule ${what}` : "Schedule", detail: { type: "generic", tool: "schedule" } };
      }
      case "run_workflow": {
        const desc = str(a.Description) ?? str(a.ScriptPath);
        return { title: desc ? `Workflow ${firstLine(desc, 80)}` : "Workflow", detail: { type: "generic", tool: "run_workflow" } };
      }
      default:
        return null;
    }
  },
  exitCode(result, isError, output) {
    const sc = result?.structuredContent;
    if (sc && typeof sc === "object" && "exit_code" in sc) return num((sc as Rec).exit_code) ?? null;
    const m = /^Command exited with code (\d+)\.?$/m.exec(output);
    if (m) return Number(m[1]);
    if (/Command aborted|Tool execution was canceled/i.test(output)) return null;
    return isError ? null : 0;
  },
};
