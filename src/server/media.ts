/**
 * Serving owner photos: `/media/<id>-<width>.webp` (plan M6.8; ADR-015 §2 and Amendment 1).
 *
 * One variant is one stored WebP file, sent as is: no transformation, no content load and no
 * content_version read (the middleware sends /media/ here before any of that). Browsers keep a
 * photo for a year, since the URL names its exact bytes. The bytes are read as hex and decoded
 * (blob-hex.ts): a byte read costs most of the free plan's 10 ms of CPU.
 *
 * A stored photo's headers are only checked, never decoded, on upload (ADR-013), so it is
 * served as a sandboxed image of a fixed type: even crafted bytes can't run as a page.
 */
import { bytesFromHex } from "../db/blob-hex";
import type { D1Database } from "../db/types";

const MEDIA = /^\/media\/([0-9a-f]{64})-(\d{1,4})\.webp$/;

/** True for any path under /media/, which belongs to this handler (a bad name there is a 404). */
export const isMediaPath = (pathname: string) => pathname.startsWith("/media/");

/** Headers every /media response carries: a fixed type nothing sniffs, sandboxed, not for other sites. */
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
};

const plain = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

export interface MediaDeps {
  db: D1Database;
  /** The Worker's own site, never taken from the request (ADR-011 answer 7). */
  siteId: string;
  /** How long to wait for D1 before answering 503 (ADR-015: 1.5 s). */
  timeoutMs?: number;
}

export async function handleMedia(request: Request, deps: MediaDeps): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", { Allow: "GET, HEAD" });
  const match = MEDIA.exec(new URL(request.url).pathname);
  if (!match) return plain(404, "Not found");
  const [, id, width] = match;
  const etag = `"${id}-${width}"`;
  const hit = {
    ...BASE_HEADERS,
    "Content-Type": "image/webp",
    "Cache-Control": "public, max-age=31536000, immutable",
    ETag: etag,
  };
  // The name is the content, so a matching ETag needs no database read at all.
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch && ifNoneMatch.split(",").some((tag) => tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: hit });
  }

  const head = request.method === "HEAD";
  const query = deps.db
    .prepare(
      head
        ? "SELECT length(bytes) AS n FROM image_variants WHERE site_id = ? AND image_id = ? AND width = ?"
        : "SELECT hex(bytes) AS h FROM image_variants WHERE site_id = ? AND image_id = ? AND width = ?",
    )
    .bind(deps.siteId, id, Number(width))
    .first<{ n?: number; h?: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.timeoutMs ?? 1500);
  });
  let row: { n?: number; h?: string } | null | "timeout";
  try {
    row = await Promise.race([query, timeout]);
  } catch (error) {
    console.error(`media: D1 failed for ${id}-${width}: ${(error as Error).message}`);
    return plain(503, "Photo temporarily unavailable", { "Retry-After": "5" });
  } finally {
    clearTimeout(timer);
  }
  if (row === "timeout") {
    console.error(`media: D1 timed out for ${id}-${width}`);
    return plain(503, "Photo temporarily unavailable", { "Retry-After": "5" });
  }
  if (!row) return plain(404, "Not found");

  if (head) return new Response(null, { status: 200, headers: { ...hit, "Content-Length": String(row.n) } });
  const bytes = bytesFromHex(row.h);
  return new Response(bytes, { status: 200, headers: { ...hit, "Content-Length": String(bytes.length) } });
}
