/**
 * The browser side of the passkey ceremonies. Buttons declare what they do:
 *   <button data-passkey="enrol">, data-passkey="login" or "add".
 * Each asks the server for options, lets the device create or use a passkey, and sends the
 * result back. On success the page moves to data-next; on failure the message from
 * data-cancelled or data-failed is shown in the element named by data-status.
 *
 * "add" is two clicks (security review M2): the first confirms with one of the person's
 * passkeys, the second (the button named by data-create) makes the new one. The second click
 * is the user gesture Safari wants before creating a passkey, and the server issues the
 * registration options only after the confirmation, for 5 minutes.
 *
 * A device that already holds this person's passkey (synced through iCloud Keychain or a
 * Google account) can't create a second one. The page then says so with data-already, and
 * shows the element named by data-signin, instead of a bare "that didn't work".
 *
 * The invite page ([data-invite]) carries its token in the URL fragment, which never reaches
 * the server (review L8): this script reads it, checks it, and only then shows the button.
 */
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";

type Kind = "enrol" | "login" | "add";

const endpoints: Record<Kind, [string, string]> = {
  enrol: ["/admin/api/enrol-options", "/admin/api/enrol-verify"],
  login: ["/admin/api/login-options", "/admin/api/login-verify"],
  add: ["/admin/api/add-options", "/admin/api/add-confirm"],
};

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? res.status));
  return json;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fragmentToken = () => window.location.hash.slice(1);

const isCancelled = (error: unknown) =>
  error instanceof WebAuthnError ? error.code === "ERROR_CEREMONY_ABORTED" : error instanceof DOMException && error.name === "NotAllowedError";
const alreadyHere = (error: unknown) =>
  error instanceof WebAuthnError ? error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" : error instanceof DOMException && error.name === "InvalidStateError";

/** What to tell the person after a failed ceremony, from the button's data-* messages. */
function failureMessage(error: unknown, source: HTMLElement): string {
  if (alreadyHere(error) && source.dataset.already) {
    const signIn = document.getElementById(source.dataset.signin ?? "");
    if (signIn) signIn.hidden = false;
    return source.dataset.already;
  }
  return (isCancelled(error) ? source.dataset.cancelled : source.dataset.failed) ?? "";
}

/** Disable `button` and show its working label while `work` runs; on failure say why and restore it. */
async function busy(button: HTMLButtonElement, status: HTMLElement | null, source: HTMLElement, work: () => Promise<void>): Promise<void> {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = source.dataset.working ?? label;
  if (status) status.textContent = "";
  try {
    await work();
  } catch (error) {
    if (status) status.textContent = failureMessage(error, source);
    button.disabled = false;
    button.textContent = label;
  }
}

async function run(button: HTMLButtonElement): Promise<void> {
  const kind = button.dataset.passkey as Kind;
  const token = kind === "enrol" ? fragmentToken() : undefined;
  const status = document.getElementById(button.dataset.status ?? "");
  const [optionsUrl, verifyUrl] = endpoints[kind];
  await busy(button, status, button, async () => {
    if (kind === "add") return confirmThenOfferCreate(button, status);
    const { options } = (await post(optionsUrl, { token })) as { options: never };
    const response = kind === "login" ? await startAuthentication({ optionsJSON: options }) : await startRegistration({ optionsJSON: options });
    await post(verifyUrl, { token, response });
    window.location.assign(button.dataset.next ?? "/admin/");
  });
}

/** Adding a device, first click: confirm with an existing passkey, then show the create button. */
async function confirmThenOfferCreate(button: HTMLButtonElement, status: HTMLElement | null): Promise<void> {
  const [optionsUrl, confirmUrl] = endpoints.add;
  const { confirm } = (await post(optionsUrl, {})) as { confirm: never };
  const response = await startAuthentication({ optionsJSON: confirm });
  const { options } = (await post(confirmUrl, { response })) as { options: never };
  const create = document.getElementById(button.dataset.create ?? "");
  if (!(create instanceof HTMLButtonElement)) throw new Error("no create button");
  button.hidden = true;
  create.hidden = false;
  if (status) status.textContent = button.dataset.confirmed ?? "";
  create.focus();
  create.onclick = () =>
    void busy(create, status, button, async () => {
      try {
        // No await before this: the click's user activation must reach the passkey prompt.
        const created = await startRegistration({ optionsJSON: options });
        await post("/admin/api/add-verify", { response: created });
      } catch (error) {
        // The 5-minute window closed, or the confirmation was used: start again from step one.
        if (error instanceof Error && /challenge/.test(error.message)) {
          create.hidden = true;
          button.hidden = false;
          button.disabled = false;
        }
        throw error;
      }
      window.location.assign(button.dataset.next ?? "/admin/");
    });
}

// Shown by default for browsers without JavaScript; this script running proves otherwise.
for (const note of document.querySelectorAll<HTMLElement>("[data-needs-js]")) note.hidden = true;

/** Show the invite's button only for a link that is still good; otherwise say why not. */
async function checkInvite(section: HTMLElement): Promise<void> {
  const show = (selector: string) => section.querySelector<HTMLElement>(selector)?.removeAttribute("hidden");
  const token = fragmentToken();
  if (!TOKEN.test(token)) return show("[data-invite-invalid]");
  try {
    const { email } = (await post("/admin/api/invite-check", { token })) as { email?: string };
    const shown = section.querySelector<HTMLElement>("[data-invite-email]");
    if (shown) shown.textContent = email ?? "";
    show("[data-invite-valid]");
    show("button[data-passkey]");
  } catch (error) {
    if (error instanceof Error && error.message === "invite-invalid") return show("[data-invite-invalid]");
    const status = document.getElementById("status");
    if (status) status.textContent = status.dataset.failed ?? "";
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-passkey]")) {
  if (button.dataset.passkey !== "enrol") button.hidden = false;
  button.addEventListener("click", () => void run(button));
}

const invite = document.querySelector<HTMLElement>("[data-invite]");
if (invite) {
  void checkInvite(invite);
  // Opening another invite link in the same tab changes only the fragment, which doesn't
  // load the page again: reload, so the new link is checked from a clean page.
  window.addEventListener("hashchange", () => window.location.reload());
}
