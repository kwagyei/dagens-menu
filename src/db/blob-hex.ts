/**
 * The only code that turns bytes into D1 parameters and D1 results back into bytes
 * (ADR-012 Amendment 1).
 *
 * D1 serializes a bound `Uint8Array` at about 3.6× its size and charges about 55 ms of
 * Worker CPU per MB for it (spike M6.0), so one photo upload alone would exceed the free
 * plan's 10 ms. Bound as hex text, the same bytes cost about 5× less. So:
 *
 *   write   INSERT … VALUES (…, unhex(?), …)   with   bytesParam(bytes)
 *   read    SELECT hex(bytes) AS bytes_hex …    then   bytesFromHex(row.bytes_hex)
 *
 * `unhex()` stores a real BLOB, so the column, its CHECK, `length()` and exports are as
 * before. tests/blob-hygiene.test.ts fails the build if bytes reach `.bind(` anywhere else;
 * the one named exception is the passkey public key in src/auth/passkeys.ts.
 */

/** Hex text for an `unhex(?)` placeholder. Uses the native encoder, not the Node layer. */
export function bytesParam(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytesParam expects a Uint8Array");
  // Through the prototype, so a subclass's own toHex() cannot change what is bound.
  return Uint8Array.prototype.toHex.call(bytes);
}

/**
 * Bytes from a `hex(column)` result. Refuses anything that is not a string of hex digit
 * pairs, so a wrong column fails here with a clear message, not later.
 *
 * Also refuses '': SQLite's hex(NULL) is '', so that is what a LEFT JOIN that found no
 * variant returns. A stored variant is never empty (image_variants' CHECK), so '' always
 * means "nothing found", never zero bytes (decided by Kwabena, 2026-10-17).
 */
export function bytesFromHex(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string") throw new TypeError(`Expected hex text from hex(), got ${value === null ? "null" : typeof value}`);
  if (value === "") throw new TypeError("Expected hex text from hex(), got '' (hex(NULL): no BLOB was found)");
  try {
    return Uint8Array.fromHex(value);
  } catch {
    throw new TypeError(`Expected hex text from hex(), got ${value.length} characters that are not hex digit pairs`);
  }
}
