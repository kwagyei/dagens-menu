/** Plan M5.5: the restaurant's settings and page texts, as the admin edits them. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import { exportSite } from "../../src/db/export";
import type { RepoContext } from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { adminTexts, type OwnerSettings, type PageTexts, updatePageTexts, updateSettings } from "../../src/db/texts";

const db = env.DB;
const now = new Date("2026-10-16T08:00:00Z");
const ctx = (siteId = "bistro"): RepoContext => ({ db, siteId, userId: null, now });
const bistro = ctx();

const content = {
  settings: { ...settings, booking: { provider: "link", bookingUrl: "https://book.example.se/bistro" }, mapEmbed: "https://maps.example.se/embed" },
  hours,
  menu: { categories: menu.categories.map((c) => ({ ...c, items: c.items.map(({ image: _i, ...i }) => i) })) },
  pages: {
    home: { tagline: pages.home.tagline, highlights: pages.home.highlights, pullQuote: { sv: "Enkelt och gott.", en: "Simple and good." } },
    menu: {},
    about: { story: pages.about.story, chef: pages.about.chef },
  },
  gallery: { images: [] },
  images: [],
} as unknown as StoredContent;

const version = () => db.prepare("SELECT content_version FROM sites WHERE id = 'bistro'").first<number>("content_version");
const lastAudit = () => db.prepare("SELECT entity, action, summary FROM audit_log WHERE site_id = 'bistro' ORDER BY id DESC LIMIT 1").first();

async function current() {
  const texts = await adminTexts(bistro);
  if (!texts) throw new Error("no texts");
  const { rowVersion: sv, ...s } = texts.settings;
  const { rowVersion: pv, ...p } = texts.pages;
  return { settings: s as OwnerSettings, settingsVersion: sv, pages: p as PageTexts, pagesVersion: pv };
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(
    prepare(
      db,
      seedStatements("bistro", content, () => ({ id: "0".repeat(64), mime: "image/jpeg" })),
    ),
  );
  await db.prepare("INSERT INTO sites (id) VALUES ('westafrican')").run();
});

describe("settings", () => {
  it("reads the seeded settings, without booking or map", async () => {
    const texts = await adminTexts(bistro);
    expect(texts?.settings).toMatchObject({ name: settings.name, phone: settings.phone, socialLinks: settings.socialLinks });
    expect(Object.keys(texts!.settings)).not.toContain("booking");
    expect(Object.keys(texts!.settings)).not.toContain("mapEmbed");
  });

  it("saves, bumps the version, audits the changed fields, and leaves booking and map alone", async () => {
    const { settings: s, settingsVersion } = await current();
    const v0 = await version();
    const edit = { ...s, phone: "08-123 456 78", socialLinks: { ...s.socialLinks, tiktok: "https://tiktok.com/@bistronorden" } };
    expect(await updateSettings(bistro, settingsVersion, edit)).toEqual({ ok: true });
    expect(await version()).toBeGreaterThan(v0!);
    expect(await lastAudit()).toEqual({ entity: "settings", action: "update", summary: "settings: phone, socialLinks" });
    const site = (await exportSite(db, "bistro"))!.content;
    expect(site.settings.phone).toBe("08-123 456 78");
    expect(site.settings.socialLinks.tiktok).toBe("https://tiktok.com/@bistronorden");
    expect(site.settings.booking).toEqual({ provider: "link", bookingUrl: "https://book.example.se/bistro" });
    expect(site.settings.mapEmbed).toBe("https://maps.example.se/embed");
  });

  it("rejects a non-https social link and stores nothing", async () => {
    const { settings: s, settingsVersion } = await current();
    const v0 = await version();
    for (const url of ["http://instagram.com/x", "javascript:alert(1)", "https://", "instagram.com/x"]) {
      const result = await updateSettings(bistro, settingsVersion, { ...s, socialLinks: { instagram: url } });
      expect(result).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await version()).toBe(v0);
  });

  it("rejects booking or map fields smuggled into the edit", async () => {
    const { settings: s, settingsVersion } = await current();
    const smuggled = { ...s, mapEmbed: "https://evil.example/" } as unknown as OwnerSettings;
    expect(await updateSettings(bistro, settingsVersion, smuggled)).toMatchObject({ ok: false, error: "invalid" });
  });

  it("is a conflict when someone saved in between, with the current version to overwrite knowingly", async () => {
    const { settings: s, settingsVersion } = await current();
    expect(await updateSettings(bistro, settingsVersion, { ...s, email: "a@bistro.se" })).toEqual({ ok: true });
    const stale = await updateSettings(bistro, settingsVersion, { ...s, email: "b@bistro.se" });
    expect(stale).toEqual({ ok: false, error: "conflict", current: settingsVersion + 1 });
    expect(await updateSettings(bistro, settingsVersion + 1, { ...s, email: "b@bistro.se" })).toEqual({ ok: true });
    expect((await current()).settings.email).toBe("b@bistro.se");
  });

  it("is not-found for a site without settings", async () => {
    const { settings: s } = await current();
    expect(await adminTexts(ctx("westafrican"))).toBeNull();
    expect(await updateSettings(ctx("westafrican"), 0, s)).toEqual({ ok: false, error: "not-found" });
  });
});

describe("page texts", () => {
  it("reads the seeded texts", async () => {
    const { pages: p } = await current();
    expect(p).toEqual({
      homeTagline: pages.home.tagline,
      pullQuote: { sv: "Enkelt och gott.", en: "Simple and good." },
      aboutStory: pages.about.story,
      aboutChef: pages.about.chef,
    });
  });

  it("saves, and removing the pull quote removes it from the site", async () => {
    const { pages: p, pagesVersion } = await current();
    const edit = { ...p, homeTagline: { sv: "Ny rubrik", en: "New headline" }, pullQuote: null };
    expect(await updatePageTexts(bistro, pagesVersion, edit)).toEqual({ ok: true });
    expect(await lastAudit()).toEqual({ entity: "page_content", action: "update", summary: "page texts: homeTagline, pullQuote" });
    const site = (await exportSite(db, "bistro"))!.content;
    expect(site.pages.home.tagline).toEqual({ sv: "Ny rubrik", en: "New headline" });
    expect(site.pages.home.pullQuote).toBeUndefined();
    expect(site.pages.home.highlights).toEqual(pages.home.highlights);
  });

  it("rejects an empty or over-long text", async () => {
    const { pages: p, pagesVersion } = await current();
    expect(await updatePageTexts(bistro, pagesVersion, { ...p, aboutChef: { sv: " ", en: "Chef" } })).toMatchObject({ ok: false, error: "invalid" });
    expect(await updatePageTexts(bistro, pagesVersion, { ...p, aboutStory: { sv: "x".repeat(3001), en: "Story" } })).toMatchObject({ ok: false, error: "invalid" });
  });

  it("is a conflict when someone saved in between", async () => {
    const { pages: p, pagesVersion } = await current();
    expect(await updatePageTexts(bistro, pagesVersion, { ...p, homeTagline: { sv: "A", en: "A" } })).toEqual({ ok: true });
    expect(await updatePageTexts(bistro, pagesVersion, { ...p, homeTagline: { sv: "B", en: "B" } })).toMatchObject({ ok: false, error: "conflict" });
  });
});
