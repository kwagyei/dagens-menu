/**
 * Tester, M4 (ADR-011 §6, answer 7): attacks on the admin's sign-in, against the same built
 * bistro Worker as admin.spec.ts.
 *
 * The westafrican isolation block needs a second Worker and runs only when WESTAFRICAN_URL is
 * set (see the tester report for how it was started); the missing-secret block starts its own
 * wrangler dev on port 8791 without SESSION_SECRET.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";

const BASE = "http://localhost:8790";
const SAME = { Origin: BASE };

function cli(args: string[]): string {
  return execFileSync("npm", ["run", "-s", "admin", "--", ...args], { encoding: "utf-8" });
}
function invite(email: string, site = "bistro"): string {
  const out = cli(["invite", "--site", site, "--email", email, "--url", BASE]);
  const link = out.match(/\/admin\/invite\/[A-Za-z0-9_-]{43}/)?.[0];
  if (!link) throw new Error(`no invite link in: ${out}`);
  return link;
}
function d1<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--json", "--command", sql], {
    encoding: "utf-8",
  });
  return JSON.parse(out)[0].results as T[];
}
const passkeyIds = (email: string) =>
  d1<{ id: string }>(`SELECT p.id FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.email = '${email}' ORDER BY p.created_at, p.id`).map((r) => r.id);

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const add = async () =>
    (
      await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      })
    ).authenticatorId;
  const id = await add();
  return { id, add, remove: (authenticatorId: string) => cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }) };
}

const sessionCookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === "__Host-dm_admin");
let n = 0;
const freshEmail = () => `tester-${Date.now().toString(36)}-${n++}@example.se`;

let ip = 0;
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "CF-Connecting-IP": `192.0.2.${++ip}` });
});

async function enrol(page: Page, email = freshEmail(), base = BASE) {
  const auth = await authenticator(page);
  const link = invite(email);
  await page.goto(`${base}${link}`);
  await page.getByRole("button", { name: "Skapa passkey" }).click();
  await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
  return { auth, link, email };
}

/** The csrf token from a signed-in admin page. */
async function csrfOf(page: Page, path = "/admin/security/") {
  await page.goto(path);
  return (await page.locator('input[name="csrf"]').first().getAttribute("value"))!;
}

/** Give the signed-in owner a second passkey (Chrome holds one built-in authenticator at a time). */
async function addSecondDevice(page: Page, auth: Awaited<ReturnType<typeof authenticator>>) {
  await page.goto("/admin/security/");
  await auth.remove(auth.id);
  await auth.add();
  await page.getByRole("button", { name: "Lägg till en enhet" }).click();
  await expect(page.getByText("Den nya passkeyn är sparad.")).toBeVisible();
}

const cookieHeader = async (context: BrowserContext) => `__Host-dm_admin=${(await sessionCookie(context))!.value}`;
const isSignedIn = async (request: APIRequestContext, cookie: string, base = BASE) =>
  (await (await request.get(`${base}/admin/`, { headers: { Cookie: cookie } })).text()).includes("Inloggad som");

// ---------------------------------------------------------------------------------------

test.describe("sessions", () => {
  test("a planted session cookie is replaced at sign-in, and a signed-out token is dead server-side", async ({ page, context, request }) => {
    await context.addCookies([{ name: "__Host-dm_admin", value: "A".repeat(43), domain: "localhost", path: "/", secure: true, httpOnly: true, sameSite: "Lax" }]);
    await enrol(page);
    const cookie = await cookieHeader(context);
    expect(cookie).not.toContain("A".repeat(43));
    expect(await isSignedIn(request, cookie)).toBe(true);
    await page.getByRole("button", { name: "Logga ut" }).click();
    await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
    expect(await isSignedIn(request, cookie)).toBe(false);
  });

  test("sign out everywhere ends a session held by another browser", async ({ page, context, request }) => {
    await enrol(page);
    // "The other browser": keep this session's cookie, then forget it locally (no sign-out).
    const other = await cookieHeader(context);
    await context.clearCookies();
    await page.goto("/admin/");
    await page.getByRole("button", { name: "Logga in med passkey" }).click();
    await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
    expect(await cookieHeader(context)).not.toBe(other);
    expect(await isSignedIn(request, other)).toBe(true);
    await page.goto("/admin/security/");
    await page.getByRole("button", { name: "Logga ut överallt" }).click();
    await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
    expect(await isSignedIn(request, other)).toBe(false);
  });
});

test.describe("CSRF and redirects", () => {
  test("logout never redirects off the admin", async ({ request }) => {
    for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example", "/admin/../../evil", "/en/admin/x"]) {
      const res = await request.post("/admin/logout", { form: { next }, headers: SAME, maxRedirects: 0 });
      expect(res.status()).toBe(303);
      expect(res.headers().location).toBe("/admin/");
    }
  });

  test("security page actions need the site's Origin and the session's form token", async ({ page, context, request }) => {
    await enrol(page);
    const cookie = await cookieHeader(context);
    const csrf = await csrfOf(page);
    const post = (headers: Record<string, string>, form: Record<string, string>) =>
      request.post("/admin/security/", { form, headers: { Cookie: cookie, ...headers }, maxRedirects: 0 });

    expect((await post({ Origin: "https://evil.example" }, { csrf, action: "sign-out-everywhere" })).status()).toBe(403);
    expect((await post({}, { csrf, action: "sign-out-everywhere" })).status()).toBe(403);
    const wrongToken = await post(SAME, { csrf: "forged", action: "sign-out-everywhere" });
    expect(wrongToken.status()).toBe(303);
    expect(wrongToken.headers().location).toContain("done=expired");
    const noToken = await post(SAME, { action: "sign-out-everywhere" });
    expect(noToken.headers().location).toContain("done=expired");
    expect(await isSignedIn(request, cookie)).toBe(true);
  });

  test("a form token from one session doesn't work with another", async ({ page, context, request, browser }) => {
    await enrol(page);
    const csrfA = await csrfOf(page);
    const other = await browser.newContext({ extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.250" } });
    const otherPage = await other.newPage();
    await enrol(otherPage, freshEmail());
    const cookieB = await cookieHeader(other);
    const res = await request.post("/admin/security/", { form: { csrf: csrfA, action: "sign-out-everywhere" }, headers: { ...SAME, Cookie: cookieB }, maxRedirects: 0 });
    expect(res.headers().location).toContain("done=expired");
    expect(await isSignedIn(request, cookieB)).toBe(true);
    await other.close();
    void context;
  });
});

test.describe("security page", () => {
  test("the last passkey can't be removed, even by a hand-made post", async ({ page, context, request }) => {
    const { email } = await enrol(page);
    const [only] = passkeyIds(email);
    const csrf = await csrfOf(page);
    await request.post("/admin/security/", { form: { csrf, action: "remove", id: only }, headers: { ...SAME, Cookie: await cookieHeader(context) } });
    expect(passkeyIds(email)).toEqual([only]);
  });

  test("an owner can't remove another owner's passkey by posting its id", async ({ page, context, request, browser }) => {
    const victimContext = await browser.newContext({ extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.251" } });
    const victim = await enrol(await victimContext.newPage());
    const [victimKey] = passkeyIds(victim.email);
    await victimContext.close();

    const { auth, email } = await enrol(page);
    await addSecondDevice(page, auth);
    expect(passkeyIds(email)).toHaveLength(2);
    const csrf = await csrfOf(page);
    await request.post("/admin/security/", { form: { csrf, action: "remove", id: victimKey }, headers: { ...SAME, Cookie: await cookieHeader(context) } });
    expect(passkeyIds(victim.email)).toEqual([victimKey]);
    expect(passkeyIds(email)).toHaveLength(2);
  });

  test("two removes at once never leave the owner with no passkey", async ({ page, context, request }) => {
    const { auth, email } = await enrol(page);
    await addSecondDevice(page, auth);
    const ids = passkeyIds(email);
    expect(ids).toHaveLength(2);
    const csrf = await csrfOf(page);
    const headers = { ...SAME, Cookie: await cookieHeader(context) };
    await Promise.all(ids.map((id) => request.post("/admin/security/", { form: { csrf, action: "remove", id }, headers, maxRedirects: 0 })));
    expect(passkeyIds(email).length).toBeGreaterThanOrEqual(1);
  });
});

test.describe("headers and paths", () => {
  test("admin pages are no-store with a CSP that still lets the bundled script run", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => /Content Security Policy/i.test(m.text()) && violations.push(m.text()));
    for (const path of ["/admin/", "/en/admin/", `/admin/invite/${"A".repeat(43)}`]) {
      const res = (await page.goto(path))!;
      const h = res.headers();
      expect(h["cache-control"], path).toBe("no-store");
      expect(h["content-security-policy"], path).toContain("frame-ancestors 'none'");
      expect(h["referrer-policy"], path).toBe("strict-origin-when-cross-origin");
      expect(h["set-cookie"], path).toBeUndefined();
    }
    await page.goto("/admin/");
    await expect(page.getByRole("button", { name: "Logga in med passkey" })).toBeVisible(); // script ran
    for (const src of await page.locator("script[src]").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).src))) {
      expect(new URL(src).origin).toBe(BASE);
    }
    expect(violations).toEqual([]);
  });

  test("the invite page loads nothing from another origin (the token is in its URL)", async ({ page }) => {
    const link = invite(freshEmail());
    const foreign: string[] = [];
    page.on("request", (r) => new URL(r.url()).origin !== BASE && foreign.push(r.url()));
    await page.goto(link);
    const links = await page.locator("a[href]").evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href));
    expect(links.every((href) => new URL(href).origin === BASE)).toBe(true);
    expect(foreign).toEqual([]);
  });

  test("a percent-encoded /admin path is still treated as the admin (headers, rate limit)", async ({ request }) => {
    const token = "A".repeat(43);
    const res = await request.get(`/%61dmin/invite/${token}`);
    // Today this renders the invite page as a *public* page: no-cache, no rate limit.
    expect(res.headers()["cache-control"]).toBe("no-store");
    const headers = { "CF-Connecting-IP": "203.0.113.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await request.get(`/%61dmin/invite/${token}`, { headers })).status());
    expect(statuses[10]).toBe(429);
  });

  test("a percent-encoded admin endpoint can't be used to skip the guard", async ({ request }) => {
    // It is the admin endpoint, so it gets the admin's guard: cross-site is refused...
    const crossSite = await request.post("/%61dmin/api/login-options", { data: {}, headers: { Origin: "https://evil.example" } });
    expect(crossSite.status()).toBe(403);
    // ...and a same-site call behaves exactly like /admin/api/login-options, admin headers included.
    const sameSite = await request.post("/%61dmin/api/login-options", { data: {}, headers: SAME });
    expect(sameSite.status()).toBe(200);
    expect(sameSite.headers()["cache-control"]).toBe("no-store");
  });
});

test.describe("rate limiting", () => {
  test("opening invite links is limited too, and a 429 says nothing about the client", async ({ request }) => {
    const headers = { "CF-Connecting-IP": "203.0.113.201" };
    const statuses: number[] = [];
    let last = "";
    for (let i = 0; i < 11; i++) {
      const res = await request.get(`/en/admin/invite/${"B".repeat(43)}`, { headers });
      statuses.push(res.status());
      last = await res.text();
    }
    expect(statuses.slice(0, 10).every((s) => s === 410)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect(last).not.toContain("203.0.113.201");
    expect(last).not.toMatch(/bistro|limit|10/i);
    // The sign-in page itself (GET) is not limited, nor is another visitor.
    expect((await request.get("/admin/", { headers })).status()).toBe(200);
    expect((await request.get(`/admin/invite/${"B".repeat(43)}`, { headers: { "CF-Connecting-IP": "203.0.113.202" } })).status()).toBe(410);
  });
});

test.describe("English and no-JS paths", () => {
  test("an English invite enrols and lands on the English admin; sign-out stays in English", async ({ page }) => {
    await authenticator(page);
    const link = invite(freshEmail());
    await page.goto(`/en${link}`);
    await page.getByRole("button", { name: /passkey/i }).click();
    await expect(page).toHaveURL(/\/en\/admin\/$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("link", { name: "Security" }).click();
    await expect(page).toHaveURL(/\/en\/admin\/security\/$/);
    await page.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(page).toHaveURL(/\/en\/admin\/$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("without JavaScript: the invite page explains, and sign-out and sign-out-everywhere still work", async ({ page, context, browser }) => {
    await enrol(page);
    const cookies = await context.cookies();
    const noJs = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.252" } });
    await noJs.addCookies(cookies);
    const p = await noJs.newPage();
    await p.goto(`${BASE}${invite(freshEmail())}`);
    await expect(p.getByText("kräver JavaScript")).toBeVisible();
    await p.goto(`${BASE}/admin/security/`);
    await expect(p.getByRole("heading", { name: "Säkerhet" })).toBeVisible();
    await expect(p.getByText("kräver JavaScript")).toBeVisible(); // add a device needs JS
    await p.getByRole("button", { name: "Logga ut överallt" }).click();
    await expect(p.getByRole("heading", { name: "Logga in" })).toBeVisible();
    await noJs.close();
  });
});

// ---------------------------------------------------------------------------------------

test.describe("without SESSION_SECRET", () => {
  const PORT = 8791;
  let server: ChildProcess;
  test.beforeAll(async () => {
    test.setTimeout(90_000);
    server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "9331", "--persist-to", ".wrangler/state"], { stdio: "ignore", detached: true });
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`http://localhost:${PORT}/`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("wrangler dev without a secret did not start");
  });
  test.afterAll(() => {
    if (server?.pid) process.kill(-server.pid);
  });

  test("the passkey endpoints answer 503", async ({ request }) => {
    const res = await request.post(`http://localhost:${PORT}/admin/api/login-options`, { data: {}, headers: { Origin: `http://localhost:${PORT}` } });
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: "not-configured" });
  });

  test("a signed-in admin page answers 503, not a crash", async ({ page, context, request }) => {
    await enrol(page); // on the configured Worker, same local database
    const cookie = await cookieHeader(context);
    for (const path of ["/admin/", "/admin/security/"]) {
      const res = await request.get(`http://localhost:${PORT}${path}`, { headers: { Cookie: cookie }, maxRedirects: 0 });
      expect(res.status(), path).toBe(503);
    }
  });
});

// ---------------------------------------------------------------------------------------

const WEST = process.env.WESTAFRICAN_URL;
test.describe("per-site isolation against a westafrican Worker (answer 7)", () => {
  test.skip(!WEST, "set WESTAFRICAN_URL to a westafrican build on the same local D1");

  test("a bistro session, invite and passkey get nothing on westafrican", async ({ page, context, request }) => {
    const { link, email } = await enrol(page);
    const cookie = await cookieHeader(context);
    // Same person is a westafrican member too: the bistro passkey still mustn't work there.
    invite(email, "westafrican");

    // Session: the bistro cookie (host-only, so a browser on another port sends it) is not a session there.
    expect(await isSignedIn(request, cookie, WEST)).toBe(false);
    const sec = await request.get(`${WEST}/admin/security/`, { headers: { Cookie: cookie }, maxRedirects: 0 });
    expect(sec.status()).toBe(303);

    // Invite: a bistro invite (even an unused one) is not valid there.
    const unused = invite(freshEmail());
    expect((await request.get(`${WEST}${unused}`)).status()).toBe(410);
    expect((await request.get(`${WEST}${link}`)).status()).toBe(410);
    const opts = await request.post(`${WEST}/admin/api/enrol-options`, { data: { token: unused.split("/").pop() }, headers: { Origin: WEST! } });
    expect(opts.status()).toBe(410);

    // Passkey: both Workers are on "localhost", so the browser offers the bistro passkey; the server must refuse it.
    await page.goto(`${WEST}/admin/`);
    await page.getByRole("button", { name: "Logga in med passkey" }).click();
    await expect(page.getByRole("status")).toContainText("Det gick inte");
    await page.goto(`${WEST}/admin/`);
    await expect(page.getByRole("heading", { name: "Logga in" })).toBeVisible();
  });
});
