// Pictures in answers (protocol.md v3.11): a line of nothing but `![words](file)` (as
// `agentctl show --inline` prints) is an image block drawn from the host's copy of the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { pictureLine, splitBlocks } from "../../host/blocks.ts";
import { pictureFiles } from "../../host/render.ts";
import { startHost, idle } from "./harness.ts";

function png(w: number, h: number): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc((w + 1) * h))), chunk("IEND", Buffer.alloc(0))]);
}

test("pictureLine: only a line of pictures, with their words and destinations", () => {
  assert.deepEqual(pictureLine("![shot.png](/tmp/a%20b/shot.png)"), [{ alt: "shot.png", src: "/tmp/a%20b/shot.png" }]);
  assert.deepEqual(pictureLine("  ![a](x.png)  ![b \\[1\\]](<my dir/y.png> \"title\")"), [{ alt: "a", src: "x.png" }, { alt: "b [1]", src: "my dir/y.png" }]);
  assert.deepEqual(pictureLine("![](f(1).png)"), [{ alt: "", src: "f(1).png" }]);
  for (const no of ["text ![a](x.png)", "![a](x.png) and text", "[a](x.png)", "![a](x y.png)", "![a](x.png", "- ![a](x.png)", ""]) {
    assert.equal(pictureLine(no), null, no);
  }
});

test("pictureFiles: absolute, ~, file:// and relative paths, %-escapes decoded first; no URLs", () => {
  assert.deepEqual(pictureFiles("/srv/a%20b/c%28d%29.png", "/w"), ["/srv/a b/c(d).png", "/srv/a%20b/c%28d%29.png"]);
  assert.deepEqual(pictureFiles("/srv/x.png", null), ["/srv/x.png"]);
  assert.deepEqual(pictureFiles("~/p.png", "/w"), [join(homedir(), "p.png")]);
  assert.deepEqual(pictureFiles("file:///srv/a%20b.png", "/w"), ["/srv/a b.png"]);
  assert.deepEqual(pictureFiles("shots/x.png", "/w"), ["/w/shots/x.png"]);
  assert.deepEqual(pictureFiles("shots/x.png", null), []);
  for (const url of ["https://example.com/x.png", "data:image/png;base64,AAAA", "mailto:a@b"]) assert.deepEqual(pictureFiles(url, "/w"), [], url);
});

test("splitBlocks: a picture line whose files are found is a block per picture; anything else stays prose", () => {
  const found = (src: string) => (src.includes("missing") ? null : { path: `/copy/${src}`, size: { w: 4, h: 2 } });
  const text = [
    "Here it is:",
    "",
    "    ![indented code](e.png)",
    "",
    "![one](a.png) ![two](b.png)",
    "",
    "![gone](missing.png)",
    "",
    "1. First",
    "   ![three](c.png)",
    "2. Second",
    "",
    "```md",
    "![in code](d.png)",
    "```",
    "",
    "Done ![inline](f.png)",
  ].join("\n");
  const kinds = (bs: any[]) => bs.map((b) => (b.type === "image" ? `image:${b.alt}` : b.type === "markdown" ? `md:${b.text.split("\n").length}` : b.type));
  const bs = splitBlocks(text, false, found);
  assert.deepEqual(kinds(bs), ["md:3", "image:one", "image:two", "md:3", "image:three", "md:1", "code", "md:1"]);
  assert.deepEqual(bs[1], { type: "image", alt: "one", src: "a.png", path: "/copy/a.png", size: { w: 4, h: 2 } });
  assert.equal((bs[3] as any).text, "![gone](missing.png)\n\n1. First");
  // Without a finder (or one that finds nothing) the prose is as before.
  assert.deepEqual(splitBlocks(text, false), splitBlocks(text, false, () => null));
  // A streaming answer's last line can still grow: it waits; the lines before it don't.
  assert.deepEqual(kinds(splitBlocks("![one](a.png)\n![two](b.png)", true, found)), ["image:one", "md:1"]);
  assert.deepEqual(kinds(splitBlocks("![one](a.png)\n![two](b.png)", false, found)), ["image:one", "image:two"]);
});

const done = (c: any) => idle(c) && c.items.some((i: any) => i.kind === "assistant" && !i.streaming && i.text.startsWith("Shots"));

test("a host copies the pictures an answer shows and sends image blocks with their sizes; others stay as written", async () => {
  const dir = join(process.env.TMPDIR || "/tmp", `herdr-chat-pictures-${process.pid}`);
  const cwd = join(dir, "cwd");
  mkdirSync(join(cwd, "shots"), { recursive: true });
  mkdirSync(join(dir, "elsewhere", "a b"), { recursive: true });
  const outside = join(dir, "elsewhere", "a b", "wide.png");
  writeFileSync(outside, png(40, 20));
  writeFileSync(join(cwd, "shots", "tall.png"), png(10, 30));
  writeFileSync(join(cwd, "shots", "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="120" height="60"/></svg>');
  writeFileSync(join(cwd, "shots", "fake.png"), "not a picture");
  const text = [
    "Shots:",
    "",
    `![wide.png](${outside.replace(/ /g, "%20")})`,
    "![tall](shots/tall.png) ![chart](<shots/chart.svg>)",
    "![fake](shots/fake.png)",
    "![nowhere](shots/nowhere.png)",
  ].join("\n");
  const h = await startHost({ name: "pictures", cwd, scenario: { prompts: [{ match: ".", steps: [{ assistant: { text, chunk: 40, every: 5 } }] }] } });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "Show me" });
    await c.waitFor(done, 20_000, "the answer");
    const answer = c.items.find((i: any) => i.kind === "assistant" && i.text.startsWith("Shots"))!;
    const blocks = answer.blocks.map((b: any) => (b.type === "image" ? { type: b.type, alt: b.alt, src: b.src, size: b.size } : { type: b.type, text: b.text }));
    assert.deepEqual(blocks, [
      { type: "markdown", text: "Shots:" },
      { type: "image", alt: "wide.png", src: outside.replace(/ /g, "%20"), size: { w: 40, h: 20 } },
      { type: "image", alt: "tall", src: "shots/tall.png", size: { w: 10, h: 30 } },
      { type: "image", alt: "chart", src: "shots/chart.svg", size: null },
      { type: "markdown", text: "![fake](shots/fake.png)\n![nowhere](shots/nowhere.png)" },
    ]);
    // Each is a copy beside the chat's other images (under the app's home, where image() reads), the same bytes.
    const images = answer.blocks.filter((b: any) => b.type === "image");
    for (const [b, from] of [[images[0], outside], [images[1], join(cwd, "shots", "tall.png")], [images[2], join(cwd, "shots", "chart.svg")]] as const) {
      const [folder, name] = b.path.split("/").slice(-2) as [string, string];
      assert.equal(b.path, join(h.stateDir, "images", "c-test", folder, name));
      assert.match(folder, /^picture-[0-9a-f]{16}$/);
      assert.equal(name, from.split("/").at(-1), "the copy keeps its name, for the viewer's title");
      assert.deepEqual(readFileSync(b.path), readFileSync(from));
    }
    // The same answer again (history after a restart, or a re-send) uses the same copy.
    assert.equal(new Set(images.map((b: any) => b.path)).size, 3);
    assert.ok(images.every((b: any) => existsSync(b.path)));
  } finally {
    await h.stop();
  }
});
