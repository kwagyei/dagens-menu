/**
 * Tester M7.5: edge cases for the content export's row counting and the fast failure paths of
 * `backup verify` (the ones that fail before wrangler starts). The slow paths (tampered count,
 * deleted row, truncated file, FK orphan) were run by hand, see the tester report.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTENT_TABLES, countRows, EXCLUDED_TABLES } from "../scripts/backup-tables";

describe("countRows edge cases", () => {
  it("counts a file that holds only the PRAGMA line as an empty table", () => {
    expect(countRows("PRAGMA defer_foreign_keys=TRUE;\n", "hours_exceptions")).toBe(0);
    expect(countRows("", "hours_exceptions")).toBe(0);
  });

  it("does not count INSERT text that wrangler keeps inside an escaped string", () => {
    // wrangler writes newlines inside values as '\n' escapes wrapped in replace(..., char(10)).
    const sql = [
      "PRAGMA defer_foreign_keys=TRUE;",
      `INSERT INTO "page_content" ("a") VALUES(replace('x\\nINSERT INTO "page_content" ("a") VALUES(''y'');\\nINSERT INTO "menu_items" z','\\n',char(10)));`,
    ].join("\n");
    expect(countRows(sql, "page_content")).toBe(1);
  });

  it("rejects a file for another table", () => {
    expect(() => countRows('INSERT INTO "menu_items" ("a") VALUES(1);\n', "sites")).toThrow(/another table/);
  });

  it("is blind to a raw newline followed by INSERT INTO inside a string (documents the assumption)", () => {
    const sql = `INSERT INTO "sites" ("a") VALUES('x\nINSERT INTO "sites" ("a") VALUES(1);');\n`;
    expect(countRows(sql, "sites")).toBe(2);
  });

  it("matches a table whose name is a prefix of another only by the quoted name", () => {
    expect(() => countRows('INSERT INTO "images" ("a") VALUES(1);\n', "image")).toThrow(/another table/);
  });
});

describe("exclusions", () => {
  it("never overlaps with the exported tables", () => {
    for (const t of Object.keys(EXCLUDED_TABLES)) expect(CONTENT_TABLES as readonly string[]).not.toContain(t);
  });
});

describe("backup verify fails loudly before wrangler runs", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const run = (dir: string) => {
    try {
      execFileSync("npx", ["tsx", "scripts/backup.ts", "verify", "--dir", dir], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, err: "" };
    } catch (e) {
      const x = e as { status: number; stderr: string };
      return { code: x.status, err: x.stderr };
    }
  };
  const make = (manifest: unknown) => {
    const d = mkdtempSync(join(tmpdir(), "tester-backup-"));
    dirs.push(d);
    if (manifest !== undefined) writeFileSync(join(d, "manifest.json"), JSON.stringify(manifest));
    return d;
  };

  it("fails when manifest.json is missing", () => {
    const r = run(make(undefined));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/manifest.json not found/);
  });

  it("fails when the manifest names a migration this checkout doesn't have", () => {
    const r = run(make({ formatVersion: 1, migrations: ["0001_content.sql", "0099_future.sql"], tables: {}, excluded: [] }));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/unknown migrations: 0099_future.sql/);
  });
}, 60_000);
