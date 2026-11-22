// Claude Code's first face (herdr-app/mods/new-chat/first-face.js): which terminals Claude Code just started in, and
// settings.json's claude.face. The flip itself is faces.js's (terminal-view.test.ts, the rig).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error: a mod's plain JavaScript, with no declarations (it loads as is in the app)
import { DEFAULT_FACE, RECENT_MS, REMOTE_CHECK, faceOf, flipsThere, remoteAnswer, started, withFace } from "../../herdr-app/mods/new-chat/first-face.js";

const runs = (t: any) => t.claude === true;
const NOW = 1_800_000_000_000;

test("started: nothing at the first look; then a new terminal running Claude Code, or a shell that started it", () => {
  const list = [
    { address: "t1", claude: true, created_ms: NOW - 3_600_000, status_ms: NOW - 3_600_000 },
    { address: "t2", claude: false, created_ms: NOW - 3_600_000, status_ms: NOW - 3_600_000 },
  ];
  assert.deepEqual(started(null, list, runs, NOW), [], "the first look sets what runs: it keeps its face");
  const was = new Map([["t1", true], ["t2", false]]);
  // t2's shell started claude (its status changed just now); t3 is a new tab that runs it
  const later = [list[0], { ...list[1], claude: true, status_ms: NOW - 400 }, { address: "t3", claude: true, created_ms: NOW - 900, status_ms: NOW - 800 }];
  assert.deepEqual(started(was, later, runs, NOW), ["t2", "t3"]);
  // already running at the last look: not again (flipping back to the terminal stays)
  assert.deepEqual(started(new Map([["t1", true], ["t2", true], ["t3", true]]), later, runs, NOW), []);
});

test("started: a terminal the app lists only late, running Claude Code for long, keeps its face", () => {
  const was = new Map([["t1", false]]);
  const old = { address: "t9", claude: true, created_ms: NOW - 2 * RECENT_MS, status_ms: NOW - 2 * RECENT_MS };
  assert.deepEqual(started(was, [old], runs, NOW), []);
  // its status reported late (the app listed it before its first report): the change is old too
  assert.deepEqual(started(new Map([["t9", false]]), [old], runs, NOW), []);
  // a start that ended again by the next look (claude exited) isn't one
  assert.deepEqual(started(was, [{ address: "t1", claude: false, created_ms: NOW, status_ms: NOW }], runs, NOW), []);
});

test("started: without the core's times, only a change seen here counts", () => {
  assert.deepEqual(started(new Map([["t1", false]]), [{ address: "t1", claude: true }, { address: "t2", claude: true }], runs, NOW), ["t1"]);
});

test("faceOf and withFace: the chat view unless set to the terminal; the rest of settings.json kept", () => {
  assert.equal(DEFAULT_FACE, "chat");
  assert.equal(faceOf({}), "chat");
  assert.equal(faceOf(null), "chat");
  assert.equal(faceOf({ claude: { env: { A: "1" } } }), "chat");
  assert.equal(faceOf({ claude: { face: "chat" } }), "chat");
  assert.equal(faceOf({ claude: { face: "terminal" } }), "terminal");
  assert.equal(faceOf({ claude: { face: "Terminal" } }), "chat", "neither: the default");
  const s = { updates: { check: false }, claude: { env: { A: "1" } } };
  assert.deepEqual(withFace(s, "chat"), { updates: { check: false }, claude: { env: { A: "1" }, face: "chat" } });
  assert.deepEqual(s, { updates: { check: false }, claude: { env: { A: "1" } } }, "the read settings unchanged");
  assert.deepEqual(withFace({ claude: "odd" }, "terminal"), { claude: { face: "terminal" } });
  assert.deepEqual(withFace([], "chat"), { claude: { face: "chat" } });
});

test("Codex and Antigravity have their own faces: codex.face, antigravity.face, the same default, written beside Claude Code's", () => {
  // @ts-expect-error: as above
  return import("../../herdr-app/mods/new-chat/first-face.js").then(({ VIEW_AGENTS }) => {
    assert.deepEqual(VIEW_AGENTS, ["claude", "codex", "antigravity"]);
    assert.equal(faceOf(null, "codex"), DEFAULT_FACE);
    assert.equal(faceOf(null, "antigravity"), DEFAULT_FACE);
    assert.equal(faceOf({ claude: { face: "terminal" } }, "codex"), "chat", "Claude Code's face isn't Codex's");
    assert.equal(faceOf({ claude: { face: "terminal" } }, "antigravity"), "chat", "Claude Code's face isn't Antigravity's");
    assert.equal(faceOf({ codex: { face: "terminal" } }, "codex"), "terminal");
    assert.equal(faceOf({ antigravity: { face: "terminal" } }, "antigravity"), "terminal");
    assert.equal(faceOf({ codex: { face: "terminal" } }), "chat", "without an agent: Claude Code's");
    assert.deepEqual(withFace({ claude: { face: "chat" }, codex: { tui: ["x"] } }, "terminal", "codex"), { claude: { face: "chat" }, codex: { tui: ["x"], face: "terminal" } });
    assert.deepEqual(withFace({ claude: { face: "chat" } }, "terminal", "antigravity"), { claude: { face: "chat" }, antigravity: { face: "terminal" } });
  });
});

test("remoteAnswer and flipsThere: another machine's terminal flips here only while its app is closed, by its setting", () => {
  const said = (head: string, settings = "") => remoteAnswer(`${head}\n\x1e\n${settings}`);
  const NOW = "herdr-chat=1 app=0 default=chat agents=claude,codex";
  assert.deepEqual(said(NOW, '{"updates":{"check":false}}'), { herdrChat: true, app: false, agents: ["claude", "codex"], faces: { claude: "chat", codex: "chat" } });
  assert.equal(flipsThere(said(NOW)), true, "no settings.json: its default");
  assert.equal(flipsThere(said(NOW), "codex"), true);
  assert.equal(flipsThere(said("herdr-chat=1 app=1 default=chat agents=claude,codex")), false, "its own app flips it");
  assert.equal(flipsThere(said(NOW, '{"claude":{"face":"terminal"}}')), false, "its setting");
  assert.equal(flipsThere(said(NOW, '{"claude":{"face":"terminal"}}'), "codex"), true, "Claude Code's setting isn't Codex's");
  assert.equal(flipsThere(said(NOW, '{"codex":{"face":"terminal"}}'), "codex"), false);
  // builds from before: no agents line (Claude Code's view alone), and before that no default line (the terminal)
  assert.equal(flipsThere(said("herdr-chat=1 app=0 default=chat agents=claude")), true);
  assert.equal(flipsThere(said("herdr-chat=1 app=0 default=chat agents=claude"), "codex"), false, "no Codex view there");
  assert.equal(flipsThere(said("herdr-chat=1 app=0 default=chat"), "codex"), false);
  assert.equal(flipsThere(said("herdr-chat=1 app=0 default=terminal agents=claude")), false);
  assert.equal(flipsThere(said("herdr-chat=1 app=0 default=terminal agents=claude", '{"claude":{"face":"chat"}}')), true);
  assert.equal(said(NOW, "{not json")?.faces.claude, "chat", "a settings.json that isn't JSON: its default");
  assert.equal(flipsThere(remoteAnswer("herdr-chat=0\n")), false, "no setting there: a herdr-chat without it, or none");
  assert.equal(remoteAnswer("sh: 1: syntax error"), null);
  assert.equal(flipsThere(remoteAnswer("")), false);
  assert.equal(flipsThere(null), false, "no answer");
});

test("REMOTE_CHECK, run by sh: the setting's file, the app's socket (live, stale, untried), its lines, settings.json", async () => {
  const d = mkdtempSync(join(tmpdir(), "hc-ff-"));
  try {
    const home = join(d, "app"), sock = join(home, "herdr-app.sock");
    const check = (env: Record<string, string> = {}) => {
      const r = spawnSync("/bin/sh", ["-c", REMOTE_CHECK], { encoding: "utf8", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HERDR_APP_HOME: home + "/", ...env } });
      assert.equal(r.status, 0, r.stderr);
      return remoteAnswer(r.stdout);
    };
    mkdirSync(join(home, "mods/new-chat"), { recursive: true });
    mkdirSync(join(home, "mods/chat"), { recursive: true });
    mkdirSync(join(home, "data/herdr-chat"), { recursive: true });
    assert.deepEqual(check(), { herdrChat: false, app: false, agents: [], faces: {} }, "no first-face.js: no setting there");
    // this build's own lines, as the file has them
    const { readFileSync } = await import("node:fs");
    const own = readFileSync(new URL("../../herdr-app/mods/new-chat/first-face.js", import.meta.url), "utf8");
    writeFileSync(join(home, "mods/new-chat/first-face.js"), own);
    writeFileSync(join(home, "mods/chat/config.json"), JSON.stringify({ host: "/x/herdr-chat-host", node: process.execPath }, null, 2) + "\n");
    assert.deepEqual(check(), { herdrChat: true, app: false, agents: ["claude", "codex", "antigravity"], faces: { claude: "chat", codex: "chat", antigravity: "chat" } }, "no app socket: its app isn't running");
    // the app runs: its socket answers
    const app = spawn(process.execPath, ["-e", `require("net").createServer((c) => c.end()).listen(${JSON.stringify(sock)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((r) => app.stdout.once("data", r));
    try {
      assert.equal(check()?.app, true);
      // a socket that can't be tried (the node its install named is gone): as running, so the two apps never both flip
      writeFileSync(join(home, "mods/chat/config.json"), JSON.stringify({ node: join(d, "no-node") }, null, 2) + "\n");
      assert.equal(check()?.app, true);
    } finally {
      app.kill("SIGKILL");
    }
    // the app was killed: its socket file stays, and nothing answers it
    writeFileSync(join(home, "mods/chat/config.json"), JSON.stringify({ node: process.execPath }, null, 2) + "\n");
    assert.equal(check()?.app, false, "a stale socket");
    writeFileSync(join(home, "data/herdr-chat/settings.json"), '{"claude":{"face":"terminal"}}');
    assert.deepEqual(check()?.faces, { claude: "terminal", codex: "chat", antigravity: "chat" });
    writeFileSync(join(home, "data/herdr-chat/settings.json"), "{not json");
    writeFileSync(join(home, "mods/new-chat/first-face.js"), "// a build from before DEFAULT_FACE and VIEW_AGENTS\n");
    assert.deepEqual(check()?.faces, { claude: "terminal" });
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
