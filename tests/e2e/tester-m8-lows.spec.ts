/**
 * Tester, review Lows (17 Oct): edges of L1 (expired-session posts), L2 (the limited paths) and
 * L8 (the invite token in the URL fragment) that the gate's security.spec.ts doesn't sweep.
 * Every test uses its own client address and its own invite; nothing depends on order.
 */
import { expect, type Page, test } from "@playwright/test";
import { freshIp, invite } from "./helpers";

const BASE = "http://localhost:8790";
let n = 0;
const freshEmail = () => `tester-lows-${Date.now().toString(36)}-${n++}@example.se`;
const tokenOf = (link: string) => link.split("#").pop()!;

async function asNewClient(page: Page) {
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
}

async function verifyingAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
}

test.describe("L1: posts without a session", () => {
  test("every remaining admin form (menu, categories, history) answers 303 to sign-in with the expired note", async ({ request }) => {
    const headers = { Origin: BASE, "CF-Connecting-IP": freshIp() };
    for (const [path, home] of [
      ["/admin/history/", "/admin/"],
      ["/admin/menu/category/new/", "/admin/"],
      ["/admin/menu/item/nosuchitem01/", "/admin/"],
      ["/admin/menu/item/nosuchitem01/delete/", "/admin/"],
      ["/admin/menu/category/nosuchcateg1/", "/admin/"],
      ["/en/admin/menu/category/nosuchcateg1/delete/", "/en/admin/"],
      ["/en/admin/security/", "/en/admin/"],
      ["/en/admin/hours/", "/en/admin/"],
    ]) {
      const res = await request.post(path, { form: { csrf: "x", action: "save" }, headers, maxRedirects: 0 });
      expect(res.status(), path).toBe(303);
      expect(res.headers().location, path).toBe(`${home}?done=expired`);
    }
  });

  test("the passkey script replaces the expired note once the owner tries to sign in", async ({ page }) => {
    await asNewClient(page);
    // A failed sign-in, without needing a passkey: the options call fails.
    await page.route("**/admin/api/login-options", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
    await page.goto("/admin/?done=expired");
    const status = page.locator("#status");
    await expect(status).toContainText("Din inloggning hade gått ut");
    await page.getByRole("button", { name: "Logga in med passkey" }).click();
    await expect(status).not.toContainText("Din inloggning hade gått ut");
    await expect(status).not.toBeEmpty();
  });

  test("an unknown done= value shows nothing in the status element", async ({ page }) => {
    await asNewClient(page);
    await page.goto("/admin/?done=%3Cscript%3Ealert(1)%3C/script%3E");
    await expect(page.locator("#status")).toBeEmpty();
  });
});

test.describe("L8: the invite page reads its token from the fragment", () => {
  for (const [name, fragment] of [
    ["empty", ""],
    ["percent-encoded", "%41".repeat(43)],
    ["one character too many", "A".repeat(44)],
    ["one character short", "A".repeat(42)],
    ["very long", "A".repeat(20_000)],
    ["markup", "<img src=x onerror=alert(1)>"],
    ["a second fragment", `${"A".repeat(43)}#${"B".repeat(43)}`],
  ] as const) {
    test(`a malformed fragment (${name}) shows the invalid note, no button, and asks the server nothing`, async ({ page }) => {
      await asNewClient(page);
      const checks: string[] = [];
      page.on("request", (r) => r.url().includes("/admin/api/") && checks.push(r.url()));
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`/admin/invite/#${fragment}`);
      await expect(page.getByText("Den här länken har redan använts eller har gått ut")).toBeVisible();
      await expect(page.getByRole("button", { name: "Skapa passkey" })).toBeHidden();
      expect(checks).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("a well-formed but unknown token shows the invalid note after asking the server", async ({ page }) => {
    await asNewClient(page);
    await page.goto(`/admin/invite/#${"Z".repeat(43)}`);
    await expect(page.getByText("Den här länken har redan använts eller har gått ut")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skapa passkey" })).toBeHidden();
  });

  test("without JavaScript the page says JavaScript is needed, shows no button and no verdict", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
    const page = await context.newPage();
    const email = freshEmail();
    await page.goto(`${BASE}${invite(email)}`);
    await expect(page.getByText("Inloggning med passkey kräver JavaScript")).toBeVisible();
    await expect(page.getByRole("button", { name: "Skapa passkey" })).toBeHidden();
    await expect(page.getByText("Den här länken har redan använts")).toBeHidden();
    await expect(page.getByText(email)).toHaveCount(0); // the email needs the check, which needs JS
    await context.close();
  });

  test("the English invite page checks the same fragment and enrols", async ({ page }) => {
    await asNewClient(page);
    await verifyingAuthenticator(page);
    const email = freshEmail();
    const link = invite(email);
    await page.goto(`/en${link}`);
    await expect(page.getByText(email)).toBeVisible();
    await page.getByRole("button", { name: "Create passkey" }).click();
    await expect(page).toHaveURL(/\/en\/admin\/$/);
  });

  test("the English invite page says an unknown link is invalid in English", async ({ page }) => {
    await asNewClient(page);
    await page.goto(`/en/admin/invite/#${"Y".repeat(43)}`);
    await expect(page.getByText("This link has already been used or has expired")).toBeVisible();
  });

  test("opening another invite link in the same tab checks the new token", async ({ page }) => {
    await asNewClient(page);
    await page.goto(`/admin/invite/#${"X".repeat(43)}`);
    await expect(page.getByText("Den här länken har redan använts")).toBeVisible();
    const email = freshEmail();
    const link = invite(email);
    await page.evaluate((hash) => (window.location.hash = hash), tokenOf(link));
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Den här länken har redan använts")).toBeHidden();
    await expect(page.getByRole("button", { name: "Skapa passkey" })).toBeVisible();
  });
});

test.describe("L2 / ADR-011 §6: the limited paths can't be reached around the limiter", () => {
  test("a doubled slash before api/ is limited like the plain path", async ({ request }) => {
    const headers = { Origin: BASE, "CF-Connecting-IP": freshIp() };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await request.post("/admin//api/invite-check", { data: { token: "C".repeat(43) }, headers })).status());
    }
    expect(statuses).toContain(429);
  });

  test("a doubled slash before a ceremony endpoint is limited too", async ({ request }) => {
    const headers = { Origin: BASE, "CF-Connecting-IP": freshIp() };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await request.post("/admin//api/login-options", { data: {}, headers })).status());
    expect(statuses).toContain(429);
  });
});
