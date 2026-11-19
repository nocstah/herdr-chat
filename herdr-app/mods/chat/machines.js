// Chats in another machine's spaces (`hc machine`: the app shows that machine's
// spaces beside this computer's). Such a chat's pane lives in that machine's
// layout document, and its host runs there, from that machine's own herdr-chat
// install, so the agent, its files, its sessions and its hooks are all that
// machine's. This computer only draws the chat: it reaches the host's
// WebSocket through an ssh port forward, on an ssh connection of herdr-chat's
// own (one per machine, a ControlMaster), to the machine's `hc machine` target.
//
// In the app, another machine's ids carry its name ("box/t7", "box/p1a2");
// in its own core and layout document they're bare ("t7").

import { exec, hc } from "herdr";

/** The machine of an app id or address: "box" for "box/t7", null for this computer's. */
export function machineOf(id) {
  const s = String(id ?? ""), at = s.indexOf("/");
  return at > 0 ? s.slice(0, at) : null;
}

/** An id as its own machine names it: "t7" for "box/t7". */
export function bare(id) {
  const s = String(id ?? ""), at = s.indexOf("/");
  return at > 0 ? s.slice(at + 1) : s;
}

/** An id of `machine`'s own document as the app names it: "box/t7" (this computer's stay as they are). */
export function qualify(machine, id) {
  return machine && id != null && !String(id).includes("/") ? `${machine}/${id}` : id;
}

const sh = (script, args = [], opts = {}) => exec("/bin/sh", ["-c", script, "sh", ...args], opts);
const said = (r) => (r.stderr || r.stdout || "").trim();

// `hc machine ls`, by name ({name, target, via, state}), asked again after 30 s.
let known = null;
let knownAt = 0;
export async function machine(name) {
  if (!known || Date.now() - knownAt > 30000) {
    const r = await hc(["machine", "ls", "--json"]);
    if (r.code !== 0) throw new Error(`hc machine ls: ${said(r)}`);
    known = new Map((JSON.parse(r.stdout)?.machines ?? []).map((m) => [m.name, m]));
    knownAt = Date.now();
  }
  return known.get(name) ?? null;
}

// What a machine's own install says: its app home and mods/chat/config.json, read
// through herdr-core (no ssh of ours). Kept for a minute: a host start asks for it.
const installs = new Map();
export async function remoteInstall(name) {
  const had = installs.get(name);
  if (had && Date.now() - had.at < 60000) return had;
  const r = await sh('h="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"; h="${h%/}"; printf "%s\\n" "$h"; '
    + 'cat "$h/mods/chat/config.json" 2>/dev/null; printf "\\n\\036\\n"; cat "$h/data/herdr-chat/settings.json" 2>/dev/null', [], { on: name, timeout: 20000 });
  if (r.code !== 0) throw new Error(`${name} didn't answer: ${said(r) || `exit ${r.code}`}`);
  const [head, settingsText = ""] = r.stdout.split("\n\x1e\n");
  const nl = head.indexOf("\n");
  const home = (nl < 0 ? head : head.slice(0, nl)).trim();
  const json = (text) => { try { return JSON.parse(text) ?? {}; } catch { return {}; } };
  const config = json(nl < 0 ? "" : head.slice(nl + 1));
  if (!home) throw new Error(`${name} didn't say where its Herdr app keeps its files`);
  const got = { at: Date.now(), home, config, settings: json(settingsText) };
  installs.set(name, got);
  return got;
}

/** A file of another machine's, read through herdr-core; null when it isn't there. */
export async function readRemoteText(name, path) {
  const r = await sh('[ -f "$1" ] || exit 3; exec cat "$1"', [path], { on: name, timeout: 20000 });
  if (r.code === 3) return null;
  if (r.code !== 0) throw new Error(`${name}: ${said(r) || `exit ${r.code}`}`);
  return r.stdout;
}

// ---- the port forward -----------------------------------------------------------

// The folder of this computer's ssh control sockets (short: a socket path has ~100 bytes).
let socketDir = null;
async function sockets() {
  if (socketDir) return socketDir;
  const r = await sh('d="${XDG_RUNTIME_DIR:-/tmp}/herdr-chat-ssh-$(id -u)"; mkdir -p -m 700 "$d" && printf %s "$d"');
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`no folder for ssh sockets: ${said(r)}`);
  return (socketDir = r.stdout.trim());
}

const sshOpts = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];

const starting = new Map(); // machine → its connection being checked or started (chats opening together share it)
const forwards = new Map(); // "machine:port" → local port

/** The machine's ssh target and our control socket for it, its connection up (started when it isn't). */
function connection(name) {
  if (!starting.has(name)) starting.set(name, connect(name).finally(() => starting.delete(name)));
  return starting.get(name);
}

async function connect(name) {
  const m = await machine(name);
  if (!m) throw new Error(`${name} isn't one of this computer's machines (hc machine ls)`);
  if (m.via) throw new Error(`${name} is reached through a command (hc machine add --via), not ssh: a chat there can't reach its host`);
  const target = m.target || m.host || name;
  const sock = `${await sockets()}/${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const check = await exec("ssh", ["-S", sock, "-O", "check", target]);
  if (check.code === 0) return { target, sock };
  // -f backgrounds it once connected; its output goes to a file, so this exec isn't held open by it.
  // A new connection: the forwards of the one before went with it.
  for (const key of [...forwards.keys()]) if (key.startsWith(`${name}:`)) forwards.delete(key);
  const r = await sh('s="$1"; shift; rm -f "$s"; ssh -f -N -M -S "$s" -o ControlMaster=yes -o ExitOnForwardFailure=yes -o RequestTTY=no "$@" '
    + '</dev/null >/dev/null 2>"$s.err"; c=$?; [ $c = 0 ] || cat "$s.err" >&2; rm -f "$s.err"; exit $c', [sock, ...sshOpts, target], { timeout: 30000 });
  if (r.code !== 0) throw new Error(`ssh ${target}: ${said(r) || `exit ${r.code}`}`);
  return { target, sock };
}

// A free port here, from the node install named (a mod can't listen). Another program may take it
// before ssh does: forward() then tries again.
async function freePort(node) {
  const r = await exec(node || "node", ["-e", 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})']);
  const port = Number(r.stdout.trim());
  if (r.code !== 0 || !(port > 0)) throw new Error(`couldn't pick a local port: ${said(r)}`);
  return port;
}

const asked = new Map(); // "machine:port" → its forward being made

/**
 * A port on this computer's loopback that reaches `port` on `name`'s, or `port`
 * itself for a machine set `"direct": true` in settings.json's "machines" (one
 * that shares this computer's loopback, such as a second core here). Kept until
 * forget(); a connection that fails asks for it again.
 */
export function reach(name, port, { direct = false, node = null } = {}) {
  if (direct) return Promise.resolve(port);
  const key = `${name}:${port}`;
  if (!asked.has(key)) asked.set(key, forward(name, port, node).finally(() => asked.delete(key)));
  return asked.get(key);
}

async function forward(name, port, node) {
  const key = `${name}:${port}`;
  const { target, sock } = await connection(name);
  if (forwards.has(key)) return forwards.get(key);
  let last = null;
  for (let i = 0; i < 3; i++) {
    const local = await freePort(node);
    const r = await exec("ssh", ["-S", sock, "-O", "forward", "-L", `127.0.0.1:${local}:127.0.0.1:${port}`, target]);
    if (r.code === 0) {
      forwards.set(key, local);
      return local;
    }
    last = said(r);
  }
  throw new Error(`ssh couldn't forward a port to ${name}: ${last}`);
}

/** Drops a forward (the chat closed, or its connection failed): cancelled in ssh, asked for afresh next time. */
export async function forget(name, port) {
  const key = `${name}:${port}`;
  const local = forwards.get(key);
  if (local == null) return;
  forwards.delete(key);
  try {
    const m = await machine(name);
    const sock = `${await sockets()}/${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    await exec("ssh", ["-S", sock, "-O", "cancel", "-L", `127.0.0.1:${local}:127.0.0.1:${port}`, m?.target || m?.host || name]);
  } catch {}
}
