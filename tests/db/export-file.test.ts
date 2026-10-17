/** Plan M5.6: the owner's export, and that it re-imports (the M5.6 acceptance criterion). */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import theme from "../../sites/bistro/theme.json";
import type { Theme } from "../../src/content/schema";
import { recentChanges } from "../../src/db/audit";
import { exportSite } from "../../src/db/export";
import { exportFile, exportFileName, type OperatorContent, readExportFile } from "../../src/db/export-file";
import { addException } from "../../src/db/hours";
import { createCategory } from "../../src/db/menu";
import type { RepoContext } from "../../src/db/repository";
import { setSoldOut } from "../../src/db/repository";
import { resetStatements, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { adminTexts, updateSettings } from "../../src/db/texts";

const db = env.DB;
const now = new Date("2026-10-16T08:00:00Z");
const USER = "owner0000001";
const bistro: RepoContext = { db, siteId: "bistro", userId: USER, now };
const op = (t: Theme): OperatorContent => ({ theme: t, settings: settings as unknown as OperatorContent["settings"] });
const images = () => ({ id: "0".repeat(64), mime: "image/jpeg" as const });

const content = {
  settings,
  hours,
  menu: { categories: menu.categories.map((c) => ({ ...c, items: c.items.map(({ image: _i, ...i }) => i) })) },
  pages: { home: { tagline: pages.home.tagline, highlights: pages.home.highlights }, menu: {}, about: { story: pages.about.story, chef: pages.about.chef } },
  gallery: { images: [] },
  images: [],
} as unknown as StoredContent;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content, images)));
  await db.batch([
    db.prepare("INSERT INTO sites (id) VALUES ('westafrican')"),
    db.prepare("INSERT INTO users (id, email) VALUES (?, 'owner@bistro.se')").bind(USER),
  ]);
});

async function ownerEdits() {
  const texts = (await adminTexts(bistro))!;
  const { rowVersion, ...s } = texts.settings;
  await updateSettings(bistro, rowVersion, { ...s, phone: "08-555 123 45", socialLinks: { instagram: "https://instagram.com/x" } });
  await addException(bistro, { date: "2026-12-24", hours: null, note: { sv: "Julafton", en: "Christmas Eve" } });
  await createCategory(bistro, { sv: "Säsong", en: "Seasonal" });
  await setSoldOut(bistro, menu.categories[0].items[0].id, true);
}

describe("export file", () => {
  it("re-imports to the same content after the owner's edits", async () => {
    await ownerEdits();
    const before = (await exportSite(db, "bistro"))!;
    const text = JSON.stringify(exportFile("bistro", before, now), null, 2);

    const read = readExportFile(text, "bistro", op(theme as Theme));
    if (!read.ok) throw new Error(read.error);
    await db.batch(prepare(db, [...resetStatements("bistro"), ...seedStatements("bistro", read.content, images)]));

    expect((await exportSite(db, "bistro"))!.content).toEqual(before.content);
  });

  it("carries the format, site, time and version, and names the file by site and day", async () => {
    const exported = (await exportSite(db, "bistro"))!;
    expect(exportFile("bistro", exported, new Date("2026-10-16T08:00:00.123Z"))).toMatchObject({
      format: "dagens-menu-export",
      formatVersion: 2,
      site: "bistro",
      exportedAt: "2026-10-16T08:00:00Z",
      contentVersion: exported.version,
    });
    expect(exportFileName("bistro", now)).toBe("bistro-content-2026-10-16.json");
  });

  it("refuses another site's file, other formats, broken JSON and invalid content", async () => {
    const good = exportFile("bistro", (await exportSite(db, "bistro"))!, now);
    const read = (value: unknown) => readExportFile(typeof value === "string" ? value : JSON.stringify(value), "bistro", op(theme as Theme));
    expect(read({ ...good, site: "westafrican" })).toEqual({ ok: false, error: 'the file is for site "westafrican", not "bistro"' });
    expect(read({ ...good, format: "something-else" })).toMatchObject({ ok: false, error: "not a dagens-menu-export file" });
    expect(read({ ...good, formatVersion: 3 })).toMatchObject({ ok: false, error: expect.stringContaining("format version 3") });
    expect(read("{ not json")).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(read([])).toEqual({ ok: false, error: "not an export file" });
    expect(read({ ...good, content: null })).toEqual({ ok: false, error: "the file has no content" });
    const bad = structuredClone(good);
    bad.content.settings.socialLinks = { instagram: "http://instagram.com/x" };
    expect(read(bad)).toMatchObject({ ok: false, error: expect.stringContaining("settings.socialLinks.instagram") });
  });
});

describe("format 1 files (before the image library, M6.3)", () => {
  /** A format 1 file as the previous release wrote it: gallery { src, alt }, highlightImages, no library. */
  async function v1File() {
    const current = exportFile("bistro", (await exportSite(db, "bistro"))!, now);
    const alts = new Map(current.content.images.map((i) => [i.ref, i.alt]));
    const { images: _library, ...content } = structuredClone(current.content) as typeof current.content & { images?: unknown };
    const gallery = { images: current.content.gallery.images.map((g) => ({ src: g.image, alt: alts.get(g.image) ?? { sv: "Bild", en: "Image" } })) };
    const home = { ...content.pages.home, highlightImages: { [content.pages.home.highlights[0]]: current.content.images[0]?.ref ?? "/images/bistro/x.jpg" } };
    return { ...current, formatVersion: 1, content: { ...content, gallery, pages: { ...content.pages, home } } };
  }

  it("upgrades on reading: the gallery's alt moves to the library, highlightImages is dropped and counted", async () => {
    const file = await v1File();
    const read = readExportFile(JSON.stringify(file), "bistro", { ...op(theme as Theme), images: [] });
    if (!read.ok) throw new Error(read.error);
    expect(read.highlightImagesDropped).toBe(1);
    expect("highlightImages" in read.content.pages.home).toBe(false);
    for (const [index, g] of file.content.gallery.images.entries()) {
      expect(read.content.gallery.images[index]).toEqual({ image: g.src });
      expect(read.content.images.find((i) => i.ref === g.src)?.alt).toEqual(g.alt);
    }
  });

  it("other curated images take their alt from the repository's library", async () => {
    const file = await v1File();
    const photo = "/images/bistro/kottbullar-hero.jpg";
    file.content.menu.categories[0].items[0].image = photo; // this fixture's dishes have no photos
    const read = readExportFile(JSON.stringify(file), "bistro", {
      ...op(theme as Theme),
      images: [{ ref: photo, alt: { sv: "Från repot", en: "From the repository" } }],
    });
    if (!read.ok) throw new Error(read.error);
    expect(read.content.images.find((i) => i.ref === photo)?.alt).toEqual({ sv: "Från repot", en: "From the repository" });
  });

  it("restores to the same content as a format 2 file of the same site", async () => {
    const before = (await exportSite(db, "bistro"))!;
    const read = readExportFile(JSON.stringify(await v1File()), "bistro", { ...op(theme as Theme), images: before.content.images });
    if (!read.ok) throw new Error(read.error);
    await db.batch(prepare(db, [...resetStatements("bistro"), ...seedStatements("bistro", read.content, images)]));
    expect((await exportSite(db, "bistro"))!.content).toEqual(before.content);
  });
});

describe("recentChanges", () => {
  it("lists the newest first, with who made each change, for this site only", async () => {
    await ownerEdits();
    await db.prepare("INSERT INTO audit_log (site_id, entity, action, summary) VALUES ('westafrican', 'site', 'seed', 'other site')").run();
    const changes = await recentChanges(bistro);
    expect(changes.map((c) => c.entity)).toEqual(["menu_item", "menu_category", "hours_exception", "settings", "site"]);
    expect(changes[0].by).toBe("owner@bistro.se");
    expect(changes.at(-1)).toMatchObject({ entity: "site", action: "seed", by: null });
    expect(changes.some((c) => c.summary === "other site")).toBe(false);
  });

  it("returns at most the limit", async () => {
    await db.batch(Array.from({ length: 60 }, (_, n) => db.prepare("INSERT INTO audit_log (site_id, entity, action, summary) VALUES ('bistro', 'menu_item', 'update', ?)").bind(`change ${n}`)));
    expect(await recentChanges(bistro)).toHaveLength(50);
    expect(await recentChanges(bistro, 5)).toHaveLength(5);
  });
});
