/**
 * GitHub OAuth for Decap CMS.
 *
 * Decap opens /auth in a popup; GitHub redirects back to /callback with a code, which is
 * exchanged for a token and handed to the CMS window with postMessage. The token can write
 * to the repository, so:
 *
 * - the scope is fixed here, never taken from the request;
 * - /auth sets a random `state` in a cookie and /callback rejects any mismatch, so a
 *   callback URL cannot be replayed or forged from another site;
 * - the popup only hands the token to a window whose origin is in ALLOWED_ORIGINS.
 *   Answering any origin would let any web page open this worker and collect a token.
 */

export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Comma-separated origins of the sites whose /admin/ may receive a token. */
  ALLOWED_ORIGINS: string;
}

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";

/** The content repo is public, so the token never needs access to private repos. */
export const SCOPE = "public_repo";

const STATE_COOKIE = "decap_oauth_state";
const STATE_MAX_AGE_SECONDS = 600;

export function allowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function html(body: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

const clearStateCookie = `${STATE_COOKIE}=; Path=/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/auth") {
      const state = crypto.randomUUID();
      const authUrl = new URL(GITHUB_AUTHORIZE);
      authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authUrl.searchParams.set("scope", SCOPE);
      authUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
      authUrl.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl.toString(),
          "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/callback; Max-Age=${STATE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === "/callback") {
      const origins = allowedOrigins(env);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const expected = readCookie(request, STATE_COOKIE);
      if (!code || !state || !expected || state !== expected) {
        return html(
          renderMessage("error", "Login could not be verified. Close this window and try again.", origins),
          403,
          { "Set-Cookie": clearStateCookie },
        );
      }

      let data: { access_token?: string; error?: string; error_description?: string };
      try {
        const tokenRes = await fetch(GITHUB_TOKEN, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
          }),
        });
        data = tokenRes.ok ? await tokenRes.json() : { error: `GitHub returned ${tokenRes.status}` };
      } catch {
        data = { error: "Could not reach GitHub" };
      }

      if (data.error || !data.access_token) {
        return html(renderMessage("error", data.error_description || data.error || "Unknown error", origins), 401, {
          "Set-Cookie": clearStateCookie,
        });
      }
      return html(renderMessage("success", data.access_token, origins), 200, { "Set-Cookie": clearStateCookie });
    }

    return new Response("Not found", { status: 404 });
  },
};

/** JSON that is safe inside an inline <script>: no "</script>" or "<!--" breakout. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The popup page. Decap's handshake: the popup announces "authorizing:github" to its
 * opener, the CMS window echoes it back, and the popup replies with the result — but only
 * to an allowed origin, and only once.
 */
export function renderMessage(status: "success" | "error", content: string, origins: string[]): string {
  const message = `authorization:github:${status}:${JSON.stringify({ token: content, provider: "github" })}`;
  return `<!doctype html>
<html><body><script>
(function () {
  var allowed = ${scriptJson(origins)};
  var message = ${scriptJson(message)};
  function onMessage(e) {
    if (e.data !== "authorizing:github" || allowed.indexOf(e.origin) === -1) return;
    window.removeEventListener("message", onMessage, false);
    window.opener.postMessage(message, e.origin);
  }
  if (!window.opener) return;
  window.addEventListener("message", onMessage, false);
  window.opener.postMessage("authorizing:github", "*");
})();
</script></body></html>`;
}
