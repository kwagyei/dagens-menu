import { loginVerify } from "../../../auth/passkeys";
import { ceremonyContext, endpoint, jsonResponse, readJson } from "../../../admin/context";

export const POST = endpoint(async (context) => {
  const body = await readJson(context.request);
  if (!body?.response) return jsonResponse({ status: 400, body: { error: "bad-request" }, cookies: [] });
  return jsonResponse(await loginVerify(ceremonyContext(context), body.response));
});
