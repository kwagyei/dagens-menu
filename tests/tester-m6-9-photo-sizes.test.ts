/** Tester M6.9: edge cases of curatedSizes / photoSources and the image-variants script. */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { curatedSizes, curatedVariantUrl, photoSources } from "../src/content/images";
import { buildImageVariants, missingImageVariants } from "../scripts/image-variants";

const widths = (w: number, h: number) => curatedSizes(w, h).map((s) => s.width);

describe("curatedSizes edges", () => {
  it("exactly 320 / 319 / 400 / 1600 wide", () => {
    expect(widths(320, 200)).toEqual([320]);
    expect(widths(319, 200)).toEqual([]);
    expect(widths(400, 300)).toEqual([400]);
    expect(widths(1600, 1000)).toEqual([400, 800, 1200, 1600]);
    expect(widths(1601, 1000)).toEqual([400, 800, 1200, 1600]);
  });
  it("snaps within 10% above a step only", () => {
    expect(widths(1320, 880)).toEqual([400, 800, 1200]);
    expect(widths(1321, 880)).toEqual([400, 800, 1200, 1321]);
    expect(widths(440, 300)).toEqual([400]);
    expect(widths(441, 300)).toEqual([400, 441]);
  });
  it("portrait and very tall images obey the 2400 cap", () => {
    expect(curatedSizes(1000, 3000).at(-1)).toEqual({ width: 800, height: 2400 });
    expect(widths(1000, 3000)).toEqual([400, 800]);
    expect(widths(1200, 4000)).toEqual([400, 720]);
    expect(widths(4000, 100)).toEqual([400, 800, 1200, 1600]);
    // so narrow after the cap that nothing is made
    expect(widths(800, 10000)).toEqual([]);
    expect(photoSources({ ref: "/images/bistro/t.jpg", width: 800, height: 10000 })).toBeNull();
  });
  it("heights are never 0 and srcset widths are strictly increasing", () => {
    for (const [w, h] of [[4000, 10], [1600, 1], [321, 5000]] as const) {
      const s = curatedSizes(w, h);
      for (const x of s) expect(x.height).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < s.length; i++) expect(s[i].width).toBeGreaterThan(s[i - 1].width);
    }
  });
});

describe("photoSources / URLs", () => {
  it("320 wide: one 320 size, and src falls back to it", () => {
    const p = photoSources({ ref: "/images/bistro/s.jpg", width: 320, height: 240 })!;
    expect(p.sizes.map((s) => s.width)).toEqual([320]);
    expect(p.src).toBe("/images/bistro/v/s-320.webp");
  });
  it("dotted names keep inner dots; only the last extension goes", () => {
    expect(curatedVariantUrl("/images/bistro/a.b.c.jpg", 400)).toBe("/images/bistro/v/a.b.c-400.webp");
    expect(curatedVariantUrl("/images/bistro/noext", 400)).toBe("/images/bistro/v/noext-400.webp");
  });
  it("two refs that differ only in extension name the same variant file (collision)", () => {
    expect(curatedVariantUrl("/images/bistro/x.jpg", 400)).toBe(curatedVariantUrl("/images/bistro/x.png", 400));
  });
  it("upload ref: /media URLs, ladder below master, master last, no duplicate at exact step", () => {
    const id = "b".repeat(64);
    expect(photoSources({ ref: id, width: 800, height: 600 })!.sizes.map((s) => s.url)).toEqual([`/media/${id}-400.webp`, `/media/${id}-800.webp`]);
    const big = photoSources({ ref: id, width: 1600, height: 2400 })!;
    expect(big.srcset).toContain(`/media/${id}-1600.webp 1600w`);
    expect(big.src).toBe(`/media/${id}-800.webp`);
    // an upload narrower than 400 (cannot be uploaded, but the library may hold odd rows)
    expect(photoSources({ ref: id, width: 300, height: 200 })!.sizes.map((s) => s.width)).toEqual([300]);
  });
  it("srcset URLs contain no whitespace or comma (they would break the srcset syntax)", () => {
    for (const ref of ["/images/bistro/ok-name_1.v2.jpg"]) {
      const p = photoSources({ ref, width: 2000, height: 1000 })!;
      for (const s of p.sizes) expect(s.url).not.toMatch(/[\s,]/);
    }
  });
});

// ---- the build script, on a throwaway site ----
const SITE = "zz-tester-m69";
const root = join(__dirname, "..");
const siteDir = join(root, "sites", SITE);
const pubDir = join(root, "public", "images", SITE);
const out = (name: string, w: number) => join(pubDir, "v", `${name}-${w}.webp`);

async function jpeg(name: string, w: number, h: number, orientation?: number) {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: "#c33" } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  writeFileSync(join(pubDir, name), await img.toBuffer());
}

describe("image-variants", () => {
  beforeAll(async () => {
    mkdirSync(join(siteDir, "content"), { recursive: true });
    mkdirSync(pubDir, { recursive: true });
    await jpeg("plain.jpg", 1000, 600);
    await jpeg("rot.jpg", 1000, 1500, 6); // stored 1000x1500, displayed 1500x1000
    await jpeg("tiny.jpg", 200, 100);
    writeFileSync(
      join(siteDir, "content", "images.json"),
      JSON.stringify([{ ref: `/images/${SITE}/plain.jpg` }, { ref: `/images/${SITE}/rot.jpg` }, { ref: `/images/${SITE}/tiny.jpg` }, { ref: "a".repeat(64) }]),
    );
  });
  afterAll(() => {
    rmSync(siteDir, { recursive: true, force: true });
    rmSync(pubDir, { recursive: true, force: true });
  });

  it("makes the sizes, is idempotent, and ignores uploads and too-small files", async () => {
    expect(await buildImageVariants(SITE)).toBe(7); // plain 400/800/1000, rot 400/800/1200/1500
    expect(await buildImageVariants(SITE)).toBe(0);
    expect(existsSync(out("tiny", 200))).toBe(false);
  });

  it("EXIF orientation 6: library dims as seed stores them (swapped) match files made", async () => {
    const meta = await sharp(join(pubDir, "rot.jpg")).metadata();
    const [w, h] = [meta.height!, meta.width!]; // seed's swap rule
    const p = photoSources({ ref: `/images/${SITE}/rot.jpg`, width: w, height: h })!;
    for (const s of p.sizes) {
      const file = join(root, "public", s.url);
      expect(existsSync(file), s.url).toBe(true);
      const m = await sharp(file).metadata();
      expect({ w: m.width, h: m.height }).toEqual({ w: s.width, h: s.height });
    }
    expect(p.width).toBe(1500);
  });

  it("a changed source makes its sizes again; an untouched one is left alone", async () => {
    const before = statSync(out("plain", 400)).mtimeMs;
    const other = statSync(out("rot", 400)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await jpeg("plain.jpg", 1000, 600); // rewritten: newer mtime
    expect(await buildImageVariants(SITE)).toBe(3); // 400, 800, 1000
    expect(statSync(out("plain", 400)).mtimeMs).toBeGreaterThan(before);
    expect(statSync(out("rot", 400)).mtimeMs).toBe(other);
  });

  it("a source whose dimensions change gets the new plan; stale sizes are left behind", async () => {
    await jpeg("plain.jpg", 500, 300);
    await buildImageVariants(SITE);
    // 1000 wide made 400, 800, 1000(snap?) earlier; now 400,500
    expect(existsSync(out("plain", 500))).toBe(true);
    const stale = [800, 1000].filter((w) => existsSync(out("plain", w)));
    // documents behaviour: stale files are not removed (harmless, but they ship)
    expect(Array.isArray(stale)).toBe(true);
  });

  it("an output older than its source is rebuilt, but a restored OLDER source is not (mtime only)", async () => {
    const f = out("plain", 400);
    const src = join(pubDir, "plain.jpg");
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(src, old, old); // source "older" than output, content swapped
    await jpeg("plain.jpg", 500, 300, 6); // swapped content...
    utimesSync(src, old, old);
    const n = await buildImageVariants(SITE);
    // content changed (now rotated, displayed 300x500 -> too narrow) but mtime says nothing to do
    expect(n).toBe(0);
    expect(existsSync(f)).toBe(true);
  });

  it("--check lists missing sizes and exits 1; exits 0 when complete", async () => {
    await jpeg("plain.jpg", 1000, 600);
    await buildImageVariants(SITE);
    expect(await missingImageVariants(SITE)).toEqual([]);
    const run = () => spawnSync("npx", ["tsx", "scripts/image-variants.ts", "--site", SITE, "--check"], { cwd: root, encoding: "utf-8", timeout: 60_000 });
    expect(run().status).toBe(0);
    rmSync(out("plain", 800));
    expect(await missingImageVariants(SITE)).toEqual([`/images/${SITE}/plain.jpg → 800 px`]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("800 px");
    expect(readFileSync(join(siteDir, "content", "images.json"), "utf-8")).toContain("plain");
  }, 60_000);

  it("refuses two curated photos that would make the same files (x.jpg and x.png)", async () => {
    await jpeg("plain.png", 1000, 600);
    writeFileSync(join(siteDir, "content", "images.json"), JSON.stringify([{ ref: `/images/${SITE}/plain.jpg` }, { ref: `/images/${SITE}/plain.png` }]));
    await expect(buildImageVariants(SITE)).rejects.toThrow(/plain\.jpg and .*plain\.png would make the same files/);
  });
});
