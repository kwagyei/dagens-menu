/** Shared setup for admin e2e tests: real invites from the CLI, a virtual passkey, a fresh IP. */
import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { msToStockholmMidnight } from "./clock";

/** The site the Worker under test serves (playwright.config.ts). */
export const SITE = process.env.E2E_SITE ?? "bistro";

/**
 * Today's date in Stockholm, as YYYY-MM-DD: the date the Worker means by "today". Never take the date from
 * an ISO timestamp, which gives the UTC date and is wrong between midnight and 01:00
 * or 02:00 Stockholm time (tests/e2e-hygiene.test.ts checks for it).
 */
export const stockholmToday = (): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());

/** A calendar date n days after an ISO date (n may be negative), computed at noon UTC so DST can't shift it. */
export const plusDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().split("T")[0];

/** A Stockholm date n days from today. */
export const daysAhead = (n: number): string => plusDays(stockholmToday(), n);

/**
 * For test.beforeEach in a spec whose test means "today" across more than one request: an
 * exception for today, a dish sold out today, the home badge. If Stockholm midnight could fall
 * inside the test (it is closer than the test's timeout), wait until it has passed and give
 * the test that time back. Otherwise the Worker's "today" changes halfway: the nightly edge run
 * starts at 23:30 Stockholm time in winter. The assertions are unchanged; each test just runs
 * wholly on one date, which may be either side of midnight.
 */
export async function clearOfMidnight(): Promise<void> {
  const info = test.info();
  const wait = msToStockholmMidnight(new Date());
  if (wait > info.timeout) return;
  info.setTimeout(info.timeout + wait + 2_000);
  await new Promise((resolve) => setTimeout(resolve, wait + 1_000));
}

let n = 0;
let ip = 0;

/**
 * A client address no other test in this run uses, for CF-Connecting-IP. Sign-in is limited to
 * 10 a minute per address, and every spec file runs in the same process, so specs that each
 * counted through 192.0.2.x handed out the same addresses and tripped each other's limit
 * depending on order. IPv6 documentation addresses never run out, and the process id keeps a
 * second local run from inheriting the first one's counts.
 */
export const freshIp = (): string => `2001:db8::${(process.pid & 0xffff).toString(16)}:${(++ip).toString(16)}`;

export function invite(email: string): string {
  const out = execFileSync("npm", ["run", "-s", "admin", "--", "invite", "--site", SITE, "--email", email, "--url", "http://localhost:8790"], {
    encoding: "utf-8",
  });
  const link = out.match(/http:\/\/localhost:8790\/admin\/invite\/#[A-Za-z0-9_-]{43}/)?.[0];
  if (!link) throw new Error(`no invite link in: ${out}`);
  // The token is in the fragment (review L8), so keep it: the path alone is just the page.
  const url = new URL(link);
  return url.pathname + url.hash;
}

/** Sign a fresh owner in with a virtual passkey; lands on the admin's menu page. */
export async function signedInOwner(page: Page): Promise<string> {
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const email = `menu-${Date.now().toString(36)}-${n++}@example.se`;
  await page.goto(invite(email));
  await page.getByRole("button", { name: "Skapa passkey" }).click();
  await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible();
  return email;
}

/** The admin's list entry for a dish, by its Swedish name. */
export const dishRow = (page: Page, name: string) => page.locator("li[id^='item-']").filter({ has: page.getByText(name, { exact: true }) });

/** Run SQL on the local D1 the Worker under test uses; for setting up what no admin page can yet. */
export function d1<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--json", "--command", sql], { encoding: "utf-8" });
  return JSON.parse(out)[0].results as T[];
}

let photoCount = 0;
/**
 * Upload a distinct photo through the real endpoint (two WebP sizes made by sharp, as the
 * browser pipeline would post them); returns its id and alt. The page must be signed in.
 */
export async function uploadPhoto(page: Page): Promise<{ id: string; sv: string; en: string }> {
  const { default: sharp } = await import("sharp");
  const n = ++photoCount;
  const tint = { r: 100 + ((Date.now() + n * 37) % 150), g: 60 + (n % 90), b: 200 };
  const parts = await Promise.all([400, 800].map((width) => sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width }).tint(tint).webp({ quality: 70 }).toBuffer()));
  const tag = `${Date.now().toString(36)}-${process.pid}-${n}`;
  const sv = `Testfoto ${tag}`;
  const en = `Test photo ${tag}`;
  await page.goto("/admin/photos/new/");
  const form = new FormData();
  form.set("csrf", await page.locator("input[name=csrf]").first().inputValue());
  form.set("alt_sv", sv);
  form.set("alt_en", en);
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  const res = await page.request.post("/admin/photos/new/", { multipart: form, maxRedirects: 0, headers: { Origin: "http://localhost:8790" } });
  expect(res.headers().location).toBe("/admin/photos/new/?done=added");
  const [row] = d1<{ id: string }>(`SELECT id FROM images WHERE site_id = '${SITE}' AND alt_sv = '${sv}'`);
  return { id: row.id, sv, en };
}
