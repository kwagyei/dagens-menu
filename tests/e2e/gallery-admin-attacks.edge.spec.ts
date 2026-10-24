/**
 * Tester, M6.10b admin gallery end to end: the public gallery shows exactly the admin's order
 * (wide tiles first and fourth), cross-site / malformed / CSRF / Origin / unknown-action posts
 * change nothing, 44 px targets, focus at both ends, the full gallery, JS off in both languages.
 * Another site's rows are written with SQL on the local D1 (the Worker serves one site).
 */
import { expect, type Page, test } from "@playwright/test";
import { d1, freshIp, signedInOwner, uploadPhoto } from "./helpers";

// Several uploads, picks and local SQL calls per test: up to ~35 s on CI runners, over the
// 30 s default, so each test gets 90 s (as media-route-attacks.edge.spec.ts does).
test.describe.configure({ timeout: 90_000 });

const BASE = "http://localhost:8790";
const GALLERY = "/admin/gallery/";
const rows = () =>
  d1<{ id: string; image_id: string; position: number; site_id: string }>("SELECT site_id, id, image_id, position FROM gallery_images ORDER BY site_id, position, id");
const version = () => d1<{ v: number }>("SELECT content_version AS v FROM sites WHERE id = 'bistro'")[0].v;
const csrf = (page: Page) => page.locator("input[name=csrf]").first().inputValue();
// One character changed in the middle, where every bit counts: the last character of a 32-byte
// token carries two unused bits, so changing it can spell the same token (24 Oct nightly).
const tampered = (token: string) => {
  const i = Math.floor(token.length / 2);
  return token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
};
const post = (page: Page, form: Record<string, string>, headers: Record<string, string> = { Origin: BASE }, path = GALLERY) =>
  page.request.post(path, { form, maxRedirects: 0, headers });
const addable = (page: Page, id: string) => page.locator(`#addable-${id.slice(0, 12)}`);
const entry = (page: Page, id: string) => page.locator("#gallery li").filter({ has: page.locator(`img[src*="${id}"]`) });
const adminAlts = (page: Page) => page.locator("#gallery li img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).alt));
const publicAlts = (page: Page) => page.locator(".gallery-magazine img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).alt));

test("public gallery shows exactly the admin's order after add, move and remove, in both languages", async ({ page }) => {
  await signedInOwner(page);
  const a = await uploadPhoto(page);
  const b = await uploadPhoto(page);
  await page.goto(GALLERY);
  const baseline = rows().filter((r) => r.site_id === "bistro").length;
  const v0 = version();
  for (const p of [a, b])
    await addable(page, p.id)
      .getByRole("button", { name: `Lägg till i galleriet: ${p.sv}` })
      .click();
  expect(version()).toBeGreaterThan(v0);
  // Move b up twice and a to the end side: final admin order is what the public page must show.
  await entry(page, b.id)
    .getByRole("button", { name: `Flytta tidigare: ${b.sv}` })
    .click();
  await entry(page, b.id)
    .getByRole("button", { name: `Flytta tidigare: ${b.sv}` })
    .click();
  const admin = await adminAlts(page);
  expect(admin).toHaveLength(baseline + 2);
  await page.goto("/gallery/");
  expect(await publicAlts(page)).toEqual(admin);
  // First and fourth tiles are the wide ones (on a desktop-sized, non-mobile context).
  const wide = await page
    .context()
    .browser()!
    .newContext({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
  const wp = await wide.newPage();
  await wp.goto(`${BASE}/gallery/`);
  const spans = await wp.locator(".gallery-magazine > li").evaluateAll((lis) => lis.slice(0, 5).map((li) => getComputedStyle(li).gridColumnStart));
  await wide.close();
  expect(spans.map((s) => s.includes("span 2"))).toEqual([true, false, false, true, false]);
  // English: same photos, same order, English alts.
  await page.goto(`/en${GALLERY}`);
  const adminEn = await adminAlts(page);
  await page.goto("/en/gallery/");
  expect(await publicAlts(page)).toEqual(adminEn);
  expect(adminEn[baseline - 1]).toBe(b.en);
  // Removing the moved photo leaves the rest in the same relative order.
  await page.goto(GALLERY);
  await entry(page, b.id)
    .getByRole("button", { name: `Ta bort från galleriet: ${b.sv}` })
    .click();
  await page.goto("/gallery/");
  expect(await publicAlts(page)).toEqual(admin.filter((x) => x !== b.sv));
  await page.goto(GALLERY);
  await entry(page, a.id)
    .getByRole("button", { name: `Ta bort från galleriet: ${a.sv}` })
    .click();
  expect(rows().filter((r) => r.site_id === "bistro")).toHaveLength(baseline);
});

test("another site's rows and photos, malformed ids, bad CSRF, wrong Origin and unknown actions change nothing", async ({ page }) => {
  await signedInOwner(page);
  const mine = await uploadPhoto(page);
  const theirImg = "f".repeat(63) + "0";
  d1(
    `INSERT OR IGNORE INTO sites (id) VALUES ('westafrican');
     INSERT INTO images (site_id, id, kind, path, mime, width, height, byte_size, alt_sv, alt_en) VALUES ('westafrican', '${theirImg}', 'upload', NULL, 'image/webp', 400, 300, 1, 'Deras', 'Theirs');
     INSERT INTO gallery_images (site_id, id, image_id, position) VALUES ('westafrican', 'wawawawawa01', '${theirImg}', 0), ('westafrican', 'wawawawawa02', '${theirImg}', 1)`,
  );
  try {
    await page.goto(GALLERY);
    const token = await csrf(page);
    // The test's own gallery row, so the attacks never aim at a row another test may be moving
    // or removing in parallel (PR #74: the old snapshot of every bistro row failed that way).
    expect((await post(page, { csrf: token, action: "add", id: mine.id })).status()).toBe(303);
    const ownId = rows().find((r) => r.image_id === mine.id)!.id;
    // Only the rows the attacks aim at: the other site's two, this test's own, and any row that
    // wrongly took the other site's photo (the "add" attack). Other tests
    // edit bistro's gallery and content in parallel, so neither all of its rows nor its
    // content_version can be compared here.
    const watched = () =>
      JSON.stringify(
        d1(`SELECT site_id, id, image_id, position FROM gallery_images WHERE site_id = 'westafrican' OR id = '${ownId}' OR image_id = '${theirImg}' ORDER BY site_id, id`),
      );
    const snapshot = watched();
    const bad: Record<string, string>[] = [
      { action: "add", id: theirImg },
      { action: "remove", id: "wawawawawa01" },
      { action: "move", id: "wawawawawa02", direction: "up" },
      { action: "move", id: "wawawawawa01", direction: "down" },
      { action: "add", id: "nonsense" },
      { action: "add", id: "" },
      { action: "add", id: "'; DELETE FROM gallery_images; --" },
      { action: "add", id: "A".repeat(64) },
      { action: "add", id: "e".repeat(64) },
      { action: "add", id: "z".repeat(10000) },
      { action: "remove", id: "x" },
      { action: "remove", id: "../../etc" },
      { action: "remove", id: "" },
      { action: "move", id: ownId, direction: "sideways" },
      { action: "move", id: ownId },
      { action: "delete-all", id: ownId },
      { action: "", id: ownId },
      { id: ownId },
    ];
    for (const form of bad) {
      const res = await post(page, { csrf: token, ...form });
      expect(res.status(), JSON.stringify(form)).toBe(303);
      // A known action on a wrong id is "not found"; an action the page never sends is "unknown" (L3).
      const known = form.action === "add" || form.action === "remove" || (form.action === "move" && (form.direction === "up" || form.direction === "down"));
      expect(res.headers().location, JSON.stringify(form)).toMatch(known ? /\?done=not-found$/ : /\?done=unknown$/);
    }
    // Without a valid token, or from another origin, nothing is written either.
    const good = { action: "remove", id: ownId };
    for (const [form, headers] of [
      [{ ...good }, { Origin: BASE }],
      [{ ...good, csrf: "wrong" }, { Origin: BASE }],
      [{ ...good, csrf: tampered(token) }, { Origin: BASE }],
      [{ ...good, csrf: token }, { Origin: "https://evil.example" }],
      [{ ...good, csrf: token }, { Origin: "null" }],
      [{ ...good, csrf: token }, {}],
    ] as [Record<string, string>, Record<string, string>][]) {
      const res = await post(page, form, headers);
      expect([303, 403], JSON.stringify([form, headers])).toContain(res.status());
      if (res.status() === 303) expect(res.headers().location).toMatch(/done=expired|done=not-found|\/admin\/?/);
    }
    // A bistro photo id that exists only on the other site's library: not found.
    expect(watched()).toBe(snapshot);
    // GET with action-looking query strings does nothing.
    await page.goto(`${GALLERY}?action=remove&id=${ownId}`);
    expect(watched()).toBe(snapshot);
    // The other site's photo is not offered here.
    await expect(page.locator(`#addable-${theirImg.slice(0, 12)}`)).toHaveCount(0);
    // A signed-out client can't post.
    const anon = await page
      .context()
      .browser()!
      .newContext({ extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
    const res = await anon.request.post(`${BASE}${GALLERY}`, { form: { csrf: token, action: "remove", id: ownId }, maxRedirects: 0, headers: { Origin: BASE } });
    expect([303, 401, 403]).toContain(res.status());
    await anon.close();
    expect(watched()).toBe(snapshot);
  } finally {
    d1(`DELETE FROM gallery_images WHERE site_id = 'westafrican'`);
    d1(`DELETE FROM images WHERE site_id = 'westafrican' AND id = '${theirImg}'`);
    d1(`DELETE FROM gallery_images WHERE site_id = 'bistro' AND image_id = '${mine.id}'`);
  }
});

test("targets are 44 px, focus follows at the top and bottom ends, and the library numbering matches", async ({ page }) => {
  await signedInOwner(page);
  const a = await uploadPhoto(page);
  const b = await uploadPhoto(page);
  await page.goto(GALLERY);
  for (const p of [a, b])
    await addable(page, p.id)
      .getByRole("button", { name: `Lägg till i galleriet: ${p.sv}` })
      .click();
  const small = await page.locator("#gallery button:not([disabled]), #gallery-addable button:not([disabled])").evaluateAll((bs) =>
    bs
      .map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      })
      .filter(([w, h]) => w < 44 || h < 44),
  );
  expect(small).toEqual([]);
  // Bottom end: b is last; move a down -> a is last, its down is disabled, focus goes to its up.
  await entry(page, a.id)
    .getByRole("button", { name: `Flytta senare: ${a.sv}` })
    .click();
  await expect(entry(page, a.id).getByRole("button", { name: `Flytta senare: ${a.sv}` })).toBeDisabled();
  await expect(entry(page, a.id).getByRole("button", { name: `Flytta tidigare: ${a.sv}` })).toBeFocused();
  // Library numbering matches the order.
  const alts = await adminAlts(page);
  await page.goto(`/admin/photos/${a.id}/`);
  await expect(page.locator("#photo-uses")).toContainText(`galleriet, foto ${alts.indexOf(a.sv) + 1}`);
  await page.goto(`/admin/photos/${b.id}/`);
  await expect(page.locator("#photo-uses")).toContainText(`galleriet, foto ${alts.indexOf(b.sv) + 1}`);
  // Top end: move the first photo (not ours) is a no-op; move a to the top step by step.
  await page.goto(GALLERY);
  const total = alts.length;
  for (let i = 0; i < total; i++) {
    const up = entry(page, a.id).getByRole("button", { name: `Flytta tidigare: ${a.sv}` });
    if (await up.isDisabled()) break;
    await up.click();
  }
  await expect(entry(page, a.id).getByRole("button", { name: `Flytta tidigare: ${a.sv}` })).toBeDisabled();
  await expect(entry(page, a.id).getByRole("button", { name: `Flytta senare: ${a.sv}` })).toBeFocused();
  // A crafted "up" at the top is a silent no-op that still lands focus on the other button.
  // a's own row, which the clicks above moved to the top: another test can't reorder it.
  const first = d1<{ id: string }>(`SELECT id FROM gallery_images WHERE image_id = '${a.id}'`)[0].id;
  // The row itself, not content_version: other tests edit bistro's content in parallel.
  const position = () => d1<{ position: number }>(`SELECT position FROM gallery_images WHERE id = '${first}'`)[0].position;
  const before = position();
  const res = await post(page, { csrf: await csrf(page), action: "move", id: first, direction: "up" });
  expect(res.headers().location).toBe(`${GALLERY}?changed=${first}%3Aup`);
  expect(position()).toBe(before);
  for (const p of [a, b])
    await entry(page, p.id)
      .getByRole("button", { name: `Ta bort från galleriet: ${p.sv}` })
      .click();
});

test("a full gallery: add buttons are disabled with a stated reason, and a crafted add is refused", async ({ page }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const have = rows().filter((r) => r.site_id === "bistro");
  const filler = have[0].image_id;
  const extra = Array.from({ length: 30 - have.length }, (_, i) => `('bistro', 'fill${String(i).padStart(8, "0")}', '${filler}', ${1000 + i})`);
  try {
    if (extra.length) d1(`INSERT INTO gallery_images (site_id, id, image_id, position) VALUES ${extra.join(",")}`);
    await page.goto(GALLERY);
    const btn = addable(page, photo.id).getByRole("button", { name: `Lägg till i galleriet: ${photo.sv}` });
    await expect(btn).toBeDisabled();
    // The page says why without a refused click (a disabled button can't be activated).
    await expect(page.locator("main")).toContainText(/högst 30 foton/);
    const res = await post(page, { csrf: await csrf(page), action: "add", id: photo.id });
    expect(res.headers().location).toBe(`${GALLERY}?done=full`);
    await page.goto(`${GALLERY}?done=full`);
    await expect(page.getByRole("alert")).toHaveText("Galleriet rymmer högst 30 foton. Ta bort ett först.");
    await expect(page.getByRole("alert")).toBeFocused();
    await page.goto(`/en${GALLERY}`);
    await expect(page.locator("main")).toContainText(/at most 30 photos/);
  } finally {
    d1("DELETE FROM gallery_images WHERE site_id = 'bistro' AND id LIKE 'fill%'");
  }
});

test("JS off, English: add, move at the end, remove, and refusal messages", async ({ page, browser }) => {
  await signedInOwner(page);
  const photo = await uploadPhoto(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState(), extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const plain = await noJs.newPage();
  await plain.goto(`${BASE}/en${GALLERY}`);
  await addable(plain, photo.id)
    .getByRole("button", { name: `Add to the gallery: ${photo.en}` })
    .click();
  await expect(plain.getByRole("status")).toHaveText("The photo is added to the gallery.");
  // Down at the bottom is disabled; up works and the page reloads in English.
  await expect(entry(plain, photo.id).getByRole("button", { name: `Move later: ${photo.en}` })).toBeDisabled();
  await entry(plain, photo.id)
    .getByRole("button", { name: `Move earlier: ${photo.en}` })
    .click();
  expect(plain.url()).toContain("/en/admin/gallery/");
  for (const [done, text] of [
    ["already", "That photo is already in the gallery."],
    ["not-found", "That photo isn't in your photos any more."],
    ["busy", "Someone else changed the gallery just now. Try again."],
    ["expired", ""],
  ] as const) {
    await plain.goto(`${BASE}/en${GALLERY}?done=${done}`);
    await expect(plain.getByRole("alert")).toBeVisible();
    if (text) await expect(plain.getByRole("alert")).toHaveText(text);
  }
  await plain.goto(`${BASE}/en${GALLERY}?done=bogus`);
  await expect(plain.getByRole("alert")).toHaveCount(0);
  await entry(plain, photo.id)
    .getByRole("button", { name: `Remove from the gallery: ${photo.en}` })
    .click();
  await expect(plain.getByRole("status")).toHaveText("The photo is removed from the gallery. It's still in your photos.");
  await noJs.close();
});
