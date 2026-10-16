/** Shared setup for admin e2e tests: real invites from the CLI, a virtual passkey, a fresh IP. */
import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

let n = 0;
let ip = 0;

export function invite(email: string): string {
  const out = execFileSync("npm", ["run", "-s", "admin", "--", "invite", "--site", "bistro", "--email", email, "--url", "http://localhost:8790"], {
    encoding: "utf-8",
  });
  const link = out.match(/http:\/\/localhost:8790\/admin\/invite\/[A-Za-z0-9_-]{43}/)?.[0];
  if (!link) throw new Error(`no invite link in: ${out}`);
  return new URL(link).pathname;
}

/** Sign a fresh owner in with a virtual passkey; lands on the admin's menu page. */
export async function signedInOwner(page: Page): Promise<string> {
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": `192.0.2.${(++ip % 250) + 1}` });
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
