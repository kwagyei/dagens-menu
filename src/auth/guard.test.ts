import { describe, expect, it, vi } from "vitest";
import { checkFormToken, formToken, guardAdminRequest, type RateLimiter } from "./guard";

const SECRET = "s".repeat(32);
const site = "https://bistro.example";
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(`${site}${path}`, init);

/** Allows `max` calls per key, like the Workers binding within one window. */
function limiter(max: number): RateLimiter & { calls: string[] } {
  const counts = new Map<string, number>();
  const calls: string[] = [];
  return {
    calls,
    async limit({ key }) {
      calls.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key)! <= max };
    },
  };
}

describe("guardAdminRequest: cross-site requests", () => {
  it("refuses a form post from another site", async () => {
    const res = await guardAdminRequest(req("/admin/logout", { method: "POST", headers: { Origin: "https://evil.example" } }), "bistro", undefined);
    expect(res?.status).toBe(403);
  });

  it("refuses a JSON post with no Origin at all", async () => {
    const res = await guardAdminRequest(req("/admin/api/login-verify", { method: "POST", headers: { "Content-Type": "application/json" } }), "bistro", undefined);
    expect(res?.status).toBe(403);
  });

  it("lets the site's own posts and any GET through", async () => {
    expect(await guardAdminRequest(req("/admin/logout", { method: "POST", headers: { Origin: site } }), "bistro", undefined)).toBeNull();
    expect(await guardAdminRequest(req("/admin/", { headers: { Origin: "https://evil.example" } }), "bistro", undefined)).toBeNull();
  });
});

describe("guardAdminRequest: rate limiting", () => {
  const attempt = (l: RateLimiter, ip = "203.0.113.7") =>
    guardAdminRequest(req("/admin/api/login-verify", { method: "POST", headers: { Origin: site, "CF-Connecting-IP": ip } }), "bistro", l);

  it("answers the 11th attempt in a window with 429", async () => {
    const l = limiter(10);
    for (let i = 0; i < 10; i++) expect(await attempt(l)).toBeNull();
    const res = await attempt(l);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("60");
  });

  it("counts per site and IP", async () => {
    const l = limiter(1);
    expect(await attempt(l, "198.51.100.1")).toBeNull();
    expect(await attempt(l, "198.51.100.2")).toBeNull();
    expect(l.calls).toEqual(["bistro:198.51.100.1", "bistro:198.51.100.2"]);
  });

  it("limits opening invite links too, but not other admin pages", async () => {
    const l = limiter(0);
    expect((await guardAdminRequest(req("/admin/invite/abc"), "bistro", l))?.status).toBe(429);
    expect(await guardAdminRequest(req("/admin/"), "bistro", l)).toBeNull();
  });

  it("doesn't run the limiter for a refused cross-site request", async () => {
    const l = limiter(10);
    const spy = vi.spyOn(l, "limit");
    await guardAdminRequest(req("/admin/logout", { method: "POST", headers: { Origin: "https://evil.example" } }), "bistro", l);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("form tokens", () => {
  it("are accepted only with the session they were made for", async () => {
    const token = await formToken(SECRET, "a".repeat(64));
    expect(await checkFormToken(SECRET, "a".repeat(64), token)).toBe(true);
    expect(await checkFormToken(SECRET, "b".repeat(64), token)).toBe(false);
    expect(await checkFormToken(SECRET, "a".repeat(64), undefined)).toBe(false);
    expect(await checkFormToken(SECRET, "a".repeat(64), "forged")).toBe(false);
  });
});
