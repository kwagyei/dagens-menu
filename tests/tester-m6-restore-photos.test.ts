/**
 * Tester, M6.4 (ADR-014 §5): hostile export files and photo folders for a restore. Each must be
 * refused with one readable line naming the photo, or restore exactly; never a crash with a raw
 * error, never a photo silently changed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadUploads } from "../scripts/restore-photos";
import { type LibraryImage, siteContentSchema, type Theme } from "../src/content/schema";
import { type OperatorContent, readExportFile } from "../src/db/export-file";
import { UPLOAD_BYTES } from "../src/db/photos";
import { BLOB_CHUNK_BYTES, seedStatements, type StoredContent } from "../src/db/seed";
import { renderSql } from "../src/db/sql";
import { readSiteJson } from "./site-fixtures";

const quiet = () => {};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const HERO = "public/images/bistro/kottbullar-hero.jpg";

let master1600: Buffer; // 1600 wide, from the hero
let id1600: string;
let other: Buffer; // a different photo
let otherId: string;
let one400: Buffer; // exactly 400 wide: a single size
let id400: string;

let server: Server;
let base: string;
let sent = 0;
const routes = new Map<string, (res: import("node:http").ServerResponse) => void>();

beforeAll(async () => {
  master1600 = await sharp(HERO).resize({ width: 1600 }).webp({ quality: 75 }).toBuffer();
  id1600 = sha(master1600);
  other = await sharp(HERO).resize({ width: 800 }).modulate({ hue: 120 }).webp({ quality: 75 }).toBuffer();
  otherId = sha(other);
  one400 = await sharp(HERO).resize({ width: 400 }).webp({ quality: 75 }).toBuffer();
  id400 = sha(one400);
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? "");
    if (route) route(res);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  routes.clear();
});

/** The test server's host, which the restore fetches from only when allowed (--allow-host). */
const local = () => [new URL(base).host];
const path = (id: string, w: number) => `/media/${id}-${w}.webp`;
const up = (id: string, variants: number[], master = `${base}${path(id, variants.at(-1)!)}`) => ({ id, variants, master });
const serve = (p: string, body: Uint8Array | string, headers: Record<string, string> = {}) =>
  routes.set(p, (res) => res.writeHead(200, { "Content-Type": "image/webp", ...headers }).end(body));

describe("area 1 (node half): sizes made again", () => {
  it("a 400 px master restores as a single size, byte for byte", async () => {
    serve(path(id400, 400), one400);
    const got = (await loadUploads([up(id400, [400])], undefined, quiet, local())).get(id400)!;
    expect(got.map((v) => v.width)).toEqual([400]);
    expect(sha(got[0].bytes)).toBe(id400);
  });

  it("a 1600 x 2400 master near the 1 MB cap: every statement under 100,000 bytes", async () => {
    // Noise compresses badly, so this master is close to the cap.
    const noise = Buffer.alloc(1600 * 2400 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    let big = await sharp(noise, { raw: { width: 1600, height: 2400, channels: 3 } }).webp({ quality: 40 }).toBuffer();
    for (const q of [30, 20, 10, 5]) {
      if (big.length <= 1_000_000) break;
      big = await sharp(noise, { raw: { width: 1600, height: 2400, channels: 3 } }).webp({ quality: q }).toBuffer();
    }
    expect(big.length).toBeLessThanOrEqual(1_048_576);
    const id = sha(big);
    serve(path(id, 1600), big);
    const got = (await loadUploads([up(id, [400, 800, 1200, 1600])], undefined, quiet, local())).get(id)!;
    expect(got.map((v) => [v.width, v.height])).toEqual([
      [400, 600],
      [800, 1200],
      [1200, 1800],
      [1600, 2400],
    ]);
    const total = got.reduce((n, v) => n + v.bytes.length, 0);
    console.log(`tester: near-cap master ${big.length} B; restored total ${total} B (upload cap ${UPLOAD_BYTES})`);

    const repo = readSiteJson("bistro");
    const { theme: _t, ...parsed } = siteContentSchema("bistro").parse(repo);
    const content = structuredClone(parsed) as StoredContent;
    content.images.push({ ref: id, alt: { sv: "Brus", en: "Noise" } });
    const statements = seedStatements("bistro", content, (p) => ({ id: sha(Buffer.from(p)), mime: "image/jpeg" }), new Date(), "t", new Map([[id, got]]));
    const longest = Math.max(...statements.map((s) => Buffer.byteLength(renderSql([s]))));
    console.log(`tester: longest rendered statement ${longest} B`);
    expect(longest).toBeLessThan(100_000);
    const updates = statements.filter((s) => s.sql.startsWith("UPDATE image_variants")).length;
    const expected = got.reduce((n, v) => n + Math.ceil(v.bytes.length / BLOB_CHUNK_BYTES) - 1, 0);
    expect(updates).toBe(expected);
  }, 60_000);
});

describe("area 2: hostile links", () => {
  it("never follows a redirect, even to the right bytes: the link must be the photo (F5)", async () => {
    routes.set(path(id1600, 1600), (res) => res.writeHead(302, { Location: `${base}/elsewhere` }).end());
    serve("/elsewhere", master1600);
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id1600}: couldn't fetch`));
  });

  it("refuses a link with a user name or password in it (F5)", async () => {
    const withUser = { ...up(id1600, [400, 800, 1200, 1600]), master: `http://user:secret@127.0.0.1:1/media/${id1600}-1600.webp` };
    await expect(loadUploads([withUser], undefined, quiet, local())).rejects.toThrow(/user name or password/);
  });

  it("a redirect to file:// is refused with a line naming the photo", async () => {
    routes.set(path(id1600, 1600), (res) => res.writeHead(302, { Location: "file:///etc/passwd" }).end());
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id1600}: couldn't fetch`));
  });

  it("a 200 with an HTML page is refused by the hash check", async () => {
    serve(path(id1600, 1600), "<!doctype html><title>Login</title>", { "Content-Type": "text/html" });
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(/has been changed/);
  });

  it("an id whose link serves another photo's bytes is refused", async () => {
    serve(path(id1600, 1600), other);
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(/has been changed/);
  });

  // Finding (see the M6.4 tester report), fixed in the same PR.
  it("a huge response is not read past the size a photo can have", async () => {
    // 64 MB, streamed; a photo is at most 1,048,576 bytes.
    sent = 0;
    routes.set(path(id1600, 1600), (res) => {
      res.writeHead(200, { "Content-Type": "image/webp" });
      const chunk = Buffer.alloc(1 << 20);
      let left = 64;
      const pump = () => {
        while (left > 0) {
          left--;
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => (left = 0));
      pump();
    });
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(/^photo /);
    console.log(`tester: huge response: the server sent ${sent} bytes before the client stopped`);
    expect(sent, "the client reads the whole body before refusing it").toBeLessThan(8 * (1 << 20));
  }, 30_000);

  // Finding (see the M6.4 tester report), fixed in the same PR.
  it("a server that sends headers and then stalls times out with a line naming the photo", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(300));
    routes.set(path(id1600, 1600), (res) => {
      res.writeHead(200, { "Content-Type": "image/webp" });
      res.write(master1600.subarray(0, 1000)); // then nothing
    });
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id1600}: `));
  });

  it("a server that never answers times out with a line naming the photo", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(300));
    routes.set(path(id1600, 1600), () => {}); // no headers
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id1600}: couldn't fetch .*pass --photos`));
  });

  // Finding (see the M6.4 tester report), fixed in the same PR.
  it("a connection cut mid-body is refused with a line naming the photo", async () => {
    routes.set(path(id1600, 1600), (res) => {
      res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": String(master1600.length) });
      res.write(master1600.subarray(0, 1000), () => res.destroy());
    });
    await expect(loadUploads([up(id1600, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id1600}: `));
  });

  // Finding (see the M6.4 tester report), fixed in the same PR.
  it("the file's widths are checked against the photo itself", async () => {
    // The file says [400, 800] with a -800 link, but the bytes behind the id are 1600 wide.
    serve(path(id1600, 800), master1600);
    const result = loadUploads([up(id1600, [400, 800])], undefined, quiet, local());
    await expect(result, "a 1600 px photo listed as 800 px").rejects.toThrow(/^photo /);
  });

  // Finding (see the M6.4 tester report), fixed in the same PR.
  it("a well-headed WebP that doesn't decode is refused with a line naming the photo", async () => {
    // Keep the RIFF and VP8 headers, scramble the bitstream after them, so the headers still pass.
    const broken = Buffer.from(master1600);
    for (let i = 40; i < broken.length; i++) broken[i] = (i * 31) & 0xff;
    const id = sha(broken);
    serve(path(id, 1600), broken);
    await expect(loadUploads([up(id, [400, 800, 1200, 1600])], undefined, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id}: its image data can't be decoded`));
  });
});

describe("area 2: the reader refuses links that aren't to a photo", () => {
  const SITE = "bistro";
  const repo = readSiteJson(SITE);
  const op: OperatorContent = { theme: repo.theme as Theme, settings: repo.settings, images: repo.images as LibraryImage[] };
  const id = "a".repeat(64);
  const fileWith = (entries: Array<Record<string, unknown>>) => {
    const { theme: _t, ...content } = structuredClone(repo);
    content.images = [...content.images, ...entries];
    return JSON.stringify({ format: "dagens-menu-export", formatVersion: 2, site: SITE, exportedAt: "2026-10-17T10:00:00Z", contentVersion: 1, content });
  };
  const entry = (master: string, variants = [400, 800]) => ({ ref: id, alt: { sv: "Foto", en: "Photo" }, variants, master });

  it.each([
    ["file://", `file:///media/${id}-800.webp`],
    ["ftp:", `ftp://host/media/${id}-800.webp`],
    ["data:", `data:image/webp;base64,AAAA/media/${id}-800.webp`],
    ["javascript:", `javascript://x/media/${id}-800.webp`],
    ["a fragment", `https://h/media/${id}-800.webp#x`],
    ["a relative link", `/media/${id}-800.webp`],
    ["uppercase id in the path", `https://h/media/${id.toUpperCase()}-800.webp`],
  ])("refuses %s", (_name, master) => {
    const r = readExportFile(fileWith([entry(master)]), SITE, op);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain("\n");
  });

  it("reads a link to any other host: the fetch, not the file, decides which hosts it trusts (L2)", () => {
    for (const master of [`https://user:pw@evil.example/media/${id}-800.webp`, `http://169.254.169.254/media/${id}-800.webp`, `http://localhost:22/media/${id}-800.webp`]) {
      const r = readExportFile(fileWith([entry(master)]), SITE, op);
      expect(r.ok, master).toBe(true);
    }
  });

  it("refuses duplicate upload entries", () => {
    const r = readExportFile(fileWith([entry(`https://h/media/${id}-800.webp`), entry(`https://h/media/${id}-800.webp`)]), SITE, op);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("duplicate") });
  });

  it.each([
    ["empty variants", []],
    ["a fraction", [400.5, 800]],
    ["a string", ["400", 800]],
    ["over 1600", [400, 2000]],
    ["repeated", [800, 800]],
  ])("refuses %s", (_name, variants) => {
    const r = readExportFile(fileWith([entry(`https://h/media/${id}-800.webp`, variants as number[])]), SITE, op);
    expect(r.ok).toBe(false);
  });

  it("refuses variants or a master on a curated image", () => {
    const { theme: _t, ...content } = structuredClone(repo);
    content.images[0].variants = [400];
    const r = readExportFile(JSON.stringify({ format: "dagens-menu-export", formatVersion: 2, site: SITE, exportedAt: "2026-10-17T10:00:00Z", contentVersion: 1, content }), SITE, op);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("only an uploaded photo") });
  });

  it("an upload without variants or master is refused", () => {
    const r = readExportFile(fileWith([{ ref: id, alt: { sv: "Foto", en: "Photo" } }]), SITE, op);
    expect(r.ok).toBe(false);
  });
});

describe("area 4: the --photos folder", () => {
  const upload = () => up(id1600, [400, 800, 1200, 1600]);

  it("a file named for one id holding another photo is refused, not replaced by the fetch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    writeFileSync(join(dir, `${id1600}.webp`), other);
    serve(path(id1600, 1600), master1600);
    await expect(loadUploads([upload()], dir, quiet, local())).rejects.toThrow(/has been changed/);
  });

  it("a symlink to the right photo is read through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    writeFileSync(join(dir, "real.webp"), master1600);
    symlinkSync(join(dir, "real.webp"), join(dir, `${id1600}.webp`));
    vi.stubGlobal("fetch", vi.fn());
    expect((await loadUploads([upload()], dir, quiet, local())).get(id1600)!.length).toBe(4);
  });

  it("a symlink to another file is refused, and its content isn't echoed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    writeFileSync(join(dir, "secret.txt"), "SECRET-TOKEN-123");
    symlinkSync(join(dir, "secret.txt"), join(dir, `${id1600}.webp`));
    const error = await loadUploads([upload()], dir, quiet, local()).catch((e: Error) => e);
    expect(String(error)).toMatch(/has been changed/);
    expect(String(error)).not.toContain("SECRET");
  });

  it("a dangling symlink falls back to the link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    symlinkSync(join(dir, "missing.webp"), join(dir, `${id1600}.webp`));
    serve(path(id1600, 1600), master1600);
    expect((await loadUploads([upload()], dir, quiet, local())).get(id1600)!.length).toBe(4);
  });

  it("a missing file falls back to the link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    serve(path(id1600, 1600), master1600);
    expect((await loadUploads([upload()], dir, quiet, local())).get(id1600)!.length).toBe(4);
  });

  it("an uppercase file name: found or fetched, but the restore never differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    writeFileSync(join(dir, `${id1600.toUpperCase()}.WEBP`), master1600);
    serve(path(id1600, 1600), master1600);
    const got = (await loadUploads([upload()], dir, quiet, local())).get(id1600)!;
    expect(sha(got.at(-1)!.bytes)).toBe(id1600);
  });

  // Finding (see the M6.4 tester report), fixed in the same PR.
  it("a folder named <id>.webp is refused with a line naming the photo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    mkdirSync(join(dir, `${id1600}.webp`));
    serve(path(id1600, 1600), master1600);
    await expect(loadUploads([upload()], dir, quiet, local())).rejects.toThrow(new RegExp(`^photo ${id1600}: `));
  });

  it("several uploads: one bad one refuses the whole restore, and says which", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    writeFileSync(join(dir, `${id400}.webp`), one400);
    writeFileSync(join(dir, `${otherId}.webp`), master1600); // wrong bytes
    await expect(loadUploads([up(id400, [400]), up(otherId, [400, 800])], dir, quiet, local())).rejects.toThrow(new RegExp(`^photo ${otherId}: `));
  });
});
