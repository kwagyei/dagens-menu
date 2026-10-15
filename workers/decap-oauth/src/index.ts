interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGINS: string;
}

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN = "https://github.com/login/oauth/access_token";

function corsHeaders(origin: string, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    if (url.pathname === "/auth") {
      const scope = url.searchParams.get("scope") || "repo,user";
      const authUrl = new URL(GITHUB_AUTHORIZE);
      authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authUrl.searchParams.set("scope", scope);
      authUrl.searchParams.set(
        "redirect_uri",
        `${url.origin}/callback`
      );
      return Response.redirect(authUrl.toString(), 302);
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return new Response("Missing code parameter", { status: 400 });
      }

      const tokenRes = await fetch(GITHUB_TOKEN, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
        }),
      });

      const data = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };

      if (data.error || !data.access_token) {
        return new Response(
          renderMessage("error", data.error_description || data.error || "Unknown error"),
          { status: 401, headers: { "Content-Type": "text/html;charset=utf-8" } }
        );
      }

      return new Response(
        renderMessage("success", data.access_token),
        { status: 200, headers: { "Content-Type": "text/html;charset=utf-8" } }
      );
    }

    return new Response("Not found", { status: 404 });
  },
};

function renderMessage(status: "success" | "error", content: string): string {
  const data = JSON.stringify({ token: content, provider: "github" });
  const authStatus = status === "success" ? "success" : "error";
  return `<!doctype html>
<html><body><script>
(function() {
  function sendAuth(e) {
    window.opener.postMessage(
      "authorization:github:${authStatus}:" + ${JSON.stringify(data)},
      e.origin
    );
  }
  window.addEventListener("message", sendAuth, false);
  window.opener.postMessage("authorizing:github", "*");
})();
</script></body></html>`;
}
