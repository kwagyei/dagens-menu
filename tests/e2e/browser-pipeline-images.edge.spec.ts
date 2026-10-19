/**
 * Tester, M6.7 (2026-10-17): the browser pipeline's edge cases, in Chromium and WebKit.
 * - correctness: EXIF orientations 1–8, alpha, CMYK, 16-bit, greyscale, extreme aspects, the
 *   320/319 px edge, the 2400 px height limit; every stored file passes the server's own check and
 *   carries no chunk but the image (and ALPH/VP8X when the encoder writes them)
 * - the 1 MB cap: a photo that only fits at q60, and one that fails even then (nothing is sent)
 * - behaviour: double click, a file changed mid-encode, no file, progress in sv and en, the button
 *   after a refusal, Back after an upload
 * - security: no CSP violation, every request same-origin, the multipart body carries nothing of
 *   the original, no inline script
 *
 * In the edge project (Chromium). For WebKit, run it with a config that adds an iPhone project.
 */
import { randomBytes } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { chromium, expect, type Page, type Request, test } from "@playwright/test";
import { inspectWebp } from "../../src/server/upload-validate";
import { signedInOwner } from "./helpers";

const ORIGIN = "http://localhost:8790";
const NEW = "/admin/photos/new/";

async function signIn(page: Page, browserName: string) {
  if (browserName !== "webkit") return signedInOwner(page);
  const helper = await chromium.launch();
  const other = await helper.newPage({ baseURL: ORIGIN });
  await signedInOwner(other);
  const cookies = await other.context().cookies();
  await helper.close();
  const header = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  // Sent once, as a header (a route that set it again was redundant). These specs run on macOS:
  // Linux's WebKit build answers as signed out however the cookie is sent (see e2e-edge.yml).
  await page.context().setExtraHTTPHeaders({ cookie: header });
}

/** A unique small patch so no two fixtures encode to the same bytes (the server dedupes). */
const uniq = async () => {
  const [r, g, b] = [...randomBytes(3)];
  return sharp({ create: { width: 12, height: 12, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
};

/** Upright 800 × 600: red top-left, green top-right, blue bottom-left, white elsewhere. */
async function uprightQuadrants(): Promise<Buffer> {
  const block = (r: number, g: number, b: number) =>
    sharp({ create: { width: 200, height: 150, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();
  return sharp({ create: { width: 800, height: 600, channels: 3, background: "#ffffff" } })
    .composite([
      { input: await block(230, 20, 20), left: 0, top: 0 },
      { input: await block(20, 200, 20), left: 600, top: 0 },
      { input: await block(20, 20, 230), left: 0, top: 450 },
      { input: await uniq(), left: 397, top: 297 },
    ])
    .png()
    .toBuffer();
}

/** Stored pixels plus EXIF orientation `o` such that a viewer that honours EXIF shows `upright`. */
async function withOrientation(upright: Buffer, o: number): Promise<Buffer> {
  // Try each of the eight pixel layouts; keep the one sharp's own auto-orient turns upright.
  const candidates: ((s: Sharp) => Sharp)[] = [
    (s) => s,
    (s) => s.flop(),
    (s) => s.flip(),
    (s) => s.rotate(180),
    (s) => s.rotate(90),
    (s) => s.rotate(270),
    (s) => s.rotate(90).flop(),
    (s) => s.rotate(270).flop(),
  ];
  for (const op of candidates) {
    const stored = await sharp(await op(sharp(upright)).png().toBuffer())
      .png()
      .toBuffer();
    const jpeg = await sharp(stored).withMetadata({ orientation: o }).jpeg({ quality: 92 }).toBuffer();
    const check = await sharp(jpeg).rotate().raw().toBuffer({ resolveWithObject: true });
    if (check.info.width !== 800 || check.info.height !== 600) continue;
    const px = (x: number, y: number) => [...check.data.subarray((y * 800 + x) * 3, (y * 800 + x) * 3 + 3)];
    if (px(50, 50)[0] > 150 && px(750, 50)[1] > 150 && px(50, 550)[2] > 150) {
      expect((await sharp(jpeg).metadata()).orientation, `fixture ${o}`).toBe(o);
      return jpeg;
    }
  }
  throw new Error(`no fixture for orientation ${o}`);
}

async function libraryRefs(page: Page): Promise<string[]> {
  const exported = await (await page.request.get("/admin/export")).json();
  return exported.content.images.map((i: { ref: string }) => i.ref).filter((r: string) => /^[0-9a-f]{64}$/.test(r));
}

type Watch = { posts: Request[]; requests: string[]; csp: string[]; progress: () => Promise<string[]> };
async function watch(page: Page): Promise<Watch> {
  const w: Watch = { posts: [], requests: [], csp: [], progress: async () => page.evaluate(() => JSON.parse(sessionStorage.getItem("__progress") ?? "[]") as string[]) };
  page.on("request", (r) => {
    w.requests.push(r.url());
    if (r.method() === "POST") w.posts.push(r);
  });
  page.on("console", (m) => /Content Security Policy|Refused to/i.test(m.text()) && w.csp.push(m.text()));
  await page.addInitScript(() => {
    const store = window as unknown as { __csp: string[] };
    store.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => store.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    new MutationObserver(() => {
      const t = document.querySelector("#photo-progress")?.textContent;
      const seen = JSON.parse(sessionStorage.getItem("__progress") ?? "[]") as string[];
      if (t && seen.at(-1) !== t) sessionStorage.setItem("__progress", JSON.stringify([...seen, t]));
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  return w;
}
const cspEvents = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp ?? []);

async function fill(page: Page, sv = "En bild", en = "A picture") {
  await page.locator("#alt_sv").fill(sv);
  await page.locator("#alt_en").fill(en);
}

/** Upload `buffer` through the page; resolve to the new library id, or null with the progress text. */
async function upload(page: Page, buffer: Buffer, name = "photo.jpg", mimeType = "image/jpeg", path = NEW): Promise<{ id: string | null; progress: string }> {
  const before = new Set(await libraryRefs(page));
  await page.goto(path);
  await expect(page.locator("#photo")).toBeEnabled();
  await page.locator("#photo").setInputFiles({ name, mimeType, buffer });
  await fill(page);
  await page.locator("form#photo-upload button[type=submit]").click();
  const outcome = await Promise.race([
    page.waitForURL(/done=(added|duplicate)/, { timeout: 60_000 }).then(() => "nav"),
    expect(page.locator("form#photo-upload button[type=submit]"))
      .toBeEnabled({ timeout: 60_000 })
      .then(async () => {
        await page.waitForTimeout(300);
        return page.url().includes("done=") ? "nav" : "refused";
      }),
  ]);
  const progress =
    (await page
      .locator("#photo-progress")
      .textContent()
      .catch(() => "")) ?? "";
  if (outcome !== "nav") return { id: null, progress };
  expect(page.url(), "a new photo, not a duplicate").toContain("done=added");
  const id = (await libraryRefs(page)).find((r) => !before.has(r)) ?? null;
  return { id, progress };
}

const LADDER = [400, 800, 1200, 1600];
/** Every stored size: passes the server's check, has only image chunks, and its widths. */
async function stored(page: Page, id: string, extra: number[] = []) {
  const out: { width: number; height: number; bytes: Buffer; chunks: string[]; alpha: boolean }[] = [];
  for (const w of [...new Set([...LADDER, ...extra])].sort((x, y) => x - y)) {
    const res = await page.request.get(`/media/${id}-${w}.webp`);
    if (res.status() !== 200) continue;
    const bytes = Buffer.from(await res.body());
    const info = inspectWebp(new Uint8Array(bytes));
    expect(info.ok, `server check, size ${w}: ${JSON.stringify(info)}`).toBe(true);
    const chunks: string[] = [];
    for (let at = 12; at + 8 <= bytes.length;) {
      chunks.push(bytes.toString("latin1", at, at + 4));
      const size = bytes.readUInt32LE(at + 4);
      at += 8 + size + (size % 2);
    }
    for (const c of chunks) expect(["VP8 ", "VP8L", "VP8X", "ALPH"], `size ${w} chunk ${c}`).toContain(c);
    if (info.ok) out.push({ width: info.width, height: info.height, bytes, chunks, alpha: info.hasAlpha });
  }
  return out;
}

test.describe.configure({ timeout: 180_000 });

test("EXIF orientations 1–8 all come out upright", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const w = await watch(page);
  const failures: string[] = [];
  for (let o = 1; o <= 8; o++) {
    const jpeg = await withOrientation(await uprightQuadrants(), o);
    const { id, progress } = await upload(page, jpeg, `IMG_000${o}.jpg`);
    if (!id) {
      failures.push(`orientation ${o}: not added (${progress})`);
      continue;
    }
    const files = await stored(page, id);
    const master = files.at(-1)!;
    if (master.width !== 800 || master.height !== 600) failures.push(`orientation ${o}: master ${master.width}×${master.height}`);
    const raw = await sharp(master.bytes).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => [...raw.data.subarray((y * raw.info.width + x) * raw.info.channels, (y * raw.info.width + x) * raw.info.channels + 3)];
    const [tl, tr, bl] = [px(50, 50), px(750, 50), px(50, 550)];
    if (!(tl[0] > 150 && tl[2] < 100 && tr[1] > 150 && tr[0] < 100 && bl[2] > 150 && bl[0] < 100)) failures.push(`orientation ${o}: corners tl ${tl} tr ${tr} bl ${bl}`);
  }
  expect(failures).toEqual([]);
  expect([...w.csp, ...(await cspEvents(page))], "no CSP violation").toEqual([]);
});

test("odd sources: alpha PNG, CMYK JPEG, 16-bit PNG, greyscale, ICC profile", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const base = () =>
    sharp({ create: { width: 900, height: 700, channels: 3, background: { r: 200, g: 120, b: 40 } } })
      .png()
      .toBuffer();
  const results: Record<string, unknown> = {};

  // Alpha: a transparent canvas with an opaque red square in the middle.
  const red = await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 220, g: 0, b: 0, alpha: 1 } } })
    .png()
    .toBuffer();
  const alphaPng = await sharp({ create: { width: 900, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: red, left: 300, top: 200 },
      { input: await uniq(), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  const a = await upload(page, alphaPng, "alpha.png", "image/png");
  expect(a.id, `alpha: ${a.progress}`).toBeTruthy();
  const af = await stored(page, a.id!);
  const corner = await sharp(af.at(-1)!.bytes).ensureAlpha().extract({ left: 100, top: 600, width: 1, height: 1 }).raw().toBuffer();
  results.alpha = { chunks: af.at(-1)!.chunks, hasAlpha: af.at(-1)!.alpha, transparentCornerRGBA: [...corner] };

  const cmyk = await sharp(await base())
    .composite([{ input: await uniq(), left: 0, top: 0 }])
    .toColourspace("cmyk")
    .jpeg({ quality: 90 })
    .toBuffer();
  expect((await sharp(cmyk).metadata()).space).toBe("cmyk");
  const c = await upload(page, cmyk, "cmyk.jpg");
  results.cmyk = c.id
    ? (
        await sharp((await stored(page, c.id)).at(-1)!.bytes)
          .extract({ left: 450, top: 350, width: 1, height: 1 })
          .raw()
          .toBuffer()
      ).toJSON().data
    : c.progress;

  const png16 = await sharp(await base())
    .composite([{ input: await uniq(), left: 0, top: 0 }])
    .toColourspace("rgb16")
    .png()
    .toBuffer();
  expect((await sharp(png16).metadata()).depth).toBe("ushort");
  const p = await upload(page, png16, "deep.png", "image/png");
  results.png16 = p.id ? (await stored(page, p.id)).map((f) => f.width) : p.progress;

  const grey = await sharp(await base())
    .composite([{ input: await uniq(), left: 0, top: 0 }])
    .toColourspace("b-w")
    .jpeg()
    .toBuffer();
  expect((await sharp(grey).metadata()).channels).toBe(1);
  const g = await upload(page, grey, "grey.jpg");
  results.grey = g.id ? (await stored(page, g.id)).map((f) => f.width) : g.progress;

  const icc = await sharp(await base())
    .composite([{ input: await uniq(), left: 0, top: 0 }])
    .withIccProfile("p3")
    .jpeg()
    .toBuffer();
  expect((await sharp(icc).metadata()).icc, "fixture carries an ICC profile").toBeTruthy();
  const i = await upload(page, icc, "p3.jpg");
  expect(i.id, `icc: ${i.progress}`).toBeTruthy();
  results.icc = (await stored(page, i.id!)).at(-1)!.chunks;

  console.log("odd sources:", JSON.stringify(results));
  expect(typeof results.cmyk, `CMYK added: ${results.cmyk}`).not.toBe("string");
  expect(typeof results.png16, `16-bit added: ${results.png16}`).not.toBe("string");
  expect(typeof results.grey, `grey added: ${results.grey}`).not.toBe("string");
});

test("extreme shapes and the edges of the size rules", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const img = async (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 90, g: 140, b: 60 } } })
      .composite([{ input: await uniq(), left: 0, top: 0 }])
      .jpeg()
      .toBuffer();
  const cases: [string, number, number, number[] | string][] = [
    ["very wide", 6000, 300, [400, 800, 1200, 1600]],
    ["very tall", 400, 3000, [320]],
    ["exactly 320", 320, 500, [320]],
    ["fits only after the 2400 limit", 1000, 4000, [400, 600]],
    ["snap 1242 × 2208", 1242, 2208, [400, 800, 1200]],
  ];
  const got: Record<string, unknown> = {};
  for (const [name, w, h, want] of cases) {
    const r = await upload(page, await img(w, h), `${name}.jpg`);
    got[name] = r.id ? (await stored(page, r.id, want as number[])).map((f) => f.width) : r.progress;
    expect(got[name], name).toEqual(want);
  }
  // Refused up front, in the page's language, with the button usable again.
  const narrow = await upload(page, await img(319, 400), "narrow.jpg");
  expect(narrow).toEqual({ id: null, progress: "Fotot är för smalt. Det behöver vara minst 320 pixlar brett efter att det anpassats." });
  const tallNarrow = await upload(page, await img(600, 5000), "tall-narrow.jpg", "image/jpeg", `/en${NEW}`);
  expect(tallNarrow.progress).toBe("The photo is too narrow. It needs to be at least 320 pixels wide once fitted.");
  await expect(page.locator("form#photo-upload button[type=submit]")).toBeEnabled();
});

test("a photo that only fits at q60 is added under 1 MB; one too large even at q60 says so and sends nothing", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const noisy = async (sigma: number) =>
    sharp(
      await sharp({ create: { width: 1600, height: 2400, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma } } })
        .png()
        .toBuffer(),
    )
      .composite([{ input: await uniq(), left: 0, top: 0 }])
      .png()
      .toBuffer();
  const sizesAt = async (src: Buffer, q: number) => {
    let total = 0;
    for (const w of LADDER) total += (await sharp(src).resize({ width: w }).webp({ quality: q, effort: 4 }).toBuffer()).length;
    return total;
  };
  const w = await watch(page);

  const mid = await noisy(14);
  const [q75, q60] = [await sizesAt(mid, 75), await sizesAt(mid, 60)];
  console.log(`sharp estimate for sigma 14: q75 ${q75}, q60 ${q60}`);
  expect(q75, "fixture needs the retry (sharp's estimate)").toBeGreaterThan(1_000_000);
  const r = await upload(page, mid, "noisy.png", "image/png");
  expect(r.id, `needs q60: ${r.progress}`).toBeTruthy();
  const files = await stored(page, r.id!);
  const total = files.reduce((s, f) => s + f.bytes.length, 0);
  console.log(`stored total ${total}, master ${files.at(-1)!.bytes.length}`);
  expect(total).toBeLessThanOrEqual(1_000_000);
  expect(files.map((f) => f.width)).toEqual(LADDER);

  const postsBefore = w.posts.length;
  const huge = await upload(page, await noisy(60), "huge.png", "image/png");
  expect(huge).toEqual({ id: null, progress: "Fotot är för stort, även efter att det krympts. Välj ett annat foto." });
  expect(w.posts.length - postsBefore, "nothing sent").toBe(0);
  await expect(page.locator("form#photo-upload button[type=submit]")).toBeEnabled();
});

test("progress line in Swedish and English", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const w = await watch(page);
  const photo = async () => withOrientation(await uprightQuadrants(), 1);
  await upload(page, await photo());
  const sv = await w.progress();
  await upload(page, await photo(), "en.jpg", "image/jpeg", `/en${NEW}`);
  const en = await w.progress();
  console.log("progress:", JSON.stringify({ sv, en }));
  expect(sv).toEqual(expect.arrayContaining(["Öppnar fotot…", "Förbereder fotot (1 av 2)…", "Förbereder fotot (2 av 2)…", "Skickar fotot…"]));
  expect(en).toEqual(expect.arrayContaining(["Opening the photo…", "Preparing the photo (1 of 2)…", "Preparing the photo (2 of 2)…", "Sending the photo…"]));
});

test("double click sends one upload", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const w = await watch(page);
  const before = new Set(await libraryRefs(page));
  await page.goto(NEW);
  await expect(page.locator("#photo")).toBeEnabled();
  await page.locator("#photo").setInputFiles({ name: "d.jpg", mimeType: "image/jpeg", buffer: await withOrientation(await uprightQuadrants(), 1) });
  await fill(page);
  await page.locator("form#photo-upload button[type=submit]").dblclick();
  await page.waitForURL(/done=/, { timeout: 60_000 });
  expect(page.url()).toContain("done=added");
  expect(w.posts.filter((p) => p.url().includes("/admin/photos/new")).length).toBe(1);
  expect((await libraryRefs(page)).filter((r) => !before.has(r)).length).toBe(1);
});

test("changing the file while it is being prepared uploads the file now chosen, or nothing", async ({ page, browserName }) => {
  await signIn(page, browserName);
  // A slow first photo (big noisy PNG) and a plain second one.
  const slow = await sharp(
    await sharp({ create: { width: 6000, height: 4000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 10 } } })
      .png()
      .toBuffer(),
  )
    .composite([{ input: await uniq(), left: 0, top: 0 }])
    .jpeg()
    .toBuffer();
  const second = await withOrientation(await uprightQuadrants(), 1); // 800 × 600
  const before = new Set(await libraryRefs(page));
  await page.goto(NEW);
  await expect(page.locator("#photo")).toBeEnabled();
  await page.locator("#photo").setInputFiles({ name: "first.jpg", mimeType: "image/jpeg", buffer: slow });
  await fill(page);
  await page.locator("form#photo-upload button[type=submit]").click();
  await expect(page.locator("#photo-progress")).toHaveText(/Öppnar|Förbereder/);
  const pickerDisabled = await page.locator("#photo").isDisabled();
  if (!pickerDisabled) await page.locator("#photo").setInputFiles({ name: "second.jpg", mimeType: "image/jpeg", buffer: second });
  await page.waitForURL(/done=/, { timeout: 60_000 }).catch(() => undefined);
  const added = (await libraryRefs(page)).filter((r) => !before.has(r));
  const widths = added.length ? (await stored(page, added[0])).map((f) => f.width) : [];
  console.log(
    "mid-encode change:",
    JSON.stringify({
      pickerDisabled,
      added: added.length,
      widths,
      picker: await page
        .locator("#photo")
        .evaluate((i: HTMLInputElement) => i.files?.[0]?.name)
        .catch(() => "navigated"),
    }),
  );
  // The owner now sees "second.jpg" chosen; a 1600 px first photo stored under the alt they typed is the wrong photo.
  expect(pickerDisabled || added.length === 0 || widths.at(-1) === 800, "the stored photo is the one now chosen").toBe(true);
});

test("submitting with no file: the page asks for a photo, and nothing is sent (F3)", async ({ page, browserName }) => {
  await signIn(page, browserName);
  await page.goto(NEW);
  await expect(page.locator("#photo")).toBeEnabled();
  await fill(page);
  const posts: string[] = [];
  page.on("request", (r) => r.method() === "POST" && posts.push(r.url()));
  await page.locator("form#photo-upload button[type=submit]").click();
  await expect(page.locator("#photo-progress")).toHaveText("Välj ett foto först.");
  expect(posts).toEqual([]);
  await expect(page.locator("#alt_sv")).toHaveValue("En bild");
});

test("Back after an upload gives a working form; Forward returns to the result", async ({ page, browserName }) => {
  await signIn(page, browserName);
  await upload(page, await withOrientation(await uprightQuadrants(), 1));
  expect(page.url()).toContain("done=added");
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${NEW}$`));
  const state = {
    button: await page.locator("form#photo-upload button[type=submit]").isEnabled(),
    picker: await page.locator("#photo").isEnabled(),
    progress: await page.locator("#photo-progress").textContent(),
    variants: await page.locator("#photo-variants").evaluate((i: HTMLInputElement) => i.files?.length ?? 0),
  };
  console.log("after Back:", JSON.stringify(state));
  expect(state.button && state.picker, "form usable after Back").toBe(true);
  // A second upload from the restored page must work.
  await page.locator("#photo").setInputFiles({ name: "again.jpg", mimeType: "image/jpeg", buffer: await withOrientation(await uprightQuadrants(), 1) });
  await fill(page);
  await page.locator("form#photo-upload button[type=submit]").click();
  await page.waitForURL(/done=added/, { timeout: 60_000 });
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(/done=added/);
});

test("security: one origin, a clean multipart body, no CSP violation, no inline script", async ({ page, browserName }) => {
  await signIn(page, browserName);
  const w = await watch(page);
  let body: Buffer | null = null;
  let contentType = "";
  await page.route(`${ORIGIN}${NEW}`, async (route) => {
    if (route.request().method() === "POST") {
      body = route.request().postDataBuffer();
      contentType = route.request().headers()["content-type"] ?? "";
    }
    await route.fallback();
  });
  const gpsPhoto = await sharp(await withOrientation(await uprightQuadrants(), 6))
    .withMetadata({ orientation: 6, exif: { IFD0: { Make: "TesterPhone", Model: "SECRET-MODEL" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "59/1 19/1 0/1" } } })
    .jpeg()
    .toBuffer();
  const { id } = await upload(page, gpsPhoto, "IMG_SECRET_NAME.jpg");
  expect(id).toBeTruthy();

  expect(body, "the POST body was captured").not.toBeNull();
  const text = (body as unknown as Buffer).toString("latin1");
  const boundary = contentType.split("boundary=")[1];
  const parts = text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((p) => /Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i.exec(p)?.slice(1));
  console.log("parts:", JSON.stringify(parts));
  expect(parts.map((p) => p?.[0]).sort()).toEqual(["alt_en", "alt_sv", "csrf", "variant", "variant"].sort());
  for (const needle of ["IMG_SECRET_NAME", "SECRET-MODEL", "TesterPhone", "Exif", "GPS", "\xff\xd8\xff", "ICC_PROFILE"])
    expect(text.includes(needle), `body contains ${JSON.stringify(needle)}`).toBe(false);
  expect(body!.length).toBeLessThan(1_000_000 + 64 * 1024);

  const foreign = w.requests.filter((u) => !u.startsWith(ORIGIN) && !u.startsWith("blob:") && !u.startsWith("data:"));
  expect(foreign, "every request same-origin").toEqual([]);
  const wasm = w.requests.filter((u) => u.endsWith(".wasm"));
  console.log("wasm:", JSON.stringify(wasm));
  expect(wasm.length).toBeGreaterThan(0);
  expect(wasm.every((u) => u.startsWith(`${ORIGIN}/`))).toBe(true);
  expect([...w.csp, ...(await cspEvents(page))], "no CSP violation").toEqual([]);

  await page.goto(NEW);
  const inline = await page.locator("script:not([src])").evaluateAll((s) => s.map((e) => (e as HTMLScriptElement).type + ":" + e.textContent!.slice(0, 80)));
  expect(
    inline.filter((s) => !s.startsWith("application/ld+json")),
    "no inline script",
  ).toEqual([]);
  const res = await page.request.get(NEW);
  const csp = res.headers()["content-security-policy"];
  console.log("CSP:", csp);
  expect(csp).toContain("'wasm-unsafe-eval'");
  expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'[^;]*script/);
});

test("after Back, submitting without choosing a file does not resend the previous photo", async ({ page, browserName }) => {
  // WebKit restores the picker and the hidden variant input on Back; pageshow now clears them (F6).
  await signIn(page, browserName);
  const first = await upload(page, await withOrientation(await uprightQuadrants(), 1));
  expect(first.id).toBeTruthy();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${NEW}$`));
  const restored = {
    picker: await page.locator("#photo").evaluate((i: HTMLInputElement) => i.files?.length ?? 0),
    variants: await page.locator("#photo-variants").evaluate((i: HTMLInputElement) => i.files?.length ?? 0),
  };
  console.log("restored after Back:", JSON.stringify(restored));
  // The owner deletes nothing, types new descriptions and presses the button without picking a photo.
  await fill(page, "Helt ny beskrivning", "Brand new description");
  let posted = "";
  page.on("request", (r) => r.method() === "POST" && (posted = r.postDataBuffer()?.toString("latin1") ?? ""));
  await page.locator("form#photo-upload button[type=submit]").click();
  // Since F3/F6 the page asks for a photo itself, and the restored inputs were cleared on pageshow.
  await expect(page.locator("#photo-progress")).toHaveText("Välj ett foto först.");
  await page.waitForTimeout(500);
  const variantParts = (posted.match(/name="variant"; filename="[^"]+"/g) ?? []).length;
  expect(posted, "nothing was posted").toBe("");
  expect(variantParts, "no stale variant parts sent").toBe(0);
});
