/** Shared setup for admin e2e tests: real invites from the CLI, a virtual passkey, a fresh IP. */
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

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
