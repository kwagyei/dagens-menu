/**
 * Texts end to end (plan M5.5): the restaurant's settings and the page texts change on the
 * public site on the very next request; a non-https social link is refused; booking and the
 * map are not the owner's to edit.
 */
import { expect, type Page, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

async function openTexts(page: Page) {
  await page.getByRole("link", { name: "Texter" }).first().click();
  await expect(page.getByRole("heading", { name: "Texter och kontakt", level: 1 })).toBeVisible();
}
const settingsForm = (page: Page) => page.locator("form#settings");
const pagesForm = (page: Page) => page.locator("form#pages");

test("new contact details and a social link show in the footer and the JSON-LD", async ({ page }) => {
  await signedInOwner(page);
  await openTexts(page);
  const phone = await settingsForm(page).getByLabel("Telefon").inputValue();
  await settingsForm(page).getByLabel("Telefon").fill("08-555 123 45");
  await settingsForm(page).getByLabel("TikTok").fill("https://tiktok.com/@bistronorden");
  await page.getByRole("button", { name: "Spara restaurangen" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");

  await page.goto("/en/");
  await expect(page.getByRole("contentinfo")).toContainText("08-555 123 45");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "TikTok" })).toHaveAttribute("href", "https://tiktok.com/@bistronorden");
  const jsonLd = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(JSON.parse(jsonLd!).telephone).toBe("08-555 123 45");

  // Put it back so other tests see the seeded footer.
  await page.goto("/admin/texts/");
  await settingsForm(page).getByLabel("Telefon").fill(phone);
  await settingsForm(page).getByLabel("TikTok").fill("");
  await page.getByRole("button", { name: "Spara restaurangen" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
});

test("a non-https social link is refused, with the input kept and nothing changed", async ({ page }) => {
  await signedInOwner(page);
  await openTexts(page);
  await settingsForm(page).getByLabel("Facebook").fill("http://facebook.com/bistronorden");
  const response = page.waitForResponse((r) => r.url().includes("/admin/texts/") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Spara restaurangen" }).click();
  expect((await response).status()).toBe(422);
  await expect(page.locator("#social_facebook-error")).toHaveText("Länken måste börja med https://.");
  await expect(settingsForm(page).getByLabel("Facebook")).toHaveValue("http://facebook.com/bistronorden");
  await expect(settingsForm(page).getByLabel("Facebook")).toHaveAttribute("aria-invalid", "true");
  await page.goto("/");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Facebook" })).toHaveCount(0);
});

test("the home headline and pull quote change in both languages", async ({ page }) => {
  await signedInOwner(page);
  await openTexts(page);
  const before = {
    sv: await pagesForm(page).getByLabel("Startsidans rubrik på svenska").inputValue(),
    en: await pagesForm(page).getByLabel("Startsidans rubrik på engelska").inputValue(),
    quoteSv: await pagesForm(page).getByLabel("Citat på startsidan, svenska").inputValue(),
    quoteEn: await pagesForm(page).getByLabel("Citat på startsidan, engelska").inputValue(),
  };
  await pagesForm(page).getByLabel("Startsidans rubrik på svenska").fill("Höstens meny är här");
  await pagesForm(page).getByLabel("Startsidans rubrik på engelska").fill("The autumn menu is here");
  await pagesForm(page).getByLabel("Citat på startsidan, svenska").fill("Bästa lunchen på Söder.");
  await pagesForm(page).getByLabel("Citat på startsidan, engelska").fill("");
  await page.getByRole("button", { name: "Spara texterna" }).click();
  await expect(page.locator("#pull_quote_en-error")).toHaveText("Fyll i citatet på båda språken, eller töm båda.");
  await expect(pagesForm(page).getByLabel("Startsidans rubrik på svenska")).toHaveValue("Höstens meny är här");

  await pagesForm(page).getByLabel("Citat på startsidan, engelska").fill("The best lunch in Södermalm.");
  await page.getByRole("button", { name: "Spara texterna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
  await page.goto("/");
  await expect(page.locator("main")).toContainText("Höstens meny är här");
  await expect(page.locator("main")).toContainText("Bästa lunchen på Söder.");
  await page.goto("/en/");
  await expect(page.locator("main")).toContainText("The autumn menu is here");
  await expect(page.locator("main")).toContainText("The best lunch in Södermalm.");

  await page.goto("/admin/texts/");
  await pagesForm(page).getByLabel("Startsidans rubrik på svenska").fill(before.sv);
  await pagesForm(page).getByLabel("Startsidans rubrik på engelska").fill(before.en);
  await pagesForm(page).getByLabel("Citat på startsidan, svenska").fill(before.quoteSv);
  await pagesForm(page).getByLabel("Citat på startsidan, engelska").fill(before.quoteEn);
  await page.getByRole("button", { name: "Spara texterna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
});

test("emptying the pull quote in both languages removes it from the home page", async ({ page }) => {
  await signedInOwner(page);
  await openTexts(page);
  const quote = await pagesForm(page).getByLabel("Citat på startsidan, svenska").inputValue();
  const quoteEn = await pagesForm(page).getByLabel("Citat på startsidan, engelska").inputValue();
  test.skip(!quote, "the seeded site has no pull quote");
  await pagesForm(page).getByLabel("Citat på startsidan, svenska").fill("");
  await pagesForm(page).getByLabel("Citat på startsidan, engelska").fill("");
  await page.getByRole("button", { name: "Spara texterna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
  await page.goto("/");
  await expect(page.locator("main")).not.toContainText(quote);

  await page.goto("/admin/texts/");
  await pagesForm(page).getByLabel("Citat på startsidan, svenska").fill(quote);
  await pagesForm(page).getByLabel("Citat på startsidan, engelska").fill(quoteEn);
  await page.getByRole("button", { name: "Spara texterna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
});

test("booking and the map are not on the owner's page", async ({ page }) => {
  await signedInOwner(page);
  await openTexts(page);
  await expect(page.locator("[name*='booking'], [name*='map'], [name*='embed']")).toHaveCount(0);
  await expect(page.getByText("Bokning och karta sköts av den som byggt webbplatsen")).toBeVisible();
});
