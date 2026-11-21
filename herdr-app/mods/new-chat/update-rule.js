// Whom the restart question asks about (update.js checkHosts): each chat once,
// whatever the answer. Asked once per build, it came back after every install
// about the same chats: after Later, and after Restart too, since each install
// makes the restarted chats outdated again (several installs in a day). Now a
// chat the question was put for is remembered by its id while its host lives
// (a restart keeps the chat's id), and only a chat nobody was asked about yet
// brings it back. Each outdated chat keeps its own bar with Restart
// (mods/chat/update.js) after later installs.
// No imports, so the tests load it (tests/host/update-rule.test.ts).

/**
 * Whether to put the restart question now, and which chats to remember after.
 * `older`: the outdated chats now (their ids); `live`: every chat whose host runs now (outdated or not); `asked`: what
 * was remembered before (shared, any value). `always`: the person asked for the questions (`new-chat.update-check`,
 * or the update they started just ended). `answered`: the question was answered under the rule before this one (a
 * build asked once each, its Later or Restart kept): with nothing remembered yet, the chats running now count as asked,
 * so this rule's first look doesn't ask again about them. Remembers the chats asked about that still run, so the list
 * never grows.
 * @param {string[]} older @param {string[]} live @param {unknown} asked @param {boolean} [always] @param {boolean} [answered]
 * @returns {{ask: boolean, asked: string[]}}
 */
export function restartQuestion(older, live, asked, always = false, answered = false) {
  const kept = Array.isArray(asked) ? asked.filter((k) => typeof k === "string") : answered ? [...live, ...older] : [];
  const before = new Set(kept);
  const running = new Set([...live, ...older]);
  const ask = older.length > 0 && (always || older.some((c) => !before.has(c)));
  const still = [...before].filter((c) => running.has(c));
  return { ask, asked: [...new Set([...still, ...(ask ? older : [])])] };
}
