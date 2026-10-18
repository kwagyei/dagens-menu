import type { APIContext } from "astro";
import { env } from "cloudflare:workers";
import { adminSecret, endpoint } from "../../admin/context";
import { checkFormToken } from "../../auth/guard";
import { clearSessionCookie, endSessionStatement } from "../../auth/sessions";
import { prepare } from "../../db/sql";

const safeNext = (next: unknown) => (typeof next === "string" && /^\/(en\/)?admin\/$/.test(next) ? next : "/admin/");

export const POST = endpoint(async (context: APIContext) => {
  const done = (next?: unknown) => new Response(null, { status: 303, headers: { Location: safeNext(next), "Set-Cookie": clearSessionCookie } });
  // Signed out already: nothing to end, so the body isn't read (security review L1).
  const session = context.locals.session;
  if (!session) return done();
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return done();
  }
  if (await checkFormToken(adminSecret(), session.tokenHash, form.get("csrf"))) {
    await env.DB.batch(prepare(env.DB, [endSessionStatement(session.tokenHash)]));
  }
  return done(form.get("next"));
});
