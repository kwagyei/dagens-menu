/**
 * Booking and map embeds load after consent and not before (H2), and a booking provider only
 * ever runs in a sandboxed frame (security review M1). Neither demo uses an embed, so the spec
 * gives the bistro a TheFork booking frame and a Google map for its run, and puts them back
 * afterwards. The provider hosts are stubbed with page routes: no real third-party request is
 * made, but each stubbed request still had to pass the page's CSP to reach the route.
 */
import { type BrowserContext, expect, test } from "@playwright/test";
import { SANDBOX } from "../../src/booking/embed";
import { listPresets } from "../../src/booking/presets";
import { d1, freshIp, SITE } from "./helpers";

const BOOKING = "https://widget.thefork.com";
const MAP = "https://www.google.com";
const EMBED = `<iframe src="${BOOKING}/e2e" title="Boka bord"></iframe>`;

/** Stub both providers; returns the URLs the page asked them for. */
async function stubProviders(context: BrowserContext): Promise<string[]> {
  const requested: string[] = [];
  await context.setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
  await context.route(`${BOOKING}/**`, (route) => {
    requested.push(route.request().url());
    // The frame tries to reach the page around it; the sandbox and the origin boundary stop it.
    return route.fulfill({
      contentType: "text/html",
      body: `<p>Stub booking widget</p><script>try { parent.document.title = "reached"; } catch { document.body.append("parent blocked"); }</script>`,
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

  test("the booking frame loads only after the visitor accepts, sandboxed and cut off from the page", async ({ page, context }) => {
    const requested = await stubProviders(context);
    const response = await page.goto("/book/");
    const policy = response?.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("script-src 'self' 'unsafe-inline';");
    expect(policy).toContain(`frame-src 'self' ${BOOKING} ${MAP};`);
    await expect(page.getByRole("button", { name: "Ladda bokning" })).toBeVisible();
    expect(requested).toEqual([]);

    await page.getByRole("dialog").getByRole("button", { name: "Acceptera" }).click();
    const frame = page.frameLocator('iframe[title="Boka bord"]');
    await expect(frame.getByText("Stub booking widget")).toBeVisible();
    await expect(frame.getByText("parent blocked")).toBeVisible();
    await expect(page.locator('iframe[title="Boka bord"]')).toHaveAttribute("sandbox", SANDBOX);
    expect(await page.title()).not.toBe("reached");
    expect(requested).toEqual([`${BOOKING}/e2e`]);
  });

  test("an earlier acceptance loads the booking frame on arrival", async ({ page, context, baseURL }) => {
    const requested = await stubProviders(context);
    await context.addCookies([{ name: "consent", value: "accepted", url: baseURL! }]);
    await page.goto("/en/book/");
    await expect(page.frameLocator('iframe[title="Boka bord"]').getByText("Stub booking widget")).toBeVisible();
    expect(requested).toEqual([`${BOOKING}/e2e`]);
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

// Every embed preset, framed from its own host: the CSP built from the preset lets the browser
// frame it, and only after consent.
test.describe("each booking preset loads after consent", () => {
  test.afterAll(() => {
    d1(`UPDATE settings SET booking_mode = 'none', booking_embed_code = NULL WHERE site_id = '${SITE}'`);
  });

  for (const [id, preset] of Object.entries(listPresets()).filter(([, p]) => p.mode === "embed")) {
    test(`${id}: the browser reaches ${preset.origins.join(", ")} after consent, not before`, async ({ page, context }) => {
      const code = preset.embedPattern?.replace(/RESTAURANT_(ID|UUID)/g, "e2e") ?? `<iframe src="${preset.origins[0]}/book/e2e"></iframe>`;
      d1(`UPDATE settings SET booking_mode = 'embed', booking_embed_code = '${code.replaceAll("'", "''")}' WHERE site_id = '${SITE}'`);
      await context.setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
      const reached: string[] = [];
      for (const origin of preset.origins) {
        await context.route(`${origin}/**`, (route) => {
          reached.push(new URL(route.request().url()).origin);
          return route.fulfill({ contentType: "text/html", body: "<p>Stub provider</p>" });
        });
      }
      const response = await page.goto("/book/");
      for (const origin of preset.origins) expect(response?.headers()["content-security-policy"]).toContain(origin);
      await expect(page.getByRole("button", { name: "Ladda bokning" })).toBeVisible();
      expect(reached).toEqual([]);

      await page.getByRole("dialog").getByRole("button", { name: "Acceptera" }).click();
      await expect.poll(() => [...new Set(reached)]).toEqual([preset.origins[0]]);
    });
  }
});
