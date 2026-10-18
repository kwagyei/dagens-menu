/**
 * A software WebAuthn authenticator for workerd tests: ES256 keys, "none" attestation and a
 * minimal CBOR encoder, so the real ceremony functions can be driven end to end (registering,
 * signing in, replaying) without a browser. Written for tests/db/passkey-ceremony-attacks.test.ts.
 */
import { base64url, fromBase64url } from "../../src/auth/crypto";

// ---------------------------------------------------------------------------------------
// A minimal CBOR encoder and a software ES256 authenticator ("none" attestation).

const enc = new TextEncoder();
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 256) return Uint8Array.of((major << 5) | 24, n);
  return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
}
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const b = enc.encode(value);
    return concat(cborHead(3, b.length), b);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  const parts: Uint8Array[] = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return concat(...parts);
}
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(b)));

/** Raw r||s to DER, which WebAuthn uses for ES256 signatures. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export class SoftAuthenticator {
  credentialId = crypto.getRandomValues(new Uint8Array(16));
  counter: number;
  userHandle = "";
  private keys!: CryptoKeyPair;
  /** false acts like a security key with no PIN or biometric: user present (UP), never verified (UV). */
  verified = true;
  constructor(counter = 0) {
    this.counter = counter;
  }
  get id() {
    return base64url(this.credentialId);
  }

  async register(options: { challenge: string; user: { id: string } }, origin: string, rpID: string) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    this.userHandle = options.user.id;
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64url(jwk.x!)],
        [-3, fromBase64url(jwk.y!)],
      ]),
    );
    const authData = concat(
      await sha256(enc.encode(rpID)),
      Uint8Array.of(this.verified ? 0x45 : 0x41), // UP, UV (if verified), AT
      u32(this.counter),
      new Uint8Array(16),
      Uint8Array.of(0, this.credentialId.length),
      this.credentialId,
      cose,
    );
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: base64url(clientData), attestationObject: base64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {},
    };
  }

  async assert(challenge: string, origin: string, rpID: string, opts: { counter?: number; userHandle?: string } = {}) {
    if (opts.counter !== undefined) this.counter = opts.counter;
    else if (this.counter > 0) this.counter++;
    const authData = concat(await sha256(enc.encode(rpID)), Uint8Array.of(this.verified ? 0x05 : 0x01), u32(this.counter)); // UP, UV (if verified)
    const clientData = enc.encode(JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, concat(authData, await sha256(clientData))),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: base64url(clientData),
        authenticatorData: base64url(authData),
        signature: base64url(derSignature(raw)),
        userHandle: opts.userHandle ?? this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}
