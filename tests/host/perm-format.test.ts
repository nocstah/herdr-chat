// Command chain formatter for permission cards (herdr-app/mods/chat/perm-format.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain JS module of the chat mod
import { commandSteps } from "../../herdr-app/mods/chat/perm-format.js";

test("commandSteps splits top-level && / || / ; chains while preserving quoted and grouped expressions", () => {
  assert.deepEqual(
    commandSteps("systemctl --user restart omarelay.service && systemctl --user status omarelay.service --no-pager -n 12 && systemctl --user list-units --all --no-legend 'hc-shutdown-*'"),
    [
      { op: "$", text: "systemctl --user restart omarelay.service" },
      { op: "&&", text: "systemctl --user status omarelay.service --no-pager -n 12" },
      { op: "&&", text: "systemctl --user list-units --all --no-legend 'hc-shutdown-*'" },
    ],
  );

  // Semicolons inside double quotes (e.g. python3 -c "...") are NOT split.
  const py = `python3 -c "import sys; sys.path.insert(0, '/home/noc/code/omarelay/scripts'); import ovis; print('OK')"`;
  assert.deepEqual(commandSteps(py), [{ op: "$", text: py }]);

  // Operators inside subshells, command substitutions, and single quotes stay intact.
  const grouped = `echo "$(a && b)" || (c && d); echo 'x && y'`;
  assert.deepEqual(commandSteps(grouped), [
    { op: "$", text: `echo "$(a && b)"` },
    { op: "||", text: `(c && d)` },
    { op: ";", text: `echo 'x && y'` },
  ]);

  // Multi-line scripts keep their exact lines without splitting further.
  assert.deepEqual(commandSteps("set -e\n  echo hi\necho bye\n"), [
    { op: "$", text: "set -e" },
    { op: "", text: "  echo hi" },
    { op: "", text: "echo bye" },
  ]);

  assert.deepEqual(commandSteps("   "), []);
});
