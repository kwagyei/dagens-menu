const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A random 12-character id in [a-z0-9], the format of every content id (ADR-011 §5). */
export function newId(): string {
  // 252 is the largest multiple of 36 below 256: rejecting higher bytes avoids modulo bias.
  const out: string[] = [];
  while (out.length < 12) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 252 && out.length < 12) out.push(ALPHABET[byte % 36]);
    }
  }
  return out.join("");
}
