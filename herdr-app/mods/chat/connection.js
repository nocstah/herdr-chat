import { appHome, hc, readTextFile, terminals } from "herdr";
import { openLink } from "./transport.js";
import { forget, reach, readRemoteText, remoteInstall } from "./machines.js";
import { DEFAULT_PROVIDER, MOD, message } from "./util.js";

export const stateDir = () => `${appHome()}/data/herdr-chat`;
export const registryPath = (chat) => `${stateDir()}/chats/${chat}.json`;

/**
 * The install a chat's host runs from: this computer's (null), or, for a chat
 * in another machine's space, that machine's (machines.js): {machine, home,
 * config, settings}, `home` its app home there.
 */
export async function hostSide(machine) {
  return machine ? { machine, ...(await remoteInstall(machine)) } : null;
}
const sideState = (side) => (side ? `${side.home}/data/herdr-chat` : stateDir());

async function readJson(path) {
  try {
    return JSON.parse((await readTextFile(path)) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

/** Where the person's settings live (README "Configuration"); install never writes it. */
export const settingsPath = () => `${stateDir()}/settings.json`;

/**
 * What install wrote (mods/chat/config.json: the host, node, hc and each agent
 * it found) with the person's settings over it. One agent's:
 * {command, args, env, tui}, `tui` an argv or null.
 */
export async function readConfig(side = null) {
  const cfg = side ? side.config ?? {} : await readJson(`${appHome()}/mods/${MOD}/config.json`);
  const mine = side ? side.settings ?? {} : await readJson(settingsPath());
  const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === "string" && v ? [v] : null);
  const agent = (id) => {
    const a = mine[id] && typeof mine[id] === "object" ? mine[id] : {};
    return {
      command: typeof a.command === "string" && a.command ? a.command : typeof cfg[id] === "string" ? cfg[id] : null,
      args: list(a.args) ?? [],
      env: { ...(mine.env ?? {}), ...(a.env ?? {}) },
      tui: list(a.tui),
    };
  };
  return { host: cfg.host ?? null, node: cfg.node ?? null, hc: cfg.hc ?? null, version: cfg.version ?? null, build: cfg.build ?? null, installedAt: cfg.installedAt ?? null, agent };
}

export async function readRegistry(chat, side = null) {
  try {
    const text = side ? await readRemoteText(side.machine, `${sideState(side)}/chats/${chat}.json`) : await readTextFile(registryPath(chat));
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// Whether a terminal runs a host (herdr-chat-host, or herdr-chat-subagent for a
// sub-agent; a template runs it as `sh -c '…/herdr-chat-subagent …'`). After
// herdr-core restarts, it brings a kept terminal back as a login shell with
// the same labels: that shell is no host.
const HOST_BIN = /herdr-chat-(host|subagent)\b/;
export function runsHost(t) {
  return !Array.isArray(t.argv) || t.argv.some((a) => HOST_BIN.test(a));
}

// The live core terminal running this chat's host, if any.
export function hostTerminal(chat) {
  return terminals().find((t) => t.labels?.["herdr-chat.chat"] === chat && t.state === "live" && runsHost(t)) ?? null;
}

// hc run's error, for the person. The host starts as /usr/bin/env, which is
// always there: "No such file" from the spawn is the folder (a space whose
// worktree was deleted).
export function startError(text, cwd) {
  if (/spawn_failed/.test(text) && /No such file or directory/.test(text)) {
    return `The chat's folder ${cwd} doesn't exist (a deleted worktree?). Open the chat in a space whose folder exists.`;
  }
  return `couldn't start the host: ${text}`;
}

const BACKOFF = [250, 500, 1000, 2000, 2000];

export class Connection {
  // opts: {chat, cwd, attachOnly (never start a host), place: () => ({space, tab}) | null (a host starts only once the chat's tab is known),
  // machine: () => the machine of the chat's space, null for this computer's (its host runs there: machines.js),
  // session, hostEnv, handOver ({pid, model, thinking} | null), onRecord(rec, cx), onChange(cx), log}
  constructor(opts) {
    this.o = opts;
    this.status = "connecting"; // connecting | starting | connected | reconnecting | stopped | failed
    this.error = null;
    this.link = null;
    this.pending = new Map();
    this.nextId = 1;
    this.closed = false;
    this.attempt = 0;
    this.startedHostAt = 0;
    this.welcome = null;
    this.connects = 0;
    // Start a host when none runs: on open, and after Restart. Once a host
    // answered, its going away shows "host stopped" instead (main.js).
    this.autoStart = true;
  }

  restart() {
    this.startFailed = false;
    this.autoStart = true;
    this.startedHostAt = 0;
    this.attempt = 0;
  }

  set(status, error, cx) {
    if (this.status === status && this.error === error) return;
    this.status = status;
    this.error = error ?? null;
    this.o.onChange?.(cx);
  }

  start(cx) {
    cx.spawn(async (cx) => {
      // Into a turn the scheduler resumed first: the start of a spawned body runs inside the call
      // that spawned it, and a promise it awaits that's already settled (a cached lookup,
      // machines.js) continues after that call, outside any. The read loop would then run
      // there too, and the code views it makes (syncCode's cx.new) come out released.
      await cx.sleep(0);
      while (!this.closed) {
        try {
          await this.once(cx);
        } catch (e) {
          this.o.log?.(`connection: ${message(e)}`);
          if (!this.closed) this.set(this.connects ? "reconnecting" : "connecting", message(e), cx);
        }
        this.failPending("disconnected");
        if (this.closed) return;
        await cx.sleep(BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]);
      }
    });
    // Requests nobody answered within their time: fail them, keep the loop.
    cx.timer.every(1000, () => {
      const now = Date.now();
      for (const [id, p] of this.pending) {
        if (now > p.deadline) {
          this.pending.delete(id);
          p.reject(new Error(`${p.op}: no reply from the host`));
        }
      }
    });
  }

  // One connection attempt and, when it works, its whole read loop.
  async once(cx) {
    const machine = this.o.machine?.() ?? null;
    const side = await hostSide(machine);
    const entry = await readRegistry(this.o.chat, side);
    if (!entry?.port || !entry?.pid) {
      await this.ensureHost(cx, entry, side);
      return;
    }
    let link;
    try {
      link = await this.open(entry, machine);
    } catch (e) {
      if (machine) this.o.log?.(`${machine}: ${message(e)}`);
      await this.ensureHost(cx, entry, side);
      return;
    }
    this.link = link;
    try {
      await link.send({ t: "hello", v: 1, token: entry.token, client: "mod" });
      let welcomed = false;
      for (let texts; (texts = await link.next()) !== null; ) {
        const recs = [];
        for (const text of texts) {
          try {
            recs.push(JSON.parse(text));
          } catch {
            this.o.log?.(`bad record: ${text.slice(0, 200)}`);
          }
        }
        for (const rec of recs) {
          if (rec.t === "welcome") {
            welcomed = true;
            this.welcome = rec;
            this.connects++;
            this.attempt = 0;
            this.autoStart = false;
            this.set("connected", null, cx);
          } else if (rec.t === "res") {
            const p = this.pending.get(rec.id);
            if (p) {
              this.pending.delete(rec.id);
              if (rec.ok) p.resolve(rec.data ?? {});
              else p.reject(new Error(rec.error ?? "failed"));
            }
          }
          if (welcomed && rec.t !== "ping") this.o.onRecord(rec, cx); // ping: the host's keepalive
        }
        if (recs.length) this.o.onFlush?.(cx);
      }
      if (!welcomed) {
        // A wrong token (a newer host wrote the registry) closes without a reply.
        this.o.log?.("closed before welcome");
      }
    } finally {
      this.link = null;
      link.close();
      if (!this.closed) this.set("reconnecting", null, cx);
    }
  }

  // The link to the host: here, its port; on another machine, a port here that
  // an ssh forward takes there (machines.js). A forward that fails is dropped, so
  // the next attempt makes a new one (the machine's connection may have gone).
  async open(entry, machine) {
    if (!machine) return openLink(entry);
    if (!entry.wsPort) throw new Error(`the host on ${machine} has no WebSocket port (an older herdr-chat there)`);
    const mine = await readJson(settingsPath());
    const how = mine.machines?.[machine] ?? {};
    const local = await reach(machine, entry.wsPort, { direct: how.direct === true, node: (await readConfig()).node });
    this.forwarded = { machine, port: entry.wsPort };
    try {
      return await openLink({ ...entry, wsPort: local, port: null });
    } catch (e) {
      await forget(machine, entry.wsPort);
      throw e;
    }
  }

  // No host answered: start one, unless a live terminal already runs it
  // (it may still be starting) or we just did.
  async ensureHost(cx, entry, side = null) {
    const live = hostTerminal(this.o.chat);
    // A sub-agent's chat only attaches: its host is the parent's to start and end.
    if (this.o.attachOnly) {
      if (live) this.set(this.connects ? "reconnecting" : "starting", null, cx);
      else this.set("stopped", "The sub-agent ended", cx);
      return;
    }
    // A start that failed stays failed (its error shown) until Retry (restart).
    if (this.startFailed) return;
    if (live || Date.now() - this.startedHostAt < 8000) {
      this.set(this.connects ? "reconnecting" : "starting", null, cx);
      return;
    }
    if (!this.autoStart) {
      this.set("stopped", "The chat's host stopped", cx);
      return;
    }
    const place = this.o.place?.();
    if (!place) {
      this.set("connecting", "waiting for the chat's tab", cx);
      return;
    }
    this.startedHostAt = Date.now();
    this.set("starting", null, cx);
    const cfg = await readConfig(side);
    // The chat's agent: its props, else what the registry recorded (a reopened chat keeps it).
    const provider = this.o.provider ?? entry?.provider ?? DEFAULT_PROVIDER;
    this.provider = provider;
    const host = cfg.host;
    const agent = cfg.agent(provider);
    if (!host) {
      this.startFailed = true;
      this.set("failed", side ? `herdr-chat isn't installed on ${side.machine} (its mods/${MOD}/config.json names no host): install it there too` : `mods/${MOD}/config.json has no "host"`, cx);
      return;
    }
    const env = { ...agent.env, ...(this.o.hostEnv ?? {}) };
    if (cfg.node) env.HERDR_CHAT_NODE = cfg.node;
    const session = this.o.session ?? entry?.sessionFile ?? null;
    const args = [
      // No --name: the registry and the herdr-chat.chat label identify it, and
      // Herdr's toasts then show the title the host sets (OSC 0). No herdr.*
      // labels yet: the app would adopt it as a visible pane. The chat adds
      // its pane, hidden, to the layout document, then labels it (main.js
      // keepHostHidden). --keep: the core keeps it, as adoption would.
      "run", "--bg", "--json", "--keep", "--no-parent", ...(side ? ["--on", side.machine] : []), "--cwd", this.o.cwd,
      "--label", `herdr-chat.chat=${this.o.chat}`, "--label", "herdr-chat.role=host",
      "--", "/usr/bin/env", ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      host, "serve", "--chat", this.o.chat, "--cwd", this.o.cwd, "--state-dir", sideState(side), "--app-home", side ? side.home : appHome(), "--provider", provider,
      ...(session ? ["--session", session] : []),
      // A Pi TUI this chat takes over: the host waits for its pid, then uses its model and
      // thinking (only while that pid lives: a later restart of the chat ignores them).
      ...(session && this.o.handOver?.pid ? ["--after-pid", String(this.o.handOver.pid),
        ...(this.o.handOver.model ? ["--model", this.o.handOver.model] : []),
        ...(this.o.handOver.thinking ? ["--thinking", this.o.handOver.thinking] : [])] : []),
      // The agent's command and arguments (readConfig).
      ...(agent.command ? [`--${provider}`, agent.command] : []),
      ...(agent.args.length ? ["--", ...agent.args] : []),
    ];
    const r = await hc(args);
    this.o.log?.(`hc run host: code ${r.code} ${r.stdout.trim()} ${r.stderr.trim()}`);
    if (r.code !== 0) {
      this.startFailed = true;
      this.set("failed", startError((r.stderr || r.stdout).trim(), this.o.cwd), cx);
    }
    else this.o.onHostStarted?.(r.stdout, cx);
  }

  req(op, args = {}, { timeout = 30000 } = {}) {
    const link = this.link;
    if (!link || this.status !== "connected") return Promise.reject(new Error("not connected to the host"));
    const id = `m${this.nextId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, op, deadline: Date.now() + timeout });
      link.send({ t: "req", id, op, ...args }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  failPending(why) {
    for (const [, p] of this.pending) p.reject(new Error(why));
    this.pending.clear();
  }

  resync() {
    this.link?.close();
  }

  close() {
    this.closed = true;
    this.resync();
    if (this.forwarded) forget(this.forwarded.machine, this.forwarded.port);
  }
}
