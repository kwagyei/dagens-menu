/**
 * Validates every demo site's content against the content schema (src/content/schema.ts).
 *
 * Owners can save content that breaks the templates: an empty English translation, a close
 * time of "25:00", an allergen spelled wrong. These tests run in CI on every change. The
 * rules themselves live in the schema, which the admin's save path will also use (ADR-011);
 * tests/schema-parity.test.ts proves each rule rejects a bad value.
 */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { siteContentSchema } from "../src/content/schema";
import { readSiteJson } from "./site-fixtures";

const root = resolve(import.meta.dirname, "..");
const sites = readdirSync(resolve(root, "sites"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

/** Every string value that looks like a site image path, e.g. "/images/bistro/hero.jpg". */
function imagePaths(value: unknown): string[] {
  if (typeof value === "string") return value.startsWith("/images/") ? [value] : [];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(imagePaths);
}

it("finds the demo sites", () => {
  expect(sites).toEqual(expect.arrayContaining(["bistro", "westafrican"]));
});

describe.each(sites)("%s", (site) => {
  const content = readSiteJson(site);

  it("matches the content schema", () => {
    const result = siteContentSchema(site).safeParse(content);
    const issues = result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(issues).toEqual([]);
  });

  it("references only images that exist on disk", () => {
    const missing = imagePaths(content).filter((p) => !existsSync(resolve(root, "public", p.slice(1))));
    expect(missing).toEqual([]);
  });
});
