import type { APIContext } from "astro";
import { env } from "cloudflare:workers";
import { adminSecret, endpoint } from "../../admin/context";
import { checkFormToken } from "../../auth/guard";
import { clearSessionCookie, endSessionStatement } from "../../auth/sessions";
import { prepare } from "../../db/sql";

const safeNext = (next: unknown) => (typeof next === "string" && /^\/(en\/)?admin\/$/.test(next) ? next : "/admin/");

export const POST = endpoint(async (context: APIContext) => {
  const form = await context.request.formData();
  const session = context.locals.session;
  if (session && (await checkFormToken(adminSecret(), session.tokenHash, form.get("csrf")))) {
    await env.DB.batch(prepare(env.DB, [endSessionStatement(session.tokenHash)]));
  }
  return new Response(null, { status: 303, headers: { Location: safeNext(form.get("next")), "Set-Cookie": clearSessionCookie } });
});
