import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, renderMessage, SCOPE } from "./index";

const ALLOWED = "https://dagens-menu-bistro.pages.dev";
const env: Env = {
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  ALLOWED_ORIGINS: `${ALLOWED}, https://dagens-menu-westafrican.pages.dev`,
};
const BASE = "https://decap-oauth.example.workers.dev";

afterEach(() => vi.unstubAllGlobals());

function stubGitHub(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function startAuth(query = "") {
  const res = await worker.fetch(new Request(`${BASE}/auth${query}`), env);
  const location = new URL(res.headers.get("Location")!);
  const cookie = res.headers.get("Set-Cookie")!.split(";")[0];
  return { res, location, cookie, state: location.searchParams.get("state")! };
}

/** Runs the popup page's script against a fake window and returns what it posted where. */
function runPopup(page: string, replies: Array<{ origin: string; data: unknown }>) {
  const script = page.match(/<script>([\s\S]*)<\/script>/)![1];
  const posted: Array<{ data: string; target: string }> = [];
  type Listener = (e: { origin: string; data: unknown }) => void;
  const handler: { current: Listener | null } = { current: null };
  const window = {
    opener: { postMessage: (data: string, target: string) => posted.push({ data, target }) },
    addEventListener: (_: string, fn: Listener) => (handler.current = fn),
    removeEventListener: () => (handler.current = null),
  };
  runInNewContext(script, { window });
  for (const reply of replies) handler.current?.(reply);
  return posted;
}

describe("/auth", () => {
  it("redirects to GitHub with a fixed scope and a fresh state cookie", async () => {
    const { res, location, cookie, state } = await startAuth("?scope=repo,user,admin:org");
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("scope")).toBe(SCOPE);
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);
    expect(state).toMatch(/^[0-9a-f-]{36}$/);
    expect(cookie).toBe(`decap_oauth_state=${state}`);
    expect(res.headers.get("Set-Cookie")).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it("issues a different state each time", async () => {
    expect((await startAuth()).state).not.toBe((await startAuth()).state);
  });
});

describe("/callback", () => {
  it.each([
    ["no state cookie", (s: string) => ({ query: `?code=c&state=${s}`, cookie: "" })],
    ["a mismatched state", (s: string) => ({ query: `?code=c&state=${s}x`, cookie: `decap_oauth_state=${s}` })],
    ["no state parameter", (s: string) => ({ query: "?code=c", cookie: `decap_oauth_state=${s}` })],
  ])("refuses a callback with %s, without asking GitHub", async (_, make) => {
    const fetchMock = stubGitHub({ access_token: "gho_secret" });
    const { state } = await startAuth();
    const { query, cookie } = make(state);
    const res = await worker.fetch(new Request(`${BASE}/callback${query}`, { headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("gho_secret");
  });

  it("exchanges the code and clears the state cookie", async () => {
    const fetchMock = stubGitHub({ access_token: "gho_secret" });
    const { state, cookie } = await startAuth();
    const res = await worker.fetch(
      new Request(`${BASE}/callback?code=the-code&state=${state}`, { headers: { Cookie: `other=1; ${cookie}` } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/^decap_oauth_state=; .*Max-Age=0/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ code: "the-code", client_secret: "client-secret" });
  });

  it("reports a GitHub error instead of crashing", async () => {
    stubGitHub("<html>bad gateway</html>", 502);
    const { state, cookie } = await startAuth();
    const res = await worker.fetch(new Request(`${BASE}/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("GitHub returned 502");
  });
});

describe("popup page", () => {
  const page = renderMessage("success", "gho_secret", [ALLOWED]);

  it("hands the token to an allowed CMS window", () => {
    const posted = runPopup(page, [{ origin: ALLOWED, data: "authorizing:github" }]);
    expect(posted[0]).toEqual({ data: "authorizing:github", target: "*" });
    expect(posted[1].target).toBe(ALLOWED);
    expect(posted[1].data).toBe('authorization:github:success:{"token":"gho_secret","provider":"github"}');
  });

  it("never hands the token to another origin", () => {
    const posted = runPopup(page, [{ origin: "https://evil.example", data: "authorizing:github" }]);
    expect(posted).toHaveLength(1);
    expect(posted[0].data).not.toContain("gho_secret");
  });

  it("ignores unrelated messages and answers only once", () => {
    const posted = runPopup(page, [
      { origin: ALLOWED, data: "something else" },
      { origin: ALLOWED, data: "authorizing:github" },
      { origin: ALLOWED, data: "authorizing:github" },
    ]);
    expect(posted.filter((p) => p.data.includes("gho_secret"))).toHaveLength(1);
  });

  it("cannot be broken out of with a crafted error message", () => {
    const evil = renderMessage("error", "</script><script>alert(1)</script>", [ALLOWED]);
    expect(evil.match(/<\/script>/g)).toHaveLength(1);
  });
});
