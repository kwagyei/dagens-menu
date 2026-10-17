/**
 * The browser pipeline end to end (plan M6.7 AC): a phone-style JPEG goes in through the real
 * upload page; what the server stores is upright, has no EXIF (so no GPS), comes in every size,
 * and the page ran the WebAssembly encoder without a single CSP violation.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { chromium, expect, type Page, test } from "@playwright/test";
import { inspectWebp } from "../../src/server/upload-validate";
import { signedInOwner } from "./helpers";

const NEW = "/admin/photos/new/";

/**
 * Sign in. Passkeys are emulated through Chromium's DevTools protocol, which WebKit lacks, so in
 * WebKit an owner signs in with a Chromium browser and the session cookie is handed over.
 */
async function signIn(page: Page) {
  if (test.info().project.name !== "webkit") return signedInOwner(page);
  const helper = await chromium.launch();
  const other = await helper.newPage({ baseURL: "http://localhost:8790" });
  await signedInOwner(other);
  const cookies = await other.context().cookies();
  await helper.close();
  // WebKit won't store a __Host- cookie for plain http://localhost, so send it with each request.
  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // One way only. Sending it as an extra header and again through a route signed every WebKit
  // spec out on Linux CI (the upload page answered 303 to the sign-in page), never on macOS.
  await page.context().setExtraHTTPHeaders({ cookie: header });
}

/**
 * 1200 × 800 upright, red in the top-left corner and blue elsewhere, stored the way a phone does
 * it: pixels turned a quarter left with EXIF orientation 6 to turn them back, plus a GPS position.
 */
async function phonePhoto(): Promise<Buffer> {
  const upright = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 20, g: 40, b: 200 } } })
    .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 230, g: 20, b: 20 } } }).png().toBuffer(), left: 0, top: 0 }])
    .png()
    .toBuffer();
  return sharp(upright)
    .rotate(-90)
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: "TestPhone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "59/1 19/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "18/1 4/1 0/1" } },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function libraryRefs(page: Page): Promise<string[]> {
  const exported = await (await page.request.get("/admin/export")).json();
  return exported.content.images.map((i: { ref: string }) => i.ref).filter((r: string) => /^[0-9a-f]{64}$/.test(r));
}

test("a phone photo is uploaded upright, in every size, without its EXIF or GPS, and with no CSP violation", async ({ page, request }) => {
  const csp: string[] = [];
  page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && csp.push(m.text()));
  await signIn(page);
  const before = new Set(await libraryRefs(page));
  const jpeg = await phonePhoto();
  expect((await sharp(jpeg).metadata()).orientation, "the fixture really is orientation 6").toBe(6);

  await page.goto(NEW);
  await expect(page.locator("#photo")).toBeEnabled();
  await page.locator("#photo").setInputFiles({ name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: jpeg });
  await page.getByLabel("Beskrivning på svenska").fill("Röd ruta i hörnet av en blå bild");
  await page.getByLabel("Beskrivning på engelska").fill("A red square in the corner of a blue picture");
  await page.getByRole("button", { name: "Ladda upp fotot" }).click();
  await page.waitForURL(/done=added/, { timeout: 30_000 });
  await expect(page.getByRole("status")).toHaveText("Fotot är uppladdat.");

  const id = (await libraryRefs(page)).find((r) => !before.has(r))!;
  expect(id, "a new upload is in the library").toBeTruthy();
  const sizes = [400, 800, 1200];
  for (const width of sizes) expect((await request.get(`/media/${id}-${width}.webp`)).status(), `size ${width}`).toBe(200);
  const master = Buffer.from(await (await request.get(`/media/${id}-1200.webp`)).body());
  expect(createHash("sha256").update(master).digest("hex")).toBe(id);

  const info = inspectWebp(new Uint8Array(master));
  expect(info.ok, "the server's own check: no EXIF or XMP chunk").toBe(true);
  expect(master.includes(Buffer.from("EXIF")) || master.includes(Buffer.from("GPS")), "no metadata bytes at all").toBe(false);
  if (info.ok) expect({ width: info.width, height: info.height }, "upright: landscape again").toEqual({ width: 1200, height: 800 });
  const corner = await sharp(master).extract({ left: 20, top: 20, width: 1, height: 1 }).raw().toBuffer();
  expect(corner[0], "red where the upright photo is red").toBeGreaterThan(150);
  expect(corner[2], "not blue there").toBeLessThan(100);

  expect(csp, "no CSP violations").toEqual([]);
});

test("without alt text nothing is encoded or sent, and the field says why", async ({ page }) => {
  await signIn(page);
  await page.goto(NEW);
  await page.locator("#photo").setInputFiles({ name: "x.jpg", mimeType: "image/jpeg", buffer: await phonePhoto() });
  await page.getByLabel("Beskrivning på engelska").fill("Only English");
  const posts: string[] = [];
  page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
  await page.getByRole("button", { name: "Ladda upp fotot" }).click();
  await expect(page.locator("#alt_sv")).toHaveJSProperty("validationMessage", "Beskriv fotot på båda språken innan du laddar upp det.");
  expect(posts).toEqual([]);
});

test("a file the browser can't open says so, in the page's language", async ({ page }) => {
  await signIn(page);
  await page.goto(`/en${NEW}`);
  await page.locator("#photo").setInputFiles({ name: "broken.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not really a jpeg") });
  await page.getByLabel("Description in Swedish").fill("Trasig");
  await page.getByLabel("Description in English").fill("Broken");
  await page.getByRole("button", { name: "Upload the photo" }).click();
  await expect(page.locator("#photo-progress")).toHaveText("This photo can't be opened in this browser. Save it as JPEG and try again.");
});
