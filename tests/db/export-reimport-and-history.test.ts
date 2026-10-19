/**
 * Tester, M5.6: the owner's export and the change history at the repository level (workerd +
 * D1). The acceptance criterion is "the export re-imports": export → read back → reset and
 * seed → export must give the same content after every kind of owner edit. Also: what the
 * file leaves out, tampered files, and the history's ordering, limit and site isolation.
 */
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import bistroGallery from "../../sites/bistro/content/gallery.json";
import bistroImages from "../../sites/bistro/content/images.json";
import bistroHours from "../../sites/bistro/content/hours.json";
import bistroMenu from "../../sites/bistro/content/menu.json";
import bistroPages from "../../sites/bistro/content/pages.json";
import bistroSettings from "../../sites/bistro/content/settings.json";
import bistroTheme from "../../sites/bistro/theme.json";
import waGallery from "../../sites/westafrican/content/gallery.json";
import waImages from "../../sites/westafrican/content/images.json";
import waHours from "../../sites/westafrican/content/hours.json";
import waMenu from "../../sites/westafrican/content/menu.json";
import waPages from "../../sites/westafrican/content/pages.json";
import waSettings from "../../sites/westafrican/content/settings.json";
import waTheme from "../../sites/westafrican/theme.json";
import { siteContentSchema, type Theme } from "../../src/content/schema";
import { HISTORY_LIMIT, recentChanges } from "../../src/db/audit";
import { exportSite } from "../../src/db/export";
import { exportFile, type OperatorContent, readExportFile } from "../../src/db/export-file";
import { addException, adminHours, removeException, saveWeeklyHours } from "../../src/db/hours";
import { adminMenu, createCategory, createMenuItem, deleteCategory, moveCategory, moveMenuItem, setFeatured } from "../../src/db/menu";
import { deleteMenuItem, getMenuItem, type RepoContext, setSoldOut, updateMenuItem } from "../../src/db/repository";
import { type ImageResolver, resetStatements, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare, type Statement } from "../../src/db/sql";
import { adminTexts, updatePageTexts, updateSettings } from "../../src/db/texts";

const db = env.DB;
const now = new Date("2026-10-16T08:00:00Z");
const OWNER = "owner0000001";
const WA_OWNER = "waowner00001";
const ctx = (siteId: string, userId: string | null = OWNER): RepoContext => ({ db, siteId, userId, now });
const bistro = ctx("bistro");

const raw = {
  bistro: { settings: bistroSettings, hours: bistroHours, menu: bistroMenu, pages: bistroPages, gallery: bistroGallery, images: bistroImages, theme: bistroTheme },
  westafrican: { settings: waSettings, hours: waHours, menu: waMenu, pages: waPages, gallery: waGallery, images: waImages, theme: waTheme },
};
const themes = { bistro: bistroTheme as Theme, westafrican: waTheme as Theme };
const repoSettings = { bistro: bistroSettings, westafrican: waSettings } as unknown as Record<string, OperatorContent["settings"]>;
/** The repository's operator-only content for a site: theme, booking and map. */
const op = (theme: Theme, site = theme === themes.westafrican ? "westafrican" : "bistro"): OperatorContent => ({ theme, settings: repoSettings[site] });
type Site = keyof typeof raw;

function stored(site: Site): StoredContent {
  const { theme: _theme, ...content } = siteContentSchema(site).parse(raw[site]);
  return content;
}

// Stand-in for hashing the real files: the SHA-256 of each path (as tests/db/round-trip.test.ts).
const hashes = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  const id = hashes.get(path);
  if (!id) throw new Error(`no hash for ${path}`);
  return { id, mime: "image/jpeg" };
};
beforeAll(async () => {
  for (const site of ["bistro", "westafrican"] as const) {
    for (const path of stored(site).images.map((i) => i.ref)) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
      hashes.set(path, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
    }
  }
});

const run = (statements: Statement[]) => db.batch(prepare(db, statements));
const exportText = async (site: Site) => JSON.stringify(exportFile(site, (await exportSite(db, site))!, now), null, 2);

/** What `npm run seed -- --site <site> --from <file> --reset` does, minus wrangler. */
async function restore(site: Site, text: string) {
  const read = readExportFile(text, site, op(themes[site], site));
  if (!read.ok) throw new Error(read.error);
  await run([...resetStatements(site), ...seedStatements(site, read.content, fakeImages)]);
}

/** Export, restore, export: the content (and its serialisation) must not change. */
async function expectRoundTrip(site: Site) {
  const before = (await exportSite(db, site))!;
  await restore(site, await exportText(site));
  const after = (await exportSite(db, site))!;
  expect(after.content).toEqual(before.content);
  // Same key order too, so two exports of the same content are byte-identical files.
  expect(JSON.stringify(after.content)).toBe(JSON.stringify(before.content));
  // And a second cycle is stable.
  await restore(site, await exportText(site));
  expect(JSON.stringify((await exportSite(db, site))!.content)).toBe(JSON.stringify(before.content));
  return { before, after };
}

const rejected = (text: string, site: Site = "bistro") => {
  const read = readExportFile(text, site, op(themes[site], site));
  expect(read.ok).toBe(false);
  return (read as { ok: false; error: string }).error;
};
const goodFile = async () => JSON.parse(await exportText("bistro"));
const contentRows = async (site: string) => {
  const rows = await db.batch([
    db.prepare("SELECT count(*) AS n FROM menu_items WHERE site_id = ?").bind(site),
    db.prepare("SELECT count(*) AS n FROM menu_categories WHERE site_id = ?").bind(site),
    db.prepare("SELECT content_version AS n FROM sites WHERE id = ?").bind(site),
  ]);
  return rows.map((r) => (r.results[0] as { n: number }).n);
};

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await run(seedStatements("bistro", stored("bistro"), fakeImages));
  await run(seedStatements("westafrican", stored("westafrican"), fakeImages));
  await db.batch([
    db.prepare("INSERT INTO users (id, email) VALUES (?, 'owner@bistro.se')").bind(OWNER),
    db.prepare("INSERT INTO users (id, email) VALUES (?, 'secret-owner@chezabena.se')").bind(WA_OWNER),
  ]);
});

describe("round trip: export → restore → export is identical", () => {
  it.each(["bistro", "westafrican"] as const)("%s as seeded (images, gallery, highlight images, pull quote)", async (site) => {
    const { after } = await expectRoundTrip(site);
    expect(after.content).toEqual(stored(site));
  });

  it("after every kind of owner edit", async () => {
    const menu = await adminMenu(bistro);
    const [first, second] = menu;
    const dish = first.items[0];

    // Sold out today, featured on and off, moved, edited (öre, unicode, emoji, bidi), off the menu.
    expect(await setSoldOut(bistro, second.items[0].id, true)).toEqual({ ok: true });
    const highlighted = (await exportSite(db, "bistro"))!.content.pages.home.highlights;
    expect(await setFeatured(bistro, highlighted[0], false)).toEqual({ ok: true });
    expect(await setFeatured(bistro, dish.id, true)).toMatchObject({ ok: true });
    expect(await moveMenuItem(bistro, first.items[1].id, "up")).toEqual({ ok: true });
    expect(await moveCategory(bistro, second.id, "up")).toEqual({ ok: true });
    const record = (await getMenuItem(bistro, dish.id))!;
    expect(
      await updateMenuItem(bistro, dish.id, record.rowVersion, {
        name: { sv: "Räksmörgås 🦐 Cafe\u0301 \u202Eevil", en: "Shrimp 👨‍👩‍👧 sandwich" },
        description: { sv: "Rad ett\nRad två — \u00ADmjuk", en: "Arabic عربى and Hebrew עברית" },
        priceOre: 14550,
        tags: [],
        allergens: [],
        available: false,
      }),
    ).toEqual({ ok: true });

    // A new category with a dish, then a category deleted along with a highlighted dish.
    const added = await createCategory(bistro, { sv: "Säsong 🍂", en: "Seasonal" });
    expect(added.ok).toBe(true);
    expect(
      (
        await createMenuItem(bistro, added.id!, {
          name: { sv: "Kantarell", en: "Chanterelle" },
          description: { sv: "Toast", en: "Toast" },
          priceOre: 9_999_999,
          tags: [],
          allergens: [],
          available: true,
        })
      ).ok,
    ).toBe(true);
    const third = menu[2];
    expect(await deleteCategory(bistro, third.id)).toEqual({ ok: true });
    expect(await deleteMenuItem(bistro, first.items.at(-1)!.id)).toEqual({ ok: true });

    // Hours: a week closing after midnight, a closed day, a special day added and one removed.
    const weekly = (await exportSite(db, "bistro"))!.content.hours.weekly;
    expect(await saveWeeklyHours(bistro, (await adminHours(bistro)).weeklyToken, { ...weekly, friday: { open: "18:00", close: "01:00" }, monday: null })).toEqual({ ok: true });
    expect((await addException(bistro, { date: "2026-12-24", hours: null, note: { sv: "Julafton", en: "Christmas Eve" } })).ok).toBe(true);
    expect((await addException(bistro, { date: "2026-12-31", hours: { open: "17:00", close: "02:00" }, note: { sv: "Nyår", en: "NYE" } })).ok).toBe(true);
    expect((await removeException(bistro, "2026-12-24")).ok).toBe(true);

    // Texts: several social links, a changed phone; the pull quote removed.
    const texts = (await adminTexts(bistro))!;
    const { rowVersion: sv, ...s } = texts.settings;
    expect(
      await updateSettings(bistro, sv, { ...s, phone: "+46 8 555 12 34", socialLinks: { facebook: "https://facebook.com/bistro", instagram: "https://instagram.com/bistro_å" } }),
    ).toEqual({ ok: true });
    const { rowVersion: pv, ...p } = texts.pages;
    expect(await updatePageTexts(bistro, pv, { ...p, pullQuote: null })).toEqual({ ok: true });

    const { after } = await expectRoundTrip("bistro");
    const restoredDish = after.content.menu.categories.flatMap((c) => c.items).find((i) => i.id === dish.id)!;
    expect(restoredDish).toMatchObject({ price: 14550, available: false, name: { sv: "Räksmörgås 🦐 Caf\u00e9 evil", en: "Shrimp 👨‍👩‍👧 sandwich" } });
    expect(after.content.pages.home.pullQuote).toBeUndefined();
    expect(after.content.pages.home.highlights).toContain(dish.id);
    expect(after.content.menu.categories.map((c) => c.name.sv)).toContain("Säsong 🍂");
    expect(after.content.hours.weekly.friday).toEqual({ open: "18:00", close: "01:00" });
    expect(after.content.settings.socialLinks).toEqual({ facebook: "https://facebook.com/bistro", instagram: "https://instagram.com/bistro_å" });
  });

  it("does not carry today's sold-out state (documented: the restored dish is back on sale)", async () => {
    const id = (await adminMenu(bistro))[0].items[0].id;
    await setSoldOut(bistro, id, true);
    expect((await exportSite(db, "bistro"))!.soldOutOn).toEqual({ [id]: "2026-10-16" });
    const file = await exportText("bistro");
    expect(file).not.toContain('2026-10-16"');
    await restore("bistro", file);
    expect((await exportSite(db, "bistro"))!.soldOutOn).toEqual({});
  });

  it("holds no owners, emails, sessions, audit entries or image bytes", async () => {
    const file = await exportText("bistro");
    expect(file).not.toContain("owner@bistro.se");
    expect(file).not.toContain(OWNER);
    for (const key of ["audit", "users", "memberships", "sessions", "passkeys", "theme", "soldOut", "sold_out"]) expect(file).not.toContain(`"${key}`);
    // Images are referenced by path only.
    expect(file).toContain('"/images/bistro/');
    expect(file).not.toMatch(/data:image|base64/);
  });

  it("keeps owners and the audit log of the site across a restore, and adds one 'seed' entry", async () => {
    await setSoldOut(bistro, (await adminMenu(bistro))[0].items[0].id, true);
    const before = await recentChanges(bistro);
    await restore("bistro", await exportText("bistro"));
    const after = await recentChanges(bistro);
    expect(after.slice(1)).toEqual(before);
    expect(after[0]).toMatchObject({ entity: "site", action: "seed", by: null });
    expect(await db.prepare("SELECT count(*) AS n FROM users").first("n")).toBe(2);
  });

  it("leaves the other site untouched", async () => {
    const wa = JSON.stringify((await exportSite(db, "westafrican"))!.content);
    await restore("bistro", await exportText("bistro"));
    expect(JSON.stringify((await exportSite(db, "westafrican"))!.content)).toBe(wa);
  });
});

describe("tampered or wrong files are refused before anything is written", () => {
  it("a westafrican export can't be restored into bistro, nor bistro's into westafrican", async () => {
    const wa = await exportText("westafrican");
    expect(rejected(wa, "bistro")).toBe('the file is for site "westafrican", not "bistro"');
    expect(rejected(await exportText("bistro"), "westafrican")).toBe('the file is for site "bistro", not "westafrican"');
  });

  it("relabelling another site's file still fails on its image paths", async () => {
    const file = JSON.parse(await exportText("westafrican"));
    file.site = "bistro";
    expect(rejected(JSON.stringify(file))).toMatch(/must be a file under \/images\/bistro\//);
  });

  it("refuses unknown keys inside the content (strict schema)", async () => {
    const file = await goodFile();
    file.content.owners = [{ email: "x@y.se" }];
    expect(rejected(JSON.stringify(file))).toMatch(/owners|Unrecognized/i);
    const file2 = await goodFile();
    file2.content.menu.categories[0].items[0].soldOutOn = "2026-10-16";
    expect(rejected(JSON.stringify(file2))).toMatch(/soldOutOn|Unrecognized/i);
  });

  it("ignores a theme smuggled into the file: the theme always comes from the repository", async () => {
    const file = await goodFile();
    file.content.theme = { ...bistroTheme, colors: { ...bistroTheme.colors, primary: "#ff0000" } };
    const read = readExportFile(JSON.stringify(file), "bistro", op(themes.bistro));
    expect(read.ok).toBe(true);
    expect(JSON.stringify((read as { content: unknown }).content)).not.toContain("#ff0000");
  });

  it("refuses __proto__ keys at every level", async () => {
    const text = await exportText("bistro");
    const inject = (needle: string) => text.replace(needle, `${needle}"__proto__": { "polluted": true },`);
    expect(rejected(inject('"content": {'))).toBeTruthy();
    expect(rejected(inject('"settings": {'))).toBeTruthy();
    expect(rejected(inject('"socialLinks": {'))).toMatch(/__proto__/);
    expect(rejected(inject('"weekly": {'))).toMatch(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it.each([
    ["negative", -1],
    ["fractional öre", 145.5],
    ["a string", "14500"],
    ["over 100 000 kr", 10_000_001],
    ["null", null],
    ["huge", 1e300],
  ])("refuses a %s price", async (_name, price) => {
    const file = await goodFile();
    file.content.menu.categories[0].items[0].price = price;
    expect(rejected(JSON.stringify(file))).toMatch(/menu\.categories\.0\.items\.0\.price/);
  });

  it("refuses highlights that point at a missing dish, and highlight images for unhighlighted dishes", async () => {
    const file = await goodFile();
    file.content.pages.home.highlights = ["zzzzzzzzzzzz"];
    expect(rejected(JSON.stringify(file))).toMatch(/pages\.home\.highlights\.0: highlights an item that does not exist/);
  });

  it("refuses path traversal and other folders in image paths", async () => {
    for (const path of ["/images/bistro/../../../etc/passwd", "/images/bistro/.env", "/images/westafrican/x.jpg", "https://evil.example/x.jpg", "/images/bistro/a/b.jpg"]) {
      const file = await goodFile();
      file.content.pages.home.heroImage = path;
      expect(rejected(JSON.stringify(file))).toMatch(/pages\.home\.heroImage/);
    }
  });

  it("refuses wrong format markers, broken JSON and non-objects", async () => {
    const file = await goodFile();
    expect(rejected(JSON.stringify({ ...file, formatVersion: "1" }))).toMatch(/format version "?1"? is not supported/);
    expect(rejected(JSON.stringify({ ...file, format: undefined }))).toBe("not a dagens-menu-export file");
    expect(rejected(JSON.stringify({ ...file, content: "x" }))).toBe("the file has no content");
    expect(rejected(text30k())).toMatch(/not valid JSON/);
    expect(rejected("null")).toBe("not an export file");
    expect(rejected('"a string"')).toBe("not an export file");
    expect(rejected("")).toMatch(/not valid JSON/);
  });

  it("refuses a huge text with a short, readable message", async () => {
    const file = await goodFile();
    file.content.menu.categories[0].items[0].description.sv = "x".repeat(2_000_000);
    const error = rejected(JSON.stringify(file));
    expect(error).toMatch(/description\.sv: must be at most 300 characters/);
    expect(error.length).toBeLessThan(500);
  });

  it("lists at most five problems, so a badly broken file still gives a short message", async () => {
    const file = await goodFile();
    for (const item of file.content.menu.categories[0].items) item.price = -1;
    const error = rejected(JSON.stringify(file));
    expect(error.split("\n").length).toBeLessThanOrEqual(6);
  });

  it("allows another site's dish ids: ids are scoped per site, so nothing collides", async () => {
    const waIds = (await exportSite(db, "westafrican"))!.content.menu.categories[0].items.map((i) => i.id);
    const file = await goodFile();
    const items = file.content.menu.categories[0].items;
    const oldId = items[0].id;
    items[0].id = waIds[0];
    file.content.pages.home.highlights = file.content.pages.home.highlights.map((h: string) => (h === oldId ? waIds[0] : h));
    if (file.content.pages.home.highlightImages?.[oldId]) {
      file.content.pages.home.highlightImages[waIds[0]] = file.content.pages.home.highlightImages[oldId];
      delete file.content.pages.home.highlightImages[oldId];
    }
    const wa = JSON.stringify((await exportSite(db, "westafrican"))!.content);
    await restore("bistro", JSON.stringify(file));
    expect(JSON.stringify((await exportSite(db, "westafrican"))!.content)).toBe(wa);
    expect((await exportSite(db, "bistro"))!.content.menu.categories[0].items[0].id).toBe(waIds[0]);
  });

  it("a refused file leaves the database exactly as it was", async () => {
    const before = await contentRows("bistro");
    const file = await goodFile();
    file.content.pages.home.highlights.push("zzzzzzzzzzzz");
    expect(() => readExportFile(JSON.stringify(file), "bistro", op(themes.bistro))).not.toThrow();
    expect(rejected(JSON.stringify(file))).toBeTruthy();
    expect(await contentRows("bistro")).toEqual(before);
  });
});

describe("tampered files the reader accepts (findings)", () => {
  it("a restore never takes the operator-only booking and map fields from the file", async () => {
    const file = await goodFile();
    file.content.settings.booking = { provider: "embed", embedCode: '<script src="https://evil.example/x.js"></script>' };
    file.content.settings.mapEmbed = "https://evil.example/map";
    // ADR-011 §8: booking embed and map URL are operator-only. The repository's values win,
    // and the reader says the file's differed.
    const read = readExportFile(JSON.stringify(file), "bistro", op(themes.bistro));
    if (!read.ok) throw new Error(read.error);
    expect(read.operatorFieldsReplaced).toBe(true);
    expect(read.content.settings.booking).toEqual(bistroSettings.booking);
    expect(read.content.settings.mapEmbed).toBe(bistroSettings.mapEmbed);
  });

  it("D: a restore accepts more featured dishes than the admin allows (3)", async () => {
    const file = await goodFile();
    const ids = file.content.menu.categories.flatMap((c: { items: Array<{ id: string }> }) => c.items.map((i) => i.id));
    file.content.pages.home.highlights = ids.slice(0, 8);
    delete file.content.pages.home.highlightImages;
    const read = readExportFile(JSON.stringify(file), "bistro", op(themes.bistro));
    expect(read.ok, "more than MAX_FEATURED highlights should be refused").toBe(false);
  });

  it("D: a file saved with a byte-order mark (Windows editors) should be read; today it is refused as broken JSON", async () => {
    const read = readExportFile(`﻿${await exportText("bistro")}`, "bistro", op(themes.bistro));
    expect(read.ok, "a UTF-8 BOM should be skipped").toBe(true);
  });

  it("D: terminal control characters from the file reach the operator's terminal in the error", async () => {
    const file = await goodFile();
    file.site = "\u001b[2J\u001b]0;pwned\u0007westafrican";
    const error = rejected(JSON.stringify(file));
    expect(error, "values from the file should be printed with JSON.stringify or control characters stripped").not.toMatch(/\p{Cc}/u);
  });
});

describe("recentChanges", () => {
  const insert = (site: string, user: string | null, summary: string, at = "2026-10-16T08:00:00Z", entity = "menu_item", action = "update") =>
    db.prepare("INSERT INTO audit_log (site_id, user_id, at, entity, action, summary) VALUES (?, ?, ?, ?, ?, ?)").bind(site, user, at, entity, action, summary);

  it("orders by commit order, not by the stored time", async () => {
    await db.batch([insert("bistro", OWNER, "first", "2026-10-16T10:00:00Z"), insert("bistro", OWNER, "second", "2026-10-16T09:00:00Z")]);
    expect((await recentChanges(bistro)).slice(0, 2).map((c) => c.summary)).toEqual(["second", "first"]);
  });

  it(`shows exactly the newest ${HISTORY_LIMIT}`, async () => {
    await db.batch(Array.from({ length: HISTORY_LIMIT + 1 }, (_, n) => insert("bistro", OWNER, `change ${n}`)));
    const changes = await recentChanges(bistro);
    expect(changes).toHaveLength(HISTORY_LIMIT);
    expect(changes[0].summary).toBe(`change ${HISTORY_LIMIT}`);
    expect(changes.at(-1)!.summary).toBe("change 1");
  });

  it("never shows another site's entries or its owners' emails, even when that site is busier", async () => {
    await db.batch(Array.from({ length: 80 }, (_, n) => insert("westafrican", WA_OWNER, `wa ${n}`)));
    await db.batch([insert("bistro", OWNER, "bistro change")]);
    const changes = await recentChanges(bistro);
    expect(changes.map((c) => c.summary)).not.toContainEqual(expect.stringMatching(/^wa /));
    expect(JSON.stringify(changes)).not.toContain("chezabena");
    expect(changes[0]).toMatchObject({ summary: "bistro change", by: "owner@bistro.se" });
    const wa = await recentChanges(ctx("westafrican", WA_OWNER));
    expect(JSON.stringify(wa)).not.toContain("owner@bistro.se");
  });

  it("an owner of both sites appears in each site's history only for that site's changes", async () => {
    await db.batch([insert("westafrican", OWNER, "wa by shared owner"), insert("bistro", OWNER, "bistro by shared owner")]);
    expect((await recentChanges(bistro)).map((c) => c.summary)).not.toContain("wa by shared owner");
  });

  it("a null user is the system; a user id that has no user row is null too", async () => {
    await db.batch([insert("bistro", null, "by the operator"), insert("bistro", "ghost0000001", "by a missing user")]);
    const [ghost, system] = await recentChanges(bistro);
    expect(system).toMatchObject({ summary: "by the operator", by: null });
    expect(ghost).toMatchObject({ summary: "by a missing user", by: null });
  });

  it("returns an empty list for a site with no entries, and only the seed entry for a fresh site", async () => {
    expect(await recentChanges(ctx("nosuchsite"))).toEqual([]);
    expect(await recentChanges(bistro)).toEqual([expect.objectContaining({ entity: "site", action: "seed", summary: "Content loaded from JSON", by: null })]);
  });

  it("the audit time is always ISO-8601 UTC to the second (the page parses it with new Date)", async () => {
    await expect(insert("bistro", OWNER, "bad time", "2026-10-16 08:00:00").run()).rejects.toThrow(/CHECK/);
    for (const c of await recentChanges(bistro)) expect(c.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("every owner edit writes an entry that the history labels (entity and action are known)", async () => {
    const menu = await adminMenu(bistro);
    await setSoldOut(bistro, menu[0].items[0].id, true);
    await moveCategory(bistro, menu[1].id, "up");
    await addException(bistro, { date: "2026-12-24", hours: null, note: { sv: "Jul", en: "Christmas" } });
    await saveWeeklyHours(bistro, (await adminHours(bistro)).weeklyToken, (await exportSite(db, "bistro"))!.content.hours.weekly);
    const texts = (await adminTexts(bistro))!;
    const { rowVersion: pv, ...p } = texts.pages;
    await updatePageTexts(bistro, pv, { ...p, pullQuote: null });
    const known = ["menu_item", "menu_category", "hours", "hours_exception", "settings", "page_content", "site"];
    for (const c of await recentChanges(bistro)) {
      expect(known).toContain(c.entity);
      expect(["create", "update", "delete", "reorder", "seed"]).toContain(c.action);
    }
  });
});

function text30k() {
  return `{"format": "dagens-menu-export", "content": ${"[".repeat(30_000)}`;
}
