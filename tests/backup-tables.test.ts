/**
 * The weekly export's table list (scripts/backup-tables.ts) against the schema in migrations/:
 * every table is either exported or excluded with a reason, photo bytes and personal data are
 * never exported, and the export order loads with foreign keys on.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTENT_TABLES, countRows, EXCLUDED_TABLES } from "../scripts/backup-tables";

const schema = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(`migrations/${f}`, "utf8"))
  .join("\n");

/** Each table the migrations create, with the tables it references. */
const tables = new Map<string, Set<string>>();
for (const match of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\)/g)) {
  tables.set(match[1], new Set([...match[2].matchAll(/REFERENCES (\w+)/g)].map((m) => m[1])));
}
for (const match of schema.matchAll(/ALTER TABLE (\w+) ADD COLUMN [^;]*REFERENCES (\w+)/g)) {
  tables.get(match[1])?.add(match[2]);
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
