/**
 * The browser side of the passkey ceremonies. Buttons declare what they do:
 *   <button data-passkey="enrol">, data-passkey="login" or "add".
 * Each asks the server for options, lets the device create or use a passkey, and sends the
 * result back. On success the page moves to data-next; on failure the message from
 * data-cancelled or data-failed is shown in the element named by data-status.
 *
 * The invite page ([data-invite]) carries its token in the URL fragment, which never reaches
 * the server (review L8): this script reads it, checks it, and only then shows the button.
 */
import { startAuthentication, startRegistration, WebAuthnError } from "@simplewebauthn/browser";

type Kind = "enrol" | "login" | "add";

const endpoints: Record<Kind, [string, string]> = {
  enrol: ["/admin/api/enrol-options", "/admin/api/enrol-verify"],
  login: ["/admin/api/login-options", "/admin/api/login-verify"],
  add: ["/admin/api/add-options", "/admin/api/add-verify"],
};

async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? res.status));
  return json;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const fragmentToken = () => window.location.hash.slice(1);

async function run(button: HTMLButtonElement): Promise<void> {
  const kind = button.dataset.passkey as Kind;
  const token = kind === "enrol" ? fragmentToken() : undefined;
  const status = document.getElementById(button.dataset.status ?? "");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = button.dataset.working ?? label;
  if (status) status.textContent = "";
  try {
    const [optionsUrl, verifyUrl] = endpoints[kind];
    const { options } = (await post(optionsUrl, { token })) as { options: never };
    const response = kind === "login" ? await startAuthentication({ optionsJSON: options }) : await startRegistration({ optionsJSON: options });
    await post(verifyUrl, { token, response });
    window.location.assign(button.dataset.next ?? "/admin/");
  } catch (error) {
    const cancelled = error instanceof WebAuthnError ? error.code === "ERROR_CEREMONY_ABORTED" : error instanceof DOMException && error.name === "NotAllowedError";
    if (status) status.textContent = (cancelled ? button.dataset.cancelled : button.dataset.failed) ?? "";
    button.disabled = false;
    button.textContent = label;
  }
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
