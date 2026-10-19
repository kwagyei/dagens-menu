/**
 * Admin by keyboard (plan M5.7): the first Tab reaches a skip link that lands on the page,
 * every control shows where focus is, and the daily task, marking a dish sold out, works
 * without a mouse.
 */
import { expect, type Page, test } from "@playwright/test";
import { clearOfMidnight, signedInOwner } from "./helpers";

// Sold out is for today only: the toggle is read back after the redirect. Midnight must not fall inside a test.
test.beforeEach(clearOfMidnight);

/** Whether the focused element draws a visible focus indicator. */
const focusVisible = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const s = getComputedStyle(el);
    return (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2) || s.boxShadow !== "none";
  });

test("the first Tab is a skip link that moves focus past the navigation", async ({ page }) => {
  await signedInOwner(page);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Hoppa till innehållet" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.locator("#admin-main")).toBeFocused();
  await page.keyboard.press("Tab");
  // The next stop is inside the page, not the navigation.
  expect(await page.evaluate(() => document.activeElement?.closest("#admin-main") !== null)).toBe(true);
});

test("every control on the main admin pages shows where focus is", async ({ page }) => {
  await signedInOwner(page);
  for (const path of ["/admin/", "/admin/hours/", "/admin/texts/", "/admin/history/"]) {
    await page.goto(path);
    const stops = await page.locator("a[href], button:not([disabled]), input:not([type=hidden]), textarea, select").count();
    for (let i = 0; i < Math.min(stops, 40); i++) {
      await page.keyboard.press("Tab");
      const what = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80));
      expect(await focusVisible(page), `${path}, Tab ${i + 1}: ${what}`).toBe(true);
    }
  }
});

test("marking a dish sold out and back works with the keyboard alone", async ({ page }) => {
  await signedInOwner(page);
  const button = page.locator("li[id^='item-']").first().getByRole("button", { name: "Slutsåld idag" });
  await button.focus();
  await page.keyboard.press("Enter");
  const row = page.locator("li[id^='item-']").first();
  await expect(row.getByRole("button", { name: "Finns igen" })).toBeVisible();
  await row.getByRole("button", { name: "Finns igen" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("li[id^='item-']").first().getByRole("button", { name: "Slutsåld idag" })).toBeVisible();
});

test("after a move, the dish's button has focus and is on screen, and the admin's script isn't blocked", async ({ page }) => {
  // Walkthrough 18 Oct: iPhone Safari ignores autofocus, so the page landed at the top after
  // every move. src/admin/return-focus.ts focuses the control and scrolls it into view when
  // the browser didn't (its logic is unit-tested). Chromium can't be made to ignore autofocus
  // the way iOS does, so this checks the outcome, and that the script arrives as a file: the
  // admin's CSP allows no inline script, and an inlined copy was silently blocked.
  const blocked: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy/.test(m.text())) blocked.push(m.text());
  });
  await signedInOwner(page);
  await page.goto("/admin/");
  const last = page.locator("li[id^='item-']").last();
  const id = (await last.getAttribute("id"))!;
  await last.getByRole("button", { name: /^Flytta upp/ }).click();
  await page.waitForURL(/[?&]changed=/);
  // The same direction's button, or the other one if the dish reached the top (then "up" is disabled).
  const moved = page
    .locator(`#${id}`)
    .getByRole("button", { name: /^Flytta (upp|ned)/ })
    .and(page.locator(":focus"));
  await expect(moved).toHaveCount(1);
  await expect(moved).toBeInViewport();
  expect(await page.evaluate(() => [...document.scripts].some((s) => /AdminLayout/.test(s.src)))).toBe(true);
  await page
    .locator(`#${id}`)
    .getByRole("button", { name: /^Flytta ned/ })
    .click(); // undo
  await page.waitForURL(/[?&]changed=/);
  expect(blocked).toEqual([]);
});

test("the page photos have their own link in the admin menu", async ({ page }) => {
  await signedInOwner(page);
  await page.getByRole("navigation").getByRole("link", { name: "Sidornas foton" }).click();
  await expect(page.getByRole("heading", { name: "Sidornas foton" })).toBeVisible();
});
