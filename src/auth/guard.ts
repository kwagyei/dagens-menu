/**
 * Checks on admin requests before anything else runs (ADR-011 §6, plan M4.4, M4.5):
 *
 * - Cross-site requests: any admin request that can change something (not GET or HEAD) must
 *   carry an Origin header equal to the site's own. Astro's checkOrigin covers form posts;
 *   this also covers JSON fetches, which it skips.
 * - Rate limiting: opening invite links and the passkey endpoints (enrolment, sign-in, adding
 *   a device) share a per-site, per-IP budget, as ADR-011 §6 specifies. Ordinary admin
 *   writes are not limited, so an owner can mark a dozen dishes sold out in a minute.
 *   Public pages are never limited.
 * - Forms posted while signed in carry a token tied to the session (formToken), checked by
 *   the page that handles the post.
 */
import { decodedPath, securityHeaders } from "../server/http";
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

export async function guardAdminRequest(request: Request, site: string, limiter: RateLimiter | undefined): Promise<Response | null> {
  const url = new URL(request.url);
  if (changes(request.method) && request.headers.get("Origin") !== url.origin) {
    return refusal(403, "Cross-site request refused");
  }
  if (limiter && AUTH_PATH.test(decodedPath(url.pathname))) {
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
