/**
 * Tester (ADR-012 Amendment 1 §3): blob-hex with unusual arrays, and what hex() hands back for
 * a NULL or a wrong column, in workerd against a local D1.
 * Report: ~/Vault/Projects/dagens-menu/tester/2026-10-17-m6-validator-blob-hex.md
 * Tests marked "TESTER FINDING" fail on purpose until the finding is fixed or waived.
 */
import { Buffer } from "node:buffer";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { bytesFromHex, bytesParam } from "../../src/db/blob-hex";

const db = env.DB;
const IMAGE = "c".repeat(64);

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro')"),
    db.prepare("INSERT INTO images (site_id, id, kind, mime) VALUES ('bistro', ?, 'upload', 'image/webp')").bind(IMAGE),
  ]);
});

async function roundTrip(bytes: Uint8Array, width: number) {
  await db
    .prepare("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('bistro', ?, ?, 'image/webp', unhex(?))")
    .bind(IMAGE, width, bytesParam(bytes))
    .run();
  const row = await db
    .prepare("SELECT hex(bytes) AS bytes_hex, length(bytes) AS n FROM image_variants WHERE site_id = 'bistro' AND image_id = ? AND width = ?")
    .bind(IMAGE, width)
    .first<{ bytes_hex: string; n: number }>();
  return { bytes: bytesFromHex(row?.bytes_hex), n: row?.n };
}

const expected = (bytes: Uint8Array) => Uint8Array.from(bytes);

describe("tester: arrays that are not plain Uint8Arrays", () => {
  it("a pooled node:buffer Buffer (a Uint8Array subclass, byteOffset ≠ 0 possible) round-trips exactly", async () => {
    const a = Buffer.from([0, 1, 2, 0, 0xff]);
    const b = Buffer.from([9, 0, 8, 0, 7, 0, 6]); // likely shares a's pool slab
    expect(bytesParam(b)).toBe("09000800070006");
    expect(await roundTrip(b, 1)).toEqual({ bytes: expected(b), n: 7 });
    expect(await roundTrip(a, 2)).toEqual({ bytes: expected(a), n: 5 });
  });

  it("an odd-sized view at an odd offset with NUL at both ends round-trips exactly", async () => {
    const backing = Uint8Array.from({ length: 101 }, (_, i) => (i * 37) & 0xff);
    const view = backing.subarray(3, 3 + 51);
    view[0] = 0;
    view[50] = 0;
    expect(await roundTrip(view, 3)).toEqual({ bytes: expected(view), n: 51 });
  });

  it("a detached buffer throws instead of binding an empty string", () => {
    const ab = new ArrayBuffer(8);
    const view = new Uint8Array(ab);
    ab.transfer();
    expect(view.length).toBe(0);
    expect(() => bytesParam(view)).toThrow(TypeError);
  });

  it("a SharedArrayBuffer-backed array, where available, round-trips exactly", async () => {
    if (typeof SharedArrayBuffer === "undefined") return; // not exposed in this workerd
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([0, 1, 0, 2]);
    expect(await roundTrip(shared, 4)).toEqual({ bytes: Uint8Array.from([0, 1, 0, 2]), n: 4 });
  });

  // TESTER FINDING (Low): bytesParam calls `bytes.toHex()` on the object, so a subclass (or an
  // instance whose prototype was changed) decides what is bound. Calling the intrinsic,
  // `Uint8Array.prototype.toHex.call(bytes)`, would make the helper the only encoder.
  it("a subclass that overrides toHex() cannot change what is bound", () => {
    class Sneaky extends Uint8Array {
      override toHex() {
        return "41";
      }
    }
    const s = new Sneaky([1, 2, 3]);
    expect(bytesParam(s)).toBe("010203");
  });

  it("an object that only pretends to be a Uint8Array is refused", () => {
    const fake = Object.create(Uint8Array.prototype) as Uint8Array;
    expect(() => bytesParam(fake)).toThrow(TypeError);
  });
});

describe("tester: what hex() returns when the value is not the bytes", () => {
  // TESTER FINDING (Low): hex(NULL) is '' in SQLite, not NULL, so "a NULL fails here" in the
  // helper's comment is not true. A LEFT JOIN that finds no variant (M6.8) decodes to zero
  // bytes, and /media would serve an empty image instead of failing. A stored variant can
  // never be empty (CHECK length(bytes) BETWEEN 1 AND …), so '' is never a real answer.
  // WAIVED by the Lead (2026-10-17): ADR-012 Amendment 1 §3 specifies that '' decodes to zero
  // bytes. The helper's comment now says so, and that a LEFT JOIN must check the row exists.
  // Refusing '' instead is a question for Kwabena; this test documents today's behaviour.
  it.fails("hex(NULL) from a LEFT JOIN with no variant is refused, not decoded to zero bytes", async () => {
    const row = await db
      .prepare("SELECT i.mime, hex(v.bytes) AS bytes_hex FROM images i LEFT JOIN image_variants v ON v.site_id = i.site_id AND v.image_id = i.id AND v.width = 800 WHERE i.id = ?")
      .bind(IMAGE)
      .first<{ mime: string; bytes_hex: unknown }>();
    expect(row?.bytes_hex).toBe(""); // what SQLite gives
    expect(() => bytesFromHex(row?.bytes_hex)).toThrow(TypeError);
  });

  it("hex() of a text column decodes silently (documented as a limit: the helper cannot know the column)", async () => {
    const row = await db.prepare("SELECT hex(mime) AS h FROM images WHERE id = ?").bind(IMAGE).first<{ h: string }>();
    expect(new TextDecoder().decode(bytesFromHex(row?.h))).toBe("image/webp");
  });

  it.each([
    ["a String object", new String("00")],
    ["a trailing newline", "00\n"],
    ["a leading space", " 00"],
    ["full-width digits", "００"],
    ["an array of hex strings", ["00"]],
  ])("bytesFromHex refuses %s", (_, value) => {
    expect(() => bytesFromHex(value)).toThrow(TypeError);
  });

  it("the cap: 1,000,000 bytes is 2,000,000 hex characters, within D1's documented string limit", () => {
    const hex = bytesParam(new Uint8Array(1_000_000));
    expect(hex.length).toBe(2_000_000);
    expect(bytesFromHex(hex).length).toBe(1_000_000);
  });
});
