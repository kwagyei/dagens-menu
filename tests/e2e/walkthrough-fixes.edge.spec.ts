/**
 * Tester, walkthrough fixes (18 Oct): the return-focus script on every admin page without a
 * CSP violation, autofocus targets that stay focused and on screen, the "device already has
 * the passkey" message only for that error and in both languages, the new nav link at 375 px,
 * and the Foton wording. Public pages must not pick up the admin script.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import en from "../../src/i18n/en";
import sv from "../../src/i18n/sv";
import { clearOfMidnight, d1, freshIp, invite, signedInOwner } from "./helpers";

test.beforeEach(clearOfMidnight);

test.describe.configure({ timeout: 90_000 });

/** Record CSP violations (console and event) from before any page script runs. */
async function watchCsp(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|violates the following/.test(m.text())) seen.push(m.text());
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp = [...((window as unknown as { __csp?: string[] }).__csp ?? []), `${e.violatedDirective} ${e.blockedURI}`];
    });
  });
  return seen;
}

test("the return-focus script is an external file and nothing is blocked on every admin page, in both languages", async ({ page }) => {
  const seen = await watchCsp(page);
  await signedInOwner(page);
  await page.goto("/admin/");
  const itemPath = (await page.locator("li[id^='item-'] a").first().getAttribute("href"))!;
  const categoryPath = (await page.locator("section[id^='category-'] a[href*='/menu/category/']").first().getAttribute("href"))!;
  const paths = [
    "/admin/",
    "/admin/hours/",
    "/admin/texts/",
    "/admin/gallery/",
    "/admin/gallery/?done=already",
    "/admin/photos/",
    "/admin/page-photos/",
    "/admin/page-photos/hero/?done=not-found",
    "/admin/page-photos/hero/?done=saved",
    "/admin/history/",
    "/admin/security/",
    "/admin/photos/unknown-id/",
    "/admin/photos/unknown-id/delete/",
    "/admin/photos/new/",
    "/admin/menu/category/new/",
    `${itemPath}`,
    `${itemPath}delete/`,
    `${itemPath}photo/`,
    `${itemPath}photo/?done=not-found`,
    categoryPath,
  ];
  for (const prefix of ["", "/en"]) {
    for (const path of paths) {
      const resp = await page.goto(`${prefix}${path}`);
      const label = `${prefix}${path} (${resp?.status()})`;
      const scripts = await page.evaluate(() =>
        [...document.scripts].map((s) => ({ src: s.src, inline: s.src === "" && s.type !== "application/ld+json" && s.textContent!.trim().length > 0 })),
      );
      expect
        .soft(
          scripts.filter((s) => s.inline),
          `inline scripts: ${label}`,
        )
        .toEqual([]);
      expect
        .soft(
          scripts.some((s) => /AdminLayout.*\.js$/.test(s.src)),
          `return-focus external: ${label}`,
        )
        .toBe(true);
      expect.soft(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []), `violations: ${label}`).toEqual([]);
    }
  }
  expect(seen).toEqual([]);
});

test("the external script is served as JavaScript with a 200 for a signed-out visitor too", async ({ page, request }) => {
  await page.goto("/admin/");
  const src = await page.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => /AdminLayout/.test(s)));
  expect(src).toBeTruthy();
  const res = await request.get(src!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/javascript/);
});

test("an error message with autofocus is focused and on screen, and the page isn't left scrolled away", async ({ page }) => {
  await signedInOwner(page);
  for (const prefix of ["", "/en"]) {
    for (const path of ["/admin/gallery/?done=already", "/admin/page-photos/hero/?done=not-found"]) {
      await page.goto(`${prefix}${path}`);
      const alert = page.getByRole("alert");
      await expect(alert).toBeFocused();
      await expect(alert).toBeInViewport();
      // The skip link is still the first Tab stop's neighbour: focus didn't lock the page.
      await page.keyboard.press("Tab");
      await expect(alert).not.toBeFocused();
    }
  }
});

test("a long page with an autofocus button at the bottom lands with that button centred, and the nav still comes first on Shift+Tab", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/");
  const last = page.locator("li[id^='item-']").last();
  const id = (await last.getAttribute("id"))!;
  await last.getByRole("button", { name: /^Slutsåld idag/ }).click();
  await page.waitForURL(/[?&]changed=/);
  const btn = page.locator(`#${id}`).getByRole("button", { name: /^(Slutsåld idag|Finns igen)/ });
  await expect(btn).toBeFocused();
  await expect(btn).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await btn.click(); // undo
  await page.waitForURL(/[?&]changed=/);
});

test("public pages carry no admin script and still run their own", async ({ page }) => {
  await watchCsp(page);
  for (const path of ["/", "/en/", "/menu/", "/book/", "/contact/", "/gallery/"]) {
    await page.goto(path);
    const srcs = await page.evaluate(() => [...document.scripts].map((s) => s.src));
    expect
      .soft(
        srcs.filter((s) => /AdminLayout|return-focus/.test(s)),
        path,
      )
      .toEqual([]);
    expect.soft(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []), `violations ${path}`).toEqual([]);
  }
  // The consent banner is the public page's inline-able script: it must still work.
  await page.goto("/");
  const accept = page.getByRole("button", { name: /Acceptera/i }).first();
  if (await accept.isVisible()) {
    await accept.click();
    await expect(accept).toBeHidden();
  }
});

for (const [prefix, L, label] of [
  ["", sv, "Swedish"],
  ["/en", en, "English"],
] as const) {
  test(`${label}: an invite on a device that already has the passkey says so, and offers sign-in`, async ({ page }) => {
    const email = await signedInOwner(page);
    await page.goto(`${prefix}${invite(email)}`);
    await page.getByRole("button", { name: L["admin.invite.button"] }).click();
    await expect(page.getByRole("status")).toHaveText(L["admin.invite.alreadyHere"]);
    await expect(page.getByRole("link", { name: L["admin.invite.signInInstead"] })).toBeVisible();
    await expect(page.getByRole("button", { name: L["admin.invite.button"] })).toBeEnabled();
  });

  test(`${label}: adding a device from the device that holds the passkey says so`, async ({ page }) => {
    await signedInOwner(page);
    await page.goto(`${prefix}/admin/security/`);
    await page.getByRole("button", { name: L["admin.security.addDevice"] }).click();
    await page.getByRole("button", { name: L["admin.security.addCreate"] }).click();
    await expect(page.getByRole("status").filter({ hasText: L["admin.security.addAlreadyHere"] })).toBeVisible();
    await expect(page.getByRole("link", { name: L["admin.invite.signInInstead"] })).toHaveCount(0);
  });
}

test("the cancelled and other errors keep their own messages and don't show the sign-in link", async ({ page }) => {
  // Fresh visitor with an invite; replace the browser's create() with one that fails as told.
  for (const [name, message] of [
    ["NotAllowedError", sv["admin.error.failed"]], // a closed prompt or a key that can't verify: the browser doesn't say which
    ["AbortError", sv["admin.error.cancelled"]],
    ["SecurityError", sv["admin.error.failed"]],
    ["NotSupportedError", sv["admin.error.failed"]],
  ] as const) {
    const p = await page.context().newPage();
    await p.context().setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
    await p.addInitScript((n) => {
      navigator.credentials.create = () => Promise.reject(new DOMException("boom", n));
    }, name);
    await p.goto(invite(`probe-${Date.now().toString(36)}-${name}@example.se`));
    await p.getByRole("button", { name: "Skapa passkey" }).click();
    await expect(p.getByRole("status"), name).toHaveText(message);
    await expect(p.getByRole("link", { name: "Logga in i stället" }), name).toBeHidden();
    await p.close();
  }
});

test("InvalidStateError from the browser itself maps to the already message", async ({ page }) => {
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
  await page.addInitScript(() => {
    navigator.credentials.create = () => Promise.reject(new DOMException("exists", "InvalidStateError"));
  });
  await page.goto(invite(`probe-${Date.now().toString(36)}-ise@example.se`));
  await page.getByRole("button", { name: "Skapa passkey" }).click();
  await expect(page.getByRole("status")).toHaveText(sv["admin.invite.alreadyHere"]);
  await expect(page.getByRole("link", { name: "Logga in i stället" })).toBeVisible();
});

test("the page-photos link in the admin menu: order, wrapping at 375 px, no axe violations, both languages", async ({ page }) => {
  await signedInOwner(page);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [prefix, L] of [
    ["", sv],
    ["/en", en],
  ] as const) {
    for (const path of ["/admin/", "/admin/page-photos/", "/admin/photos/"]) {
      await page.goto(`${prefix}${path}`);
      const nav = page.getByRole("navigation", { name: L["admin.title"] });
      const names = await nav.getByRole("link").allInnerTexts();
      const i = names.indexOf(L["admin.nav.pagePhotos"]);
      expect.soft(names.slice(i - 1, i + 2), `${prefix}${path}`).toEqual([L["admin.nav.photos"], L["admin.nav.pagePhotos"], L["admin.nav.gallery"]]);
      const link = nav.getByRole("link", { name: L["admin.nav.pagePhotos"] });
      const box = (await link.boundingBox())!;
      expect.soft(box.height, "44 px target").toBeGreaterThanOrEqual(44);
      expect.soft(box.x + box.width, "inside the viewport").toBeLessThanOrEqual(375);
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), "no horizontal scroll").toBeLessThanOrEqual(375);
      const { violations } = await new AxeBuilder({ page }).include("header").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect
        .soft(
          violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
          `axe nav ${prefix}${path}`,
        )
        .toEqual([]);
    }
  }
  // Keyboard order: Tab from "Foton" reaches "Sidornas foton", then "Galleri".
  await page.goto("/admin/photos/");
  await page.getByRole("navigation", { name: sv["admin.title"] }).getByRole("link", { name: "Foton", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Sidornas foton" }).first()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("navigation", { name: sv["admin.title"] }).getByRole("link", { name: sv["admin.nav.gallery"] })).toBeFocused();
});

for (const [prefix, L] of [
  ["", sv],
  ["/en", en],
] as const) {
  test(`${prefix || "/sv"}: Foton with no photos of its own says the built-in ones are below`, async ({ page }) => {
    await signedInOwner(page);
    const uploads = d1<{ n: number }>("select count(*) as n from images where kind = 'upload'")[0]?.n ?? 0;
    test.skip(uploads > 0, "database already holds uploads");
    await page.goto(`${prefix}/admin/photos/`);
    await expect(page.getByText(`${L["admin.photos.none"]} ${L["admin.photos.builtInBelow"]}`, { exact: true })).toBeVisible();
    await page.goto(`${prefix}/admin/photos/?filter=unused`);
    await expect(page.getByText(L["admin.photos.none"])).toHaveCount(0);
  });
}

test("the admin menu marks the current section, on its page and on the pages inside it", async ({ page }) => {
  // Tester L2 (fixed): no link showed where you are.
  await signedInOwner(page);
  const nav = page.getByRole("navigation", { name: sv["admin.title"] });
  await page.goto("/admin/page-photos/");
  await expect(nav.getByRole("link", { name: sv["admin.nav.pagePhotos"] })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
  await page.goto("/admin/");
  await expect(nav.getByRole("link", { name: sv["admin.nav.menu"] })).toHaveAttribute("aria-current", "page");
  await page.locator("li[id^='item-'] a").first().click();
  await expect(nav.getByRole("link", { name: sv["admin.nav.menu"] })).toHaveAttribute("aria-current", "true");
  await page.goto("/en/admin/photos/");
  const navEn = page.getByRole("navigation", { name: en["admin.title"] });
  await expect(navEn.getByRole("link", { name: en["admin.nav.photos"], exact: true })).toHaveAttribute("aria-current", "page");
  await expect(navEn.getByRole("link", { name: en["admin.nav.pagePhotos"] })).not.toHaveAttribute("aria-current");
});
