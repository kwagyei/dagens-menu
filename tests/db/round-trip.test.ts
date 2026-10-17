/**
 * Plan M2.4/M2.5: seeding a demo's JSON into D1 and exporting it again gives back exactly the
 * same content, and the export re-imports unchanged.
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
import { siteContentSchema } from "../../src/content/schema";
import { exportSite } from "../../src/db/export";
import { type ImageResolver, resetStatements, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare, type Statement } from "../../src/db/sql";

const db = env.DB;
const raw = {
  bistro: { settings: bistroSettings, hours: bistroHours, menu: bistroMenu, pages: bistroPages, gallery: bistroGallery, images: bistroImages, theme: bistroTheme },
  westafrican: { settings: waSettings, hours: waHours, menu: waMenu, pages: waPages, gallery: waGallery, images: waImages, theme: waTheme },
};

// Stand-in for hashing the real files (no file system in workerd): the SHA-256 of each path.
const hashes = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  const id = hashes.get(path);
  if (!id) throw new Error(`no hash for ${path}`);
  return { id, mime: "image/jpeg" };
};

beforeAll(async () => {
  for (const site of ["bistro", "westafrican"] as const) {
    for (const path of (stored(site)).images.map((i) => i.ref)) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
      hashes.set(path, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
    }
  }
});

function stored(site: keyof typeof raw): StoredContent {
  const { theme: _theme, ...content } = siteContentSchema(site).parse(raw[site]);
  return content;
}

const run = (statements: Statement[]) => db.batch(prepare(db, statements));

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
});

describe.each(["bistro", "westafrican"] as const)("%s", (site) => {
  it("exports exactly the JSON it was seeded from", async () => {
    await run(seedStatements(site, stored(site), fakeImages));
    const exported = await exportSite(db, site);
    const { theme: _theme, ...source } = raw[site];
    expect(exported?.content).toEqual(source);
  });

  it("re-imports its own export unchanged", async () => {
    await run(seedStatements(site, stored(site), fakeImages));
    const first = await exportSite(db, site);
    await run([...resetStatements(site), ...seedStatements(site, first!.content, fakeImages)]);
    const second = await exportSite(db, site);
    expect(second?.content).toEqual(first?.content);
  });

  it("passes the content schema after a round trip", async () => {
    await run(seedStatements(site, stored(site), fakeImages));
    const exported = await exportSite(db, site);
    const check = siteContentSchema(site).safeParse({ ...exported!.content, theme: raw[site].theme });
    expect(check.success ? [] : check.error.issues).toEqual([]);
  });
});

describe("seeding", () => {
  it("keeps the two sites apart", async () => {
    await run(seedStatements("bistro", stored("bistro"), fakeImages));
    await run(seedStatements("westafrican", stored("westafrican"), fakeImages));
    const bistro = await exportSite(db, "bistro");
    expect(bistro?.content.settings.name.sv).toBe("Bistro Norden");
    expect(await db.prepare("SELECT count(DISTINCT site_id) AS n FROM menu_items").first("n")).toBe(2);
  });

  it("moves the content version forward on a reseed, never back", async () => {
    await run(seedStatements("bistro", stored("bistro"), fakeImages, new Date("2030-01-01T00:00:00Z")));
    const before = (await exportSite(db, "bistro"))!.version;
    // A reseed with an older clock must still produce a newer version.
    await run([...resetStatements("bistro"), ...seedStatements("bistro", stored("bistro"), fakeImages, new Date("2020-01-01T00:00:00Z"))]);
    expect((await exportSite(db, "bistro"))!.version).toBeGreaterThan(before);
  });

  it("keeps owners and the audit log through a reset", async () => {
    await run(seedStatements("bistro", stored("bistro"), fakeImages));
    await db.batch([
      db.prepare("INSERT INTO users (id, email) VALUES ('user00000001', 'owner@x.se')"),
      db.prepare("INSERT INTO memberships (user_id, site_id, role) VALUES ('user00000001', 'bistro', 'owner')"),
    ]);
    await run([...resetStatements("bistro"), ...seedStatements("bistro", stored("bistro"), fakeImages)]);
    expect(await db.prepare("SELECT count(*) AS n FROM memberships").first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'seed'").first("n")).toBe(2);
  });

  it("refuses to seed over existing content without a reset", async () => {
    await run(seedStatements("bistro", stored("bistro"), fakeImages));
    await expect(run(seedStatements("bistro", stored("bistro"), fakeImages))).rejects.toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    expect((await exportSite(db, "bistro"))?.content.menu.categories.length).toBe(stored("bistro").menu.categories.length);
  });

  it("deletes a fully seeded site, images and all, in one statement", async () => {
    await run(seedStatements("bistro", stored("bistro"), fakeImages));
    await db.prepare("DELETE FROM sites WHERE id = 'bistro'").run();
    const tables = ["images", "settings", "menu_categories", "menu_items", "home_highlights", "weekly_hours", "page_content", "gallery_images"];
    const counts = await Promise.all(tables.map((t) => db.prepare(`SELECT count(*) AS n FROM ${t}`).first<number>("n")));
    expect(Object.fromEntries(tables.map((t, i) => [t, counts[i]]))).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
  });

  it("names both files when two paths hold the same image", async () => {
    const same: ImageResolver = () => ({ id: "a".repeat(64), mime: "image/jpeg" });
    expect(() => seedStatements("bistro", stored("bistro"), same)).toThrow(/are the same file/);
  });

  it("exports nothing for a site without content", async () => {
    expect(await exportSite(db, "nobody")).toBeNull();
  });
});
