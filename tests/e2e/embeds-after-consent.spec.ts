/**
 * Booking and map embeds load after consent and not before (H2). Neither demo uses an embed,
 * so the spec gives the bistro a WaiterAid booking script and a Google map for its run, and
 * puts them back afterwards. The provider hosts are stubbed with page routes: no real
 * third-party request is made, but each stubbed request still had to pass the page's CSP to
 * reach the route, and the stub script proves the browser ran it.
 */
import { type BrowserContext, expect, test } from "@playwright/test";
import { d1, freshIp, SITE } from "./helpers";

const BOOKING = "https://app.waiteraid.com";
const MAP = "https://www.google.com";
const EMBED = `<script src="${BOOKING}/widget/e2e.js"></script>`;

/** Stub both providers; returns the URLs the page asked them for. */
async function stubProviders(context: BrowserContext): Promise<string[]> {
  const requested: string[] = [];
  await context.setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
  await context.route(`${BOOKING}/**`, (route) => {
    requested.push(route.request().url());
    return route.fulfill({
      contentType: "text/javascript",
      body: `document.getElementById("booking-content").append(Object.assign(document.createElement("p"), { textContent: "Stub booking widget ran" }));`,
    });
  });
  await context.route(`${MAP}/**`, (route) => {
    requested.push(route.request().url());
    return route.fulfill({ contentType: "text/html", body: "<p>Stub map</p>" });
  });
  return requested;
}

test.describe("third-party embeds", () => {
  test.beforeAll(() => {
    d1(`UPDATE settings SET booking_mode = 'embed', booking_embed_code = '${EMBED}', map_embed_url = '${MAP}/maps/embed?pb=e2e' WHERE site_id = '${SITE}'`);
  });
  test.afterAll(() => {
    d1(`UPDATE settings SET booking_mode = 'none', booking_embed_code = NULL, map_embed_url = '' WHERE site_id = '${SITE}'`);
  });

  test("the booking script loads and runs only after the visitor accepts", async ({ page, context }) => {
    const requested = await stubProviders(context);
    const response = await page.goto("/book/");
    expect(response?.headers()["content-security-policy"]).toContain(`script-src 'self' 'unsafe-inline' ${BOOKING};`);
    await expect(page.getByRole("button", { name: "Ladda bokning" })).toBeVisible();
    expect(requested).toEqual([]);

    await page.getByRole("dialog").getByRole("button", { name: "Acceptera" }).click();
    await expect(page.getByText("Stub booking widget ran")).toBeVisible();
    expect(requested).toEqual([`${BOOKING}/widget/e2e.js`]);
  });

  test("an earlier acceptance loads the booking script on arrival", async ({ page, context, baseURL }) => {
    const requested = await stubProviders(context);
    await context.addCookies([{ name: "consent", value: "accepted", url: baseURL! }]);
    await page.goto("/en/book/");
    await expect(page.getByText("Stub booking widget ran")).toBeVisible();
    expect(requested).toEqual([`${BOOKING}/widget/e2e.js`]);
  });

  test("declining loads nothing from either provider", async ({ page, context }) => {
    const requested = await stubProviders(context);
    await page.goto("/contact/");
    await page.getByRole("dialog").getByRole("button", { name: "Avböj" }).click();
    await page.goto("/book/");
    await page.getByRole("button", { name: "Ladda bokning" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(requested).toEqual([]);
  });

  test("the map frame loads after the visitor accepts from its button", async ({ page, context }) => {
    const requested = await stubProviders(context);
    const response = await page.goto("/contact/");
    expect(response?.headers()["content-security-policy"]).toContain(`frame-src 'self' ${BOOKING} ${MAP};`);
    await page.getByRole("dialog").getByRole("button", { name: "Avböj" }).click();
    await page.getByRole("button", { name: "Ladda karta" }).click();
    expect(requested).toEqual([]);

    await page.getByRole("dialog").getByRole("button", { name: "Acceptera" }).click();
    await expect(page.frameLocator('iframe[title="Map"]').getByText("Stub map")).toBeVisible();
    expect(requested).toEqual([`${MAP}/maps/embed?pb=e2e`]);
  });
});
