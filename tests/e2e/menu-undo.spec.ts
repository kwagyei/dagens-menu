/**
 * Undo for a deleted dish (ADR-018): the owner deletes a dish they added, then puts it back
 * from the flash on the menu page, or later from the history page. The dish is on the admin
 * and the public menu again; a second undo of the same entry says it's already back. Works
 * without JavaScript. Asserts only on the dish the test created.
 */
import { expect, type Page, test } from "@playwright/test";
import { clearOfMidnight, dishRow, signedInOwner } from "./helpers";

test.beforeEach(clearOfMidnight);

let n = 0;
/** Add a dish through the admin, named uniquely, at the end of the first category. */
async function addDish(page: Page): Promise<string> {
  const name = `Ångersoppa ${Date.now().toString(36)}${n++}`;
  await page.goto("/admin/");
  await page
    .locator("section[id^='category-']")
    .first()
    .getByRole("link", { name: /Lägg till rätt/ })
    .click();
  await page.getByLabel("Namn på svenska").fill(name);
  await page.getByLabel("Namn på engelska").fill(`Regret soup ${n}`);
  await page.getByLabel("Beskrivning på svenska").fill("Med dill");
  await page.getByLabel("Beskrivning på engelska").fill("With dill");
  await page.getByLabel("Pris i kronor").fill("95");
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await expect(page.getByRole("status")).toHaveText("Tillagt.");
  return name;
}

/** Delete the dish through its confirmation page; lands on the menu page's flash. */
async function deleteDish(page: Page, name: string) {
  await page.goto("/admin/");
  await dishRow(page, name).getByRole("link", { name: "Ändra" }).click();
  await page.getByRole("link", { name: "Ta bort rätten" }).click();
  await page.getByRole("button", { name: "Ja, ta bort" }).click();
  await expect(page.getByRole("status")).toContainText("Borttaget.");
}

test("deleted, then undone from the flash: back in its place on the admin and the public menu", async ({ page }) => {
  await signedInOwner(page);
  const name = await addDish(page);
  const category = page.locator("section[id^='category-']").first();
  const positionBefore = await category.locator("li[id^='item-']").count();
  await deleteDish(page, name);
  await expect(dishRow(page, name)).toHaveCount(0);
  await page.getByRole("status").getByRole("button", { name: "Ångra" }).click();
  await expect(page.getByRole("status")).toHaveText("Rätten är tillbaka på menyn.");
  await expect(dishRow(page, name)).toHaveCount(1);
  // The same place: last in the first category, where it was added.
  await expect(category.locator("li[id^='item-']").nth(positionBefore - 1)).toContainText(name);
  await expect(dishRow(page, name)).toContainText("95 kr");
  await page.goto("/menu/");
  await expect(page.locator(".menu-item-row", { hasText: name })).toContainText("95 kr");
  await page.goto("/admin/history/");
  const newest = page.locator("ol > li").first();
  await expect(newest).toContainText(`${name}: återställd`);
  await expect(newest.getByRole("button", { name: /Ångra/ })).toHaveCount(0);
});

test("deleted, then undone from the history page", async ({ page }) => {
  await signedInOwner(page);
  const name = await addDish(page);
  await deleteDish(page, name);
  await page.goto("/admin/history/");
  const entry = page.locator("ol > li", { hasText: `${name}: borttagen` });
  await entry.getByRole("button", { name: `Ångra: ${name}: borttagen` }).click();
  await expect(page.getByRole("status")).toHaveText("Rätten är tillbaka på menyn.");
  await expect(dishRow(page, name)).toHaveCount(1);
  await page.goto("/admin/history/");
  await expect(entry.getByRole("button", { name: /Ångra/ })).toHaveCount(0);
});

test("the same undo submitted again says the dish is already back, and changes nothing", async ({ page }) => {
  await signedInOwner(page);
  const name = await addDish(page);
  await deleteDish(page, name);
  // Admin pages are never cached, so "back" re-fetches a page that no longer offers Ångra: the
  // realistic replay is the same form posted twice (a double tap, a retried request).
  const form = { csrf: await page.locator("input[name=csrf]").first().inputValue(), entry: await page.locator("input[name=entry]").inputValue() };
  await page.getByRole("status").getByRole("button", { name: "Ångra" }).click();
  await expect(page.getByRole("status")).toHaveText("Rätten är tillbaka på menyn.");
  const again = await page.request.post("/admin/menu/restore/", { form, maxRedirects: 0, headers: { Origin: "http://localhost:8790" } });
  expect(again.status()).toBe(303);
  await page.goto(again.headers().location!);
  await expect(page.getByRole("status")).toHaveText("Rätten är redan tillbaka på menyn.");
  await expect(dishRow(page, name)).toHaveCount(1);
});

test("undo works without JavaScript", async ({ page, browser }) => {
  await signedInOwner(page);
  const name = await addDish(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, baseURL: "http://localhost:8790" });
  await noJs.addCookies(await page.context().cookies());
  const plain = await noJs.newPage();
  await deleteDish(plain, name);
  await plain.getByRole("status").getByRole("button", { name: "Ångra" }).click();
  await expect(plain.getByRole("status")).toHaveText("Rätten är tillbaka på menyn.");
  await expect(dishRow(plain, name)).toHaveCount(1);
  await noJs.close();
});
