/**
 * Which D1 tables the weekly content export takes (ADR-011 §5, plan M7.5), and why the rest are
 * left out. Every table in migrations/ must be in exactly one of the two lists:
 * tests/backup-tables.test.ts fails otherwise, so a new table is a decision, not an accident.
 */

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
