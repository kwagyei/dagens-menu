/**
 * Adding a device takes a confirmation with an existing passkey first (security review M2).
 * Tests that only need the registration options get them through here: the signed-in
 * passkey (or, for a legacy session, any of the person's passkeys) confirms.
 */
import { expect } from "vitest";
import { addPasskeyConfirm, addPasskeyOptions, type ApiResult, type CeremonyContext } from "../../src/auth/passkeys";
import type { Session } from "../../src/auth/sessions";
import { SoftAuthenticator } from "./soft-authenticator";

export const cookieValue = (setCookie: string) => setCookie.split(";")[0].split("=").slice(1).join("=");

/** Steps 1 and 2: the registration options, after a confirmation by one of `session`'s passkeys. */
export async function confirmedAddOptions(ctx: (challengeCookie?: string) => CeremonyContext, session: Session, origin: string, rpID: string): Promise<ApiResult> {
  const first = await addPasskeyOptions(ctx(), session);
  const confirm = first.body.confirm as { challenge: string; allowCredentials?: Array<{ id: string }> };
  const ids = [session.passkeyId, ...(confirm.allowCredentials ?? []).map((c) => c.id)];
  const auth = ids.map((id) => (id ? SoftAuthenticator.registered.get(id) : undefined)).find(Boolean);
  if (!auth) throw new Error("no software authenticator holds a passkey of this person");
  const confirmed = await addPasskeyConfirm(ctx(cookieValue(first.cookies[0])), session, await auth.assert(confirm.challenge, origin, rpID));
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  return confirmed;
}
