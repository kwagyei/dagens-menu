/**
 * Checks on admin requests before anything else runs (ADR-011 §6, plan M4.4, M4.5):
 *
 * - Cross-site requests: any admin request that can change something (not GET or HEAD) must
 *   carry an Origin header equal to the site's own. Astro's checkOrigin covers form posts;
 *   this also covers JSON fetches, which it skips.
 * - Rate limiting: sign-in, enrolment and every other admin write share a per-site, per-IP
 *   budget. Public pages are never limited.
 * - Forms posted while signed in carry a token tied to the session (formToken), checked by
 *   the page that handles the post.
 */
import { hmac, hmacVerify } from "./crypto";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const changes = (method: string) => method !== "GET" && method !== "HEAD";

/** A response to send instead of handling the request, or null to carry on. */
export async function guardAdminRequest(request: Request, site: string, limiter: RateLimiter | undefined): Promise<Response | null> {
  const url = new URL(request.url);
  if (changes(request.method) && request.headers.get("Origin") !== url.origin) {
    return new Response("Cross-site request refused", { status: 403 });
  }
  const limited = changes(request.method) || url.pathname.includes("/admin/invite/");
  if (limited && limiter) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: `${site}:${ip}` });
    if (!success) return new Response("Too many attempts. Wait a minute and try again.", { status: 429, headers: { "Retry-After": "60" } });
  }
  return null;
}

/** A form token bound to the signed-in session: useless to anyone without that session. */
export const formToken = (secret: string, sessionTokenHash: string) => hmac(secret, `form:${sessionTokenHash}`);

export const checkFormToken = (secret: string, sessionTokenHash: string, token: unknown) =>
  typeof token === "string" ? hmacVerify(secret, `form:${sessionTokenHash}`, token) : Promise.resolve(false);
