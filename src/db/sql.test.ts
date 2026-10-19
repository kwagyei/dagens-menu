import { describe, expect, it } from "vitest";
import { newId } from "./ids";
import { renderSql, sqlLiteral, stmt } from "./sql";

describe("sqlLiteral", () => {
  it.each<[Parameters<typeof sqlLiteral>[0], string]>([
    [null, "NULL"],
    [14500, "14500"],
    ["Bistro", "'Bistro'"],
    ["Chef's table", "'Chef''s table'"],
    ["'); DROP TABLE sites; --", "'''); DROP TABLE sites; --'"],
    ["Rödbetscarpaccio — 145 kr", "'Rödbetscarpaccio — 145 kr'"],
    [new Uint8Array([0, 15, 255]), "X'000fff'"],
  ])("%j → %s", (value, literal) => {
    expect(sqlLiteral(value)).toBe(literal);
  });

  it("refuses non-finite numbers", () => {
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });
});

describe("renderSql", () => {
  it("binds parameters in order and terminates statements", () => {
    expect(renderSql([stmt("INSERT INTO t (a, b) VALUES (?, ?)", "x", 1), stmt("DELETE FROM t")])).toBe("INSERT INTO t (a, b) VALUES ('x', 1);\nDELETE FROM t;");
  });

  it("does not treat a ? inside a parameter as a placeholder", () => {
    expect(renderSql([stmt("UPDATE t SET a = ?, b = ?", "Vad?", 2)])).toBe("UPDATE t SET a = 'Vad?', b = 2;");
  });

  it("rejects a parameter count that doesn't match", () => {
    expect(() => renderSql([stmt("SELECT ?", 1, 2)])).toThrow(/Too many/);
    expect(() => renderSql([stmt("SELECT ?, ?", 1)])).toThrow(/Too few/);
  });
});

describe("newId", () => {
  it("is 12 characters of [a-z0-9] and practically unique", () => {
    const ids = Array.from({ length: 2000 }, newId);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{12}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
