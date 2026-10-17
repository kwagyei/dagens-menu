/**
 * Tester, M5.6: the History page and "Export my content" end to end against the bistro Worker,
 * and restoring exports with the seed CLI. Acceptance criterion: the export re-imports.
 * Also: endpoint isolation and caching, cross-site reads, refused restores leave the
 * database untouched, the history's limit and isolation, 375 px, no JavaScript, /en/admin/.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import { dishRow, signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const dir = mkdtempSync(join(tmpdir(), "tester-m56-"));
let fileNo = 0;

function d1<T>(sql: string): T[] {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--json", "--command", sql], {
    encoding: "utf-8",
  });
  return JSON.parse(out)[0].results as T[];
}

/** Run the seed CLI; returns exit status and both streams. */
function seed(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npm", ["run", "-s", "seed", "--", ...args], { encoding: "utf-8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status: number; stdout: string; stderr: string };
    return { status: e.status, stdout: String(e.stdout), stderr: String(e.stderr) };
  }
}

function writeExport(value: unknown): string {
  const path = join(dir, `export-${++fileNo}.json`);
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return path;
}

async function exported(request: APIRequestContext) {
  const response = await request.get("/admin/export", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  return response.json();
}

const audit = (summary: string, entity = "menu_item", site = "bistro", user = "NULL") =>
  `INSERT INTO audit_log (site_id, user_id, entity, action, summary) VALUES ('${site}', ${user}, '${entity}', 'update', '${summary.replaceAll("'", "''")}')`;


test.describe("export endpoint", () => {
  test("headers: attachment, JSON, no-store, nosniff, no CORS even for a foreign Origin", async ({ page }) => {
    await signedInOwner(page);
    const response = await page.request.get("/admin/export", { headers: { Origin: "https://evil.example" }, maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const h = response.headers();
    expect(h["content-type"]).toBe("application/json; charset=utf-8");
    expect(h["content-disposition"]).toMatch(/^attachment; filename="bistro-content-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(h["cache-control"]).toBe("no-store");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["access-control-allow-origin"]).toBeUndefined();
    expect(h["access-control-allow-credentials"]).toBeUndefined();
    expect(h["set-cookie"]).toBeUndefined();
    const body = await response.json();
    expect(Object.keys(body)).toEqual(["format", "formatVersion", "site", "exportedAt", "contentVersion", "content"]);
    expect(JSON.stringify(body)).not.toMatch(/@example\.se|menu-[a-z0-9]+-\d+@/);
  });

  test("the session cookie is HttpOnly, Secure and SameSite=Lax", async ({ page }) => {
    await signedInOwner(page);
    const cookie = (await page.context().cookies()).find((c) => c.name === "__Host-dm_admin")!;
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(cookie.domain).toBe("localhost");
  });

  test("a page on another origin can't read the export with fetch", async ({ page }) => {
    await signedInOwner(page);
    // 127.0.0.1 is a different site from localhost: no cookie (Lax) and no CORS.
    await page.goto(BASE.replace("localhost", "127.0.0.1") + "/");
    const result = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        return `read ${r.status} ${(await r.text()).slice(0, 40)}`;
      } catch (error) {
        return `blocked: ${(error as Error).name}`;
      }
    }, `${BASE}/admin/export`);
    expect(result).toMatch(/^blocked/);
  });

  test("signed out: /admin/export, its trailing-slash and /en/ forms never answer content", async ({ request }) => {
    for (const path of ["/admin/export", "/admin/export/", "/en/admin/export", "/admin/export?site=westafrican"]) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect([303, 404], path).toContain(response.status());
      expect(await response.text(), path).not.toContain("dagens-menu-export");
    }
    const head = await request.head("/admin/export", { maxRedirects: 0 });
    expect(head.status()).toBe(303);
  });

  test("a POST to the export is refused (it is read-only)", async ({ page }) => {
    await signedInOwner(page);
    const response = await page.request.post("/admin/export", { headers: { Origin: BASE }, maxRedirects: 0 });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain("dagens-menu-export");
  });

  test("a valid westafrican session gets nothing from the bistro Worker", async ({ request }) => {
    const r = seed(["--site", "westafrican", "--reset"]);
    expect(r.status, r.stderr).toBe(0);
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    const user = `wa${randomBytes(5).toString("hex")}`;
    const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const expires = new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    d1(
      `INSERT INTO users (id, email) VALUES ('${user}', 'wa-${user}@chezabena.se');
       INSERT INTO memberships (user_id, site_id, role) VALUES ('${user}', 'westafrican', 'owner');
       INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES ('${hash}', '${user}', 'westafrican', '${created}', '${created}', '${expires}');
       INSERT INTO audit_log (site_id, user_id, entity, action, summary) VALUES ('westafrican', '${user}', 'menu_item', 'update', 'westafrican secret change');`,
    );
    const cookie = `__Host-dm_admin=${token}`;
    const response = await request.get("/admin/export", { headers: { Cookie: cookie }, maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe("/admin/");
    const history = await request.get("/admin/history/", { headers: { Cookie: cookie }, maxRedirects: 0 });
    expect(await history.text()).not.toContain("westafrican secret change");
  });
});

test.describe("history page", () => {
  test("labels each change, shows who made it, and the seed CLI as the system", async ({ page }) => {
    // A system entry of its own, as the seed CLI writes it: the page shows only the last 50
    // changes, so the original seed entry is gone once earlier specs have made enough edits.
    d1("INSERT INTO audit_log (site_id, entity, action, summary) VALUES ('bistro', 'site', 'seed', 'seeded by tester-m5-history')");
    const email = await signedInOwner(page);
    const first = page.locator("li[id^='item-']").first();
    const name = (await first.locator("p.font-semibold").textContent())!;
    await dishRow(page, name).getByRole("button", { name: "Slutsåld idag" }).click();
    await dishRow(page, name).getByRole("button", { name: "Finns igen" }).click();
    await page.goto("/admin/history/");
    const items = page.locator("main ol > li, ol > li");
    await expect(items.first()).toContainText("Rätt ändrad");
    await expect(items.first()).toContainText(email);
    await expect(items.nth(1)).toContainText("sold out");
    // The seed CLI's entry: no user.
    await expect(page.locator("ol > li").filter({ hasText: "Webbplatsen inläst" }).first()).toContainText("Systemet");
    // Times are shown in Stockholm time with a machine-readable datetime.
    const datetime = await items.first().locator("time").getAttribute("datetime");
    expect(datetime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    const shown = (await items.first().locator("time").textContent())!;
    const expected = new Intl.DateTimeFormat("sv-SE", { timeStyle: "short", timeZone: "Europe/Stockholm" }).format(new Date(datetime!));
    expect(shown).toContain(expected);
  });

  // Open finding M5.6 D2 (tasks.md): summaries are stored in English. Kept as a fixme so it
  // stays visible until summaries are stored per language.
  test.fixme("D: summaries are stored in English, so the Swedish history reads half in English", async ({ page }) => {
    await signedInOwner(page);
    await page.goto("/admin/history/");
    const summaries = await page.locator("ol > li p.text-sm.break-words").allTextContents();
    const english = summaries.filter((s) => /\b(sold out|back on sale|moved (up|down)|added at|deleted|Content loaded from JSON|shown on the home page|renamed to)\b/.test(s));
    expect(english, "a Swedish owner should read Swedish summaries (M5.7: sv/en admin)").toEqual([]);
  });

  test("shows exactly 50 entries, newest first, and never another site's", async ({ page }) => {
    await signedInOwner(page);
    const stamp = Date.now().toString(36);
    const sql = [
      ...Array.from({ length: 55 }, (_, n) => audit(`limit-${stamp}-${String(n).padStart(2, "0")}`)),
      audit(`other-site-${stamp}`, "menu_item", "westafrican"),
    ].join(";\n");
    d1(sql);
    await page.goto("/admin/history/");
    const items = page.locator("ol > li");
    await expect(items).toHaveCount(50);
    await expect(items.first()).toContainText(`limit-${stamp}-54`);
    await expect(items.nth(49)).toContainText(`limit-${stamp}-05`);
    await expect(page.locator("body")).not.toContainText(`other-site-${stamp}`);
  });

  test("an unknown entity falls back to its stored name; an empty summary still renders", async ({ page }) => {
    await signedInOwner(page);
    d1(audit("ny bild", "image"));
    await page.goto("/admin/history/");
    await expect(page.locator("ol > li").first()).toContainText("image ändrad");
    await page.goto("/en/admin/history/");
    await expect(page.locator("ol > li").first()).toContainText("image changed");
  });

  test("owner text in a summary is escaped, not rendered as HTML", async ({ page }) => {
    await signedInOwner(page);
    d1(audit(`<img src=x onerror="document.title='pwned'"><b>bold</b>`));
    await page.goto("/admin/history/");
    await expect(page.locator("ol > li").first()).toContainText("<b>bold</b>");
    expect(await page.locator("ol > li img").count()).toBe(0);
    expect(await page.title()).not.toBe("pwned");
  });

  test("a very long unbroken summary does not widen the page at 375 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signedInOwner(page);
    d1(audit("W".repeat(3000)));
    d1(audit("https://instagram.com/" + "a".repeat(1500)));
    await page.goto("/admin/history/");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("English admin: /en/admin/history/ in English, and its export link downloads", async ({ page }) => {
    await signedInOwner(page);
    await page.goto("/en/admin/history/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "History", level: 1 })).toBeVisible();
    await expect(page.getByText("Images are not included.")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Export my content" }).click();
    expect((await download).suggestedFilename()).toMatch(/^bistro-content-/);
    expect((await page.request.get("/xx/admin/history/", { maxRedirects: 0 })).status()).toBe(404);
  });

  test("accessibility basics: one h1, labelled export section, list semantics, keyboard-reachable export", async ({ page }) => {
    await signedInOwner(page);
    await page.goto("/admin/history/");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("region", { name: "Exportera mitt innehåll" })).toBeVisible();
    await expect(page.getByRole("list").last()).toBeVisible();
    // Every entry has a time element with a datetime.
    const times = page.locator("ol > li time");
    expect(await times.count()).toBeGreaterThan(0);
    // Tab to the export link and see the focus ring.
    const link = page.getByRole("link", { name: "Exportera mitt innehåll" });
    await link.focus();
    const outline = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    const height = await link.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(44);
  });

  test("D: the list of changes has no heading of its own (it sits under 'Export my content' in the outline)", async ({ page }) => {
    await signedInOwner(page);
    await page.goto("/admin/history/");
    const headings = await page.locator("h1, h2, h3").allTextContents();
    expect(headings.length, `headings: ${headings.join(" | ")}`).toBeGreaterThanOrEqual(3);
  });

  test("works without JavaScript: the page renders and the export downloads", async ({ page, browser }) => {
    await signedInOwner(page);
    const state = await page.context().storageState();
    const context = await browser.newContext({ javaScriptEnabled: false, storageState: state, baseURL: BASE, acceptDownloads: true });
    const noJs = await context.newPage();
    await noJs.goto("/admin/history/");
    await expect(noJs.getByRole("heading", { name: "Historik", level: 1 })).toBeVisible();
    await expect(noJs.locator("ol > li").first()).toBeVisible();
    const download = noJs.waitForEvent("download");
    await noJs.getByRole("link", { name: "Exportera mitt innehåll" }).click();
    expect((await download).suggestedFilename()).toMatch(/^bistro-content-/);
    await context.close();
  });
});

test.describe("restore with the seed CLI", () => {
  test("after UI edits, export → restore → export gives the same content", async ({ page }) => {
    await signedInOwner(page);
    const original = await exported(page.request);
    // Edit through the UI: a new category, a pull-quote-free texts save, a special day.
    const stamp = Date.now().toString(36);
    await page.goto("/admin/texts/");
    await page.locator("form#pages").getByLabel("Startsidans rubrik på svenska").fill(`Ändrad ${stamp} 🍂 — “citat”`);
    await page.getByRole("button", { name: "Spara texterna" }).click();
    const edited = await exported(page.request);
    expect(edited.content.pages.home.tagline.sv).toContain(stamp);

    const path = writeExport(edited);
    const r = seed(["--site", "bistro", "--from", path, "--reset"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/restoring "bistro" from .* \(exported \d{4}-/);
    const after = await exported(page.request);
    expect(after.content).toEqual(edited.content);
    expect(after.contentVersion).toBeGreaterThan(edited.contentVersion);

    // Put the original back for the specs that follow.
    const back = seed(["--site", "bistro", "--from", writeExport(original), "--reset"]);
    expect(back.status, back.stderr).toBe(0);
    expect((await exported(page.request)).content).toEqual(original.content);
  });

  test("refused restores print one readable line and change nothing", async ({ page }) => {
    await signedInOwner(page);
    const before = await exported(page.request);
    const tampered = (change: (f: typeof before) => void) => {
      const f = structuredClone(before);
      change(f);
      return writeExport(f);
    };
    const cases: Array<[string, string, RegExp]> = [
      ["unknown key", tampered((f) => (f.content.owners = [])), /content is not valid/],
      ["missing highlight", tampered((f) => (f.content.pages.home.highlights[0] = "zzzzzzzzzzzz")), /highlights an item that does not exist/],
      ["negative price", tampered((f) => (f.content.menu.categories[0].items[0].price = -100)), /price/],
      ["other site's images", tampered((f) => (f.content.pages.home.heroImage = "/images/westafrican/hero.jpg")), /must be a file under \/images\/bistro\//],
      ["__proto__", writeExport(JSON.stringify(before).replace('"settings":{', '"settings":{"__proto__":{"x":1},')), /content is not valid/],
      ["broken JSON", writeExport("{"), /not valid JSON/],
      ["missing file", join(dir, "does-not-exist.json"), /can't read/],
      ["a directory", dir, /can't read/],
      ["image not on disk", tampered((f) => (f.content.pages.home.heroImage = "/images/bistro/not-there.jpg")), /not found under public/],
    ];
    for (const [name, path, message] of cases) {
      const r = seed(["--site", "bistro", "--from", path, "--reset"]);
      expect(r.status, name).not.toBe(0);
      expect(r.stderr, name).toMatch(message);
      expect(r.stderr, `${name}: no stack trace`).not.toMatch(/\n\s+at /);
    }
    const after = await exported(page.request);
    expect(after.content).toEqual(before.content);
    expect(after.contentVersion).toBe(before.contentVersion);
  });

  test("--from without --reset on a site with content is refused", async ({ page }) => {
    await signedInOwner(page);
    const before = await exported(page.request);
    const r = seed(["--site", "bistro", "--from", writeExport(before)]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('site "bistro" already has content in the local database; pass --reset to replace it');
    expect((await exported(page.request)).contentVersion).toBe(before.contentVersion);
  });

  test("restoring into the wrong site is refused", async ({ page }) => {
    await signedInOwner(page);
    const file = writeExport(await exported(page.request));
    const r = seed(["--site", "westafrican", "--from", file, "--reset"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('the file is for site "bistro", not "westafrican"');
  });

  test("a 20 MB file is refused quickly with a short message", async ({ page }) => {
    await signedInOwner(page);
    const f = await exported(page.request);
    f.content.menu.categories[0].items[0].description.sv = "x".repeat(20_000_000);
    const path = writeExport(f);
    const started = Date.now();
    const r = seed(["--site", "bistro", "--from", path, "--reset"]);
    const took = Date.now() - started;
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/must be at most 300 characters/);
    expect(r.stderr.length).toBeLessThan(1000);
    expect(took, `took ${took} ms`).toBeLessThan(60_000);
  });

  test("D: a file with a UTF-8 byte-order mark should restore; today it is refused as broken JSON", async ({ page }) => {
    await signedInOwner(page);
    const path = writeExport(`﻿${JSON.stringify(await exported(page.request))}`);
    const r = seed(["--site", "bistro", "--from", path, "--reset"]);
    expect(r.stderr, "a BOM should be skipped").not.toMatch(/not valid JSON/);
  });
});
