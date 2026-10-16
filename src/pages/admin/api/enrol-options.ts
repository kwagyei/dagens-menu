import { enrolOptions } from "../../../auth/passkeys";
import { ceremonyContext, endpoint, jsonResponse, readJson } from "../../../admin/context";

export const POST = endpoint(async (context) => {
  const body = await readJson(context.request);
  if (typeof body?.token !== "string") return jsonResponse({ status: 400, body: { error: "bad-request" }, cookies: [] });
  return jsonResponse(await enrolOptions(ceremonyContext(context), body.token));
});
