// Shipped migrations never change (ADR-011; reviewer M2 L1). Production D1 records each
// migration by name and never runs it again, so an edited file would leave every existing
// database different from a fresh one. Compared with <base>, files under migrations/ may only
// be added. A change belongs in a new migration.
//
// Usage: node scripts/check-migrations.mjs <base commit>   (CI passes the PR base or the push's before)

import { execFileSync } from "node:child_process";

const base = process.argv[2];
if (!base || /^0+$/.test(base)) {
  console.log("check-migrations: no base commit to compare with; nothing to check.");
  process.exit(0);
}
const changes = execFileSync("git", ["diff", "--name-status", "--no-renames", base, "--", "migrations/"], { encoding: "utf-8" })
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"));
const touched = changes.filter(([status]) => status !== "A");
if (touched.length > 0) {
  console.error("Shipped migrations must not change; add a new migration instead:");
  for (const [status, path] of touched) console.error(`  ${status === "D" ? "deleted" : "changed"}: ${path}`);
  process.exit(1);
}
const added = changes.map(([, path]) => path);
console.log(added.length > 0 ? `check-migrations: only additions (${added.join(", ")}).` : "check-migrations: migrations unchanged.");
