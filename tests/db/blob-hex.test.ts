/**
 * BLOBs to and from D1 as hex (ADR-012 Amendment 1 §3), in workerd against a local D1:
 * byte-exact round trips through `unhex(?)` and `hex()`, the empty case, and invalid input.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { bytesFromHex, bytesParam } from "../../src/db/blob-hex";

const db = env.DB;
const IMAGE = "b".repeat(64);
const UPLOAD_CAP = 1_000_000;

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM sites"),
    db.prepare("INSERT INTO sites (id) VALUES ('bistro')"),
    db.prepare("INSERT INTO images (site_id, id, kind, mime, alt_sv, alt_en) VALUES ('bistro', ?, 'upload', 'image/webp', 'Foto', 'Photo')").bind(IMAGE),
  ]);
});

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  // getRandomValues fills at most 65,536 bytes per call.
  for (let at = 0; at < length; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(length, at + 65536)));
  return bytes;
}

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).toHex();

/** Write through the helper into image_variants, read back through it. */
async function roundTrip(bytes: Uint8Array, width: number) {
  await db
    .prepare("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('bistro', ?, ?, 'image/webp', unhex(?))")
    .bind(IMAGE, width, bytesParam(bytes))
    .run();
  const row = await db
    .prepare("SELECT hex(bytes) AS bytes_hex, length(bytes) AS stored, typeof(bytes) AS type FROM image_variants WHERE site_id = 'bistro' AND image_id = ? AND width = ?")
    .bind(IMAGE, width)
    .first<{ bytes_hex: string; stored: number; type: string }>();
  if (!row) throw new Error("row not found");
  return { bytes: bytesFromHex(row.bytes_hex), stored: row.stored, type: row.type };
}

describe("bytes round-trip through unhex(?) and hex()", () => {
  const withNul = (bytes: Uint8Array<ArrayBuffer>) => {
    bytes[0] = 0;
    bytes[bytes.length >> 1] = 0;
    bytes[bytes.length - 1] = 0;
    return bytes;
  };

  it.each([
    ["1 byte", 1],
    ["3 bytes", 3],
    ["1,023 bytes", 1023],
    ["4,097 bytes", 4097],
    ["300 KB", 300_000],
    ["the upload cap, 1,000,000 bytes", UPLOAD_CAP],
    ["the per-variant CHECK limit, 1 MiB", 1_048_576],
  ])(
    "%s of random data with NUL bytes",
    async (_, length) => {
      const bytes = withNul(randomBytes(length));
      const back = await roundTrip(bytes, 1 + (length % 2000));
      expect(back.type).toBe("blob");
      expect(back.stored).toBe(length); // length() still sees the bytes, so quota sums stay right
      expect(back.bytes).toEqual(bytes);
      expect(await sha256(back.bytes)).toBe(await sha256(bytes));
    },
    30_000,
  ); // local D1 takes several seconds per MiB of hex

  it("all zeros and all 0xff", async () => {
    const zeros = new Uint8Array(4096);
    const ones = new Uint8Array(4097).fill(0xff);
    expect((await roundTrip(zeros, 10)).bytes).toEqual(zeros);
    expect((await roundTrip(ones, 11)).bytes).toEqual(ones);
  });

  it("every byte value", async () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect((await roundTrip(all, 12)).bytes).toEqual(all);
  });

  it("a view into a larger buffer sends only its own bytes", async () => {
    const backing = randomBytes(64);
    const view = backing.subarray(10, 21);
    expect((await roundTrip(view, 13)).bytes).toEqual(view.slice());
  });

  it("the stored BLOB is the same as one bound as raw bytes", async () => {
    const bytes = withNul(randomBytes(1023));
    await roundTrip(bytes, 20);
    // The old path, only to compare what is stored; the helper is the only way in src/.
    await db.prepare("INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES ('bistro', ?, 21, 'image/webp', ?)").bind(IMAGE, bytes).run();
    const same = await db
      .prepare("SELECT (SELECT bytes FROM image_variants WHERE width = 20) = (SELECT bytes FROM image_variants WHERE width = 21) AS same")
      .first<{ same: number }>();
    expect(same?.same).toBe(1);
  });
});

describe("the empty array", () => {
  it("is written as '', but '' is refused on the way back, as it is also hex(NULL)", async () => {
    const row = await db
      .prepare("SELECT hex(unhex(?)) AS h, typeof(unhex(?)) AS t, hex(NULL) AS n")
      .bind(bytesParam(new Uint8Array(0)), "")
      .first<{ h: string; t: string; n: string }>();
    expect(row).toEqual({ h: "", t: "blob", n: "" });
    expect(() => bytesFromHex(row?.h)).toThrow(TypeError);
  });

  it("is refused by image_variants' CHECK", async () => {
    await expect(roundTrip(new Uint8Array(0), 30)).rejects.toThrow(/CHECK/);
  });
});

describe("invalid input", () => {
  it("unhex() turns invalid hex into NULL, which is why the helper checks first", async () => {
    const row = await db.prepare("SELECT unhex('abc') IS NULL AS odd, unhex('zz') IS NULL AS bad").first<{ odd: number; bad: number }>();
    expect(row).toEqual({ odd: 1, bad: 1 });
  });

  it.each([
    ["odd length", "abc"],
    ["a non-hex character", "zz"],
    ["hex with a space", "ab cd"],
    ["a 0x prefix", "0xab"],
  ])("bytesFromHex refuses %s", (_, text) => {
    expect(() => bytesFromHex(text)).toThrow(TypeError);
  });

  it.each([
    ["null (a missing row or column)", null],
    ["undefined", undefined],
    ["a number", 123],
    ["raw bytes (a SELECT without hex())", new Uint8Array([1, 2])],
    ["an ArrayBuffer", new ArrayBuffer(2)],
  ])("bytesFromHex refuses %s", (_, value) => {
    expect(() => bytesFromHex(value)).toThrow(TypeError);
  });

  it("bytesFromHex reads both cases; SQLite's hex() is upper case", async () => {
    expect(bytesFromHex("00aBFf")).toEqual(new Uint8Array([0, 0xab, 0xff]));
    const row = await db
      .prepare("SELECT hex(unhex(?)) AS h")
      .bind(bytesParam(new Uint8Array([0xab, 0xcd])))
      .first<{ h: string }>();
    expect(row?.h).toBe("ABCD");
  });

  it("bytesParam refuses what is not a Uint8Array", () => {
    for (const value of [new ArrayBuffer(2), [1, 2], "0102", new Uint16Array(2), null]) {
      expect(() => bytesParam(value as unknown as Uint8Array)).toThrow(TypeError);
    }
  });
});
