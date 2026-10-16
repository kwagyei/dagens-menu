/** Plan M5.1–M5.3: adding, featuring, reordering and deleting dishes and categories. */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import gallery from "../../sites/bistro/content/gallery.json";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import {
  adminMenu,
  createCategory,
  createMenuItem,
  deleteCategory,
  MAX_FEATURED,
  moveCategory,
  moveMenuItem,
  renameCategory,
  setFeatured,
} from "../../src/db/menu";
import type { MenuItemEdit, RepoContext } from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-16T10:00:00Z");
const ctx = (siteId = "bistro"): RepoContext => ({ db, siteId, userId: null, now });
const bistro = ctx();

const content = {
  settings,
  hours,
  menu: { categories: menu.categories.map((c) => ({ ...c, items: c.items.map(({ image: _i, ...i }) => i) })) },
  pages: { home: { tagline: pages.home.tagline, highlights: pages.home.highlights }, menu: {}, about: { story: pages.about.story, chef: pages.about.chef } },
  gallery: { images: [] },
} as unknown as StoredContent;
const none = () => {
  throw new Error("no images");
};

const dish = (over: Partial<MenuItemEdit> = {}): MenuItemEdit => ({
  name: { sv: "Ärtsoppa", en: "Pea soup" },
  description: { sv: "Med fläsk", en: "With pork" },
  priceOre: 12500,
  tags: [],
  allergens: ["mustard"],
  available: true,
  ...over,
});

const version = () => db.prepare("SELECT content_version FROM sites WHERE id = 'bistro'").first<number>("content_version");
const audits = (action: string) => db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?").bind(action).first<number>("n");

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content, none)));
  await db.batch([db.prepare("INSERT INTO sites (id) VALUES ('westafrican')")]);
});

describe("adminMenu", () => {
  it("lists the categories and dishes in order, marking the featured ones", async () => {
    const list = await adminMenu(bistro);
    expect(list.map((c) => c.slug)).toEqual(menu.categories.map((c) => c.id));
    expect(list[0].items.map((i) => i.id)).toEqual(menu.categories[0].items.map((i) => i.id));
    const featured = list.flatMap((c) => c.items).filter((i) => i.featured).map((i) => i.id);
    expect(featured.sort()).toEqual([...pages.home.highlights].sort());
  });

  it("shows nothing of another site", async () => {
    expect(await adminMenu(ctx("westafrican"))).toEqual([]);
  });
});

describe("createMenuItem", () => {
  it("adds the dish at the end of its category and moves the version on", async () => {
    const [first] = await adminMenu(bistro);
    const v0 = await version();
    const result = await createMenuItem(bistro, first.id, dish());
    expect(result.ok).toBe(true);
    const after = (await adminMenu(bistro))[0];
    expect(after.items.at(-1)).toMatchObject({ id: result.id, name: { sv: "Ärtsoppa", en: "Pea soup" }, priceOre: 12500 });
    expect(await version()).toBeGreaterThan(v0!);
    expect(await audits("create")).toBe(1);
  });

  it("rejects invalid input and writes nothing", async () => {
    const [first] = await adminMenu(bistro);
    const result = await createMenuItem(bistro, first.id, dish({ name: { sv: "", en: "Soup" }, priceOre: -1 }));
    expect(result.ok === false && result.error).toBe("invalid");
    expect((await adminMenu(bistro))[0].items).toHaveLength(first.items.length);
  });

  it("can't add to another site's category", async () => {
    await db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('westafrican', 'wacat0000001', 'mains', 'A', 'A', 0)").run();
    expect(await createMenuItem(bistro, "wacat0000001", dish())).toEqual({ ok: false, error: "not-found" });
    expect(await db.prepare("SELECT count(*) AS n FROM menu_items WHERE site_id = 'westafrican'").first("n")).toBe(0);
  });
});

describe("setFeatured", () => {
  it(`allows at most ${MAX_FEATURED} featured dishes`, async () => {
    const items = (await adminMenu(bistro)).flatMap((c) => c.items);
    const featured = items.filter((i) => i.featured);
    expect(featured).toHaveLength(MAX_FEATURED);
    const other = items.find((i) => !i.featured)!;
    expect(await setFeatured(bistro, other.id, true)).toEqual({ ok: false, error: "too-many" });
    expect(await setFeatured(bistro, featured[0].id, false)).toEqual({ ok: true });
    expect(await setFeatured(bistro, other.id, true)).toEqual({ ok: true });
    expect((await adminMenu(bistro)).flatMap((c) => c.items).filter((i) => i.featured)).toHaveLength(MAX_FEATURED);
  });

  it("does nothing when the dish is already in that state", async () => {
    const featured = (await adminMenu(bistro)).flatMap((c) => c.items).find((i) => i.featured)!;
    const v0 = await version();
    expect(await setFeatured(bistro, featured.id, true)).toEqual({ ok: true });
    expect(await version()).toBe(v0);
  });

  it("is not-found for another site's dish", async () => {
    const id = menu.categories[0].items[0].id;
    expect(await setFeatured(ctx("westafrican"), id, true)).toEqual({ ok: false, error: "not-found" });
  });
});

describe("moving", () => {
  it("moves a dish within its category and renumbers it cleanly", async () => {
    const [first] = await adminMenu(bistro);
    const [a, b] = first.items;
    expect(await moveMenuItem(bistro, b.id, "up")).toEqual({ ok: true });
    expect((await adminMenu(bistro))[0].items.slice(0, 2).map((i) => i.id)).toEqual([b.id, a.id]);
    const { results } = await db.prepare("SELECT position FROM menu_items WHERE site_id = 'bistro' AND category_id = ? ORDER BY position").bind(first.id).all<{ position: number }>();
    expect(results.map((r) => r.position)).toEqual(results.map((_, i) => i));
  });

  it("leaves the first dish where it is when moved up", async () => {
    const [first] = await adminMenu(bistro);
    const v0 = await version();
    expect(await moveMenuItem(bistro, first.items[0].id, "up")).toEqual({ ok: true });
    expect(await version()).toBe(v0);
  });

  it("moves categories", async () => {
    const before = (await adminMenu(bistro)).map((c) => c.id);
    await moveCategory(bistro, before[1], "up");
    expect((await adminMenu(bistro)).map((c) => c.id)).toEqual([before[1], before[0], ...before.slice(2)]);
  });

  it("is not-found for another site's dish or category", async () => {
    const [first] = await adminMenu(bistro);
    expect(await moveMenuItem(ctx("westafrican"), first.items[1].id, "up")).toEqual({ ok: false, error: "not-found" });
    expect(await moveCategory(ctx("westafrican"), first.id, "down")).toEqual({ ok: false, error: "not-found" });
  });
});

describe("categories", () => {
  it("adds a category with a unique slug from its Swedish name", async () => {
    const one = await createCategory(bistro, { sv: "Varmrätter", en: "Mains" });
    const two = await createCategory(bistro, { sv: "Varmrätter", en: "Mains again" });
    const list = await adminMenu(bistro);
    expect(list.find((c) => c.id === one.id)?.slug).toBe("varmratter");
    expect(list.find((c) => c.id === two.id)?.slug).toBe("varmratter-2");
    expect(list.at(-1)?.id).toBe(two.id);
  });

  it("rejects a name missing a language", async () => {
    expect((await createCategory(bistro, { sv: "Dryck", en: " " })).ok).toBe(false);
  });

  it("renames, keeping the slug, and treats a stale form as a conflict", async () => {
    const [first] = await adminMenu(bistro);
    expect(await renameCategory(bistro, first.id, first.rowVersion, { sv: "Lunchmeny", en: "Lunch menu" })).toEqual({ ok: true });
    const renamed = (await adminMenu(bistro))[0];
    expect([renamed.name.sv, renamed.slug]).toEqual(["Lunchmeny", first.slug]);
    expect(await renameCategory(bistro, first.id, first.rowVersion, { sv: "X", en: "X" })).toEqual({ ok: false, error: "conflict", current: first.rowVersion + 1 });
  });

  it("deletes a category with its dishes and their home-page places", async () => {
    const list = await adminMenu(bistro);
    const withFeatured = list.find((c) => c.items.some((i) => i.featured))!;
    expect(await deleteCategory(bistro, withFeatured.id)).toEqual({ ok: true });
    expect(await db.prepare("SELECT count(*) AS n FROM menu_items WHERE category_id = ?").bind(withFeatured.id).first("n")).toBe(0);
    const featuredLeft = await db.prepare("SELECT count(*) AS n FROM home_highlights").first<number>("n");
    expect(featuredLeft).toBe(MAX_FEATURED - withFeatured.items.filter((i) => i.featured).length);
    expect(await deleteCategory(bistro, withFeatured.id)).toEqual({ ok: false, error: "not-found" });
  });
});
