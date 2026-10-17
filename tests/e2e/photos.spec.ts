/**
 * The photo upload endpoint end to end (plan M6.6), posting what the browser pipeline (M6.7)
 * will post: 1–4 WebP sizes made by libwebp (sharp), the alt text and the form token.
 */
import sharp from "sharp";
import { expect, type Page, test } from "@playwright/test";
import { freshIp, signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const PHOTO = "public/images/bistro/kottbullar-hero.jpg";
const NEW = "/admin/photos/new/";

let photoCount = 0;
/** A distinct photo each call (a tinted copy), so uploads aren't deduplicated unless meant to be. */
async function ladder(widths = [400, 800]): Promise<Buffer[]> {
  const tint = { r: 200 + (++photoCount % 50), g: 180, b: 160 };
  return Promise.all(widths.map((width) => sharp(PHOTO).resize({ width }).tint(tint).webp({ quality: 75 }).toBuffer()));
}

async function post(page: Page, parts: Buffer[], fields: Record<string, string> = {}, path = NEW) {
  await page.goto(path);
  const csrf = await page.locator("input[name=csrf]").first().inputValue();
  const form = new FormData();
  form.set("csrf", fields.csrf ?? csrf);
  form.set("alt_sv", fields.alt_sv ?? "Köttbullar med gräddsås och lingon");
  form.set("alt_en", fields.alt_en ?? "Meatballs with cream sauce and lingonberries");
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  return page.request.post(path, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } });
}

test("the upload page allows WebAssembly in its CSP, and no other admin page does", async ({ page }) => {
  await signedInOwner(page);
  const upload = await page.request.get(NEW);
  expect(upload.headers()["content-security-policy"]).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(upload.headers()["cache-control"]).toBe("no-store");
  const menu = await page.request.get("/admin/");
  expect(menu.headers()["content-security-policy"]).toContain("script-src 'self';");
  expect(menu.headers()["content-security-policy"]).not.toContain("wasm-unsafe-eval");
});

test("an upload is stored, counted and in the history; the same photo again says it's already there", async ({ page }) => {
  await signedInOwner(page);
  const parts = await ladder();
  const res = await post(page, parts);
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe(`${NEW}?done=added`);
  await page.goto(`${NEW}?done=added`);
  await expect(page.getByRole("status")).toHaveText("Fotot är uppladdat.");
  await expect(page.locator("#photo-usage")).toContainText(/^\d+ av 60 foton/);

  const again = await post(page, parts, { alt_sv: "Annan text", alt_en: "Other text" });
  expect(again.headers().location).toBe(`${NEW}?done=duplicate`);

  await page.goto("/admin/history/");
  await expect(page.locator("main li", { hasText: "Meatballs with cream sauce and lingonberries" }).first()).toContainText("Foto");
});

test("a JPEG is refused with 422, and the owner's alt text stays in the form", async ({ page }) => {
  await signedInOwner(page);
  const jpeg = await sharp(PHOTO).resize({ width: 400 }).jpeg().toBuffer();
  const res = await post(page, [jpeg], { alt_sv: "Min beskrivning", alt_en: "My description" });
  expect(res.status()).toBe(422);
  const html = await res.text();
  expect(html).toContain("Fotot kunde inte tas emot");
  expect(html).toContain('value="Min beskrivning"');
});

test("a post with no photo (no JavaScript) is 422 with the reason, never stored", async ({ page }) => {
  await signedInOwner(page);
  const res = await post(page, []);
  expect(res.status()).toBe(422);
  expect(await res.text()).toContain("behövs JavaScript");
});

test("a body over the cap is refused with 413 before it is read", async ({ page }) => {
  await signedInOwner(page);
  const big = Buffer.alloc(1_200_000, 1);
  const res = await post(page, [big]);
  // Only the status: the page answers without reading the body, so the local server closes the
  // connection while the client is still sending and the client may lose the page's text. A
  // browser never sends this much (the pipeline caps it first), so that's acceptable.
  expect(res.status()).toBe(413);
});

test("a stale form token is 'the form expired', and a signed-out post goes to sign-in", async ({ page, browser }) => {
  await signedInOwner(page);
  const res = await post(page, await ladder(), { csrf: "not-the-token" });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe(`${NEW}?done=expired`);

  const anon = await browser.newContext({ baseURL: BASE, extraHTTPHeaders: { "CF-Connecting-IP": freshIp() } });
  const out = await anon.request.post(NEW, { multipart: { csrf: "x", alt_sv: "a", alt_en: "a" }, maxRedirects: 0, headers: { Origin: BASE } });
  expect(out.status()).toBe(303);
  expect(out.headers().location).toMatch(/\/admin\/(\?done=expired)?$/);
  await anon.close();
});

test("without JavaScript the picker is disabled and the page says why", async ({ page, browser }) => {
  await signedInOwner(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
  await noJs.addCookies(await page.context().cookies());
  const plain = await noJs.newPage();
  await plain.goto(NEW);
  await expect(plain.locator("#photo")).toBeDisabled();
  // Playwright's text matchers skip <noscript>, which is the point here: check the served page.
  expect(await plain.content()).toMatch(/<noscript>.*För att ladda upp ett foto behövs JavaScript.*<\/noscript>/s);
  await noJs.close();
});
