/**
 * Tester, M6.10a photo library end to end (ADR-014 §4, §6): cross-site and malformed ids on all
 * four routes, CSRF/Origin, GETs without side effects, the ?done=deleted-unused&n= message,
 * a JS-off English journey, 44 px targets, focus on load, and public pages after an alt edit.
 * Rows for the other site are written with SQL on the local D1 (the Worker serves one site).
 */
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { expect, type Page, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const NEW = "/admin/photos/new/";
const LIBRARY = "/admin/photos/";

function d1<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--json", "--command", sql], { encoding: "utf-8" });
  return JSON.parse(out)[0].results as T[];
}
const version = () => d1<{ v: number }>("SELECT content_version AS v FROM sites WHERE id = 'bistro'")[0].v;
const variantCount = (site: string, id: string) => d1<{ n: number }>(`SELECT count(*) AS n FROM image_variants WHERE site_id = '${site}' AND image_id = '${id}'`)[0].n;
const imageRow = (site: string, id: string) => d1<{ alt_sv: string; row_version: number }>(`SELECT alt_sv, row_version FROM images WHERE site_id = '${site}' AND id = '${id}'`)[0];

let photoCount = 0;
async function upload(page: Page): Promise<{ id: string; sv: string; en: string }> {
  const n = ++photoCount;
  const tint = { r: 30 + ((Date.now() + n * 53) % 200), g: 10 + (n % 120), b: 90 };
  const parts = await Promise.all([400, 800].map((width) => sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width }).tint(tint).webp({ quality: 70 }).toBuffer()));
  const sv = `Testarfoto ${Date.now().toString(36)}-${n}`;
  const en = `Tester photo ${Date.now().toString(36)}-${n}`;
  await page.goto(NEW);
  const form = new FormData();
  form.set("csrf", await csrf(page));
  form.set("alt_sv", sv);
  form.set("alt_en", en);
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  const res = await page.request.post(NEW, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.headers().location).toBe(`${NEW}?done=added`);
  const [row] = d1<{ id: string }>(`SELECT id FROM images WHERE site_id = 'bistro' AND alt_sv = '${sv}'`);
  return { id: row.id, sv, en };
}
const csrf = (page: Page) => page.locator("input[name=csrf]").first().inputValue();
const post = (page: Page, path: string, form: Record<string, string>, headers: Record<string, string> = { Origin: BASE }) =>
  page.request.post(path, { form, maxRedirects: 0, headers });

/** A westafrican upload (with one size), optionally with the same id as a bistro photo. */
function westafricanUpload(id: string) {
  d1(
    `INSERT OR IGNORE INTO sites (id) VALUES ('westafrican');
     INSERT INTO images (site_id, id, kind, path, mime, width, height, byte_size, alt_sv, alt_en) VALUES ('westafrican', '${id}', 'upload', NULL, 'image/webp', 400, 300, 1, 'Deras foto', 'Their photo');
     INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('westafrican', '${id}', 400, 'image/webp', X'00');`,
  );
}

test.describe.configure({ timeout: 90_000 });

test("a bistro session can't read, edit or delete a westafrican photo through any route", async ({ page }) => {
  await signedInOwner(page);
  const waOnly = `${Date.now().toString(16)}`.padStart(64, "f");
  westafricanUpload(waOnly);
  const token = (await page.goto(LIBRARY), await csrf(page));

  const read = await page.request.get(`/admin/photos/${waOnly}/`, { maxRedirects: 0 });
  expect(read.status()).toBe(303);
  expect(read.headers().location).toBe(`${LIBRARY}?done=not-found`);
  const edit = await post(page, `/admin/photos/${waOnly}/`, { csrf: token, row_version: "0", alt_sv: "Hackat", alt_en: "Hacked" });
  expect(edit.status()).toBe(303);
  expect((await page.request.get(`/admin/photos/${waOnly}/delete/`)).status()).toBe(404);
  expect((await post(page, `/admin/photos/${waOnly}/delete/`, { csrf: token })).status()).toBe(404);
  expect((await page.request.get(`${LIBRARY}?filter=unused`)).ok()).toBe(true);
  expect(await (await page.request.get(LIBRARY)).text()).not.toContain(waOnly);
  // Delete-all on bistro leaves the westafrican upload alone.
  expect((await post(page, "/admin/photos/unused/delete/", { csrf: token })).status()).toBe(303);
  expect(imageRow("westafrican", waOnly)).toEqual({ alt_sv: "Deras foto", row_version: 0 });
  expect(variantCount("westafrican", waOnly)).toBe(1);
});

test("the same id on both sites: deleting bistro's copy keeps westafrican's row and size", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  westafricanUpload(photo.id);
  await page.goto(`/admin/photos/${photo.id}/delete/`);
  await page.getByRole("button", { name: "Ta bort fotot" }).click();
  await expect(page).toHaveURL(`${BASE}${LIBRARY}?done=deleted`);
  expect(d1<{ n: number }>(`SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND id = '${photo.id}'`)[0].n).toBe(0);
  expect(variantCount("bistro", photo.id)).toBe(0);
  expect(imageRow("westafrican", photo.id)).toEqual({ alt_sv: "Deras foto", row_version: 0 });
  expect(variantCount("westafrican", photo.id)).toBe(1);
  expect((await page.request.get(`/media/${photo.id}-400.webp`)).status()).toBe(404);
});

test("malformed and foreign-format ids never 500 and never write", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  await page.goto(LIBRARY);
  const token = await csrf(page);
  const galleryId = d1<{ id: string }>("SELECT id FROM gallery_images WHERE site_id = 'bistro' LIMIT 1")[0].id; // 12 chars
  const before = version();
  const ids = ["..", "%2e", "%2e%2e", "%2E%2E%2F", photo.id.toUpperCase(), photo.id.slice(0, 12), galleryId, `${photo.id}0`, "a".repeat(5000), "%00", "%0d%0aX-Injected:%201", "unused%2F..", "%27%20OR%201%3D1"];
  for (const id of ids) {
    for (const path of [`/admin/photos/${id}/`, `/en/admin/photos/${id}/`, `/admin/photos/${id}/delete/`]) {
      const get = await page.request.get(path, { maxRedirects: 0 });
      expect.soft(get.status(), `GET ${path.slice(0, 80)}`).toBeLessThan(500);
      const p = await post(page, path, { csrf: token, row_version: "0", alt_sv: "x", alt_en: "y" });
      expect.soft(p.status(), `POST ${path.slice(0, 80)}`).toBeLessThan(500);
      expect(p.headers()["x-injected"]).toBeUndefined();
    }
    // A POST without a token redirects using the raw id: no header injection, no 500.
    const noToken = await post(page, `/admin/photos/${id}/delete/`, {});
    expect.soft(noToken.status(), `POST no token ${id.slice(0, 40)}`).toBeLessThan(500);
    expect(noToken.headers()["x-injected"]).toBeUndefined();
  }
  expect(version()).toBe(before);
  expect(imageRow("bistro", photo.id).row_version).toBe(0);
});

test("CSRF and Origin: missing, wrong or cross-site posts change nothing; GETs of the delete pages have no side effects", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  await page.goto(LIBRARY);
  const token = await csrf(page);
  const v = version();

  for (const path of [`/admin/photos/${photo.id}/delete/`, "/admin/photos/unused/delete/"]) {
    for (let i = 0; i < 2; i++) expect((await page.request.get(path)).status()).toBe(200);
    expect((await post(page, path, {})).status()).toBe(303);
    expect((await post(page, path, { csrf: "x".repeat(43) })).status()).toBe(303);
    expect((await post(page, path, { csrf: token }, { Origin: "https://evil.example" })).status()).toBe(403);
    expect((await post(page, path, { csrf: token }, {})).status()).toBe(403);
  }
  const alt = await post(page, `/admin/photos/${photo.id}/`, { row_version: "0", alt_sv: "Utan token", alt_en: "No token" });
  expect(alt.status()).toBe(303);
  expect(alt.headers().location).toBe(`/admin/photos/${photo.id}/?done=expired`);
  expect((await post(page, `/admin/photos/${photo.id}/`, { csrf: token, row_version: "0", alt_sv: "a", alt_en: "b" }, { Origin: "null" })).status()).toBe(403);

  expect(imageRow("bistro", photo.id)).toEqual({ alt_sv: photo.sv, row_version: 0 });
  expect(variantCount("bistro", photo.id)).toBe(2);
  expect(version()).toBe(v);
  // The expired message is shown and is a status.
  await page.goto(`/admin/photos/${photo.id}/?done=expired`);
  await expect(page.getByRole("status")).toBeVisible();
});

test("?done=deleted-unused&n= shows only a sane count and no markup; anything else shows no message", async ({ page }) => {
  await signedInOwner(page);
  for (const [n, shown] of [
    ["2", "2"],
    ["0", "0"],
    ["abc", null],
    ["<b>x</b>", null],
    ["1.5", null],
    ["-1", null],
    ["1e9", null],
    ["99999999999999999999", null],
    ["0x10", null],
  ] as const) {
    await page.goto(`/en${LIBRARY}?done=deleted-unused&n=${encodeURIComponent(n)}`);
    const status = page.getByRole("status");
    if (shown === null) {
      await expect(status, `n=${n}`).toHaveCount(0);
      continue;
    }
    await expect(status).toHaveCount(1);
    expect(await status.locator("*").count()).toBe(0);
    await expect.soft(status, `n=${n}`).toHaveText(`${shown} unused photos are deleted.`);
  }
});

test("JS off, in English: edit a description, see the uses, delete a photo and delete all unused", async ({ page, browser }) => {
  await signedInOwner(page);
  const a = await upload(page);
  const b = await upload(page);
  const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState(), baseURL: BASE });
  const p = await ctx.newPage();

  await p.goto(`/en/admin/photos/${a.id}/`);
  await p.getByLabel("Description in Swedish").fill("Utan javascript");
  await p.getByLabel("Description in English").fill("Without javascript\nsecond line");
  await p.getByRole("button", { name: /save/i }).click();
  await expect(p).toHaveURL(`${BASE}/en/admin/photos/${a.id}/?done=saved`);
  await expect(p.getByRole("status")).toBeVisible();
  expect(d1<{ alt_en: string }>(`SELECT alt_en FROM images WHERE id = '${a.id}'`)[0].alt_en).toBe("Without javascript second line");

  await p.goto(`/en/admin/photos/${a.id}/delete/`);
  await p.getByRole("button", { name: /delete/i }).click();
  await expect(p).toHaveURL(`${BASE}/en/admin/photos/?done=deleted`);
  await expect(p.getByRole("status")).toBeVisible();

  await p.goto(`/en/admin/photos/?filter=unused`);
  await p.getByRole("link", { name: /delete all unused/i }).click();
  await expect(p).toHaveURL(`${BASE}/en/admin/photos/unused/delete/`);
  await p.getByRole("button", { name: /delete/i }).click();
  await expect(p).toHaveURL(new RegExp(`/en/admin/photos/\\?done=deleted-unused&n=\\d+$`));
  await expect(p.getByRole("status")).toContainText("unused photos are deleted");
  expect(d1<{ n: number }>(`SELECT count(*) AS n FROM images WHERE id IN ('${a.id}', '${b.id}')`)[0].n).toBe(0);
  await ctx.close();
});

test("alt validation matches the upload form: invisible-only and too long are refused, nothing saved", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  await page.goto(`/admin/photos/${photo.id}/`);
  const token = await csrf(page);
  for (const [sv, en] of [
    ["​⁠﻿", "ok"],
    ["ok", "  \t "],
    ["x".repeat(301), "ok"],
    ["ok", "y".repeat(10_000)],
  ]) {
    const res = await post(page, `/admin/photos/${photo.id}/`, { csrf: token, row_version: "0", alt_sv: sv, alt_en: en });
    expect(res.status(), JSON.stringify([sv.slice(0, 5), en.slice(0, 5)])).toBe(422);
  }
  // 300 visible characters with diacritics: accepted. (300 skin-tone emoji are refused by the
  // shared 2x-code-unit pre-check, as on every form; see the report.)
  const ok = await post(page, `/admin/photos/${photo.id}/`, { csrf: token, row_version: "0", alt_sv: "ä".repeat(300), alt_en: "ok" });
  expect(ok.status()).toBe(303);
  expect(imageRow("bistro", photo.id).row_version).toBe(1);
});

test("refusals are focused on load: in use, built-in, not found", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  const kitchen = d1<{ k: string | null }>("SELECT kitchen_image_id AS k FROM page_content WHERE site_id = 'bistro'")[0].k;
  d1(`UPDATE page_content SET kitchen_image_id = '${photo.id}' WHERE site_id = 'bistro'`);
  try {
    const inUse = await page.goto(`/en/admin/photos/${photo.id}/delete/`);
    expect(inUse!.status()).toBe(409);
    await expect(page.locator("#delete-refused")).toBeFocused();
    await expect(page.locator("#delete-refused")).toContainText(/kitchen/i);
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);

    const builtIn = d1<{ id: string }>("SELECT id FROM images WHERE site_id = 'bistro' AND kind = 'static' LIMIT 1")[0].id;
    expect((await page.goto(`/en/admin/photos/${builtIn}/delete/`))!.status()).toBe(409);
    await expect(page.locator("#delete-refused")).toBeFocused();
    expect((await page.goto(`/en/admin/photos/${"0".repeat(64)}/delete/`))!.status()).toBe(404);
    await expect(page.locator("#delete-refused")).toBeFocused();
    // The photo page lists the kitchen slot as a use with a link that works.
    await page.goto(`/en/admin/photos/${photo.id}/`);
    const use = page.locator("#photo-uses a").first();
    expect((await page.request.get((await use.getAttribute("href"))!)).ok()).toBe(true);
  } finally {
    d1(`UPDATE page_content SET kitchen_image_id = ${kitchen === null ? "NULL" : `'${kitchen}'`} WHERE site_id = 'bistro'`);
  }
});

test("every target on the four pages is at least 44 px tall (sv and en)", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  const small: string[] = [];
  for (const prefix of ["", "/en"]) {
    for (const path of [LIBRARY, `${LIBRARY}?filter=unused`, `${LIBRARY}?done=deleted`, `/admin/photos/${photo.id}/`, `/admin/photos/${photo.id}/delete/`, "/admin/photos/unused/delete/"]) {
      await page.goto(`${prefix}${path}`);
      const boxes = await page.locator("main a, main button, main input:not([type=hidden])").evaluateAll((els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return { text: (el.textContent || (el as HTMLInputElement).name || "").trim().slice(0, 40), h: Math.round(r.height), w: Math.round(r.width) };
          }),
      );
      for (const b of boxes) if (b.h < 44) small.push(`${prefix}${path}: "${b.text}" ${b.w}x${b.h}`);
    }
  }
  expect(small).toEqual([]);
});

test("editing a gallery photo's alt changes the public gallery (sv and en), then is put back", async ({ page }) => {
  await signedInOwner(page);
  const [g] = d1<{ id: string; alt_sv: string; alt_en: string; row_version: number }>(
    "SELECT i.id, i.alt_sv, i.alt_en, i.row_version FROM gallery_images g JOIN images i ON i.site_id = g.site_id AND i.id = g.image_id WHERE g.site_id = 'bistro' ORDER BY g.position LIMIT 1",
  );
  const marker = Date.now().toString(36);
  await page.goto(`/admin/photos/${g.id}/`);
  const token = await csrf(page);
  const v = version();
  expect((await post(page, `/admin/photos/${g.id}/`, { csrf: token, row_version: String(g.row_version), alt_sv: `Galleri ${marker}`, alt_en: `Gallery ${marker}` })).status()).toBe(303);
  expect(version()).toBeGreaterThan(v);
  try {
    await page.goto("/gallery/");
    await expect(page.locator(`img[alt="Galleri ${marker}"]`)).toHaveCount(1);
    await page.goto("/en/gallery/");
    await expect(page.locator(`img[alt="Gallery ${marker}"]`)).toHaveCount(1);
  } finally {
    await post(page, `/admin/photos/${g.id}/`, { csrf: token, row_version: String(g.row_version + 1), alt_sv: g.alt_sv, alt_en: g.alt_en });
  }
});
