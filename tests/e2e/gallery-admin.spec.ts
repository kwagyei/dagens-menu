/**
 * The admin gallery end to end (plan M6.10b): add a library photo, see it on the public
 * gallery, move it, take it out again (the photo stays in the library), with focus kept on
 * the control used and the refusals said plainly. Each test works on photos it uploaded.
 */
import { expect, type Page, test } from "@playwright/test";
import { d1, freshIp, signedInOwner, uploadPhoto } from "./helpers";

// Several uploads, picks and local SQL calls per test: up to ~35 s on CI runners, over the
// 30 s default, so each test gets 90 s (as media-route-attacks.edge.spec.ts does).
test.describe.configure({ timeout: 90_000 });

const BASE = "http://localhost:8790";
const GALLERY = "/admin/gallery/";

const addable = (page: Page, id: string) => page.locator(`#addable-${id.slice(0, 12)}`);
const inGallery = (page: Page, id: string) => page.locator("#gallery li").filter({ has: page.locator(`img[src*="${id}"]`) });

test("a library photo is added to the gallery, shown on the public gallery, then removed and kept in the library", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);

  await page.goto(GALLERY);
  await addable(page, photo.id).getByRole("button", { name: `Lägg till i galleriet: ${photo.sv}` }).click();
  await expect(page.getByRole("status")).toHaveText("Fotot är tillagt i galleriet.");
  await expect(inGallery(page, photo.id)).toContainText(photo.sv);
  await expect(addable(page, photo.id)).toHaveCount(0);

  // The public gallery shows it, with its alt, in both languages.
  await page.goto("/gallery/");
  await expect(page.locator(`.gallery-magazine img[alt="${photo.sv}"]`)).toHaveCount(1);
  await page.goto("/en/gallery/");
  await expect(page.locator(`.gallery-magazine img[alt="${photo.en}"]`)).toHaveCount(1);

  // The library says where it's used, with a link back here.
  await page.goto(`/admin/photos/${photo.id}/`);
  await expect(page.locator("#photo-uses a")).toHaveAttribute("href", GALLERY);

  await page.goto(GALLERY);
  await inGallery(page, photo.id).getByRole("button", { name: `Ta bort från galleriet: ${photo.sv}` }).click();
  await expect(page.getByRole("status")).toHaveText("Fotot är borttaget från galleriet. Det finns kvar bland dina foton.");
  await expect(inGallery(page, photo.id)).toHaveCount(0);
  await expect(addable(page, photo.id)).toHaveCount(1);
  expect(d1(`SELECT id FROM images WHERE id = '${photo.id}'`)).toHaveLength(1);
  await page.goto("/gallery/");
  await expect(page.locator(`.gallery-magazine img[alt="${photo.sv}"]`)).toHaveCount(0);
});

test("moving a photo swaps it with its neighbour and keeps focus on the button used", async ({ page }) => {
  await signedInOwner(page);
  const a = await uploadPhoto(page);
  const b = await uploadPhoto(page);
  await page.goto(GALLERY);
  for (const p of [a, b]) await addable(page, p.id).getByRole("button", { name: `Lägg till i galleriet: ${p.sv}` }).click();

  const ids = async () => page.locator("#gallery li img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).getAttribute("src") ?? ""));
  const indexOf = async (id: string) => (await ids()).findIndex((src) => src.includes(id));
  const before = await indexOf(b.id);
  expect(before).toBe((await indexOf(a.id)) + 1);

  await inGallery(page, b.id).getByRole("button", { name: `Flytta tidigare: ${b.sv}` }).click();
  expect(await indexOf(b.id)).toBe(before - 1);
  expect(await indexOf(a.id)).toBe(before);
  await expect(inGallery(page, b.id).getByRole("button", { name: `Flytta tidigare: ${b.sv}` })).toBeFocused();

  // Clean up: both out of the gallery again.
  for (const p of [a, b]) await inGallery(page, p.id).getByRole("button", { name: `Ta bort från galleriet: ${p.sv}` }).click();
});

test("refusals: a photo already in the gallery, and a photo deleted meanwhile, are said plainly and focused", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  await page.goto(GALLERY);
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const post = (id: string) => page.request.post(GALLERY, { form: { csrf, action: "add", id }, maxRedirects: 0, headers: { Origin: BASE } });

  expect((await post(photo.id)).headers().location).toBe(`${GALLERY}?done=added`);
  expect((await post(photo.id)).headers().location).toBe(`${GALLERY}?done=already`);
  await page.goto(`${GALLERY}?done=already`);
  await expect(page.getByRole("alert")).toHaveText("Fotot finns redan i galleriet.");
  await expect(page.getByRole("alert")).toBeFocused();

  expect((await post("e".repeat(64))).headers().location).toBe(`${GALLERY}?done=not-found`);
  d1(`DELETE FROM gallery_images WHERE site_id = 'bistro' AND image_id = '${photo.id}'`);
});

test("without JavaScript, in English: add, move and remove", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState(), extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const plain = await noJs.newPage();
  await plain.goto(`${BASE}/en${GALLERY}`);
  await addable(plain, photo.id).getByRole("button", { name: `Add to the gallery: ${photo.en}` }).click();
  await expect(plain.getByRole("status")).toHaveText("The photo is added to the gallery.");
  await inGallery(plain, photo.id).getByRole("button", { name: `Move earlier: ${photo.en}` }).click();
  await expect(inGallery(plain, photo.id)).toHaveCount(1);
  await inGallery(plain, photo.id).getByRole("button", { name: `Remove from the gallery: ${photo.en}` }).click();
  await expect(plain.getByRole("status")).toHaveText("The photo is removed from the gallery. It's still in your photos.");
  await noJs.close();
});
