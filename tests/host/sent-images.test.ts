// External and sent image mentions (host/providers/sent-images.ts and Claude follower/history).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageLines, readLocalImage } from "../../host/providers/sent-images.ts";
import { TranscriptFollower } from "../../host/providers/claude/follow.ts";
import { historyOf } from "../../host/providers/claude/history.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "binary");
const WEBP = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 \x04\x00\x00\x00\x00\x00\x00\x00", "binary");

test("imageLines extracts @<path> screenshots (standalone, captioned, quoted, spaces in .ovis cwd, mid-sentence) and rejects invalid/missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-sent-img-"));
  try {
    const ovisDir = join(dir, ".ovis");
    const spacedDir = join(dir, "My Project", ".ovis");
    const shotsDir = join(dir, "My Shots");
    mkdirSync(ovisDir, { recursive: true });
    mkdirSync(spacedDir, { recursive: true });
    mkdirSync(shotsDir, { recursive: true });

    const jpg = join(ovisDir, "paste-20261123-031336-81ae7966.jpg");
    const png = join(ovisDir, "paste-20261123-031337-1234abcd.png");
    const spaced = join(spacedDir, "paste-20261123-031338-deadbeef.webp");
    const quoted = join(shotsDir, "screen 1.gif");
    const fake = join(dir, "not-an-image.png");

    writeFileSync(jpg, JPEG);
    writeFileSync(png, PNG);
    writeFileSync(spaced, WEBP);
    writeFileSync(quoted, GIF);
    writeFileSync(fake, "plain text pretending to be png");

    // 1. Standalone OmaRelay phone screenshot.
    const one = imageLines(`@${jpg}`);
    assert.equal(one.text, "");
    assert.equal(one.images.length, 1);
    assert.equal(one.images[0]!.mimeType, "image/jpeg");
    assert.equal(one.images[0]!.data, JPEG.toString("base64"));

    // 2. Leading and trailing captions strip the mention cleanly.
    const lead = imageLines(`@${jpg} Look at this error`);
    assert.equal(lead.text, "Look at this error");
    assert.equal(lead.images.length, 1);

    const trail = imageLines(`Look at this error\n\n@${jpg}`);
    assert.equal(trail.text, "Look at this error");
    assert.equal(trail.images.length, 1);

    const sameLineTrail = imageLines(`Check this @${jpg}`);
    assert.equal(sameLineTrail.text, "Check this");
    assert.equal(sameLineTrail.images.length, 1);

    // 3. Multiple images including unquoted space-containing .ovis path and quoted path.
    const multi = imageLines(`@${spaced}\n@"${quoted}"\n@${png}`);
    assert.equal(multi.text, "");
    assert.deepEqual(multi.images.map((i) => i.mimeType), ["image/webp", "image/gif", "image/png"]);

    // 4. Mid-sentence mentions keep the sentence readable while still returning both images.
    const mid = imageLines(`Compare @${jpg} with @${png}`);
    assert.equal(mid.text, `Compare @${jpg} with @${png}`);
    assert.equal(mid.images.length, 2);

    // 5. Missing files, non-image bytes, and email-like strings stay untouched.
    assert.equal(readLocalImage(fake), null);
    assert.deepEqual(imageLines(`@${fake}`), { text: `@${fake}`, images: [] });
    assert.deepEqual(imageLines("@/nowhere/missing.png"), { text: "@/nowhere/missing.png", images: [] });
    assert.deepEqual(imageLines(`alice@${jpg}`), { text: `alice@${jpg}`, images: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Claude follower and history extract external @<path> screenshots alongside sent images", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-chat-claude-img-"));
  try {
    const shot = join(dir, "paste-20261123-031336-81ae7966.png");
    writeFileSync(shot, PNG);
    const rec = {
      uuid: "u-1",
      parentUuid: null,
      type: "user",
      timestamp: "2026-11-23T03:14:00Z",
      message: { role: "user", content: `@${shot}\nCheck this screenshot` },
    };

    const follower = new TranscriptFollower(join(dir, "s.jsonl"));
    const live = follower.feed(rec).find((e) => e.type === "user_message") as any;
    assert.ok(live);
    assert.equal(live.text, "Check this screenshot");
    assert.equal(live.images, 1);
    assert.equal(live.imageBlocks?.[0]?.mimeType, "image/png");

    const hist = historyOf([rec], join(dir, "s.jsonl")).find((e) => e.type === "user_message") as any;
    assert.ok(hist);
    assert.equal(hist.text, "Check this screenshot");
    assert.equal(hist.images, 1);
    assert.equal(hist.imageBlocks?.[0]?.mimeType, "image/png");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
