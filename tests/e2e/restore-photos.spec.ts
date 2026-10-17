/**
 * The M6.4 round trip on the real Worker and CLI: upload a photo, export, reset the site,
 * restore with the seed CLI (which fetches the master from /media), and the photo is back with
 * the same id, alt and master bytes. A changed copy given with --photos is refused.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const NEW = "/admin/photos/new/";
const seed = (...args: string[]) => execFileSync("npm", ["run", "-s", "seed", "--", "--site", "bistro", ...args], { encoding: "utf-8", stdio: "pipe" });

test("upload → export → reset → restore brings the photo back, byte for byte", async ({ page, request }) => {
  await signedInOwner(page);
  const parts = await Promise.all([400, 800].map((width) => sharp("public/images/bistro/toast-skagen-roe.jpg").resize({ width }).modulate({ hue: 91 }).webp({ quality: 75 }).toBuffer()));
  const id = createHash("sha256").update(parts[1]).digest("hex");
  await page.goto(NEW);
  const form = new FormData();
  form.set("csrf", await page.locator("input[name=csrf]").first().inputValue());
  form.set("alt_sv", "Toast skagen med rom, i grönt ljus");
  form.set("alt_en", "Toast Skagen with roe, in green light");
  for (const p of parts) form.append("variant", new Blob([new Uint8Array(p)], { type: "image/webp" }), "v.webp");
  expect((await page.request.post(NEW, { multipart: form, maxRedirects: 0, headers: { Origin: BASE } })).status()).toBe(303);

  await page.goto("/admin/photos/");
  await expect(page.getByRole("link", { name: "Ladda ner i full storlek" }).first()).toBeVisible();

  const exported = await (await page.request.get("/admin/export")).json();
  const listed = exported.content.images.find((i: { ref: string }) => i.ref === id);
  expect(listed).toMatchObject({ variants: [400, 800], master: `${BASE}/media/${id}-800.webp` });
  const file = join(mkdtempSync(join(tmpdir(), "export-")), "bistro.json");
  writeFileSync(file, JSON.stringify(exported));

  // A changed copy in --photos is refused before anything is written.
  const dir = mkdtempSync(join(tmpdir(), "photos-"));
  const changed = Buffer.from(parts[1]);
  changed[changed.length - 20] ^= 0xff;
  writeFileSync(join(dir, `${id}.webp`), changed);
  expect(() => seed("--from", file, "--photos", dir, "--reset")).toThrow(/has been changed/);
  expect((await request.get(`/media/${id}-800.webp`)).status(), "nothing was reset").toBe(200);

  // The real restore: reset, then the master is fetched back from /media while it still exists.
  const out = seed("--from", file, "--reset");
  expect(out).toContain("bringing back");
  const master = await request.get(`/media/${id}-800.webp`);
  expect(master.status()).toBe(200);
  expect(createHash("sha256").update(await master.body()).digest("hex")).toBe(id);
  expect((await request.get(`/media/${id}-400.webp`)).status(), "the smaller size is made again").toBe(200);

  const after = await (await page.request.get("/admin/export")).json();
  expect(after.content.images.find((i: { ref: string }) => i.ref === id)).toMatchObject({ alt: { sv: "Toast skagen med rom, i grönt ljus", en: "Toast Skagen with roe, in green light" } });
});
