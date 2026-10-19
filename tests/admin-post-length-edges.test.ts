/**
 * Security review L1, 18 Oct: the admin's body-size gate. Odd Content-Length
 * values, every changing method, the /en/ variants, and paths that try to borrow (or lose)
 * the photo upload's exemption.
 */
import { describe, expect, it } from "vitest";
import { ADMIN_BODY_LIMIT, guardAdminRequest, type RateLimiter } from "../src/auth/guard";

const site = "https://bistro.example";
const limiter: RateLimiter = { limit: async () => ({ success: true }) };
const send = async (path: string, length: string | null, method = "POST") => {
  const r = new Request(`${site}${path}`, { method, headers: { Origin: site } });
  if (length !== null) r.headers.set("Content-Length", length);
  return (await guardAdminRequest(r, "bistro", limiter))?.status ?? "through";
};

describe("Content-Length must be a plain decimal number", () => {
  it.each(["-1", "+5", "1e3", "0x10", "12.0", "1 2", "1,1", "", "Infinity", "NaN"])("refuses %j with 411", async (value) => {
    expect(await send("/admin/texts/", value)).toBe(411);
  });

  it("refuses a huge length, however many digits, with 413", async () => {
    expect(await send("/admin/texts/", "9".repeat(400))).toBe(413);
    expect(await send("/admin/api/add-confirm", String(Number.MAX_SAFE_INTEGER) + "0")).toBe(413);
    expect(await send("/admin/api/add-confirm", String(ADMIN_BODY_LIMIT + 1))).toBe(413);
  });

  it('reads the value as Fetch does: surrounding whitespace is trimmed, so " 12" is 12', async () => {
    expect(await send("/admin/texts/", " 12 ")).toBe("through");
    expect(await send("/admin/texts/", ` ${ADMIN_BODY_LIMIT + 1}\t`)).toBe(413);
  });

  it("accepts zero and leading zeros at the limit", async () => {
    expect(await send("/admin/logout", "0")).toBe("through");
    expect(await send("/admin/texts/", `000${ADMIN_BODY_LIMIT}`)).toBe("through");
  });
});

describe("every changing method is held to it, on both locales", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s", async (method) => {
    expect(await send("/admin/menu/", null, method)).toBe(411);
    expect(await send("/en/admin/menu/", String(ADMIN_BODY_LIMIT + 1), method)).toBe(413);
  });

  it("a GET or HEAD is not asked for a length (its handler reads no body)", async () => {
    expect(await send("/admin/texts/", null, "GET")).toBe("through");
    expect(await send("/admin/texts/", "99999999", "HEAD")).toBe("through");
  });

  it("the /en/ passkey endpoints and percent-encoded admin paths are held too", async () => {
    expect(await send("/en/admin/api/add-verify", null)).toBe(411);
    expect(await send("/%61dmin/api/add-confirm", String(ADMIN_BODY_LIMIT + 1))).toBe(413);
    expect(await send("/admin//api//login-verify", null)).toBe(411);
  });
});

describe("only the photo upload page is exempt", () => {
  it.each(["/admin/photos/new", "/admin/photos/new/", "/en/admin/photos/new/", "/admin//photos//new/", "/%61dmin/photos/new/", "/admin/photos/%6Eew/"])(
    "%s: exempt (all route to the upload page)",
    async (path) => {
      expect(await send(path, String(ADMIN_BODY_LIMIT + 1))).toBe("through");
    },
  );

  it.each([
    "/admin/photos/new/x",
    "/admin/photos/newer/",
    "/admin/photos/",
    "/admin/photos/new%2F..%2F..%2Fapi%2Fadd-confirm",
    "/admin/photos/new/../../api/add-confirm",
    "/admin/photos/new/%2e%2e/%2e%2e/api/add-confirm",
    "/admin/photos/new%3F",
    "/en/admin/photos/new/x/",
    "/admin/photos/new;/",
  ])("%s: not exempt", async (path) => {
    expect(await send(path, String(ADMIN_BODY_LIMIT + 1))).toBe(413);
  });
});
