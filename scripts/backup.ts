/**
 * The weekly content-only export (ADR-011 §5, plan M7.5) and its check.
 *
 *   npm run backup -- export --out <dir> [--remote --config wrangler.bistro.jsonc]
 *   npm run backup -- verify --dir <dir>
 *
 * export writes one data-only SQL file per content table (scripts/backup-tables.ts) and a
 * manifest.json with the applied migrations and each table's row count. It runs one
 * `wrangler d1 export --table` per table: D1 fails other queries while an export runs (M0.5),
 * so each window stays short, and the Workers serve their cached content meanwhile.
 * Without --remote it reads the local database, which is how CI tests it.
 *
 * verify loads a directory into a fresh local D1 with the migrations applied, one file at a
 * time with foreign keys on, and checks every count against the manifest. A backup that
 * doesn't load is caught the week it's made, not the day it's needed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkTarget, fail as failWith, query, root, type D1Target } from "./d1-cli";
import { CONTENT_TABLES, countRows, EXCLUDED_TABLES } from "./backup-tables";

const fail: (message: string) => never = (message) => failWith("backup", message);

export interface Manifest {
  formatVersion: 1;
  /** Applied migrations, oldest first: the schema the files were taken from. */
  migrations: string[];
  /** Row count per exported table, in load order. */
  tables: Record<string, number>;
  /** Tables deliberately left out (scripts/backup-tables.ts). */
  excluded: string[];
}

const stderrOf = (error: unknown) => (error as { stderr?: string }).stderr ?? String(error);

function wrangler(args: string[]): string {
  try {
    return execFileSync("npx", ["wrangler", ...args], { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fail(`wrangler ${args.slice(0, 2).join(" ")} failed\n${stderrOf(error)}`);
  }
}

function exportTo(out: string, target: D1Target): void {
  checkTarget("backup", target);
  mkdirSync(out, { recursive: true });
  const migrations = query<{ name: string }>("backup", target, "SELECT name FROM d1_migrations ORDER BY id").map((r) => r.name);
  const tables: Record<string, number> = {};
  for (const table of CONTENT_TABLES) {
    const file = join(out, `${table}.sql`);
    const where = target.remote ? "--remote" : "--local";
    wrangler(["d1", "export", target.database, where, "--config", target.config, "--table", table, "--no-schema", "--output", file, "-y"]);
    if (!existsSync(file)) writeFileSync(file, "");
    tables[table] = countRows(readFileSync(file, "utf-8"), table);
  }
  // A table dropped from the list must not linger in the backup as if it were current.
  for (const name of readdirSync(out)) {
    if (name.endsWith(".sql") && !(CONTENT_TABLES as readonly string[]).includes(name.slice(0, -4))) rmSync(join(out, name));
  }
  const manifest: Manifest = { formatVersion: 1, migrations, tables, excluded: Object.keys(EXCLUDED_TABLES).sort() };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`backup: exported ${Object.entries(tables).map(([t, n]) => `${t} ${n}`).join(", ")}`);
}

function verify(dir: string): void {
  const manifestFile = join(dir, "manifest.json");
  if (!existsSync(manifestFile)) fail(`${manifestFile} not found`);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf-8")) as Manifest;
  const known = readdirSync(resolve(root, "migrations")).filter((f) => f.endsWith(".sql"));
  const unknown = manifest.migrations.filter((m) => !known.includes(m));
  if (unknown.length) fail(`the backup's schema is newer than this checkout (unknown migrations: ${unknown.join(", ")})`);

  const work = mkdtempSync(join(tmpdir(), "backup-verify-"));
  try {
    const config = join(work, "wrangler.json");
    writeFileSync(config, JSON.stringify({
      name: "backup-verify",
      compatibility_date: "2026-10-01",
      d1_databases: [{ binding: "DB", database_name: "backup-verify", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: resolve(root, "migrations") }],
    }));
    const local = ["--local", "--config", config, "--persist-to", join(work, "state")];
    wrangler(["d1", "migrations", "apply", "backup-verify", ...local]);
    for (const table of CONTENT_TABLES) {
      const expected = manifest.tables[table];
      if (expected === undefined) fail(`manifest.json has no count for ${table}`);
      const file = join(dir, `${table}.sql`);
      if (countRows(readFileSync(file, "utf-8"), table) !== expected) fail(`${table}.sql doesn't hold the ${expected} rows its manifest says`);
      if (expected > 0) wrangler(["d1", "execute", "backup-verify", ...local, "--file", file, "-y"]);
      const out = wrangler(["d1", "execute", "backup-verify", ...local, "--json", "--command", `SELECT count(*) AS n FROM "${table}"`]);
      const loaded = (JSON.parse(out)[0].results as { n: number }[])[0].n;
      if (loaded !== expected) fail(`${table}: loaded ${loaded} rows, the manifest says ${expected}`);
    }
    console.log(`backup: ${dir} loads into a fresh database (${CONTENT_TABLES.length} tables, counts match)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    dir: { type: "string" },
    remote: { type: "boolean", default: false },
    database: { type: "string", default: "dagens-menu" },
    config: { type: "string", default: "d1.local.jsonc" },
  },
});
const [command] = positionals;
if (command === "export") {
  if (!values.out) fail("export needs --out <dir>");
  exportTo(resolve(values.out), { database: values.database!, config: values.config!, remote: values.remote! });
} else if (command === "verify") {
  if (!values.dir) fail("verify needs --dir <dir>");
  verify(resolve(values.dir));
} else {
  fail("usage: backup export --out <dir> [--remote --config <wrangler config>] | backup verify --dir <dir>");
}
