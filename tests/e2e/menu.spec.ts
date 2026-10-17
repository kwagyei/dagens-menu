/**
 * Menu editing end to end (plan M5.1–M5.3): every change made in the admin shows on the
 * public site on the very next request. Each test edits different dishes of the seeded
 * bistro menu, so they don't depend on each other's order.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { dishRow, signedInOwner } from "./helpers";

type Menu = { categories: Array<{ items: Array<{ id: string; name: { sv: string; en: string } }> }> };
const menu: Menu = JSON.parse(readFileSync(new URL("../../sites/bistro/content/menu.json", import.meta.url), "utf-8"));
const dish = (c: number, i: number) => menu.categories[c].items[i];
const featured: string[] = JSON.parse(readFileSync(new URL("../../sites/bistro/content/pages.json", import.meta.url), "utf-8")).home.highlights;

test("sold out today, from the menu list, shows on the public menu in both languages", async ({ page }) => {
  await signedInOwner(page);
  const name = dish(1, 1).name.sv;
  await dishRow(page, name).getByRole("button", { name: "Slutsåld idag" }).click();
  await expect(dishRow(page, name).getByText("Slutsåld idag", { exact: true }).first()).toBeVisible();
  await page.goto("/menu/");
  await expect(page.locator(".menu-item-row", { hasText: name })).toContainText("Slutsåld idag");
  await page.goto("/en/menu/");
  await expect(page.locator(".menu-item-row", { hasText: dish(1, 1).name.en })).toContainText("Sold out today");
  await page.goto("/admin/");
  await dishRow(page, name).getByRole("button", { name: "Finns igen" }).click();
  await page.goto("/menu/");
  await expect(page.locator(".menu-item-row", { hasText: name })).not.toContainText("Slutsåld idag");
});

test("editing a price shows on the public menu on the next request", async ({ page }) => {
  await signedInOwner(page);
  const name = dish(2, 0).name.sv;
  await dishRow(page, name).getByRole("link", { name: "Ändra" }).click();
  await page.getByLabel("Pris i kronor").fill("199:-");
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
  await expect(dishRow(page, name)).toContainText("199 kr");
  await page.goto("/menu/");
  await expect(page.locator(".menu-item-row", { hasText: name })).toContainText("199 kr");
});

test("a rejected form keeps what was typed and says what's wrong", async ({ page }) => {
  await signedInOwner(page);
  await dishRow(page, dish(2, 1).name.sv).getByRole("link", { name: "Ändra" }).click();
  await page.getByLabel("Namn på engelska").fill("");
  await page.getByLabel("Pris i kronor").fill("1,250");
  await page.getByLabel("Beskrivning på svenska").fill("Ny beskrivning som ska finnas kvar");
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("alert")).toContainText("Kontrollera de markerade fälten");
  await expect(page.locator("#name_en-error")).toHaveText("Fyll i det här fältet.");
  await expect(page.locator("#price-error")).toContainText("Menar du kronor och öre");
  await expect(page.getByLabel("Beskrivning på svenska")).toHaveValue("Ny beskrivning som ska finnas kvar");
  await expect(page.getByLabel("Namn på engelska")).toHaveAttribute("aria-invalid", "true");
});

test("an unusual price needs a ticked confirmation", async ({ page }) => {
  await signedInOwner(page);
  const name = dish(3, 0).name.sv;
  await dishRow(page, name).getByRole("link", { name: "Ändra" }).click();
  await page.getByLabel("Pris i kronor").fill("4500");
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByText(/Priset ser ovanligt ut/).first()).toBeVisible();
  await page.getByLabel("Ja, priset stämmer").check();
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(dishRow(page, name)).toContainText("4 500 kr");
});

test("two people editing the same dish: the second is told, and can overwrite knowingly", async ({ page, browser }) => {
  await signedInOwner(page);
  const name = dish(4, 0).name.sv;
  await dishRow(page, name).getByRole("link", { name: "Ändra" }).click();
  const editUrl = page.url();
  const other = await page.context().newPage();
  await other.goto(editUrl);
  await other.getByLabel("Pris i kronor").fill("71");
  await other.getByRole("button", { name: "Spara" }).click();
  await expect(other.getByRole("status")).toHaveText("Sparat.");

  await page.getByLabel("Pris i kronor").fill("72");
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("alert")).toContainText("Någon annan ändrade den här rätten nyss");
  await expect(page.getByLabel("Pris i kronor")).toHaveValue("72");
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(dishRow(page, name)).toContainText("72 kr");
  void browser;
});

test("adding a dish puts it on the public menu; deleting it takes it off", async ({ page }) => {
  await signedInOwner(page);
  const category = page.locator("section[id^='category-']").first();
  await category.getByRole("link", { name: /Lägg till rätt/ }).click();
  await page.getByLabel("Namn på svenska").fill("Testsoppa");
  await page.getByLabel("Namn på engelska").fill("Test soup");
  await page.getByLabel("Beskrivning på svenska").fill("Med dill");
  await page.getByLabel("Beskrivning på engelska").fill("With dill");
  await page.getByLabel("Pris i kronor").fill("95");
  await page.getByLabel("mjölk").check();
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await expect(page.getByRole("status")).toHaveText("Tillagt.");
  await page.goto("/menu/");
  const row = page.locator(".menu-item-row", { hasText: "Testsoppa" });
  await expect(row).toContainText("95 kr");
  await expect(row).toContainText("mjölk");

  await page.goto("/admin/");
  await dishRow(page, "Testsoppa").getByRole("link", { name: "Ändra" }).click();
  await page.getByRole("link", { name: "Ta bort rätten" }).click();
  await expect(page.getByText(/Testsoppa försvinner från menyn/)).toBeVisible();
  await page.getByRole("button", { name: "Ja, ta bort" }).click();
  await expect(page.getByRole("status")).toHaveText("Borttaget.");
  await page.goto("/menu/");
  await expect(page.getByText("Testsoppa")).toHaveCount(0);
});

test("moving a dish up changes the order on the public menu", async ({ page }) => {
  await signedInOwner(page);
  const [first, second] = [dish(0, 0).name.sv, dish(0, 1).name.sv];
  await dishRow(page, second).getByRole("button", { name: `Flytta upp: ${second}` }).click();
  await page.goto("/menu/");
  const names = await page.locator(".menu-item-row h3").allTextContents();
  expect(names.findIndex((n) => n.includes(second))).toBeLessThan(names.findIndex((n) => n.includes(first)));
  await page.goto("/admin/");
  await dishRow(page, second).getByRole("button", { name: `Flytta ned: ${second}` }).click();
});

test("a fourth home-page dish is refused with an explanation", async ({ page }) => {
  await signedInOwner(page);
  // Any seeded dish that isn't one of the three featured ones; the save is refused, so it changes nothing.
  const other = menu.categories.flatMap((c) => c.items).find((d) => !featured.includes(d.id))!;
  const notFeatured = dishRow(page, other.name.sv);
  await notFeatured.getByRole("link", { name: "Ändra" }).click();
  await page.getByLabel("Visa på startsidan").check();
  await page.getByRole("button", { name: "Spara" }).click();
  await expect(page.getByRole("alert")).toContainText("Startsidan visar redan tre rätter");
  await expect(page.locator("#featured-error")).toContainText("Startsidan visar redan tre rätter");
});

test("categories: add, rename, and delete with their dishes", async ({ page }) => {
  await signedInOwner(page);
  await page.getByRole("link", { name: /Lägg till kategori/ }).click();
  await page.getByLabel("Namn på svenska").fill("Säsong");
  await page.getByLabel("Namn på engelska").fill("Seasonal");
  await page.getByRole("button", { name: "Lägg till kategori" }).click();
  const section = page.locator("section[id^='category-']", { has: page.getByRole("heading", { name: "Säsong" }) });
  await expect(section).toContainText("Inga rätter i den här kategorin än.");

  await section.getByRole("link", { name: "Ändra kategori" }).click();
  await page.getByLabel("Namn på svenska").fill("Höstmeny");
  await page.getByLabel("Namn på engelska").fill("Autumn menu");
  await page.getByRole("button", { name: "Spara" }).click();
  const renamed = page.locator("section[id^='category-']", { has: page.getByRole("heading", { name: "Höstmeny" }) });
  await expect(renamed).toBeVisible();

  await renamed.getByRole("link", { name: "Ändra kategori" }).click();
  await page.getByRole("link", { name: "Ta bort kategorin" }).click();
  await expect(page.getByText(/dess 0 rätter tas bort/)).toBeVisible();
  await page.getByRole("button", { name: "Ja, ta bort kategorin och rätterna" }).click();
  await expect(page.getByRole("heading", { name: "Höstmeny" })).toHaveCount(0);
});

test("editing works without JavaScript", async ({ page, browser }) => {
  await signedInOwner(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, baseURL: "http://localhost:8790" });
  await noJs.addCookies(await page.context().cookies());
  const plain = await noJs.newPage();
  await plain.goto("/admin/");
  const name = dish(3, 1).name.sv;
  await dishRow(plain, name).getByRole("button", { name: "Slutsåld idag" }).click();
  await expect(dishRow(plain, name).getByRole("button", { name: "Finns igen" })).toBeVisible();
  await dishRow(plain, name).getByRole("link", { name: "Ändra" }).click();
  await plain.getByLabel("Pris i kronor").fill("88");
  await plain.getByRole("button", { name: "Spara" }).click();
  await expect(dishRow(plain, name)).toContainText("88 kr");
  await dishRow(plain, name).getByRole("button", { name: "Finns igen" }).click();
  await noJs.close();
});

test("signed out, the editing pages send you to sign in", async ({ request }) => {
  const res = await request.get(`/admin/menu/item/${dish(0, 0).id}/`, { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toMatch(/\/admin\/$/);
});
