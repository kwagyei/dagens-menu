/**
 * The photo library end to end (plan M6.10; ADR-014 §4, §6): every photo listed with where
 * it's used, the unused filter, alt edits with the row_version guard, and deletes that refuse
 * a photo in use (409, with the places), a built-in photo (409) and an unknown one (404).
 * Until the dish photo picker (M6.10c), a photo is put on a dish with SQL on the local D1.
 */
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { expect, type Page, test } from "@playwright/test";
import { freshIp, signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const NEW = "/admin/photos/new/";
const LIBRARY = "/admin/photos/";

function d1<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--json", "--command", sql], { encoding: "utf-8" });
  return JSON.parse(out)[0].results as T[];
}

let photoCount = 0;
/** Upload a distinct photo through the real endpoint; returns its id and alt. */
async function upload(page: Page): Promise<{ id: string; sv: string; en: string }> {
  const n = ++photoCount;
  const tint = { r: 100 + ((Date.now() + n * 37) % 150), g: 60 + (n % 90), b: 200 };
  const parts = await Promise.all([400, 800].map((width) => sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width }).tint(tint).webp({ quality: 70 }).toBuffer()));
  const sv = `Biblioteksfoto ${Date.now().toString(36)}-${n}`;
  const en = `Library photo ${Date.now().toString(36)}-${n}`;
  await page.goto(NEW);
  const form = new FormData();
  form.set("csrf", await page.locator("input[name=csrf]").first().inputValue());
  form.set("alt_sv", sv);
  form.set("alt_en", en);
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  const res = await page.request.post(NEW, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.headers().location).toBe(`${NEW}?done=added`);
  const [row] = d1<{ id: string }>(`SELECT id FROM images WHERE site_id = 'bistro' AND alt_sv = '${sv}'`);
  return { id: row.id, sv, en };
}

const item = (page: Page, id: string) => page.locator(`#photo-${id.slice(0, 12)}`);

test("a new photo is listed as not used, its description is edited in both languages, and the list shows it", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);

  await page.goto(`${LIBRARY}?filter=unused`);
  await expect(item(page, photo.id)).toContainText(photo.sv);
  await expect(item(page, photo.id)).toContainText("Används inte");
  await expect(page.getByRole("link", { name: /^Används inte \(\d+\)$/ })).toHaveAttribute("aria-current", "page");

  await item(page, photo.id).getByRole("link", { name: "Beskrivning och användning" }).click();
  await expect(page).toHaveURL(`${BASE}/admin/photos/${photo.id}/`);
  await expect(page.getByText("Fotot används inte någonstans på webbplatsen.")).toBeVisible();
  await page.getByLabel("Beskrivning på svenska").fill("Ny beskrivning av fotot");
  await page.getByLabel("Beskrivning på engelska").fill("A new description of the photo");
  await page.getByRole("button", { name: "Spara beskrivningen" }).click();
  await expect(page.getByRole("status")).toHaveText("Beskrivningen är sparad.");
  await expect(page.getByLabel("Beskrivning på engelska")).toHaveValue("A new description of the photo");

  await page.goto("/en/admin/photos/");
  await expect(item(page, photo.id)).toContainText("A new description of the photo");
  await expect(item(page, photo.id)).toContainText("Not used");
});

test("an empty description is refused with 422, the error summary is focused and the typed text is kept", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  await page.goto(`/admin/photos/${photo.id}/`);
  await page.getByLabel("Beskrivning på svenska").fill("   ");
  await page.getByLabel("Beskrivning på engelska").fill("Kept as typed");
  const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/admin/photos/${photo.id}/`));
  await page.getByRole("button", { name: "Spara beskrivningen" }).click();
  expect((await response).status()).toBe(422);
  await expect(page.locator("#photo-alt-errors")).toBeFocused();
  await expect(page.getByLabel("Beskrivning på engelska")).toHaveValue("Kept as typed");
  expect(d1<{ alt_sv: string }>(`SELECT alt_sv FROM images WHERE id = '${photo.id}'`)[0].alt_sv).toBe(photo.sv);
});

test("a stale description edit gets 409 and says so; saving again overwrites", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  await page.goto(`/admin/photos/${photo.id}/`);

  // Someone else saves first, in another tab.
  const other = await browser.newContext({ storageState: await page.context().storageState(), extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const tab = await other.newPage();
  await tab.goto(`${BASE}/admin/photos/${photo.id}/`);
  await tab.getByLabel("Beskrivning på svenska").fill("Först sparad");
  await tab.getByRole("button", { name: "Spara beskrivningen" }).click();
  await expect(tab.getByRole("status")).toHaveText("Beskrivningen är sparad.");
  await other.close();

  await page.getByLabel("Beskrivning på svenska").fill("Sparad sist");
  const response = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByRole("button", { name: "Spara beskrivningen" }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole("alert")).toHaveText("Någon annan ändrade beskrivningen nyss. Kontrollera den och spara igen för att skriva över.");
  await expect(page.getByRole("alert")).toBeFocused();
  expect(d1<{ alt_sv: string }>(`SELECT alt_sv FROM images WHERE id = '${photo.id}'`)[0].alt_sv).toBe("Först sparad");

  await page.getByRole("button", { name: "Spara beskrivningen" }).click();
  await expect(page.getByRole("status")).toHaveText("Beskrivningen är sparad.");
  expect(d1<{ alt_sv: string }>(`SELECT alt_sv FROM images WHERE id = '${photo.id}'`)[0].alt_sv).toBe("Sparad sist");
});

test("a photo in use can't be deleted: the page lists where with links, and a forced delete gets 409", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  const [dish] = d1<{ id: string; name_sv: string; image_id: string | null }>("SELECT id, name_sv, image_id FROM menu_items WHERE site_id = 'bistro' ORDER BY id LIMIT 1");
  d1(`UPDATE menu_items SET image_id = '${photo.id}' WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  try {
    await page.goto(`/admin/photos/${photo.id}/`);
    await expect(page.locator("#photo-uses")).toContainText(`rätten ${dish.name_sv}`);
    await expect(page.getByRole("link", { name: "Ta bort det här fotot" })).toHaveCount(0);
    await expect(page.locator("#photo-uses a")).toHaveAttribute("href", `/admin/menu/item/${dish.id}/`);

    const shown = await page.goto(`/admin/photos/${photo.id}/delete/`);
    expect(shown!.status()).toBe(409);
    await expect(page.locator("#delete-refused")).toContainText(`rätten ${dish.name_sv}`);
    await expect(page.getByRole("button", { name: "Ta bort fotot" })).toHaveCount(0);

    // An old tab posting anyway: refused, nothing deleted.
    const csrf = await page.locator("input[name=csrf]").first().inputValue();
    const forced = await page.request.post(`/admin/photos/${photo.id}/delete/`, { form: { csrf }, maxRedirects: 0, headers: { Origin: BASE } });
    expect(forced.status()).toBe(409);
    expect(await forced.text()).toContain(`rätten ${dish.name_sv}`);
    expect(d1(`SELECT id FROM images WHERE id = '${photo.id}'`)).toHaveLength(1);
    expect((await page.request.get(`/media/${photo.id}-400.webp`)).status()).toBe(200);
  } finally {
    d1(`UPDATE menu_items SET image_id = ${dish.image_id ? `'${dish.image_id}'` : "NULL"} WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  }
});

test("an unused photo is deleted after confirming, with its sizes", async ({ page }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  await page.goto(`/admin/photos/${photo.id}/`);
  await page.getByRole("link", { name: "Ta bort det här fotot" }).click();
  await expect(page.getByRole("heading", { name: "Ta bort fotot?" })).toBeVisible();
  await page.getByRole("button", { name: "Ta bort fotot" }).click();
  await expect(page).toHaveURL(`${BASE}${LIBRARY}?done=deleted`);
  await expect(page.getByRole("status")).toHaveText("Fotot är borttaget.");
  await expect(item(page, photo.id)).toHaveCount(0);
  expect(d1(`SELECT id FROM images WHERE id = '${photo.id}'`)).toHaveLength(0);
  expect((await page.request.get(`/media/${photo.id}-400.webp`)).status()).toBe(404);
});

test("a built-in photo can't be deleted (409), and an unknown photo is not found (404)", async ({ page }) => {
  await signedInOwner(page);
  const [builtIn] = d1<{ id: string }>("SELECT id FROM images WHERE site_id = 'bistro' AND kind = 'static' ORDER BY id LIMIT 1");
  await page.goto(`/admin/photos/${builtIn.id}/`);
  await expect(page.getByText("Inbyggt", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ta bort det här fotot" })).toHaveCount(0);
  const shown = await page.goto(`/admin/photos/${builtIn.id}/delete/`);
  expect(shown!.status()).toBe(409);
  await expect(page.locator("#delete-refused")).toHaveText("Inbyggda foton kan inte tas bort, bara bytas mot dina egna.");
  await expect(page.locator("#delete-refused")).toBeFocused();

  const unknown = await page.goto(`/admin/photos/${"f".repeat(64)}/delete/`);
  expect(unknown!.status()).toBe(404);
  await page.goto(`/admin/photos/${"f".repeat(64)}/`);
  await expect(page).toHaveURL(`${BASE}${LIBRARY}?done=not-found`);
  await expect(page.getByRole("status")).toHaveText("Fotot finns inte, eller är redan borttaget.");
});

test("without JavaScript: the description is saved and an unused photo is deleted", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await upload(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState(), extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const plain = await noJs.newPage();
  await plain.goto(`${BASE}/en/admin/photos/${photo.id}/`);
  await plain.getByLabel("Description in English").fill("Saved without JavaScript");
  await plain.getByRole("button", { name: "Save the description" }).click();
  await expect(plain.getByRole("status")).toHaveText("The description is saved.");
  await plain.getByRole("link", { name: "Delete this photo" }).click();
  await plain.getByRole("button", { name: "Delete the photo" }).click();
  await expect(plain.getByRole("status")).toHaveText("The photo is deleted.");
  expect(d1(`SELECT id FROM images WHERE id = '${photo.id}'`)).toHaveLength(0);
  await noJs.close();
});

test("delete all unused photos: confirms with the count, keeps photos in use and built-in ones", async ({ page }) => {
  await signedInOwner(page);
  const unused = await upload(page);
  const used = await upload(page);
  const [dish] = d1<{ id: string; image_id: string | null }>("SELECT id, image_id FROM menu_items WHERE site_id = 'bistro' ORDER BY id DESC LIMIT 1");
  d1(`UPDATE menu_items SET image_id = '${used.id}' WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  try {
    const builtIn = d1<{ n: number }>("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'static'")[0].n;
    await page.goto(LIBRARY);
    await page.getByRole("link", { name: /^Ta bort alla foton som inte används \(\d+\)$/ }).click();
    const n = Number((await page.getByRole("button", { name: /^Ta bort \d+ foton$/ }).textContent())!.match(/\d+/)![0]);
    expect(n).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: /^Ta bort \d+ foton$/ }).click();
    await expect(page.getByRole("status")).toHaveText(`${n} foton som inte användes är borttagna.`);
    expect(d1(`SELECT id FROM images WHERE id = '${unused.id}'`)).toHaveLength(0);
    expect(d1(`SELECT id FROM images WHERE id = '${used.id}'`)).toHaveLength(1);
    expect(d1<{ n: number }>("SELECT count(*) AS n FROM images WHERE site_id = 'bistro' AND kind = 'static'")[0].n).toBe(builtIn);
    await expect(page.getByRole("link", { name: /^Ta bort alla foton som inte används/ })).toHaveCount(0);
  } finally {
    d1(`UPDATE menu_items SET image_id = ${dish.image_id ? `'${dish.image_id}'` : "NULL"} WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  }
});
