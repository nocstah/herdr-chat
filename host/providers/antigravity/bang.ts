// Run a `! <command>` in Antigravity CLI's (`agy`) built-in bash/shell mode over
// `hc connect` (herdr-core generation-1 framed protocol).
//
// `hc send` wraps its text in bracketed paste (`\x1b[200~…\x1b[201~`), which `agy`
// delivers to Bubble Tea with `Paste: true` and therefore does NOT trigger `agy`'s
// `!` ShellMode — submitting `!cmd` as an ordinary LLM prompt instead. Typing a raw
// un-bracketed `!` over a short `terminal.attach` stream switches `agy` into bash
// mode (`!` chevron / `activated bash mode`), after which the command is bracketed-
// pasted and submitted with `\r`. The command and Enter are NEVER sent unless the
// screen confirms bash mode opened.
import { spawn } from "node:child_process";
import { agyInShellMode } from "./screen.ts";

const HC_GENERATION = 1;
const HEADER_BYTES = 9;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const FRAME_DATA = 0;
const FRAME_CREDIT = 1;
const FRAME_CLOSE = 2;
const FRAME_RESIZE = 3;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export interface SendAgyBangOptions {
  hc: string;
  terminal: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shellWaitMs?: number;
  pollMs?: number;
  enterDelayMs?: number;
}

function encodeFrame(channel: number, kind: number, payload: Buffer | Uint8Array | string): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length);
  frame.writeUInt32LE(channel, 0);
  frame[4] = kind;
  frame.writeUInt32LE(body.length, 5);
  body.copy(frame, HEADER_BYTES);
  return frame;
}

function encodeCredit(bytes: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(bytes, 0);
  return buf;
}

function encodeResize(cols: number, rows: number): Buffer {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt16LE(cols, 0);
  buf.writeUInt16LE(rows, 2);
  return buf;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendAgyBang(opts: SendAgyBangOptions): Promise<void> {
  const cmd = opts.command.replace(/\x1b\[20[01]~/g, "").trim();
  if (!cmd) throw new Error("Empty shell command.");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const shellWaitMs = opts.shellWaitMs ?? 1_500;
  const pollMs = opts.pollMs ?? 50;
  const enterDelayMs = opts.enterDelayMs ?? 80;

  const child = spawn(opts.hc, ["connect"], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(opts.env ? { env: opts.env } : {}),
  });

  let closed = false;
  let framed = false;
  let plain: Buffer = Buffer.alloc(0);
  let pendingBuf: Buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const closeWaiters = new Map<number, () => void>();
  let helloResolve!: () => void;
  let helloReject!: (e: Error) => void;
  const helloReady = new Promise<void>((res, rej) => {
    helloResolve = res;
    helloReject = rej;
  });
  helloReady.catch(() => {});

  const failAll = (err: Error) => {
    if (closed) return;
    closed = true;
    helloReject(err);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    for (const w of closeWaiters.values()) w();
    closeWaiters.clear();
  };

  const writeRaw = (buf: Buffer) => {
    if (!closed && child.stdin.writable) child.stdin.write(buf);
  };

  const handleFrame = (channel: number, kind: number, payload: Buffer) => {
    if (channel === 0) {
      if (kind !== FRAME_DATA) return;
      let msg: any;
      try {
        msg = JSON.parse(payload.toString("utf8"));
      } catch {
        failAll(new Error("hc connect sent invalid JSON"));
        return;
      }
      if (typeof msg?.id !== "number") return;
      const call = pending.get(msg.id);
      if (!call) return;
      pending.delete(msg.id);
      if (msg.error) {
        call.reject(new Error(typeof msg.error.message === "string" ? msg.error.message : "hc refused the call"));
      } else {
        call.resolve(msg.result);
      }
      return;
    }
    if (kind === FRAME_DATA) {
      if (payload.length > 0) writeRaw(encodeFrame(channel, FRAME_CREDIT, encodeCredit(payload.length)));
    } else if (kind === FRAME_CLOSE) {
      const done = closeWaiters.get(channel);
      if (done) {
        closeWaiters.delete(channel);
        done();
      }
    }
  };

  const pumpFrames = (chunk: Buffer) => {
    let buf = pendingBuf.length === 0 ? chunk : Buffer.concat([pendingBuf, chunk]);
    let offset = 0;
    while (buf.length - offset >= HEADER_BYTES) {
      const length = buf.readUInt32LE(offset + 5);
      if (length > MAX_PAYLOAD_BYTES) {
        failAll(new Error(`hc frame exceeded ${MAX_PAYLOAD_BYTES} bytes`));
        return;
      }
      if (buf.length - offset < HEADER_BYTES + length) break;
      const channel = buf.readUInt32LE(offset);
      const kind = buf[offset + 4]!;
      const payload = buf.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + length);
      handleFrame(channel, kind, payload);
      offset += HEADER_BYTES + length;
    }
    pendingBuf = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    if (framed) {
      pumpFrames(chunk);
      return;
    }
    plain = plain.length === 0 ? chunk : Buffer.concat([plain, chunk]);
    const nl = plain.indexOf(0x0a);
    if (nl < 0) return;
    const line = plain.subarray(0, nl).toString("utf8");
    const rest = plain.subarray(nl + 1);
    plain = Buffer.alloc(0);
    framed = true;
    try {
      const msg = JSON.parse(line);
      if (msg?.error) {
        failAll(new Error(typeof msg.error.message === "string" ? msg.error.message : "hc connect hello failed"));
        return;
      }
      if (msg?.result?.framed !== true) {
        failAll(new Error("hc connect did not enter framed mode"));
        return;
      }
      helloResolve();
    } catch {
      failAll(new Error("hc connect answered hello with invalid JSON"));
      return;
    }
    if (rest.length > 0) pumpFrames(rest);
  });

  child.stdin.on("error", () => {});
  child.on("error", (e) => failAll(new Error(`hc connect: ${e.message}`)));
  child.on("close", () => failAll(new Error("hc connect closed unexpectedly")));

  const timer = setTimeout(() => {
    failAll(new Error("Timed out talking to Antigravity's terminal."));
    try { child.kill(); } catch {}
  }, timeoutMs);
  timer.unref();

  const rpc = <T = any>(method: string, params: Record<string, unknown>): Promise<T> => {
    if (closed) return Promise.reject(new Error("hc connect is closed"));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      writeRaw(encodeFrame(0, FRAME_DATA, JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    });
  };

  const closeChannel = async (ch: number) => {
    if (closed) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        closeWaiters.delete(ch);
        resolve();
      }, 2000);
      t.unref();
      closeWaiters.set(ch, () => {
        clearTimeout(t);
        resolve();
      });
      writeRaw(encodeFrame(ch, FRAME_CLOSE, Buffer.alloc(0)));
    });
  };

  try {
    writeRaw(Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "hello", params: { generation: HC_GENERATION, framed: true } })}\n`, "utf8"));
    await helloReady;

    const record = await rpc("terminal.get", { terminal: opts.terminal });
    if (record?.state !== "live") throw new Error("Antigravity's terminal has ended.");
    const st = typeof record.status === "string" ? record.status : record.status?.state;
    if (st === "working") throw new Error("Antigravity is working: run the command when it's done, or in a new tab.");
    if (st === "blocked") throw new Error("Antigravity is asking something in its terminal: answer it first, then run.");
    const cols = Number(record.cols) || 80;
    const rows = Number(record.rows) || 24;

    const beforeRead = await rpc("terminal.read", { terminal: opts.terminal, lines: 0 });
    const before = typeof beforeRead?.text === "string" ? beforeRead.text : "";
    if (agyInShellMode(before)) {
      throw new Error("Antigravity is already in shell mode in its terminal: finish or cancel it there first.");
    }

    const att = await rpc("terminal.attach", { terminal: opts.terminal, cols, rows, history: 0 });
    const ch = att?.channel;
    if (typeof ch !== "number") throw new Error("hc terminal.attach returned no channel");
    const now = att?.terminal;
    if (now && typeof now.cols === "number" && typeof now.rows === "number" && (now.cols !== cols || now.rows !== rows)) {
      writeRaw(encodeFrame(ch, FRAME_RESIZE, encodeResize(now.cols, now.rows)));
    }

    try {
      // Raw un-bracketed `!` switches `agy` into ShellMode (`!` prompt / `activated bash mode`).
      writeRaw(encodeFrame(ch, FRAME_DATA, "!"));
      let entered = false;
      let lastScreen = before;
      const deadline = Date.now() + shellWaitMs;
      while (Date.now() < deadline) {
        await sleep(pollMs);
        const r = await rpc("terminal.read", { terminal: opts.terminal, lines: 0 });
        lastScreen = typeof r?.text === "string" ? r.text : "";
        if (agyInShellMode(lastScreen)) {
          entered = true;
          break;
        }
      }
      if (!entered) {
        // Undo the `!` character if typing it modified the terminal screen (e.g. a draft in the prompt).
        if (lastScreen !== before) writeRaw(encodeFrame(ch, FRAME_DATA, "\x7f"));
        throw new Error("Antigravity didn't enter shell mode (is its prompt empty and idle?): run it in a new tab or in the terminal.");
      }
      writeRaw(encodeFrame(ch, FRAME_DATA, `${PASTE_START}${cmd}${PASTE_END}`));
      await sleep(enterDelayMs);
      writeRaw(encodeFrame(ch, FRAME_DATA, "\r"));
    } finally {
      await closeChannel(ch);
    }
  } finally {
    clearTimeout(timer);
    closed = true;
    try { child.kill(); } catch {}
  }
}
