/**
 * Small WebCrypto helpers for the admin's auth (ADR-011 §6). WebCrypto works the same in
 * the Worker, in workerd tests and in Node, so this module has no platform imports.
 */

const encoder = new TextEncoder();

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A random token: 32 bytes, base64url. Used for invites and sessions. */
export function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

const hex = (buffer: ArrayBuffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");

/** SHA-256 hex. Tokens are stored only in this form, never as they were issued. */
export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("The signing secret must be at least 32 characters.");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function hmac(secret: string, message: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(message))));
}

/**
 * Constant-time check of an HMAC (crypto.subtle.verify compares in constant time). Only the
 * canonical spelling is accepted: a 32-byte value's last base64url character carries two
 * unused bits, so several spellings decode to the same bytes, and a "tampered" token could
 * still pass (it was the real token in disguise; the 24 Oct nightly caught it in a test).
 */
export async function hmacVerify(secret: string, message: string, signature: string): Promise<boolean> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64url(signature);
  } catch {
    return false;
  }
  if (base64url(bytes) !== signature) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), bytes, encoder.encode(message));
}

/**
 * A signed, expiring value for a cookie: `payload.expiresAt.signature`, where the signature
 * covers the purpose too, so a value signed for one use can't be replayed as another.
 */
export async function sign(secret: string, purpose: string, payload: string, expiresAt: Date): Promise<string> {
  if (/[.\s]/.test(payload)) throw new Error("A signed payload must not contain dots or spaces.");
  const body = `${payload}.${Math.floor(expiresAt.getTime() / 1000)}`;
  return `${body}.${await hmac(secret, `${purpose}:${body}`)}`;
}

/** The payload, if `value` was signed by us for `purpose` and hasn't expired; otherwise null. */
export async function unsign(secret: string, purpose: string, value: string, now: Date): Promise<string | null> {
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [payload, expires, signature] = parts;
  if (!(await hmacVerify(secret, `${purpose}:${payload}.${expires}`, signature))) return null;
  if (!/^\d+$/.test(expires) || Number(expires) * 1000 <= now.getTime()) return null;
  return payload;
}
