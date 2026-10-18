/**
 * Tester (M2): rows the content schema (src/content/schema.ts) rejects, pushed straight at the
 * database to see whether the second wall (ADR-011 §8) holds. Tests named "rejects ..." are
 * expected to be rejected; a failure there is a gap in the CHECKs. Tests named "accepts ...
 * (by design)" document rows the database deliberately leaves to the app.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const IMG = "a".repeat(64);
const ITEM = "item00000001";
const CAT = "cat000000001";
const USER = "user00000001";

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro')"),
    db.prepare("INSERT INTO sites (id) VALUES ('westafrican')"),
    db.prepare("INSERT INTO images (site_id, id, kind, path, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'static', '/images/bistro/a.jpg', 'image/jpeg', 'Foto', 'Photo')").bind(IMG),
    db.prepare(
      `INSERT INTO settings (site_id, name_sv, name_en, tagline_sv, tagline_en, cuisine_sv, cuisine_en, address, phone, email)
       VALUES ('bistro', 'Bistro', 'Bistro', 'Mat', 'Food', 'Svensk', 'Swedish', 'Gatan 1', '+46 8 123 45 67', 'hej@x.se')`,
    ),
    db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('bistro', ?, 'mains', 'Varmrätter', 'Mains', 0)").bind(CAT),
    db.prepare(
      `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position)
       VALUES ('bistro', ?, ?, 'Soppa', 'Soup', 'Varm', 'Hot', 14500, 0)`,
    ).bind(ITEM, CAT),
    db.prepare("INSERT INTO users (id, email) VALUES (?, 'owner@x.se')").bind(USER),
    db.prepare("INSERT INTO memberships (user_id, site_id, role) VALUES (?, 'bistro', 'owner')").bind(USER),
  ]);
});

/** Runs the statement; returns the error message, or null if the database accepted it. */
async function attempt(sql: string, ...params: unknown[]): Promise<string | null> {
  try {
    await db.prepare(sql).bind(...params).run();
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}
const updateItem = (set: string, ...params: unknown[]) => attempt(`UPDATE menu_items SET ${set} WHERE id = '${ITEM}'`, ...params);
const exception = (date: string) =>
  attempt("INSERT INTO hours_exceptions (site_id, date, note_sv, note_en) VALUES ('bistro', ?, 'Stängt', 'Closed')", date);

describe("hours_exceptions.date: date(date) = date is NULL for impossible dates, and a NULL CHECK passes", () => {
  it.each(["0000-00-00", "2026-13-01", "2026-02-32", "2026-00-10", "2026-12-00"])("rejects %s", async (date) => {
    expect(await exception(date)).toMatch(/CHECK/);
  });

  it("rejects 2026-02-30 (already covered: date() normalises it to March)", async () => {
    expect(await exception("2026-02-30")).toMatch(/CHECK/);
  });
});

describe("menu_items.sold_out_on is only pattern-checked", () => {
  it.each(["2026-19-39", "0000-00-00", "2026-02-31"])("rejects %s", async (date) => {
    expect(await updateItem("sold_out_on = ?", date)).toMatch(/CHECK/);
  });
});

describe("tag and allergen vocabularies are the schema's job (by design, see 0001_content.sql)", () => {
  it.each<[string, string]>([
    ["a tag outside the vocabulary", `tags = '["halal"]'`],
    ["a repeated tag", `tags = '["vegan","vegan"]'`],
    ["an allergen outside EU-14", `allergens = '["shellfish"]'`],
    ["a repeated allergen", `allergens = '["milk","milk"]'`],
  ])("accepts %s in the database", async (_name, set) => {
    expect(await updateItem(set)).toBeNull();
  });

  it("still rejects anything that isn't a JSON array", async () => {
    expect(await updateItem(`tags = '{"a":1}'`)).toMatch(/CHECK/);
  });
});

describe("bilingual text: SQLite's trim() only strips spaces", () => {
  it.each<[string, string]>([
    ["a name that is only a newline", "name_en = char(10)"],
    ["a name that is only a tab", "name_sv = char(9)"],
    ["a name that is only a zero-width space", "name_en = char(8203)"],
    ["a name that is only a no-break space", "name_en = char(160)"],
  ])("rejects %s", async (_name, set) => {
    expect(await updateItem(set)).toMatch(/CHECK/);
  });
});

describe("length caps are the schema's job (by design: SQLite counts code points, not characters as read)", () => {
  it("accepts an 81-character name in the database", async () => {
    expect(await updateItem("name_sv = ?", "x".repeat(81))).toBeNull();
  });
});

describe("images.path is not tied to the site's folder", () => {
  const insert = (path: string) =>
    attempt("INSERT INTO images (site_id, id, kind, path, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'static', ?, 'image/jpeg', 'Foto', 'Photo')", "b".repeat(64), path);
  it("rejects another site's folder", async () => {
    expect(await insert("/images/westafrican/x.jpg")).toMatch(/CHECK/);
  });
  it("rejects a path that climbs out of /images/", async () => {
    expect(await insert("/images/bistro/../../admin/index.html")).toMatch(/CHECK/);
  });
});

describe("settings formats are looser than the schema", () => {
  const update = (set: string) => attempt(`UPDATE settings SET ${set} WHERE site_id = 'bistro'`);
  it("rejects a phone number with no digits", async () => {
    expect(await update("phone = 'call us!'")).toMatch(/CHECK/);
  });
  it("rejects an email with a space", async () => {
    expect(await update("email = 'hej du@x.se'")).toMatch(/CHECK/);
  });
});

describe("auth timestamps are compared as text but their format is never checked", () => {
  it("rejects a session whose expiry is before its creation once formats are mixed", async () => {
    // '2026-10-16 23:00:00' sorts before '2026-10-16T09:00:00Z' (space < T), yet the second
    // string is in fact the later of the two. Here the expiry is "later" only as text.
    const error = await attempt(
      "INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', ?, ?, ?)",
      "e".repeat(64),
      USER,
      "2026-10-16 23:00:00",
      "2026-10-16 23:00:00",
      "2026-10-16T09:00:00Z",
    );
    expect(error).toMatch(/CHECK/);
  });

  it("rejects a session expiring before it was created (same format)", async () => {
    const error = await attempt(
      "INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', ?, ?, ?)",
      "e".repeat(64),
      USER,
      "2026-10-16T10:00:00Z",
      "2026-10-16T10:00:00Z",
      "2026-10-16T09:00:00Z",
    );
    expect(error).toMatch(/CHECK/);
  });
});

describe("cross-site references are impossible (composite foreign keys)", () => {
  it.each<[string, string]>([
    ["an item in another site's category", `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position)
       VALUES ('westafrican', 'item00000002', '${CAT}', 'A', 'A', 'B', 'B', 1, 0)`],
    ["a highlight of another site's item", `INSERT INTO home_highlights (site_id, item_id, position) VALUES ('westafrican', '${ITEM}', 0)`],
    ["a gallery entry using another site's image", `INSERT INTO gallery_images (site_id, id, image_id, position) VALUES ('westafrican', 'gal000000001', '${IMG}', 0)`],
    ["a membership-less session on another site", `INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at)
       VALUES ('${"f".repeat(64)}', '${USER}', 'westafrican', '2026-10-16T10:00:00Z', '2026-10-16T10:00:00Z', '2026-11-16T10:00:00Z')`],
  ])("rejects %s", async (_name, sql) => {
    expect(await attempt(sql)).toMatch(/FOREIGN KEY/);
  });
});

describe("left to the app (by design or not expressible as a CHECK)", () => {
  it("accepts a site with fewer than seven weekly_hours rows (by design: no CHECK can count rows)", async () => {
    expect(await attempt("INSERT INTO weekly_hours (site_id, weekday, opens, closes) VALUES ('bistro', 0, '11:00', '14:00')")).toBeNull();
    expect(await db.prepare("SELECT count(*) AS n FROM weekly_hours WHERE site_id = 'bistro'").first("n")).toBe(1);
  });

  it("accepts a highlight of an unavailable or sold-out dish (by design: the home page skips it)", async () => {
    await updateItem("available = 0, sold_out_on = '2026-10-16'");
    expect(await attempt(`INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', '${ITEM}', 0)`)).toBeNull();
  });

  it("accepts an exception outside 2000-2099 (by design: the range is the schema's)", async () => {
    expect(await exception("1999-12-31")).toBeNull();
  });

  it("accepts two dishes at the same position (export order is then undefined)", async () => {
    expect(
      await attempt(
        `INSERT INTO menu_items (site_id, id, category_id, name_sv, name_en, description_sv, description_en, price_ore, position)
         VALUES ('bistro', 'item00000002', '${CAT}', 'B', 'B', 'B', 'B', 1, 0)`,
      ),
    ).toBeNull();
  });

  it("accepts a javascript: URL as a social link (the schema is the only check)", async () => {
    expect(await attempt(`UPDATE settings SET social_links = '{"instagram":"javascript:alert(1)"}' WHERE site_id = 'bistro'`)).toBeNull();
  });
});
