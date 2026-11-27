// A chat whose host is older than the install (protocol.md "v3.5: updates").
// A host keeps the code it started with; the mods reload at once. After an
// install, each outdated chat compares its host (the welcome) with the install
// (config.json) and silently auto-restarts its host on the same session as soon
// as the chat is quiet — no top banner or manual Restart button required.
// A sub-agent's host is its parent's: never restarted here.
// One try per install build: a host that comes back on another build is left.
//
// The view (main.js) owns one Updater and calls it from its tick, its welcome,
// /reload and its debug dump; replaceHost does the restart.

import { terminals } from "herdr";
import { hostSide, readConfig } from "./connection.js";
import { UpdaterCore, isQuiet, older } from "./update-logic.js";

export { older };

/** Whether a restart now loses nothing (no run, dialog, queue, or live sub-agent). */
export function quiet(s, hostAddress) {
  return isQuiet(s, hostAddress, terminals());
}

export class Updater extends UpdaterCore {
  /** sub: a sub-agent's chat (never restarted); log: the view's log. */
  constructor({ sub, log }) {
    super({ sub, log, getTerminals: () => terminals() });
  }

  // `machine`: the chat's host runs on that machine, from its install (machines.js): compared with that one.
  async load(machine = null) {
    if (machine) this.cfg = null; // until that install is read, no restart: this computer's isn't the host's
    this.cfg = await readConfig(await hostSide(machine));
  }

  /** A welcome: config.json again (a new install may have come); returns a flash note only for explicit `/reload`. */
  async onWelcome(rec, oldPid) {
    await this.load();
    return this.finishWelcome(rec, oldPid);
  }
}
