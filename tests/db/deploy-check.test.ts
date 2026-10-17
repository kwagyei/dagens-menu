/** Review M2: the post-deploy batch-guard check, run against workerd's local D1. */
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CHECK_SITE, checkBatchGuard } from "../../src/db/deploy-check";

const db = env.DB;
const now = new Date("2026-10-17T10:00:00Z");
const rows = async () => (await db.prepare("SELECT count(*) AS n FROM sites WHERE id = ?").bind(CHECK_SITE).first<number>("n"))!;

describe("checkBatchGuard", () => {
  it("passes where changes() carries across a batch, and leaves nothing behind", async () => {
    await db.prepare("INSERT OR IGNORE INTO sites (id) VALUES ('bistro')").run();
    const version = await db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<number>("v");
    expect(await checkBatchGuard(db, now)).toEqual([]);
    expect(await rows()).toBe(0);
    expect(await db.prepare("SELECT count(*) AS n FROM audit_log WHERE site_id = ?").bind(CHECK_SITE).first<number>("n")).toBe(0);
    // A real site's content is never touched.
    expect(await db.prepare("SELECT content_version AS v FROM sites WHERE id = 'bistro'").first<number>("v")).toBe(version);
  });

  it("clears a leftover from a run that died halfway", async () => {
    await db.prepare("INSERT OR IGNORE INTO sites (id) VALUES (?)").bind(CHECK_SITE).run();
    expect(await checkBatchGuard(db, now)).toEqual([]);
    expect(await rows()).toBe(0);
  });

  it("reports a guard that doesn't carry, and still cleans up", async () => {
    // Simulate a D1 that runs each batch statement on its own connection: changes() reads 0.
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => target.prepare(sql.replace(/WHERE changes\(\) (> 0|= 1)/, "WHERE 0"));
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const warn = vi.spyOn(console, "warn");
    const problems = await checkBatchGuard(broken, now);
    expect(problems).toContain("changes() did not carry across the batch: commitIf had to add the audit row separately");
    expect(problems.some((p) => p.startsWith("the guarded insert saw changes() ≠ 1"))).toBe(true);
    expect(warn).not.toHaveBeenCalled(); // captured, not printed
    expect(await rows()).toBe(0);
  });
});
