import { describe, expect, it } from "vitest";
import { ogImage } from "../src/server/og-image";

const origin = "https://bistro.example.workers.dev";

describe("ogImage", () => {
  it("picks the 1200-wide size of a curated photo, as an absolute URL", () => {
    expect(ogImage({ ref: "/images/bistro/kottbullar-hero.jpg", width: 1920, height: 1280 }, origin)).toEqual({
      url: `${origin}/images/bistro/v/kottbullar-hero-1200.webp`,
      width: 1200,
      height: 800,
    });
  });
  it("uses the master when the photo is smaller than 1200", () => {
    const og = ogImage({ ref: "/images/bistro/small.jpg", width: 900, height: 600 }, origin)!;
    expect(og).toMatchObject({ width: 900, height: 600 });
    expect(og.url).toBe(`${origin}/images/bistro/v/small-900.webp`);
  });
  it("serves an upload from /media", () => {
    const id = "b".repeat(64);
    expect(ogImage({ ref: id, width: 2000, height: 1000 }, origin)!.url).toBe(`${origin}/media/${id}-1200.webp`);
  });
  it("is null with no photo or no known size, so the tags are left out", () => {
    expect(ogImage(undefined, origin)).toBeNull();
    expect(ogImage({ ref: "/images/bistro/x.jpg" }, origin)).toBeNull();
  });
});
