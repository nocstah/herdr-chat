/**
 * Read-only reader, action builder, screenshot materializer, and themed SVG graph renderer
 * for Antigravity CLI's native `/swarm` state under `<appData>/brain/<coord>/.system_generated/swarm/`.
 *
 * Every file read is bounded, non-blocking, symlink-checked inside `<appData>/brain/`,
 * and never logs prompt, board, or transcript text.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, sep } from "node:path";
import type { Theme } from "../../mermaid.ts";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MEMBER_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
export const DEFAULT_CHANNEL = "main";

const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_VIEW_BYTES = 64 * 1024;
const MAX_BOARD_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_MEMBER_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGES_RETURNED = 200;
const ERROR_SETTLE_MS = 60_000;
const STUCK_MS = 10 * 60_000;
const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;
const ROLE_NAME_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
const SCREENSHOT_LINE_RE = /^\s*Screenshot:\s*(\/[^\s|]+\.(?:png|jpe?g|webp|gif))(?:\s*\|\s*(.*))?$/i;

const FRAME_MIMES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const KNOWN_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "gpt-5",
];

export type SwarmMemberStatus = "working" | "waiting" | "blocked" | "killed";
export type SwarmAttentionKind = "decision" | "failure" | "review" | "stuck" | "quota" | "error" | "approval" | "fyi";
export type SwarmAttentionSeverity = "high" | "med" | "low";
export type SwarmWorkstreamState = "queued" | "active" | "blocked" | "review" | "done" | "failed";

export interface SwarmMemberFailure {
  kind: "quota" | "error" | "stuck" | "approval";
  message: string;
  at: number;
}

export interface SwarmMemberView {
  name: string;
  conversation_id: string;
  model: string;
  role: string;
  role_worker: boolean;
  status: SwarmMemberStatus;
  wake_mode: string;
  wait_since: number;
  last_read_seq: number;
  killed: boolean;
  channels: string[];
  workspace_mode: string;
  workspace: string | null;
  steps: number;
  posts: number;
  unread: number;
  activity: string | null;
  last_active_at: number | null;
  failure: SwarmMemberFailure | null;
}

export interface SwarmChannelView {
  name: string;
  topic: string;
  archived: boolean;
  members: string[];
  message_count: number;
  last_seq: number;
}

export interface SwarmScreenshotRef {
  path: string;
  caption: string;
  local_path?: string;
}

export interface SwarmMessageView {
  seq: number;
  agent: string;
  text: string;
  time: string;
  ts: number | null;
  channel: string;
  mentions: string[];
  all_targets: string[];
  has_all: boolean;
  channel_mentions: string[];
  screenshots: SwarmScreenshotRef[];
  control?: { op: string; channel: string; topic?: string; members?: string[] };
}

export interface SwarmEdgeView {
  from: string;
  to: string;
  direct: number;
  via_all: number;
  total: number;
  last_seq: number;
}

export interface SwarmPlanView {
  goal: { title: string; line: string } | null;
  tasks: Record<string, string>;
  threads: Array<{ id: string; title: string; goal: string; tasks: string[] }>;
}

export interface SwarmAttentionAction {
  kind: "open_member" | "jump_seq" | "switch_model" | "nudge" | "open_terminal";
  label: string;
  member?: string;
  seq?: number;
}

export interface SwarmAttentionItem {
  id: string;
  kind: SwarmAttentionKind;
  severity: SwarmAttentionSeverity;
  title: string;
  why: string;
  short?: string;
  refs: number[];
  member?: string;
  source: "system" | "narrator";
  actions: SwarmAttentionAction[];
}

export interface SwarmWorkstreamView {
  id: string;
  title: string;
  owners: string[];
  state: SwarmWorkstreamState;
  note: string;
  short?: string;
  progress?: { done: number; total: number };
  refs: number[];
}

export interface SwarmThreadView {
  id: string;
  title: string;
  goal: string;
  now: string;
  workstreams: SwarmWorkstreamView[];
  attention: SwarmAttentionItem[];
}

export interface SwarmFrameView {
  path: string;
  seq: number | null;
  caption: string;
  agent?: string;
  local_path?: string;
}

export interface SwarmNarratorView {
  status: "none" | "active" | "stale" | "idle";
  member: string | null;
  as_of_seq: number | null;
  updated_at: string | null;
  headline: string | null;
  goal: { title: string; line: string } | null;
  running_summary: string | null;
  phase: { label: string; index: number; total: number } | null;
  now: Record<string, string>;
  attention: SwarmAttentionItem[];
  workstreams: SwarmWorkstreamView[];
  threads: SwarmThreadView[];
  milestones: Array<{ title: string; state: string; note: string }>;
  risks: Array<{ title: string; severity: string; note: string }>;
}

export interface SwarmCounts {
  active: number;
  working: number;
  waiting: number;
  blocked: number;
  killed: number;
  role_workers: number;
  attention: number;
  workers_working: number;
  workers_total: number;
  coordinator_status: SwarmMemberStatus | null;
}

export interface SwarmSnapshot {
  coordinator_id: string;
  me: string;
  title: string;
  head_seq: number;
  counts: SwarmCounts;
  members: SwarmMemberView[];
  channels: SwarmChannelView[];
  messages: SwarmMessageView[];
  total_messages: number;
  messages_truncated: boolean;
  edges: SwarmEdgeView[];
  plan: SwarmPlanView | null;
  narrator: SwarmNarratorView;
  system_attention: SwarmAttentionItem[];
  frames: SwarmFrameView[];
  models: string[];
  etag: string;
}

export interface MemberTranscriptEvent {
  step_index: number;
  kind: "user" | "thinking" | "assistant" | "tool" | "tool_output" | "error" | "system";
  ts: string | null;
  status: string;
  text?: string;
  tool_name?: string;
  tool_summary?: string;
  tool_input?: string;
  error?: boolean;
}

export interface SwarmMemberTranscript {
  member: SwarmMemberView;
  events: MemberTranscriptEvent[];
  total_steps: number;
  truncated: boolean;
}

export type SwarmActionRequest =
  | { action: "start"; task: string }
  | { action: "post"; target: string; channel?: string; message: string }
  | { action: "model"; member: string; model: string }
  | { action: "kill"; member: string }
  | { action: "add"; name: string; brief: string; model?: string; workspace?: "inherit" | "share" | "branch" }
  | { action: "nudge"; member: string; note?: string }
  | { action: "title"; title: string };

export interface LocatedSwarm {
  brainDir: string;
  swarmDir: string;
  coordinatorId: string;
  me: string;
}

type Obj = Record<string, unknown>;
const asObj = (value: unknown): Obj | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
const asStr = (value: unknown, max = 4000): string => (typeof value === "string" ? value.slice(0, max) : "");
const asNum = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function isInside(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

function canonicalBrainDir(root: string): string | null {
  try {
    const brain = realpathSync(join(root, "brain"));
    return statSync(brain).isDirectory() ? brain : null;
  } catch {
    return null;
  }
}

function safeFilePath(brainDir: string, candidate: string): string | null {
  try {
    const real = realpathSync(candidate);
    if (!isInside(brainDir, real)) return null;
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function readBoundedFile(path: string, maxBytes: number): { text: string; mtimeMs: number; size: number; truncated: boolean } | null {
  let fd: number;
  try {
    fd = openSync(path, READ_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size === 0) return { text: "", mtimeMs: st.mtimeMs, size: 0, truncated: false };
    const start = st.size > maxBytes ? st.size - maxBytes : 0;
    const len = st.size - start;
    const buf = Buffer.allocUnsafe(len);
    let offset = 0;
    while (offset < len) {
      const n = readSync(fd, buf, offset, len - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    let text = buf.subarray(0, offset).toString("utf8");
    const truncated = start > 0;
    if (truncated) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return { text, mtimeMs: st.mtimeMs, size: st.size, truncated };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readJsonFile(brainDir: string, candidate: string, maxBytes = MAX_JSON_BYTES): Obj | null {
  const real = safeFilePath(brainDir, candidate);
  if (!real) return null;
  const loaded = readBoundedFile(real, maxBytes);
  if (!loaded || loaded.truncated || !loaded.text.trim()) return null;
  try {
    return asObj(JSON.parse(loaded.text));
  } catch {
    return null;
  }
}

export function isRoleWorker(name: string, role?: string | null): boolean {
  if (typeof role === "string" && role.length > 0 && role !== "worker" && role !== "coordinator") return true;
  return ROLE_NAME_RE.test(name);
}

const reverseLookupCache = new Map<string, { at: number; located: LocatedSwarm | null }>();
const REVERSE_TTL_MS = 3_000;

export function clearSwarmReaderCache(): void {
  reverseLookupCache.clear();
}

interface RawMember {
  name: string;
  conversation_id: string;
  model: string;
  role: string;
  wake_mode: string;
  wait_since: number;
  last_read_seq: number;
  last_nudged_seq: number;
  last_park_blocked_seq: number;
  killed: boolean;
  channels: string[];
  workspace_mode: string;
  workspace: string | null;
}

function parseMembersFile(raw: Obj): { title: string; members: Map<string, RawMember> } {
  const title = asStr(raw.title, 200).trim();
  const map = new Map<string, RawMember>();
  const membersObj = asObj(raw.members);
  if (!membersObj) return { title, members: map };
  for (const [name, value] of Object.entries(membersObj)) {
    if (!MEMBER_RE.test(name)) continue;
    const m = asObj(value);
    if (!m) continue;
    const convId = asStr(m.conversation_id, 64);
    const channels = Array.isArray(m.channels)
      ? m.channels.filter((c): c is string => typeof c === "string" && CHANNEL_RE.test(c))
      : [DEFAULT_CHANNEL];
    if (!channels.includes(DEFAULT_CHANNEL)) channels.unshift(DEFAULT_CHANNEL);
    map.set(name, {
      name,
      conversation_id: UUID_RE.test(convId) ? convId : "",
      model: asStr(m.model, 120),
      role: asStr(m.role, 40) || (name === "coordinator" ? "coordinator" : "worker"),
      wake_mode: asStr(m.wake_mode, 40),
      wait_since: asNum(m.wait_since, 0),
      last_read_seq: asNum(m.last_read_seq, 0),
      last_nudged_seq: asNum(m.last_nudged_seq, 0),
      last_park_blocked_seq: asNum(m.last_park_blocked_seq, 0),
      killed: m.killed === true,
      channels,
      workspace_mode: asStr(m.workspace_mode, 24) || "inherit",
      workspace: typeof m.workspace === "string" && m.workspace.length > 0 ? m.workspace.slice(0, 500) : null,
    });
  }
  return { title, members: map };
}

export function findSwarmForConversation(root: string, convId: string, nowMs = Date.now()): LocatedSwarm | null {
  if (!UUID_RE.test(convId)) return null;
  const brainDir = canonicalBrainDir(root);
  if (!brainDir) return null;

  const directDir = join(brainDir, convId, ".system_generated", "swarm");
  const directMembers = readJsonFile(brainDir, join(directDir, "members.json"));
  if (directMembers) {
    const parsed = parseMembersFile(directMembers);
    let me = "coordinator";
    for (const member of parsed.members.values()) {
      if (member.conversation_id === convId) {
        me = member.name;
        break;
      }
    }
    return { brainDir, swarmDir: realpathSync(directDir), coordinatorId: convId, me };
  }

  const cacheKey = `${brainDir}:${convId}`;
  const cached = reverseLookupCache.get(cacheKey);
  if (cached && nowMs - cached.at < REVERSE_TTL_MS) return cached.located;

  let entries: string[];
  try {
    entries = readdirSync(brainDir);
  } catch {
    return null;
  }

  let found: LocatedSwarm | null = null;
  let scanned = 0;
  for (const entry of entries) {
    if (!UUID_RE.test(entry)) continue;
    if (++scanned > 2048) break;
    const candidateDir = join(brainDir, entry, ".system_generated", "swarm");
    const candidateFile = join(candidateDir, "members.json");
    if (!existsSync(candidateFile)) continue;
    const raw = readJsonFile(brainDir, candidateFile);
    if (!raw) continue;
    const parsed = parseMembersFile(raw);
    for (const member of parsed.members.values()) {
      if (member.conversation_id === convId) {
        try {
          found = { brainDir, swarmDir: realpathSync(candidateDir), coordinatorId: entry, me: member.name };
        } catch {
          found = null;
        }
        break;
      }
    }
    if (found) break;
  }

  reverseLookupCache.set(cacheKey, { at: nowMs, located: found });
  if (reverseLookupCache.size > 128) {
    const firstKey = reverseLookupCache.keys().next().value;
    if (firstKey !== undefined) reverseLookupCache.delete(firstKey);
  }
  return found;
}

interface ParsedStep {
  step_index: number;
  type: string;
  status: string;
  content: string;
  thinking: string;
  created_at: string | null;
  tool_calls: Array<{ name: string; args: Obj }>;
}

function parseStepLine(line: string): ParsedStep | null {
  if (!line.trim()) return null;
  let obj: Obj | null;
  try {
    obj = asObj(JSON.parse(line));
  } catch {
    return null;
  }
  if (!obj || typeof obj.type !== "string") return null;
  const callsRaw = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
  const tool_calls: Array<{ name: string; args: Obj }> = [];
  for (const call of callsRaw) {
    const c = asObj(call);
    if (!c || typeof c.name !== "string") continue;
    tool_calls.push({ name: c.name, args: asObj(c.args) ?? {} });
  }
  const thinking = typeof obj.thinking === "string" ? obj.thinking : typeof obj.reasoning === "string" ? obj.reasoning : "";
  return {
    step_index: typeof obj.step_index === "number" && Number.isSafeInteger(obj.step_index) ? obj.step_index : -1,
    type: obj.type,
    status: asStr(obj.status, 40),
    content: typeof obj.content === "string" ? obj.content : "",
    thinking,
    created_at: typeof obj.created_at === "string" ? obj.created_at : null,
    tool_calls,
  };
}

function summarizeToolCall(name: string, args: Obj): string {
  const explicit = asStr(args.toolSummary, 100).trim() || asStr(args.toolAction, 100).trim();
  if (explicit) return explicit;
  if (name === "run_command") {
    const cmd = asStr(args.CommandLine ?? args.command, 80).replace(/\s+/g, " ").trim();
    return cmd ? `Run ${cmd}` : "Running command";
  }
  if (name === "read_file" || name === "view_file") {
    const p = asStr(args.Path ?? args.AbsolutePath ?? args.file_path, 240);
    return p ? `Read ${basename(p)}` : "Reading file";
  }
  if (name === "write_file" || name === "write_to_file") {
    const p = asStr(args.Path ?? args.TargetFile ?? args.file_path, 240);
    return p ? `Write ${basename(p)}` : "Writing file";
  }
  if (name === "edit_file" || name === "replace_file_content" || name === "multi_replace_file_content") {
    const p = asStr(args.Path ?? args.TargetFile ?? args.file_path, 240);
    return p ? `Edit ${basename(p)}` : "Editing file";
  }
  if (name === "grep_search" || name === "find_by_name" || name === "search_web") {
    const q = asStr(args.Query ?? args.query ?? args.Pattern ?? args.pattern, 60).trim();
    return q ? `Search ${q}` : "Searching";
  }
  if (name === "swarm") {
    const action = asStr(args.action, 24);
    const target = asStr(args.name, 24);
    return [action ? `swarm ${action}` : "swarm", target].filter(Boolean).join(" ");
  }
  if (name === "swarm_post") return "Posting to board";
  if (name === "swarm_read") return "Reading board";
  if (name === "swarm_wait") return "Waiting on board";
  return name.replaceAll("_", " ");
}

function lastBoldHeading(thinking: string): string | null {
  if (!thinking) return null;
  let last: string | null = null;
  const re = /\*\*([^*\n]{2,90})\*\*/g;
  for (const match of thinking.matchAll(re)) {
    const candidate = match[1]?.trim();
    if (candidate) last = candidate;
  }
  return last;
}

const BLOCKED_STATUSES = new Set(["WAITING", "WAITING_FOR_USER", "BLOCKED", "PENDING_APPROVAL", "AWAITING_APPROVAL"]);

function findMemberTranscriptPath(brainDir: string, convId: string, preferFull = false): string | null {
  if (!UUID_RE.test(convId)) return null;
  const logsDir = join(brainDir, convId, ".system_generated", "logs");
  const order = preferFull ? ["transcript_full.jsonl", "transcript.jsonl"] : ["transcript.jsonl", "transcript_full.jsonl"];
  for (const name of order) {
    const candidate = safeFilePath(brainDir, join(logsDir, name));
    if (candidate) return candidate;
  }
  return null;
}

interface MemberTranscriptInspect {
  status: SwarmMemberStatus;
  steps: number;
  activity: string | null;
  lastActiveAt: number | null;
  failure: SwarmMemberFailure | null;
}

function inspectMemberTranscript(brainDir: string, m: RawMember, nowMs: number): MemberTranscriptInspect {
  if (m.killed) {
    return { status: "killed", steps: 0, activity: null, lastActiveAt: null, failure: null };
  }
  const path = findMemberTranscriptPath(brainDir, m.conversation_id, false);
  if (!path) {
    const fallbackStatus: SwarmMemberStatus =
      m.wake_mode === "mentions" || m.wake_mode === "anything" ? "waiting" : "working";
    return { status: fallbackStatus, steps: 0, activity: null, lastActiveAt: null, failure: null };
  }
  const loaded = readBoundedFile(path, MAX_TRANSCRIPT_TAIL_BYTES);
  if (!loaded) {
    return { status: m.wake_mode === "mentions" || m.wake_mode === "anything" ? "waiting" : "working", steps: 0, activity: null, lastActiveAt: null, failure: null };
  }
  const parsed: ParsedStep[] = [];
  for (const line of loaded.text.split("\n")) {
    const step = parseStepLine(line);
    if (step) parsed.push(step);
  }
  if (parsed.length === 0) {
    return {
      status: m.wake_mode === "mentions" || m.wake_mode === "anything" ? "waiting" : "working",
      steps: 0,
      activity: null,
      lastActiveAt: loaded.mtimeMs,
      failure: null,
    };
  }

  const newest = parsed[parsed.length - 1]!;
  const steps = newest.step_index >= 0 ? newest.step_index + 1 : parsed.length;
  const lastActiveAt = loaded.mtimeMs;

  const trailingGenerics: ParsedStep[] = [];
  let planner: ParsedStep | null = null;
  let hitUserInput = false;
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const step = parsed[i]!;
    if (step.type === "GENERIC") {
      trailingGenerics.unshift(step);
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      planner = step;
      break;
    }
    if (step.type === "USER_INPUT") {
      hitUserInput = true;
      break;
    }
    if (step.type === "ERROR_MESSAGE") {
      break;
    }
  }

  const waitingForApproval =
    trailingGenerics.some((g) => BLOCKED_STATUSES.has(g.status)) ||
    BLOCKED_STATUSES.has(newest.status);

  let status: SwarmMemberStatus = "working";
  if (waitingForApproval) {
    status = "blocked";
  } else if (!hitUserInput && planner !== null) {
    const calls = planner.tool_calls;
    if (calls.length === 0 && trailingGenerics.length === 0 && planner.status === "DONE") {
      status = "waiting";
    } else {
      const waitIdx = calls.findIndex((c) => c.name === "swarm_wait");
      if (waitIdx >= 0 && trailingGenerics.length >= calls.length && trailingGenerics[waitIdx]?.status === "DONE") {
        status = "waiting";
      } else {
        status = "working";
      }
    }
  } else if (newest.type === "ERROR_MESSAGE") {
    status = "waiting";
  }

  let activity: string | null = null;
  if (status === "working" || status === "blocked") {
    for (let i = parsed.length - 1; i >= 0; i -= 1) {
      const step = parsed[i]!;
      if (step.type === "USER_INPUT") break;
      if (step.type !== "PLANNER_RESPONSE") continue;
      if (step.tool_calls.some((c) => c.name === "swarm_wait")) break;
      const nonWaitCalls = step.tool_calls.filter((c) => c.name !== "swarm_wait");
      if (nonWaitCalls.length > 0) {
        const lastCall = nonWaitCalls[nonWaitCalls.length - 1]!;
        activity = summarizeToolCall(lastCall.name, lastCall.args);
        break;
      }
      const heading = lastBoldHeading(step.thinking);
      if (heading) {
        activity = heading;
        break;
      }
      break;
    }
  }

  let failure: SwarmMemberFailure | null = null;
  const ageMs = Math.max(0, nowMs - loaded.mtimeMs);
  if (status === "blocked") {
    failure = {
      kind: "approval",
      message: activity ? `Waiting for approval: ${activity}` : "Waiting for tool approval in terminal",
      at: loaded.mtimeMs,
    };
  } else if (newest.type === "ERROR_MESSAGE" || (newest.status === "ERROR" && ageMs >= ERROR_SETTLE_MS)) {
    const snippet = newest.content.replace(/\s+/g, " ").trim().slice(0, 220) || "Encountered an error";
    const isQuota = QUOTA_RE.test(newest.content);
    failure = {
      kind: isQuota ? "quota" : "error",
      message: snippet,
      at: loaded.mtimeMs,
    };
  } else if (status === "working" && ageMs >= STUCK_MS) {
    const mins = Math.max(10, Math.round(ageMs / 60_000));
    failure = {
      kind: "stuck",
      message: `No transcript updates for ${mins}m`,
      at: loaded.mtimeMs,
    };
  }

  return { status, steps, activity, lastActiveAt, failure };
}

function parseBoardTime(raw: string): number | null {
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractScreenshots(brainDir: string, text: string): SwarmScreenshotRef[] {
  const out: SwarmScreenshotRef[] = [];
  for (const line of text.split("\n")) {
    const match = SCREENSHOT_LINE_RE.exec(line);
    if (!match?.[1]) continue;
    const real = safeFilePath(brainDir, match[1]);
    if (!real) continue;
    const ext = extname(real).toLowerCase();
    if (!(ext in FRAME_MIMES)) continue;
    out.push({ path: real, caption: (match[2] ?? "").trim().slice(0, 200) });
  }
  return out;
}

interface ParsedBoard {
  headSeq: number;
  channels: SwarmChannelView[];
  messages: SwarmMessageView[];
  totalMessages: number;
  truncated: boolean;
  edges: SwarmEdgeView[];
  postsByMember: Map<string, number>;
  unreadByMember: Map<string, number>;
  frames: SwarmFrameView[];
}

function resolveMentions(
  text: string,
  sender: string,
  channel: string,
  allMembers: Map<string, RawMember>,
  channelSubscribers: Map<string, Set<string>>,
): { mentions: string[]; all_targets: string[]; has_all: boolean; channel_mentions: string[] } {
  const nonRoleNames = [...allMembers.values()]
    .filter((m) => !isRoleWorker(m.name, m.role))
    .map((m) => m.name);
  const activeNonRoleNames = [...allMembers.values()]
    .filter((m) => !m.killed && !isRoleWorker(m.name, m.role))
    .map((m) => m.name);
  const directSet = new Set<string>();
  const channelSet = new Set<string>();
  let hasAll = false;

  for (const match of text.matchAll(/(?:^|[^a-z0-9_])@#([a-z0-9][a-z0-9_-]{0,31})\b/gi)) {
    const ch = match[1]!.toLowerCase();
    if (!channelSubscribers.has(ch)) continue;
    channelSet.add(ch);
    for (const sub of channelSubscribers.get(ch) ?? []) {
      if (sub !== sender && nonRoleNames.includes(sub)) directSet.add(sub);
    }
  }

  for (const match of text.matchAll(/(?:^|[^a-z0-9_])@([a-z0-9][a-z0-9_-]{0,23})\b/gi)) {
    const token = match[1]!.toLowerCase();
    if (token === "all") {
      hasAll = true;
      continue;
    }
    if (allMembers.has(token)) {
      if (token !== sender && nonRoleNames.includes(token)) directSet.add(token);
      continue;
    }
    const prefixRe = new RegExp(`^${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+$`);
    for (const candidate of nonRoleNames) {
      if (candidate !== sender && prefixRe.test(candidate)) directSet.add(candidate);
    }
  }

  const allTargets = hasAll
    ? activeNonRoleNames.filter((name) => {
        if (name === sender) return false;
        if (channel === DEFAULT_CHANNEL) return true;
        const subs = channelSubscribers.get(channel);
        return !subs || subs.size === 0 || subs.has(name);
      })
    : [];

  return {
    mentions: [...directSet],
    all_targets: allTargets,
    has_all: hasAll,
    channel_mentions: [...channelSet],
  };
}

function parseBoard(brainDir: string, swarmDir: string, members: Map<string, RawMember>): ParsedBoard {
  const channelState = new Map<string, { topic: string; archived: boolean; members: Set<string>; count: number; lastSeq: number }>();
  const mainMembers = new Set<string>();
  for (const m of members.values()) {
    if (!m.killed) mainMembers.add(m.name);
    for (const ch of m.channels) {
      if (!channelState.has(ch)) {
        channelState.set(ch, { topic: ch === DEFAULT_CHANNEL ? "Main swarm channel" : "", archived: false, members: new Set(), count: 0, lastSeq: 0 });
      }
      if (!m.killed) channelState.get(ch)!.members.add(m.name);
    }
  }
  if (!channelState.has(DEFAULT_CHANNEL)) {
    channelState.set(DEFAULT_CHANNEL, { topic: "Main swarm channel", archived: false, members: mainMembers, count: 0, lastSeq: 0 });
  } else {
    for (const name of mainMembers) channelState.get(DEFAULT_CHANNEL)!.members.add(name);
  }

  const boardPath = safeFilePath(brainDir, join(swarmDir, "board.jsonl"));
  const loaded = boardPath ? readBoundedFile(boardPath, MAX_BOARD_BYTES) : null;
  const messages: SwarmMessageView[] = [];
  const postsByMember = new Map<string, number>();
  const edgeMap = new Map<string, SwarmEdgeView>();
  const frames: SwarmFrameView[] = [];
  let headSeq = 0;

  if (loaded && loaded.text) {
    let fallbackSeq = 0;
    for (const line of loaded.text.split("\n")) {
      if (!line.trim()) continue;
      let raw: Obj | null;
      try {
        raw = asObj(JSON.parse(line));
      } catch {
        continue;
      }
      if (!raw) continue;
      fallbackSeq += 1;
      const seq = asNum(raw.seq, fallbackSeq);
      if (seq > headSeq) headSeq = seq;
      const agent = asStr(raw.agent, 40) || "unknown";
      const text = asStr(raw.text, 4000);
      const time = asStr(raw.time, 40);
      const channel = CHANNEL_RE.test(asStr(raw.channel, 32)) ? asStr(raw.channel, 32) : DEFAULT_CHANNEL;

      if (!channelState.has(channel)) {
        channelState.set(channel, { topic: "", archived: false, members: new Set(), count: 0, lastSeq: 0 });
      }
      const chInfo = channelState.get(channel)!;
      chInfo.count += 1;
      if (seq > chInfo.lastSeq) chInfo.lastSeq = seq;

      let control: SwarmMessageView["control"];
      const ctrlRaw = asObj(raw.control);
      if (ctrlRaw && typeof ctrlRaw.op === "string" && typeof ctrlRaw.channel === "string" && CHANNEL_RE.test(ctrlRaw.channel)) {
        const op = ctrlRaw.op;
        const targetCh = ctrlRaw.channel;
        if (!channelState.has(targetCh)) {
          channelState.set(targetCh, { topic: "", archived: false, members: new Set(), count: 0, lastSeq: 0 });
        }
        const st = channelState.get(targetCh)!;
        const ctrlMembers = Array.isArray(ctrlRaw.members)
          ? ctrlRaw.members.filter((x): x is string => typeof x === "string" && MEMBER_RE.test(x))
          : undefined;
        if (op === "create") {
          if (typeof ctrlRaw.topic === "string") st.topic = ctrlRaw.topic.slice(0, 200);
          st.archived = false;
          for (const mName of ctrlMembers ?? []) st.members.add(mName);
        } else if (op === "archive") {
          st.archived = true;
        } else if (op === "subscribe") {
          for (const mName of ctrlMembers ?? [agent]) st.members.add(mName);
        } else if (op === "unsubscribe") {
          for (const mName of ctrlMembers ?? [agent]) st.members.delete(mName);
        }
        control = {
          op,
          channel: targetCh,
          ...(typeof ctrlRaw.topic === "string" ? { topic: ctrlRaw.topic.slice(0, 200) } : {}),
          ...(ctrlMembers ? { members: ctrlMembers } : {}),
        };
      }

      postsByMember.set(agent, (postsByMember.get(agent) ?? 0) + 1);

      const subscribers = new Map<string, Set<string>>();
      for (const [k, v] of channelState) subscribers.set(k, v.members);
      const { mentions, all_targets, has_all, channel_mentions } = resolveMentions(text, agent, channel, members, subscribers);

      const senderMember = members.get(agent);
      const senderIsRole = isRoleWorker(agent, senderMember?.role);
      if (!senderIsRole && members.has(agent)) {
        for (const to of mentions) {
          const key = `${agent}->${to}`;
          const existing = edgeMap.get(key) ?? { from: agent, to, direct: 0, via_all: 0, total: 0, last_seq: seq };
          existing.direct += 1;
          existing.total += 1;
          existing.last_seq = Math.max(existing.last_seq, seq);
          edgeMap.set(key, existing);
        }
        for (const to of all_targets) {
          if (mentions.includes(to)) continue;
          const key = `${agent}->${to}`;
          const existing = edgeMap.get(key) ?? { from: agent, to, direct: 0, via_all: 0, total: 0, last_seq: seq };
          existing.via_all += 1;
          existing.total += 1;
          existing.last_seq = Math.max(existing.last_seq, seq);
          edgeMap.set(key, existing);
        }
      }

      const screenshots = extractScreenshots(brainDir, text);
      for (const shot of screenshots) {
        frames.push({ path: shot.path, seq, caption: shot.caption, agent });
      }

      messages.push({
        seq,
        agent,
        text,
        time,
        ts: parseBoardTime(time),
        channel,
        mentions,
        all_targets,
        has_all,
        channel_mentions,
        screenshots,
        ...(control ? { control } : {}),
      });
    }
  }

  const unreadByMember = new Map<string, number>();
  for (const m of members.values()) {
    if (m.killed) {
      unreadByMember.set(m.name, 0);
      continue;
    }
    const subChannels = new Set(m.channels);
    let unread = 0;
    for (const msg of messages) {
      if (msg.seq <= m.last_read_seq) continue;
      if (msg.agent === m.name) continue;
      if (subChannels.has(msg.channel) || msg.mentions.includes(m.name) || msg.all_targets.includes(m.name)) {
        unread += 1;
      }
    }
    unreadByMember.set(m.name, unread);
  }

  const channels: SwarmChannelView[] = [...channelState.entries()]
    .map(([name, st]) => ({
      name,
      topic: st.topic,
      archived: st.archived,
      members: [...st.members].sort(),
      message_count: st.count,
      last_seq: st.lastSeq,
    }))
    .sort((a, b) => (a.name === DEFAULT_CHANNEL ? -1 : b.name === DEFAULT_CHANNEL ? 1 : a.name.localeCompare(b.name)));

  const totalMessages = messages.length;
  const truncated = totalMessages > MAX_MESSAGES_RETURNED || loaded?.truncated === true;
  const returnedMessages = totalMessages > MAX_MESSAGES_RETURNED ? messages.slice(-MAX_MESSAGES_RETURNED) : messages;

  return {
    headSeq,
    channels,
    messages: returnedMessages,
    totalMessages,
    truncated,
    edges: [...edgeMap.values()].sort((a, b) => b.total - a.total || b.last_seq - a.last_seq),
    postsByMember,
    unreadByMember,
    frames,
  };
}

function parsePlan(brainDir: string, swarmDir: string): SwarmPlanView | null {
  const raw = readJsonFile(brainDir, join(swarmDir, "plan.json"));
  if (!raw) return null;
  const goalObj = asObj(raw.goal);
  const goal = goalObj
    ? { title: asStr(goalObj.title, 200).trim(), line: asStr(goalObj.line, 400).trim() }
    : null;
  const tasks: Record<string, string> = {};
  const tasksObj = asObj(raw.tasks);
  if (tasksObj) {
    for (const [k, v] of Object.entries(tasksObj)) {
      if (MEMBER_RE.test(k) && typeof v === "string") tasks[k] = v.slice(0, 300);
    }
  }
  const threads: SwarmPlanView["threads"] = [];
  if (Array.isArray(raw.threads)) {
    for (let i = 0; i < raw.threads.length; i += 1) {
      const t = asObj(raw.threads[i]);
      if (!t) continue;
      const title = asStr(t.title, 200).trim();
      if (!title) continue;
      threads.push({
        id: asStr(t.id, 64) || `thread-${i + 1}`,
        title,
        goal: asStr(t.goal, 400).trim(),
        tasks: Array.isArray(t.tasks) ? t.tasks.filter((x): x is string => typeof x === "string" && MEMBER_RE.test(x)) : [],
      });
    }
  }
  return { goal: goal && (goal.title || goal.line) ? goal : null, tasks, threads };
}

const VALID_ATTN_KINDS = new Set<SwarmAttentionKind>(["decision", "failure", "review", "stuck", "quota", "error", "approval", "fyi"]);
const VALID_SEVERITIES = new Set<SwarmAttentionSeverity>(["high", "med", "low"]);
const VALID_WS_STATES = new Set<SwarmWorkstreamState>(["queued", "active", "blocked", "review", "done", "failed"]);

function sanitizeRefs(value: unknown, headSeq: number): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const n = typeof item === "number" ? item : typeof item === "string" ? Number(item.replace(/^#/, "")) : NaN;
    if (Number.isSafeInteger(n) && n >= 1 && (headSeq === 0 || n <= headSeq) && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 12);
}

function sanitizeWorkstream(raw: unknown, idx: number, headSeq: number): SwarmWorkstreamView | null {
  const ws = asObj(raw);
  if (!ws) return null;
  const title = asStr(ws.title, 200).trim();
  if (!title) return null;
  const rawState = asStr(ws.state, 20).toLowerCase() as SwarmWorkstreamState;
  const state: SwarmWorkstreamState = VALID_WS_STATES.has(rawState) ? rawState : "active";
  const prog = asObj(ws.progress);
  const progress =
    prog && typeof prog.done === "number" && typeof prog.total === "number" && prog.total > 0
      ? { done: Math.max(0, Math.round(prog.done)), total: Math.max(1, Math.round(prog.total)) }
      : undefined;
  return {
    id: asStr(ws.id, 64) || `ws-${idx + 1}`,
    title,
    owners: Array.isArray(ws.owners) ? ws.owners.filter((o): o is string => typeof o === "string" && MEMBER_RE.test(o)) : [],
    state,
    note: asStr(ws.note, 500).trim(),
    ...(typeof ws.short === "string" && ws.short.trim() ? { short: ws.short.trim().slice(0, 160) } : {}),
    ...(progress ? { progress } : {}),
    refs: sanitizeRefs(ws.refs, headSeq),
  };
}

function sanitizeAttention(raw: unknown, idx: number, headSeq: number): SwarmAttentionItem | null {
  const a = asObj(raw);
  if (!a) return null;
  const title = asStr(a.title, 200).trim();
  if (!title) return null;
  const rawKind = asStr(a.kind, 24).toLowerCase() as SwarmAttentionKind;
  const kind: SwarmAttentionKind = VALID_ATTN_KINDS.has(rawKind) ? rawKind : "fyi";
  const rawSev = asStr(a.severity, 12).toLowerCase() as SwarmAttentionSeverity;
  const severity: SwarmAttentionSeverity = VALID_SEVERITIES.has(rawSev) ? rawSev : "med";
  const refs = sanitizeRefs(a.refs, headSeq);
  const actions: SwarmAttentionAction[] = [];
  if (refs[0] !== undefined) {
    actions.push({ kind: "jump_seq", label: `View #${refs[0]}`, seq: refs[0] });
  }
  return {
    id: asStr(a.id, 64) || `attn-${idx + 1}`,
    kind,
    severity,
    title,
    why: asStr(a.why, 500).trim(),
    ...(typeof a.short === "string" && a.short.trim() ? { short: a.short.trim().slice(0, 160) } : {}),
    refs,
    source: "narrator",
    actions,
  };
}

function parseNarratorView(
  brainDir: string,
  swarmDir: string,
  members: Map<string, RawMember>,
  memberViews: Map<string, SwarmMemberView>,
  headSeq: number,
  extraFrames: SwarmFrameView[],
): SwarmNarratorView {
  let narratorMember: RawMember | null = null;
  for (const m of members.values()) {
    if (!m.killed && (m.role === "narrator" || /^narrator(?:-\d+)?$/.test(m.name))) {
      narratorMember = m;
      break;
    }
  }
  const candidates = [join(swarmDir, "view.json")];
  if (narratorMember && UUID_RE.test(narratorMember.conversation_id)) {
    candidates.push(join(brainDir, narratorMember.conversation_id, "swarm_view", "view.json"));
  }

  let raw: Obj | null = null;
  for (const candidate of candidates) {
    raw = readJsonFile(brainDir, candidate, MAX_VIEW_BYTES);
    if (raw) break;
  }

  const empty: SwarmNarratorView = {
    status: narratorMember ? (memberViews.get(narratorMember.name)?.status === "working" ? "active" : "idle") : "none",
    member: narratorMember?.name ?? null,
    as_of_seq: null,
    updated_at: null,
    headline: null,
    goal: null,
    running_summary: null,
    phase: null,
    now: {},
    attention: [],
    workstreams: [],
    threads: [],
    milestones: [],
    risks: [],
  };
  if (!raw) return empty;

  const asOfSeq = typeof raw.as_of_seq === "number" && Number.isSafeInteger(raw.as_of_seq) ? raw.as_of_seq : null;
  const stale = asOfSeq !== null && headSeq - asOfSeq >= 5;
  const status: SwarmNarratorView["status"] = stale
    ? "stale"
    : narratorMember
      ? memberViews.get(narratorMember.name)?.status === "working" ? "active" : "idle"
      : "idle";

  const goalObj = asObj(raw.goal);
  const goal = goalObj && (asStr(goalObj.title, 200).trim() || asStr(goalObj.line, 400).trim())
    ? { title: asStr(goalObj.title, 200).trim(), line: asStr(goalObj.line, 400).trim() }
    : null;

  const phaseObj = asObj(raw.phase);
  const phase = phaseObj && asStr(phaseObj.label, 80).trim()
    ? { label: asStr(phaseObj.label, 80).trim(), index: Math.max(1, asNum(phaseObj.index, 1)), total: Math.max(1, asNum(phaseObj.total, 1)) }
    : null;

  const now: Record<string, string> = {};
  const nowObj = asObj(raw.now);
  if (nowObj) {
    for (const [k, v] of Object.entries(nowObj)) {
      if (MEMBER_RE.test(k) && typeof v === "string") now[k] = v.slice(0, 200);
    }
  }

  const attention = Array.isArray(raw.attention)
    ? raw.attention.map((item, idx) => sanitizeAttention(item, idx, headSeq)).filter((x): x is SwarmAttentionItem => x !== null)
    : [];
  const workstreams = Array.isArray(raw.workstreams)
    ? raw.workstreams.map((item, idx) => sanitizeWorkstream(item, idx, headSeq)).filter((x): x is SwarmWorkstreamView => x !== null)
    : [];

  const threads: SwarmThreadView[] = [];
  if (Array.isArray(raw.threads)) {
    for (let i = 0; i < raw.threads.length; i += 1) {
      const t = asObj(raw.threads[i]);
      if (!t) continue;
      const title = asStr(t.title, 200).trim();
      if (!title) continue;
      threads.push({
        id: asStr(t.id, 64) || `nthread-${i + 1}`,
        title,
        goal: asStr(t.goal, 400).trim(),
        now: asStr(t.now, 300).trim(),
        workstreams: Array.isArray(t.workstreams)
          ? t.workstreams.map((w, idx) => sanitizeWorkstream(w, idx, headSeq)).filter((x): x is SwarmWorkstreamView => x !== null)
          : [],
        attention: Array.isArray(t.attention)
          ? t.attention.map((a, idx) => sanitizeAttention(a, idx, headSeq)).filter((x): x is SwarmAttentionItem => x !== null)
          : [],
      });
    }
  }

  const milestones: SwarmNarratorView["milestones"] = [];
  if (Array.isArray(raw.milestones)) {
    for (const item of raw.milestones.slice(0, 20)) {
      const m = asObj(item);
      if (!m) continue;
      const title = asStr(m.title, 200).trim();
      if (title) milestones.push({ title, state: asStr(m.state, 32) || "pending", note: asStr(m.note, 300).trim() });
    }
  }

  const risks: SwarmNarratorView["risks"] = [];
  if (Array.isArray(raw.risks)) {
    for (const item of raw.risks.slice(0, 20)) {
      const r = asObj(item);
      if (!r) continue;
      const title = asStr(r.title, 200).trim();
      if (title) risks.push({ title, severity: asStr(r.severity, 16) || "med", note: asStr(r.note, 300).trim() });
    }
  }

  const reelObj = asObj(raw.reel);
  if (reelObj && Array.isArray(reelObj.frames)) {
    const seen = new Set(extraFrames.map((f) => f.path));
    for (const item of reelObj.frames.slice(0, 40)) {
      const f = asObj(item);
      if (!f || typeof f.path !== "string") continue;
      const real = safeFilePath(brainDir, f.path);
      if (!real || seen.has(real)) continue;
      if (!(extname(real).toLowerCase() in FRAME_MIMES)) continue;
      seen.add(real);
      extraFrames.push({
        path: real,
        seq: typeof f.seq === "number" && Number.isSafeInteger(f.seq) ? f.seq : null,
        caption: asStr(f.caption, 200).trim(),
      });
    }
  }

  return {
    status,
    member: narratorMember?.name ?? null,
    as_of_seq: asOfSeq,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at.slice(0, 64) : null,
    headline: typeof raw.headline === "string" && raw.headline.trim() ? raw.headline.trim().slice(0, 240) : null,
    goal,
    running_summary: typeof raw.running_summary === "string" && raw.running_summary.trim() ? raw.running_summary.trim().slice(0, 600) : null,
    phase,
    now,
    attention,
    workstreams,
    threads,
    milestones,
    risks,
  };
}

/** Builds a full, live swarm snapshot for an Antigravity conversation, or null when not in a swarm. */
export function readSwarmSnapshot(root: string, convId: string, nowMs = Date.now(), extraModels: string[] = []): SwarmSnapshot | null {
  const located = findSwarmForConversation(root, convId, nowMs);
  if (!located) return null;
  const rawMembers = readJsonFile(located.brainDir, join(located.swarmDir, "members.json"));
  if (!rawMembers) return null;
  const { title, members: rawMap } = parseMembersFile(rawMembers);
  const board = parseBoard(located.brainDir, located.swarmDir, rawMap);

  const memberViewMap = new Map<string, SwarmMemberView>();
  const systemAttention: SwarmAttentionItem[] = [];
  const modelSet = new Set<string>([...extraModels, ...KNOWN_MODELS]);

  for (const m of rawMap.values()) {
    const inspected = inspectMemberTranscript(located.brainDir, m, nowMs);
    const roleWorker = isRoleWorker(m.name, m.role);
    if (m.model) modelSet.add(m.model);
    const view: SwarmMemberView = {
      name: m.name,
      conversation_id: m.conversation_id,
      model: m.model,
      role: m.role,
      role_worker: roleWorker,
      status: inspected.status,
      wake_mode: m.wake_mode,
      wait_since: m.wait_since,
      last_read_seq: m.last_read_seq,
      killed: m.killed,
      channels: m.channels,
      workspace_mode: m.workspace_mode,
      workspace: m.workspace,
      steps: inspected.steps,
      posts: board.postsByMember.get(m.name) ?? 0,
      unread: board.unreadByMember.get(m.name) ?? 0,
      activity: inspected.activity,
      last_active_at: inspected.lastActiveAt,
      failure: inspected.failure,
    };
    memberViewMap.set(m.name, view);

    if (inspected.failure && !m.killed) {
      const f = inspected.failure;
      const actions: SwarmAttentionAction[] = [{ kind: "open_member", label: "Inspect", member: m.name }];
      if (f.kind === "quota") actions.push({ kind: "switch_model", label: "Switch model", member: m.name });
      else if (f.kind === "approval") actions.push({ kind: "open_terminal", label: "Open terminal", member: m.name });
      else if (f.kind === "stuck" || f.kind === "error") actions.push({ kind: "nudge", label: "Nudge", member: m.name });
      systemAttention.push({
        id: `sys:${m.name}:${f.kind}`,
        kind: f.kind,
        severity: f.kind === "approval" || f.kind === "quota" || f.kind === "error" ? "high" : "med",
        title:
          f.kind === "quota"
            ? `@${m.name} hit quota or rate limit`
            : f.kind === "approval"
              ? `@${m.name} needs approval`
              : f.kind === "stuck"
                ? `@${m.name} may be stuck`
                : `@${m.name} hit an error`,
        why: f.message,
        refs: [],
        member: m.name,
        source: "system",
        actions,
      });
    }
  }

  const statusRank: Record<SwarmMemberStatus, number> = { blocked: 0, working: 1, waiting: 2, killed: 3 };
  const members = [...memberViewMap.values()].sort((a, b) => {
    if (a.role_worker !== b.role_worker) return a.role_worker ? 1 : -1;
    if (a.name === "coordinator" && b.name !== "coordinator") return -1;
    if (b.name === "coordinator" && a.name !== "coordinator") return 1;
    if (statusRank[a.status] !== statusRank[b.status]) return statusRank[a.status] - statusRank[b.status];
    return a.name.localeCompare(b.name);
  });

  const plan = parsePlan(located.brainDir, located.swarmDir);
  const frames = [...board.frames];
  const narrator = parseNarratorView(located.brainDir, located.swarmDir, rawMap, memberViewMap, board.headSeq, frames);

  let working = 0;
  let waiting = 0;
  let blocked = 0;
  let killed = 0;
  let roleWorkers = 0;
  let workersWorking = 0;
  let workersTotal = 0;
  let coordinatorStatus: SwarmMemberStatus | null = null;

  for (const m of members) {
    if (m.role_worker) {
      if (!m.killed) roleWorkers += 1;
      continue;
    }
    if (m.name === "coordinator") coordinatorStatus = m.status;
    if (m.killed) {
      killed += 1;
      continue;
    }
    if (m.name !== "coordinator") {
      workersTotal += 1;
      if (m.status === "working" || m.status === "blocked") workersWorking += 1;
    }
    if (m.status === "blocked") blocked += 1;
    else if (m.status === "working") working += 1;
    else if (m.status === "waiting") waiting += 1;
  }

  const narratorAttnCount =
    narrator.attention.length + narrator.threads.reduce((acc, t) => acc + t.attention.length, 0);

  const counts: SwarmCounts = {
    active: working + waiting + blocked,
    working,
    waiting,
    blocked,
    killed,
    role_workers: roleWorkers,
    attention: systemAttention.length + narratorAttnCount,
    workers_working: workersWorking,
    workers_total: workersTotal,
    coordinator_status: coordinatorStatus,
  };

  const displayTitle = title || narrator.goal?.title || plan?.goal?.title || "Swarm";
  const digestSource = JSON.stringify({
    coordinatorId: located.coordinatorId,
    title: displayTitle,
    headSeq: board.headSeq,
    totalMessages: board.totalMessages,
    members: members.map((m) => [m.name, m.status, m.model, m.steps, m.posts, m.unread, m.activity, m.failure?.kind, m.killed]),
    channels: board.channels.map((c) => [c.name, c.archived, c.message_count, c.last_seq]),
    plan,
    narrator: [narrator.status, narrator.as_of_seq, narrator.updated_at, narrator.headline, narrator.attention.length, narrator.workstreams.length],
    frames: frames.map((f) => [f.path, f.seq]),
  });
  const etag = createHash("sha256").update(digestSource).digest("base64url").slice(0, 16);

  return {
    coordinator_id: located.coordinatorId,
    me: located.me,
    title: displayTitle,
    head_seq: board.headSeq,
    counts,
    members,
    channels: board.channels,
    messages: board.messages,
    total_messages: board.totalMessages,
    messages_truncated: board.truncated,
    edges: board.edges,
    plan,
    narrator,
    system_attention: systemAttention,
    frames,
    models: [...modelSet],
    etag,
  };
}

function unwrapUserRequest(content: string): string {
  if (!content.startsWith("<USER_REQUEST>")) return content;
  const end = content.lastIndexOf("</USER_REQUEST>");
  if (end < 0) return content;
  return content.slice("<USER_REQUEST>".length, end).replace(/^\n|\n$/g, "");
}

/** Reads a bounded, structured live transcript for one member of a swarm. */
export function readSwarmMemberTranscript(
  root: string,
  convId: string,
  memberName: string,
  options: { limit?: number; nowMs?: number } = {},
): SwarmMemberTranscript | null {
  if (!MEMBER_RE.test(memberName)) return null;
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(10, Math.min(200, options.limit ?? 80));
  const located = findSwarmForConversation(root, convId, nowMs);
  if (!located) return null;
  const rawMembers = readJsonFile(located.brainDir, join(located.swarmDir, "members.json"));
  if (!rawMembers) return null;
  const { members: rawMap } = parseMembersFile(rawMembers);
  const rawMember = rawMap.get(memberName);
  if (!rawMember) return null;

  const inspected = inspectMemberTranscript(located.brainDir, rawMember, nowMs);
  const member: SwarmMemberView = {
    name: rawMember.name,
    conversation_id: rawMember.conversation_id,
    model: rawMember.model,
    role: rawMember.role,
    role_worker: isRoleWorker(rawMember.name, rawMember.role),
    status: inspected.status,
    wake_mode: rawMember.wake_mode,
    wait_since: rawMember.wait_since,
    last_read_seq: rawMember.last_read_seq,
    killed: rawMember.killed,
    channels: rawMember.channels,
    workspace_mode: rawMember.workspace_mode,
    workspace: rawMember.workspace,
    steps: inspected.steps,
    posts: 0,
    unread: 0,
    activity: inspected.activity,
    last_active_at: inspected.lastActiveAt,
    failure: inspected.failure,
  };

  const path = findMemberTranscriptPath(located.brainDir, rawMember.conversation_id, true);
  if (!path) return { member, events: [], total_steps: 0, truncated: false };
  const loaded = readBoundedFile(path, MAX_MEMBER_TRANSCRIPT_BYTES);
  if (!loaded) return { member, events: [], total_steps: 0, truncated: false };

  const events: MemberTranscriptEvent[] = [];
  let maxStepIndex = 0;

  for (const line of loaded.text.split("\n")) {
    const step = parseStepLine(line);
    if (!step) continue;
    if (step.step_index >= maxStepIndex) maxStepIndex = step.step_index + 1;

    if (step.type === "USER_INPUT") {
      const text = unwrapUserRequest(step.content).trim();
      if (text) {
        events.push({ step_index: step.step_index, kind: "user", ts: step.created_at, status: step.status, text: text.slice(0, 4000) });
      }
      continue;
    }
    if (step.type === "ERROR_MESSAGE") {
      events.push({
        step_index: step.step_index,
        kind: "error",
        ts: step.created_at,
        status: step.status || "ERROR",
        text: step.content.trim().slice(0, 3000) || "Error",
        error: true,
      });
      continue;
    }
    if (step.type === "SYSTEM_MESSAGE") {
      const text = step.content.trim();
      if (text) {
        events.push({ step_index: step.step_index, kind: "system", ts: step.created_at, status: step.status, text: text.slice(0, 2000) });
      }
      continue;
    }
    if (step.type === "PLANNER_RESPONSE") {
      if (step.thinking.trim()) {
        events.push({ step_index: step.step_index, kind: "thinking", ts: step.created_at, status: step.status, text: step.thinking.trim().slice(0, 2500) });
      }
      if (step.content.trim()) {
        events.push({ step_index: step.step_index, kind: "assistant", ts: step.created_at, status: step.status, text: step.content.trim().slice(0, 4000) });
      }
      for (const call of step.tool_calls) {
        const inputText = Object.keys(call.args).length > 0 ? JSON.stringify(call.args, null, 2).slice(0, 1200) : "";
        events.push({
          step_index: step.step_index,
          kind: "tool",
          ts: step.created_at,
          status: step.status,
          tool_name: call.name,
          tool_summary: summarizeToolCall(call.name, call.args),
          ...(inputText ? { tool_input: inputText } : {}),
        });
      }
      continue;
    }
    if (step.type === "GENERIC") {
      const text = step.content.trim();
      const isErr = step.status === "ERROR";
      const isBlocked = BLOCKED_STATUSES.has(step.status);
      if (text || isErr || isBlocked) {
        events.push({
          step_index: step.step_index,
          kind: "tool_output",
          ts: step.created_at,
          status: step.status,
          text: text.slice(0, 2000) || (isBlocked ? "Waiting for user approval" : "Error"),
          error: isErr,
        });
      }
    }
  }

  const truncated = loaded.truncated || events.length > limit;
  const sliced = events.length > limit ? events.slice(-limit) : events;
  return {
    member,
    events: sliced,
    total_steps: Math.max(maxStepIndex, member.steps),
    truncated,
  };
}

/** Validates a swarm screenshot path inside brain/ (plain file, supported extension, <= 8 MiB). */
export function resolveSwarmFrameFile(
  root: string,
  convId: string,
  requestedPath: string,
  nowMs = Date.now(),
): { path: string; mime: string } | null {
  const snapshot = readSwarmSnapshot(root, convId, nowMs);
  if (!snapshot) return null;
  const brainDir = canonicalBrainDir(root);
  if (!brainDir) return null;
  const canonical = safeFilePath(brainDir, requestedPath);
  if (!canonical) return null;
  if (!snapshot.frames.some((frame) => frame.path === canonical)) return null;
  const ext = extname(canonical).toLowerCase();
  const mime = FRAME_MIMES[ext];
  if (!mime) return null;
  try {
    const st = statSync(canonical);
    if (!st.isFile() || st.size > MAX_FRAME_BYTES) return null;
  } catch {
    return null;
  }
  return { path: canonical, mime };
}

/**
 * Copies validated swarm screenshots into `imageDir/swarm-frames/` so GPUI `image(rel)` and `Viewer`
 * can display and enlarge them both locally and across remote Herdr machines.
 */
export function materializeSwarmFrames(snapshot: SwarmSnapshot, root: string, imageDir: string): void {
  const brainDir = canonicalBrainDir(root);
  if (!brainDir) return;
  const outDir = join(imageDir, "swarm-frames");
  const copied = new Map<string, string>();
  const ensureCopy = (srcPath: string): string | undefined => {
    if (copied.has(srcPath)) return copied.get(srcPath);
    const canonical = safeFilePath(brainDir, srcPath);
    if (!canonical) return undefined;
    const ext = extname(canonical).toLowerCase();
    if (!(ext in FRAME_MIMES)) return undefined;
    try {
      const st = statSync(canonical);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_FRAME_BYTES) return undefined;
      const digest = createHash("sha1").update(canonical).update(`:${st.size}:${Math.trunc(st.mtimeMs)}`).digest("hex").slice(0, 16);
      const dest = join(outDir, `${digest}${ext}`);
      if (!existsSync(dest)) {
        mkdirSync(outDir, { recursive: true, mode: 0o700 });
        copyFileSync(canonical, dest);
      }
      copied.set(srcPath, dest);
      return dest;
    } catch {
      return undefined;
    }
  };
  for (const frame of snapshot.frames) {
    const local = ensureCopy(frame.path);
    if (local) frame.local_path = local;
  }
  for (const msg of snapshot.messages) {
    for (const shot of msg.screenshots) {
      const local = ensureCopy(shot.path);
      if (local) shot.local_path = local;
    }
  }
}

// ---------------------------------------------------------------- actions

function assertSafeText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  if (!value.trim() || value.length > max || CONTROL_CHAR_RE.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return value.replace(/\r\n?/g, "\n").trim();
}

export function parseSwarmAction(raw: unknown): SwarmActionRequest {
  const obj = asObj(raw);
  if (!obj || typeof obj.action !== "string") throw new Error("Missing swarm action");
  switch (obj.action) {
    case "start":
      return { action: "start", task: assertSafeText(obj.task, "task", 4000) };
    case "post": {
      const target = typeof obj.target === "string" ? obj.target.trim() : "";
      if (target !== "all" && target !== "coordinator" && !MEMBER_RE.test(target)) {
        throw new Error("Invalid target");
      }
      const channel = typeof obj.channel === "string" && obj.channel.trim() ? obj.channel.trim() : undefined;
      if (channel && !CHANNEL_RE.test(channel)) throw new Error("Invalid channel");
      return { action: "post", target, ...(channel ? { channel } : {}), message: assertSafeText(obj.message, "message", 4000) };
    }
    case "model": {
      const member = typeof obj.member === "string" ? obj.member.trim() : "";
      const model = typeof obj.model === "string" ? obj.model.trim() : "";
      if (!MEMBER_RE.test(member)) throw new Error("Invalid member");
      if (!MODEL_RE.test(model)) throw new Error("Invalid model");
      return { action: "model", member, model };
    }
    case "kill": {
      const member = typeof obj.member === "string" ? obj.member.trim() : "";
      if (!MEMBER_RE.test(member) || member === "coordinator") throw new Error("Cannot kill coordinator or invalid member");
      return { action: "kill", member };
    }
    case "add": {
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!MEMBER_RE.test(name) || name === "all" || name === "coordinator" || name.startsWith("coordinator-")) {
        throw new Error("Invalid or reserved worker name");
      }
      const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : undefined;
      if (model && !MODEL_RE.test(model)) throw new Error("Invalid model");
      const ws = obj.workspace;
      const workspace = ws === "inherit" || ws === "share" || ws === "branch" ? ws : undefined;
      if (ws !== undefined && workspace === undefined) throw new Error("Invalid workspace mode");
      return {
        action: "add",
        name,
        brief: assertSafeText(obj.brief, "brief", 4000),
        ...(model ? { model } : {}),
        ...(workspace ? { workspace } : {}),
      };
    }
    case "nudge": {
      const member = typeof obj.member === "string" ? obj.member.trim() : "";
      if (!MEMBER_RE.test(member)) throw new Error("Invalid member");
      const note = typeof obj.note === "string" && obj.note.trim() ? assertSafeText(obj.note, "note", 1000) : undefined;
      return { action: "nudge", member, ...(note ? { note } : {}) };
    }
    case "title":
      return { action: "title", title: assertSafeText(obj.title, "title", 160) };
    default:
      throw new Error(`Unknown swarm action: ${obj.action}`);
  }
}

export function buildSwarmActionPrompt(req: SwarmActionRequest): string {
  switch (req.action) {
    case "start":
      return `/swarm ${req.task}`;
    case "post": {
      if (req.target === "coordinator") return req.message;
      const recipient = req.target === "all" ? "@all" : `@${req.target}`;
      const ch = req.channel && req.channel !== DEFAULT_CHANNEL ? ` in #${req.channel}` : "";
      return `Post to the swarm board${ch} for ${recipient}:\n${req.message}`;
    }
    case "model":
      if (req.member === "coordinator") return `/model ${req.model}`;
      return `Switch swarm worker @${req.member} to model ${req.model} using swarm{action:"model", name:"${req.member}", model:"${req.model}"}.`;
    case "kill":
      return `Permanently stop and remove swarm worker @${req.member} using swarm{action:"kill", name:"${req.member}"}.`;
    case "add": {
      const opts = [
        `name:"${req.name}"`,
        ...(req.model ? [`model:"${req.model}"`] : []),
        ...(req.workspace ? [`workspace:"${req.workspace}"`] : []),
      ].join(", ");
      return `Spawn a new swarm worker using swarm{action:"add", ${opts}} with this brief:\n${req.brief}`;
    }
    case "nudge": {
      const extra = req.note ? `: ${req.note}` : ".";
      return `Check on swarm worker @${req.member} and nudge or unstick them${extra}`;
    }
    case "title":
      return `Set the swarm title to ${JSON.stringify(req.title)} using swarm{action:"title"}.`;
  }
}

// ---------------------------------------------------------------- themed SVG communication graph

export interface SwarmGraphNode {
  name: string;
  status: SwarmMemberStatus;
  x: number;
  y: number;
  posts: number;
  activeAtStep: boolean;
}

export interface SwarmGraphEdge {
  from: string;
  to: string;
  direct: number;
  viaAll: number;
  count: number;
  activeAtStep: boolean;
}

export interface SwarmGraphLayout {
  nodes: SwarmGraphNode[];
  edges: SwarmGraphEdge[];
  width: number;
  height: number;
  activeMessage: SwarmMessageView | null;
  allPostCount: number;
}

export interface SwarmGraphOptions {
  replaySeq?: number | null;
  expandAll?: boolean;
  hideInactive?: boolean;
}

const DARK_NODE_PALETTE = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6", "#2dd4bf", "#fb923c", "#818cf8"];
const LIGHT_NODE_PALETTE = ["#0284c7", "#7c3aed", "#059669", "#b45309", "#be185d", "#0f766e", "#c2410c", "#4f46e5"];

function nodePaletteColor(name: string, dark: boolean): string {
  const palette = dark ? DARK_NODE_PALETTE : LIGHT_NODE_PALETTE;
  if (name === "coordinator") return palette[0]!;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  return palette[Math.abs(hash) % palette.length]!;
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function computeSwarmGraph(snapshot: SwarmSnapshot, opts: SwarmGraphOptions = {}): SwarmGraphLayout {
  const width = 640;
  const height = 380;
  const maxSeq = opts.replaySeq ?? snapshot.head_seq;
  const visibleMessages = snapshot.messages.filter((m) => m.seq <= maxSeq);
  const activeMessage =
    opts.replaySeq != null
      ? visibleMessages.find((m) => m.seq === opts.replaySeq) ?? visibleMessages.at(-1) ?? null
      : visibleMessages.at(-1) ?? null;

  const taskMembers = snapshot.members.filter((m) => !m.role_worker && (!opts.hideInactive || m.status === "working" || m.status === "blocked"));
  const memberSet = new Set(taskMembers.map((m) => m.name));
  const postsUpTo = new Map<string, number>();
  const edgeMap = new Map<string, SwarmGraphEdge>();
  let allPostCount = 0;

  for (const msg of visibleMessages) {
    postsUpTo.set(msg.agent, (postsUpTo.get(msg.agent) ?? 0) + 1);
    if (msg.has_all) allPostCount += 1;
    if (!memberSet.has(msg.agent)) continue;
    const isStep = activeMessage?.seq === msg.seq;
    for (const to of msg.mentions) {
      if (!memberSet.has(to) || to === msg.agent) continue;
      const key = `${msg.agent}->${to}`;
      const existing = edgeMap.get(key) ?? { from: msg.agent, to, direct: 0, viaAll: 0, count: 0, activeAtStep: false };
      existing.direct += 1;
      existing.count += 1;
      if (isStep) existing.activeAtStep = true;
      edgeMap.set(key, existing);
    }
    if (opts.expandAll) {
      for (const to of msg.all_targets) {
        if (!memberSet.has(to) || to === msg.agent || msg.mentions.includes(to)) continue;
        const key = `${msg.agent}->${to}`;
        const existing = edgeMap.get(key) ?? { from: msg.agent, to, direct: 0, viaAll: 0, count: 0, activeAtStep: false };
        existing.viaAll += 1;
        existing.count += 1;
        if (isStep) existing.activeAtStep = true;
        edgeMap.set(key, existing);
      }
    }
  }

  const ordered = [...taskMembers].sort((a, b) => {
    if (a.name === "coordinator") return -1;
    if (b.name === "coordinator") return 1;
    return a.name.localeCompare(b.name);
  });

  const cx = width / 2;
  const cy = height / 2 + 6;
  const rx = Math.min(220, Math.max(120, ordered.length * 36));
  const ry = Math.min(126, Math.max(92, ordered.length * 22));
  const nodes: SwarmGraphNode[] = ordered.map((member, idx) => {
    const angle = ordered.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (idx / ordered.length) * Math.PI * 2;
    const x = ordered.length === 1 ? cx : Math.round(cx + Math.cos(angle) * rx);
    const y = ordered.length === 1 ? cy : Math.round(cy + Math.sin(angle) * ry);
    const activeAtStep = Boolean(
      activeMessage &&
        (activeMessage.agent === member.name ||
          activeMessage.mentions.includes(member.name) ||
          (opts.expandAll && activeMessage.all_targets.includes(member.name))),
    );
    return {
      name: member.name,
      status: member.status,
      x,
      y,
      posts: postsUpTo.get(member.name) ?? 0,
      activeAtStep,
    };
  });

  return {
    nodes,
    edges: [...edgeMap.values()],
    width,
    height,
    activeMessage,
    allPostCount,
  };
}

function edgePath(from: SwarmGraphNode, to: SwarmGraphNode, hasReverse: boolean): { d: string; mx: number; my: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const r = 24;
  const sx = from.x + (dx / dist) * r;
  const sy = from.y + (dy / dist) * r;
  const ex = to.x - (dx / dist) * (r + 6);
  const ey = to.y - (dy / dist) * (r + 6);
  const curve = hasReverse ? 24 : 9;
  const nx = -dy / dist;
  const ny = dx / dist;
  const cx = (sx + ex) / 2 + nx * curve;
  const cy = (sy + ey) / 2 + ny * curve;
  return {
    d: `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
    mx: (sx + 2 * cx + ex) / 4,
    my: (sy + 2 * cy + ey) / 4,
  };
}

/** Renders a standalone, crisp themed SVG for the swarm communication graph. */
export function renderSwarmGraphSvg(graph: SwarmGraphLayout, theme: Theme): string {
  const dark = theme.dark !== false;
  const bg = theme.background || (dark ? "#16181c" : "#ffffff");
  const fg = theme.foreground || (dark ? "#e5e7eb" : "#111827");
  const muted = theme.muted || (dark ? "#8b949e" : "#6b7280");
  const border = theme.border || (dark ? "#2f3542" : "#d1d5db");
  const accent = theme.accent || (dark ? "#60a5fa" : "#2563eb");
  const green = theme.ansi2 || (dark ? "#34d399" : "#16a34a");
  const red = theme.ansi1 || (dark ? "#f87171" : "#dc2626");
  const surface = dark ? "#1f232b" : "#f8fafc";

  const nodeByName = new Map(graph.nodes.map((n) => [n.name, n]));
  const edgeKeys = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));
  const maxWeight = Math.max(1, ...graph.edges.map((e) => e.count));

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${graph.width}" height="${graph.height}" viewBox="0 0 ${graph.width} ${graph.height}">`,
    `<defs>`,
    `<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="${muted}"/></marker>`,
    `<marker id="arrow-active" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="${accent}"/></marker>`,
    `</defs>`,
    `<rect x="0" y="0" width="${graph.width}" height="${graph.height}" rx="10" fill="${bg}"/>`,
  ];

  for (const edge of graph.edges) {
    const from = nodeByName.get(edge.from);
    const to = nodeByName.get(edge.to);
    if (!from || !to) continue;
    const hasRev = edgeKeys.has(`${edge.to}->${edge.from}`);
    const { d, mx, my } = edgePath(from, to, hasRev);
    const widthPx = (1.3 + (edge.count / maxWeight) * 2.6).toFixed(2);
    const isAllOnly = edge.direct === 0 && edge.viaAll > 0;
    const stroke = edge.activeAtStep ? accent : muted;
    const opacity = edge.activeAtStep ? "0.96" : isAllOnly ? "0.45" : "0.68";
    const dash = isAllOnly ? ` stroke-dasharray="4 3"` : "";
    const marker = edge.activeAtStep ? "url(#arrow-active)" : "url(#arrow)";
    parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-opacity="${opacity}" stroke-width="${edge.activeAtStep ? Math.max(2.6, Number(widthPx)) : widthPx}"${dash} marker-end="${marker}"/>`);
    if (edge.count > 1 || edge.activeAtStep) {
      parts.push(
        `<g transform="translate(${mx.toFixed(1)}, ${my.toFixed(1)})">` +
        `<rect x="-11" y="-8" width="22" height="16" rx="7" fill="${surface}" stroke="${edge.activeAtStep ? accent : border}" stroke-width="1"/>` +
        `<text x="0" y="3.5" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" font-weight="600" fill="${edge.activeAtStep ? accent : fg}">${edge.count}</text>` +
        `</g>`,
      );
    }
  }

  for (const node of graph.nodes) {
    const ring = nodePaletteColor(node.name, dark);
    const dot =
      node.status === "blocked" ? red
        : node.status === "working" ? green
          : node.status === "killed" ? border
            : muted;
    const label = node.name.length > 14 ? `${node.name.slice(0, 13)}…` : node.name;
    const labelAbove = node.y < graph.height / 2 - 30;
    const nodeOpacity = node.status === "killed" ? "0.48" : "1";
    const initial = escapeXml(node.name.slice(0, 2).toUpperCase());
    parts.push(`<g transform="translate(${node.x}, ${node.y})" opacity="${nodeOpacity}">`);
    if (node.activeAtStep) {
      parts.push(`<circle r="27" fill="none" stroke="${accent}" stroke-opacity="0.45" stroke-width="2.5"/>`);
    }
    parts.push(`<circle r="22" fill="${surface}" stroke="${ring}" stroke-width="${node.activeAtStep ? "2.6" : "2"}"/>`);
    parts.push(`<circle cx="15" cy="-15" r="5" fill="${dot}" stroke="${bg}" stroke-width="1.8"/>`);
    parts.push(`<text x="0" y="4" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11.5" font-weight="700" fill="${fg}">${initial}</text>`);
    parts.push(`<text x="0" y="${labelAbove ? -29 : 36}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11.5" font-weight="600" fill="${fg}">@${escapeXml(label)}</text>`);
    parts.push(`</g>`);
  }

  if (graph.nodes.length === 0) {
    parts.push(`<text x="${graph.width / 2}" y="${graph.height / 2}" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="13" fill="${muted}">No agents match this graph filter</text>`);
  }

  parts.push(`</svg>`);
  return parts.join("");
}

export interface SwarmGraphSvgResult {
  path: string | null;
  w: number;
  h: number;
  nodes: SwarmGraphNode[];
  edges: SwarmGraphEdge[];
  activeMessage: SwarmMessageView | null;
  allPostCount: number;
}

/** Computes layout and writes a cached themed SVG under `imageDir/swarm-graphs/` for GPUI `image(rel)`. */
export function writeSwarmGraphSvg(
  snapshot: SwarmSnapshot,
  opts: SwarmGraphOptions,
  theme: Theme,
  imageDir: string | null,
): SwarmGraphSvgResult {
  const graph = computeSwarmGraph(snapshot, opts);
  let path: string | null = null;
  if (imageDir) {
    const svg = renderSwarmGraphSvg(graph, theme);
    const digest = createHash("sha1").update(svg).digest("hex").slice(0, 16);
    const outDir = join(imageDir, "swarm-graphs");
    const dest = join(outDir, `graph-${digest}.svg`);
    try {
      if (!existsSync(dest)) {
        mkdirSync(outDir, { recursive: true, mode: 0o700 });
        writeFileSync(dest, svg, { mode: 0o600 });
      }
      path = dest;
    } catch {
      path = null;
    }
  }
  return {
    path,
    w: graph.width,
    h: graph.height,
    nodes: graph.nodes,
    edges: graph.edges,
    activeMessage: graph.activeMessage,
    allPostCount: graph.allPostCount,
  };
}
