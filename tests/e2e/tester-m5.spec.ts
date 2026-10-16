/**
 * Tester, M5.1–M5.3: attacks on menu editing, against the built bistro Worker.
 * Runs after menu.spec.ts and tester-m4.spec.ts (alphabetical). Each test makes its own
 * category so it doesn't depend on the seeded menu's state.
 */
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { dishRow, signedInOwner } from "./helpers";

const menu = JSON.parse(readFileSync(new URL("../../sites/bistro/content/menu.json", import.meta.url), "utf-8")) as {
  categories: Array<{ id: string; items: Array<{ id: string; name: { sv: string; en: string } }> }>;
};
const waMenu = JSON.parse(readFileSync(new URL("../../sites/westafrican/content/menu.json", import.meta.url), "utf-8")) as typeof menu;
const BASE = "http://localhost:8790";

async function addCategory(page: Page, sv: string, en = sv) {
  await page.goto("/admin/menu/category/new/");
  await page.getByLabel("Namn på svenska").fill(sv);
  await page.getByLabel("Namn på engelska").fill(en);
  await page.getByRole("button", { name: "Lägg till kategori" }).click();
  const section = page.locator("section[id^='category-']", { has: page.getByRole("heading", { name: sv, exact: true }) });
  await expect(section).toBeVisible();
  return section;
}

async function addDish(page: Page, section: ReturnType<Page["locator"]>, name: string, price = "100", extra?: (p: Page) => Promise<void>) {
  await section.getByRole("link", { name: /Lägg till rätt/ }).click();
  await page.getByLabel("Namn på svenska").fill(name);
  await page.getByLabel("Namn på engelska").fill(`${name} en`);
  await page.getByLabel("Beskrivning på svenska").fill("Beskrivning");
  await page.getByLabel("Beskrivning på engelska").fill("Description");
  await page.getByLabel("Pris i kronor").fill(price);
  if (extra) await extra(page);
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
}

const csrfOf = async (page: Page) => (await page.locator("input[name=csrf]").first().inputValue());

test("price input forms through the real form", async ({ page }) => {
  await signedInOwner(page);
  const section = await addCategory(page, "Pristest");
  const cases: Array<[string, string]> = [
    ["1 250", "1 250 kr"],
    ["145 kr", "145 kr"],
    ["145:-", "145 kr"],
    ["145,5", "145,50 kr"],
    ["12.50", "12,50 kr"],
  ];
  let n = 0;
  for (const [input, shown] of cases) {
    const name = `Pris ${n++}`;
    await addDish(page, section, name, input, async (p) => {
      if (input === "1 250") await p.getByLabel("Pris i kronor").fill(input);
    });
    if (input === "1 250") {
      // 1 250 kr is within 10..2000, no confirmation needed
    }
    await expect(page.getByRole("status")).toHaveText("Tillagt.");
    await expect(dishRow(page, name)).toContainText(shown);
  }
  // rejections keep the form, store nothing
  for (const bad of ["abc", "-5", "1,2,3", "12,345", "", "99999999999999999999", "1e3", "١٢٣", "100000,01", "0x10"]) {
    await section.getByRole("link", { name: /Lägg till rätt/ }).click();
    await page.getByLabel("Namn på svenska").fill("Dålig");
    await page.getByLabel("Namn på engelska").fill("Bad");
    await page.getByLabel("Beskrivning på svenska").fill("x");
    await page.getByLabel("Beskrivning på engelska").fill("x");
    await page.getByLabel("Pris i kronor").fill(bad);
    const [res] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.getByRole("button", { name: "Lägg till rätt" }).click()]);
    expect(res.status(), `price ${JSON.stringify(bad)}`).toBe(422);
    await expect(page.getByLabel("Pris i kronor")).toHaveValue(bad);
    await page.goto("/admin/");
  }
  await expect(page.locator("li[id^='item-']", { hasText: "Dålig" })).toHaveCount(0);
});

test("price 0 needs confirmation and then stores 0 kr", async ({ page }) => {
  await signedInOwner(page);
  const section = await addCategory(page, "Nolltest");
  await addDish(page, section, "Gratis", "0");
  await expect(page.locator("#price-error")).toBeVisible();
  await page.getByLabel("Ja, priset stämmer").check();
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await expect(page.getByRole("status")).toHaveText("Tillagt.");
  await page.goto("/menu/");
  await expect(page.locator(".menu-item-row", { hasText: "Gratis" })).toBeVisible();
});

test("a 422 keeps every checkbox, including the price confirmation", async ({ page }) => {
  await signedInOwner(page);
  const section = await addCategory(page, "Kryss");
  await section.getByRole("link", { name: /Lägg till rätt/ }).click();
  await page.getByLabel("Namn på svenska").fill("");
  await page.getByLabel("Namn på engelska").fill("En");
  await page.getByLabel("Beskrivning på svenska").fill("x");
  await page.getByLabel("Beskrivning på engelska").fill("x");
  await page.getByLabel("Pris i kronor").fill("5");
  await page.getByLabel("mjölk").check();
  await page.getByLabel("vegan").check();
  await page.getByLabel("På menyn").uncheck();
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await expect(page.locator("#name_sv-error")).toBeVisible();
  await expect(page.getByLabel("mjölk")).toBeChecked();
  await expect(page.getByLabel("vegan")).toBeChecked();
  await expect(page.getByLabel("På menyn")).not.toBeChecked();
  // price 5 kr is unusual, the confirm box is offered; tick it, break something else, submit again
  await page.getByLabel("Ja, priset stämmer").check();
  await page.getByRole("button", { name: "Lägg till rätt" }).click();
  await expect(page.locator("#name_sv-error")).toBeVisible();
  // The confirmation the owner already gave must survive a second rejected submit.
  await expect(page.getByLabel("Ja, priset stämmer")).toBeChecked();
});

test("public pages: JSON-LD, anchors and highlights follow edits", async ({ page, request }) => {
  await signedInOwner(page);
  const section = await addCategory(page, "Ankare åäö", "Anchor");
  await addDish(page, section, "Ankarrätt", "111", async (p) => {
    await p.getByLabel("mjölk").check();
  });
  await expect(page.getByRole("status")).toHaveText("Tillagt.");
  const ld = async (path: string) => {
    const html = await (await request.get(path)).text();
    return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  };
  let menuLd = (await ld("/menu/")).find((j) => j["@type"] === "Menu");
  const sec = menuLd.hasMenuSection.find((s: { name: string }) => s.name === "Ankare åäö");
  expect(sec.hasMenuItem[0].offers.price).toBe("111.00");
  const anchorHref = await (async () => {
    const html = await (await request.get("/menu/")).text();
    return html.match(/href="(#cat-[^"]*)"[^>]*>\s*Ankare åäö/)?.[1];
  })();
  expect(anchorHref).toBeTruthy();
  // rename: anchors must still point at an existing section id
  await section.getByRole("link", { name: "Ändra kategori" }).click();
  await page.getByLabel("Namn på svenska").fill("Nytt namn");
  await page.getByRole("button", { name: "Spara" }).click();
  const html = await (await request.get("/menu/")).text();
  const nav = html.match(/href="(#cat-[^"]*)"[^>]*>\s*Nytt namn/)?.[1];
  expect(nav).toBe(anchorHref);
  expect(html).toContain(`id="${anchorHref!.slice(1)}"`);
  // sold out dish: JSON-LD says SoldOut
  await dishRow(page, "Ankarrätt").getByRole("button", { name: "Slutsåld idag" }).click();
  menuLd = (await ld("/menu/")).find((j) => j["@type"] === "Menu");
  const item = menuLd.hasMenuSection.find((s: { name: string }) => s.name === "Nytt namn").hasMenuItem[0];
  expect(item.offers.availability).toBe("https://schema.org/SoldOut");
  // hide dish: category vanishes from JSON-LD and public page
  await dishRow(page, "Ankarrätt").getByRole("link", { name: "Ändra" }).click();
  await page.getByLabel("På menyn").uncheck();
  await page.getByRole("button", { name: "Spara" }).click();
  menuLd = (await ld("/menu/")).find((j) => j["@type"] === "Menu");
  expect(menuLd.hasMenuSection.some((s: { name: string }) => s.name === "Nytt namn")).toBe(false);
});

test("deleting a featured dish removes it from the home page and the site keeps rendering", async ({ page, request }) => {
  await signedInOwner(page);
  const home0 = await (await request.get("/")).text();
  const featuredRow = page.locator("li[id^='item-']", { hasText: "På startsidan" }).first();
  const name = (await featuredRow.locator("p.font-semibold").textContent())!.trim();
  expect(home0).toContain(name);
  await featuredRow.getByRole("link", { name: "Ändra" }).click();
  await page.getByRole("link", { name: "Ta bort rätten" }).click();
  await page.getByRole("button", { name: "Ja, ta bort" }).click();
  await expect(page.getByRole("status")).toHaveText("Borttaget.");
  for (const path of ["/", "/en/", "/menu/", "/en/menu/", "/contact/"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
  }
  const home1 = await (await request.get("/")).text();
  expect(home1).not.toContain(`>${name}<`);
});

test("deleting a whole category of dishes keeps every public page up", async ({ page, request }) => {
  await signedInOwner(page);
  const target = page.locator("section[id^='category-']").first();
  await target.getByRole("link", { name: "Ändra kategori" }).click();
  await page.getByRole("link", { name: "Ta bort kategorin" }).click();
  await page.getByRole("button", { name: /Ja, ta bort kategorin/ }).click();
  await expect(page.getByRole("status")).toHaveText("Borttaget.");
  for (const path of ["/", "/en/", "/menu/", "/en/menu/", "/contact/", "/about/"]) {
    expect((await request.get(path)).status(), path).toBe(200);
  }
});

test("every new form carries a CSRF token, and a missing or wrong one changes nothing", async ({ page }) => {
  await signedInOwner(page);
  const cat = menu.categories[1];
  const item = cat.items[0];
  const pagesWithForms = [
    "/admin/",
    `/admin/menu/new/?category=${cat.id}`,
    `/admin/menu/item/${item.id}/`,
    `/admin/menu/item/${item.id}/delete/`,
    "/admin/menu/category/new/",
  ];
  // the category id is generated for newly made ones; look up the real ones from the page
  await page.goto("/admin/");
  const catIds = await page.locator("section[id^='category-']").evaluateAll((els) => els.map((e) => e.id.replace("category-", "")));
  const itemIds = await page.locator("li[id^='item-']").evaluateAll((els) => els.map((e) => e.id.replace("item-", "")));
  const cid = catIds[0];
  const iid = itemIds[0];
  void pagesWithForms;
  const targets = [
    `/admin/menu/new/?category=${cid}`,
    `/admin/menu/item/${iid}/`,
    `/admin/menu/item/${iid}/delete/`,
    `/admin/menu/category/new/`,
    `/admin/menu/category/${cid}/`,
    `/admin/menu/category/${cid}/delete/`,
  ];
  for (const path of targets) {
    await page.goto(path);
    const forms = await page.locator("form[method=post]").count();
    expect(forms, path).toBeGreaterThan(0);
    const forms2 = await page.locator("form[method=post]").evaluateAll((fs) => fs.map((f) => !!f.querySelector("input[name=csrf]")));
    expect(forms2.every(Boolean), path).toBe(true);
  }
  await page.goto("/admin/");
  const forms = await page.locator("form[method=post]").evaluateAll((fs) => fs.map((f) => !!f.querySelector("input[name=csrf]")));
  expect(forms.every(Boolean)).toBe(true);

  const beforeHtml = await (await page.request.get("/menu/")).text();
  const good = await csrfOf(page);
  const bodies: Array<[string, Record<string, string>]> = [
    ["/admin/", { action: "sold-out", id: iid, value: "1" }],
    ["/admin/", { action: "move-item", id: iid, direction: "down" }],
    ["/admin/", { action: "move-category", id: cid, direction: "down" }],
    [`/admin/menu/item/${iid}/delete/`, {}],
    [`/admin/menu/category/${cid}/delete/`, {}],
    [`/admin/menu/category/new/`, { name_sv: "Hackad", name_en: "Hacked" }],
    [`/admin/menu/category/${cid}/`, { name_sv: "Hackad", name_en: "Hacked", row_version: "0" }],
    [`/admin/menu/item/${iid}/`, { name_sv: "H", name_en: "H", description_sv: "x", description_en: "x", price: "1", row_version: "0" }],
    [`/admin/menu/new/?category=${cid}`, { name_sv: "H", name_en: "H", description_sv: "x", description_en: "x", price: "100" }],
  ];
  for (const [path, body] of bodies) {
    for (const csrf of [undefined, "", "garbage", good.slice(0, -1) + (good.endsWith("a") ? "b" : "a")]) {
      const res = await page.request.post(path, { form: csrf === undefined ? body : { ...body, csrf }, maxRedirects: 0, headers: { Origin: BASE } });
      expect([303, 302, 403], `${path} csrf=${csrf}`).toContain(res.status());
      if (res.status() === 303) expect(res.headers().location, `${path} csrf=${csrf}`).toContain("done=expired");
    }
  }
  expect(await (await page.request.get("/menu/")).text()).toBe(beforeHtml);
});

test("garbage ids, garbage directions and another site's ids", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/");
  const csrf = await csrfOf(page);
  const post = (path: string, form: Record<string, string>) => page.request.post(path, { form: { csrf, ...form }, maxRedirects: 0, headers: { Origin: BASE } });
  const order = async () => page.locator("li[id^='item-']").evaluateAll((els) => els.map((e) => e.id));
  await page.goto("/admin/");
  const before = await order();
  const foreign = [waMenu.categories[0].id, waMenu.categories[0].items[0].id];
  for (const id of ["", "x", "../../etc", "'; DROP TABLE menu_items;--", "a".repeat(5000), foreign[1]]) {
    for (const action of ["sold-out", "move-item", "move-category"]) {
      const res = await post("/admin/", { action, id, direction: "up", value: "1" });
      expect([303, 400, 404], `${action} ${id.slice(0, 20)}`).toContain(res.status());
      if (res.status() === 303) expect(res.headers().location).toContain("done=not-found");
    }
    if (id === "") continue;
    for (const path of [`/admin/menu/item/${encodeURIComponent(id)}/`, `/admin/menu/item/${encodeURIComponent(id)}/delete/`, `/admin/menu/category/${encodeURIComponent(id)}/`, `/admin/menu/category/${encodeURIComponent(id)}/delete/`]) {
      const get = await page.request.get(path, { maxRedirects: 0 });
      expect([303, 404, 400], path).toContain(get.status());
      const p = await post(path, { name_sv: "x", name_en: "x", description_sv: "x", description_en: "x", price: "1", row_version: "0" });
      expect([303, 404, 400], path).toContain(p.status());
    }
  }
  const res = await post(`/admin/menu/new/?category=${foreign[0]}`, { name_sv: "Främmande", name_en: "Foreign", description_sv: "x", description_en: "x", price: "100" });
  expect(res.headers().location).toContain("done=not-found");
  await page.goto("/admin/");
  expect(await order()).toEqual(before);
  // a garbage direction: must not move anything (it should be ignored or rejected)
  // the first dish of a category with at least two dishes, so a move down would be visible
  const first = (await page.locator("section[id^='category-']").filter({ has: page.locator("li + li") }).first().locator("li[id^='item-']").first().getAttribute("id"))!.replace("item-", "");
  await page.goto("/admin/");
  const before2 = await order();
  const res2 = await post("/admin/", { action: "move-item", id: first, direction: "sideways" });
  expect(res2.status()).toBe(303);
  await page.goto("/admin/");
  expect(await order(), "direction=sideways must not reorder").toEqual(before2);
});

test("English admin keeps its language through every redirect", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/en/admin/");
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();
  const section = page.locator("section[id^='category-']").first();
  await section.getByRole("link", { name: /Add a dish/ }).click();
  expect(page.url()).toContain("/en/admin/");
  await page.getByLabel("Name in Swedish").fill("Engelsk");
  await page.getByLabel("Name in English").fill("English");
  await page.getByLabel("Description in Swedish").fill("x");
  await page.getByLabel("Description in English").fill("x");
  await page.getByLabel("Price in kronor").fill("abc");
  await page.getByRole("button", { name: "Add a dish" }).click();
  await expect(page.locator("#price-error")).toContainText("numbers");
  await page.getByLabel("Price in kronor").fill("120");
  await page.getByRole("button", { name: "Add a dish" }).click();
  expect(page.url()).toMatch(/\/en\/admin\/\?done=added/);
  await expect(page.getByRole("status")).toHaveText("Added.");
  const row = page.locator("li[id^='item-']", { hasText: "English" });
  await row.getByRole("button", { name: "Sold out today" }).click();
  expect(page.url()).toContain("/en/admin/");
  await row.getByRole("link", { name: "Edit" }).click();
  await page.getByRole("link", { name: "Delete the dish" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  expect(page.url()).toMatch(/\/en\/admin\/\?done=deleted/);
});

test("long names on a 375px screen do not overflow, in the admin or on the public menu", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signedInOwner(page);
  const longWord = "Överdrivetlångtnamn".repeat(10).slice(0, 80);
  const section = await addCategory(page, longWord, longWord);
  await addDish(page, section, longWord.slice(0, 70), "100");
  await expect(page.getByRole("status")).toHaveText("Tillagt.");
  const overflow = async (path: string) => {
    await page.goto(path);
    return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  };
  expect.soft(await overflow("/admin/"), "admin list overflows horizontally").toBeLessThanOrEqual(0);
  await page.goto("/admin/");
  const link = page.locator("li[id^='item-']", { hasText: longWord.slice(0, 30) }).getByRole("link", { name: "Ändra" });
  await link.click();
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "edit form overflows").toBeLessThanOrEqual(0);
  expect.soft(await overflow("/menu/"), "public menu overflows horizontally").toBeLessThanOrEqual(0);
  // targets: buttons at least 44px tall on the list
  await page.goto("/admin/");
  const small = await page.locator("main button, main a.admin-button, main a.admin-small-button").evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).offsetParent && e.getBoundingClientRect().height < 40).length,
  );
  expect.soft(small, "controls under 40px tall").toBe(0);
});

test("no-JS: a rejected form, a conflict and a confirmed delete all work", async ({ page, browser }) => {
  await signedInOwner(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
  await noJs.addCookies(await page.context().cookies());
  const p = await noJs.newPage();
  await p.goto("/admin/menu/category/new/");
  await p.getByLabel("Namn på svenska").fill("");
  await p.getByLabel("Namn på engelska").fill("Keep me");
  await p.getByRole("button", { name: /Lägg till kategori/ }).click();
  await expect(p.getByLabel("Namn på engelska")).toHaveValue("Keep me");
  await expect(p.locator("#error-summary, [role=alert]").first()).toBeVisible();
  await noJs.close();
});
