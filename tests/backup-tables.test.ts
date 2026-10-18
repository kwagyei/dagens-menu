/**
 * The weekly export's table list (scripts/backup-tables.ts) against the schema in migrations/:
 * every table is either exported or excluded with a reason, photo bytes and personal data are
 * never exported, and the export order loads with foreign keys on.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_TABLES, countRows, EXCLUDED_TABLES, exportTables } from "../scripts/backup-tables";

const schema = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(`migrations/${f}`, "utf8"))
  .join("\n");

/**
 * Each table the migrations leave, with the tables it references. Read in order, so a rebuild
 * (create the new table, drop the old, rename the new, as 0006 does) ends as the one table.
 */
const tables = new Map<string, Set<string>>();
const statements = /CREATE TABLE (\w+) \(([\s\S]*?)\n\)|ALTER TABLE (\w+) ADD COLUMN [^;]*REFERENCES (\w+)|DROP TABLE (\w+)|ALTER TABLE (\w+) RENAME TO (\w+)/g;
for (const [, created, body, altered, referenced, dropped, from, to] of schema.matchAll(statements)) {
  if (created) tables.set(created, new Set([...body.matchAll(/REFERENCES (\w+)/g)].map((m) => m[1])));
  else if (altered) tables.get(altered)?.add(referenced);
  else if (dropped) tables.delete(dropped);
  else if (from) {
    tables.set(to, tables.get(from)!);
    tables.delete(from);
  }
}

describe("backup table list", () => {
  it("reads the schema", () => {
    expect(tables.size).toBeGreaterThan(15);
    expect(tables.get("menu_items")).toEqual(new Set(["menu_categories", "images"]));
  });

  it("classifies every table in migrations/ exactly once", () => {
    const listed = [...CONTENT_TABLES, ...Object.keys(EXCLUDED_TABLES)];
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...tables.keys()].sort());
  });

  it("never exports photo bytes, history or auth", () => {
    for (const table of ["image_variants", "audit_log", "users", "memberships", "passkeys", "sessions", "invites", "rate_limits"]) {
      expect(CONTENT_TABLES as readonly string[]).not.toContain(table);
      expect(EXCLUDED_TABLES[table]).toBeTruthy();
    }
  });

  it("lists each exported table after every exported table it references", () => {
    CONTENT_TABLES.forEach((table, i) => {
      for (const parent of tables.get(table) ?? []) {
        if (parent === table) continue;
        expect(CONTENT_TABLES as readonly string[], `${table} references ${parent}`).toContain(parent);
        expect(CONTENT_TABLES.indexOf(parent as (typeof CONTENT_TABLES)[number]), `${parent} before ${table}`).toBeLessThan(i);
      }
    });
  });
});

describe("countRows", () => {
  it("counts one INSERT per row, and only line starts", () => {
    const sql = [
      "PRAGMA defer_foreign_keys=TRUE;",
      `INSERT INTO "menu_items" ("id","name_sv") VALUES('a','Sill');`,
      `INSERT INTO "menu_items" ("id","name_sv") VALUES('b','two lines`,
      `INSERT INTO "menu_items" is text here');`,
    ].join("\n");
    // The third line is the inside of a string, but it starts like a row: the count is an
    // upper bound that verify then checks against the database.
    expect(countRows(sql, "menu_items")).toBe(3);
    expect(countRows("PRAGMA defer_foreign_keys=TRUE;\n", "hours_exceptions")).toBe(0);
    expect(countRows("", "sites")).toBe(0);
  });

  it("refuses a file that holds another table's rows", () => {
    expect(() => countRows(`INSERT INTO "users" VALUES('x');`, "sites")).toThrow(/another table/);
  });
});

describe("the weekly export (exportTables)", () => {
  it("never asks for, writes or keeps image_variants, even with a stale file left in the folder", () => {
    const out = mkdtempSync(join(tmpdir(), "backup-export-"));
    // A folder reused from an older backup that (wrongly) held photo bytes.
    writeFileSync(join(out, "image_variants.sql"), `INSERT INTO "image_variants" ("site_id") VALUES('bistro');\n`);
    const asked: string[] = [];
    const manifest = exportTables(out, {
      migrations: () => ["0001_content.sql"],
      exportTable: (table, file) => {
        asked.push(table);
        writeFileSync(file, `PRAGMA defer_foreign_keys=TRUE;\nINSERT INTO "${table}" ("site_id") VALUES('bistro');\n`);
      },
    });
    expect(asked).toEqual([...CONTENT_TABLES]);
    expect(asked).not.toContain("image_variants");
    expect(existsSync(join(out, "image_variants.sql"))).toBe(false);
    for (const name of readdirSync(out).filter((n) => n.endsWith(".sql"))) expect(readFileSync(join(out, name), "utf-8")).not.toContain("image_variants");
    expect(Object.keys(manifest.tables)).toEqual([...CONTENT_TABLES]);
    expect(manifest.excluded).toContain("image_variants");
    expect(JSON.parse(readFileSync(join(out, "manifest.json"), "utf-8")).excluded).toContain("image_variants");
  });

  it("counts an empty table that wrangler wrote no file for as 0 rows", () => {
    const out = mkdtempSync(join(tmpdir(), "backup-export-"));
    const manifest = exportTables(out, { migrations: () => [], exportTable: () => {} });
    expect(Object.values(manifest.tables).every((n) => n === 0)).toBe(true);
  });
});
