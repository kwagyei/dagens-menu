/**
 * What the admin endpoints and pages need from the request and the Worker, in one place.
 * A missing SESSION_SECRET means the admin is not configured: refuse rather than sign
 * anything with a guessable key.
 */
import type { AstroGlobal, APIContext } from "astro";
import { env } from "cloudflare:workers";
import type { ApiResult, CeremonyContext } from "../auth/passkeys";
import { CHALLENGE_COOKIE } from "../auth/passkeys";
import { usableSecret } from "../auth/secret";
import { readCookie } from "../auth/sessions";

export class AdminNotConfiguredError extends Error {}

export function adminSecret(): string {
  const secret = env.SESSION_SECRET;
  if (!usableSecret(secret)) throw new AdminNotConfiguredError("SESSION_SECRET is not set (32+ random characters, not the example's placeholder).");
  return secret;
}

export function ceremonyContext(context: APIContext | AstroGlobal): CeremonyContext {
  return {
    db: env.DB,
    site: env.SITE_ID,
    siteName: context.locals.content.settings.name.sv,
    secret: adminSecret(),
    origin: context.url.origin,
    rpID: context.url.hostname,
    now: new Date(),
    challengeCookie: readCookie(context.request.headers.get("Cookie"), CHALLENGE_COOKIE),
  };
}

/** Turn a ceremony result into a JSON response with its cookies. */
export function jsonResponse(result: ApiResult): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  for (const cookie of result.cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(result.body), { status: result.status, headers });
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return null;
  try {
    const body = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Wrap an endpoint so a missing secret answers 503 instead of throwing. */
export function endpoint(handler: (context: APIContext) => Promise<Response>) {
  return async (context: APIContext) => {
    try {
      return await handler(context);
    } catch (error) {
      if (error instanceof AdminNotConfiguredError) {
        console.error(`admin: ${error.message}`);
        return new Response(JSON.stringify({ error: "not-configured" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      throw error;
    }
  };
}
