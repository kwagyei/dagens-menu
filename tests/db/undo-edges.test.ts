/**
 * ADR-018, tester's edge cases (2026-10-19): the snapshot SQL for odd content, the restore's
 * place in categories with gaps, ties and growth, the shift staying in its own category and
 * site, the guards (cross-site category and image, owner's pick vs the original category),
 * and parseSnapshot refusing rows the database accepts.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { siteContentSchema } from "../../src/content/schema";
import { adminMenu, createMenuItem } from "../../src/db/menu";
import { deleteMenuItem, getMenuItem, type MenuItemEdit, type RepoContext, restoreMenuItem } from "../../src/db/repository";
import { type ImageResolver, seedStatements, type StoredContent } from "../../src/db/seed";
import { prepare } from "../../src/db/sql";
import { parseSnapshot } from "../../src/db/undo";

const db = env.DB;
const now = new Date("2026-10-19T12:00:00Z");
const ctx = (siteId: string): RepoContext => ({ db, siteId, userId: null, now });
const bistro = ctx("bistro");
const abena = ctx("westafrican");

const imageIds = new Map<string, string>();
const fakeImages: ImageResolver = (path) => {
  if (!imageIds.has(path)) imageIds.set(path, (imageIds.size + 1).toString(16).padStart(64, "0"));
  return { id: imageIds.get(path)!, mime: "image/jpeg" };
};
async function load(site: "bistro" | "westafrican") {
  const [settings, hours, menu, pages, gallery, images, theme] = await Promise.all(
    ["settings", "hours", "menu", "pages", "gallery", "images"]
      .map((f) => import(`../../sites/${site}/content/${f}.json`).then((m) => m.default))
      .concat(import(`../../sites/${site}/theme.json`).then((m) => m.default)),
  );
  const { theme: _t, ...content } = siteContentSchema(site).parse({ settings, hours, menu, pages, gallery, images, theme });
  return content as StoredContent;
}

const all = async <T>(sql: string, ...params: unknown[]) =>
  (
    await db
      .prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
const one = <T>(sql: string, ...params: unknown[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .first<T>();

async function deleted(c: RepoContext, id: string) {
  const result = await deleteMenuItem(c, id);
  expect(result).toMatchObject({ ok: true });
  return String((result as { entryId: number }).entryId);
}
/** The dish ids of a category in admin order. */
async function order(c: RepoContext, categoryId: string) {
  return (await adminMenu(c)).find((x) => x.id === categoryId)!.items.map((i) => i.id);
}
const positions = (site: string, categoryId: string) =>
  all<{ id: string; position: number }>("SELECT id, position FROM menu_items WHERE site_id = ? AND category_id = ? ORDER BY position, id", site, categoryId);

/** An empty category of its own, so a test controls every dish and position in it. */
async function freshCategory(site: string, slug: string) {
  const id = slug
    .replace(/[^a-z0-9]/g, "")
    .padEnd(12, "0")
    .slice(0, 12);
  await db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES (?, ?, ?, 'Test', 'Test', 99)").bind(site, id, slug).run();
  return id;
}
/** A dish written straight into a position, as an old import or a renumber could leave it. */
async function dishAt(site: string, categoryId: string, id: string, position: number) {
  await db
    .prepare("INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position) VALUES (?, ?, ?, ?, ?, 'd', 'd', 1000, ?)")
    .bind(site, id, categoryId, `Rätt ${id}`, `Dish ${id}`, position)
    .run();
}
const edit = (over: Partial<MenuItemEdit> = {}): MenuItemEdit => ({
  name: { sv: "Rätt", en: "Dish" },
  description: { sv: "Beskrivning", en: "Description" },
  priceOre: 12900,
  tags: [],
  allergens: [],
  available: true,
  ...over,
});

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM sites"), db.prepare("DELETE FROM users")]);
  const [b, a] = [await load("bistro"), await load("westafrican")];
  await db.batch(prepare(db, seedStatements("bistro", b, fakeImages)));
  await db.batch(prepare(db, seedStatements("westafrican", a, fakeImages)));
});

describe("(a) the snapshot of odd content round-trips exactly", () => {
  const cases: Array<[string, Partial<MenuItemEdit>]> = [
    ["quotes and backslashes", { name: { sv: `"Köttbullar" \\ 'mormors'`, en: `O'Brien's "stew" \\n` }, description: { sv: `a\\b "c" ''`, en: `C:\\path\\x "y"` } }],
    ["newlines and tabs in the description", { description: { sv: "rad ett\nrad två\r\nrad tre\tflik", en: "line\n\nline" } }],
    ["emoji, combining marks and RTL", { name: { sv: "🍲 Gryta 👨‍👩‍👧", en: "Stew ﷺ שלום" }, description: { sv: "e\u0301 → é, 🇸🇪", en: "日本語のテキスト" } }],
    ["the 80- and 300-character limits", { name: { sv: "å".repeat(80), en: "🍜".repeat(80) }, description: { sv: "ö".repeat(300), en: "x".repeat(300) } }],
    ["JSON-looking text", { name: { sv: '{"v":2}', en: "[1,2]" }, description: { sv: "null", en: "true" } }],
    [
      "every tag and allergen, unavailable",
      {
        tags: ["vegan", "vegetarian", "gluten-free", "spicy"],
        allergens: ["gluten", "crustaceans", "eggs", "fish", "peanuts", "soybeans", "milk", "nuts", "celery", "mustard", "sesame", "sulphites", "lupin", "molluscs"],
        available: false,
        priceOre: 0,
      },
    ],
  ];
  it.each(cases)("%s", async (_label, over) => {
    const category = (await adminMenu(bistro))[0].id;
    const created = await createMenuItem(bistro, category, edit(over));
    expect(created).toMatchObject({ ok: true });
    const id = created.id!;
    const before = (await getMenuItem(bistro, id))!;
    const entry = await deleted(bistro, id);
    const payload = (await one<{ payload: string }>("SELECT payload FROM audit_log WHERE id = ?", Number(entry)))!.payload;
    const snapshot = parseSnapshot(payload, "bistro", id);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.item.name).toEqual(before.name);
    expect(snapshot!.item.description).toEqual(before.description);
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await getMenuItem(bistro, id)).toEqual({ ...before, rowVersion: before.rowVersion + 1 });
  });

  it("a dish sold out today keeps its sold_out_on", async () => {
    const category = (await adminMenu(bistro))[0].id;
    const id = (await createMenuItem(bistro, category, edit())).id!;
    await db.prepare("UPDATE menu_items SET sold_out_on = '2026-10-19' WHERE site_id = 'bistro' AND id = ?").bind(id).run();
    const entry = await deleted(bistro, id);
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect((await one<{ s: string }>("SELECT sold_out_on AS s FROM menu_items WHERE site_id = 'bistro' AND id = ?", id))!.s).toBe("2026-10-19");
  });

  it("tags stored with whitespace are normalised by json() and still parse", async () => {
    const category = (await adminMenu(bistro))[0].id;
    const id = (await createMenuItem(bistro, category, edit())).id!;
    await db.prepare(`UPDATE menu_items SET tags = '[ "vegan" ,  "spicy" ]' WHERE site_id = 'bistro' AND id = ?`).bind(id).run();
    const entry = await deleted(bistro, id);
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect((await getMenuItem(bistro, id))!.tags).toEqual(["vegan", "spicy"]);
  });
});

describe("(a) the restored place", () => {
  it("first, last and only dish come back where they were", async () => {
    const c = await freshCategory("bistro", "places");
    for (const [id, p] of [
      ["aaaaaaaaaaa1", 0],
      ["aaaaaaaaaaa2", 1],
      ["aaaaaaaaaaa3", 2],
    ] as const)
      await dishAt("bistro", c, id, p);
    const before = await order(bistro, c);
    for (const id of ["aaaaaaaaaaa1", "aaaaaaaaaaa3"]) {
      const entry = await deleted(bistro, id);
      expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
      expect(await order(bistro, c)).toEqual(before);
    }
    const solo = await freshCategory("bistro", "solo");
    await dishAt("bistro", solo, "sssssssssss1", 0);
    const entry = await deleted(bistro, "sssssssssss1");
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await positions("bistro", solo)).toEqual([{ id: "sssssssssss1", position: 0 }]);
  });

  it("the category grew since the delete: back in its place, the newer dish stays after it", async () => {
    const c = await freshCategory("bistro", "grew");
    for (const [id, p] of [
      ["ggggggggggg1", 0],
      ["ggggggggggg2", 1],
      ["ggggggggggg3", 2],
    ] as const)
      await dishAt("bistro", c, id, p);
    const entry = await deleted(bistro, "ggggggggggg2");
    const added = (await createMenuItem(bistro, c, edit())).id!;
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await order(bistro, c)).toEqual(["ggggggggggg1", "ggggggggggg2", "ggggggggggg3", added]);
  });

  // Deletes leave gaps (deleteMenuItem never renumbers). The clamp is `min(position, count(*))`,
  // a count compared against position values, so with gaps it can land before dishes that
  // were before the deleted one.
  it("two deletes, undo the later one: it comes back after the dish that was before it", async () => {
    const c = await freshCategory("bistro", "gaps");
    for (const [id, p] of [
      ["ppppppppppp1", 0],
      ["ppppppppppp2", 1],
      ["ppppppppppp3", 2],
    ] as const)
      await dishAt("bistro", c, id, p);
    await deleted(bistro, "ppppppppppp1");
    const entry = await deleted(bistro, "ppppppppppp3");
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await order(bistro, c)).toEqual(["ppppppppppp2", "ppppppppppp3"]);
  });

  it("positions with gaps: the last dish comes back last", async () => {
    const c = await freshCategory("bistro", "sparse");
    for (const [id, p] of [
      ["qqqqqqqqqqq1", 0],
      ["qqqqqqqqqqq2", 5],
      ["qqqqqqqqqqq3", 10],
    ] as const)
      await dishAt("bistro", c, id, p);
    const entry = await deleted(bistro, "qqqqqqqqqqq3");
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await order(bistro, c)).toEqual(["qqqqqqqqqqq1", "qqqqqqqqqqq2", "qqqqqqqqqqq3"]);
  });

  it("positions with gaps: a middle dish comes back in the middle", async () => {
    const c = await freshCategory("bistro", "sparse-mid");
    for (const [id, p] of [
      ["rrrrrrrrrrr1", 0],
      ["rrrrrrrrrrr2", 3],
      ["rrrrrrrrrrr3", 5],
    ] as const)
      await dishAt("bistro", c, id, p);
    const entry = await deleted(bistro, "rrrrrrrrrrr2");
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await order(bistro, c)).toEqual(["rrrrrrrrrrr1", "rrrrrrrrrrr2", "rrrrrrrrrrr3"]);
  });

  it("two dishes sharing a position (hand-written rows only): the restored one takes the place, the other moves down", async () => {
    // Accepted (ADR-018 limits): everything at or after the place moves down one, so a tie can
    // swap. The app never writes a tie; the rule keeps a dish restored into a chosen category
    // exactly where it should be.
    const c = await freshCategory("bistro", "ties");
    // admin order is (position, id): t1(0), t2(1), t3(1), t4(2)
    for (const [id, p] of [
      ["ttttttttttt1", 0],
      ["ttttttttttt2", 1],
      ["ttttttttttt3", 1],
      ["ttttttttttt4", 2],
    ] as const)
      await dishAt("bistro", c, id, p);
    const entry = await deleted(bistro, "ttttttttttt3");
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    expect(await order(bistro, c)).toEqual(["ttttttttttt1", "ttttttttttt3", "ttttttttttt2", "ttttttttttt4"]);
  });
});

describe("(a) the shift stays in its category and site", () => {
  it("dishes of other categories and of the other site keep their positions", async () => {
    const dish = (await adminMenu(bistro))[1].items[0];
    const otherCats = await all<{ site_id: string; id: string; position: number }>(
      "SELECT site_id, id, position FROM menu_items WHERE NOT (site_id = 'bistro' AND category_id = (SELECT category_id FROM menu_items WHERE site_id = 'bistro' AND id = ?)) ORDER BY site_id, id",
      dish.id,
    );
    // Put a westafrican category under the same id as the bistro one, with a dish at the same position.
    const bistroCat = (await one<{ c: string }>("SELECT category_id AS c FROM menu_items WHERE site_id = 'bistro' AND id = ?", dish.id))!.c;
    await db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('westafrican', ?, 'twin', 'T', 'T', 50)").bind(bistroCat).run();
    await dishAt("westafrican", bistroCat, "twintwintwin", 0);
    const entry = await deleted(bistro, dish.id);
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true });
    const after = await all<{ site_id: string; id: string; position: number }>(
      "SELECT site_id, id, position FROM menu_items WHERE NOT (site_id = 'bistro' AND category_id = ?) AND id <> 'twintwintwin' ORDER BY site_id, id",
      bistroCat,
    );
    expect(after).toEqual(otherCats);
    expect(await positions("westafrican", bistroCat)).toEqual([{ id: "twintwintwin", position: 0 }]);
  });
});

describe("(b) the guards", () => {
  it("an owner-chosen category of the other site is ignored: needs-category, nothing written", async () => {
    const dish = (await adminMenu(bistro))[1].items[0];
    const entry = await deleted(bistro, dish.id);
    // Make the original category unfindable by id and by slug.
    await db
      .prepare("DELETE FROM menu_categories WHERE site_id = 'bistro' AND id = (SELECT json_extract(payload, '$.categoryId') FROM audit_log WHERE id = ?)")
      .bind(Number(entry))
      .run();
    const abenaCat = (await adminMenu(abena))[0].id;
    const writes = await one<{ n: number }>("SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM menu_items) AS n");
    expect(await restoreMenuItem(bistro, entry, abenaCat)).toEqual({ ok: false, error: "needs-category" });
    expect(await one<{ n: number }>("SELECT (SELECT count(*) FROM audit_log) + (SELECT count(*) FROM menu_items) AS n")).toEqual(writes);
  });

  it("a snapshot naming the other site's image restores without a photo (no FK error, no 500)", async () => {
    const dish = (await adminMenu(bistro))[1].items[0];
    const abenaOnly = (await one<{ id: string }>("SELECT id FROM images WHERE site_id = 'westafrican' AND id NOT IN (SELECT id FROM images WHERE site_id = 'bistro') LIMIT 1"))?.id;
    if (!abenaOnly) {
      await db.prepare("INSERT INTO images (site_id, id, kind, mime) VALUES ('westafrican', ?, 'upload', 'image/jpeg')").bind("f".repeat(64)).run();
    }
    const foreign = abenaOnly ?? "f".repeat(64);
    const entry = await deleted(bistro, dish.id);
    await db.prepare("UPDATE audit_log SET payload = json_set(payload, '$.imageId', ?) WHERE id = ?").bind(foreign, Number(entry)).run();
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true, photoLost: true });
    expect((await one<{ i: string | null }>("SELECT image_id AS i FROM menu_items WHERE site_id = 'bistro' AND id = ?", dish.id))!.i).toBeNull();
  });

  it("a photo of this site relinks (the FK is (site_id, image_id); kind plays no part)", async () => {
    const withPhoto = (await all<{ id: string; image_id: string }>("SELECT id, image_id FROM menu_items WHERE site_id = 'bistro' AND image_id IS NOT NULL LIMIT 1"))[0];
    const entry = await deleted(bistro, withPhoto.id);
    expect(await restoreMenuItem(bistro, entry)).toMatchObject({ ok: true, photoLost: false });
    expect((await one<{ i: string }>("SELECT image_id AS i FROM menu_items WHERE site_id = 'bistro' AND id = ?", withPhoto.id))!.i).toBe(withPhoto.image_id);
  });

  it("the original category still exists: an owner pick of another category is ignored (dish goes home)", async () => {
    const menu = await adminMenu(bistro);
    const dish = menu[1].items[0];
    const entry = await deleted(bistro, dish.id);
    expect(await restoreMenuItem(bistro, entry, menu[0].id)).toMatchObject({ ok: true });
    expect((await one<{ c: string }>("SELECT category_id AS c FROM menu_items WHERE site_id = 'bistro' AND id = ?", dish.id))!.c).toBe(menu[1].id);
  });

  it("the entry purged after undoableEntry would have passed: the batch still writes dish + audit together or nothing", async () => {
    const dish = (await adminMenu(bistro))[1].items[0];
    const entry = await deleted(bistro, dish.id);
    await db.prepare("DELETE FROM audit_log WHERE id = ?").bind(Number(entry)).run();
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "not-found" });
    expect(await getMenuItem(bistro, dish.id)).toBeNull();
  });

  it("never a highlight or audit row without the dish, never the dish without its audit row", async () => {
    const dishes = (await adminMenu(bistro)).flatMap((c) => c.items.map((i) => i.id));
    for (const id of dishes.slice(0, 6)) {
      const entry = await deleted(bistro, id);
      await restoreMenuItem(bistro, entry);
    }
    const orphanHighlights = await one<{ n: number }>(
      "SELECT count(*) AS n FROM home_highlights h WHERE NOT EXISTS (SELECT 1 FROM menu_items m WHERE m.site_id = h.site_id AND m.id = h.item_id)",
    );
    expect(orphanHighlights!.n).toBe(0);
    const restoredWithoutRow = await one<{ n: number }>(
      "SELECT count(*) AS n FROM menu_items m WHERE m.site_id = 'bistro' AND m.id IN (SELECT entity_id FROM audit_log WHERE action = 'delete') AND NOT EXISTS (SELECT 1 FROM audit_log a WHERE a.site_id = 'bistro' AND a.entity_id = m.id AND a.summary LIKE '%: restored')",
    );
    expect(restoredWithoutRow!.n).toBe(0);
  });
});

describe("(c) parseSnapshot refuses what the database accepts", () => {
  const good = {
    v: 1,
    item: { id: "abcdefabcdef", name: { sv: "A", en: "A" }, description: { sv: "B", en: "B" }, price: 100, tags: [], allergens: [], available: true },
    categoryId: "cccccccccccc",
    categorySlug: "mains",
    position: 0,
    soldOutOn: null,
    imageId: null,
    rowVersion: 0,
    highlight: null,
  };
  const variant = (patch: (s: typeof good & Record<string, unknown>) => void) => {
    const s = structuredClone(good) as typeof good & Record<string, unknown>;
    patch(s);
    return JSON.stringify(s);
  };
  it("accepts the good one", () => {
    expect(parseSnapshot(JSON.stringify(good), "bistro", "abcdefabcdef")).not.toBeNull();
  });
  it.each<[string, (s: Record<string, unknown> & typeof good) => void]>([
    ["v: 2", (s) => (s.v = 2 as 1)],
    ["v as a string", (s) => ((s as Record<string, unknown>).v = "1")],
    ["an extra top-level key", (s) => (s.extra = 1)],
    ["an extra item key", (s) => ((s.item as Record<string, unknown>).extra = 1)],
    ["item.image present", (s) => ((s.item as Record<string, unknown>).image = "/images/bistro/x.jpg")],
    ["highlight negative", (s) => (s.highlight = -1 as unknown as null)],
    ["highlight float", (s) => (s.highlight = 1.5 as unknown as null)],
    ["position float", (s) => (s.position = 1.5)],
    ["position negative", (s) => (s.position = -1)],
    ["position as a string", (s) => ((s as Record<string, unknown>).position = "1")],
    ["rowVersion negative", (s) => (s.rowVersion = -1)],
    ["imageId uppercase hex", (s) => (s.imageId = "A".repeat(64) as unknown as null)],
    ["imageId 63 chars", (s) => (s.imageId = "a".repeat(63) as unknown as null)],
    ["categoryId uppercase", (s) => (s.categoryId = "CCCCCCCCCCCC")],
    ["categorySlug empty", (s) => (s.categorySlug = "")],
    ["price float", (s) => (s.item.price = 1.5)],
    ["price as a string", (s) => ((s.item as Record<string, unknown>).price = "100")],
    ["available as 1", (s) => ((s.item as Record<string, unknown>).available = 1)],
    ["unknown tag", (s) => ((s.item as Record<string, unknown>).tags = ["halal"])],
    ["repeated allergen", (s) => ((s.item as Record<string, unknown>).allergens = ["milk", "milk"])],
    ["name 81 characters", (s) => (s.item.name.sv = "a".repeat(81))],
    ["whitespace-only description", (s) => (s.item.description.en = "   ")],
    ["missing highlight key", (s) => delete (s as Record<string, unknown>).highlight],
    ["item.id mismatching the entry", (s) => (s.item.id = "zzzzzzzzzzzz")],
  ])("%s", (_label, patch) => {
    expect(parseSnapshot(variant(patch), "bistro", "abcdefabcdef")).toBeNull();
  });
  it("refuses a soldOutOn that isn't a date", () => {
    expect(
      parseSnapshot(
        variant((s) => ((s as Record<string, unknown>).soldOutOn = "not a date")),
        "bistro",
        "abcdefabcdef",
      ),
    ).toBeNull();
  });
  it("a JSON array, null, a number and broken JSON", () => {
    for (const p of ["[]", "null", "1", "{", ""]) expect(parseSnapshot(p, "bistro", "abcdefabcdef")).toBeNull();
    expect(parseSnapshot(null, "bistro", "abcdefabcdef")).toBeNull();
  });
});

describe("(c) a non-date soldOutOn reaching restore", () => {
  it("is refused as invalid before any write, so nothing is written and nothing throws", async () => {
    const dish = (await adminMenu(bistro))[1].items[0];
    const entry = await deleted(bistro, dish.id);
    await db.prepare("UPDATE audit_log SET payload = json_set(payload, '$.soldOutOn', 'tomorrow') WHERE id = ?").bind(Number(entry)).run();
    const before = await one<{ a: number; m: number; v: number }>(
      "SELECT (SELECT count(*) FROM audit_log) AS a, (SELECT count(*) FROM menu_items) AS m, (SELECT content_version FROM sites WHERE id = 'bistro') AS v",
    );
    expect(await restoreMenuItem(bistro, entry)).toEqual({ ok: false, error: "invalid" });
    expect(await one("SELECT (SELECT count(*) FROM audit_log) AS a, (SELECT count(*) FROM menu_items) AS m, (SELECT content_version FROM sites WHERE id = 'bistro') AS v")).toEqual(
      before,
    );
    // Record what the caller sees: a thrown error is a 500 on the route.
  });
});
