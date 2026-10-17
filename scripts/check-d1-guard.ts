/**
 * Post-deploy check (review M2): on the real D1, a save moves content_version and writes its
 * audit row, which depends on changes() carrying across a batch (src/db/deploy-check.ts).
 * It goes through the D1 binding API, as the Worker does, not through `wrangler d1 execute`,
 * whose HTTP path could behave differently.
 *
 *   npx tsx scripts/check-d1-guard.ts            # the local D1 in .wrangler/state
 *   npx tsx scripts/check-d1-guard.ts --remote   # production; needs CLOUDFLARE_API_TOKEN
 *
 * It writes only a throwaway site that no Worker serves, and deletes it again.
 */
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { checkBatchGuard } from "../src/db/deploy-check";
import type { D1Database } from "../src/db/types";
import { root } from "./d1-cli";

const { values } = parseArgs({ options: { remote: { type: "boolean", default: false } } });
const where = values.remote ? "production" : "local";
// d1.remote.jsonc marks the binding remote, so the proxy reaches the real database.
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: `${root}/${values.remote ? "d1.remote.jsonc" : "d1.local.jsonc"}`,
  remoteBindings: values.remote,
  envFiles: [],
});
try {
  const problems = await checkBatchGuard(proxy.env.DB, new Date());
  if (problems.length > 0) {
    console.error(`check-d1-guard: the batch guard does not hold on the ${where} D1:\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log(`check-d1-guard: on the ${where} D1 a save moved content_version and wrote exactly one audit row; a save that matched nothing wrote none.`);
  }
} finally {
  await proxy.dispose();
}
