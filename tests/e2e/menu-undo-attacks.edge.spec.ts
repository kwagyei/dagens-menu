/**
 * The restore route under attack (ADR-018 task 8): no or a wrong CSRF token, a GET, crafted
 * entry values, a double POST. Nothing is restored except by one valid POST, once. Cross-site
 * entries are covered in tests/db/undo-attacks.test.ts: this server serves one site.
 */
import { type APIResponse, expect, type Page, test } from "@playwright/test";
import { clearOfMidnight, d1, dishRow, freshIp, signedInOwner } from "./helpers";

test.beforeEach(clearOfMidnight);

// Each test sets up a dish and then fires a dozen requests at the route.
test.describe.configure({ timeout: 90_000 });

const BASE = "http://localhost:8790";
const RESTORE = "/admin/menu/restore/";
const csrf = (page: Page) => page.locator("input[name=csrf]").first().inputValue();
// One character changed in the middle, where every bit counts: the last character of a 32-byte
// token carries two unused bits, so changing it can spell the same token (24 Oct nightly).
const tampered = (token: string) => {
  const i = Math.floor(token.length / 2);
  return token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
};
const post = (page: Page, form: Record<string, string>, headers: Record<string, string> = { Origin: BASE }) =>
  page.request.post(`${BASE}${RESTORE}`, { form, maxRedirects: 0, headers });
const location = (res: APIResponse) => res.headers().location ?? "";

/** Add a dish, delete it, and hand back its name and the entry id the flash carries. */
async function deletedDish(page: Page) {
  const name = `Attackrätt ${Date.now().toString(36)}`;
  await page.goto("/admin/");
  await page
    .locator("section[id^='category-']")
    .first()
    .getByRole("link", { name: /Lägg till rätt/ })
    .click();
  await page.getByLabel("Namn på svenska").fill(name);
  await page.getByLabel("Namn på engelska").fill("Attack dish");
  await page.getByLabel("Beskrivning på svenska").fill("Test");
  await page.getByLabel("Beskrivning på engelska").fill("Test");
  await page.getByLabel("Pris i kronor").fill("10");
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await dishRow(page, name).getByRole("link", { name: "Ändra" }).click();
  await page.getByRole("link", { name: "Ta bort rätten" }).click();
  await page.getByRole("button", { name: "Ja, ta bort" }).click();
  await expect(page.getByRole("status")).toContainText("Borttaget.");
  const entry = await page.locator("input[name=entry]").inputValue();
  expect(entry).toMatch(/^[1-9][0-9]*$/);
  return { name, entry };
}
const dishes = (name: string) => d1<{ n: number }>(`SELECT count(*) AS n FROM menu_items WHERE name_sv = '${name}'`)[0].n;

test("without a valid token, or from another origin, nothing is restored", async ({ page }) => {
  await signedInOwner(page);
  const { name, entry } = await deletedDish(page);
  const token = await csrf(page);
  for (const [form, headers] of [
    [{ entry }, { Origin: BASE }],
    [{ entry, csrf: "wrong" }, { Origin: BASE }],
    [{ entry, csrf: tampered(token) }, { Origin: BASE }],
    [{ entry, csrf: token }, { Origin: "https://evil.example" }],
    [{ entry, csrf: token }, { Origin: "null" }],
    [{ entry, csrf: token }, {}],
  ] as [Record<string, string>, Record<string, string>][]) {
    const res = await post(page, form, headers);
    expect([303, 403], JSON.stringify([form, headers])).toContain(res.status());
    if (res.status() === 303) expect(location(res)).toMatch(/done=expired|\/admin\/?$/);
    expect(dishes(name), JSON.stringify([form, headers])).toBe(0);
  }
});

test("crafted entry values are not found, and GET restores nothing", async ({ page }) => {
  await signedInOwner(page);
  const { name, entry } = await deletedDish(page);
  const token = await csrf(page);
  for (const bad of ["", "0", "-1", "abc", "1e3", "1 OR 1=1", "9".repeat(17), ` ${entry}`, `${entry}\n`, "../1", String(Number(entry) + 1000)]) {
    const res = await post(page, { csrf: token, entry: bad });
    expect(res.status(), JSON.stringify(bad)).toBe(303);
    expect(location(res), JSON.stringify(bad)).toMatch(/done=not-found$/);
    expect(dishes(name), JSON.stringify(bad)).toBe(0);
  }
  // The category picker needs a real, undoable entry; a GET with anything else lands on the menu.
  for (const query of ["", `?entry=abc`, `?entry=${Number(entry) + 1000}`]) {
    const res = await page.request.get(`${BASE}${RESTORE}${query}`, { maxRedirects: 0 });
    expect(res.status(), query).toBe(303);
    expect(location(res), query).toMatch(/done=not-found$/);
  }
  // A GET with the real entry while the dish's category still exists offers one button, no choice, and restores nothing.
  const fits = await page.request.get(`${BASE}${RESTORE}?entry=${entry}`, { maxRedirects: 0 });
  expect(fits.status()).toBe(200);
  const html = await fits.text();
  expect(html).toContain("kan läggas tillbaka där den låg");
  expect(html).not.toContain('type="radio"');
  expect(dishes(name)).toBe(0);
  // A POST with a crafted category id is ignored when the dish's own category exists: it still restores there.
  const res = await post(page, { csrf: token, entry, category: "'; DROP TABLE menu_items; --" });
  expect(location(res)).toMatch(/done=restored$/);
  expect(dishes(name)).toBe(1);
});

test("the same undo posted twice restores once; the second says already back", async ({ page }) => {
  await signedInOwner(page);
  const { name, entry } = await deletedDish(page);
  const token = await csrf(page);
  const [a, b] = await Promise.all([post(page, { csrf: token, entry }), post(page, { csrf: token, entry })]);
  const outcomes = [a, b]
    .map(location)
    .map((l) => l.replace(/^.*done=/, ""))
    .sort();
  expect(outcomes).toEqual(["already-back", "restored"]);
  expect(dishes(name)).toBe(1);
  expect(d1<{ n: number }>(`SELECT count(*) AS n FROM audit_log WHERE summary = '${name}: restored'`)[0].n).toBe(1);
  // And again, later: still once.
  expect(location(await post(page, { csrf: token, entry }))).toMatch(/done=already-back$/);
  expect(dishes(name)).toBe(1);
});

test("a signed-out client can't restore", async ({ page }) => {
  await signedInOwner(page);
  const { name, entry } = await deletedDish(page);
  const token = await csrf(page);
  const anon = await page
    .context()
    .browser()!
    .newContext({ extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const res = await anon.request.post(`${BASE}${RESTORE}`, { form: { csrf: token, entry }, maxRedirects: 0, headers: { Origin: BASE } });
  expect([303, 401, 403]).toContain(res.status());
  await anon.close();
  expect(dishes(name)).toBe(0);
});
