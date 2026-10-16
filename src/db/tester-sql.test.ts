/**
 * Tester (M2.4): renderSql output goes through `wrangler d1 execute --file`, which is not a
 * plain SQLite reader. Before splitting statements, wrangler 4.151 runs trimSqlQuery():
 *   sql.replace("BEGIN TRANSACTION;", "").replace("COMMIT;", "")   (not quote-aware)
 * and refuses a file in which "BEGIN TRANSACTION" still appears afterwards. SQLite also ends
 * a statement at a NUL byte. Verified end to end against a local D1 with the seed CLI.
 */
import { describe, expect, it } from "vitest";
import { renderSql, sqlLiteral, stmt } from "./sql";

describe("renderSql survives wrangler's file pre-processing", () => {
  it("keeps 'BEGIN TRANSACTION;' and 'COMMIT;' inside content out of reach of wrangler's trimmer", () => {
    const sql = renderSql([stmt("INSERT INTO t (x) VALUES (?)", "Kom in! BEGIN TRANSACTION; COMMIT;")]);
    // If this text appears verbatim, wrangler deletes it from the string literal (silent data
    // change), or rejects the whole seed when it appears twice.
    expect(sql).not.toContain("BEGIN TRANSACTION");
    expect(sql).not.toContain("COMMIT;");
  });

  it("never writes a raw NUL byte (SQLite stops reading the statement there)", () => {
    expect(sqlLiteral("a\u0000b")).not.toContain("\u0000");
  });

  it("does not expand a '?' that arrives inside a parameter", () => {
    expect(renderSql([stmt("SELECT ?, ?", "?", "x")])).toBe("SELECT '?', 'x';");
  });

  it("quotes injection attempts as plain text", () => {
    expect(renderSql([stmt("SELECT ?", "'); DROP TABLE sites; --")])).toBe("SELECT '''); DROP TABLE sites; --';");
  });
});
