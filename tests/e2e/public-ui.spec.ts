/**
 * The public site's basics on a phone (UI review PR A): the menu button is reachable, a site
 * with nothing to consent to asks for no consent, and each highlight shows its own dish.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

type Menu = { categories: Array<{ items: Array<{ id: string; name: { sv: string }; image?: string }> }> };
const menu: Menu = JSON.parse(readFileSync(new URL("../../sites/bistro/content/menu.json", import.meta.url), "utf-8"));
const pages = JSON.parse(readFileSync(new URL("../../sites/bistro/content/pages.json", import.meta.url), "utf-8"));

test.use({ viewport: { width: 390, height: 844 } });

test("the menu button is the element under its own centre, and opens the navigation", async ({ page }) => {
  await page.goto("/");
  const toggle = page.locator("#menu-toggle");
  const box = (await toggle.boundingBox())!;
  const topmost = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest("#menu-toggle") !== null, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(topmost, "something covers the menu button").toBe(true);
  await toggle.click();
  await expect(page.locator("#nav-menu")).toBeVisible();
  await expect(page).toHaveURL("/");
});

test("one booking button in the header at each width", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("header a[href='/book/']:visible")).toHaveCount(0);
  for (const width of [800, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("header a[href='/book/']:visible")).toHaveCount(1);
  }
});

test("no consent banner or consent link when nothing third-party can load", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#consent-banner")).toHaveCount(0);
  await expect(page.locator("#change-consent")).toHaveCount(0);
});

test("each home highlight shows its own dish's photo, or none", async ({ page }) => {
  await page.goto("/");
  const items = menu.categories.flatMap((c) => c.items);
  for (const id of pages.home.highlights as string[]) {
    const dish = items.find((i) => i.id === id)!;
    const img = page.locator(`main img[alt="${dish.name.sv}"]`);
    if (dish.image) await expect(img).toHaveAttribute("src", dish.image);
    else await expect(img).toHaveCount(0);
  }
});
