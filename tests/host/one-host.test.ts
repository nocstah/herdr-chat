// One host per chat (registry.ts claimChat): every app showing a chat's tab
// runs its own copy of the chat and starts a host when none answers, so two
// may start together (the chat's machine's own app and another computer's
// showing that machine's spaces). The later one steps aside.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { claimChat, releaseChat, servesChat } from "../../host/registry.ts";
import { Host, HOST_ENTRY, HOST_NODE, idle } from "./harness.ts";

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "pich-claim-")));
const claim = (state: string, chat: string) => join(state, "chats", `${chat}.host`);

test("claimChat: the first claim serves; a live host's claim makes another step aside; a stale one is taken over", () => {
  const state = dir();
  assert.equal(claimChat(state, "c1", () => true, 111), null, "the first claim");
  assert.equal(readFileSync(claim(state, "c1"), "utf8").trim(), "111");
  // A live process that serves the chat holds it (this test's own pid stands in for it).
  writeFileSync(claim(state, "c1"), `${process.pid}\n`);
  assert.equal(claimChat(state, "c1", (pid) => pid === process.pid, 222), process.pid, "a live host serves it");
  // The same pid, alive but no host of this chat (a reused pid): stale.
  assert.equal(claimChat(state, "c1", () => false, 222), null);
  assert.equal(readFileSync(claim(state, "c1"), "utf8").trim(), "222");
  // A pid that's gone: stale.
  writeFileSync(claim(state, "c1"), "999999999\n");
  assert.equal(claimChat(state, "c1", () => true, 333), null);
  // Released only by its holder.
  releaseChat(state, "c1", 222);
  assert.ok(existsSync(claim(state, "c1")), "another pid's release leaves it");
  releaseChat(state, "c1", 333);
  assert.ok(!existsSync(claim(state, "c1")));
  // Each chat has its own.
  mkdirSync(join(state, "chats"), { recursive: true });
  assert.equal(claimChat(state, "c2", () => true, 444), null);
});

test("servesChat reads the command line: a host of that chat, not of another or another program", () => {
  assert.equal(servesChat(process.pid, "c1"), false);
  assert.equal(servesChat(999999999, "c1"), false);
});

test("a second host for a chat whose host runs steps aside; once that one ends, the next start serves", async () => {
  const a = await new Host({ name: "one-a", chat: "c-one", speed: 4 }).start();
  let b: Host | null = null;
  try {
    await a.client.waitFor(idle, 10_000);
    assert.equal(servesChat(a.proc.pid!, "c-one"), true);
    assert.equal(servesChat(a.proc.pid!, "c-other"), false);
    const before = a.registry!;
    // The same command another app's start would run: same chat, same state.
    const second = spawn(HOST_NODE, [HOST_ENTRY, "serve", "--chat", "c-one", "--cwd", a.cwd, "--state-dir", a.stateDir, "--pi", "/bin/false"], { stdio: "ignore" });
    const code = await new Promise<number | null>((r) => second.on("exit", r));
    assert.equal(code, 0, "it leaves quietly");
    const log = readFileSync(join(a.stateDir, "logs", "c-one.log"), "utf8");
    assert.match(log, new RegExp(`another host \\(pid ${a.proc.pid}\\) serves chat=c-one: this one \\(pid ${second.pid}\\) steps aside`));
    const now = a.registry!; // (its agent's version may land in it meanwhile)
    assert.deepEqual([now.pid, now.port, now.wsPort, now.token], [before.pid, before.port, before.wsPort, before.token], "the registry still names the first host");
    assert.equal(readFileSync(claim(a.stateDir, "c-one"), "utf8").trim(), String(a.proc.pid));
    await a.client.req("send", { text: "still here" });
    await a.client.waitFor((x) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && i.text === "ok: still here"), 10_000, "the first host still serves");

    await a.stop();
    assert.ok(!existsSync(claim(a.stateDir, "c-one")), "a host gives its claim back as it ends");
    b = await new Host({ name: "one-b", dir: a.dir, chat: "c-one", speed: 4 }).start();
    assert.equal(b.registry!.pid, b.proc.pid);
  } finally {
    await b?.stop();
    await a.stop();
  }
});
