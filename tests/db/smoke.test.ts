import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

it("runs inside workerd with the migrations applied", async () => {
  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  expect(results.map((r) => r.name)).toEqual(expect.arrayContaining(["sites", "menu_items", "home_highlights", "sessions", "passkeys", "audit_log"]));
  expect(typeof navigator !== "undefined" && navigator.userAgent).toBe("Cloudflare-Workers");
});
