/**
 * ci.yml skips the deploy for merges that change only Markdown. That is safe only while no
 * Markdown file feeds the build, so keep it out of the folders the build reads.
 */
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const BUILD_INPUTS = ["src", "sites", "public"];

const markdownUnder = (dir: string): string[] => (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".md")).map((f) => `${dir}/${f}`);

describe("deploy skip for Markdown-only merges", () => {
  it("has no Markdown in the folders the build reads", () => {
    expect(BUILD_INPUTS.flatMap(markdownUnder)).toEqual([]);
  });
});
