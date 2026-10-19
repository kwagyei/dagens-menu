/**
 * Serving photos at /media/<id>-<width>.webp (plan M6.8 AC; ADR-015 §2): the headers of every
 * response, 304 without touching D1, sites kept apart, the exact bytes, and no content read.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesParam } from "../../src/db/blob-hex";
import type { D1Database } from "../../src/db/types";
import { handleMedia } from "../../src/server/media";

const db = env.DB;
let master: Uint8Array<ArrayBuffer>;
let small: Uint8Array<ArrayBuffer>;
let id: string;
const url = (path: string) => `https://dagens-menu-bistro.example${path}`;
const get = (path: string, init: RequestInit = {}, deps: Partial<Parameters<typeof handleMedia>[1]> = {}) =>
  handleMedia(new Request(url(path), init), { db, siteId: "bistro", ...deps });

/** A D1 stand-in that records every statement and can fail or hang. */
function spy(mode: "pass" | "throw" | "hang" = "pass"): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const wrapped = {
    prepare(query: string) {
      sql.push(query);
      if (mode === "throw") return { bind: () => ({ first: () => Promise.reject(new Error("D1 down")) }) };
      if (mode === "hang") return { bind: () => ({ first: () => new Promise(() => {}) }) };
      return db.prepare(query);
    },
  };
  return { db: wrapped as unknown as D1Database, sql };
}

beforeAll(async () => {
  master = crypto.getRandomValues(new Uint8Array(4096));
  small = crypto.getRandomValues(new Uint8Array(1024));
  id = Uint8Array.prototype.toHex.call(new Uint8Array(await crypto.subtle.digest("SHA-256", master)));
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO sites (id) VALUES ('bistro'), ('westafrican')"),
    db
      .prepare("INSERT INTO images (site_id, id, kind, mime, width, height, byte_size, alt_sv, alt_en) VALUES ('bistro', ?, 'upload', 'image/webp', 800, 600, ?, 'a', 'a')")
      .bind(id, master.length + small.length),
    db.prepare("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('bistro', ?, 400, 'image/webp', unhex(?))").bind(id, bytesParam(small)),
    db.prepare("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('bistro', ?, 800, 'image/webp', unhex(?))").bind(id, bytesParam(master)),
  ]);
});

describe("/media", () => {
  it("200: the exact bytes (the master's SHA-256 is its id), cached for a year, sandboxed", async () => {
    const res = await get(`/media/${id}-800.webp`);
    expect(res.status).toBe(200);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Uint8Array.prototype.toHex.call(new Uint8Array(await crypto.subtle.digest("SHA-256", body)))).toBe(id);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "image/webp",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${id}-800"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "content-length": String(master.length),
    });
  });

  it("serves each width as stored", async () => {
    const res = await get(`/media/${id}-400.webp`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(small);
  });

  it("HEAD: the same headers and length, no body", async () => {
    const res = await get(`/media/${id}-800.webp`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(master.length));
    expect(res.body).toBeNull();
  });

  it("304 for a matching ETag, without asking the database", async () => {
    const s = spy();
    const res = await get(`/media/${id}-800.webp`, { headers: { "If-None-Match": `W/"x", "${id}-800"` } }, { db: s.db });
    expect(res.status).toBe(304);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(s.sql).toEqual([]);
  });

  it("reads one variant row and nothing else: no content, no content_version", async () => {
    const s = spy();
    await get(`/media/${id}-800.webp`, {}, { db: s.db });
    expect(s.sql).toHaveLength(1);
    expect(s.sql[0]).toMatch(/FROM image_variants WHERE site_id = \? AND image_id = \? AND width = \?/);
    expect(s.sql.join(" ")).not.toMatch(/content_version|FROM sites|settings|menu_/);
  });

  it("404 (no-store) for another site's photo, an unknown width or id, and a malformed name", async () => {
    for (const path of [
      `/media/${id}-1200.webp`,
      `/media/${"0".repeat(64)}-800.webp`,
      `/media/${id}-800.jpg`,
      `/media/${id.toUpperCase()}-800.webp`,
      "/media/",
      `/media/${id}-800.webp/x`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    const other = await get(`/media/${id}-800.webp`, {}, { siteId: "westafrican" });
    expect(other.status).toBe(404);
  });

  it("405 for anything but GET and HEAD", async () => {
    const res = await get(`/media/${id}-800.webp`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  it("503 with Retry-After, never cached, when D1 fails or takes too long", async () => {
    for (const mode of ["throw", "hang"] as const) {
      const res = await get(`/media/${id}-800.webp`, {}, { db: spy(mode).db, timeoutMs: 50 });
      expect(res.status, mode).toBe(503);
      expect(res.headers.get("retry-after"), mode).toBe("5");
      expect(res.headers.get("cache-control"), mode).toBe("no-store");
    }
  });
});
