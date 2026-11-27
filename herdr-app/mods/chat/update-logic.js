// Pure, UI-agnostic logic for silent auto-restarting outdated chat hosts
// (herdr-app/mods/chat/update.js). Tested directly in Node without GPUI bindings.

/**
 * Older than the install: other code, and started before the install (a host
 * started after it runs what is there; in a clone, edited code isn't an update
 * until ./install.sh). A host before 0.3 sends no build.
 */
export function older(host, cfg) {
  return Boolean(cfg?.build && host) && host.build !== cfg.build && !(host.startedAt > Number(cfg.installedAt ?? 0));
}

/**
 * Nothing a restart would lose: no run, no open question, nothing queued (the host
 * holds the follow-ups in memory), and no live sub-agent of its own (their reports go
 * to this host's terminal, which a restart replaces). An agent that exited or failed
 * is quiet: the restart starts it again.
 */
export function isQuiet(s, hostAddress, liveTerminals = []) {
  if (!["idle", "exited", "error"].includes(s?.phase)) return false;
  if (s?.dialog || s?.dialogsPending) return false;
  if (s?.queue?.steering?.length || s?.queue?.followUp?.length) return false;
  return !hostAddress || !liveTerminals.some((t) => t.state === "live" && t.parent === hostAddress);
}

export class UpdaterCore {
  /** @param {{ sub?: boolean, log?: (msg: string) => void, getTerminals?: () => any[] }} [opts] */
  constructor({ sub = false, log = () => {}, getTerminals = () => [] } = {}) {
    this.sub = Boolean(sub);
    this.log = log;
    this.getTerminals = getTerminals;
    this.cfg = null; // config.json as of the last load/welcome
    this.wanted = false; // explicit user request (/reload or update:restart)
    this.triedFor = null; // the install build a restart was tried for (at most once per build)
    this.updatingTo = null; // set only for explicit user restarts, so silent auto-restarts don't flash
  }

  /** Whether this chat's host is outdated and eligible to restart onto the installed build. */
  canRestart(welcome) {
    return !this.sub && older(welcome?.host, this.cfg) && this.triedFor !== this.cfg.build;
  }

  /** Record an explicit restart request (e.g. `/reload`). */
  want() {
    this.wanted = true;
  }

  /** "herdr-chat 0.5.0", or a plain name when config.json has no version. */
  label() {
    return this.cfg?.version ? `herdr-chat ${this.cfg.version}` : "the new herdr-chat";
  }

  /**
   * Whether to restart the host now: outdated hosts auto-restart silently as soon as
   * the chat is quiet (no prompt or banner required).
   */
  due({ welcome, state, host, replacing }) {
    if (!this.canRestart(welcome) || replacing || !host) return false;
    if (!isQuiet(state, host.address, this.getTerminals())) return false;
    this.log(`host ${host.address} runs ${welcome.host?.build ?? "an older build"}, the install ${this.cfg.build}: auto-restarting it`);
    this.triedFor = this.cfg.build;
    this.updatingTo = this.wanted ? this.label() : null;
    return true;
  }

  /** Finish a restart on welcome; returns a flash note only for explicit user restarts. */
  finishWelcome(rec, oldPid) {
    const to = this.updatingTo;
    this.updatingTo = null;
    this.wanted = false;
    if (!to || rec?.host?.pid === oldPid) return null;
    if (older(rec?.host, this.cfg)) {
      this.log(`restarted, but the host says ${rec?.host?.build ?? "no build"}, the install ${this.cfg?.build}`);
      return null;
    }
    return `Restarted on ${to}`;
  }

  /** No top update banner: outdated hosts auto-restart silently when idle. */
  bar() {
    return null;
  }

  dump(welcome) {
    return {
      outdated: older(welcome?.host, this.cfg),
      canRestart: this.canRestart(welcome),
      wanted: this.wanted,
      triedFor: this.triedFor,
      hostBuild: welcome?.host?.build ?? null,
      build: this.cfg?.build ?? null,
    };
  }
}
