/**
 * The admin's sign-in, end to end (plan M4.2, M4.3, M4.4, M4.6), in Chromium with a virtual
 * passkey authenticator. Invites come from the real operator CLI.
 */
import { execFileSync } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { freshIp } from "./helpers";

function invite(email: string): string {
  const out = execFileSync("npm", ["run", "-s", "admin", "--", "invite", "--site", "bistro", "--email", email, "--url", "http://localhost:8790"], { encoding: "utf-8" });
  const link = out.match(/http:\/\/localhost:8790\/admin\/invite\/#[A-Za-z0-9_-]{43}/)?.[0];
  if (!link) throw new Error(`no invite link in: ${out}`);
  const url = new URL(link);
  return url.pathname + url.hash; // the token is in the fragment (review L8)
}

function revoke(email: string): void {
  execFileSync("npm", ["run", "-s", "admin", "--", "revoke", "--site", "bistro", "--email", email], { encoding: "utf-8" });
}

/** A phone's built-in passkey store, approving every prompt. */
async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return {
    id: authenticatorId,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
    addAnother: async () =>
      (
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
        })
      ).authenticatorId,
    remove: (authenticatorId: string) => cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }),
  };
}

const sessionCookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === "__Host-dm_admin");
let n = 0;
const freshEmail = () => `e2e-${Date.now().toString(36)}-${n++}@example.se`;

// Every test is its own visitor: the admin's rate limit (10 a minute per IP) would otherwise
// count the whole suite as one client. One test checks the limit itself.
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
});

async function enrol(page: Page, email = freshEmail()) {
  const auth = await authenticator(page);
  const link = invite(email);
  await page.goto(link);
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: "Skapa passkey" }).click();
  await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
  return { auth, link, email };
}

test("an invited owner creates a passkey and is signed in", async ({ page, context }) => {
  const { email, auth } = await enrol(page);
  await expect(page.getByText(`Inloggad som ${email}`)).toBeVisible();
  expect(await auth.credentials()).toHaveLength(1);
  const cookie = await sessionCookie(context);
  expect(cookie).toMatchObject({ path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
  expect(cookie?.domain).toBe("localhost");
  expect(cookie!.expires * 1000 - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
});

test("an invite works only once", async ({ page, request }) => {
  const { link } = await enrol(page);
  await page.context().clearCookies();
  await page.goto(link);
  await expect(page.getByText("Den här länken har redan använts eller har gått ut")).toBeVisible();
  await expect(page.getByRole("button", { name: "Skapa passkey" })).toBeHidden();
  const token = link.split("#").pop();
  const check = await request.post("/admin/api/invite-check", { data: { token }, headers: { Origin: "http://localhost:8790" } });
  expect(check.status()).toBe(410);
  const api = await request.post("/admin/api/enrol-options", { data: { token }, headers: { Origin: "http://localhost:8790" } });
  expect(api.status()).toBe(410);
});

test("signing out and back in with the passkey", async ({ page, context }) => {
  await enrol(page);
  await page.getByRole("button", { name: "Logga ut" }).click();
  await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
  expect(await sessionCookie(context)).toBeUndefined();
  await page.getByRole("button", { name: "Logga in med passkey" }).click();
  await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
});

test("a revoked owner's session ends at once", async ({ page }) => {
  const { email } = await enrol(page);
  revoke(email);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
  // ...and the passkey no longer signs in.
  await page.getByRole("button", { name: "Logga in med passkey" }).click();
  await expect(page.getByRole("status")).toContainText("Det gick inte");
});

test("security: add a second device, remove the first (which signs it out), sign out everywhere", async ({ page }) => {
  const { auth } = await enrol(page);
  await page.getByRole("link", { name: "Säkerhet" }).click();
  await expect(page.getByText("Din enda passkey kan inte tas bort")).toBeVisible();

  // First confirm with this phone's passkey (security review M2), then a second phone: Chrome
  // allows one built-in authenticator at a time, so swap devices before creating.
  await page.getByRole("button", { name: "Lägg till en enhet" }).click();
  await expect(page.getByRole("status")).toHaveText("Bekräftat. Skapa nu passkeyn på den nya enheten.");
  await auth.remove(auth.id);
  await auth.addAnother();
  await page.getByRole("button", { name: "Skapa den nya passkeyn" }).click();
  await expect(page.getByText("Den nya passkeyn är sparad.")).toBeVisible();
  await expect(page.getByText(/^Passkey 2$/)).toBeVisible();

  // Removing the first device's passkey ends the sign-ins made with it, this one included.
  await expect(page.getByText(/^Passkey 1 · du är inloggad med den här$/)).toBeVisible();
  await page.getByRole("button", { name: "Ta bort" }).first().click();
  await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
  await page.getByRole("button", { name: "Logga in med passkey" }).click();
  await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Säkerhet" }).click();
  await expect(page.getByText(/^Passkey 2$/)).toHaveCount(0);
  await expect(page.getByText("Din enda passkey kan inte tas bort")).toBeVisible();

  await page.getByRole("button", { name: "Logga ut överallt" }).click();
  await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
  // The remaining passkey (on the second device) still signs in. That device is on another
  // network: this test's 11th ceremony call in one minute would hit the per-IP limit of 10.
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
  await page.getByRole("button", { name: "Logga in med passkey" }).click();
  await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
});

test("the admin works in English at /en/admin/", async ({ page }) => {
  await page.goto("/en/admin/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
});

test("cross-site posts are refused, form and fetch alike", async ({ request }) => {
  const evil = { Origin: "https://evil.example" };
  expect((await request.post("/admin/logout", { form: { csrf: "x" }, headers: evil })).status()).toBe(403);
  expect((await request.post("/admin/api/login-options", { data: {}, headers: evil })).status()).toBe(403);
  expect((await request.post("/admin/api/login-options", { data: {} })).status()).toBe(403); // no Origin at all
});

test("without JavaScript the sign-in page says why", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("http://localhost:8790/admin/");
  await expect(page.getByText("Inloggning med passkey kräver JavaScript")).toBeVisible();
  await context.close();
});

test("the 11th sign-in attempt in a minute is refused, and public pages are unaffected", async ({ request }) => {
  const headers = { Origin: "http://localhost:8790", "CF-Connecting-IP": "203.0.113.200" };
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await request.post("/admin/api/login-options", { data: {}, headers })).status());
  expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
  expect(statuses[10]).toBe(429);
  expect((await request.get("/menu/", { headers })).status()).toBe(200);
});

test("public pages carry no admin cookie and stay cacheable", async ({ page }) => {
  await enrol(page);
  const res = await page.goto("/menu/");
  expect(res?.headers()["cache-control"]).toBe("no-cache");
  expect(res?.headers()["set-cookie"]).toBeUndefined();
});
