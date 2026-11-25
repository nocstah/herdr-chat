// Native file picker command building, result parsing, and @-mention formatting
// (herdr-app/mods/chat/file-picker.js).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error a plain JS module of the mod's
import { PICKER_TIMEOUT_MS, composeWithFiles, formatMention, parsePickerResult, pickFiles, pickerCandidates } from "../../herdr-app/mods/chat/file-picker.js";

test("formatMention makes cwd-relative paths short and quotes paths with spaces or quotes", () => {
  assert.equal(formatMention("/repo/src/index.ts", "/repo"), "@src/index.ts");
  assert.equal(formatMention("/repo/src/index.ts", "/repo/"), "@src/index.ts");
  assert.equal(formatMention("/other/report.pdf", "/repo"), "@/other/report.pdf");
  assert.equal(formatMention("/repo/docs/my spec.md", "/repo"), '@"docs/my spec.md"');
  assert.equal(formatMention("/tmp/My Report (v2).pdf", "/repo"), '@"/tmp/My Report (v2).pdf"');
  assert.equal(formatMention('/tmp/say "hi".txt', null), '@"/tmp/say \\"hi\\".txt"');
  assert.equal(formatMention("/etc/hosts", "/"), "@/etc/hosts");
});

test("composeWithFiles preserves leading slash commands/skills and handles empty text", () => {
  assert.equal(composeWithFiles("hello", [], "/repo"), "hello");
  assert.equal(composeWithFiles("", ["/repo/a.txt", "/tmp/my file.pdf"], "/repo"), '@a.txt @"/tmp/my file.pdf"');
  assert.equal(
    composeWithFiles("Summarize these", ["/repo/docs/spec.md", "/tmp/data 1.csv"], "/repo"),
    'Summarize these\n\n@docs/spec.md @"/tmp/data 1.csv"',
  );
  assert.equal(
    composeWithFiles("/review", ["/repo/src/app.ts"], "/repo"),
    "/review\n\n@src/app.ts",
  );
});

test("pickerCandidates builds Linux (zenity then kdialog) and macOS (osascript) invocations", () => {
  const linux = pickerCandidates({ platform: "linux", startDir: "/home/noc/project/" });
  assert.deepEqual(linux.map((c: any) => c.kind), ["zenity", "kdialog"]);
  assert.ok(linux[0]!.args.includes("--file-selection"));
  assert.ok(linux[0]!.args.includes("--multiple"));
  assert.ok(linux[0]!.args.includes("--filename=/home/noc/project/"));
  assert.equal(linux[1]!.args[0], "--getopenfilename");
  assert.equal(linux[1]!.args[1], "/home/noc/project");

  const linuxNoDir = pickerCandidates({ platform: "linux", startDir: null });
  assert.ok(!linuxNoDir[0]!.args.some((a: string) => a.startsWith("--filename=")));
  assert.equal(linuxNoDir[1]!.args[1], ".");

  const mac = pickerCandidates({ platform: "darwin", startDir: "/Users/noc/work" });
  assert.deepEqual(mac.map((c: any) => c.kind), ["osascript"]);
  assert.equal(mac[0]!.args[0], "-e");
  assert.deepEqual(mac[0]!.args.slice(-2), ["--", "/Users/noc/work"]);

  const macNoDir = pickerCandidates({ platform: "macos", startDir: null });
  assert.equal(macNoDir[0]!.args.length, 2);
});

test("parsePickerResult handles selections, cancellations (with benign GTK stderr), and real errors", () => {
  assert.deepEqual(
    parsePickerResult("zenity", { code: 0, stdout: "/tmp/a.pdf\n/tmp/My File.csv\n", stderr: "Gtk-Message: 12:00:00: benign" }),
    { status: "ok", paths: ["/tmp/a.pdf", "/tmp/My File.csv"] },
  );
  assert.deepEqual(
    parsePickerResult("zenity", { code: 1, stdout: "", stderr: "Gtk-WARNING **: some theme warning\n" }),
    { status: "cancelled", paths: [] },
  );
  assert.equal(
    parsePickerResult("zenity", { code: 1, stdout: "", stderr: "Gtk-WARNING **: cannot open display:\n" }).status,
    "error",
  );
  assert.deepEqual(
    parsePickerResult("kdialog", { code: 1, stdout: "", stderr: "" }),
    { status: "cancelled", paths: [] },
  );
  assert.deepEqual(
    parsePickerResult("osascript", { code: 1, stdout: "", stderr: "execution error: User canceled. (-128)\n" }),
    { status: "cancelled", paths: [] },
  );
  assert.deepEqual(
    parsePickerResult("osascript", { code: 0, stdout: "/Users/noc/a.pdf\r\n/Users/noc/b c.txt\r\n", stderr: "" }),
    { status: "ok", paths: ["/Users/noc/a.pdf", "/Users/noc/b c.txt"] },
  );
});

test("pickFiles falls back from missing zenity to kdialog, stops on cancel, and errors when none exist", async () => {
  const seen: { cmd: string; timeout: number }[] = [];
  const picked = await pickFiles(async (cmd: string, _args: string[], opts: { timeout: number }) => {
    seen.push({ cmd, timeout: opts.timeout });
    if (cmd === "zenity") throw new Error("ENOENT");
    return { code: 0, stdout: "/tmp/one.pdf\n/tmp/two words.md\n", stderr: "" };
  }, { platform: "linux", startDir: "/tmp" });
  assert.deepEqual(picked, ["/tmp/one.pdf", "/tmp/two words.md"]);
  assert.deepEqual(seen, [
    { cmd: "zenity", timeout: PICKER_TIMEOUT_MS },
    { cmd: "kdialog", timeout: PICKER_TIMEOUT_MS },
  ]);

  // Cancel on primary picker returns [] without invoking fallback.
  const calls: string[] = [];
  const cancelled = await pickFiles(async (cmd: string) => {
    calls.push(cmd);
    return { code: 1, stdout: "", stderr: "" };
  }, { platform: "linux" });
  assert.deepEqual(cancelled, []);
  assert.deepEqual(calls, ["zenity"]);

  // Neither picker installed gives an actionable message.
  await assert.rejects(
    pickFiles(async () => ({ code: 127, stdout: "", stderr: "not found" }), { platform: "linux" }),
    /No file picker found/,
  );
});
