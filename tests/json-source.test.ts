import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonContentSource } from "../src/content/json-source";

const now = new Date("2026-10-16T10:00:00Z");
let dir: string;
const menuPath = () => join(dir, "bistro", "content", "menu.json");
const setFirstPrice = (price: number) => {
  const menu = JSON.parse(readFileSync(menuPath(), "utf-8"));
  menu.categories[0].items[0].price = price;
  writeFileSync(menuPath(), JSON.stringify(menu));
};
const firstPrice = async (source: JsonContentSource) =>
  (await source.load({ now })).content.menu.categories[0].items[0].price;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dagens-menu-"));
  cpSync(resolve(import.meta.dirname, "..", "sites", "bistro"), join(dir, "bistro"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("JsonContentSource", () => {
  it("re-reads files on every load when not caching, as in astro dev", async () => {
    const source = new JsonContentSource("bistro", { sitesDir: dir, cache: false });
    const before = await source.load({ now });
    setFirstPrice(9900);
    const after = await source.load({ now });
    expect(after.content.menu.categories[0].items[0].price).toBe(9900);
    expect(after.version).not.toBe(before.version);
  });

  it("keeps the first result when caching, as in a build", async () => {
    const source = new JsonContentSource("bistro", { sitesDir: dir, cache: true });
    const first = await firstPrice(source);
    setFirstPrice(first + 100);
    expect(await firstPrice(source)).toBe(first);
  });

  it("reports which file is not valid JSON", async () => {
    writeFileSync(menuPath(), '{"categories": [');
    const source = new JsonContentSource("bistro", { sitesDir: dir, cache: false });
    await expect(source.load({ now })).rejects.toThrow(/menu\.json is not valid JSON/);
  });

  it("lists every schema issue with its path", async () => {
    setFirstPrice(-1);
    const source = new JsonContentSource("bistro", { sitesDir: dir, cache: false });
    await expect(source.load({ now })).rejects.toThrow(/menu\.categories\.0\.items\.0\.price: must not be negative/);
  });

  it("is never stale and versions by content", async () => {
    const a = await new JsonContentSource("bistro", { sitesDir: dir }).load({ now });
    const b = await new JsonContentSource("bistro", { sitesDir: dir }).load({ now });
    expect(a.stale).toBe(false);
    expect(a.version).toBe(b.version);
  });
});
