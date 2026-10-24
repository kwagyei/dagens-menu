/**
 * The canonical-spelling check in hmacVerify (tester, 24 Oct), from
 * the producers' side (every issued token and cookie still verifies) and the attacker's (no
 * other spelling of the same bytes does); fill() edge cases; the 15-digit ENTRY_ID boundary.
 */
import { describe, expect, it } from "vitest";
import { base64url, fromBase64url, hmac, hmacVerify, sign, unsign } from "../src/auth/crypto";
import { checkFormToken, formToken } from "../src/auth/guard";
import { CHALLENGE_COOKIE } from "../src/auth/passkeys";
import { readCookie } from "../src/auth/sessions";
import { fill } from "../src/i18n";
import { ENTRY_ID } from "../src/db/undo";

const SECRET = "s".repeat(32);
const now = new Date("2026-10-24T12:00:00Z");
const in5min = new Date(now.getTime() + 300_000);

describe("every legitimately issued value passes the canonical check", () => {
  it("500 form tokens for random session hashes verify, and are 43 characters of the base64url alphabet", async () => {
    for (let i = 0; i < 500; i++) {
      const sessionHash = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
      const token = await formToken(SECRET, sessionHash);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await checkFormToken(SECRET, sessionHash, token)).toBe(true);
    }
  });

  it("a form token survives a urlencoded form post (URLSearchParams round trip) and a multipart one (FormData)", async () => {
    for (let i = 0; i < 100; i++) {
      const sessionHash = `session-${i}`;
      const token = await formToken(SECRET, sessionHash);
      const posted = new URLSearchParams(new URLSearchParams({ csrf: token }).toString()).get("csrf");
      expect(await checkFormToken(SECRET, sessionHash, posted)).toBe(true);
      const form = new FormData();
      form.set("csrf", token);
      const parsed = await new Request("https://x/", { method: "POST", body: form }).formData();
      expect(await checkFormToken(SECRET, sessionHash, parsed.get("csrf"))).toBe(true);
      // A browser that percent-encodes "-" or "_" anyway: the form parser decodes it back.
      const encoded = `csrf=${token.replace(/-/g, "%2D").replace(/_/g, "%5F")}`;
      expect(await checkFormToken(SECRET, sessionHash, new URLSearchParams(encoded).get("csrf"))).toBe(true);
    }
  });

  it("the challenge cookie: Set-Cookie value -> Cookie header -> readCookie -> unsign, for 300 random challenges", async () => {
    for (let i = 0; i < 300; i++) {
      const challenge = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const value = await sign(SECRET, "login", challenge, in5min);
      // Only cookie-octet characters: nothing a browser or a proxy would quote or re-encode.
      expect(value).toMatch(/^[A-Za-z0-9_.-]+$/);
      const header = `other=1; ${CHALLENGE_COOKIE}=${value}; __Host-dm_session=abc`;
      expect(await unsign(SECRET, "login", readCookie(header, CHALLENGE_COOKIE)!, now)).toBe(challenge);
    }
  });
});

describe("other spellings of a valid MAC are refused", () => {
  it("padding, the standard alphabet, whitespace and percent-encoding", async () => {
    for (let i = 0; i < 50; i++) {
      const mac = await hmac(SECRET, `m${i}`);
      const variants = [
        `${mac}=`,
        `${mac}==`,
        mac.replace(/-/g, "+").replace(/_/g, "/"),
        ` ${mac}`,
        `${mac}\n`,
        `${mac.slice(0, 10)} ${mac.slice(10)}`,
        mac.replace(/-/g, "%2D"),
      ].filter((v) => v !== mac);
      for (const v of variants) expect(await hmacVerify(SECRET, `m${i}`, v), JSON.stringify(v)).toBe(false);
    }
  });

  it("a canonical spelling of the wrong length (truncated or extended) is refused", async () => {
    const mac = await hmac(SECRET, "m");
    expect(await hmacVerify(SECRET, "m", mac.slice(0, -1))).toBe(false);
    expect(await hmacVerify(SECRET, "m", base64url(new Uint8Array([...fromBase64url(mac), 0])))).toBe(false);
    expect(await hmacVerify(SECRET, "m", "")).toBe(false);
  });

  it("unsign refuses a challenge cookie whose signature carries an alias last character", async () => {
    const value = await sign(SECRET, "login", "abc", in5min);
    const sig = value.split(".")[2];
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const aliases = [...ALPHABET].map((c) => sig.slice(0, -1) + c).filter((s) => s !== sig && base64url(fromBase64url(s)) === sig);
    expect(aliases.length).toBeGreaterThan(0);
    for (const alias of aliases) expect(await unsign(SECRET, "login", value.replace(sig, alias), now)).toBeNull();
  });
});

describe("fill", () => {
  it("doesn't re-read a value that itself looks like a placeholder", () => {
    expect(fill("{name} och {photo}", { name: "{photo}", photo: "Bild" })).toBe("{photo} och Bild");
  });

  it("fills every occurrence of a placeholder, not just the first", () => {
    expect(fill("{n} / {n}", { n: 3 })).toBe("3 / 3");
  });

  it("leaves non-letter placeholders such as {0} or {a_b} alone", () => {
    expect(fill("{0} {a_b} {n}", { n: 1 })).toBe("{0} {a_b} 1");
  });
});

describe("ENTRY_ID at 15 digits", () => {
  it("accepts the largest 15-digit id and Number() reads it exactly; refuses 16 digits", () => {
    expect(ENTRY_ID.test("999999999999999")).toBe(true);
    expect(String(Number("999999999999999"))).toBe("999999999999999");
    expect(ENTRY_ID.test("1000000000000000")).toBe(false);
    expect(ENTRY_ID.test("0999")).toBe(false);
  });
});
