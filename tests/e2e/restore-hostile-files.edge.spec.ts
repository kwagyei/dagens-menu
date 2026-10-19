/**
 * Tester, M6.4 on the real Worker and seed CLI: several uploads (one in use as a dish photo,
 * one unused, one with a single size, one large 1600 x 2400), the "Your photos" page in both
 * languages, hostile export files that must leave the database exactly as it was (even with
 * --reset), and a real restore from the link and from --photos.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, type Page, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

test.setTimeout(180_000);
const BASE = "http://localhost:8790";
const NEW = "/admin/photos/new/";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const seed = (...args: string[]) => {
  const r = spawnSync("npm", ["run", "-s", "seed", "--", "--site", "bistro", "--allow-host", "localhost:8790", "--allow-host", "127.0.0.1:9", ...args], {
    encoding: "utf-8",
    timeout: 90_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

async function upload(page: Page, parts: Buffer[], alt: { sv: string; en: string }): Promise<string> {
  await page.goto(NEW);
  const form = new FormData();
  form.set("csrf", await page.locator("input[name=csrf]").first().inputValue());
  form.set("alt_sv", alt.sv);
  form.set("alt_en", alt.en);
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  const res = await page.request.post(NEW, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.status(), await res.text()).toBe(303);
  return sha(parts.at(-1)!);
}

const ladder = (src: string, widths: number[], hue: number, quality = 75) =>
  Promise.all(widths.map((w) => sharp(src).resize({ width: w }).modulate({ hue }).webp({ quality }).toBuffer()));

test("several uploads: Your photos page, hostile files change nothing, restore brings all back", async ({ page, request, browser }) => {
  await signedInOwner(page);
  const MARKUP = `<b>fet</b> & "citat" <script>alert(1)</script>`;
  const a = await ladder("public/images/bistro/toast-skagen-roe.jpg", [400, 800], 33);
  const b = await ladder("public/images/bistro/kottbullar-hero.jpg", [400], 77);
  // 1600 x 2400 from a tall crop, at a quality that keeps the upload just under 1,000,000 bytes.
  const tall = await sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width: 1600, height: 2400, fit: "cover" }).png().toBuffer();
  let c: Buffer[] = [];
  for (const q of [95, 90, 85, 80, 75, 70, 60]) {
    c = await Promise.all([400, 800, 1200, 1600].map((w) => sharp(tall).resize({ width: w }).modulate({ hue: 151 }).webp({ quality: q }).toBuffer()));
    if (c.reduce((n, p) => n + p.length, 0) <= 1_000_000) break;
  }
  const idA = await upload(page, a, { sv: "I bruk", en: "In use" });
  const idB = await upload(page, b, { sv: MARKUP, en: "One size" });
  const idC = await upload(page, c, { sv: "Stor", en: "Large" });
  const ids = [idA, idB, idC];

  // "Your photos", sv and en, without JavaScript.
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  const plain = await noJs.newPage();
  for (const [path, label] of [
    ["/admin/photos/", "Ladda ner i full storlek"],
    ["/en/admin/photos/", "Download at full size"],
  ]) {
    const res = await plain.goto(path);
    expect(res?.status()).toBe(200);
    const html = await res!.text();
    // Markup in alt is text: escaped in the paragraph, quotes escaped in the attribute, no elements made.
    if (path === "/admin/photos/") {
      expect(html).toContain("&lt;b&gt;fet&lt;/b&gt;");
      expect(html).toContain('alt="<b>fet</b> &amp; &quot;citat&quot;');
      await expect(plain.locator("#photo-" + idB.slice(0, 12)).getByText(MARKUP, { exact: true })).toBeVisible();
    } else expect(html).toContain('alt="One size"');
    expect(await plain.locator("main script, main b").count()).toBe(0);
    for (const [id, master] of [
      [idA, 800],
      [idB, 400],
      [idC, 1600],
    ] as const) {
      const link = plain.locator(`#photo-${id.slice(0, 12)} a`, { hasText: label });
      await expect(link).toHaveAttribute("href", `/media/${id}-${master}.webp`);
      await expect(link).toHaveAttribute("download", `${id}.webp`);
      const got = await request.get(`/media/${id}-${master}.webp`);
      expect(sha(await got.body()), "the download is the master").toBe(id);
    }
  }
  await noJs.close();

  // Export, with photo A put on the first dish (in use).
  const exported = await (await page.request.get("/admin/export")).json();
  exported.content.menu.categories[0].items[0].image = idA;
  const dir = mkdtempSync(join(tmpdir(), "tester-restore-"));
  const write = (name: string, file: unknown) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(file));
    return p;
  };
  const good = write("good.json", exported);
  for (const id of ids)
    expect(exported.content.images.find((i: { ref: string }) => i.ref === id)?.master).toBe(`${BASE}/media/${id}-${{ [idA]: 800, [idB]: 400, [idC]: 1600 }[id]}.webp`);

  const before = JSON.stringify((await (await page.request.get("/admin/export")).json()).content);
  const unchanged = async (why: string) => {
    const now = JSON.stringify((await (await page.request.get("/admin/export")).json()).content);
    expect(now, why).toBe(before);
    for (const id of ids) expect((await request.get(`/media/${id}-400.webp`)).status(), why).toBe(200);
  };

  // Hostile files: each refused with a readable line, nothing written, also with --reset.
  const variant = (name: string, change: (f: typeof exported) => void) => {
    const f = structuredClone(exported);
    change(f);
    return write(`${name}.json`, f);
  };
  const entry = (f: typeof exported, id: string) => f.content.images.find((i: { ref: string }) => i.ref === id);
  const hostile: Array<[string, string, RegExp]> = [
    ["404 host", variant("404", (f) => (entry(f, idC).master = `http://127.0.0.1:9/media/${idC}-1600.webp`)), /photo [0-9a-f]{64}: couldn't fetch/],
    ["file scheme", variant("file", (f) => (entry(f, idB).master = `file:///media/${idB}-400.webp`)), /the master must be a link/],
    ["curated with master", variant("curated", (f) => (f.content.images[0].master = `${BASE}/media/x-1.webp`)), /only an uploaded photo/],
    ["duplicate upload", variant("dup", (f) => f.content.images.push(structuredClone(entry(f, idB)))), /duplicate/],
    ["last photo bad", variant("lastbad", (f) => (entry(f, idC).master = `${BASE}/media/${idC}-1600.webp`.replace(BASE, "http://127.0.0.1:9"))), /couldn't fetch/],
  ];
  for (const [name, file, message] of hostile) {
    const r = seed("--from", file, "--reset");
    expect(r.status, `${name}: ${r.out}`).not.toBe(0);
    expect(r.out, name).toMatch(message);
    await unchanged(`${name}: nothing written`);
  }

  // A --photos folder holding another photo under C's name: refused, nothing written.
  const photos = mkdtempSync(join(tmpdir(), "tester-photos-"));
  writeFileSync(join(photos, `${idC}.webp`), a[1]);
  const swapped = seed("--from", good, "--photos", photos, "--reset");
  expect(swapped.status).not.toBe(0);
  expect(swapped.out).toMatch(/has been changed/);
  await unchanged("swapped --photos: nothing written");

  // The real restore: C from the folder, A and B fetched.
  writeFileSync(join(photos, `${idC}.webp`), c[3]);
  const ok = seed("--from", good, "--photos", photos, "--reset");
  expect(ok.status, ok.out).toBe(0);
  expect(ok.out).toMatch(/--reset deletes the site's \d+ uploaded photo\(s\); the file brings back the ones it lists/);
  // Every upload the file lists: these three, plus any an earlier spec left on the shared server.
  const listed = exported.content.images.filter((i: { master?: string }) => i.master).length;
  expect(listed).toBeGreaterThanOrEqual(3);
  expect(ok.out).toContain(`bringing back ${listed} uploaded photo(s)`);

  const after = await (await page.request.get("/admin/export")).json();
  for (const id of ids) {
    const was = exported.content.images.find((i: { ref: string }) => i.ref === id);
    const now = after.content.images.find((i: { ref: string }) => i.ref === id);
    expect(now?.alt, id).toEqual(was.alt);
    expect(now?.variants, `${id}: the same sizes`).toEqual(was.variants);
    const master = await request.get(now.master.replace(BASE, ""));
    expect(sha(await master.body())).toBe(id);
    for (const w of now.variants) expect((await request.get(`/media/${id}-${w}.webp`)).status()).toBe(200);
  }
  expect(after.content.menu.categories[0].items[0].image, "the dish keeps its photo").toBe(idA);
});
