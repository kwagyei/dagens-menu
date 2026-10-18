/**
 * scripts/check-migrations.mjs marks an added migration that drops or renames
 * something as a contract migration (reviewer M1). Each case builds a throwaway git repo with
 * a base commit, adds one migration file, and runs the real script against the base.
 *
 * SQLite accepts `ALTER TABLE t DROP c` and `ALTER TABLE t RENAME a TO b` without the COLUMN
 * keyword (https://sqlite.org/lang_altertable.html), so both must count as destructive.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/check-migrations.mjs");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=tester@example.invalid", "-c", "user.name=tester", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf-8" });

/** Base commit with one shipped migration, then `sql` added as 0002; returns the script's verdict. */
function check(sql: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "check-migrations-"));
  dirs.push(dir);
  mkdirSync(join(dir, "migrations"));
  writeFileSync(join(dir, "migrations", "0001_base.sql"), "CREATE TABLE t (a TEXT, b TEXT);\n");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "migrations", "0002_next.sql"), sql);
  // CI checks committed files; an untracked file is invisible to `git diff <base>`.
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "next");
  try {
    const out = execFileSync("node", [script, base], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const x = e as { status: number; stderr: string };
    return { code: x.status, out: x.stderr };
  }
}

describe("check-migrations: destructive statements need a -- CONTRACT first line", () => {
  it("accepts an expand-only migration", () => {
    expect(check("ALTER TABLE t ADD COLUMN c TEXT;\nCREATE INDEX t_a ON t (a);\n").code).toBe(0);
  });

  it.each([
    ["DROP TABLE", "DROP TABLE t;\n"],
    ["DROP TABLE IF EXISTS", "DROP TABLE IF EXISTS t;\n"],
    ["DROP COLUMN", "ALTER TABLE t DROP COLUMN b;\n"],
    ["RENAME TO", "ALTER TABLE t RENAME TO u;\n"],
    ["RENAME COLUMN", "ALTER TABLE t RENAME COLUMN b TO c;\n"],
    ["lower case", "alter table t drop column b;\n"],
    ["statement split over lines", "ALTER TABLE t\n  DROP\n  COLUMN b;\n"],
  ])("refuses an unmarked %s", (_name, sql) => {
    const r = check(sql);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/-- CONTRACT/);
  });

  it.each([
    ["DROP without the optional COLUMN keyword", "ALTER TABLE t DROP b;\n"],
    ["RENAME without the optional COLUMN keyword", "ALTER TABLE t RENAME b TO c;\n"],
  ])("refuses an unmarked %s (SQLite accepts it)", (_name, sql) => {
    expect(check(sql).code).toBe(1);
  });

  it("accepts the same drop when the first line is -- CONTRACT", () => {
    expect(check("-- CONTRACT: old code writes b.\nALTER TABLE t DROP COLUMN b;\n").code).toBe(0);
  });

  it("refuses when -- CONTRACT is not on the first line", () => {
    expect(check("-- Removes b.\n-- CONTRACT\nALTER TABLE t DROP COLUMN b;\n").code).toBe(1);
  });

  it("ignores DROP TABLE that appears only in a line comment", () => {
    expect(check("-- A later migration may DROP TABLE t.\nALTER TABLE t ADD COLUMN c TEXT;\n").code).toBe(0);
  });

  it("refuses an unmarked DROP VIEW", () => {
    expect(check("CREATE VIEW v AS SELECT a FROM t;\nDROP VIEW v;\n").code).toBe(1);
  });

  it("ignores DROP TABLE inside a block comment", () => {
    expect(check("/* An old draft did DROP TABLE t here. */\nALTER TABLE t ADD COLUMN c TEXT;\n").code).toBe(0);
  });

  it("does not take -- CONTRACTOR as the marker", () => {
    expect(check("-- CONTRACTOR notes\nDROP TABLE t;\n").code).toBe(1);
  });

  it("does not count DROP INDEX or DROP TRIGGER as contract: no code reads an index or trigger by name", () => {
    expect(check("CREATE INDEX t_a ON t (a);\nDROP INDEX t_a;\n").code).toBe(0);
    expect(check("CREATE TRIGGER t_x AFTER INSERT ON t BEGIN SELECT 1; END;\nDROP TRIGGER t_x;\n").code).toBe(0);
  });

  it("refuses an edited shipped migration whatever its content", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-migrations-"));
    dirs.push(dir);
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "migrations", "0001_base.sql"), "CREATE TABLE t (a TEXT);\n");
    git(dir, "init", "-q");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "migrations", "0001_base.sql"), "-- CONTRACT\nCREATE TABLE t (a TEXT, b TEXT);\n");
    expect(() => execFileSync("node", [script, base], { cwd: dir, stdio: "pipe" })).toThrow();
  });
});

describe("check-migrations on this branch", () => {
  it("accepts 0006 as a marked contract migration", () => {
    const root = resolve(import.meta.dirname, "..");
    // The commit before 0006 was added; read-only git diff in the checkout.
    const base = execFileSync("git", ["log", "--format=%H", "-n", "1", "--diff-filter=A", "--", "migrations/0006_image_library_contract.sql"], { cwd: root, encoding: "utf-8" }).trim();
    expect(base).not.toBe("");
    const out = execFileSync("node", [script, `${base}^`], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toMatch(/0006_image_library_contract\.sql/);
  });
});
