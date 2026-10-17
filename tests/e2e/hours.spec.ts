/**
 * Opening hours end to end (plan M5.4): a change in the admin shows in the footer, on the
 * contact page and in the JSON-LD on the very next request.
 */
import { expect, type Page, test } from "@playwright/test";
import { daysAhead, signedInOwner } from "./helpers";

const sunday = (page: Page) => page.getByRole("group", { name: "Söndag" });

async function openHours(page: Page) {
  await page.getByRole("link", { name: "Öppettider" }).first().click();
  await expect(page.getByRole("heading", { name: "Öppettider", level: 1 })).toBeVisible();
}

test("new weekly hours show in the footer, the contact page and the JSON-LD", async ({ page }) => {
  await signedInOwner(page);
  await openHours(page);
  await sunday(page).getByLabel("Stängt").uncheck();
  await sunday(page).getByLabel("Öppnar").fill("12:00");
  await sunday(page).getByLabel("Stänger").fill("16:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");

  await page.goto("/contact/");
  await expect(page.locator("main table tr", { hasText: "Söndag" })).toContainText("12:00–16:00");
  await expect(page.locator("footer")).toContainText("12:00–16:00");
  const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(jsonLd).toContain("Su 12:00-16:00");

  // Put Sunday back so other runs start from the seeded week.
  await page.goto("/admin/hours/");
  await sunday(page).getByLabel("Stängt").check();
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await page.goto("/contact/");
  await expect(page.locator("main table tr", { hasText: "Söndag" })).toContainText("Stängt");
});

test("a special day shows on the contact page in both languages, and can be removed", async ({ page }) => {
  await signedInOwner(page);
  await openHours(page);
  const date = daysAhead(40);
  await page.getByLabel("Datum").fill(date);
  await page.getByLabel("Anledning på svenska").fill("Personalfest");
  await page.getByLabel("Anledning på engelska").fill("Staff party");
  await page.getByRole("button", { name: "Lägg till dag" }).click();
  await expect(page.getByRole("status")).toHaveText("Tillagt.");

  await page.goto("/contact/");
  await expect(page.locator("main li", { has: page.locator(`time[datetime="${date}"]`) })).toContainText("Personalfest");
  await page.goto("/en/contact/");
  await expect(page.locator("main li", { has: page.locator(`time[datetime="${date}"]`) })).toContainText("Staff party");

  await page.goto("/admin/hours/");
  await page.locator("#exceptions li", { hasText: "Personalfest" }).getByRole("button", { name: /Ta bort/ }).click();
  await expect(page.getByRole("status")).toHaveText("Borttaget.");
  await page.goto("/contact/");
  await expect(page.locator("main")).not.toContainText("Personalfest");
});

test("rejected hours keep what was typed and say what's wrong", async ({ page }) => {
  await signedInOwner(page);
  await openHours(page);
  await sunday(page).getByLabel("Stängt").uncheck();
  await sunday(page).getByLabel("Öppnar").fill("12:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("alert").first()).toContainText("Kontrollera de markerade fälten");
  await expect(page.locator("#sunday-error")).toContainText("Ange när ni öppnar och stänger");
  await expect(sunday(page).getByLabel("Öppnar")).toHaveValue("12:00");

  await page.getByLabel("Datum").fill(daysAhead(-3));
  await page.getByLabel("Anledning på svenska").fill("För sent");
  await page.getByLabel("Anledning på engelska").fill("Too late");
  await page.getByRole("button", { name: "Lägg till dag" }).click();
  await expect(page.locator("#date-error")).toHaveText("Datumet har redan varit.");
  await expect(page.getByLabel("Anledning på svenska")).toHaveValue("För sent");
});

test("two people editing the hours: the second is told, and can overwrite knowingly", async ({ page }) => {
  await signedInOwner(page);
  await openHours(page);
  const other = await page.context().newPage();
  await other.goto(page.url());
  await sunday(other).getByLabel("Stängt").uncheck();
  await sunday(other).getByLabel("Öppnar").fill("12:00");
  await sunday(other).getByLabel("Stänger").fill("16:00");
  await other.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(other.getByRole("status")).toHaveText("Sparat.");

  await sunday(page).getByLabel("Stängt").uncheck();
  await sunday(page).getByLabel("Öppnar").fill("13:00");
  await sunday(page).getByLabel("Stänger").fill("17:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("alert")).toContainText("Någon annan ändrade öppettiderna nyss");
  await expect(sunday(page).getByLabel("Öppnar")).toHaveValue("13:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
  await expect(sunday(page).getByLabel("Öppnar")).toHaveValue("13:00");
  await expect(sunday(page).getByLabel("Stänger")).toHaveValue("17:00");

  // Put Sunday back so other runs start from the seeded week.
  await sunday(page).getByLabel("Stängt").check();
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
});

test("saving the hours without changing anything says so, in both languages, and adds no history", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/history/");
  const newest = () => page.locator("main ol li").first().textContent({ timeout: 1000 }).catch(() => null);
  const before = await newest();
  await page.goto("/admin/hours/");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Inga ändringar att spara.");
  await page.goto("/en/admin/hours/");
  await page.getByRole("button", { name: "Save opening hours" }).click();
  await expect(page.getByRole("status")).toHaveText("No changes to save.");
  await page.goto("/admin/history/");
  expect(await newest()).toBe(before);
});
