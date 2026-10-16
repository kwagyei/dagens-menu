import { addPasskeyOptions } from "../../../auth/passkeys";
import { ceremonyContext, endpoint, jsonResponse } from "../../../admin/context";

export const POST = endpoint(async (context) => {
  const session = context.locals.session;
  if (!session) return jsonResponse({ status: 401, body: { error: "signed-out" }, cookies: [] });
  return jsonResponse(await addPasskeyOptions(ceremonyContext(context), session));
});
