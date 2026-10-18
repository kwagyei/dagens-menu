/**
 * Checks on admin requests before anything else runs (ADR-011 §6, plan M4.4, M4.5):
 *
 * - Cross-site requests: any admin request that can change something (not GET or HEAD) must
 *   carry an Origin header equal to the site's own. Astro's checkOrigin covers form posts;
 *   this also covers JSON fetches, which it skips.
 * - Rate limiting: opening invite links and the passkey endpoints (enrolment, sign-in, adding
 *   a device) share a per-site, per-IP budget, as ADR-011 §6 specifies. Ordinary admin
 *   writes are not limited, so an owner can mark a dozen dishes sold out in a minute.
 *   Public pages are never limited. Without the limiter binding these paths fail closed with
 *   a 503 rather than run unlimited (review L2): a config slip must not quietly drop the limit.
 * - Forms posted while signed in carry a token tied to the session (formToken), checked by
 *   the page that handles the post.
 * - Body size: an admin post must say how big it is, and be at most ADMIN_BODY_LIMIT, before
 *   anything reads it (security review L1, 18 Oct). The photo upload page has its own,
 *   larger limit (src/admin/upload.ts).
 */
import { decodedPath, routeClass, securityHeaders } from "../server/http";
import { hmac, hmacVerify } from "./crypto";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const changes = (method: string) => method !== "GET" && method !== "HEAD";

/** A response to send instead of handling the request, or null to carry on. */
const refusal = (status: number, text: string, extra: Record<string, string> = {}) =>
  new Response(text, { status, headers: { ...securityHeaders("admin"), "Content-Type": "text/plain; charset=utf-8", ...extra } });

/** Paths that cost a passkey ceremony or reveal an invite: the rate-limited ones. */
const AUTH_PATH = /^\/(en\/)?admin\/(invite\/|api\/)/;

/**
 * The largest admin post other than a photo upload. The texts page is the biggest form: four
 * long fields at their input limit, each character up to 9 bytes once form-encoded, plus the
 * short ones, comes to about 330 KB.
 */
export const ADMIN_BODY_LIMIT = 512 * 1024;

export async function guardAdminRequest(request: Request, site: string, limiter: RateLimiter | undefined): Promise<Response | null> {
  const url = new URL(request.url);
  if (changes(request.method) && request.headers.get("Origin") !== url.origin) {
    return refusal(403, "Cross-site request refused");
  }
  if (changes(request.method) && routeClass(url.pathname) !== "admin-upload") {
    const length = request.headers.get("Content-Length");
    if (length === null || !/^\d+$/.test(length)) return refusal(411, "Length required");
    if (Number(length) > ADMIN_BODY_LIMIT) return refusal(413, "Too large");
  }
  if (AUTH_PATH.test(decodedPath(url.pathname))) {
    if (!limiter) {
      console.error("admin: the AUTH_LIMITER binding is missing; sign-in and invite links are refused until it is configured.");
      return refusal(503, "Sign-in is not available right now.", { "Retry-After": "60" });
    }
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: `${site}:${ip}` });
    if (!success) return refusal(429, "Too many attempts. Wait a minute and try again.", { "Retry-After": "60" });
  }
  return null;
}

/** A form token bound to the signed-in session: useless to anyone without that session. */
export const formToken = (secret: string, sessionTokenHash: string) => hmac(secret, `form:${sessionTokenHash}`);

export const checkFormToken = (secret: string, sessionTokenHash: string, token: unknown) =>
  typeof token === "string" ? hmacVerify(secret, `form:${sessionTokenHash}`, token) : Promise.resolve(false);
