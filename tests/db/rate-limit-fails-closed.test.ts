/**
 * Tester, review L2: without the AUTH_LIMITER binding the limited paths fail closed, in every
 * spelling the router would still serve, and log once per request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardAdminRequest, type RateLimiter } from "../../src/auth/guard";

const site = "https://bistro.example";
const req = (path: string, method = "POST") => new Request(`${site}${path}`, { method, headers: method === "GET" ? {} : { Origin: site } });

afterEach(() => vi.restoreAllMocks());

describe("guardAdminRequest without a limiter (review L2)", () => {
  it("answers 503 for invite and api paths, plain and percent-encoded, logging once each", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const paths = [
      ["/admin/api/invite-check", "POST"],
      ["/en/admin/api/login-verify", "POST"],
      ["/admin/invite/", "GET"],
      ["/en/admin/invite/", "GET"],
      ["/%61dmin/api/login-options", "POST"],
      ["/admin/%61pi/enrol-options", "POST"],
      ["/admin/api%2Fadd-verify", "POST"],
      ["/admin/%69nvite/", "GET"],
    ] as const;
    for (const [path, method] of paths) {
      const before = log.mock.calls.length;
      const res = await guardAdminRequest(req(path, method), "bistro", undefined);
      expect(res?.status, path).toBe(503);
      expect(res?.headers.get("Retry-After"), path).toBe("60");
      expect(log.mock.calls.length - before, path).toBe(1);
    }
  });

  it("leaves other admin pages alone and logs nothing for them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/admin/", "/admin/menu/new/", "/en/admin/history/", "/admin/apiary/", "/admin/invites/"]) {
      expect(await guardAdminRequest(req(path), "bistro", undefined), path).toBeNull();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("still refuses a cross-site post with 403 before the missing limiter matters", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await guardAdminRequest(new Request(`${site}/admin/api/invite-check`, { method: "POST", headers: { Origin: "https://evil.example" } }), "bistro", undefined);
    expect(res?.status).toBe(403);
  });

  it("limits a doubled slash before api/ like the plain path (the router serves both)", async () => {
    const limiter: RateLimiter = { limit: vi.fn(async () => ({ success: false })) };
    const res = await guardAdminRequest(req("/admin//api/invite-check"), "bistro", limiter);
    expect(res?.status).toBe(429);
  });
});
