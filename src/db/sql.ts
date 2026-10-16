/**
 * Statements as plain data, so the same seed and write logic can run through the D1 binding
 * (in the Worker and in tests) or be rendered to a SQL file for `wrangler d1 execute`.
 */
import type { D1Database, D1PreparedStatement } from "./types";

export type SqlValue = string | number | null | Uint8Array;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

export const stmt = (sql: string, ...params: SqlValue[]): Statement => ({ sql, params });

export function prepare(db: D1Database, statements: readonly Statement[]): D1PreparedStatement[] {
  return statements.map((s) => db.prepare(s.sql).bind(...s.params));
}

/** A SQLite literal. Strings are single-quoted with quotes doubled; nothing else is trusted. */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} to SQL`);
    return String(value);
  }
  if (value instanceof Uint8Array) return `X'${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  return `'${value.replace(/'/g, "''")}'`;
}

/** Render statements to a SQL script, binding each "?" in order. */
export function renderSql(statements: readonly Statement[]): string {
  return statements
    .map(({ sql, params }) => {
      let index = 0;
      const rendered = sql.replace(/\?/g, () => {
        if (index >= params.length) throw new Error(`Too few parameters for: ${sql}`);
        return sqlLiteral(params[index++]);
      });
      if (index !== params.length) throw new Error(`Too many parameters for: ${sql}`);
      return `${rendered.trim()};`;
    })
    .join("\n");
}
