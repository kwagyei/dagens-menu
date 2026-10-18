import { describe, expect, it } from "vitest";
import { adminProblems, galleryProblems, photoProblems, publicPageProblems, UNKNOWN_MEDIA, unknownMediaProblems } from "../scripts/smoke.mjs";

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

describe("photo checks", () => {
  const gallery = (items: string) => html("Galleri | Bistro Norden", `<ul class="gallery-magazine">${items}</ul>`);
  const img = (src: string, alt: string) => `<li><figure><img src="${src}" srcset="${src} 800w" alt="${alt}" loading="lazy"></figure></li>`;

  it("takes a gallery whose photos all have alt, and returns the first photo", () => {
    const page = gallery(img("/images/bistro/v/a-800.webp", "Dukat bord") + img(`/media/${"a".repeat(64)}-800.webp`, "Fisk"));
    expect(galleryProblems("/gallery/", page)).toEqual({ problems: [], photo: "/images/bistro/v/a-800.webp" });
  });

  it("names an empty gallery and a photo without alt", () => {
    expect(galleryProblems("/gallery/", html("x")).problems).toEqual(["/gallery/: the gallery lists no photos"]);
    expect(galleryProblems("/gallery/", gallery(img("/a.webp", "Ok") + img("/b.webp", "  "))).problems).toEqual(["/gallery/: gallery photo 2 (/b.webp) has no alt text"]);
  });

  it("wants the photo served as WebP", () => {
    expect(photoProblems("/a.webp", { status: 200, headers: new Headers({ "content-type": "image/webp" }) })).toEqual([]);
    expect(photoProblems("/a.webp", { status: 404, headers: new Headers({ "content-type": "text/html" }) })).toHaveLength(2);
  });

  it("wants an unknown /media id to be a sandboxed 404", () => {
    expect(UNKNOWN_MEDIA).toMatch(/^\/media\/[0-9a-f]{64}-400\.webp$/);
    expect(unknownMediaProblems({ status: 404, headers: new Headers({ "content-security-policy": "default-src 'none'; sandbox" }) })).toEqual([]);
    expect(unknownMediaProblems({ status: 200, headers: new Headers({ "content-security-policy": "default-src 'self'" }) })).toHaveLength(2);
  });
});
