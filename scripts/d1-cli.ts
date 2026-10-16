/**
 * Shared plumbing for the operator CLIs (seed, admin): run statements or a query against
 * the local or remote D1 through wrangler, and fail with one readable line.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderSql, type Statement } from "../src/db/sql";

export const root = resolve(import.meta.dirname, "..");

export function fail(tool: string, message: string): never {
  console.error(`${tool}: ${message}`);
  process.exit(1);
}

export interface D1Target {
  database: string;
  config: string;
  remote: boolean;
}

export function checkTarget(tool: string, target: D1Target): void {
  if (!existsSync(resolve(root, target.config))) fail(tool, `wrangler config ${target.config} not found`);
}

export const targetName = (target: D1Target) => (target.remote ? "remote" : "local");

function wrangler(target: D1Target, args: string[]): string {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", target.database, target.remote ? "--remote" : "--local", "--config", target.config, ...args],
    { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

const stderrOf = (error: unknown) => (error as { stderr?: string }).stderr ?? String(error);

/** Rows from a read-only query. */
export function query<T>(tool: string, target: D1Target, sql: string): T[] {
  try {
    return JSON.parse(wrangler(target, ["--json", "--command", sql]))[0].results as T[];
  } catch (error) {
    fail(tool, `could not query the ${targetName(target)} database (have the migrations been applied?)\n${stderrOf(error)}`);
  }
}

/** Apply statements as one file, which wrangler runs all-or-nothing. */
export function execute(tool: string, target: D1Target, statements: Statement[]): void {
  const dir = mkdtempSync(join(tmpdir(), `${tool}-`));
  const file = join(dir, "statements.sql");
  try {
    writeFileSync(file, renderSql(statements));
    wrangler(target, ["--file", file, "-y"]);
  } catch (error) {
    fail(tool, `wrangler could not apply the change; nothing was changed.\n${stderrOf(error)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
