/**
 * Admin accessibility (plan M5.7): axe finds nothing on any admin page, in Swedish and
 * English, signed out and in, and on each form in its error state, where it matters most.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

async function expectNoViolations(page: Page, what: string) {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(summary, what).toEqual([]);
}

test("the sign-in page, in both languages", async ({ page }) => {
  for (const path of ["/admin/", "/en/admin/"]) {
    await page.goto(path);
    await expectNoViolations(page, path);
  }
});

test("every signed-in admin page, in both languages", async ({ page }) => {
  await signedInOwner(page);
  const itemPath = await page.locator("li[id^='item-'] a").first().getAttribute("href");
  const categoryPath = await page.locator("section[id^='category-'] a[href*='/menu/category/']").first().getAttribute("href");
  const newDishPath = await page.locator("a[href*='/menu/new/?category=']").first().getAttribute("href");
  const pages = ["/", "/menu/category/new/", "/hours/", "/texts/", "/history/", "/security/"];
  const paths = [...pages.map((p) => `/admin${p}`), newDishPath!, itemPath!, `${itemPath}delete/`, categoryPath!, `${categoryPath}delete/`];
  for (const path of paths) {
    for (const prefix of ["", "/en"]) {
      await page.goto(`${prefix}${path}`);
      await expectNoViolations(page, `${prefix}${path}`);
    }
  }
});

test("forms in their error state", async ({ page }) => {
  await signedInOwner(page);
  await page.locator("a[href*='/menu/new/?category=']").first().click();
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expectNoViolations(page, "new dish, rejected");

  await page.goto("/admin/hours/");
  // Open, with no opening time: an error on any site, whatever its Sunday is.
  await page.getByRole("group", { name: "Söndag" }).getByLabel("Stängt").uncheck();
  await page.getByRole("group", { name: "Söndag" }).getByLabel("Öppnar").fill("");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.locator("#weekly-errors")).toBeVisible();
  await expectNoViolations(page, "weekly hours, rejected");

  await page.goto("/admin/hours/");
  await page.getByRole("button", { name: "Lägg till dag" }).click();
  await expect(page.locator("#exception-errors")).toBeVisible();
  await expectNoViolations(page, "special day, rejected");

  await page.goto("/admin/texts/");
  await page.locator("form#settings").getByLabel("Instagram").fill("http://x");
  await page.getByRole("button", { name: "Spara restaurangen" }).click();
  await expect(page.locator("#settings-errors")).toBeVisible();
  await expectNoViolations(page, "settings, rejected");
});

test("each error in the summary takes the keyboard to its field", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/hours/");
  await page.getByRole("button", { name: "Lägg till dag" }).click();
  await page.locator("#exception-errors a").first().click();
  await expect(page.locator("#date")).toBeFocused();
});

test("the photo library pages, in both languages, and the description form rejected (M6.10)", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/photos/");
  const photoPath = await page.locator("#uploads a[href*='/admin/photos/']").last().getAttribute("href");
  const paths = ["/admin/photos/", "/admin/photos/?filter=unused", "/admin/photos/unused/delete/", photoPath!, `${photoPath}delete/`, "/admin/gallery/", "/admin/gallery/?done=already", "/admin/page-photos/", "/admin/page-photos/story/", "/admin/page-photos/story/?done=not-found"];
  for (const path of paths) {
    for (const prefix of ["", "/en"]) {
      await page.goto(`${prefix}${path}`);
      await expectNoViolations(page, `${prefix}${path}`);
    }
  }
  const dishPath = await page.goto("/admin/").then(() => page.locator("li[id^='item-'] a").first().getAttribute("href"));
  for (const prefix of ["", "/en"]) {
    await page.goto(`${prefix}${dishPath}photo/`);
    await expectNoViolations(page, `${prefix}${dishPath}photo/`);
  }
  await page.goto(photoPath!);
  await page.getByLabel("Beskrivning på svenska").fill("");
  await page.getByRole("button", { name: "Spara beskrivningen" }).click();
  await expect(page.locator("#photo-alt-errors")).toBeVisible();
  await expectNoViolations(page, "photo description, rejected");
});
