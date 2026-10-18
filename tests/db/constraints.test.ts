/**
 * The database's own rules, tested with raw SQL that bypasses the app: each case starts from
 * one valid row per table and breaks one column. These constraints are the second wall
 * behind the content schema (ADR-011 §8), so each must hold on its own.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const db = env.DB;
const IMG = "a".repeat(64);
const ITEM = "item00000001";
const CAT = "cat000000001";
const USER = "user00000001";

async function seedValidRows() {
  // Storage is isolated per file, not per test: start each test from empty.
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("DELETE FROM users"),
    db.prepare("DELETE FROM rate_limits"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro')"),
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
}

beforeEach(seedValidRows);

async function rejected(sql: string, ...params: unknown[]): Promise<string> {
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error(`accepted: ${sql}`);
}

describe("a valid baseline", () => {
  it("is accepted", async () => {
    const row = await db.prepare("SELECT price_ore, available, tags FROM menu_items").first();
    expect(row).toEqual({ price_ore: 14500, available: 1, tags: "[]" });
  });
});

const updateItem = (set: string, ...params: unknown[]) => rejected(`UPDATE menu_items SET ${set} WHERE id = '${ITEM}'`, ...params);

describe("menu_items rejects", () => {
  it.each<[string, () => Promise<string>, RegExp]>([
    ["a negative price", () => updateItem("price_ore = -1"), /CHECK/],
    ["a price over 100 000 kr", () => updateItem("price_ore = 10000001"), /CHECK/],
    ["a fractional price (STRICT)", () => updateItem("price_ore = 145.5"), /cannot store REAL/],
    ["a price as text (STRICT)", () => updateItem("price_ore = 'gratis'"), /cannot store TEXT/],
    ["an empty English name", () => updateItem("name_en = '   '"), /CHECK/],
    ["a missing description", () => updateItem("description_sv = NULL"), /NOT NULL/],
    ["tags that aren't a JSON array", () => updateItem("tags = '{\"a\":1}'"), /CHECK/],
    ["invalid JSON allergens", () => updateItem("allergens = 'milk'"), /CHECK/],
    ["available other than 0/1", () => updateItem("available = 2"), /CHECK/],
    ["a malformed sold-out date", () => updateItem("sold_out_on = 'idag'"), /CHECK/],
    ["an item id that isn't 12 lowercase characters", () => updateItem("id = 'Soup'"), /CHECK/],
    ["a category from nowhere", () => updateItem("category_id = 'cat999999999'"), /FOREIGN KEY/],
    ["an image from nowhere", () => updateItem("image_id = ?", "b".repeat(64)), /FOREIGN KEY/],
  ])("%s", async (_name, run, error) => {
    expect(await run()).toMatch(error);
  });

  it("cascades: deleting a category deletes its items and their highlights", async () => {
    await db.prepare("INSERT INTO home_highlights (site_id, item_id, position) VALUES ('bistro', ?, 0)").bind(ITEM).run();
    await db.prepare("DELETE FROM menu_categories WHERE id = ?").bind(CAT).run();
    expect(await db.prepare("SELECT count(*) AS n FROM menu_items").first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) AS n FROM home_highlights").first("n")).toBe(0);
  });

  it("protects: an image in use can't be deleted", async () => {
    await db.prepare("UPDATE menu_items SET image_id = ? WHERE id = ?").bind(IMG, ITEM).run();
    expect(await rejected("DELETE FROM images WHERE id = ?", IMG)).toMatch(/FOREIGN KEY/);
  });
});

describe("menu_categories rejects", () => {
  it.each([
    ["a slug with a space", "slug = 'main courses'"],
    ["a slug with capitals", "slug = 'Mains'"],
    ["a slug ending in a hyphen", "slug = 'mains-'"],
    ["a slug with a double hyphen", "slug = 'main--courses'"],
    ["a negative position", "position = -1"],
  ])("%s", async (_name, set) => {
    expect(await rejected(`UPDATE menu_categories SET ${set} WHERE id = '${CAT}'`)).toMatch(/CHECK/);
  });

  it("a duplicate slug on the same site", async () => {
    expect(
      await rejected("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('bistro', 'cat000000002', 'mains', 'A', 'A', 1)"),
    ).toMatch(/UNIQUE/);
  });
});

describe("hours reject", () => {
  const weekly = (opens: string | null, closes: string | null) =>
    rejected("INSERT INTO weekly_hours (site_id, weekday, opens, closes) VALUES ('bistro', 0, ?, ?)", opens, closes);
  const exception = (date: string, opens: string | null = null, closes: string | null = null) =>
    rejected("INSERT INTO hours_exceptions (site_id, date, opens, closes, note_sv, note_en) VALUES ('bistro', ?, ?, ?, 'Stängt', 'Closed')", date, opens, closes);

  it.each<[string, () => Promise<string>]>([
    ["a weekday of 7", () => rejected("INSERT INTO weekly_hours (site_id, weekday) VALUES ('bistro', 7)")],
    ["opening without closing", () => weekly("11:00", null)],
    ["24:00", () => weekly("11:00", "24:00")],
    ["a 12-hour time", () => weekly("11am", "22:00")],
    ["opening and closing at the same minute", () => weekly("11:00", "11:00")],
    ["an impossible exception date", () => exception("2026-02-30")],
    ["a malformed exception date", () => exception("24/12/2026")],
    ["an exception with half its hours", () => exception("2026-12-24", "11:00", null)],
  ])("%s", async (_name, run) => {
    expect(await run()).toMatch(/CHECK/);
  });

  it("accepts closing after midnight", async () => {
    await db.prepare("INSERT INTO weekly_hours (site_id, weekday, opens, closes) VALUES ('bistro', 4, '18:00', '01:00')").run();
  });
});

describe("settings reject", () => {
  const update = (set: string) => rejected(`UPDATE settings SET ${set} WHERE site_id = 'bistro'`);
  it.each([
    ["an unknown booking mode", "booking_mode = 'phone'"],
    ["link mode without a URL", "booking_mode = 'link'"],
    ["an http booking URL", "booking_url = 'http://x.se'"],
    ["embed mode without code", "booking_mode = 'embed', booking_embed_code = ' '"],
    ["oversized embed code", `booking_embed_code = '${"x".repeat(5001)}'`],
    ["a non-https map", "map_embed_url = 'javascript:alert(1)'"],
    ["social links that aren't an object", "social_links = '[]'"],
    ["an email without a domain", "email = 'hej@'"],
  ])("%s", async (_name, set) => {
    expect(await update(set)).toMatch(/CHECK/);
  });
});

describe("page_content rejects", () => {
  const insert = (quoteSv: string | null, quoteEn: string | null) =>
    rejected(
      `INSERT INTO page_content (site_id, home_tagline_sv, home_tagline_en, pull_quote_sv, pull_quote_en,
         about_story_sv, about_story_en, about_chef_sv, about_chef_en)
       VALUES ('bistro', 'T', 'T', ?, ?, 'S', 'S', 'C', 'C')`,
      quoteSv,
      quoteEn,
    );
  it("a pull quote in only one language", async () => {
    expect(await insert("Citat", null)).toMatch(/CHECK/);
  });
  it("a blank pull quote", async () => {
    expect(await insert(" ", " ")).toMatch(/CHECK/);
  });
});

describe("images reject", () => {
  it.each([
    ["a static image without a path", "INSERT INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'static', 'image/jpeg', 'Foto', 'Photo')"],
    ["an upload with a path", "INSERT INTO images (site_id, id, kind, path, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'upload', '/images/bistro/b.jpg', 'image/webp', 'Foto', 'Photo')"],
    ["an SVG", "INSERT INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'upload', 'image/svg+xml', 'Foto', 'Photo')"],
  ])("%s", async (_name, sql) => {
    expect(await rejected(sql, "c".repeat(64))).toMatch(/CHECK/);
  });

  it("an image without alt in both languages (migration 0006's triggers)", async () => {
    const insert = "INSERT INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'upload', 'image/webp', ?, ?)";
    expect(await rejected(insert, "c".repeat(64), null, null)).toMatch(/alt text in Swedish and English/);
    expect(await rejected(insert, "c".repeat(64), "Foto", null)).toMatch(/alt text in Swedish and English/);
    expect(await rejected("UPDATE images SET alt_en = NULL WHERE site_id = 'bistro' AND id = ?", IMG)).toMatch(/alt text in Swedish and English/);
  });

  it("a variant over 1 MiB", async () => {
    await db.prepare("INSERT INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'upload', 'image/webp', 'Foto', 'Photo')").bind("d".repeat(64)).run();
    const tooBig = new Uint8Array(1048577);
    expect(
      await rejected("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('bistro', ?, 640, 'image/webp', ?)", "d".repeat(64), tooBig),
    ).toMatch(/CHECK/);
  });
});

describe("auth tables", () => {
  it("reject a session for a user who isn't a member of that site", async () => {
    await db.prepare("INSERT INTO sites (id) VALUES ('westafrican')").run();
    expect(
      await rejected(
        "INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'westafrican', '2026-10-16T10:00:00Z', '2026-10-16T10:00:00Z', '2026-11-15T10:00:00Z')",
        "e".repeat(64),
        USER,
      ),
    ).toMatch(/FOREIGN KEY/);
  });

  it("reject a plain-text token instead of its hash", async () => {
    expect(
      await rejected(
        "INSERT INTO invites (token_hash, user_id, site_id, created_at, expires_at) VALUES ('secret-token', ?, 'bistro', '2026-10-16T10:00:00Z', '2026-10-19T10:00:00Z')",
        USER,
      ),
    ).toMatch(/CHECK/);
  });

  it("reject an unknown role", async () => {
    expect(await rejected("UPDATE memberships SET role = 'admin'")).toMatch(/CHECK/);
  });

  it("revoke everything when a membership is deleted", async () => {
    await db.batch([
      db.prepare("INSERT INTO passkeys (id, user_id, site_id, public_key) VALUES ('cred1', ?, 'bistro', x'01')").bind(USER),
      db.prepare(
        "INSERT INTO sessions (token_hash, user_id, site_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 'bistro', '2026-10-16T10:00:00Z', '2026-10-16T10:00:00Z', '2026-11-15T10:00:00Z')",
      ).bind("f".repeat(64), USER),
    ]);
    await db.prepare("DELETE FROM memberships WHERE user_id = ?").bind(USER).run();
    expect(await db.prepare("SELECT (SELECT count(*) FROM passkeys) + (SELECT count(*) FROM sessions) AS n").first("n")).toBe(0);
  });
});

describe("sites", () => {
  it("cascade: deleting a site removes all its content", async () => {
    await db.prepare("DELETE FROM sites WHERE id = 'bistro'").run();
    const { results } = await db
      .prepare("SELECT (SELECT count(*) FROM menu_items) + (SELECT count(*) FROM images) + (SELECT count(*) FROM settings) + (SELECT count(*) FROM memberships) AS n")
      .all();
    expect(results[0]).toEqual({ n: 0 });
  });

  it("reject an id that could escape a folder", async () => {
    expect(await rejected("INSERT INTO sites (id) VALUES ('../x')")).toMatch(/CHECK/);
  });
});

describe("content_version", () => {
  const version = () => db.prepare("SELECT content_version FROM sites WHERE id = 'bistro'").first<number>("content_version");

  it.each<[string, string]>([
    ["a settings change", "UPDATE settings SET tagline_en = 'New' WHERE site_id = 'bistro'"],
    ["a price change", `UPDATE menu_items SET price_ore = 15500 WHERE id = '${ITEM}'`],
    ["a new category", "INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES ('bistro', 'cat000000002', 'drinks', 'Drycker', 'Drinks', 1)"],
    ["opening hours", "INSERT INTO weekly_hours (site_id, weekday, opens, closes) VALUES ('bistro', 2, '11:00', '22:00')"],
    ["a holiday", "INSERT INTO hours_exceptions (site_id, date, note_sv, note_en) VALUES ('bistro', '2026-12-24', 'Julafton', 'Christmas Eve')"],
    ["a deleted dish", `DELETE FROM menu_items WHERE id = '${ITEM}'`],
    ["a new image", `INSERT INTO images (site_id, id, kind, path, mime, alt_sv, alt_en) VALUES ('bistro', '${"9".repeat(64)}', 'static', '/images/bistro/b.jpg', 'image/jpeg', 'Foto', 'Photo')`],
  ])("moves on with %s, by a trigger, whoever writes it", async (_name, sql) => {
    const before = await version();
    await db.prepare(sql).run();
    expect(await version()).toBeGreaterThan(before!);
  });

  it("stays put when a statement changes nothing", async () => {
    const before = await version();
    await db.prepare("UPDATE menu_items SET price_ore = 1 WHERE id = 'nonexistent0'").run();
    expect(await version()).toBe(before);
  });

  it("moves only the changed site's version", async () => {
    await db.prepare("INSERT INTO sites (id) VALUES ('westafrican')").run();
    const other = await db.prepare("SELECT content_version FROM sites WHERE id = 'westafrican'").first<number>("content_version");
    await db.prepare(`UPDATE menu_items SET price_ore = 15500 WHERE id = '${ITEM}'`).run();
    expect(await db.prepare("SELECT content_version FROM sites WHERE id = 'westafrican'").first<number>("content_version")).toBe(other);
  });
});
