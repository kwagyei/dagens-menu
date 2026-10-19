/**
 * Tester, M5.5: attacks on the texts and settings writes at the repository and form-parser
 * level (workerd + D1): hostile links, smuggled fields, values the schema accepts but a D1
 * CHECK refuses, length limits, the pull quote rule, row_version races, site isolation.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import hours from "../../sites/bistro/content/hours.json";
import menu from "../../sites/bistro/content/menu.json";
import pages from "../../sites/bistro/content/pages.json";
import settings from "../../sites/bistro/content/settings.json";
import { parsePageTextsForm, parseSettingsForm } from "../../src/admin/forms";
import { pagesSchema, settingsSchema } from "../../src/content/schema";
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
const auditCount = async () => (await db.prepare("SELECT count(*) AS n FROM audit_log").first<{ n: number }>())!.n;
const bookingRow = () => db.prepare("SELECT booking_mode, booking_url, booking_embed_code, map_embed_url FROM settings WHERE site_id = 'bistro'").first();

async function current() {
  const texts = await adminTexts(bistro);
  if (!texts) throw new Error("no texts");
  const { rowVersion: sv, ...s } = texts.settings;
  const { rowVersion: pv, ...p } = texts.pages;
  return { settings: s as OwnerSettings, settingsVersion: sv, pages: p as PageTexts, pagesVersion: pv };
}
const asResult = (r: unknown) => r as { ok: boolean; error?: string; issues?: Array<{ path: string; message: string }> };

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

describe("social links", () => {
  const hostile = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "http://facebook.com/x",
    "//facebook.com/x",
    "ftp://x.se",
    "https:/x.se",
    "https:///x.se",
    "https://",
    "https://x.se/a b",
    "https://x .se",
    " https://x.se",
    "https://x.se\n",
    "https://x.se/\n<script>",
    'https://x.se/"onmouseover="alert(1)',
    "https://x.se/'><script>",
    "https://x.se/<b>",
    "https://x.se\t/a",
    "mailto:a@b.se",
    "",
  ];
  it.each(hostile)("refuses %j and writes nothing", async (url) => {
    const { settings: s, settingsVersion } = await current();
    const v0 = await version();
    const result = asResult(await updateSettings(bistro, settingsVersion, { ...s, socialLinks: { ...s.socialLinks, instagram: url } }));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid");
    expect(await version()).toBe(v0);
    expect((await current()).settings.socialLinks).toEqual(s.socialLinks);
  });

  const odd = [
    "https://biströ.se/meny", // IDN
    "https://xn--bistr-7qa.se/",
    "https://x.se/path?q=1&r=2#frag",
    "https://x.se?x=1", // host swallows "?x=1"; still https
    "https://user:pw@x.se/", // credentials in the URL
  ];
  it.each(odd)("handles %j without a 500 (accepted or invalid, never thrown)", async (url) => {
    const { settings: s, settingsVersion } = await current();
    await expect(updateSettings(bistro, settingsVersion, { ...s, socialLinks: { instagram: url } })).resolves.toBeDefined();
  });

  it("refuses a link with a bidi override or zero-width character in it (the host is never displayed, but the href is)", async () => {
    const { settings: s, settingsVersion } = await current();
    const result = asResult(await updateSettings(bistro, settingsVersion, { ...s, socialLinks: { instagram: "https://x.se/‮abc" } }));
    expect(result.ok).toBe(false);
  });

  it("refuses a very long link rather than storing megabytes (or at least does not throw)", async () => {
    const { settings: s, settingsVersion } = await current();
    const long = `https://x.se/${"a".repeat(200_000)}`;
    const result = await updateSettings(bistro, settingsVersion, { ...s, socialLinks: { instagram: long } }).catch((e) => ({ thrown: String(e) }));
    expect(result, "a 200 kB URL should be answered 'invalid', not stored or thrown").toMatchObject({ ok: false, error: "invalid" });
  });

  it("rejects the key __proto__ and a capitalised or non-letter network", async () => {
    const { settings: s, settingsVersion } = await current();
    const proto = JSON.parse('{"__proto__": "https://x.se/"}');
    expect(asResult(await updateSettings(bistro, settingsVersion, { ...s, socialLinks: proto })).ok).toBe(false);
    for (const key of ["Instagram", "insta-gram", "insta1", "", "a b", "constructor "]) {
      expect(asResult(await updateSettings(bistro, settingsVersion, { ...s, socialLinks: { [key]: "https://x.se/" } })).ok, key).toBe(false);
    }
  });

  it("accepts a lowercase network name the footer has no label for (shown as written)", async () => {
    const { settings: s, settingsVersion } = await current();
    expect(await updateSettings(bistro, settingsVersion, { ...s, socialLinks: { youtube: "https://youtube.com/@x" } })).toEqual({ ok: true });
  });
});

describe("smuggled fields", () => {
  it.each([
    ["booking", { provider: "embed", embedCode: "<script src=https://evil.example></script>" }],
    ["mapEmbed", "https://evil.example/embed"],
    ["bookingUrl", "https://evil.example/"],
    ["embedCode", "<iframe>"],
    ["__proto__", { polluted: true }],
    ["site_id", "westafrican"],
    ["rowVersion", 99],
    ["updatedBy", "x"],
  ])("updateSettings refuses an extra %s and leaves booking and map untouched", async (key, value) => {
    const { settings: s, settingsVersion } = await current();
    const before = await bookingRow();
    const v0 = await version();
    const edit = Object.assign(Object.create(null), s, { [key]: value });
    const result = asResult(await updateSettings(bistro, settingsVersion, edit as OwnerSettings));
    expect(result.ok, `extra key ${key}`).toBe(false);
    expect(await bookingRow()).toEqual(before);
    expect(await version()).toBe(v0);
  });

  it("updatePageTexts refuses an extra key, including images", async () => {
    const { pages: p, pagesVersion } = await current();
    for (const extra of [{ heroImageId: "x" }, { highlights: [] }, { __proto__x: 1 }]) {
      expect(asResult(await updatePageTexts(bistro, pagesVersion, { ...p, ...extra } as PageTexts)).ok).toBe(false);
    }
  });

  it("the settings form parser ignores booking, map, embed, extra networks and __proto__ in a raw POST, and keeps stored operator links", () => {
    const form = new FormData();
    const base: Record<string, string> = {
      name_sv: "Namn",
      name_en: "Name",
      tagline_sv: "T",
      tagline_en: "T",
      cuisine_sv: "C",
      cuisine_en: "C",
      address: "Gatan 1",
      phone: "08-123 456 78",
      email: "a@b.se",
      social_instagram: "https://instagram.com/x",
      booking_provider: "embed",
      booking_embed_code: "<script>",
      map_embed: "https://evil.example/",
      embed: "<iframe>",
      social_youtube: "https://evil.example/",
      social___proto__: "https://evil.example/",
      __proto__: "x",
    };
    for (const [k, v] of Object.entries(base)) form.set(k, v);
    form.set("__proto__", "x");
    const parsed = parseSettingsForm(form, "en", { youtube: "https://youtube.com/@kept", facebook: "https://facebook.com/old" });
    expect(parsed.errors).toEqual({});
    expect(Object.keys(parsed.settings!.socialLinks).sort()).toEqual(["instagram", "youtube"]);
    expect(parsed.settings!.socialLinks.youtube).toBe("https://youtube.com/@kept");
    expect(Object.keys(parsed.settings!)).toEqual(["name", "tagline", "cuisine", "address", "phone", "email", "socialLinks"]);
  });
});

describe("phone and email: what the schema accepts, D1 must accept too", () => {
  // The form trims the ends only, so interior odd whitespace reaches the schema.
  const phones = [
    "+46 8 123 456",
    "08-123 456 78",
    "0701234567",
    "070 1234567",
    "070\t1234567",
    "070\n1234567",
    "070　1234567",
    "070 1234567",
    "070﻿1234567",
    "070 1234567",
    "070 1234567 ",
    "+ 0701234567",
    "--------1234567",
    "+46--8 123 456",
  ];
  it.each(phones)("phone %j: if the schema takes it, the database must store it (no throw)", async (phone) => {
    const { settings: s, settingsVersion } = await current();
    const accepted = settingsSchema.shape.phone.safeParse(phone).success;
    const outcome = await updateSettings(bistro, settingsVersion, { ...s, phone }).catch((e) => ({ thrown: String(e).slice(0, 120) }));
    if (accepted) expect(outcome, "schema accepted it but the CHECK refused: a 500 in the admin").toEqual({ ok: true });
    else expect(outcome).toMatchObject({ ok: false, error: "invalid" });
  });

  const emails = [
    "a@b.se",
    "a+tag@b.se",
    "a@b.c",
    "a@b..c",
    "a@.b.c",
    "a.@b.c",
    "a@b.c.",
    "‮a@b.se",
    "a@b​.se",
    "a​@b.se",
    "a<b>@c.se",
    'a"b@c.se',
    "a'b@c.se",
    "a@b.se ",
    "ä@b.se",
    "a@b.se%0d",
    "a@b/c.se",
  ];
  it.each(emails)("email %j: if the schema takes it, the database must store it (no throw)", async (email) => {
    const { settings: s, settingsVersion } = await current();
    const accepted = settingsSchema.shape.email.safeParse(email).success;
    const outcome = await updateSettings(bistro, settingsVersion, { ...s, email }).catch((e) => ({ thrown: String(e).slice(0, 120) }));
    if (accepted) expect(outcome).toEqual({ ok: true });
    else expect(outcome).toMatchObject({ ok: false, error: "invalid" });
  });

  it("email with a bidi override or zero-width character is refused, as names and prices are (it is shown in the footer)", async () => {
    const { settings: s, settingsVersion } = await current();
    for (const email of ["‮a@b.se", "a@b​.se", "a⁦@b.se"]) {
      expect(asResult(await updateSettings(bistro, settingsVersion, { ...s, email })).ok, JSON.stringify(email)).toBe(false);
    }
  });

  it("refuses an absurdly long phone number and email (the form's maxlength is only a hint)", async () => {
    const { settings: s, settingsVersion } = await current();
    expect(asResult(await updateSettings(bistro, settingsVersion, { ...s, phone: "1".repeat(10_000) })).ok).toBe(false);
    expect(asResult(await updateSettings(bistro, settingsVersion, { ...s, email: `${"a".repeat(10_000)}@b.se` })).ok).toBe(false);
  });

  it("the form parser gives the same verdict as the schema for interior whitespace in a phone number", () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({
      name_sv: "N",
      name_en: "N",
      tagline_sv: "T",
      tagline_en: "T",
      cuisine_sv: "C",
      cuisine_en: "C",
      address: "A 1",
      phone: "070 1234567",
      email: "a@b.se",
    }))
      form.set(k, v);
    const parsed = parseSettingsForm(form, "en");
    // Either a friendly field error, or a settings object the repository can store. Never the latter followed by a throw.
    expect(parsed.settings === null || Object.keys(parsed.errors).length === 0).toBe(true);
  });
});

describe("text limits count what a reader sees", () => {
  const nameWith = (name: string): OwnerSettings extends infer S ? S : never => name as never;
  it("accepts 80 emoji and 80 family-emoji sequences as names, refuses 81", async () => {
    const { settings: s, settingsVersion } = await current();
    const family = "👨‍👩‍👧‍👦";
    expect(await updateSettings(bistro, settingsVersion, { ...s, name: { sv: "😀".repeat(80), en: family.repeat(80) } })).toEqual({ ok: true });
    const again = await current();
    expect(asResult(await updateSettings(bistro, again.settingsVersion, { ...s, name: { sv: "😀".repeat(81), en: "x" } })).ok).toBe(false);
    void nameWith;
  });

  it("decomposed å counts as one character after NFC", async () => {
    const { settings: s, settingsVersion } = await current();
    expect(await updateSettings(bistro, settingsVersion, { ...s, name: { sv: "å".repeat(80), en: "x" } })).toEqual({ ok: true });
    expect((await current()).settings.name.sv).toBe("å".repeat(80));
  });

  it("strips bidi and zero-width characters from every text field and keeps a ZWJ emoji intact", async () => {
    const { settings: s, settingsVersion } = await current();
    const dirty = "‮Ab​c⁦d­e\u0007f";
    expect(
      await updateSettings(bistro, settingsVersion, {
        ...s,
        name: { sv: dirty, en: dirty },
        tagline: { sv: dirty, en: dirty },
        cuisine: { sv: dirty, en: dirty },
        address: dirty,
      }),
    ).toEqual({ ok: true });
    const stored = (await current()).settings;
    for (const v of [stored.name.sv, stored.name.en, stored.tagline.sv, stored.tagline.en, stored.cuisine.sv, stored.cuisine.en, stored.address]) expect(v).toBe("Abcdef");
  });

  it("refuses a name made only of invisible characters, and markup is stored as typed (escaped on output)", async () => {
    const { settings: s, settingsVersion } = await current();
    expect(asResult(await updateSettings(bistro, settingsVersion, { ...s, name: { sv: "​‮", en: "x" } })).ok).toBe(false);
    expect(await updateSettings(bistro, settingsVersion, { ...s, name: { sv: "<b>Bistro</b> </script>", en: "x" } })).toEqual({ ok: true });
  });

  it("single-line fields reject or flatten a newline (a raw POST can send one into <title> and the header)", async () => {
    const { settings: s, settingsVersion } = await current();
    const result = asResult(await updateSettings(bistro, settingsVersion, { ...s, name: { sv: "Bistro\nNorden", en: "x" } }));
    if (result.ok) expect((await current()).settings.name.sv).not.toContain("\n");
    else expect(result.ok).toBe(false);
  });

  it("long texts: 3000 characters pass, 3001 fail, in both languages, for the about story and chef", async () => {
    const { pages: p, pagesVersion } = await current();
    const ok = { ...p, aboutStory: { sv: "å".repeat(3000), en: "😀".repeat(3000) } };
    expect(await updatePageTexts(bistro, pagesVersion, ok)).toEqual({ ok: true });
    const next = (await current()).pagesVersion;
    expect(asResult(await updatePageTexts(bistro, next, { ...p, aboutChef: { sv: "x".repeat(3001), en: "x" } })).ok).toBe(false);
  });
});

describe("pull quote", () => {
  it("can be removed: both columns become NULL, the export validates, the audit says so", async () => {
    const { pages: p, pagesVersion } = await current();
    expect(await updatePageTexts(bistro, pagesVersion, { ...p, pullQuote: null })).toEqual({ ok: true });
    const row = await db.prepare("SELECT pull_quote_sv, pull_quote_en FROM page_content WHERE site_id = 'bistro'").first();
    expect(row).toEqual({ pull_quote_sv: null, pull_quote_en: null });
    const exported = await exportSite(db, "bistro");
    expect(pagesSchema("bistro").safeParse(exported?.content.pages).success).toBe(true);
    expect(exported?.content.pages.home.pullQuote).toBeUndefined();
    const audit = await db.prepare("SELECT summary FROM audit_log ORDER BY id DESC LIMIT 1").first<string>("summary");
    expect(audit).toContain("pullQuote");
  });

  it.each([[{ sv: "Bara svenska", en: "" }], [{ sv: "", en: "Only English" }], [{ sv: "Text", en: "   " }], [{ sv: "Text", en: "​‮" }]])(
    "refuses %j (one language only)",
    async (pullQuote) => {
      const { pages: p, pagesVersion } = await current();
      expect(asResult(await updatePageTexts(bistro, pagesVersion, { ...p, pullQuote })).ok).toBe(false);
    },
  );

  it("form: both blank (spaces, ZWSP, newlines) removes it; one language gives an error on the empty one only", () => {
    const f = (o: Record<string, string>) => {
      const form = new FormData();
      for (const [k, v] of Object.entries({
        home_tagline_sv: "H",
        home_tagline_en: "H",
        pull_quote_sv: "",
        pull_quote_en: "",
        about_story_sv: "S",
        about_story_en: "S",
        about_chef_sv: "C",
        about_chef_en: "C",
        ...o,
      }))
        form.set(k, v);
      return parsePageTextsForm(form, "en");
    };
    expect(f({ pull_quote_sv: " ​\n", pull_quote_en: "\t" }).texts?.pullQuote).toBeNull();
    const one = f({ pull_quote_sv: "Bra" });
    expect(Object.keys(one.errors)).toEqual(["pull_quote_en"]);
    expect(one.texts).toBeNull();
    expect(f({ pull_quote_sv: "x".repeat(301), pull_quote_en: "y" }).errors.pull_quote_sv).toBeTruthy();
  });

  it("a quote of exactly 300 emoji is accepted, 301 refused", async () => {
    const { pages: p, pagesVersion } = await current();
    expect(await updatePageTexts(bistro, pagesVersion, { ...p, pullQuote: { sv: "😀".repeat(300), en: "x" } })).toEqual({ ok: true });
    const v = (await current()).pagesVersion;
    expect(asResult(await updatePageTexts(bistro, v, { ...p, pullQuote: { sv: "😀".repeat(301), en: "x" } })).ok).toBe(false);
  });
});

describe("row_version", () => {
  it("a stale settings save is a conflict and loses nothing; a stale pages save does not touch settings", async () => {
    const c = await current();
    expect(await updateSettings(bistro, c.settingsVersion, { ...c.settings, phone: "08-111 111 11" })).toEqual({ ok: true });
    const stale = asResult(await updateSettings(bistro, c.settingsVersion, { ...c.settings, phone: "08-222 222 22" }));
    expect(stale).toMatchObject({ ok: false, error: "conflict" });
    expect((await current()).settings.phone).toBe("08-111 111 11");
    // The pages form still carries its own, untouched version and saves fine.
    expect(await updatePageTexts(bistro, c.pagesVersion, { ...c.pages, homeTagline: { sv: "Ny", en: "New" } })).toEqual({ ok: true });
    // Now the pages version is stale; settings save with the fresh settings version works.
    expect(asResult(await updatePageTexts(bistro, c.pagesVersion, c.pages))).toMatchObject({ ok: false, error: "conflict" });
    const fresh = await current();
    expect(await updateSettings(bistro, fresh.settingsVersion, { ...fresh.settings, phone: "08-333 333 33" })).toEqual({ ok: true });
    expect((await current()).pages.homeTagline.sv).toBe("Ny");
  });

  it("two saves with the same version at once: exactly one wins, one audit row", async () => {
    const c = await current();
    const a0 = await auditCount();
    const results = await Promise.all([
      updateSettings(bistro, c.settingsVersion, { ...c.settings, phone: "08-111 111 11" }),
      updateSettings(bistro, c.settingsVersion, { ...c.settings, phone: "08-222 222 22" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "conflict")).toHaveLength(1);
    expect(await auditCount()).toBe(a0 + 1);
  });

  it("a negative, huge or unsafe expected version is a conflict, not a throw", async () => {
    const c = await current();
    for (const v of [-1, 2 ** 31, Number.MAX_SAFE_INTEGER, 1.5, Number.NaN]) {
      const r = await updateSettings(bistro, v, c.settings).catch((e) => ({ thrown: String(e) }));
      expect(r, `version ${v}`).toMatchObject({ ok: false, error: "conflict" });
    }
  });

  it("an invalid edit does not bump the version or write an audit row; a no-op save still counts as a save", async () => {
    const c = await current();
    const v0 = await version();
    const a0 = await auditCount();
    await updateSettings(bistro, c.settingsVersion, { ...c.settings, email: "nope" });
    expect(await version()).toBe(v0);
    expect(await auditCount()).toBe(a0);
    expect(await updateSettings(bistro, c.settingsVersion, c.settings)).toEqual({ ok: true });
    expect(await auditCount()).toBe(a0 + 1);
  });
});

describe("site isolation", () => {
  it("a site without settings rows answers not-found, writes nothing, and cannot touch bistro", async () => {
    const west = ctx("westafrican");
    expect(await adminTexts(west)).toBeNull();
    const c = await current();
    const v0 = await version();
    expect(asResult(await updateSettings(west, c.settingsVersion, { ...c.settings, phone: "08-999 999 99" }))).toMatchObject({ ok: false, error: "not-found" });
    expect(asResult(await updatePageTexts(west, c.pagesVersion, c.pages))).toMatchObject({ ok: false, error: "not-found" });
    expect((await current()).settings.phone).toBe(c.settings.phone);
    expect(await version()).toBe(v0);
  });

  it("with both sites seeded, an edit on one is invisible on the other and audited under its own site", async () => {
    const west = { ...content, settings: { ...content.settings, name: { sv: "Chez", en: "Chez" } } } as unknown as StoredContent;
    await db.prepare("DELETE FROM sites WHERE id = 'westafrican'").run();
    await db.batch(
      prepare(
        db,
        seedStatements("westafrican", west, () => ({ id: "1".repeat(64), mime: "image/jpeg" })),
      ),
    );
    const c = await current();
    await updateSettings(bistro, c.settingsVersion, { ...c.settings, name: { sv: "Ändrad", en: "Changed" } });
    const w = await adminTexts(ctx("westafrican"));
    expect(w?.settings.name).toEqual({ sv: "Chez", en: "Chez" });
    expect(w?.settings.rowVersion).toBe(0);
    const rows = await db.prepare("SELECT DISTINCT site_id FROM audit_log WHERE entity = 'settings'").all<{ site_id: string }>();
    expect(rows.results.map((r) => r.site_id)).toEqual(["bistro"]);
  });
});
