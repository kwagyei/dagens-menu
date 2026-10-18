/**
 * Tester, M6.8 (2026-10-17): /media against the real Worker. Path tricks, If-None-Match edge cases,
 * headers on every status, no content read (works with the content deleted, never sets a cookie),
 * a WebP whose ICC profile carries HTML, and a second site's Worker on the same D1.
 * Set WESTAFRICAN_URL (scripts/serve-westafrican.sh) to run the site-isolation test.
 */
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import { expect, type APIResponse, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const NEW = "/admin/photos/new/";
const WEST = process.env.WESTAFRICAN_URL;

const SANDBOX = "default-src 'none'; sandbox";
function sandboxed(res: APIResponse, label: string) {
  const h = res.headers();
  expect(h["content-security-policy"], label).toBe(SANDBOX);
  expect(h["cross-origin-resource-policy"], label).toBe("same-origin");
  expect(h["x-content-type-options"], label).toBe("nosniff");
  expect(h["set-cookie"], `${label} set-cookie`).toBeUndefined();
}

/** RIFF/WebP with a VP8X + ICCP(valid 128-byte header, then `html` inside the payload) + the VP8 chunk of a sharp file. */
function withHtmlIcc(plain: Buffer, html: string): Buffer {
  const chunks: { id: string; data: Buffer }[] = [];
  for (let o = 12; o < plain.length; ) {
    const size = plain.readUInt32LE(o + 4);
    chunks.push({ id: plain.toString("latin1", o, o + 4), data: plain.subarray(o + 8, o + 8 + size) });
    o += 8 + size + (size & 1);
  }
  const vp8 = chunks.find((c) => c.id === "VP8 ")!;
  const w = vp8.data.readUInt16LE(6) & 0x3fff;
  const h = vp8.data.readUInt16LE(8) & 0x3fff;
  const body = Buffer.from(html);
  const icc = Buffer.alloc(128 + body.length + (body.length & 1));
  icc.writeUInt32BE(icc.length, 0);
  icc.write("acsp", 36, "latin1");
  body.copy(icc, 128);
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x20;
  vp8x.writeUIntLE(w - 1, 4, 3);
  vp8x.writeUIntLE(h - 1, 7, 3);
  const chunk = (id: string, d: Buffer) => {
    const head = Buffer.alloc(8);
    head.write(id, 0, "latin1");
    head.writeUInt32LE(d.length, 4);
    return Buffer.concat([head, d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
  };
  const payload = Buffer.concat([Buffer.from("WEBP"), chunk("VP8X", vp8x), chunk("ICCP", icc), chunk("VP8 ", vp8.data)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(payload.length, 4);
  return Buffer.concat([riff, payload]);
}

let tint = 40;
async function upload(page: import("@playwright/test").Page, transform?: (master: Buffer) => Buffer) {
  const parts = await Promise.all(
    [400, 800, 1200].map((width) => sharp("public/images/bistro/kottbullar-hero.jpg").resize({ width }).modulate({ hue: ++tint * 3 }).webp({ quality: 70 }).toBuffer()),
  );
  if (transform) parts[2] = transform(parts[2]) as Buffer<ArrayBuffer>;
  const id = createHash("sha256").update(parts[2]).digest("hex");
  await page.goto(NEW);
  const form = new FormData();
  form.set("csrf", await page.locator("input[name=csrf]").first().inputValue());
  form.set("alt_sv", "Testbild");
  form.set("alt_en", "Test image");
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  const res = await page.request.post(NEW, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.headers().location, `upload (${res.status()})`).toMatch(/done=(added|duplicate)/);
  return { id, parts };
}

test.describe.configure({ mode: "serial" });
let photo: { id: string; parts: Buffer[] };

test("setup: upload a photo", async ({ page }) => {
  await signedInOwner(page);
  photo = await upload(page);
});

test("headers on 200, 304, HEAD, 404, 405 all carry CORP, sandbox and nosniff, and never a cookie", async ({ request }) => {
  const { id } = photo;
  const ok = await request.get(`/media/${id}-800.webp`);
  expect(ok.status()).toBe(200);
  sandboxed(ok, "200");
  expect(ok.headers()["etag"]).toBe(`"${id}-800"`);
  const nm = await request.get(`/media/${id}-800.webp`, { headers: { "If-None-Match": `"${id}-800"` } });
  expect(nm.status()).toBe(304);
  sandboxed(nm, "304");
  expect(nm.headers()["etag"]).toBe(`"${id}-800"`);
  const head = await request.head(`/media/${id}-800.webp`);
  expect(head.status()).toBe(200);
  sandboxed(head, "HEAD");
  const nf = await request.get(`/media/${"0".repeat(64)}-800.webp`);
  expect(nf.status()).toBe(404);
  sandboxed(nf, "404");
  expect(nf.headers()["content-type"]).toContain("text/plain");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
    const r = await request.fetch(`/media/${id}-800.webp`, { method, data: "x" });
    expect(r.status(), method).toBe(405);
    expect(r.headers()["allow"], method).toBe("GET, HEAD");
    sandboxed(r, method);
  }
  const opt = await request.fetch(`/media/${id}-800.webp`, { method: "OPTIONS" });
  expect(opt.status()).toBe(405);
});

test("path tricks never crash and never serve anything unexpected", async ({ request }) => {
  test.setTimeout(90_000);
  const { id, parts } = photo;
  const good = parts[1];
  const sameBytes = async (path: string) => {
    const r = await request.get(path, { maxRedirects: 0 });
    expect(r.status(), path).toBe(200);
    expect(Buffer.from(await r.body()).equals(good), path).toBe(true);
    sandboxed(r, path);
  };
  // Spellings that name the same photo are served (or at worst 404), never anything else.
  await sameBytes(`/media/${id}-800.webp?x=1&y=2`);
  await sameBytes(`/media/${id}-800.webp#frag`);
  const notFound = [
    `/media/${id}-0800.webp`,
    `/media/${id}-00800.webp`,
    `/media/${id}-800.webp/`,
    `/media/${id}-800.WEBP`,
    `/media/${id.toUpperCase()}-800.webp`,
    `/media/${id.slice(0, 63)}-800.webp`,
    `/media/${id}0-800.webp`,
    `/media/${id}-.webp`,
    `/media/${id}-800%2ewebp.x`,
    `/media/${id}-+800.webp`,
    `/media/${id}-8e2.webp`,
    `/media/${id}-800.webp.jpg`,
    `/media/../media/${"a".repeat(64)}-800.webp`,
    `/media/%252e%252e/`,
    `/media/${"a".repeat(8000)}.webp`,
    `/media/${"%41".repeat(3000)}`,
    `/media/%`,
    `/media/%zz`,
    `/media/%ff%fe`,
    `/media//${id}-800.webp/x`,
    `/media/a/${id}-800.webp`,
    `/media/;/${id}-800.webp`,
  ];
  for (const path of notFound) {
    const r = await request.get(path, { maxRedirects: 0 });
    const label = `${path.slice(0, 90)} -> ${r.status()} ${r.headers()["content-type"]}`;
    // Leading zeros were an alias (F1): fixed, so 0800 is a plain 404 like every other name.
    // Double-encoded dot segments are rejected by Astro's router before the middleware: a styled
    // HTML 404 that does load content (reported as a Low finding), but still a 404.
    if (path.includes("%252e")) {
      expect(r.status(), label).toBe(404);
      test.info().annotations.push({ type: "double-encoded-dots", description: label });
      continue;
    }
    expect([404], label).toContain(r.status());
    expect(r.headers()["content-type"], label).toContain("text/plain");
    expect(await r.text(), label).not.toMatch(/<html|<!doctype/i);
    sandboxed(r, label);
  }
  // Encoded and doubled slashes reach the media handler but don't match the raw path: 404, never a second URL (F3).
  for (const path of [`/media%2F${id}-800.webp`, `/media//${id}-800.webp`, `/media/\\${id}-800.webp`, `/%6dedia/${id}-800.webp`, `/media/%${id.charCodeAt(0).toString(16)}${id.slice(1)}-800.webp`]) {
    const r = await request.get(path, { maxRedirects: 0 });
    test.info().annotations.push({ type: "alias", description: `${path.slice(0, 60)} -> ${r.status()}` });
    expect(r.status(), path).toBe(404);
    sandboxed(r, path);
  }
  // Raw request line, so no client rewrites the path before the Worker sees it.
  for (const raw of [`//media/${id}-800.webp`, `/media/${id}-800.webp%00`, `/media/${id}-800.webp%0a`, `/media/${id}-800.webp%20`, `/media/${id}%2d800.webp`, `/media/${id}-800.webp%2f`]) {
    const reply = await new Promise<string>((resolve) => {
      const sock = connect(8790, "localhost", () => sock.write(`GET ${raw} HTTP/1.1\r\nHost: localhost:8790\r\nConnection: close\r\n\r\n`));
      let data = "";
      sock.on("data", (d) => (data += d.toString("latin1").slice(0, 400)));
      sock.on("close", () => resolve(data.split("\r\n")[0]));
      sock.setTimeout(3000, () => {
        resolve(`TIMEOUT after: ${data.split("\r\n")[0]}`);
        sock.destroy();
      });
    });
    test.info().annotations.push({ type: "raw", description: `${raw.slice(-24)} -> ${reply}` });
    expect(reply, raw).toMatch(/ 404 /);
  }
  expect((await request.get(`/media/${id}-0800.webp`)).status(), "leading zeros are not another URL").toBe(404);
});

test("If-None-Match edge cases", async ({ request }) => {
  const { id } = photo;
  const status = async (inm: string, path = `/media/${id}-800.webp`) => (await request.get(path, { headers: { "If-None-Match": inm } })).status();
  expect(await status(`"${id}-800"`)).toBe(304);
  expect(await status(`W/"${id}-800"`)).toBe(304);
  expect(await status(`"x", "${id}-800", "y"`)).toBe(304);
  expect(await status(`"x","${id}-800"`)).toBe(304);
  expect(await status(`"${id}-400"`)).toBe(200);
  expect(await status(`"${id}-800`)).toBe(200);
  expect(await status(`${id}-800`)).toBe(200);
  expect(await status(`""`)).toBe(200);
  expect(await status(`W/`)).toBe(200);
  expect(await status(`,,,`)).toBe(200);
  const star = await status("*");
  test.info().annotations.push({ type: "star", description: `If-None-Match: * -> ${star}` });
  // A tag for a photo that is not there still gets 304 (no D1 read): the name is the content.
  const ghost = `${"c".repeat(64)}-800`;
  const g = await status(`"${ghost}"`, `/media/${ghost}.webp`);
  test.info().annotations.push({ type: "ghost-304", description: `matching tag for a nonexistent photo -> ${g}` });
  // A 404 must not be turned into a 304 by a tag for another name.
  expect(await status(`"${id}-800"`, `/media/${"d".repeat(64)}-800.webp`)).toBe(404);
  // Many tags: no crash.
  expect(await status(Array.from({ length: 2000 }, (_, i) => `"t${i}"`).join(", "))).toBe(200);
});

test("a photo uploaded to bistro is a 404 from a westafrican Worker on the same D1", async ({ request, playwright }) => {
  test.skip(!WEST, "set WESTAFRICAN_URL (scripts/serve-westafrican.sh)");
  const { id } = photo;
  const west = await playwright.request.newContext({ baseURL: WEST });
  for (const w of [400, 800, 1200]) {
    const r = await west.get(`/media/${id}-${w}.webp`);
    expect(r.status(), `west ${w}`).toBe(404);
    sandboxed(r, `west ${w}`);
  }
  expect((await request.get(`/media/${id}-800.webp`)).status()).toBe(200);
  // A West-origin client that knows the ETag gets 304 for a photo it does not hold (no D1 read).
  const nm = await west.get(`/media/${id}-800.webp`, { headers: { "If-None-Match": `"${id}-800"` } });
  test.info().annotations.push({ type: "cross-site-304", description: `west with matching ETag -> ${nm.status()}` });
  await west.dispose();
});

test("no content read: /media works with the content deleted, sets no cookie, and with the settings row gone", async ({ request }) => {
  const { id } = photo;
  const run = (sql: string) => execFileSync("npx", ["wrangler", "d1", "execute", "dagens-menu", "--local", "--config", "d1.local.jsonc", "--persist-to", ".wrangler/state", "--command", sql], { encoding: "utf-8" });
  const before = await request.get("/", { maxRedirects: 0 });
  expect(before.status()).toBe(200);
  try {
    run("DELETE FROM settings WHERE site_id = 'bistro'");
    const page = await request.get("/", { maxRedirects: 0 });
    test.info().annotations.push({ type: "page-with-broken-content", description: String(page.status()) });
    const res = await request.get(`/media/${id}-800.webp`);
    expect(res.status()).toBe(200);
    sandboxed(res, "media with broken content");
    expect((await request.get(`/media/${id}-800.webp`, { headers: { "If-None-Match": `"${id}-800"` } })).status()).toBe(304);
    expect((await request.get(`/media/${"0".repeat(64)}-800.webp`)).status()).toBe(404);
  } finally {
    execFileSync("npm", ["run", "-s", "seed", "--", "--site", "bistro", "--reset"], { encoding: "utf-8" });
  }
});

test("an ICC profile carrying HTML is stored, and served as a sandboxed image, never a page", async ({ page, request }) => {
  await signedInOwner(page);
  const html = "<!doctype html><html><body><script>document.title='pwned';fetch('/admin/')</script><h1>x</h1></body></html>";
  const up = await upload(page, (m) => withHtmlIcc(m, html));
  const res = await request.get(`/media/${up.id}-1200.webp`);
  expect(res.status()).toBe(200);
  const body = Buffer.from(await res.body());
  expect(body.includes(Buffer.from("<script>")), "the HTML really is in the stored bytes").toBe(true);
  expect(res.headers()["content-type"]).toBe("image/webp");
  sandboxed(res, "icc-html");
  // Opened as a document in a real browser: it must not become a page or run the script.
  const doc = await page.context().newPage();
  const errors: string[] = [];
  doc.on("pageerror", (e) => errors.push(e.message));
  await doc.goto(`${BASE}/media/${up.id}-1200.webp`).catch(() => {});
  expect(await doc.title()).not.toBe("pwned");
  expect(await doc.locator("h1").count()).toBe(0);
  expect(errors).toEqual([]);
  await doc.close();
});

