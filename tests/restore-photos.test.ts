/**
 * Bringing uploaded photos back for a restore (plan M6.4): from a folder or the export's link,
 * refused unless the SHA-256 is the id, with the smaller sizes made again by libwebp.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { linkProblem, loadUploads } from "../scripts/restore-photos";

let master: Buffer;
let id: string;
const quiet = () => {};
// The stubbed fetch answers for this host; the restore fetches from it only when told to.
const TRUSTED = ["example.test"];

beforeAll(async () => {
  master = await sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width: 1600 }).webp({ quality: 75 }).toBuffer();
  id = createHash("sha256").update(master).digest("hex");
});
afterEach(() => vi.unstubAllGlobals());

const upload = () => ({ id, variants: [400, 800, 1200, 1600], master: `https://example.test/media/${id}-1600.webp` });

describe("loadUploads", () => {
  it("takes the master from the folder, keeps it byte for byte and makes the smaller sizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    writeFileSync(join(dir, `${id}.webp`), master);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const loaded = (await loadUploads([upload()], dir, quiet)).get(id)!;
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loaded.map((v) => v.width)).toEqual([400, 800, 1200, 1600]);
    expect(Buffer.from(loaded[3].bytes).equals(master)).toBe(true);
    for (const v of loaded) expect(Buffer.from(v.bytes).subarray(8, 12).toString()).toBe("WEBP");
  });

  it("fetches the link when the folder doesn't have it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(master), { status: 200 })));
    const loaded = await loadUploads([upload()], undefined, quiet, TRUSTED);
    expect(loaded.get(id)!.length).toBe(4);
  });

  it("refuses a changed photo: its SHA-256 isn't the id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "photos-"));
    const changed = Buffer.from(master);
    changed[changed.length - 10] ^= 0xff;
    writeFileSync(join(dir, `${id}.webp`), changed);
    await expect(loadUploads([upload()], dir, quiet)).rejects.toThrow(/has been changed/);
  });

  it("says what to do when the link can't be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
    await expect(loadUploads([upload()], undefined, quiet, TRUSTED)).rejects.toThrow(/answered 404; pass --photos/);
  });

  it("refuses bytes that are no WebP, even if they hash to the id", async () => {
    const jpeg = await sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width: 400 }).jpeg().toBuffer();
    const jpegId = createHash("sha256").update(jpeg).digest("hex");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(jpeg))));
    await expect(loadUploads([{ id: jpegId, variants: [400], master: `https://example.test/media/${jpegId}-400.webp` }], undefined, quiet, TRUSTED)).rejects.toThrow(/not a photo the upload page accepts/);
  });
});

describe("which links a restore fetches (L2)", () => {
  it.each([
    "https://dagens-menu-bistro.kwabenasasuboakye.workers.dev/media/x.webp",
    "https://dagens-menu-westafrican.kwabenasasuboakye.workers.dev/media/x.webp",
  ])("fetches from this project's Workers unasked: %s", (link) => {
    expect(linkProblem(new URL(link))).toBeNull();
  });

  it.each([
    ["plain http to a Worker", "http://dagens-menu-bistro.kwabenasasuboakye.workers.dev/media/x.webp", "isn't https"],
    ["the cloud metadata address", "http://169.254.169.254/media/x.webp", "isn't https"],
    ["a local service", "https://localhost:22/media/x.webp", "isn't one of this project's Workers"],
    ["a private address", "https://10.0.0.1/media/x.webp", "isn't one of this project's Workers"],
    ["another account's Worker", "https://dagens-menu-bistro.someone.workers.dev/media/x.webp", "isn't one of this project's Workers"],
    ["a look-alike host", "https://dagens-menu-bistro.kwabenasasuboakye.workers.dev.evil.example/media/x.webp", "isn't one of this project's Workers"],
    ["a Worker on another port", "https://dagens-menu-bistro.kwabenasasuboakye.workers.dev:8443/media/x.webp", "isn't one of this project's Workers"],
  ])("refuses %s unless allowed", (_, link, problem) => {
    const url = new URL(link);
    expect(linkProblem(url)).toContain(problem);
    expect(linkProblem(url)).toContain(`--allow-host ${url.host}`);
    expect(linkProblem(url, [url.host])).toBeNull();
  });

  it("matches --allow-host by host and port, however it is spelled", () => {
    const url = new URL("http://localhost:8790/media/x.webp");
    expect(linkProblem(url, ["Localhost:8790"])).toBeNull();
    expect(linkProblem(url, ["http://localhost:8790/"])).toBeNull();
    expect(linkProblem(url, ["localhost"])).not.toBeNull();
    expect(linkProblem(url, ["localhost:8791", ""])).not.toBeNull();
  });

  it("refuses a link to a private address without fetching it, naming the way round", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const link = { ...upload(), master: `http://192.168.1.1/media/${id}-1600.webp` };
    await expect(loadUploads([link], undefined, quiet)).rejects.toThrow(new RegExp(`^photo ${id}: the link isn't https; pass --allow-host 192.168.1.1 if you trust it, or pass --photos`));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
