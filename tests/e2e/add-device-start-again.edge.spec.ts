/**
 * Adding a device when the server refuses the new passkey (review M1, 18 Oct). The device has
 * already made the passkey by then, and the registration options are spent, so the page must
 * go back to step one instead of offering a create button that can only fail again.
 */
import { expect, test } from "@playwright/test";
import en from "../../src/i18n/en";
import sv from "../../src/i18n/sv";
import { asNewDevice, clearOfMidnight, d1, signedInOwner } from "./helpers";

test.beforeEach(clearOfMidnight);

test.describe.configure({ timeout: 90_000 });

const passkeysOf = (email: string) => d1<{ n: number }>(`SELECT count(*) AS n FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.email = '${email}'`)[0].n;

for (const [prefix, L, label] of [
  ["", sv, "Swedish"],
  ["/en", en, "English"],
] as const) {
  test(`${label}: a refused new passkey sends the page back to step one, and nothing is stored`, async ({ page, context }) => {
    const email = await signedInOwner(page);
    await page.goto(`${prefix}/admin/security/`);
    const add = page.getByRole("button", { name: L["admin.security.addDevice"] });
    const create = page.getByRole("button", { name: L["admin.security.addCreate"] });
    await add.click();
    await expect(create).toBeVisible();
    // The 5 minutes run out: the browser drops the confirmation's cookie.
    await context.clearCookies({ name: "__Host-dm_challenge" });
    await asNewDevice(page);
    await create.click();
    await expect(page.getByRole("status").filter({ hasText: L["admin.security.addStartAgain"] })).toBeVisible();
    await expect(create).toBeHidden();
    await expect(add).toBeEnabled();
    await expect(add).toBeFocused();
    expect(passkeysOf(email)).toBe(1);
  });
}

test("a cancelled create prompt keeps the create button: its options are still good", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/security/");
  await page.getByRole("button", { name: sv["admin.security.addDevice"] }).click();
  const create = page.getByRole("button", { name: sv["admin.security.addCreate"] });
  await expect(create).toBeVisible();
  await page.evaluate(() => {
    navigator.credentials.create = () => Promise.reject(new DOMException("closed", "AbortError"));
  });
  await create.click();
  await expect(page.getByRole("status").filter({ hasText: sv["admin.error.cancelled"] })).toBeVisible();
  await expect(create).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(page.getByRole("button", { name: sv["admin.security.addDevice"] })).toBeHidden();
});
