// Antigravity CLI's transcript records and tools (items.ts, tools.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgyTranscriptFollower, extractUserText } from "../../host/providers/antigravity/items.ts";
import { ANTIGRAVITY_TOOLS, cleanToolOutput, decodeToolArgs } from "../../host/providers/antigravity/tools.ts";
import { applyResult, presentTool } from "../../host/tools.ts";

test("extractUserText strips Antigravity XML wrappers and metadata", () => {
  const raw = `<USER_REQUEST>
Fix the login bug
and add a test
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-11-23T06:15:32+07:00.
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
The user changed setting \`Model Selection\` from None to Gemini 4 Neon (XHigh).
</USER_SETTINGS_CHANGE>`;
  assert.equal(extractUserText(raw), "Fix the login bug\nand add a test");
  assert.equal(extractUserText("plain prompt\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>"), "plain prompt");
});

test("decodeToolArgs unwraps JSON-encoded values and leaves plain values alone", () => {
  assert.deepEqual(
    decodeToolArgs({
      CommandLine: '"ls -la /tmp"',
      WaitMsBeforeAsync: "5000",
      BypassSandbox: "true",
      StartLine: "10",
      Plain: "already plain",
      Nested: '{"a":1}',
      Truncated: '"python3 - <<\'PY\'\\nprint(\\"hi\\")\\\n<truncated 147 bytes>',
    }),
    {
      CommandLine: "ls -la /tmp",
      WaitMsBeforeAsync: 5000,
      BypassSandbox: true,
      StartLine: 10,
      Plain: "already plain",
      Nested: { a: 1 },
      Truncated: "python3 - <<'PY'\nprint(\"hi\")\n<truncated 147 bytes>",
    },
  );
});

test("ANTIGRAVITY_TOOLS presents commands, reads, edits with diffs, writes, searches, subagents and exit codes", () => {
  const cmd = presentTool(ANTIGRAVITY_TOOLS, "run_command", { CommandLine: "npm test", toolSummary: "Run tests" }, "/proj");
  assert.equal(cmd.title, "$ npm test");
  assert.deepEqual(cmd.detail, { type: "bash", command: "npm test" });
  const out0 = cleanToolOutput("Created At: 2026-11-23T06:15:38+07:00\nCompleted At: 2026-11-23T06:15:40+07:00\nCreated At: 2026-11-23T06:15:38+07:00\nCompleted At: 2026-11-23T06:15:40+07:00\nCommand exited with code 0.\n\nCommand output:\nok\n");
  assert.equal(out0, "Command exited with code 0.\n\nCommand output:\nok\n");
  assert.equal((applyResult(ANTIGRAVITY_TOOLS, "run_command", cmd.detail, null, false, out0, "/proj") as any).exitCode, 0);
  const out2 = "Command exited with code 2.\n\nCommand output:\nfailed\n";
  assert.equal((applyResult(ANTIGRAVITY_TOOLS, "run_command", cmd.detail, null, true, out2, "/proj") as any).exitCode, 2);

  const rd = presentTool(ANTIGRAVITY_TOOLS, "read_file", { Path: "/proj/src/app.ts", StartLine: 10, EndLine: 25 }, "/proj");
  assert.equal(rd.title, "Read src/app.ts:10-25");
  assert.deepEqual(rd.detail, { type: "read", path: "/proj/src/app.ts", offset: 10, limit: 16 });

  const ed = presentTool(ANTIGRAVITY_TOOLS, "edit_file", { Path: "/proj/src/app.ts", Target: "const a = 1;", Replacement: "const a = 2;" }, "/proj");
  assert.equal(ed.title, "Edit src/app.ts");
  assert.equal(ed.detail.type, "edit");
  assert.match((ed.detail as any).diff, /-const a = 1;\n\+const a = 2;/);

  const wr = presentTool(ANTIGRAVITY_TOOLS, "write_file", { Path: "/proj/new.txt", Content: "hello" }, "/proj");
  assert.equal(wr.title, "Write new.txt");
  assert.deepEqual(wr.detail, { type: "write", path: "/proj/new.txt", bytes: 5 });

  const ag = presentTool(ANTIGRAVITY_TOOLS, "invoke_subagent", { TypeName: "research", Role: "Codebase Explorer", Prompt: "Scan files" }, "/proj");
  assert.equal(ag.title, "Agent Codebase Explorer");
  assert.deepEqual(ag.detail, { type: "agent", description: "Scan files", agentType: "research" });
});

test("AgyTranscriptFollower maps a full turn, pairs tool calls across history->live, and deduplicates steps", () => {
  const f = new AgyTranscriptFollower({ history: true });
  const ev0 = f.feed({
    step_index: 0,
    type: "USER_INPUT",
    status: "DONE",
    created_at: "2026-11-22T23:15:32Z",
    content: "<USER_REQUEST>\nCheck status\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>",
  });
  assert.deepEqual(ev0.map((e) => [e.type, (e as any).text, (e as any).source]), [["user_message", "Check status", "composer"]]);

  const ev1 = f.feed({
    step_index: 1,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-22T23:15:33Z",
    model: "gemini-4-neon-xhigh",
    input_tokens: 9000,
    cache_read_tokens: 1500,
    output_tokens: 200,
    thinking: "Checking git status.",
    tool_calls: [
      { name: "run_command", args: { CommandLine: '"git status"', WaitMsBeforeAsync: "5000" } },
      { name: "read_file", args: { Path: '"/proj/README.md"' } },
    ],
  });
  assert.ok(ev1.some((e) => e.type === "model" && (e as any).model.id === "gemini-4-neon" && (e as any).model.name === "Gemini 4 Neon"));
  assert.ok(ev1.some((e) => e.type === "thinking" && (e as any).level === "xhigh"));
  assert.equal(ev1.filter((e) => e.type === "tool_call").length, 2);
  assert.equal(f.usage().contextTokens, 10500);
  assert.equal(f.turn, "running");

  // First tool finishes during history replay.
  const ev2 = f.feed({
    step_index: 2,
    type: "GENERIC",
    status: "DONE",
    created_at: "2026-11-22T23:15:34Z",
    content: "Created At: 2026-11-23T06:15:34+07:00\nCompleted At: 2026-11-23T06:15:34+07:00\nCommand exited with code 0.\n\nCommand output:\nclean\n",
  });
  assert.equal(ev2.length, 1);
  assert.equal(ev2[0]!.type, "tool_ended");
  assert.equal((ev2[0] as any).callId, "agy-1-0");
  assert.equal((ev2[0] as any).name, "run_command");
  assert.equal((ev2[0] as any).isError, false);

  // Transition to live while second tool call is still in-flight!
  f.setLive();
  // Re-feeding an already-seen step produces nothing.
  assert.deepEqual(f.feed({ step_index: 2, type: "GENERIC", status: "DONE", content: "dup" }), []);

  // Second tool finishes live with an error.
  const ev3 = f.feed({
    step_index: 3,
    type: "GENERIC",
    status: "ERROR",
    error: "permission denied by user",
    content: "permission denied by user",
  });
  assert.equal(ev3.length, 1);
  assert.equal((ev3[0] as any).callId, "agy-1-1");
  assert.equal((ev3[0] as any).name, "read_file");
  assert.equal((ev3[0] as any).isError, true);
  assert.equal((ev3[0] as any).declined, true);

  // Error notice + internal system reminder (skipped) + background task notice.
  const evErr = f.feed({ step_index: 4, type: "ERROR_MESSAGE", status: "DONE", error: "API error (attempt 1): UNAVAILABLE (code 503)" });
  assert.equal(evErr[0]!.type, "notice");
  assert.deepEqual(f.feed({ step_index: 5, type: "SYSTEM_MESSAGE", status: "DONE", content: "<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>" }), []);
  const evBg = f.feed({ step_index: 6, type: "SYSTEM_MESSAGE", status: "DONE", content: 'Task id "abc/task-12" finished with result:\nok' });
  assert.equal(evBg[0]!.type, "notice");
  assert.match((evBg[0] as any).text, /task-12 finished/);

  // Final assistant answer closes the turn.
  const evFinal = f.feed({
    step_index: 7,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    model: "gemini-4-neon-xhigh",
    input_tokens: 11000,
    cache_read_tokens: 2000,
    output_tokens: 50,
    content: "All clean.",
  });
  assert.equal(f.turn, "ended");
  assert.ok(evFinal.some((e) => e.type === "assistant_end" && (e as any).stopReason === "stop"));
});
