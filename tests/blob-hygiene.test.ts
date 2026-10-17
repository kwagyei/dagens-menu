/**
 * Bytes go to and from D1 as hex, through src/db/blob-hex.ts only (ADR-012 Amendment 1 §3).
 * A byte array bound to D1 costs about 55 ms of Worker CPU per MB (spike M6.0), so one slip
 * puts an upload or a photo request over the free plan's 10 ms.
 *
 * This is a text scan of the Worker code in src/ (tests excluded). It cannot see through a
 * variable or a spread, so it catches the obvious slip, not every one; the upload and /media
 * tests (M6.6, M6.8) add a runtime check on the bound values.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** The helper itself, and the one named exception: passkey public keys of a few hundred bytes. */
const ALLOWED = new Set(["src/db/blob-hex.ts", "src/auth/passkeys.ts"]);

const BYTES = /\bUint8Array\b|\bArrayBuffer\b|\bBuffer\b|\bDataView\b|\.buffer\b|\bBlob\b/;
/** A variable or property named `bytes` (the likely M6.6 slip), but not its length. */
const BYTES_NAME = /\bbytes\b(?!\s*\.\s*(?:length|byteLength)\b)/;

/** The source with comments blanked out and strings kept, so a ")" or "'" in a comment can't mislead the scan. */
function withoutComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === "\\") out += source[++i] ?? "";
      else if (c === quote) quote = null;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close === -1 ? source.length : close + 1;
      out += " ";
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/** The text between the parentheses of each call to `name(`, with nesting and strings respected. */
function callArguments(source: string, name: string): string[] {
  const found: string[] = [];
  for (let start = source.indexOf(name); start !== -1; start = source.indexOf(name, start + 1)) {
    // `stmt(` must be the whole identifier, not the end of another one.
    if (/\w/.test(name[0]) && /[\w$]/.test(source[start - 1] ?? "")) continue;
    let depth = 0;
    let quote: string | null = null;
    let i = start + name.length - 1; // at the "("
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    found.push(source.slice(start + name.length, i));
  }
  return found;
}

const STRING = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;

/** String literals ('…', "…" and template text) in the source. */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(STRING)].map((m) => m[0].slice(1, -1));
}

/** Split a list on its top-level commas. */
function topLevelItems(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      items.push(list.slice(from, i).trim());
      from = i + 1;
    }
  }
  items.push(list.slice(from).trim());
  return items;
}

const UNHEX = /^unhex\(\s*\?\s*\)$/i;
/** Appending a chunk (a restore writes big variants in pieces, M6.4): the new bytes still come through unhex(?). */
const APPEND_UNHEX = /^CAST\(\s*bytes\s*\|\|\s*unhex\(\s*\?\s*\)\s+AS\s+BLOB\s*\)$/i;

/** Whether every place an INSERT or UPDATE sets the bytes column takes them through unhex(?). */
function writesThroughUnhex(sql: string): boolean {
  // INSERT … (columns) VALUES (values): the value in the bytes column's position.
  const insert = /\bimage_variants\s*\(([^)]*)\)\s*VALUES\s*\(/i.exec(sql);
  if (insert) {
    const columns = insert[1].split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase());
    const valuesAt = insert.index + insert[0].length;
    let depth = 1;
    let i = valuesAt;
    for (; i < sql.length && depth > 0; i++) depth += sql[i] === "(" ? 1 : sql[i] === ")" ? -1 : 0;
    const values = topLevelItems(sql.slice(valuesAt, i - 1));
    const at = columns.indexOf("bytes");
    if (at !== -1 && !UNHEX.test(values[at] ?? "")) return false;
  } else if (/\bINSERT\b/i.test(sql) && !/\bunhex\(\s*\?\s*\)/i.test(sql)) {
    return false; // INSERT … SELECT or a form not parsed above: at least ask for unhex(?)
  }
  // UPDATE … SET bytes = …, and an upsert's DO UPDATE SET bytes = …
  for (const m of sql.matchAll(/\bbytes\s*=\s*([^,]+?)(?=\s*(?:,|\bWHERE\b|\bRETURNING\b|$))/gi)) {
    if (!UNHEX.test(m[1].trim()) && !APPEND_UNHEX.test(m[1].trim()) && !/^excluded\.bytes$/i.test(m[1].trim())) return false;
  }
  return true;
}

/** What is wrong with one file's text; empty when it follows the rule. */
function blobViolations(original: string): string[] {
  const source = withoutComments(original);
  const problems: string[] = [];
  // Statements reach D1 through `.bind(…)` directly, or through `stmt(sql, …params)` in
  // src/db/sql.ts, whose parameters are bound later by `prepare()`.
  for (const call of [".bind(", "stmt("]) {
    for (const args of callArguments(source, call)) {
      const code = args.replace(STRING, '""').replace(/\bbytesParam\((?:[^()]|\([^()]*\))*\)/g, "");
      if (BYTES.test(code) || BYTES_NAME.test(code)) problems.push(`bytes passed to ${call}${args.trim().slice(0, 80)})`);
    }
  }
  for (const sql of stringLiterals(source)) {
    if (!/\bimage_variants\b/i.test(sql)) continue;
    // Reading: every mention of the bytes column must be hex(bytes), or length(bytes) for
    // quotas, and no * may pull the column in unseen.
    if (/\b(SELECT|RETURNING)\b/i.test(sql)) {
      const rest = sql.replace(/\b(?:hex|length)\(\s*(?:\w+\.)?"?bytes"?\s*\)|\bimage_variants\s*\([^)]*\)|\bbytes\s*=\s*[^,]+/gi, "");
      if (/\bbytes\b/i.test(rest) || /(?:\bSELECT(?:\s+(?:DISTINCT|ALL))?|\bRETURNING|,)\s*(?:\w+\.)?\*/i.test(sql)) {
        problems.push(`reads image_variants.bytes without hex(): ${sql.trim().slice(0, 80)}`);
      }
    }
    // Writing: an INSERT or UPDATE that sets bytes must take them through unhex(?).
    if (/\b(INSERT|UPDATE)\b/i.test(sql) && /\bbytes\b/i.test(sql) && !writesThroughUnhex(sql)) {
      problems.push(`writes image_variants.bytes without unhex(?): ${sql.trim().slice(0, 80)}`);
    }
  }
  return problems;
}

function workerSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|astro)$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !e.name.endsWith(".d.ts"))
    .map((e) => relative(ROOT, join(e.parentPath, e.name)));
}

describe("the scanner", () => {
  it.each([
    ['db.prepare("INSERT INTO t VALUES (?)").bind(new Uint8Array(4))', "a new array"],
    ['db.prepare(sql).bind(id, file.buffer, width)', "a .buffer"],
    ['db.prepare(sql).bind(id, await part.arrayBuffer() as ArrayBuffer)', "a cast to ArrayBuffer"],
    ['stmt("INSERT INTO t VALUES (?, ?)", id, Buffer.from(bytes))', "a Buffer through stmt()"],
    ['db.prepare(sql).bind(\n  id,\n  new Uint8Array(await blob.arrayBuffer()),\n)', "across lines"],
    ['const s = "SELECT bytes FROM image_variants WHERE id = ?";', "reading bytes raw"],
    ['const s = `SELECT width, bytes, mime FROM image_variants`;', "reading bytes in a list"],
    ['const s = "INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES (?, ?, ?, ?, ?)";', "writing bytes raw"],
    ['const s = "UPDATE image_variants SET bytes = ? WHERE width = ?";', "updating bytes raw"],
    ['const s = "UPDATE image_variants SET bytes = CAST(bytes || ? AS BLOB) WHERE width = ?";', "appending raw bytes"],
  ])("flags %s (%s)", (source) => {
    expect(blobViolations(source)).not.toEqual([]);
  });

  it.each([
    ['db.prepare("SELECT 1 WHERE id = ?").bind(id, siteId)', "plain values"],
    ['db.prepare(sql).bind(id, bytesParam(bytes))', "the helper"],
    ['db.prepare(sql).bind(fn(a, "("), b)', "a parenthesis in a string"],
    ['const s = "SELECT hex(bytes) AS bytes_hex FROM image_variants WHERE id = ?";', "reading through hex()"],
    ['const s = "SELECT SUM(length(bytes)) FROM image_variants";', "a quota sum"],
    ['const s = "INSERT INTO image_variants (site_id, image_id, width, mime, bytes) VALUES (?, ?, ?, ?, unhex(?))";', "writing through unhex(?)"],
    ['const s = "DELETE FROM image_variants WHERE image_id = ?";', "a delete"],
    ['const tables = ["image_variants", "images"];', "a table name alone"],
    ['const bytes = new Uint8Array(4); restmt(x);', "bytes outside any bind"],
  ])("passes %s (%s)", (source) => {
    expect(blobViolations(source)).toEqual([]);
  });
});

describe("Worker code in src/", () => {
  const files = workerSources(join(ROOT, "src"));

  it("is found (so the rule below checks something)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("src/db/blob-hex.ts");
    expect(files).toContain("src/auth/passkeys.ts");
  });

  it("never binds bytes or reads image_variants.bytes except through src/db/blob-hex.ts", () => {
    const offending = files.filter((f) => !ALLOWED.has(f)).flatMap((f) => blobViolations(readFileSync(join(ROOT, f), "utf-8")).map((p) => `${f}: ${p}`));
    expect(offending).toEqual([]);
  });
});
