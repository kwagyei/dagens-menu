/**
 * Review M1, 18 Oct (tester, 19 Oct): the "add a device" client logic in
 * src/admin/passkey-client.ts, driven against a minimal fake DOM (no DOM library in the repo).
 * After the device has made a passkey, any refusal of add-verify returns the page to step one;
 * a failed or cancelled create prompt keeps the create button. Also double clicks, a missing
 * data-again, and the add button's label after a return to step one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: webauthn.startAuthentication,
  startRegistration: webauthn.startRegistration,
  WebAuthnError: class WebAuthnError extends Error {
    code = "";
  },
}));

class FakeElement {
  hidden = false;
  textContent = "";
  dataset: Record<string, string> = {};
  constructor(
    public id = "",
    public tag = "p",
  ) {}
  focus() {
    page.focused = this;
  }
  removeAttribute(name: string) {
    if (name === "hidden") this.hidden = false;
  }
}
class FakeButton extends FakeElement {
  disabled = false;
  onclick: (() => void) | null = null;
  private listeners: Array<() => void> = [];
  addEventListener(_type: string, fn: () => void) {
    this.listeners.push(fn);
  }
  /** Like a browser: a disabled or hidden button gets no click. */
  click() {
    if (this.disabled || this.hidden) return;
    for (const fn of this.listeners) fn();
    this.onclick?.();
  }
}

const page = { focused: null as unknown, assigned: [] as string[] };
const AGAIN = "Börja om";
const UNANSWERED = "Ladda om och kolla listan";
const LABEL = "Lägg till en enhet";
const CREATE = "Skapa passkey";

function build(again = true) {
  const add = new FakeButton("", "button");
  add.hidden = true;
  add.textContent = LABEL;
  add.dataset = {
    passkey: "add",
    next: "/admin/security/?done=added",
    status: "add-status",
    create: "add-create",
    confirmed: "Bekräftat",
    already: "Redan här",
    working: "Arbetar…",
    cancelled: "Avbrutet",
    failed: "Det gick inte",
    ...(again ? { again: AGAIN, unanswered: UNANSWERED } : {}),
  };
  const create = new FakeButton("add-create", "button");
  create.hidden = true;
  create.textContent = CREATE;
  const status = new FakeElement("add-status");
  const byId: Record<string, FakeElement> = { "add-create": create, "add-status": status };
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLButtonElement", FakeButton);
  vi.stubGlobal("document", {
    getElementById: (id: string) => byId[id] ?? null,
    querySelectorAll: (sel: string) => (sel === "button[data-passkey]" ? [add] : []),
    querySelector: () => null,
  });
  vi.stubGlobal("window", { location: { hash: "", assign: (url: string) => page.assigned.push(url), reload() {} }, addEventListener() {} });
  return { add, create, status };
}

/** fetch answers by path: a status and a body. */
function server(routes: Record<string, () => { status: number; body: unknown } | Promise<never>>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    const answer = await routes[url]();
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  });
  return calls;
}

const OK = { "/admin/api/add-options": () => ({ status: 200, body: { confirm: {} } }), "/admin/api/add-confirm": () => ({ status: 200, body: { options: {} } }) };
const settle = () => new Promise((r) => setTimeout(r, 0));

async function load(again = true) {
  const dom = build(again);
  vi.resetModules();
  await import("../src/admin/passkey-client");
  return dom;
}

beforeEach(() => {
  page.focused = null;
  page.assigned = [];
  webauthn.startAuthentication.mockReset().mockResolvedValue({ id: "existing" });
  webauthn.startRegistration.mockReset().mockResolvedValue({ id: "new" });
});
afterEach(() => vi.unstubAllGlobals());

describe("step one to step two", () => {
  it("shows the add button, then after confirming hides it and shows and focuses the create button", async () => {
    const { add, create, status } = await load();
    server(OK);
    expect(add.hidden).toBe(false);
    add.click();
    await settle();
    expect([add.hidden, create.hidden, page.focused === create, status.textContent]).toEqual([true, false, true, "Bekräftat"]);
  });

  it("a double click on the add button runs one confirmation", async () => {
    const { add } = await load();
    const calls = server(OK);
    add.click();
    add.click();
    await settle();
    expect(calls.filter((c) => c === "/admin/api/add-options")).toHaveLength(1);
    expect(webauthn.startAuthentication).toHaveBeenCalledTimes(1);
  });
});

describe("the server refuses the new passkey: back to step one", () => {
  it.each([
    ["challenge-expired", 400],
    ["verification-failed", 400],
    ["challenge-used", 401],
    ["already-registered", 409],
    ["a server error", 500],
  ])("%s", async (error, code) => {
    const { add, create, status } = await load();
    server({ ...OK, "/admin/api/add-verify": () => ({ status: code, body: { error } }) });
    add.click();
    await settle();
    create.click();
    await settle();
    expect(create.hidden).toBe(true);
    expect([add.hidden, add.disabled, add.textContent, page.focused === add]).toEqual([false, false, LABEL, true]);
    expect(status.textContent).toBe(AGAIN);
    expect(page.assigned).toEqual([]);
    // The hidden create button is restored for the next round, not left disabled or "working".
    expect([create.disabled, create.textContent]).toEqual([false, CREATE]);
  });

  it("a network failure of add-verify starts again, but says to check the list, not to delete the passkey (review L5)", async () => {
    const { add, create, status } = await load();
    server({ ...OK, "/admin/api/add-verify": () => Promise.reject(new TypeError("Failed to fetch")) });
    add.click();
    await settle();
    create.click();
    await settle();
    expect([add.hidden, create.hidden, status.textContent]).toEqual([false, true, UNANSWERED]);
  });

  it("without data-again it says the generic failure, and is still back at step one", async () => {
    const { add, create, status } = await load(false);
    server({ ...OK, "/admin/api/add-verify": () => ({ status: 400, body: { error: "challenge-expired" } }) });
    add.click();
    await settle();
    create.click();
    await settle();
    expect([add.hidden, add.disabled, add.textContent, create.hidden, status.textContent]).toEqual([false, false, LABEL, true, "Det gick inte"]);
  });

  it("starting again works: a second round shows the working label, then the original label after a cancelled confirmation", async () => {
    const { add, create } = await load();
    server({ ...OK, "/admin/api/add-verify": () => ({ status: 401, body: { error: "challenge-used" } }) });
    add.click();
    await settle();
    create.click();
    await settle();
    webauthn.startAuthentication.mockRejectedValueOnce(new DOMException("closed", "NotAllowedError"));
    add.click();
    expect(add.textContent).toBe("Arbetar…");
    await settle();
    expect([add.hidden, add.disabled, add.textContent]).toEqual([false, false, LABEL]);
    // And a full second round succeeds with the new options.
    add.click();
    await settle();
    expect(create.hidden).toBe(false);
    server({ ...OK, "/admin/api/add-verify": () => ({ status: 200, body: { ok: true } }) });
    create.click();
    await settle();
    expect(page.assigned).toEqual(["/admin/security/?done=added"]);
  });
});

describe("the device's prompt fails: the create button stays", () => {
  it.each([
    ["cancelled", new DOMException("closed", "NotAllowedError"), "Avbrutet"],
    ["already on this device", new DOMException("exists", "InvalidStateError"), "Redan här"],
    ["another error", new Error("boom"), "Det gick inte"],
  ])("%s", async (_, failure, message) => {
    const { add, create, status } = await load();
    const calls = server(OK);
    webauthn.startRegistration.mockRejectedValueOnce(failure);
    add.click();
    await settle();
    create.click();
    await settle();
    expect([create.hidden, create.disabled, create.textContent, add.hidden]).toEqual([false, false, CREATE, true]);
    expect(status.textContent).toBe(message);
    expect(calls).not.toContain("/admin/api/add-verify");
  });

  it("a double click on the create button opens one prompt", async () => {
    const { add, create } = await load();
    server({ ...OK, "/admin/api/add-verify": () => ({ status: 200, body: { ok: true } }) });
    add.click();
    await settle();
    create.click();
    create.click();
    await settle();
    expect(webauthn.startRegistration).toHaveBeenCalledTimes(1);
    expect(page.assigned).toHaveLength(1);
  });
});
