import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file; storage is isolated per file, so each starts from empty.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
