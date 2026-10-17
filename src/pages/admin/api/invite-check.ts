import { env } from "cloudflare:workers";
import { checkInvite } from "../../../auth/passkeys";
import { endpoint, jsonResponse, readJson } from "../../../admin/context";

export const POST = endpoint(async (context) => {
  const body = await readJson(context.request);
  if (typeof body?.token !== "string") return jsonResponse({ status: 400, body: { error: "bad-request" }, cookies: [] });
  return jsonResponse(await checkInvite({ db: env.DB, site: env.SITE_ID, now: new Date() }, body.token));
});
