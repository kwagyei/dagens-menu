import { addPasskeyConfirm } from "../../../auth/passkeys";
import { ceremonyContext, endpoint, jsonResponse, readJson } from "../../../admin/context";

export const POST = endpoint(async (context) => {
  const session = context.locals.session;
  if (!session) return jsonResponse({ status: 401, body: { error: "signed-out" }, cookies: [] });
  const body = await readJson(context.request);
  if (!body?.response) return jsonResponse({ status: 400, body: { error: "bad-request" }, cookies: [] });
  return jsonResponse(await addPasskeyConfirm(ceremonyContext(context), session, body.response));
});
