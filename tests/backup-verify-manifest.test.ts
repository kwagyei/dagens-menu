/**
 * `backup verify` (review M3) loads a backup into the schema it was taken under,
 * so the manifest's migrations must be a prefix of this checkout's. These are the fast paths
 * that fail before wrangler starts. The slow paths (a pre-0006 backup with and without alt on
 * every image) were run by hand against a scratch D1, see the report.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTENT_TABLES } from "../scripts/backup-tables";

const root = resolve(import.meta.dirname, "..");
const known = readdirSync(join(root, "migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function verify(migrations: string[]): { code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "backup-verify-test-"));
  dirs.push(dir);
  const tables = Object.fromEntries(CONTENT_TABLES.map((t) => [t, 0]));
  for (const t of CONTENT_TABLES) writeFileSync(join(dir, `${t}.sql`), "");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ formatVersion: 1, migrations, tables, excluded: [] }));
  try {
    execFileSync("npx", ["tsx", "scripts/backup.ts", "verify", "--dir", dir], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, err: "" };
  } catch (e) {
    const x = e as { status: number; stderr: string };
    return { code: x.status, err: x.stderr };
  }
}

describe("backup verify refuses a manifest whose migrations aren't a prefix of this checkout's", () => {
  it("with a gap (0004 missing)", () => {
    const r = verify(known.filter((m) => !m.startsWith("0004")).slice(0, 4));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/aren't a prefix/);
  });

  it("out of order", () => {
    const r = verify([known[1], known[0]]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/aren't a prefix/);
  });

  it("with a duplicate", () => {
    const r = verify([known[0], known[0]]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/aren't a prefix/);
  });

  it("with no migrations at all", () => {
    const r = verify([]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/lists no migrations/);
  });
});
