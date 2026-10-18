/**
 * Which D1 tables the weekly content export takes (ADR-011 §5, plan M7.5), and why the rest are
 * left out. Every table in migrations/ must be in exactly one of the two lists:
 * tests/backup-tables.test.ts fails otherwise, so a new table is a decision, not an accident.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exported, in this order: a table comes after every table it references, so a restore can
 *  load the files one at a time with foreign keys on. */
export const CONTENT_TABLES = [
  "sites",
  "images",
  "settings",
  "menu_categories",
  "menu_items",
  "home_highlights",
  "weekly_hours",
  "hours_exceptions",
  "page_content",
  "gallery_images",
] as const;

/** Never exported, with the reason. */
export const EXCLUDED_TABLES: Record<string, string> = {
  // ADR-012: tens of MB of photo bytes, and an export makes D1 queries fail while it runs.
  // Photos are backed up by Time Travel and by the owners' own downloads (ADR-014).
  image_variants: "photo bytes (ADR-012)",
  audit_log: "names the people who made each change",
  users: "owner emails",
  memberships: "auth",
  passkeys: "auth",
  sessions: "auth",
  invites: "auth",
  rate_limits: "hashed IP addresses",
  used_challenges: "auth",
};

export interface Manifest {
  formatVersion: 1;
  /** Applied migrations, oldest first: the schema the files were taken from. */
  migrations: string[];
  /** Row count per exported table, in load order. */
  tables: Record<string, number>;
  /** Tables deliberately left out. */
  excluded: string[];
}

/** What an export needs from the database; scripts/backup.ts runs wrangler for each. */
export interface ExportSource {
  /** The applied migrations, oldest first. */
  migrations(): string[];
  /** Write one table's rows to `file` as data-only SQL (wrangler may write nothing for an empty table). */
  exportTable(table: string, file: string): void;
}

/**
 * Export the content tables into `out` and write its manifest. Only CONTENT_TABLES are asked
 * for, and any other .sql file already in `out` is removed, so a table dropped from the list
 * (or never on it, like image_variants) can't linger in the backup as if it were current.
 */
export function exportTables(out: string, source: ExportSource): Manifest {
  mkdirSync(out, { recursive: true });
  const migrations = source.migrations();
  const tables: Record<string, number> = {};
  for (const table of CONTENT_TABLES) {
    const file = join(out, `${table}.sql`);
    source.exportTable(table, file);
    if (!existsSync(file)) writeFileSync(file, "");
    tables[table] = countRows(readFileSync(file, "utf-8"), table);
  }
  for (const name of readdirSync(out)) {
    if (name.endsWith(".sql") && !(CONTENT_TABLES as readonly string[]).includes(name.slice(0, -4))) rmSync(join(out, name));
  }
  const manifest: Manifest = { formatVersion: 1, migrations, tables, excluded: Object.keys(EXCLUDED_TABLES).sort() };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Rows in a data-only export: wrangler writes one INSERT per row, each starting a line. */
export function countRows(sql: string, table: string): number {
  const prefix = `INSERT INTO "${table}"`;
  let rows = 0;
  for (const line of sql.split("\n")) {
    if (line.startsWith(prefix)) rows++;
    else if (line.startsWith("INSERT INTO")) throw new Error(`${table}.sql holds rows for another table: ${line.slice(0, 60)}`);
  }
  return rows;
}
