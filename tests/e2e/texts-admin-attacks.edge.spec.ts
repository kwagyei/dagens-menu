/**
 * Tester, M5.5: the texts admin attacked over HTTP against the built bistro Worker: hostile
 * links, smuggled fields, values the form accepts but D1 refuses, markup on every public
 * surface, independent row_versions, CSRF, English admin, 375 px, no JavaScript.
 * Every test that saves puts the original values back in a finally block.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { freshIp, signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
type Fields = Record<string, string>;

// One real sign-in per run (a passkey ceremony per test trips the sign-in rate limit), kept in
// a file because Playwright restarts the worker after a failing test and loses module state.
type Session = Awaited<ReturnType<ReturnType<Page["context"]>["storageState"]>>;
const SESSION_FILE = join("test-results", ".tester-m5-texts-session.json");
async function owner(page: Page, browser: Browser) {
  let session: Session | undefined = existsSync(SESSION_FILE) ? JSON.parse(readFileSync(SESSION_FILE, "utf-8")) : undefined;
  if (session) {
    const probe = await browser.newContext({ baseURL: BASE });
    await probe.addCookies(session.cookies);
    const res = await probe.request.get("/admin/texts/", { maxRedirects: 0 });
    await probe.close();
    if (res.status() !== 200) session = undefined;
  }
  if (!session) {
    const first = await browser.newContext({ baseURL: BASE });
    await signedInOwner(await first.newPage());
    session = await first.storageState();
    await first.close();
    mkdirSync("test-results", { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(session));
  }
  await page.context().addCookies(session.cookies);
  await page.context().setExtraHTTPHeaders({ "CF-Connecting-IP": freshIp() });
}

/** Every named field of a form on the page, as the browser would post it. */
async function readForm(page: Page, id: "settings" | "pages", path = "/admin/texts/"): Promise<Fields> {
  await page.goto(path);
  return page.locator(`form#${id}`).evaluate((form) => Object.fromEntries(new FormData(form as HTMLFormElement) as unknown as Iterable<[string, string]>));
}
const post = (page: Page, form: Fields, path = "/admin/texts/") => page.request.post(path, { form, maxRedirects: 0, headers: { Origin: BASE } });
const settingsDefaults = (f: Fields): Fields => f;

async function snapshot(page: Page) {
  const settings = await readForm(page, "settings");
  const pages = await readForm(page, "pages");
  return { settings, pages };
}
async function restore(page: Page, snap: { settings: Fields; pages: Fields }) {
  for (const id of ["settings", "pages"] as const) {
    const fresh = await readForm(page, id);
    await post(page, { ...snap[id], csrf: fresh.csrf, row_version: fresh.row_version });
  }
}
const jsonLd = async (page: Page, path: string) => {
  await page.goto(path);
  const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}");
  // The menu page carries the restaurant and its menu as one graph: read the restaurant.
  return ld["@graph"] ? ld["@graph"].find((node: { "@type": string }) => node["@type"] === "Restaurant") : ld;
};
const meta = (page: Page, property: string) => page.locator(`meta[property="${property}"]`).getAttribute("content");

test("hostile social links over raw POST: 422, nothing saved, nothing in the footer", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://instagram.com/x",
      "//instagram.com/x",
      "https://insta gram.com",
      'https://x.se/"onmouseover="alert(1)',
      "https://x.se/<script>",
    ]) {
      const fresh = await readForm(page, "settings");
      const res = await post(page, { ...fresh, social_instagram: bad });
      expect(res.status(), bad).toBe(422);
      expect(await res.text(), bad).toContain("Länken måste börja med https://.");
    }
    await page.goto("/");
    const hrefs = await page.locator("footer a[target=_blank]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.every((h) => h?.startsWith("https://"))).toBe(true);
    expect(hrefs.join()).not.toContain("javascript");
  } finally {
    await restore(page, snap);
  }
});

test("a saved link is rendered with noopener, target=_blank and an escaped href", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    const fresh = await readForm(page, "settings");
    const res = await post(page, { ...fresh, social_tiktok: "https://tiktok.com/@x?a=1&b=2#top", social_facebook: "https://biströ.se/meny" });
    expect(res.status()).toBe(303);
    await page.goto("/en/");
    // Social links are icons (PR B): find TikTok by its accessible name.
    const tik = page.getByRole("contentinfo").getByRole("link", { name: /TikTok/ });
    await expect(tik).toHaveAttribute("href", "https://tiktok.com/@x?a=1&b=2#top");
    await expect(tik).toHaveAttribute("rel", /noopener/);
    await expect(tik).toHaveAttribute("target", "_blank");
    const html = await (await page.request.get("/en/")).text();
    expect(html).not.toMatch(/href="https:\/\/tiktok\.com\/@x\?a=1&b=2/); // raw & in an attribute: should be &amp;
  } finally {
    await restore(page, snap);
  }
});

test("a very long social link is refused with 422, not stored", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    const fresh = await readForm(page, "settings");
    const res = await post(page, { ...fresh, social_instagram: `https://x.se/${"a".repeat(300_000)}` });
    expect(res.status()).toBe(422);
  } finally {
    await restore(page, snap);
  }
});

test("a phone number with an interior non-breaking space, tab or wide space is saved with a plain space, not a 500", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    for (const phone of ["070 1234567", "070\t1234567", "070　1234567"]) {
      const fresh = await readForm(page, "settings");
      const res = await post(page, { ...fresh, phone });
      expect(res.status(), JSON.stringify(phone)).toBe(303);
      expect((await readForm(page, "settings")).phone, JSON.stringify(phone)).toBe("070 1234567");
    }
  } finally {
    await restore(page, snap);
  }
});

test("booking, map and embed fields in a raw POST change nothing the public sees", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  const before = { book: await (await page.request.get("/book/")).text(), contact: await (await page.request.get("/contact/")).text() };
  try {
    const fresh = await readForm(page, "settings");
    const res = await post(page, {
      ...fresh,
      booking_provider: "embed",
      booking_embed_code: "<script src=https://evil.example/x.js></script>",
      booking_url: "https://evil.example/",
      map_embed: "https://evil.example/map",
      mapEmbed: "https://evil.example/map",
      embed: "<iframe src=https://evil.example>",
      social_youtube: "https://evil.example/",
      __proto__: "x",
      "booking[provider]": "embed",
    });
    expect(res.status()).toBe(303);
    const after = { book: await (await page.request.get("/book/")).text(), contact: await (await page.request.get("/contact/")).text() };
    expect(after.book).toBe(before.book);
    expect(after.contact).toBe(before.contact);
    expect(after.book + after.contact).not.toContain("evil.example");
    await page.goto("/");
    expect(await page.locator("footer a[href*='evil']").count()).toBe(0);
  } finally {
    await restore(page, snap);
  }
});

test("markup and invisible characters in the name are inert on every public surface", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  const payload = `<img src=x onerror=alert(1)>"'&</script><script>alert(2)</script>`;
  let dialogs = 0;
  page.on("dialog", async (d) => {
    dialogs++;
    await d.dismiss();
  });
  try {
    const fresh = await readForm(page, "settings");
    const res = await post(page, {
      ...fresh,
      name_sv: `${payload}‮​`,
      name_en: `EN ${payload}`,
      tagline_sv: `T ${payload}`,
      cuisine_sv: `C ${payload}`,
      address: `A ${payload}`,
    });
    expect(res.status()).toBe(303);
    for (const path of ["/", "/en/", "/menu/", "/about/", "/contact/", "/en/contact/", "/privacy/"]) {
      const html = await (await page.request.get(path)).text();
      expect(html, path).not.toMatch(/[‮​]/);
      await page.goto(path);
      expect(await page.locator("img[src='x']").count(), path).toBe(0);
      expect(
        await page.locator("script").evaluateAll((els) => els.filter((e) => /alert\(2\)/.test(e.textContent ?? "") && e.getAttribute("type") !== "application/ld+json").length),
        path,
      ).toBe(0);
      const ld = await jsonLd(page, path);
      const sv = !path.startsWith("/en");
      expect(ld.name, path).toContain(sv ? "<img src=x" : "EN <img src=x");
      expect(await meta(page, "og:site_name"), path).toContain("<img src=x");
      expect(await page.title(), path).toContain("<img src=x");
      // Home has no header bar since PR B: the name is the hero's H1 (in an SVG's aria-label on the modern look).
      const nameSurface =
        (await page.locator("header").count()) > 0
          ? await page.locator("header").first().textContent()
          : await page.locator("#page-title").evaluate((el) => `${el.textContent} ${el.querySelector("[aria-label]")?.getAttribute("aria-label") ?? ""}`);
      expect(nameSurface, path).toContain("<img src=x");
      expect(await page.getByRole("contentinfo").textContent(), path).toContain("<img src=x");
    }
    expect(dialogs).toBe(0);
    // The owner's own page escapes it too.
    await page.goto("/admin/texts/");
    expect(await page.locator("img[src='x']").count()).toBe(0);
    await expect(page.getByLabel("Namn på svenska")).toHaveValue(new RegExp(`^<img src=x onerror=alert\\(1\\)>"'&</script>`));
    expect(dialogs).toBe(0);
  } finally {
    await restore(page, snap);
  }
});

test("every change shows on the next request, sv and en, in header, footer, title, OG, JSON-LD and the page bodies", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    const fresh = await readForm(page, "settings");
    const res = await post(page, {
      ...fresh,
      name_sv: "Nya Namnet",
      name_en: "New Name",
      tagline_sv: "Ny beskrivning sv",
      tagline_en: "New description en",
      cuisine_sv: "Ny kök",
      cuisine_en: "New cuisine",
      address: "Nygatan 9, 111 22 Stockholm",
      phone: "+46 8 765 43 21",
      email: "ny@nytt.se",
    });
    expect(res.status()).toBe(303);
    const pg = await readForm(page, "pages");
    const res2 = await post(page, {
      ...pg,
      home_tagline_sv: "Ny rubrik sv",
      home_tagline_en: "New headline en",
      about_story_sv: "Ny historia sv",
      about_story_en: "New story en",
      about_chef_sv: "Ny kock sv",
      about_chef_en: "New chef en",
    });
    expect(res2.status()).toBe(303);
    for (const [path, name, tagline, cuisine] of [
      ["/", "Nya Namnet", "Ny beskrivning sv", "Ny kök"],
      ["/en/", "New Name", "New description en", "New cuisine"],
    ] as const) {
      const ld = await jsonLd(page, path);
      expect(ld).toMatchObject({ name, servesCuisine: cuisine, telephone: "+46 8 765 43 21", email: "ny@nytt.se" });
      expect(ld.address.streetAddress).toBe("Nygatan 9, 111 22 Stockholm");
      expect(await meta(page, "og:site_name")).toBe(name);
      expect(await page.title()).toContain(name);
      // Home has no header bar since PR B: the name is the hero's H1.
      await expect(page.locator("#page-title")).toHaveAccessibleName(name);
      const footer = page.getByRole("contentinfo");
      await expect(footer).toContainText(name);
      await expect(footer).toContainText("Nygatan 9");
      await expect(footer).toContainText(tagline);
      await expect(footer.locator("a[href='tel:+46 8 765 43 21'], a[href^='tel:']").first()).toContainText("+46 8 765 43 21");
      await expect(footer.locator("a[href='mailto:ny@nytt.se']")).toHaveCount(1);
    }
    await page.goto("/menu/");
    await expect(page.locator("header")).toContainText("Nya Namnet");
    await page.goto("/en/menu/");
    await expect(page.locator("header")).toContainText("New Name");
    await page.goto("/");
    await expect(page.locator("main")).toContainText("Ny rubrik sv");
    await page.goto("/en/");
    await expect(page.locator("main")).toContainText("New headline en");
    await page.goto("/about/");
    await expect(page.locator("main")).toContainText("Ny historia sv");
    await expect(page.locator("main")).toContainText("Ny kock sv");
    await page.goto("/en/about/");
    await expect(page.locator("main")).toContainText("New story en");
    await expect(page.locator("main")).toContainText("New chef en");
    await page.goto("/contact/");
    await expect(page.locator("main")).toContainText("Nygatan 9");
  } finally {
    await restore(page, snap);
  }
});

test("a conflict on one form keeps the other's save, keeps every typed value, and answers 409", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    const stale = await readForm(page, "settings"); // the tab the owner left open
    const stalePages = await readForm(page, "pages");
    // Another tab saves settings.
    const other = await readForm(page, "settings");
    expect((await post(page, { ...other, phone: "08-111 111 11" })).status()).toBe(303);
    // The stale pages form still saves: its own version is untouched.
    expect((await post(page, { ...stalePages, home_tagline_sv: "Sparad trots konflikt" })).status()).toBe(303);
    // The stale settings form conflicts and keeps what was typed, and the page shows the pages save.
    const res = await post(page, { ...stale, phone: "08-222 222 22", address: "Skriven adress 1" });
    expect(res.status()).toBe(409);
    const html = await res.text();
    expect(html).toContain("Någon annan sparade här nyss");
    expect(html).toContain('value="08-222 222 22"');
    expect(html).toContain('value="Skriven adress 1"');
    expect(html).toContain("Sparad trots konflikt");
    // Stored phone is the other tab's.
    await page.goto("/admin/texts/");
    await expect(page.getByLabel("Telefon")).toHaveValue("08-111 111 11");
    // Saving again from the 409 page (current version) overwrites knowingly.
    const m = html.match(/name="row_version" value="(\d+)"/g)!;
    expect(m.length).toBe(2);

    // And the other way round: stale pages conflict does not touch settings.
    const stale2 = await readForm(page, "pages");
    const cur = await readForm(page, "pages");
    expect((await post(page, { ...cur, about_chef_sv: "Kock ett" })).status()).toBe(303);
    const r2 = await post(page, { ...stale2, about_chef_sv: "Kock två", home_tagline_en: "Typed headline" });
    expect(r2.status()).toBe(409);
    const h2 = await r2.text();
    expect(h2).toContain("Kock två");
    expect(h2).toContain("Typed headline");
    await page.goto("/admin/texts/");
    await expect(page.getByLabel("Telefon")).toHaveValue("08-111 111 11");
    await expect(page.getByLabel("Vår kock, svenska").or(page.locator("#about_chef_sv"))).toHaveValue("Kock ett");
  } finally {
    await restore(page, snap);
  }
  void browser;
});

test("row_version garbage, missing or from the other form never throws", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    const s = await readForm(page, "settings");
    for (const rv of ["", "abc", "-1", "99999999999999999999", "1.5", "0x1", " 1"]) {
      const res = await post(page, { ...s, row_version: rv, phone: "08-444 444 44" });
      expect([409, 422], `row_version ${JSON.stringify(rv)}`).toContain(res.status());
    }
    const { row_version: _drop, ...noVersion } = s;
    expect([409, 422]).toContain((await post(page, { ...noVersion, phone: "08-444 444 44" })).status());
    await page.goto("/admin/texts/");
    await expect(page.getByLabel("Telefon")).not.toHaveValue("08-444 444 44");
  } finally {
    await restore(page, snap);
  }
});

test("unknown or missing action: a clear 'form expired' style message, nothing saved", async ({ page, browser }) => {
  await owner(page, browser);
  await page.goto("/admin/texts/");
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  for (const form of <Fields[]>[{ csrf }, { csrf, action: "" }, { csrf, action: "bogus" }, { csrf, action: "settings ", name_sv: "x" }, { csrf, action: "SETTINGS" }]) {
    const res = await post(page, form);
    expect(res.status()).toBe(303);
    expect(res.headers().location).toBe("/admin/texts/?done=expired");
  }
  await page.goto("/admin/texts/?done=expired");
  // The message must not tell a restaurant owner that something "was deleted".
  await expect(page.getByRole("status")).not.toContainText("tagit bort");
  await expect(page.getByRole("status")).not.toContainText("deleted");
});

test("CSRF: both forms refuse a missing or wrong token and a foreign Origin, and save nothing", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    for (const id of ["settings", "pages"] as const) {
      const f = await readForm(page, id);
      const change: Fields = id === "settings" ? { phone: "08-555 555 55" } : { home_tagline_sv: "CSRF-rubrik" };
      const { csrf: _c, ...noToken } = f;
      for (const form of <Fields[]>[
        { ...noToken, ...change },
        { ...f, ...change, csrf: "x".repeat(43) },
        { ...f, ...change, csrf: "" },
      ]) {
        const res = await post(page, form);
        expect(res.status(), id).toBe(303);
        expect(res.headers().location).toContain("done=expired");
      }
      const foreign = await page.request.post("/admin/texts/", { form: { ...f, ...change }, maxRedirects: 0, headers: { Origin: "https://evil.example" } });
      expect(foreign.status(), id).toBe(403);
      const noOrigin = await page.request.post("/admin/texts/", { form: { ...f, ...change }, maxRedirects: 0 });
      expect([303, 403], id).toContain(noOrigin.status());
    }
    await page.goto("/admin/texts/");
    await expect(page.getByLabel("Telefon")).not.toHaveValue("08-555 555 55");
    await expect(page.locator("#home_tagline_sv")).not.toHaveValue("CSRF-rubrik");
  } finally {
    await restore(page, snap);
  }
});

test("signed out: GET and POST on /admin/texts/ never reach the forms", async ({ browser }) => {
  const anon = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.240" } });
  const get = await anon.request.get("/admin/texts/", { maxRedirects: 0 });
  expect([302, 303, 401, 403]).toContain(get.status());
  expect(await get.text()).not.toContain('name="row_version"');
  const res = await anon.request.post("/admin/texts/", { form: { action: "settings", phone: "08-666 666 66" }, maxRedirects: 0, headers: { Origin: BASE } });
  expect([302, 303, 401, 403]).toContain(res.status());
  const en = await anon.request.get("/en/admin/texts/", { maxRedirects: 0 });
  expect([302, 303, 401, 403]).toContain(en.status());
  const bad = await anon.request.get("/fr/admin/texts/", { maxRedirects: 0 });
  expect(bad.status()).toBe(404);
  await anon.close();
});

test("English admin: labels in English, saves and errors stay under /en/admin/", async ({ page, browser }) => {
  await owner(page, browser);
  await page.goto("/en/admin/texts/");
  await expect(page.getByRole("heading", { name: "Texts and contact", level: 1 })).toBeVisible();
  const snap = await snapshot(page);
  try {
    const f = await readForm(page, "settings", "/en/admin/texts/");
    const bad = await post(page, { ...f, social_facebook: "http://x.se/", email: "nope" }, "/en/admin/texts/");
    expect(bad.status()).toBe(422);
    const html = await bad.text();
    expect(html).toContain("The link must start with https://.");
    expect(html).toContain("Enter an email address");
    expect(html).toContain('value="nope"');
    expect(html).toContain('value="http://x.se/"');
    const ok = await post(page, { ...f, phone: "08-777 777 77" }, "/en/admin/texts/");
    expect(ok.status()).toBe(303);
    expect(ok.headers().location).toBe("/en/admin/texts/?done=saved#settings");
    const pf = await readForm(page, "pages", "/en/admin/texts/");
    const okPages = await post(page, { ...pf, home_tagline_en: "English-admin headline" }, "/en/admin/texts/");
    expect(okPages.headers().location).toBe("/en/admin/texts/?done=saved#pages");
    await page.goto("/en/admin/texts/?done=saved");
    await expect(page.getByRole("status")).toHaveText("Saved.");
    const hrefs = await page.locator("nav a:not([hreflang]), header a:not([hreflang])").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.filter((h) => h?.includes("admin")).every((h) => h?.startsWith("/en/admin/"))).toBe(true);
  } finally {
    await restore(page, snap);
  }
});

test("a rejected form keeps every typed value in both forms (422)", async ({ page, browser }) => {
  await owner(page, browser);
  await page.goto("/admin/texts/");
  const s = page.locator("form#settings");
  await s.getByLabel("Namn på svenska").fill("Skrivet namn");
  await s.getByLabel("Adress").fill("Skriven adress");
  await s.getByLabel("E-post").fill("inte-en-epost");
  await s.getByLabel("Instagram").fill("javascript:alert(1)");
  await s.getByLabel("TikTok").fill("https://tiktok.com/@fin");
  await s.getByRole("button", { name: "Spara restaurangen" }).click();
  await expect(page.locator("#email-error")).toBeVisible();
  await expect(page.locator("#social_instagram-error")).toBeVisible();
  await expect(s.getByLabel("Namn på svenska")).toHaveValue("Skrivet namn");
  await expect(s.getByLabel("Adress")).toHaveValue("Skriven adress");
  await expect(s.getByLabel("E-post")).toHaveValue("inte-en-epost");
  await expect(s.getByLabel("Instagram")).toHaveValue("javascript:alert(1)");
  await expect(s.getByLabel("TikTok")).toHaveValue("https://tiktok.com/@fin");
  await expect(s.locator("[role=alert] a").first()).toBeVisible();

  const p = page.locator("form#pages");
  await p.locator("#home_tagline_sv").fill("Skriven rubrik");
  await p.locator("#pull_quote_sv").fill("Bara ett språk");
  await p.locator("#pull_quote_en").fill("");
  await p.locator("#about_story_en").fill("Typed story\nwith a second line");
  await p.getByRole("button", { name: "Spara texterna" }).click();
  await expect(page.locator("#pull_quote_en-error")).toBeVisible();
  await expect(page.locator("form#pages #home_tagline_sv")).toHaveValue("Skriven rubrik");
  await expect(page.locator("form#pages #pull_quote_sv")).toHaveValue("Bara ett språk");
  await expect(page.locator("form#pages #about_story_en")).toHaveValue("Typed story\nwith a second line");
  // The settings form beside it shows the stored values, not the rejected ones.
  await expect(page.locator("form#settings").getByLabel("Namn på svenska")).not.toHaveValue("Skrivet namn");
});

test("the browser's maxlength does not stop an owner typing a name the server accepts (80 emoji)", async ({ page, browser }) => {
  await owner(page, browser);
  await page.goto("/admin/texts/");
  const name = page.locator("form#settings").getByLabel("Namn på svenska");
  await name.fill("");
  await name.pressSequentially("😀".repeat(50)); // 50 characters, 100 UTF-16 units; the limit is 80 characters
  const kept = await name.evaluate((el) => [...new Intl.Segmenter("sv", { granularity: "grapheme" }).segment((el as HTMLInputElement).value)].length);
  expect(kept).toBe(50);
});

test("375 px: no sideways scroll, controls are at least 44 px tall, error links are tappable", async ({ page, browser }) => {
  await owner(page, browser);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/admin/texts/");
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  const small = async (selector: string) =>
    page.locator(selector).evaluateAll((els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { id: (el as HTMLElement).id || el.textContent?.trim().slice(0, 30) || el.tagName, w: Math.round(r.width), h: Math.round(r.height) };
        })
        .filter((b) => b.h < 44 || b.w < 44),
    );
  expect(await small("main input:not([type=hidden]), main textarea, main button")).toEqual([]);
  // With errors showing, the summary links must be tappable too.
  await page.locator("form#settings").getByLabel("E-post").fill("nope");
  await page.locator("form#settings").getByLabel("Facebook").fill("http://x.se");
  await page.getByRole("button", { name: "Spara restaurangen" }).click();
  await expect(page.locator("form#settings [role=alert] a").first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  expect(await small("form#settings [role=alert] a")).toEqual([]);
  // A long unbroken value does not push the page sideways.
  await page
    .locator("form#settings")
    .getByLabel("Instagram")
    .fill(`https://x.se/${"a".repeat(300)}`);
  await page.locator("form#pages #about_story_sv").fill("b".repeat(600));
  expect(await overflow()).toBeLessThanOrEqual(0);
});

test("without JavaScript both forms save, and an error comes back filled in", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    baseURL: BASE,
    storageState: await page.context().storageState(),
    extraHTTPHeaders: { "CF-Connecting-IP": "192.0.2.241" },
  });
  const p = await noJs.newPage();
  try {
    await p.goto("/admin/texts/");
    await p.locator("form#settings").getByLabel("Telefon").fill("08-888 888 88");
    await p.getByRole("button", { name: "Spara restaurangen" }).click();
    await expect(p.getByRole("status")).toHaveText("Sparat.");
    await expect(p.locator("form#settings").getByLabel("Telefon")).toHaveValue("08-888 888 88");
    await p.locator("form#pages #home_tagline_en").fill("No-JS headline");
    await p.getByRole("button", { name: "Spara texterna" }).click();
    await expect(p.getByRole("status")).toHaveText("Sparat.");
    await p.locator("form#settings").getByLabel("Facebook").fill("http://x.se");
    await p.getByRole("button", { name: "Spara restaurangen" }).click();
    await expect(p.locator("#social_facebook-error")).toBeVisible();
    await expect(p.locator("form#settings").getByLabel("Facebook")).toHaveValue("http://x.se");
    await p.goto("/en/");
    await expect(p.locator("main")).toContainText("No-JS headline");
  } finally {
    await noJs.close();
    await restore(page, snap);
  }
});

test("removing the pull quote over HTTP: the home page loses it in both languages and the form shows it empty", async ({ page, browser }) => {
  await owner(page, browser);
  const snap = await snapshot(page);
  try {
    const f = await readForm(page, "pages");
    test.skip(!f.pull_quote_sv, "the seeded site has no pull quote");
    const res = await post(page, { ...f, pull_quote_sv: " ​ ", pull_quote_en: "\n" });
    expect(res.status()).toBe(303);
    for (const path of ["/", "/en/"]) {
      await page.goto(path);
      await expect(page.locator("main")).not.toContainText(f.pull_quote_sv);
      await expect(page.locator("main")).not.toContainText(f.pull_quote_en);
      await expect(page.locator("blockquote")).toHaveCount(0);
    }
    await page.goto("/admin/texts/");
    await expect(page.locator("#pull_quote_sv")).toHaveValue("");
    await expect(page.locator("#pull_quote_en")).toHaveValue("");
  } finally {
    await restore(page, snap);
  }
  void settingsDefaults;
});
