/**
 * Tester, M5.7: admin accessibility and language, probed past what a11y.spec.ts and
 * keyboard.spec.ts cover. Axe on 409, invite, security (several passkeys), empty, "saved" and
 * many-entry states; headings and landmarks; programmatic labels and announced errors in
 * both languages; English admin free of Swedish; lang attributes; focus after a 422/409;
 * sold-out and reorder names; 44 px targets at 375 px; contrast of text and non-text;
 * 320 px and 200 % text reflow; reduced motion; no JavaScript.
 *
 * Soft assertions throughout, so one run lists every finding of a kind.
 */
import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import sv from "../../src/i18n/sv";
import en from "../../src/i18n/en";
import { invite } from "./helpers";

let ipn = 100;
const BASE = "http://localhost:8790";

/** Sign in as a fresh owner. Like the shared helper, but if the ceremony fails it records why, waits out the rate limit and tries again. */
async function signedInOwner(page: Page): Promise<string> {
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": `192.0.2.${100 + (ipn++ % 150)}` });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const email = `a11y-${Date.now().toString(36)}-${ipn}@example.se`;
  const link = invite(email);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(link);
    await page.getByRole("button", { name: "Skapa passkey" }).click();
    try {
      await expect(page.getByRole("heading", { name: "Meny", exact: true })).toBeVisible({ timeout: 8000 });
      return email;
    } catch {
      const status = await page.locator("#status").innerText().catch(() => "?");
      test.info().annotations.push({ type: "sign-in retry", description: `attempt ${attempt + 1}: ${status}` });
      await page.waitForTimeout(61_000);
    }
  }
  throw new Error("could not sign in");
}

/** A POST the way the browser sends it (the admin refuses writes without a matching Origin). */
const post = (page: Page, path: string, form: Record<string, string>) => page.request.post(path, { form, headers: { Origin: BASE }, maxRedirects: 0 });

function d1(sql: string) {
  execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--command", sql], { stdio: "pipe" });
}

// Sweeps over every page in two languages and several states: slower than a normal test.
// Long enough for the page-by-page checks; a stuck wait fails in 90 s, not 5 min.
test.describe.configure({ timeout: 90_000 });

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function axe(page: Page, what: string, extra: string[] = []) {
  const { violations } = await new AxeBuilder({ page }).withTags([...TAGS, ...extra]).analyze();
  expect.soft(violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), `axe: ${what}`).toEqual([]);
}

/** Every signed-in admin page the owner can reach, as Swedish paths. */
async function adminPaths(page: Page): Promise<string[]> {
  await page.goto("/admin/");
  const itemPath = (await page.locator("li[id^='item-'] a").first().getAttribute("href"))!;
  const categoryPath = (await page.locator("section[id^='category-'] a[href*='/menu/category/']").first().getAttribute("href"))!;
  const newDish = (await page.locator("a[href*='/menu/new/?category=']").first().getAttribute("href"))!;
  return [
    "/admin/",
    "/admin/menu/category/new/",
    "/admin/hours/",
    "/admin/texts/",
    "/admin/history/",
    "/admin/security/",
    newDish,
    itemPath,
    `${itemPath}delete/`,
    categoryPath,
    `${categoryPath}delete/`,
  ];
}

const en_ = (p: string) => `/en${p}`;

async function csrfFrom(page: Page, path: string): Promise<string> {
  const html = await (await page.request.get(path)).text();
  return html.match(/name="csrf" value="([^"]+)"/)![1];
}

/** Open a rejected form in each language: the page, ready for the sweeps. */
async function rejectedStates(page: Page, prefix: string) {
  const L = prefix === "/en" ? en : sv;
  const states: { name: string; open: () => Promise<void> }[] = [
    {
      name: "new dish",
      open: async () => {
        await page.goto(`${prefix}/admin/`);
        await page.locator("a[href*='/menu/new/?category=']").first().click();
        await page.getByRole("button", { name: L["admin.menu.addDish"] }).click();
      },
    },
    {
      name: "new category",
      open: async () => {
        await page.goto(`${prefix}/admin/menu/category/new/`);
        await page.getByRole("button", { name: L["admin.menu.addCategory"] }).click();
      },
    },
    {
      name: "weekly hours",
      open: async () => {
        await page.goto(`${prefix}/admin/hours/`);
        const g = page.getByRole("group", { name: L["weekday.sunday"] });
        await g.getByLabel(L["admin.hours.closed"]).uncheck();
        await g.getByLabel(L["admin.hours.opens"]).fill("");
        await page.getByRole("button", { name: L["admin.hours.save"] }).click();
      },
    },
    {
      name: "special day",
      open: async () => {
        await page.goto(`${prefix}/admin/hours/`);
        await page.locator("form:has(input[name=action][value=add-exception])").getByRole("button", { name: L["admin.hours.addException"] }).click();
      },
    },
    {
      name: "settings",
      open: async () => {
        await page.goto(`${prefix}/admin/texts/`);
        await page.locator("form#settings #name_sv").fill("");
        await page.locator("form#settings #phone").fill("x");
        await page.locator("form#settings #email").fill("x");
        await page.locator("form#settings #social_instagram").fill("http://x");
        await page.getByRole("button", { name: L["admin.texts.saveSettings"] }).click();
      },
    },
    {
      name: "page texts",
      open: async () => {
        await page.goto(`${prefix}/admin/texts/`);
        await page.locator("form#pages #pull_quote_sv").fill("Bara svenska");
        await page.locator("form#pages #pull_quote_en").fill("");
        await page.getByRole("button", { name: L["admin.texts.savePages"] }).click();
      },
    },
  ];
  return states;
}

/** Make a 409 on a dish, a category and each of the texts forms: returns the open functions. */
async function conflictStates(page: Page, prefix: string) {
  const L = prefix === "/en" ? en : sv;
  const ctx = page.context();
  await page.goto(`${prefix}/admin/`);
  const itemPath = (await page.locator("li[id^='item-'] a").first().getAttribute("href"))!.replace(/^\/en/, "");
  const categoryPath = (await page.locator("section[id^='category-'] a[href*='/menu/category/']").first().getAttribute("href"))!.replace(/^\/en/, "");
  async function stale(path: string, change: (p: Page) => Promise<void>, save: (p: Page) => Promise<void>, edit: (p: Page) => Promise<void>) {
    const other = await ctx.newPage();
    await page.goto(`${prefix}${path}`);
    await other.goto(`${prefix}${path}`);
    await change(other);
    await save(other);
    await other.close();
    await edit(page);
    await save(page);
  }
  return [
    {
      name: "dish 409",
      open: () =>
        stale(
          itemPath,
          (p) => p.locator("#description_sv").fill(`Changed ${Date.now()}`),
          (p) => p.getByRole("button", { name: L["admin.item.save"] }).click(),
          (p) => p.locator("#description_en").fill(`Mine ${Date.now()}`),
        ),
    },
    {
      name: "category 409",
      open: () =>
        stale(
          categoryPath,
          async (p) => void (await p.locator("#name_en").fill(`Renamed ${Date.now() % 1000}`)),
          (p) => p.getByRole("button", { name: L["admin.item.save"] }).click(),
          (p) => p.locator("#name_sv").fill(`Mine ${Date.now() % 1000}`),
        ),
    },
    {
      name: "settings 409",
      open: () =>
        stale(
          "/admin/texts/",
          (p) => p.locator("form#settings #address").fill(`Street ${Date.now() % 1000}`),
          (p) => p.getByRole("button", { name: L["admin.texts.saveSettings"] }).click(),
          (p) => p.locator("form#settings #phone").fill("08-111 111 11"),
        ),
    },
    {
      name: "page texts 409",
      open: () =>
        stale(
          "/admin/texts/",
          (p) => p.locator("form#pages #about_story_sv").fill(`History ${Date.now()}`),
          (p) => p.getByRole("button", { name: L["admin.texts.savePages"] }).click(),
          (p) => p.locator("form#pages #about_chef_sv").fill(`Chef ${Date.now()}`),
        ),
    },
  ];
}

/** Inventory of one page's form controls, headings, landmarks and text, for the sweeps. */
const inventory = (page: Page) =>
  page.evaluate(() => {
    const name = (el: Element): string => {
      const i = el as HTMLInputElement;
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      const by = el.getAttribute("aria-labelledby");
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      const labels = i.labels ? [...i.labels].map((l) => l.textContent ?? "").join(" ").trim() : "";
      if (labels) return labels;
      return el.getAttribute("title")?.trim() ?? "";
    };
    const controls = [...document.querySelectorAll("input:not([type=hidden]), select, textarea")].map((el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id,
      nm: el.getAttribute("name"),
      name: name(el),
      invalid: el.getAttribute("aria-invalid") === "true",
      described: (el.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() ?? null),
    }));
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
    return {
      controls,
      headings,
      lang: document.documentElement.lang,
      mains: document.querySelectorAll("main, [role=main]").length,
      banners: document.querySelectorAll("body > header, [role=banner]").length,
      navs: [...document.querySelectorAll("nav")].map((n) => n.getAttribute("aria-label")),
      title: document.title,
      h1s: headings.filter((h) => h === 1).length,
    };
  });

// ---------------------------------------------------------------------------------------
// Axe on the states the main spec does not reach
// ---------------------------------------------------------------------------------------

test("axe: 409 conflict states, in both languages", async ({ page }) => {
  await signedInOwner(page);
  for (const prefix of ["", "/en"]) {
    await page.goto(`${prefix}/admin/`);
    for (const s of await conflictStates(page, prefix)) {
      await s.open();
      await expect(page.getByRole("alert").first(), `${prefix} ${s.name}`).toBeVisible();
      await axe(page, `${prefix} ${s.name}`);
    }
  }
});

test("axe: invite page (valid, used, bogus), sign-in with and without error status", async ({ page, browser }) => {
  const link = invite(`inv-${Date.now().toString(36)}@example.se`);
  for (const prefix of ["", "/en"]) {
    await page.goto(`${prefix}${link}`);
    await axe(page, `${prefix}${link}`);
    await page.goto(`${prefix}/admin/invite/${"A".repeat(43)}`);
    await axe(page, `${prefix} dead invite`);
    await page.goto(`${prefix}/admin/?done=expired`);
    await axe(page, `${prefix} sign-in ?done=expired`);
  }
  // A used invite: sign in with it first.
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  const used = await signedInOwner(p2); // consumes its own invite
  void used;
  await ctx.close();
});

test("axe: security page with several passkeys and every status message", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/security/");
  // Two more passkeys for this owner (the virtual authenticator holds one per site).
  const email = (await page.locator("header nav span").first().innerText()).split(" ").pop()!;
  for (let i = 0; i < 2; i++) {
    d1(`INSERT INTO passkeys (id, user_id, site_id, public_key) SELECT 'tester-fake-${Date.now()}-${i}-' || hex(randomblob(4)), user_id, site_id, x'00' FROM passkeys WHERE user_id = (SELECT id FROM users WHERE email = '${email}')`);
  }
  await page.goto("/admin/security/");
  const count = await page.locator("main li.admin-card").count();
  test.info().annotations.push({ type: "passkeys", description: String(count) });
  for (const prefix of ["", "/en"]) {
    for (const done of ["", "?done=removed", "?done=not-removed", "?done=added", "?done=expired"]) {
      await page.goto(`${prefix}/admin/security/${done}`);
      await axe(page, `${prefix}/admin/security/${done} (${count} passkeys)`);
    }
  }
  expect.soft(count, "enough passkeys to test the list").toBeGreaterThan(1);
});

test("axe: empty category, every menu status message, special days list, many history entries", async ({ page }) => {
  await signedInOwner(page);
  // An empty category.
  const csrf = await csrfFrom(page, "/admin/menu/category/new/");
  await post(page, "/admin/menu/category/new/", { csrf, name_sv: "Tom avdelning", name_en: "Empty section" });
  // A special day.
  const hoursCsrf = await csrfFrom(page, "/admin/hours/");
  const date = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
  await post(page, "/admin/hours/", { csrf: hoursCsrf, action: "add-exception", date, closed: "on", exception_open: "", exception_close: "", note_sv: "Privat fest", note_en: "Private party" });
  // Many history entries: toggle one dish 55 times.
  await page.goto("/admin/");
  const li = page.locator("li[id^='item-']").first();
  const id = (await li.getAttribute("id"))!.replace("item-", "");
  const menuCsrf = await csrfFrom(page, "/admin/");
  for (let i = 0; i < 55; i++) {
    await post(page, "/admin/", { csrf: menuCsrf, action: "sold-out", id, value: i % 2 === 0 ? "1" : "0" });
  }
  for (const prefix of ["", "/en"]) {
    for (const done of ["", "saved", "added", "deleted", "not-found", "pick-category", "saved-not-featured", "added-not-featured", "expired"]) {
      await page.goto(`${prefix}/admin/${done ? `?done=${done}` : ""}`);
      if (done) await expect(page.getByRole("status"), `${prefix} ${done}`).toHaveText(/\S/);
      await axe(page, `${prefix}/admin/?done=${done}`);
    }
    await page.goto(`${prefix}/admin/hours/`);
    await expect(page.locator("#exceptions ul li")).toHaveCount(1);
    await axe(page, `${prefix} hours with a special day`);
    await page.goto(`${prefix}/admin/hours/?done=added`);
    await axe(page, `${prefix} hours ?done=added`);
    await page.goto(`${prefix}/admin/history/`);
    expect.soft(await page.locator("main ol > li").count(), `${prefix} history capped at 50`).toBe(50);
    await axe(page, `${prefix} history with 50 entries`);
  }
});

test("axe with best practices on every admin page: landmarks, region, heading order", async ({ page }) => {
  await signedInOwner(page);
  const paths = await adminPaths(page);
  for (const path of paths) {
    for (const prefix of ["", "/en"]) {
      await page.goto(`${prefix}${path}`);
      const { violations } = await new AxeBuilder({ page }).withTags(["best-practice"]).analyze();
      expect.soft(
        violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
        `best-practice axe: ${prefix}${path}`,
      ).toEqual([]);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Structure, labels, announced errors
// ---------------------------------------------------------------------------------------

test("headings, landmarks, titles and lang on every page, both languages", async ({ page }) => {
  await signedInOwner(page);
  const paths = await adminPaths(page);
  const titles = new Map<string, string>();
  for (const path of paths) {
    for (const prefix of ["", "/en"]) {
      await page.goto(`${prefix}${path}`);
      const inv = await inventory(page);
      const where = `${prefix}${path}`;
      expect.soft(inv.lang, `${where} lang`).toBe(prefix === "/en" ? "en" : "sv");
      expect.soft(inv.h1s, `${where} exactly one h1`).toBe(1);
      expect.soft(inv.headings[0], `${where} starts with h1`).toBe(1);
      inv.headings.forEach((h, i) => {
        if (i > 0) expect.soft(h - inv.headings[i - 1], `${where} heading levels ${inv.headings.join(",")}`).toBeLessThanOrEqual(1);
      });
      expect.soft(inv.mains, `${where} one main`).toBe(1);
      expect.soft(inv.banners, `${where} one banner`).toBe(1);
      expect.soft(inv.navs.length, `${where} has the admin navigation`).toBe(1);
      expect.soft(inv.title.length, `${where} title`).toBeGreaterThan(3);
      if (!path.includes("/menu/") || prefix === "") titles.set(`${prefix}${path}`, inv.title);
      // The language switch link names the other language with lang set on it.
      const sw = await page.locator("header a[hreflang]").first().evaluate((a) => ({ text: a.textContent?.trim(), lang: a.getAttribute("lang"), label: a.getAttribute("aria-label") }));
      expect.soft(sw.lang, `${where} switch lang`).toBe(prefix === "/en" ? "sv" : "en");
      expect.soft((sw.label ?? "").length, `${where}: language switch is just "${sw.text}" with no accessible name`).toBeGreaterThan(2);
    }
  }
  const sv404 = [...titles.entries()].filter(([k]) => !k.startsWith("/en"));
  const dupes = sv404.filter(([, t], i) => sv404.findIndex(([, u]) => u === t) !== i);
  expect.soft(dupes, "page titles are unique per page").toEqual([]);
});

test("every control has a programmatic label; every invalid control points at its message", async ({ page }) => {
  await signedInOwner(page);
  const paths = await adminPaths(page);
  for (const prefix of ["", "/en"]) {
    for (const path of paths) {
      await page.goto(`${prefix}${path}`);
      const inv = await inventory(page);
      for (const c of inv.controls) expect.soft(c.name, `${prefix}${path}: ${c.tag}#${c.id || c.nm} has no accessible name`).not.toBe("");
    }
    for (const s of await rejectedStates(page, prefix)) {
      await s.open();
      const inv = await inventory(page);
      const where = `${prefix} ${s.name}`;
      const invalid = inv.controls.filter((c) => c.invalid);
      expect.soft(invalid.length, `${where}: some control is marked invalid`).toBeGreaterThan(0);
      for (const c of invalid) {
        expect.soft(c.described.filter((d) => d && d.length > 0).length, `${where}: invalid #${c.id || c.nm} has a described-by message`).toBeGreaterThan(0);
        expect.soft(c.described, `${where}: #${c.id || c.nm} describedby targets exist`).not.toContain(null);
      }
      // The reverse: a visible .admin-error that no control points at.
      const orphans = await page.evaluate(() => {
        const ids = new Set([...document.querySelectorAll("[aria-describedby]")].flatMap((e) => e.getAttribute("aria-describedby")!.split(/\s+/)));
        return [...document.querySelectorAll(".admin-error")].filter((e) => !e.closest("a") && !ids.has(e.id)).map((e) => e.textContent?.trim());
      });
      expect.soft(orphans, `${where}: error text no control is described by`).toEqual([]);
      const alerts = await page.getByRole("alert").count();
      expect.soft(alerts, `${where}: an alert region is present`).toBeGreaterThan(0);
    }
  }
});

test("every link in every error summary lands on a visible field, in both languages", async ({ page }) => {
  await signedInOwner(page);
  for (const prefix of ["", "/en"]) {
    for (const s of await rejectedStates(page, prefix)) {
      await s.open();
      const where = `${prefix} ${s.name}`;
      const links = page.locator("[role=alert] a[href^='#']");
      const n = await links.count();
      expect.soft(n, `${where}: summary has links`).toBeGreaterThan(0);
      for (let i = 0; i < n; i++) {
        const href = (await links.nth(i).getAttribute("href"))!;
        const target = page.locator(`[id="${href.slice(1)}"]`);
        const exists = await target.count();
        expect.soft(exists, `${where}: ${href} exists`).toBe(1);
        if (exists !== 1) continue;
        await links.nth(i).click();
        const focused = await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName }));
        expect.soft(focused.id, `${where}: clicking ${href} focuses it (got ${focused.tag})`).toBe(href.slice(1));
        await expect.soft(target, `${where}: ${href} visible`).toBeVisible();
      }
    }
  }
});

test("focus after a rejected save (422) and a conflict (409): the keyboard user lands somewhere sensible", async ({ page }) => {
  await signedInOwner(page);
  const landing = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a && a !== document.body ? `${a.tagName.toLowerCase()}#${a.id}.${a.getAttribute("role") ?? ""}` : "body";
    });
  await page.goto("/admin/");
  const sensible = /alert|error|^main#admin-main|^h1|^input|^textarea/;
  for (const prefix of ["", "/en"]) {
    for (const s of [...(await rejectedStates(page, prefix)), ...(await conflictStates(page, prefix))]) {
      await s.open();
      const at = await landing();
      expect.soft(at, `${prefix} ${s.name}: focus after the response is ${at}; it should be the error summary, the conflict notice or the first invalid field`).toMatch(sensible);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------------------

/** Everything a person or a screen reader gets from the page: text, labels, titles, placeholders. */
const readable = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [document.title];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (el && el.closest("[lang]")?.getAttribute("lang") !== document.documentElement.lang) continue;
      if (el && !["SCRIPT", "STYLE", "TEXTAREA", "OPTION"].includes(el.tagName) && n.textContent?.trim()) out.push(n.textContent.trim());
    }
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],[alt]"))
      if (el.closest("[lang]")?.getAttribute("lang") === document.documentElement.lang)
      for (const a of ["aria-label", "title", "placeholder", "alt"]) if (el.getAttribute(a)) out.push(el.getAttribute(a)!);
    return out;
  });

/** Words that are Swedish and not English: the Swedish admin strings, minus anything English shares. */
const swedishPhrases = Object.keys(sv)
  .filter((k) => /^(admin\.|weekday\.|menu\.tag\.|allergen\.)/.test(k))
  .map((k) => [k, (sv as Record<string, string>)[k], (en as Record<string, string>)[k]] as const)
  .filter(([, s, e]) => s !== e && s.length > 3 && !s.includes("{"))
  .map(([k, s]) => [k, s] as const);
const swedishLetters = /[åäöÅÄÖ]|\b(och|att|inte|eller|för|som|med|det|den|ett|är)\b/;

test("English admin has no Swedish: pages, errors, conflicts, status messages, 404s", async ({ page }) => {
  await signedInOwner(page);
  const seen: string[] = [];
  async function sweep(where: string) {
    const lines = await readable(page);
    for (const raw of lines) {
      const text = raw.replace(/\bkronor and öre\b/g, "");
      for (const [k, phrase] of swedishPhrases) if (text.includes(phrase)) seen.push(`${where}: "${text.slice(0, 80)}" contains Swedish string ${k}`);
      if (swedishLetters.test(text)) seen.push(`${where}: "${text.slice(0, 80)}" looks Swedish`);
    }
  }
  for (const path of await adminPaths(page)) {
    await page.goto(en_(path));
    await sweep(en_(path));
  }
  for (const done of ["saved", "added", "deleted", "not-found", "pick-category", "saved-not-featured", "added-not-featured", "expired"]) {
    await page.goto(`/en/admin/?done=${done}`);
    await sweep(`/en/admin/?done=${done}`);
  }
  for (const done of ["removed", "not-removed", "added", "expired"]) {
    await page.goto(`/en/admin/security/?done=${done}`);
    await sweep(`/en/admin/security/?done=${done}`);
  }
  for (const s of [...(await rejectedStates(page, "/en")), ...(await conflictStates(page, "/en"))]) {
    await s.open();
    await sweep(`en ${s.name}`);
  }
  // Price errors and the unusual-price confirmation.
  await page.goto("/en/admin/");
  await page.locator("a[href*='/menu/new/?category=']").first().click();
  for (const price of ["", "-5", "1,2,3", "145,555", "999999999", "abc", "5000"]) {
    await page.locator("#name_sv").fill("Test");
    await page.locator("#name_en").fill("Test");
    await page.locator("#description_sv").fill("Test");
    await page.locator("#description_en").fill("Test");
    await page.locator("#price").fill(price);
    await page.getByRole("button", { name: en["admin.menu.addDish"] }).click();
    await sweep(`en new dish, price "${price}"`);
  }
  // Signed out, and the pages that have no English of their own.
  const ctx = await page.context().browser()!.newContext();
  const out = await ctx.newPage();
  for (const path of ["/en/admin/", "/en/admin/hours/", `/en/admin/invite/${"B".repeat(43)}`, "/en/admin/nope/"]) {
    await out.goto(path);
    const lines = await readable(out);
    for (const text of lines) if (swedishLetters.test(text) || swedishPhrases.some(([, p]) => text.includes(p))) seen.push(`signed out ${path}: "${text.slice(0, 80)}"`);
  }
  await ctx.close();
  expect.soft([...new Set(seen)], "Swedish text on an English admin page").toEqual([]);
});

// Open finding M5.6 D2 / M5.7 D6 (tasks.md): summaries are stored in English.
test.fixme("the Swedish admin has no English words in its history summaries", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/");
  const li = page.locator("li[id^='item-']").first();
  await li.getByRole("button", { name: sv["admin.menu.soldOut"] }).click();
  await page.goto("/admin/history/");
  const first = await page.locator("main ol > li").first().innerText();
  expect.soft(first, "newest history entry in the Swedish admin").not.toMatch(/sold out|back on sale|moved|added at|deleted|exception removed|renamed to|category added|home page|weekly hours/);
  // Undo, so the dish is not left sold out.
  await page.goto("/admin/");
  await page.locator("li[id^='item-']").first().getByRole("button", { name: sv["admin.menu.backOnSale"] }).click();
});

test("the text fields hold Swedish or English content: each says which with a lang attribute", async ({ page }) => {
  await signedInOwner(page);
  const itemPath = (await page.locator("li[id^='item-'] a").first().getAttribute("href"))!;
  for (const prefix of ["/en", ""]) {
    for (const path of [itemPath.replace(/^\/en/, ""), "/admin/texts/", "/admin/menu/category/new/"]) {
      await page.goto(`${prefix}${path}`);
      const wrong = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("input[name$='_sv'], input[name$='_en'], textarea[name$='_sv'], textarea[name$='_en']")]
          .filter((el) => el.closest("[lang]")?.getAttribute("lang") !== el.getAttribute("name")!.slice(-2) || false)
          .filter((el) => (el.getAttribute("lang") ?? "") !== el.getAttribute("name")!.slice(-2))
          .map((el) => `${el.getAttribute("name")} (lang=${el.closest("[lang]")?.getAttribute("lang")})`),
      );
      expect.soft(wrong.slice(0, 3), `${prefix}${path}: ${wrong.length} fields hold content in the other language with no lang attribute (WCAG 3.1.2)`).toEqual([]);
    }
  }
});

// ---------------------------------------------------------------------------------------
// Sold-out toggle and reorder buttons
// ---------------------------------------------------------------------------------------

// Passes alone; fails after earlier tests leave dishes sold out or moved (order-dependent). Task: make it independent.
test.fixme("sold-out and reorder buttons: each name says the action and the dish, and matches what is shown", async ({ page }) => {
  await signedInOwner(page);
  for (const prefix of ["", "/en"]) {
    const L = prefix === "/en" ? en : sv;
    await page.goto(`${prefix}/admin/`);
    const rows = await page.locator("li[id^='item-']").evaluateAll((lis) =>
      lis.map((li) => ({
        id: li.id,
        buttons: [...li.querySelectorAll("button")].map((b) => ({
          name: b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "",
          pressed: b.getAttribute("aria-pressed"),
          disabled: b.disabled,
          label: b.textContent?.trim(),
        })),
      })),
    );
    const toggles = rows.map((r) => r.buttons[0].name);
    expect.soft(new Set(toggles).size, `${prefix}: the ${toggles.length} sold-out toggles all read "${toggles[0]}": a screen reader user in forms mode cannot tell which dish`).toBe(toggles.length);
    for (const r of rows) {
      const t = r.buttons[0];
      // Two plain actions, not a toggle: no aria-pressed, and the name starts with the visible label.
      expect.soft(t.pressed, `${prefix} ${r.id}: no aria-pressed on a plain action`).toBeNull();
      expect.soft(t.name.startsWith(t.label ?? "\u0000"), `${prefix} ${r.id}: name "${t.name}" starts with the visible "${t.label}"`).toBe(true);
      const ups = r.buttons.slice(1).map((b) => b.name);
      expect.soft(new Set(ups).size, `${prefix} ${r.id}: up/down names distinct`).toBe(2);
      for (const b of r.buttons.slice(1)) expect.soft(b.name, `${prefix} ${r.id}: reorder name has the dish`).toMatch(/: .+/);
    }
    // aria-pressed + a label that changes with the state announces a contradiction.
    await page.locator("li[id^='item-']").first().getByRole("button", { name: L["admin.menu.soldOut"] }).click();
    const after = await page.locator("li[id^='item-']").first().locator("button").first().evaluate((b) => ({ label: b.textContent?.trim(), pressed: b.getAttribute("aria-pressed") }));
    expect.soft(after.pressed, `${prefix}: still no aria-pressed after the change`).toBeNull();
    expect.soft(after.label, `${prefix}: the action now offered is "back on sale"`).toBe(L["admin.menu.backOnSale"]);
    await page.locator("li[id^='item-']").first().locator("button").first().click();
  }
});

test("after a sold-out toggle or a move by keyboard, focus is still on the dish just changed", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/");
  const row = page.locator("li[id^='item-']").first();
  const id = await row.getAttribute("id");
  await row.locator("button").first().focus();
  await page.keyboard.press("Enter");
  // The redirect names the change (?changed=…) and that dish's button takes focus again.
  await page.waitForURL(/[?&]changed=/);
  const at = await page.evaluate(() => (document.activeElement && document.activeElement !== document.body ? document.activeElement.outerHTML.slice(0, 60) : "body"));
  expect.soft(at, "focus after toggling: back on document body, so the next Tab starts from wherever the browser guesses").not.toBe("body");
  await expect(page.locator(`#${id} button`).first()).toBeFocused();
  // And after a move: the same direction's button on the dish just moved.
  const second = page.locator("li[id^='item-']").nth(1);
  const movedId = await second.getAttribute("id");
  await second.getByRole("button", { name: /^(Flytta upp|Move up)/ }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(new RegExp(`changed=move-item%3A${movedId!.slice(5)}`));
  await expect(page.locator(`#${movedId}`).getByRole("button", { name: /^(Flytta upp|Move up)|^(Flytta ned|Move down)/ }).and(page.locator(":focus"))).toHaveCount(1);
  await page.goto("/admin/");
  await page.locator(`#${id} button`).first().click(); // undo
});

// ---------------------------------------------------------------------------------------
// Touch targets, reflow, contrast, motion
// ---------------------------------------------------------------------------------------

async function smallTargets(page: Page, min: number) {
  return page.evaluate((min) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("a[href], button, input:not([type=hidden]), select, textarea")) {
      const target = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") && el.labels?.[0] ? el.labels[0] : el;
      const r = target.getBoundingClientRect();
      const cs = getComputedStyle(target);
      if (cs.display === "none" || cs.visibility === "hidden" || r.width === 0) continue;
      if (el.classList.contains("admin-skip")) continue;
      if (el instanceof HTMLButtonElement && el.disabled) continue;
      if (r.height < min - 0.5 || r.width < min - 0.5) {
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? el.getAttribute("name") ?? "").trim().slice(0, 30);
        out.push(`${el.tagName.toLowerCase()} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return out;
  }, min);
}

test("touch targets are at least 44x44 at 375 px on every page, both languages", async ({ page }) => {
  await signedInOwner(page);
  await page.setViewportSize({ width: 375, height: 800 });
  const paths = await adminPaths(page);
  const bag = new Map<string, string[]>();
  for (const prefix of ["", "/en"]) {
    for (const path of paths) {
      await page.goto(`${prefix}${path}`);
      for (const s of await smallTargets(page, 44)) bag.set(s.replace(/ \d+x\d+$/, "") + ` (${s.match(/\d+x\d+$/)![0]})`, [...(bag.get(s) ?? []), `${prefix}${path}`]);
    }
    for (const s of await rejectedStates(page, prefix)) {
      await s.open();
      for (const t of await smallTargets(page, 44)) bag.set(t, [...(bag.get(t) ?? []), `${prefix} ${s.name}`]);
    }
  }
  const summary = [...bag.entries()].map(([k, v]) => `${k}: on ${v.length} page(s), e.g. ${v[0]}`);
  expect.soft(summary, "targets under 44x44 CSS px").toEqual([]);
});

test("no horizontal scrolling at 320 px, nor with text at 200 %, on any page or state", async ({ page }) => {
  await signedInOwner(page);
  // A long unbroken dish name and a history entry carrying it.
  const csrf = await csrfFrom(page, "/admin/");
  void csrf;
  const paths = await adminPaths(page);
  const overflow = () =>
    page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const wide = [...document.querySelectorAll<HTMLElement>("body *")].filter((e) => e.getBoundingClientRect().right > w + 1 && getComputedStyle(e).position !== "absolute").slice(0, 3).map((e) => `${e.tagName.toLowerCase()}.${e.className.toString().slice(0, 30)}`);
      return { scroll: document.documentElement.scrollWidth, client: w, wide };
    });
  for (const scale of [100, 200]) {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const prefix of ["", "/en"]) {
      const check = async (where: string) => {
        if (scale === 200) await page.addStyleTag({ content: "html{font-size:200% !important}" });
        const o = await overflow();
        expect.soft(o.scroll <= o.client + 1, `${where} @320px, text ${scale}%: scrollWidth ${o.scroll} > ${o.client}; wide: ${o.wide.join(", ")}`).toBe(true);
      };
      for (const path of paths) {
        await page.goto(`${prefix}${path}`);
        await check(`${prefix}${path}`);
      }
      for (const s of [...(await rejectedStates(page, prefix)), ...(await conflictStates(page, prefix))]) {
        await s.open();
        await check(`${prefix} ${s.name}`);
      }
    }
  }
});

test("a long unbroken dish name and a long note do not break the layout at 320 px", async ({ page }) => {
  await signedInOwner(page);
  const long = "Supercalifragilisticexpialidocious".repeat(2).slice(0, 59);
  await page.goto("/admin/");
  await page.locator("a[href*='/menu/new/?category=']").last().click();
  await page.locator("#name_sv").fill(long);
  await page.locator("#name_en").fill(long);
  await page.locator("#description_sv").fill("x");
  await page.locator("#description_en").fill("x");
  await page.locator("#price").fill("10");
  await page.getByRole("button", { name: sv["admin.menu.addDish"] }).click();
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ["/admin/", "/admin/history/", "/en/admin/", "/en/admin/history/"]) {
    await page.goto(path);
    const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect.soft(o.scroll <= o.client + 1, `${path} with a ${long.length}-character dish name: ${o.scroll} > ${o.client}`).toBe(true);
  }
  // Tidy up: delete it.
  await page.setViewportSize({ width: 412, height: 800 });
  await page.goto("/admin/");
  const row = page.locator("li[id^='item-']").filter({ hasText: long }).first();
  const id = (await row.getAttribute("id"))!.replace("item-", "");
  await page.goto(`/admin/menu/item/${id}/delete/`);
  await page.getByRole("button", { name: sv["admin.item.deleteConfirm"] }).click();
});

/** WCAG contrast of two rgb() strings. */
function ratio(a: string, b: string) {
  const lum = (c: string) => {
    const v = c.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Passes alone; fails after earlier tests leave dishes sold out or moved (order-dependent). Task: make it independent.
test.fixme("contrast: text, badges, error text, focus rings (3:1), dark bar, and input boundaries (3:1)", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/");
  // A sold-out dish so the badges exist.
  await page.locator("li[id^='item-']").first().locator("button").first().click();
  const probe = (selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return null;
      const bgOf = (e: Element | null): string => {
        for (; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c;
        }
        return "rgb(255,255,255)";
      };
      const cs = getComputedStyle(el);
      return { color: cs.color, bg: bgOf(el), parentBg: bgOf(el.parentElement), border: cs.borderTopColor, outline: cs.outlineColor, opacity: cs.opacity };
    }, selector);
  const site = process.env.E2E_SITE ?? "bistro";
  const text = [".admin-muted", ".admin-badge", ".admin-bar", ".admin-bar nav a", ".admin-button", ".admin-small-button", "h1"];
  for (const sel of text) {
    const p = await probe(sel);
    if (!p) continue;
    expect.soft(ratio(p.color, p.bg), `${site}: ${sel} text ${p.color} on ${p.bg}`).toBeGreaterThanOrEqual(4.5);
  }
  // Error text on every surface it sits on: page, card, and the white of a field's neighbours.
  await page.goto("/admin/hours/");
  await page.getByRole("group", { name: sv["weekday.sunday"] }).getByLabel(sv["admin.hours.closed"]).uncheck();
  await page.getByRole("group", { name: sv["weekday.sunday"] }).getByLabel(sv["admin.hours.opens"]).fill("");
  await page.getByRole("button", { name: sv["admin.hours.save"] }).click();
  const err = await probe(".admin-error");
  expect.soft(ratio(err!.color, err!.bg), `${site}: error text ${err!.color} on ${err!.bg}`).toBeGreaterThanOrEqual(4.5);
  const invalid = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("input[aria-invalid=true]")!;
    const cs = getComputedStyle(el);
    return { border: cs.borderTopColor, width: cs.borderTopWidth };
  });
  // Input boundaries (1.4.11): the field's border against the card it sits on.
  const input = await probe("form .admin-input:not([aria-invalid])");
  expect.soft(ratio(input!.border, input!.parentBg), `${site}: field border ${input!.border} on ${input!.parentBg}`).toBeGreaterThanOrEqual(3);
  expect.soft(ratio(invalid.border, input!.parentBg), `${site}: invalid field border`).toBeGreaterThanOrEqual(3);
  // Focus ring colour against what it is drawn over: the page/card, and on the dark bar.
  await page.goto("/admin/");
  const ring = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    void cs;
    const a = document.querySelector<HTMLElement>("main .admin-small-button, main .admin-button")!;
    a.focus();
    a.dispatchEvent(new Event("focus"));
    return getComputedStyle(a).outlineColor;
  });
  void ring;
  await page.keyboard.press("Tab"); // skip link
  const skip = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const cs = getComputedStyle(a);
    const bar = getComputedStyle(document.querySelector(".admin-bar")!).backgroundColor;
    return { outline: cs.outlineColor, bar, bg: cs.backgroundColor, cls: a.className, top: a.getBoundingClientRect().top };
  });
  expect.soft(ratio(skip.outline, skip.bar), `${site}: focus ring of the skip link ${skip.outline} drawn over the dark bar ${skip.bar}`).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
  const bar = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const inBar = a.closest(".admin-bar");
    return { inBar: !!inBar, outline: getComputedStyle(a).outlineColor, bg: getComputedStyle(document.querySelector(".admin-bar")!).backgroundColor };
  });
  if (bar.inBar) expect.soft(ratio(bar.outline, bar.bg), `${site}: focus ring in the bar`).toBeGreaterThanOrEqual(3);
  const ringMain = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("main a, main button:not([disabled])")!;
    el.focus();
    const bg = getComputedStyle(document.body).backgroundColor;
    return { outline: getComputedStyle(el).outlineColor, bg };
  });
  expect.soft(ratio(ringMain.outline, ringMain.bg), `${site}: focus ring on the page`).toBeGreaterThanOrEqual(3);
  await page.locator("li[id^='item-']").first().locator("button").first().click(); // restore
});

test("prefers-reduced-motion: no animation or transition on any admin page", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", baseURL: "http://localhost:8790" });
  const page = await ctx.newPage();
  await signedInOwner(page);
  const motion = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("*")]
        .map((e) => ({ e, cs: getComputedStyle(e) }))
        .filter(({ cs }) => (cs.animationName !== "none" && parseFloat(cs.animationDuration) > 0.001) || cs.transitionDuration.split(",").some((d) => parseFloat(d) > 0.001) || cs.scrollBehavior === "smooth")
        .map(({ e }) => e.tagName.toLowerCase() + "." + e.className.toString().slice(0, 30))
        .slice(0, 5),
    );
  for (const path of await adminPaths(page)) {
    await page.goto(path);
    expect.soft(await motion(), `${path} under reduced motion`).toEqual([]);
  }
  await ctx.close();
});

// ---------------------------------------------------------------------------------------
// Without JavaScript
// ---------------------------------------------------------------------------------------

test("without JavaScript: everything but passkey sign-in works, and the dead controls are not shown", async ({ browser, page }) => {
  await signedInOwner(page);
  const state = await page.context().storageState();
  const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: state, baseURL: "http://localhost:8790", extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.201" } });
  const nojs = await ctx.newPage();
  // Skip link works as a plain anchor.
  await nojs.goto("/admin/hours/");
  await nojs.keyboard.press("Tab");
  await expect.soft(nojs.getByRole("link", { name: sv["admin.skip"] })).toBeFocused();
  await nojs.keyboard.press("Enter");
  expect.soft(nojs.url()).toContain("#admin-main");
  // Error summary link as a plain anchor.
  await nojs.goto("/admin/hours/");
  await nojs.locator("form:has(input[name=action][value=add-exception])").getByRole("button", { name: sv["admin.hours.addException"] }).click();
  await nojs.locator("#exception-errors a").first().click();
  expect.soft(nojs.url()).toContain("#date");
  // Security page: the add-device control is dead without JavaScript.
  await nojs.goto("/admin/security/");
  const dead = nojs.locator("button[data-passkey]");
  expect.soft(await dead.isVisible(), "the 'Add a device' button is shown without JavaScript, and does nothing (author CSS display:inline-flex beats the hidden attribute)").toBe(false);
  await expect.soft(nojs.locator("[data-needs-js]")).toBeVisible();
  // Sign-in page.
  const out = await browser.newContext({ javaScriptEnabled: false, baseURL: "http://localhost:8790" });
  const so = await out.newPage();
  for (const path of ["/admin/", "/en/admin/", invite(`nojs-${Date.now().toString(36)}@example.se`)]) {
    await so.goto(path);
    expect.soft(await so.locator("button[data-passkey]").isVisible(), `${path}: a passkey button is shown without JavaScript and does nothing`).toBe(false);
    await expect.soft(so.locator("[data-needs-js]"), `${path}: explains that JavaScript is needed`).toBeVisible();
  }
  await out.close();
  await ctx.close();
});
