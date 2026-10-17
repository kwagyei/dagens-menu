/**
 * The public site's basics on a phone (UI review PR A and PR B): the menu button is reachable
 * and works without JavaScript, each page has one booking button, a site with nothing to
 * consent to asks for no consent, each highlight shows its own dish, and the menu's category
 * bar stays on one row at the top.
 */
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

type Menu = { categories: Array<{ id: string; items: Array<{ id: string; name: { sv: string }; image?: string }> }> };
const site = process.env.E2E_SITE ?? "bistro";
const menu: Menu = JSON.parse(readFileSync(new URL(`../../sites/${site}/content/menu.json`, import.meta.url), "utf-8"));
const pages = JSON.parse(readFileSync(new URL(`../../sites/${site}/content/pages.json`, import.meta.url), "utf-8"));
const theme = JSON.parse(readFileSync(new URL(`../../sites/${site}/theme.json`, import.meta.url), "utf-8"));

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

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the menu button still opens the navigation", async ({ page }) => {
    await page.goto("/menu/");
    await page.locator("#menu-toggle").click();
    await expect(page.locator("#nav-menu").getByRole("link", { name: "Kontakt" })).toBeVisible();
  });
});

test("the home page puts Meny, Om oss and Kontakt on the hero, and every page in the nav on a wide screen", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Huvudnavigering" });
  for (const name of ["Meny", "Om oss", "Kontakt"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.locator("#menu-toggle")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const name of ["Meny", "Om oss", "Galleri", "Kontakt", "English"]) await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(page.locator("#menu-toggle")).toBeHidden();
});

test("each page has one booking button, in the page and not in the header, at each width", async ({ page }) => {
  for (const path of ["/", "/menu/", "/about/", "/gallery/", "/contact/"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      // The one exception, chosen by Kwabena from the reference: the modern home on a wide screen
      // has Boka bord in the nav above the photo as well as the oval on the name.
      const expected = theme.style === "modern" && path === "/" && width === 1440 ? 2 : 1;
      await expect(page.locator("main a[href='/book/']:visible"), `${path} at ${width}px`).toHaveCount(expected);
      await expect(page.locator("header a[href='/book/']:visible"), `${path} at ${width}px`).toHaveCount(0);
    }
  }
});

test("the site's look comes from theme.json", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-style", theme.style);
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
    // The dish's card, by its caption; its photo is that dish's own image, in WebP sizes (M6.9).
    const img = page.locator("main li").filter({ hasText: dish.name.sv }).first().locator("img");
    if (dish.image) {
      const name = dish.image.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
      await expect(img).toHaveAttribute("srcset", new RegExp(`/v/${name}-\\d+\\.webp \\d+w`));
    } else await expect(img).toHaveCount(0);
  }
});

test("the menu has a visible Meny heading and one category bar row that stays at the top", async ({ page }) => {
  await page.goto("/menu/");
  await expect(page.getByRole("heading", { name: "Meny", level: 1 })).toBeVisible();
  const bar = page.getByRole("navigation", { name: "Menykategorier" });
  const links = bar.getByRole("link");
  await expect(links).toHaveCount(menu.categories.filter((c) => c.items.length > 0).length);
  const tops = await links.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(new Set(tops).size, "category links wrap onto a second row").toBe(1);

  await page.mouse.wheel(0, 2500);
  await expect.poll(async () => Math.round((await bar.boundingBox())!.y)).toBe(0);
});

test("the footer shows today's hours, and the whole week behind Alla öppettider", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByText(/^Idag: /)).toBeVisible();
  await expect(footer.getByText("Måndag")).toBeHidden();
  await footer.getByText("Alla öppettider").click();
  await expect(footer.getByText("Måndag")).toBeVisible();
});

test("social links are icons with a name a screen reader can say", async ({ page }) => {
  await page.goto("/");
  const instagram = page.getByRole("contentinfo").getByRole("link", { name: /Instagram/ });
  await expect(instagram).toBeVisible();
  await expect(instagram).toHaveText("");
});

test("on a wide screen the modern home puts Meny and Boka bord at the far right above the photo, the rest at the left", async ({ page }) => {
  test.skip(theme.style !== "modern", "only the modern look has this hero");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Huvudnavigering" });
  const box = async (name: string) => (await nav.getByRole("link", { name, exact: true }).boundingBox())!;
  const photo = (await page.locator(".hero-dag__img").boundingBox())!;
  const [menu, book, about, english] = [await box("Meny"), await box("Boka bord"), await box("Om oss"), await box("English")];
  for (const b of [menu, book, about, english]) expect(b.y + b.height, "the nav sits above the photo").toBeLessThanOrEqual(photo.y);
  expect(about.x, "Om oss starts at the left").toBeLessThan(photo.x + photo.width * 0.25);
  expect(english.x, "the left group stays left").toBeLessThan(photo.x + photo.width / 2);
  expect(menu.x, "Meny is in the right group").toBeGreaterThan(photo.x + photo.width / 2);
  expect(book.x, "Boka bord is last").toBeGreaterThan(menu.x);
  // The name is pulled up onto the photo.
  const word = (await page.locator(".hero-dag__word svg:visible").boundingBox())!;
  expect(word.y, "the name overlaps the photo").toBeLessThan(photo.y + photo.height);
});
