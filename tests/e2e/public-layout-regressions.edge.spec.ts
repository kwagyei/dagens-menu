/**
 * Tester regression checks for UI PR B (public redesign): no horizontal overflow on any public
 * route at four widths, every image has alt text and loads, tap targets are at least 44 px, the
 * footer shows today's hours and hides the week until opened, and the modern "Se menyn" sticker
 * stops turning under reduced motion.
 */
import { expect, test } from "@playwright/test";

const base = ["/", "/menu/", "/book/", "/about/", "/gallery/", "/contact/", "/privacy/"];
const routes = [...base, ...base.map((p) => `/en${p}`), "/no-such-page/"];

test("no public route scrolls sideways at 320, 390, 768 or 1440 px", async ({ page }) => {
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of routes) {
      await page.goto(path);
      const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
      expect(scroll, `${path} at ${width}px`).toBeLessThanOrEqual(client);
    }
  }
});

test("every image has alt text, loads, and no /images or /fonts request fails", async ({ page }) => {
  const failed: string[] = [];
  page.on("response", (r) => {
    if (/\/(images|fonts)\//.test(r.url()) && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  for (const path of ["/", "/menu/", "/gallery/", "/en/"]) {
    await page.goto(path, { waitUntil: "networkidle" });
    const broken = await page.evaluate(() =>
      [...document.querySelectorAll("img")].filter((i) => !i.hasAttribute("alt") || i.naturalWidth === 0).map((i) => i.getAttribute("src")),
    );
    expect(broken, path).toEqual([]);
  }
  expect(failed).toEqual([]);
});

test("links, buttons and summaries are at least 44 px square on a phone and on a desktop", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/menu/", "/contact/"]) {
      await page.goto(path);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll("header a, header button, header summary, main a, main button, main summary, footer a, footer button, footer summary")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height || getComputedStyle(e).visibility === "hidden") return false;
            if (e.tagName === "A" && e.closest("p")) return false; // inline text links
            return r.width < 44 || r.height < 44;
          })
          .map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
      );
      expect(small, `${path} at ${width}px`).toEqual([]);
    }
  }
});

test("the footer shows today's hours and keeps the week closed until opened", async ({ page }) => {
  await page.goto("/menu/");
  const footer = page.locator("footer");
  // Today's hours, or "Stängt" on the site's closed weekday (the bistro on Sunday, Chez Abena on Monday).
  await expect(footer).toContainText(/Idag: (\d\d:\d\d–\d\d:\d\d|Stängt)/);
  const week = footer.locator("details").first();
  await expect(week.locator("table, ul, dl").first()).toBeHidden();
  await week.locator("summary").click();
  await expect(week.locator("table, ul, dl").first()).toBeVisible();
  for (const link of await footer.locator("a[aria-label]").all()) await expect(link).toHaveAttribute("aria-label", /Instagram|Facebook|TikTok|X|YouTube/);
});

test("the menu's category bar stays on one row, sticks, and jumps to its section", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/menu/");
  const links = page.locator("a[href^='#cat-']");
  const tops = await links.evaluateAll((l) => l.map((a) => Math.round(a.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  // The page scrolls smoothly, so wait for it to settle rather than reading mid-scroll.
  await page.evaluate(() => window.scrollTo(0, 1500));
  await expect.poll(() => links.first().evaluate((a) => a.getBoundingClientRect().top)).toBeLessThan(20);
  const last = (await links.last().getAttribute("href"))!;
  await links.last().click();
  await expect(page).toHaveURL(new RegExp(`${last}$`));
  await expect.poll(() => page.evaluate((id) => document.querySelector(id)!.getBoundingClientRect().top, last)).toBeLessThan(140);
});

test.describe("the modern look's sticker", () => {
  test.skip(process.env.E2E_SITE !== "westafrican", "the sticker belongs to the modern look");
  const turning = (page: import("@playwright/test").Page) =>
    page.evaluate(() => [...document.querySelectorAll("a.star")].filter((e) => getComputedStyle(e).animationName !== "none").length);

  test("the Se menyn sticker is still when asked, and turns otherwise", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    expect(await turning(page)).toBe(0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await turning(page)).toBeGreaterThan(0);
  });

  test("the sticker's text is the dark ink on orange (4.7:1), not the page green (3.3:1)", async ({ page }) => {
    await page.goto("/");
    // Chez Abena's theme secondary, #13301d.
    const sticker = await page.evaluate(() => getComputedStyle(document.querySelector("a.star")!).color);
    expect(sticker).toBe("rgb(19, 48, 29)");
  });
});
