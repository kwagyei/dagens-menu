/**
 * Tester, M6.10c photo pickers end to end: every slot on its public page (alt rules, "No photo"),
 * content_version, the dish and texts forms around a photo choice, delete refusal links,
 * cross-site / malformed / CSRF / Origin / no-alt attacks, 44 px rows, keyboard-only choice,
 * focus on refusals, JS off in both languages. Each test puts what it changed back.
 */
import { expect, type Page, test } from "@playwright/test";
import { d1, freshIp, signedInOwner, uploadPhoto } from "./helpers";

const BASE = "http://localhost:8790";
const version = () => d1<{ v: number }>("SELECT content_version AS v FROM sites WHERE id = 'bistro'")[0].v;
const slots = () => d1<Record<string, string | null>>("SELECT hero_image_id, cta_image_id, menu_hero_image_id, story_image_id, kitchen_image_id FROM page_content WHERE site_id = 'bistro'")[0];
const restoreSlots = (b: Record<string, string | null>) =>
  d1(`UPDATE page_content SET ${Object.entries(b).map(([k, v]) => `${k} = ${v ? `'${v}'` : "NULL"}`).join(", ")} WHERE site_id = 'bistro'`);
const csrf = (page: Page) => page.locator("input[name=csrf]").first().inputValue();
const post = (page: Page, path: string, form: Record<string, string>, headers: Record<string, string> = { Origin: BASE }) =>
  page.request.post(path, { form, maxRedirects: 0, headers });

async function pick(page: Page, path: string, label: string) {
  await page.goto(path);
  await page.getByRole("radio", { name: label }).check();
  await page.getByRole("button", { name: "Spara valet" }).click();
  await expect(page.getByRole("status")).toHaveText("Fotot är sparat.");
}

test("each slot the classic design draws shows on its page; hero stays decorative; hidden slots can only be cleared; no photo leaves pages intact", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const before = slots();
  const media = new RegExp(`/media/${photo.id}`);
  try {
    const v0 = version();
    for (const slot of ["hero", "story", "kitchen"]) await pick(page, `/admin/page-photos/${slot}/`, photo.sv);
    expect(version()).toBeGreaterThan(v0);
    // M1, M2 (fixed): classic draws no cta band and no design draws menu_hero, so those places
    // don't offer the photo and a crafted choice is refused.
    for (const slot of ["cta", "menu_hero"]) {
      await page.goto(`/admin/page-photos/${slot}/`);
      await expect(page.getByRole("radio", { name: photo.sv })).toHaveCount(0);
      const res = await post(page, `/admin/page-photos/${slot}/`, { csrf: await csrf(page), image: photo.id });
      expect(res.headers().location, slot).toBe(`/admin/page-photos/${slot}/?done=not-shown`);
      expect(slots()[`${slot}_image_id`], slot).toBe(before[`${slot}_image_id`]);
    }
    await page.goto("/admin/page-photos/");
    await expect(page.locator("#page-photos li")).toHaveCount(3);
    // hero: decorative, so alt="" and never the library alt
    await page.goto("/");
    const hero = page.locator("img[srcset], img[src]").filter({ has: page.locator("xpath=self::*") }).locator(`xpath=self::*[contains(@src,"${photo.id}") or contains(@srcset,"${photo.id}")]`);
    expect(await hero.count(), "hero img on /").toBeGreaterThan(0);
    for (const alt of await hero.evaluateAll((els) => els.map((e) => e.getAttribute("alt")))) expect(alt).toBe("");
    await expect(page.locator(`img[alt="${photo.sv}"]`)).toHaveCount(0);
    // story + kitchen: two images with the library alt
    await page.goto("/about/");
    await expect(page.locator(`img[alt="${photo.sv}"]`)).toHaveCount(2);
    await page.goto("/en/about/");
    await expect(page.locator(`img[alt="${photo.en}"]`)).toHaveCount(2);
    // none
    for (const slot of ["hero", "story", "kitchen"]) await pick(page, `/admin/page-photos/${slot}/`, "Inget foto");
    for (const p of ["/", "/menu/", "/about/", "/en/", "/en/about/"]) {
      const res = await page.goto(p);
      expect(res!.status(), p).toBe(200);
      expect(await page.content(), p).not.toContain(photo.id);
    }
  } finally {
    restoreSlots(before);
  }
});

test("dish form saved after a photo choice keeps the photo; texts form opened before still saves", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const [dish] = d1<{ id: string; image_id: string | null; name_sv: string }>("SELECT id, image_id, name_sv FROM menu_items WHERE site_id = 'bistro' ORDER BY id LIMIT 1");
  const before = slots();
  try {
    // Dish form opened first (in a second tab), photo chosen in the first, then the form saved.
    const other = await page.context().newPage();
    await other.goto(`/admin/menu/item/${dish.id}/`);
    await expect(other.locator("#dish-photo")).toContainText("Inget foto");
    await pick(page, `/admin/menu/item/${dish.id}/photo/`, photo.sv);
    await other.getByRole("button", { name: "Spara" }).click();
    await expect(other.getByRole("status")).toHaveText("Sparat.");
    expect(d1<{ image_id: string }>(`SELECT image_id FROM menu_items WHERE site_id = 'bistro' AND id = '${dish.id}'`)[0].image_id).toBe(photo.id);
    // Texts form open, then a page photo change, then save.
    await other.goto("/admin/texts/");
    await pick(page, "/admin/page-photos/story/", photo.sv);
    await other.getByRole("button", { name: "Spara" }).first().click();
    await expect(other.getByRole("status").first()).toBeVisible();
    await expect(other.getByRole("alert")).toHaveCount(0);
    expect(slots().story_image_id).toBe(photo.id);
    // Delete refused with links to the right pickers.
    await page.goto(`/admin/photos/${photo.id}/delete/`);
    const hrefs = await page.locator("#delete-refused a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs).toContain(`/admin/menu/item/${dish.id}/photo/`);
    expect(hrefs).toContain("/admin/page-photos/story/");
    for (const h of hrefs) expect((await page.request.get(h!)).status(), h!).toBe(200);
  } finally {
    restoreSlots(before);
    d1(`UPDATE menu_items SET image_id = ${dish.image_id ? `'${dish.image_id}'` : "NULL"} WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  }
});

test("a photo deleted while the picker is open is refused with a focused alert", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  await page.goto("/admin/page-photos/kitchen/");
  const before = slots();
  await page.getByRole("radio", { name: photo.sv }).check();
  d1(`DELETE FROM images WHERE site_id = 'bistro' AND id = '${photo.id}'`);
  await page.getByRole("button", { name: "Spara valet" }).click();
  await expect(page.getByRole("alert")).toContainText("finns inte längre");
  await expect(page.getByRole("alert")).toBeFocused();
  expect(slots()).toEqual(before);
});

test("hostile requests change nothing: cross-site, malformed, no alt, CSRF, Origin, odd paths", async ({ page }) => {
  await signedInOwner(page);
  const before = slots();
  const [dish] = d1<{ id: string; image_id: string | null }>("SELECT id, image_id FROM menu_items WHERE site_id = 'bistro' ORDER BY id LIMIT 1");
  const theirs = "e".repeat(64);
  const noAlt = (await uploadPhoto(page)).id;
  try {
    d1("INSERT OR IGNORE INTO sites (id) VALUES ('westafrican')");
    d1(`INSERT OR REPLACE INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES ('westafrican', '${theirs}', 'upload', 'image/webp', 'Deras', 'Theirs')`);
    d1(`UPDATE images SET alt_sv = NULL, alt_en = NULL WHERE site_id = 'bistro' AND id = '${noAlt}'`);
    const v0 = version();
    await page.goto("/admin/page-photos/hero/");
    const token = await csrf(page);
    const paths = ["/admin/page-photos/hero/", `/admin/menu/item/${dish.id}/photo/`];
    const bad = [theirs, noAlt, "../../x", "A".repeat(64), "e".repeat(63), "x'; DROP TABLE images;--", "%00", "\u0000", " " + "a".repeat(63), "d".repeat(64)];
    for (const p of paths)
      for (const image of bad) {
        const r = await post(page, p, { csrf: token, image });
        expect(r.status(), `${p} ${image}`).toBe(303);
        expect(r.headers().location, `${p} ${image}`).toContain("done=not-found");
      }
    // CSRF missing / wrong, Origin missing / foreign, text/plain body
    expect((await post(page, paths[0], { image: "" })).headers().location).toContain("done=expired");
    expect((await post(page, paths[0], { csrf: "zzz", image: "" })).headers().location).toContain("done=expired");
    expect((await post(page, paths[0], { csrf: token, image: "" }, { Origin: "https://evil.example" })).status()).toBeGreaterThanOrEqual(400);
    const noOrigin = await page.request.post(paths[0], { form: { csrf: token, image: "" }, maxRedirects: 0, headers: { Origin: "null" } });
    expect(noOrigin.status()).toBeGreaterThanOrEqual(400);
    const plain = await page.request.post(paths[0], { data: "image=", headers: { "Content-Type": "text/plain", Origin: BASE }, maxRedirects: 0 });
    expect(plain.status()).toBeLessThan(500);
    // slot / dish path tricks
    for (const p of ["/admin/page-photos/HERO/", "/admin/page-photos/hero%2f..%2fcta/", "/admin/page-photos/hero_image_id/", "/admin/page-photos/__proto__/", "/admin/page-photos/constructor/", "/admin/page-photos/hero;x/", "/xx/admin/page-photos/hero/"]) {
      const r = await page.request.get(p, { maxRedirects: 0 });
      expect([404, 308, 301], p).toContain(r.status());
    }
    for (const p of ["/admin/menu/item/%00/photo/", "/admin/menu/item/..%2f/photo/", "/admin/menu/item/'%20OR%201=1/photo/", `/admin/menu/item/${"z".repeat(300)}/photo/`]) {
      const r = await page.request.get(p, { maxRedirects: 0 });
      expect(r.status(), p).toBeLessThan(500);
    }
    for (const p of ["/admin/page-photos/nope/"]) expect((await post(page, p, { csrf: token, image: "" })).status()).toBe(404);
    expect(slots()).toEqual(before);
    expect(d1<{ image_id: string | null }>(`SELECT image_id FROM menu_items WHERE site_id = 'bistro' AND id = '${dish.id}'`)[0].image_id).toBe(dish.image_id);
    expect(version()).toBe(v0);
    // Another site's dish id is not ours
  } finally {
    d1(`DELETE FROM images WHERE site_id = 'westafrican' AND id = '${theirs}'`);
  }
});

test("rows are 44 px tall, choose by keyboard only, saved status, JS off in English", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const before = slots();
  try {
    await page.goto("/admin/page-photos/story/");
    for (const label of await page.locator("#photo-picker label").all()) {
      const box = (await label.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    // keyboard: tab to the radio group, arrow to the photo, Enter submits
    const target = page.getByRole("radio", { name: photo.sv });
    await page.getByRole("radio", { name: "Inget foto" }).focus();
    for (let i = 0; i < 40 && !(await target.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("ArrowDown");
    await expect(target).toBeFocused();
    await expect(target).toBeChecked();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Spara valet" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText("Fotot är sparat.");
    expect(slots().story_image_id).toBe(photo.id);
    // reload keeps the saved choice selected, and the status does not stick on a plain reload
    await page.goto("/admin/page-photos/story/");
    await expect(page.getByRole("radio", { name: photo.sv })).toBeChecked();
    await expect(page.getByRole("status")).toHaveCount(0);

    const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState(), extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
    const plain = await noJs.newPage();
    await plain.goto(`${BASE}/en/admin/page-photos/kitchen/`);
    await expect(plain.getByRole("heading", { level: 1 })).toBeVisible();
    await plain.getByRole("radio", { name: photo.en }).check();
    await plain.getByRole("button", { name: "Save the choice" }).click();
    await expect(plain.getByRole("status")).toHaveText("The photo is saved.");
    await plain.goto(`${BASE}/en/admin/page-photos/`);
    await expect(plain.locator("#slot-kitchen")).toContainText(photo.en);
    await plain.goto(`${BASE}/en/admin/page-photos/nope/`);
    await noJs.close();
  } finally {
    restoreSlots(before);
  }
});
