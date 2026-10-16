/**
 * The browser side of the passkey ceremonies. Buttons declare what they do:
 *   <button data-passkey="enrol" data-token="…">, data-passkey="login" or "add".
 * Each asks the server for options, lets the device create or use a passkey, and sends the
 * result back. On success the page moves to data-next; on failure the message from
 * data-cancelled or data-failed is shown in the element named by data-status.
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

async function run(button: HTMLButtonElement): Promise<void> {
  const kind = button.dataset.passkey as Kind;
  const token = button.dataset.token;
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

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-passkey]")) {
  button.hidden = false;
  button.addEventListener("click", () => void run(button));
}
