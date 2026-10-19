/**
 * Tester (M6.5 / ADR-012 Amendment 1 §3): what the blob hygiene scanner misses, or flags wrongly,
 * in code a realistic M6.6 (upload) or M6.8 (/media) author would write.
 * Report: ~/Vault/Projects/dagens-menu/tester/2026-10-17-m6-validator-blob-hex.md
 *
 * The scanner is not exported, so this loads its exact source from tests/blob-hygiene.test.ts
 * (from `const BYTES` up to `function workerSources`) and compiles it with esbuild. A change to
 * the scanner is picked up here without copying it.
 * Tests marked "TESTER FINDING" fail on purpose until the finding is fixed or waived.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "blob-hygiene.test.ts"), "utf-8");
const start = source.indexOf("const BYTES");
const end = source.indexOf("function workerSources");
if (start < 0 || end < 0) throw new Error("scanner source moved; update the tester extraction");
const js = transformSync(source.slice(start, end), { loader: "ts" }).code;
const blobViolations = new Function(`${js}\nreturn blobViolations;`)() as (src: string) => string[];

const flagged = (src: string) => blobViolations(src).length > 0;

describe("tester: the extracted scanner is the real one", () => {
  it("still flags and passes the author's own examples", () => {
    expect(flagged("db.prepare(sql).bind(id, new Uint8Array(4))")).toBe(true);
    expect(flagged("db.prepare(sql).bind(id, bytesParam(bytes))")).toBe(false);
  });
});

describe("tester: the scanner flags slips it is meant to catch", () => {
  it.each([
    ["a spread of an inline array", "db.prepare(sql).bind(...[id, new Uint8Array(buf)])"],
    ["a template literal SQL reading bytes", "const s = `SELECT width, bytes FROM image_variants WHERE id = ${'?'}`;"],
    // TESTER FINDING (Low): any unhex(?) in the SQL satisfies the write check, wherever it is.
    [
      "an UPSERT setting bytes from a raw parameter",
      'const s = "INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES (?, ?, ?, ?, unhex(?)) ON CONFLICT DO UPDATE SET bytes = ?";',
    ],
    ["a quoted column name", 'const s = `SELECT "bytes" FROM image_variants`;'],
    ["an aliased raw read", 'const s = "SELECT v.bytes FROM image_variants v JOIN images i ON i.id = v.image_id";'],
    ["a request body bound directly", "db.prepare(sql).bind(id, await request.arrayBuffer() as ArrayBuffer)"],
    ["a Blob bound directly", "db.prepare(sql).bind(id, file as Blob)"],
  ])("%s", (_, src) => {
    expect(flagged(src)).toBe(true);
  });
});

describe("tester: false negatives a future author would plausibly write", () => {
  // TESTER FINDING (Medium): SELECT * (or v.*) returns image_variants.bytes as an ArrayBuffer,
  // the exact read path ADR-012 Amendment 1 forbids, without the word "bytes" in the SQL.
  it.each([
    ["SELECT *", 'const s = "SELECT * FROM image_variants WHERE site_id = ? AND image_id = ? AND width = ?";'],
    ["SELECT v.*", 'const s = "SELECT i.mime, v.* FROM images i JOIN image_variants v ON v.image_id = i.id WHERE i.id = ?";'],
    ["RETURNING *", 'const s = "INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES (?, ?, ?, ?, unhex(?)) RETURNING *";'],
  ])("reads every column including bytes: %s", (_, src) => {
    expect(flagged(src)).toBe(true);
  });

  // TESTER FINDING (Medium): the most likely M6.6 slip binds a variable that holds the bytes.
  // The header admits the scanner cannot see through variables, but a variable or property
  // named `bytes` (or `.bytes`) inside .bind( is a cheap, high-signal heuristic.
  it.each([
    ["a bare `bytes` variable", "db.prepare(INSERT_VARIANT).bind(siteId, imageId, width, 'image/webp', bytes)"],
    ["a `.bytes` property", "db.prepare(INSERT_VARIANT).bind(siteId, imageId, v.width, 'image/webp', v.bytes)"],
    ["through stmt()", "stmt(INSERT_VARIANT, siteId, imageId, variant.width, variant.mime, variant.bytes)"],
  ])("binds raw bytes held in %s", (_, src) => {
    expect(flagged(src)).toBe(true);
  });

  // TESTER FINDING (Low): an unbalanced ")" inside a comment ends the argument list early.
  it("a comment with a closing parenthesis inside the .bind( arguments", () => {
    const src = ["db.prepare(sql).bind(", "  id, // 1) the image id", "  new Uint8Array(await part.arrayBuffer()),", ")"].join("\n");
    expect(flagged(src)).toBe(true);
  });

  // TESTER FINDING (Low): an apostrophe in a comment starts a "string literal" that swallows the
  // next statements, so a raw write sitting next to a correct one is judged together with it.
  it("an apostrophe in a comment hides a raw write next to a correct one", () => {
    const src = [
      "// The owner's photo goes in once per width.",
      'const INSERT_RAW = "INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES (?, ?, ?, ?, ?)";',
      'const INSERT_HEX = "INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES (?, ?, ?, ?, unhex(?))";',
      "const COUNT = \"SELECT count(*) FROM images WHERE kind = 'upload'\";",
    ].join("\n");
    expect(flagged(src)).toBe(true);
    // Without the comment the scanner does catch it:
    expect(flagged(src.split("\n").slice(1).join("\n"))).toBe(true);
  });
});

describe("tester: false positives on code that follows the rule", () => {
  // TESTER FINDING (Low): an aliased hex()/length() is the natural form in M6.8's join, and the
  // scanner rejects it (it only strips hex(bytes) without a table prefix). Fails safe, but it
  // pushes the author to work around the rule.
  it.each([
    ["hex(v.bytes) in a join", 'const s = "SELECT i.mime, hex(v.bytes) AS bytes_hex FROM images i JOIN image_variants v ON v.image_id = i.id WHERE i.id = ?";'],
    ["SUM(length(v.bytes)) for the quota", 'const s = "SELECT SUM(length(v.bytes)) AS used FROM image_variants v WHERE v.site_id = ?";'],
  ])("%s", (_, src) => {
    expect(flagged(src)).toBe(false);
  });

  it.each([
    ["HEX() in upper case", 'const s = "SELECT HEX(bytes) AS bytes_hex FROM image_variants WHERE id = ?";'],
    ["a comment that mentions Uint8Array outside any bind", "// bytes are a Uint8Array here\nconst r = db.prepare(sql).bind(id, bytesParam(bytes));"],
    ["bytes_hex in a select list", 'const s = "SELECT width, bytes_hex FROM v_image_variants_hex"; // not the table'],
  ])("%s", (_, src) => {
    expect(flagged(src)).toBe(false);
  });
});
