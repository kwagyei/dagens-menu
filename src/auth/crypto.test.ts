import { describe, expect, it } from "vitest";
import { base64url, fromBase64url, hmac, hmacVerify, randomToken, sha256Hex, sign, unsign } from "./crypto";

const SECRET = "s".repeat(32);
const now = new Date("2026-10-16T10:00:00Z");
const in5min = new Date(now.getTime() + 5 * 60_000);

describe("tokens and hashes", () => {
  it("issues 32-byte base64url tokens that don't repeat", () => {
    const tokens = Array.from({ length: 200 }, randomToken);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fromBase64url(t)).toHaveLength(32);
    }
    expect(new Set(tokens).size).toBe(200);
  });

  it("hashes to SHA-256 hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("round-trips base64url", () => {
    const bytes = new Uint8Array([0, 251, 255, 62, 63]);
    expect(fromBase64url(base64url(bytes))).toEqual(bytes);
  });
});

describe("hmac", () => {
  it("verifies its own signature and nothing else", async () => {
    const mac = await hmac(SECRET, "message");
    expect(await hmacVerify(SECRET, "message", mac)).toBe(true);
    expect(await hmacVerify(SECRET, "messagE", mac)).toBe(false);
    expect(await hmacVerify("t".repeat(32), "message", mac)).toBe(false);
    expect(await hmacVerify(SECRET, "message", "not base64!")).toBe(false);
  });

  it("accepts only the canonical spelling: other spellings of the same bytes are refused", async () => {
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    for (let n = 0; n < 40; n++) {
      const sig = await hmac(SECRET, `message ${n}`);
      expect(await hmacVerify(SECRET, `message ${n}`, sig)).toBe(true);
      // Every other last character that decodes to the same 32 bytes.
      const same = [...ALPHABET].map((c) => sig.slice(0, -1) + c).filter((s) => s !== sig && base64url(fromBase64url(s)) === sig);
      expect(same.length, sig).toBeGreaterThan(0);
      for (const alias of same) expect(await hmacVerify(SECRET, `message ${n}`, alias), alias).toBe(false);
    }
  });

  it("refuses a short secret", async () => {
    await expect(hmac("short", "m")).rejects.toThrow(/at least 32/);
  });
});

describe("sign / unsign", () => {
  it("returns the payload while valid", async () => {
    const value = await sign(SECRET, "challenge", "abc123", in5min);
    expect(await unsign(SECRET, "challenge", value, now)).toBe("abc123");
  });

  it("rejects it once expired", async () => {
    const value = await sign(SECRET, "challenge", "abc123", in5min);
    expect(await unsign(SECRET, "challenge", value, new Date(in5min.getTime() + 1000))).toBeNull();
  });

  it("rejects it for another purpose", async () => {
    const value = await sign(SECRET, "registration", "abc123", in5min);
    expect(await unsign(SECRET, "authentication", value, now)).toBeNull();
  });

  it("rejects a tampered payload or expiry", async () => {
    const value = await sign(SECRET, "challenge", "abc123", in5min);
    const [, exp, sig] = value.split(".");
    expect(await unsign(SECRET, "challenge", `abc124.${exp}.${sig}`, now)).toBeNull();
    expect(await unsign(SECRET, "challenge", `abc123.${Number(exp) + 3600}.${sig}`, now)).toBeNull();
    expect(await unsign(SECRET, "challenge", "garbage", now)).toBeNull();
  });
});
