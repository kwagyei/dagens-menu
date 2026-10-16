import { loginOptions } from "../../../auth/passkeys";
import { ceremonyContext, endpoint, jsonResponse } from "../../../admin/context";

export const POST = endpoint(async (context) => jsonResponse(await loginOptions(ceremonyContext(context))));
