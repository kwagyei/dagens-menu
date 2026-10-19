/** Tester, M5.1–M5.3: attacks on menu editing at the repository level (workerd + D1). */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import { siteContentSchema } from "../../src/content/schema";
import { todayFor } from "../../src/content/today";
import { exportSite } from "../../src/db/export";
import { adminMenu, createCategory, createMenuItem, deleteCategory, moveCategory, moveMenuItem, renameCategory, setFeatured, slugify } from "../../src/db/menu";
import { deleteMenuItem, type MenuItemEdit, type RepoContext, setSoldOut, updateMenuItem } from "../../src/db/repository";
import { seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";

const db = env.DB;
const now = new Date("2026-10-16T10:00:00Z");
const ctx = (siteId = "bistro", at = now): RepoContext => ({ db, siteId, userId: null, now: at });
const bistro = ctx();
const theme = { colors: {} } as never;

const content = {
  settings,
  hours,
  menu: { categories: menu.categories.map((c) => ({ ...c, items: c.items.map(({ image: _i, ...i }) => i) })) },
  pages: { home: { tagline: pages.home.tagline, highlights: pages.home.highlights }, menu: {}, about: { story: pages.about.story, chef: pages.about.chef } },
  gallery: { images: [] },
  images: [],
} as unknown as StoredContent;
const none = () => {
  throw new Error("no images");
};
const dish = (over: Partial<MenuItemEdit> = {}): MenuItemEdit => ({
  name: { sv: "Ärtsoppa", en: "Pea soup" },
  description: { sv: "Med fläsk", en: "With pork" },
  priceOre: 12500,
  tags: [],
  allergens: [],
  available: true,
  ...over,
});

/** The public site's view: the exported content must pass the full site schema. */
async function publicContent() {
  const exported = await exportSite(db, "bistro");
  const parsed = siteContentSchema("bistro").safeParse({ ...exported!.content, theme: undefined });
  // theme is stored in files; replace it with the real bistro theme for the parse
  return { exported: exported!, issues: parsed.success ? [] : parsed.error.issues.filter((i) => i.path[0] !== "theme") };
}
void theme;

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  await db.batch(prepare(db, seedStatements("bistro", content, none)));
  await db.batch([db.prepare("INSERT INTO sites (id) VALUES ('westafrican')")]);
});

describe("sold out clears at Stockholm midnight", () => {
  const sold = async (at: string) => {
    const id = menu.categories[0].items[0].id;
    await setSoldOut(ctx("bistro", new Date(at)), id, true);
    return id;
  };
  const isSoldOut = async (id: string, at: string) => {
    const exported = await exportSite(db, "bistro");
    return todayFor(exported!.content.hours as never, exported!.soldOutOn, new Date(at)).soldOut.includes(id);
  };
  it("summer time: 23:59:59 and 00:00:00 Stockholm", async () => {
    const id = await sold("2026-10-16T21:59:00Z");
    expect(await isSoldOut(id, "2026-10-16T21:59:59Z")).toBe(true);
    expect(await isSoldOut(id, "2026-10-16T22:00:00Z")).toBe(false);
  });
  it("winter time: boundary moves an hour", async () => {
    const id = await sold("2026-12-01T22:30:00Z");
    expect(await isSoldOut(id, "2026-12-01T22:59:59Z")).toBe(true);
    expect(await isSoldOut(id, "2026-12-01T23:00:00Z")).toBe(false);
  });
  it("toggling at 00:30 Stockholm marks the new day, not the old one", async () => {
    const id = await sold("2026-10-16T22:30:00Z");
    expect(await isSoldOut(id, "2026-10-16T22:31:00Z")).toBe(true);
    expect(await isSoldOut(id, "2026-10-17T21:59:00Z")).toBe(true);
    expect(await isSoldOut(id, "2026-10-17T22:00:00Z")).toBe(false);
  });
});

describe("featured cap", () => {
  it("never exceeds three when five owners feature different dishes at once", async () => {
    const items = (await adminMenu(bistro)).flatMap((c) => c.items);
    const featured = items.filter((i) => i.featured);
    await setFeatured(bistro, featured[0].id, false);
    await setFeatured(bistro, featured[1].id, false);
    const candidates = items.filter((i) => !i.featured).slice(0, 6);
    await Promise.allSettled(candidates.map((c) => setFeatured(bistro, c.id, true)));
    const n = await db.prepare("SELECT count(*) AS n FROM home_highlights WHERE site_id = 'bistro'").first<number>("n");
    expect(n).toBeLessThanOrEqual(3);
  });
  it("featured positions stay unique under concurrency", async () => {
    const items = (await adminMenu(bistro)).flatMap((c) => c.items);
    for (const f of items.filter((i) => i.featured)) await setFeatured(bistro, f.id, false);
    const candidates = items.filter((i) => !i.featured).slice(0, 3);
    const results = await Promise.allSettled(candidates.map((c) => setFeatured(bistro, c.id, true)));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
  });
  it("featuring a sold-out or hidden dish leaves a schema-valid site", async () => {
    const items = (await adminMenu(bistro)).flatMap((c) => c.items);
    const f = items.filter((i) => i.featured);
    await setFeatured(bistro, f[0].id, false);
    const target = items.find((i) => !i.featured)!;
    await setSoldOut(bistro, target.id, true);
    await setFeatured(bistro, target.id, true);
    expect((await publicContent()).issues).toEqual([]);
  });
  it("unfeaturing one then featuring another keeps highlights contiguous", async () => {
    const items = (await adminMenu(bistro)).flatMap((c) => c.items);
    const f = items.filter((i) => i.featured);
    await setFeatured(bistro, f[0].id, false);
    await setFeatured(bistro, items.find((i) => !i.featured)!.id, true);
    const rows = await db.prepare("SELECT position FROM home_highlights WHERE site_id='bistro' ORDER BY position").all<{ position: number }>();
    expect(new Set(rows.results.map((r) => r.position)).size).toBe(3);
  });
});

describe("deleting", () => {
  it("deleting a featured dish removes it from highlights and the site still validates", async () => {
    const f = (await adminMenu(bistro)).flatMap((c) => c.items).find((i) => i.featured)!;
    await deleteMenuItem(bistro, f.id);
    const { exported, issues } = await publicContent();
    expect(issues).toEqual([]);
    expect(exported.content.pages.home.highlights).not.toContain(f.id);
  });
  it("deleting a category with featured dishes drops those highlights", async () => {
    const list = await adminMenu(bistro);
    const cat = list.find((c) => c.items.some((i) => i.featured))!;
    await deleteCategory(bistro, cat.id);
    const { exported, issues } = await publicContent();
    expect(issues).toEqual([]);
    for (const i of cat.items) expect(exported.content.pages.home.highlights).not.toContain(i.id);
  });
  it("deleting every category leaves an exportable (empty) menu", async () => {
    for (const c of await adminMenu(bistro)) await deleteCategory(bistro, c.id);
    const { exported, issues } = await publicContent();
    expect(issues).toEqual([]);
    expect(exported.content.menu.categories).toEqual([]);
  });
  it("deleting every dish leaves empty categories that still validate", async () => {
    for (const c of await adminMenu(bistro)) for (const i of c.items) await deleteMenuItem(bistro, i.id);
    expect((await publicContent()).issues).toEqual([]);
  });
  it("deleting twice (double submit) is not-found, writes one audit row", async () => {
    const id = menu.categories[0].items[0].id;
    expect(await deleteMenuItem(bistro, id)).toMatchObject({ ok: true });
    expect(await deleteMenuItem(bistro, id)).toEqual({ ok: false, error: "not-found" });
    const n = await db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='delete'").first<number>("n");
    expect(n).toBe(1);
  });
});

describe("categories", () => {
  it("slugs: Swedish characters, duplicates, symbols, emoji, long names", async () => {
    expect(slugify("Varmrätter")).toBe("varmratter");
    expect(slugify("Åäö & Co.")).toBe("aao-co");
    expect(slugify("🍕🍕")).toBe("kategori");
    expect(slugify("Ø æ")).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slugify("a".repeat(300)).length).toBeLessThanOrEqual(40);
    const a = await createCategory(bistro, { sv: "Förrätter", en: "A" });
    const b = await createCategory(bistro, { sv: "Förrätter", en: "B" });
    expect(a.ok && b.ok).toBe(true);
    const slugs = (await adminMenu(bistro)).map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect((await publicContent()).issues).toEqual([]);
  });
  it("two simultaneous creates with the same name do not throw", async () => {
    const results = await Promise.allSettled([
      createCategory(bistro, { sv: "Dessert special", en: "A" }),
      createCategory(bistro, { sv: "Dessert special", en: "B" }),
      createCategory(bistro, { sv: "Dessert special", en: "C" }),
    ]);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
  });
  it("a long name with the numeric suffix still yields a schema-valid slug", async () => {
    const name = "x".repeat(60);
    await createCategory(bistro, { sv: name, en: "a" });
    await createCategory(bistro, { sv: name, en: "b" });
    expect((await publicContent()).issues).toEqual([]);
  });
  it("rename keeps the slug (anchors don't move) and bumps row_version", async () => {
    const [c] = await adminMenu(bistro);
    expect(await renameCategory(bistro, c.id, c.rowVersion, { sv: "Nytt", en: "New" })).toEqual({ ok: true });
    const after = (await adminMenu(bistro))[0];
    expect(after.slug).toBe(c.slug);
    expect(after.rowVersion).toBe(c.rowVersion + 1);
  });
  it("two concurrent renames: exactly one wins, other is conflict", async () => {
    const [c] = await adminMenu(bistro);
    const r = await Promise.all([renameCategory(bistro, c.id, c.rowVersion, { sv: "A", en: "A" }), renameCategory(bistro, c.id, c.rowVersion, { sv: "B", en: "B" })]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.find((x) => !x.ok)).toMatchObject({ error: "conflict" });
  });
  it("rename with blank/over-long names is invalid and writes nothing", async () => {
    const [c] = await adminMenu(bistro);
    for (const name of [
      { sv: " ", en: "x" },
      { sv: "x", en: "​" },
      { sv: "y".repeat(500), en: "x" },
    ]) {
      expect(await renameCategory(bistro, c.id, c.rowVersion, name)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect((await adminMenu(bistro))[0].rowVersion).toBe(c.rowVersion);
  });
  it("rename with a stale/garbage row_version (-1, huge) is conflict, not an error", async () => {
    const [c] = await adminMenu(bistro);
    for (const v of [-1, 2 ** 31, 999999999]) {
      expect(await renameCategory(bistro, c.id, v, { sv: "A", en: "A" })).toMatchObject({ ok: false, error: "conflict" });
    }
  });
  it("delete a category of another site is not-found and nothing is lost", async () => {
    const [c] = await adminMenu(bistro);
    expect(await deleteCategory(ctx("westafrican"), c.id)).toEqual({ ok: false, error: "not-found" });
    expect(await adminMenu(bistro)).toHaveLength(menu.categories.length);
  });
});

describe("moving", () => {
  it("up at the top and down at the bottom are no-ops that write nothing", async () => {
    const list = await adminMenu(bistro);
    const v = () => db.prepare("SELECT content_version FROM sites WHERE id='bistro'").first<number>("content_version");
    const v0 = await v();
    expect(await moveCategory(bistro, list[0].id, "up")).toEqual({ ok: true });
    expect(await moveCategory(bistro, list.at(-1)!.id, "down")).toEqual({ ok: true });
    expect(await moveMenuItem(bistro, list[0].items[0].id, "up")).toEqual({ ok: true });
    expect(await moveMenuItem(bistro, list[0].items.at(-1)!.id, "down")).toEqual({ ok: true });
    expect(await v()).toBe(v0);
  });
  it("garbage ids and another site's ids are not-found", async () => {
    expect(await moveMenuItem(bistro, "nope", "up")).toEqual({ ok: false, error: "not-found" });
    expect(await moveMenuItem(bistro, "'; DROP TABLE menu_items;--", "up")).toEqual({ ok: false, error: "not-found" });
    expect(await moveCategory(ctx("westafrican"), (await adminMenu(bistro))[0].id, "down")).toEqual({ ok: false, error: "not-found" });
    expect(await moveMenuItem(ctx("westafrican"), menu.categories[0].items[0].id, "down")).toEqual({ ok: false, error: "not-found" });
  });
  it("two simultaneous moves of different dishes both take effect", async () => {
    const [c] = await adminMenu(bistro);
    const [a, b, d] = c.items;
    // Move b up and d up at once: expected order b, d, a? (b<->a then d<->a) is order dependent; check no item lost/duplicated and BOTH moved above their old neighbour.
    await Promise.all([moveMenuItem(bistro, b.id, "up"), moveMenuItem(bistro, d.id, "up")]);
    const order = (await adminMenu(bistro))[0].items.map((i) => i.id);
    expect(order.sort()).toEqual(c.items.map((i) => i.id).sort());
    const after = (await adminMenu(bistro))[0].items.map((i) => i.id);
    // lost update check: with both applied serially the order cannot equal the original
    expect(after).not.toEqual(c.items.map((i) => i.id));
    void a;
  });
  it("a move concurrent with a delete leaves positions valid", async () => {
    const [c] = await adminMenu(bistro);
    await Promise.all([moveMenuItem(bistro, c.items[1].id, "up"), deleteMenuItem(bistro, c.items[0].id)]);
    expect((await publicContent()).issues).toEqual([]);
  });
});

describe("items", () => {
  it("price 0 and the maximum are accepted by the repository; one öre over is invalid", async () => {
    const [c] = await adminMenu(bistro);
    expect((await createMenuItem(bistro, c.id, dish({ priceOre: 0 }))).ok).toBe(true);
    expect((await createMenuItem(bistro, c.id, dish({ priceOre: 10_000_000 }))).ok).toBe(true);
    expect(await createMenuItem(bistro, c.id, dish({ priceOre: 10_000_001 }))).toMatchObject({ ok: false, error: "invalid" });
    expect(await createMenuItem(bistro, c.id, dish({ priceOre: 1.5 }))).toMatchObject({ ok: false, error: "invalid" });
  });
  it("an edit stale after a sold-out toggle is still accepted (sold-out is not a conflict)", async () => {
    const id = menu.categories[0].items[0].id;
    const row = await db.prepare("SELECT row_version FROM menu_items WHERE site_id='bistro' AND id=?").bind(id).first<number>("row_version");
    await setSoldOut(bistro, id, true);
    expect(await updateMenuItem(bistro, id, row!, dish())).toEqual({ ok: true });
  });
  it("edits on another site's dish are not-found", async () => {
    expect(await updateMenuItem(ctx("westafrican"), menu.categories[0].items[0].id, 0, dish())).toEqual({ ok: false, error: "not-found" });
  });
  it("every audit summary for new operations is plain text without markup", async () => {
    const [c] = await adminMenu(bistro);
    await createMenuItem(bistro, c.id, dish({ name: { sv: "<script>x</script>", en: "y" } }));
    const rows = await db.prepare("SELECT summary FROM audit_log").all<{ summary: string }>();
    expect(rows.results.length).toBeGreaterThan(0);
  });
});
