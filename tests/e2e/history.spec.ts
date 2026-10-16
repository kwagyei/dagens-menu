/**
 * History and export end to end (plan M5.6): a change shows in the history with who made
 * it, and the exported file restores the site with the seed CLI (the M5.6 acceptance
 * criterion: the export re-imports).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { dishRow, signedInOwner } from "./helpers";

test("a change shows in the history, newest first, with who made it", async ({ page }) => {
  const email = await signedInOwner(page);
  const first = page.locator("li[id^='item-']").first();
  const name = (await first.locator("p.font-semibold").textContent())!;
  await dishRow(page, name).getByRole("button", { name: "Slutsåld idag" }).click();
  await page.getByRole("link", { name: "Historik" }).first().click();
  await expect(page.getByRole("heading", { name: "Historik", level: 1 })).toBeVisible();
  const newest = page.locator("ol > li").first();
  await expect(newest).toContainText("Rätt ändrad");
  await expect(newest).toContainText(name);
  await expect(newest).toContainText(email);
  await page.goto("/admin/");
  await dishRow(page, name).getByRole("button", { name: "Finns igen" }).click();
});

test("the export downloads as a file and restores the site with the seed CLI", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/history/");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Exportera mitt innehåll" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^bistro-content-\d{4}-\d{2}-\d{2}\.json$/);
  const path = join(mkdtempSync(join(tmpdir(), "export-")), file.suggestedFilename());
  await file.saveAs(path);

  const response = await page.request.get("/admin/export", { maxRedirects: 0 });
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="bistro-content-/);
  const exported = await response.json();
  expect(exported).toMatchObject({ format: "dagens-menu-export", formatVersion: 1, site: "bistro" });

  // Change the site after exporting, then restore: the change is gone.
  const tagline = exported.content.pages.home.tagline.sv as string;
  await page.goto("/admin/texts/");
  await page.locator("form#pages").getByLabel("Startsidans rubrik på svenska").fill("Ändrad efter exporten");
  await page.getByRole("button", { name: "Spara texterna" }).click();
  await page.goto("/");
  await expect(page.locator("main")).toContainText("Ändrad efter exporten");

  execFileSync("npm", ["run", "-s", "seed", "--", "--site", "bistro", "--from", path, "--reset"], { encoding: "utf-8" });
  await page.goto("/");
  await expect(page.locator("main")).toContainText(tagline);
  await expect(page.locator("main")).not.toContainText("Ändrad efter exporten");
});

test("the seed CLI refuses another site's export", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "export-")), "other.json");
  writeFileSync(path, JSON.stringify({ format: "dagens-menu-export", formatVersion: 1, site: "westafrican", content: {} }));
  let output = "";
  try {
    execFileSync("npm", ["run", "-s", "seed", "--", "--site", "bistro", "--from", path, "--reset"], { encoding: "utf-8", stdio: "pipe" });
  } catch (error) {
    output = String((error as { stderr?: string }).stderr);
  }
  expect(output).toContain('the file is for site "westafrican", not "bistro"');
});

test("signed out, the export sends you to sign in", async ({ page }) => {
  const response = await page.request.get("/admin/export", { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  expect(response.headers().location).toBe("/admin/");
});
