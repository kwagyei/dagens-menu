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

// Text that wrangler's file runner would mangle before SQLite sees it: it strips
// "BEGIN TRANSACTION;" and "COMMIT;" anywhere in the file, quotes or not, and a NUL ends the
// statement. Such strings are written as hex bytes instead, which nothing can rewrite.
// eslint-disable-next-line no-control-regex -- the NUL byte is exactly what this looks for.
const UNSAFE_IN_FILE = /BEGIN|COMMIT|\u0000/i;

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A SQLite literal. Strings are single-quoted with quotes doubled, or hex-encoded when they
 * contain something a SQL file runner could rewrite; nothing is trusted.
 */
export function sqlLiteral(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot write ${value} to SQL`);
    return String(value);
  }
  if (value instanceof Uint8Array) return `X'${hex(value)}'`;
  if (UNSAFE_IN_FILE.test(value)) return `CAST(X'${hex(new TextEncoder().encode(value))}' AS TEXT)`;
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Render statements to a SQL script, binding each "?" in order. Every "?" in the statement's
 * own SQL is a placeholder, so statement SQL must not contain a literal "?".
 */
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
