/**
 * the Swedish history's translated summaries are still escaped, and the
 * purge note reads in Swedish on /admin/ and as stored on /en/admin/.
 */
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

function d1(sql: string): void {
  execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--json", "--command", sql], { encoding: "utf-8" });
}
const audit = (summary: string, entity: string) =>
  `INSERT INTO audit_log (site_id, user_id, entity, action, summary) VALUES ('bistro', NULL, '${entity}', 'delete', '${summary.replaceAll("'", "''")}')`;

test("a translated summary with markup in the owner's text is escaped", async ({ page }) => {
  await signedInOwner(page);
  d1(audit(`<img src=x onerror="document.title='pwned'"><i>it</i>: deleted`, "menu_item"));
  await page.goto("/admin/history/");
  const first = page.locator("ol > li").first();
  await expect(first).toContainText(`<i>it</i>: borttagen`);
  expect(await page.locator("ol > li img, ol > li i").count()).toBe(0);
  expect(await page.title()).not.toBe("pwned");
});

test("the purge note reads in Swedish on /admin/ and in English on /en/admin/", async ({ page }) => {
  await signedInOwner(page);
  d1(audit("history older than 180 days removed: 3 entries", "audit_log"));
  await page.goto("/admin/history/");
  await expect(page.locator("ol > li").first()).toContainText("historik äldre än 180 dagar borttagen: 3 poster");
  await expect(page.locator("ol > li").first()).toContainText("Historiken");
  await page.goto("/en/admin/history/");
  await expect(page.locator("ol > li").first()).toContainText("history older than 180 days removed: 3 entries");
});
