/**
 * Undo for a deleted dish (ADR-018): the owner deletes a dish they added, then puts it back
 * from the flash on the menu page, or later from the history page. The dish is on the admin
 * and the public menu again, in its place (also from the middle of a category); a featured
 * dish is featured again (last, as ADR-018 says); a dish whose category is gone goes through the
 * category picker; a second undo of the same entry says it's already back. Works without
 * JavaScript. Asserts only on the dishes the test created, except the featured dish: the home
 * page is full in the seed, so that test deletes and restores a seeded one.
 */
import { expect, type Page, test } from "@playwright/test";
import { clearOfMidnight, dishRow, signedInOwner } from "./helpers";

test.beforeEach(clearOfMidnight);

let n = 0;
const categories = (page: Page) => page.locator("section[id^='category-']");

/** Add a dish through the admin, named uniquely, at the end of a category (the first by default). */
async function addDish(page: Page, category?: string): Promise<string> {
  const name = `Ångersoppa ${Date.now().toString(36)}${n++}`;
  await page.goto("/admin/");
  const section = category ? categories(page).filter({ has: page.getByRole("heading", { name: category, exact: true }) }) : categories(page).first();
  await section.getByRole("link", { name: /Lägg till rätt/ }).click();
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

test("a dish from the middle of its category comes back in the middle", async ({ page }) => {
  await signedInOwner(page);
  const [a, b, c] = [await addDish(page), await addDish(page), await addDish(page)];
  const order = async () => {
    const rows = await categories(page).first().locator("li[id^='item-']").allInnerTexts();
    return [a, b, c].map((name) => rows.findIndex((row) => row.includes(name)));
  };
  await deleteDish(page, b);
  await page.getByRole("status").getByRole("button", { name: "Ångra" }).click();
  await expect(page.getByRole("status")).toHaveText("Rätten är tillbaka på menyn.");
  const [ia, ib, ic] = await order();
  expect(ia).toBeGreaterThanOrEqual(0);
  expect(ia < ib && ib < ic, `${a}, ${b}, ${c} at ${ia}, ${ib}, ${ic}`).toBe(true);
  // The public menu shows the same order.
  await page.goto("/menu/");
  const rows = await page.locator(".menu-item-row").allInnerTexts();
  const at = [a, b, c].map((name) => rows.findIndex((row) => row.includes(name)));
  expect(at[0] < at[1] && at[1] < at[2], at.join(", ")).toBe(true);
});

test("a featured dish deleted and undone is on the home page again, last", async ({ page }) => {
  await signedInOwner(page);
  const featured = page.locator("li[id^='item-']", { hasText: "På startsidan" }).first();
  const name = (await featured.locator("p.font-semibold").textContent())!.trim();
  const cards = async () => {
    await page.goto("/");
    return page.locator("main ul.strip > li, main ul.dish-cards > li").allInnerTexts();
  };
  const before = await cards();
  const slot = before.findIndex((card) => card.includes(name));
  expect(slot, `${name} on the home page`).toBeGreaterThanOrEqual(0);

  await deleteDish(page, name);
  const flash = page.getByRole("status").getByRole("button", { name: "Ångra" });
  await expect(flash).toBeVisible();
  expect((await cards()).some((card) => card.includes(name))).toBe(false);

  await page.goBack();
  await page.getByRole("status").getByRole("button", { name: "Ångra" }).click();
  // The plain "back" message: featured again, photo kept. Anything else would say so.
  await expect(page.getByRole("status")).toHaveText("Rätten är tillbaka på menyn.");
  await expect(dishRow(page, name)).toContainText("På startsidan");
  // ADR-018: a highlight comes back at the end of the list (if there is room), not in its old slot.
  expect(await cards()).toEqual([...before.filter((card) => !card.includes(name)), before[slot]]);
});

test("a dish whose category was deleted goes back through the category picker", async ({ page }) => {
  await signedInOwner(page);
  const gone = `Ångerkategori ${Date.now().toString(36)}`;
  await page.getByRole("link", { name: /Lägg till kategori/ }).click();
  await page.getByLabel("Namn på svenska").fill(gone);
  await page.getByLabel("Namn på engelska").fill("Regret category");
  await page.getByRole("button", { name: "Lägg till kategori" }).click();
  const name = await addDish(page, gone);
  await deleteDish(page, name);
  await categories(page)
    .filter({ has: page.getByRole("heading", { name: gone, exact: true }) })
    .getByRole("link", { name: "Ändra kategori" })
    .click();
  await page.getByRole("link", { name: "Ta bort kategorin" }).click();
  await page.getByRole("button", { name: "Ja, ta bort kategorin och rätterna" }).click();
  await expect(page.getByRole("heading", { name: gone })).toHaveCount(0);
  const names = (await categories(page).locator("h2").allInnerTexts()).map((t) => t.trim());
  const target = names.at(-1)!;

  await page.goto("/admin/history/");
  await page
    .locator("ol > li", { hasText: `${name}: borttagen` })
    .getByRole("button", { name: `Ångra: ${name}: borttagen` })
    .click();
  // The picker: every remaining category, the first chosen, and nothing restored yet.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Vilken kategori?");
  await expect(page.getByText(`Kategorin som ${name} låg i finns inte längre.`)).toBeVisible();
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(names.length);
  await expect(radios.first()).toBeChecked();
  await page.goto("/admin/");
  await expect(dishRow(page, name)).toHaveCount(0);
  await page.goBack();

  await page.getByRole("radio", { name: target }).check();
  await page.getByRole("button", { name: "Lägg tillbaka" }).click();
  await expect(page.getByRole("status")).toContainText("Rätten är tillbaka på menyn.");
  const section = categories(page).filter({ has: page.getByRole("heading", { name: target, exact: true }) });
  // ADR-018: its old position (first, the only dish), clamped to the new category's length.
  await expect(section.locator("li[id^='item-']").first()).toContainText(name);
});
