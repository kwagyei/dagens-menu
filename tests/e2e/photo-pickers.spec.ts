/**
 * Choosing photos end to end (plan M6.10c): a dish's photo and a page slot's photo, chosen from
 * the library with plain radio buttons, shown on the public pages, counted as uses in the
 * library, and set back to what they were. Works without JavaScript.
 */
import { expect, type Page, test } from "@playwright/test";
import { d1, freshIp, signedInOwner, uploadPhoto } from "./helpers";

const BASE = "http://localhost:8790";

async function choose(page: Page, path: string, label: string | RegExp) {
  await page.goto(path);
  await page.getByRole("radio", { name: label }).check();
  await page.getByRole("button", { name: "Spara valet" }).click();
  await expect(page.getByRole("status")).toHaveText("Fotot är sparat.");
}

test("a dish's photo is chosen from the library, shown with the dish on the home page, and counted as a use", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
    // A featured dish: the home page shows its photo on every style (the classic menu page is text only).
  const [dish] = d1<{ id: string; name_sv: string; image_id: string | null }>(
    "SELECT m.id, m.name_sv, m.image_id FROM menu_items m JOIN home_highlights h ON h.site_id = m.site_id AND h.item_id = m.id WHERE m.site_id = 'bistro' AND m.available = 1 AND m.sold_out_on IS NULL ORDER BY h.position LIMIT 1",
  );
  try {
    await page.goto(`/admin/menu/item/${dish.id}/`);
    await page.locator("#dish-photo").getByRole("link", { name: "Välj foto" }).click();
    await expect(page.getByRole("heading", { name: `Foto till ${dish.name_sv}` })).toBeVisible();
    await page.getByRole("radio", { name: photo.sv }).check();
    await page.getByRole("button", { name: "Spara valet" }).click();
    await expect(page.getByRole("status")).toHaveText("Fotot är sparat.");
    await expect(page.getByRole("radio", { name: photo.sv })).toBeChecked();

    await page.goto(`/admin/menu/item/${dish.id}/`);
    await expect(page.locator("#dish-photo")).toContainText(`Foto: ${photo.sv}`);

    await page.goto("/");
    await expect(page.locator(`img[alt="${photo.sv}"]`)).toHaveCount(1);
    await expect(page.locator(`img[alt="${photo.sv}"]`)).toHaveAttribute("srcset", new RegExp(`/media/${photo.id}-400\\.webp 400w`));

    await page.goto(`/admin/photos/${photo.id}/`);
    await expect(page.locator("#photo-uses a")).toHaveAttribute("href", `/admin/menu/item/${dish.id}/photo/`);

    await choose(page, `/admin/menu/item/${dish.id}/photo/`, "Inget foto");
    await page.goto("/");
    await expect(page.locator(`img[alt="${photo.sv}"]`)).toHaveCount(0);
  } finally {
    d1(`UPDATE menu_items SET image_id = ${dish.image_id ? `'${dish.image_id}'` : "NULL"} WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  }
});

test("a page photo is chosen per slot, shown on its page, and the other slots stay as they were", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const [before] = d1<Record<string, string | null>>("SELECT hero_image_id, cta_image_id, menu_hero_image_id, story_image_id, kitchen_image_id FROM page_content WHERE site_id = 'bistro'");
  try {
    await page.goto("/admin/photos/");
    await page.getByRole("link", { name: "Välj sidornas foton" }).click();
    await expect(page.locator("#page-photos li")).toHaveCount(3); // classic draws hero, story and kitchen
    await page.getByRole("link", { name: "Byt: om oss-sidans foto till berättelsen" }).click();
    await page.getByRole("radio", { name: photo.sv }).check();
    await page.getByRole("button", { name: "Spara valet" }).click();
    await expect(page.getByRole("status")).toHaveText("Fotot är sparat.");

    await page.goto("/admin/page-photos/");
    await expect(page.locator("#slot-story")).toContainText(`Nu: ${photo.sv}`);
    const [after] = d1<Record<string, string | null>>("SELECT hero_image_id, cta_image_id, menu_hero_image_id, story_image_id, kitchen_image_id FROM page_content WHERE site_id = 'bistro'");
    expect(after).toEqual({ ...before, story_image_id: photo.id });

    await page.goto("/about/");
    await expect(page.locator(`img[alt="${photo.sv}"]`)).toHaveCount(1);
    await page.goto("/en/about/");
    await expect(page.locator(`img[alt="${photo.en}"]`)).toHaveCount(1);
  } finally {
    d1(`UPDATE page_content SET story_image_id = ${before.story_image_id ? `'${before.story_image_id}'` : "NULL"} WHERE site_id = 'bistro'`);
  }
});

test("an unknown slot is not a page, and a crafted choice of an unknown photo changes nothing", async ({ page }) => {
  await signedInOwner(page);
  expect((await page.goto("/admin/page-photos/logo/"))!.status()).toBe(404);
  const [before] = d1<{ hero_image_id: string | null }>("SELECT hero_image_id FROM page_content WHERE site_id = 'bistro'");
  await page.goto("/admin/page-photos/hero/");
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const res = await page.request.post("/admin/page-photos/hero/", { form: { csrf, image: "d".repeat(64) }, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.headers().location).toBe("/admin/page-photos/hero/?done=not-found");
  await page.goto("/admin/page-photos/hero/?done=not-found");
  await expect(page.getByRole("alert")).toBeFocused();
  expect(d1<{ hero_image_id: string | null }>("SELECT hero_image_id FROM page_content WHERE site_id = 'bistro'")[0]).toEqual(before);
});

test("without JavaScript, in English: choose a dish photo and set it back to none", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const [dish] = d1<{ id: string; image_id: string | null }>("SELECT id, image_id FROM menu_items WHERE site_id = 'bistro' ORDER BY id DESC LIMIT 1");
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState(), extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const plain = await noJs.newPage();
  try {
    await plain.goto(`${BASE}/en/admin/menu/item/${dish.id}/photo/`);
    await plain.getByRole("radio", { name: photo.en }).check();
    await plain.getByRole("button", { name: "Save the choice" }).click();
    await expect(plain.getByRole("status")).toHaveText("The photo is saved.");
    expect(d1<{ image_id: string }>(`SELECT image_id FROM menu_items WHERE site_id = 'bistro' AND id = '${dish.id}'`)[0].image_id).toBe(photo.id);
    await plain.getByRole("radio", { name: "No photo" }).check();
    await plain.getByRole("button", { name: "Save the choice" }).click();
    expect(d1<{ image_id: string | null }>(`SELECT image_id FROM menu_items WHERE site_id = 'bistro' AND id = '${dish.id}'`)[0].image_id).toBeNull();
  } finally {
    await noJs.close();
    d1(`UPDATE menu_items SET image_id = ${dish.image_id ? `'${dish.image_id}'` : "NULL"} WHERE site_id = 'bistro' AND id = '${dish.id}'`);
  }
});
