import { describe, expect, it } from "vitest";
import { adminProblems, publicPageProblems } from "../scripts/smoke.mjs";

const html = (title: string, body = "") => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const good = (etag = 'W/"abc1234-1-2026-10-16-x"') =>
  new Headers({ "content-security-policy": "default-src 'self'", "strict-transport-security": "max-age=31536000", etag });
const want = { title: "Bistro Norden", build: "abc1234" };

describe("publicPageProblems", () => {
  it("passes a page that serves this build with its title and headers", () => {
    expect(publicPageProblems("/", { status: 200, headers: good(), html: html("Meny | Bistro Norden") }, want)).toEqual([]);
  });

  it("names each problem: status, title, headers, an older build, a third-party request", () => {
    const headers = new Headers({ etag: 'W/"0ld0000-1-2026-10-16-x"' });
    const page = html("Chez Abena", '<img src="https://cdn.example.com/x.png">');
    expect(publicPageProblems("/menu/", { status: 503, headers, html: page }, want)).toEqual([
      "/menu/: status 503",
      '/menu/: title "Chez Abena" lacks "Bistro Norden"',
      "/menu/: no Content-Security-Policy",
      "/menu/: no Strict-Transport-Security",
      '/menu/: serves build W/"0ld0000-1-2026-10-16-x", expected abc1234',
      '/menu/: loads src="https://cdn.example.com/x.png" before consent',
    ]);
  });

  it("does not take a build id that merely starts the same", () => {
    expect(publicPageProblems("/", { status: 200, headers: good('W/"abc12345-1-x"'), html: html("Bistro Norden") }, want)).toHaveLength(1);
  });
});

describe("adminProblems", () => {
  it("wants the sign-in page up, uncached, with a CSP", () => {
    expect(adminProblems({ status: 200, headers: new Headers({ "cache-control": "no-store", "content-security-policy": "default-src 'self'" }) })).toEqual([]);
    expect(adminProblems({ status: 503, headers: new Headers({ "cache-control": "no-cache" }) })).toHaveLength(3);
  });
});
