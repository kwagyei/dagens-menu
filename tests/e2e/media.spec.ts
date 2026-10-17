/**
 * Photos served by the real Worker (plan M6.8): an upload is fetchable at
 * /media/<id>-<width>.webp for every size, byte for byte, with the immutable, sandboxed
 * headers, and anything else under /media/ is a plain 404, not a page.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const NEW = "/admin/photos/new/";

test("an uploaded photo is served at every size, exactly, cached for a year and sandboxed", async ({ page, request }) => {
  await signedInOwner(page);
  const widths = [400, 800, 1200];
  const parts = await Promise.all(widths.map((width) => sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width }).modulate({ hue: 37 }).webp({ quality: 75 }).toBuffer()));
  const id = createHash("sha256").update(parts[parts.length - 1]).digest("hex");

  await page.goto(NEW);
  const form = new FormData();
  form.set("csrf", await page.locator("input[name=csrf]").first().inputValue());
  form.set("alt_sv", "Köttbullar i ett annat ljus");
  form.set("alt_en", "Meatballs in a different light");
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  const res = await page.request.post(NEW, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.headers().location).toMatch(/done=(added|duplicate)/);

  for (const [i, width] of widths.entries()) {
    const photo = await request.get(`/media/${id}-${width}.webp`);
    expect(photo.status(), `width ${width}`).toBe(200);
    expect(Buffer.from(await photo.body()).equals(parts[i]), `width ${width} bytes`).toBe(true);
    expect(photo.headers()).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    });
  }
  const again = await request.get(`/media/${id}-800.webp`, { headers: { "If-None-Match": `"${id}-800"` } });
  expect(again.status()).toBe(304);
  const head = await request.head(`/media/${id}-1200.webp`);
  expect(head.headers()["content-length"]).toBe(String(parts[2].length));
});

test("anything else under /media/ is a plain 404, never a page or a redirect", async ({ request }) => {
  for (const path of ["/media/", "/media/x.webp", `/media/${"0".repeat(64)}-800.webp`, `/media/${"a".repeat(64)}-800.webp/extra`]) {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status(), path).toBe(404);
    expect(res.headers()["content-type"], path).toContain("text/plain");
    expect(res.headers()["cache-control"], path).toBe("no-store");
  }
});
