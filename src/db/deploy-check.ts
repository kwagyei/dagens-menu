/**
 * Post-deploy check of the batch guard on the real D1 (review M2). The content writes
 * (commitIf) and passkey enrolment rely on SQLite's changes() carrying from one statement of
 * a db.batch() to the next. That holds locally; this proves it on the production database
 * after every deploy, through the same D1 binding API the Worker uses.
 *
 * It never touches a restaurant's content. It creates a throwaway site (CHECK_SITE) that no
 * Worker serves, saves through the real commitIf, reads the result, and deletes the site,
 * whose rows (category, audit entries) go with it by ON DELETE CASCADE. Read-only checks
 * can't do this: they can only look at past saves, and there may be none since the deploy.
 * Used by scripts/check-d1-guard.ts; nothing in the Worker imports it.
 */
import { commitIf, isoSeconds } from "./repository";
import { prepare, stmt } from "./sql";
import type { D1Database } from "./types";

export const CHECK_SITE = "zz-deploy-check";
const CATEGORY = "deploycheck1";

const version = (db: D1Database) => db.prepare("SELECT content_version AS v FROM sites WHERE id = ?").bind(CHECK_SITE).first<number>("v");
const audits = (db: D1Database) => db.prepare("SELECT count(*) AS n FROM audit_log WHERE site_id = ?").bind(CHECK_SITE).first<number>("n");
const touch = (id: string) => stmt("UPDATE menu_categories SET row_version = row_version + 1 WHERE site_id = ? AND id = ?", CHECK_SITE, id);
const entry = { entity: "category", entityId: CATEGORY, action: "update", summary: "deploy check" } as const;

/** What went wrong; empty when the guard holds. Always removes its throwaway site. */
export async function checkBatchGuard(db: D1Database, now: Date): Promise<string[]> {
  const problems: string[] = [];
  const ctx = { db, siteId: CHECK_SITE, userId: null, now };
  // commitIf repairs a missing audit row and only warns: count the warnings, or a broken guard would pass.
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  try {
    await db.batch([
      db.prepare("DELETE FROM sites WHERE id = ?").bind(CHECK_SITE), // a leftover from a run that died
      db.prepare("INSERT INTO sites (id, created_at) VALUES (?, ?)").bind(CHECK_SITE, isoSeconds(now)),
      db.prepare("INSERT INTO menu_categories (site_id, id, slug, name_sv, name_en, position) VALUES (?, ?, 'check', 'Kontroll', 'Check', 0)").bind(CHECK_SITE, CATEGORY),
    ]);
    const before = { version: await version(db), audits: await audits(db) };

    // 1. A save that matches: the trigger bumps the version, the guarded insert writes the audit row.
    if (!(await commitIf(ctx, touch(CATEGORY), entry))) problems.push("a save that matched its row reported no change");
    const after = { version: await version(db), audits: await audits(db) };
    if (!(after.version! > before.version!)) problems.push(`content_version did not move (${before.version} → ${after.version})`);
    if (after.audits !== before.audits! + 1) problems.push(`expected one new audit row, found ${after.audits! - before.audits!}`);
    if (warnings.length > 0) problems.push("changes() did not carry across the batch: commitIf had to add the audit row separately");

    // 2. A save that matches nothing writes no audit row: changes() is this batch's 0, not a stale count.
    if (await commitIf(ctx, touch("nosuchcateg0"), entry)) problems.push("a save that matched no row reported a change");
    if ((await audits(db)) !== after.audits) problems.push("a save that matched no row still wrote an audit row");

    // 3. The raw shape the passkey enrolment uses: the second statement sees the first's changes().
    const [, carried] = await db.batch(
      prepare(db, [
        touch(CATEGORY),
        stmt("INSERT INTO audit_log (site_id, at, entity, action, summary) SELECT ?, ?, 'check', 'update', 'raw' WHERE changes() = 1", CHECK_SITE, isoSeconds(now)),
      ]),
    );
    if (carried.meta.changes !== 1) problems.push(`the guarded insert saw changes() ≠ 1 (inserted ${carried.meta.changes} rows)`);
  } finally {
    console.warn = warn;
    await db.prepare("DELETE FROM sites WHERE id = ?").bind(CHECK_SITE).run();
  }
  const left = await db.prepare("SELECT (SELECT count(*) FROM sites WHERE id = ?1) + (SELECT count(*) FROM audit_log WHERE site_id = ?1) AS n").bind(CHECK_SITE).first<number>("n");
  if (left !== 0) problems.push(`the throwaway site "${CHECK_SITE}" was not fully removed (${left} rows left)`);
  return problems;
}
