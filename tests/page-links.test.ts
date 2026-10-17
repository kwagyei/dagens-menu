import { describe, expect, it } from "vitest";
import { pageLinks } from "../src/server/page-links";

const at = (path: string) => new URL(path, "https://dagens-menu-bistro.example.workers.dev");

describe("pageLinks", () => {
  it("makes canonical and both hreflang URLs absolute on the request's origin", () => {
    expect(pageLinks(at("/menu/"), "sv")).toEqual({
      canonical: "https://dagens-menu-bistro.example.workers.dev/menu/",
      sv: "https://dagens-menu-bistro.example.workers.dev/menu/",
      en: "https://dagens-menu-bistro.example.workers.dev/en/menu/",
    });
  });
  it("pairs an English page with its Swedish twin", () => {
    const l = pageLinks(at("/en/menu/"), "en");
    expect(l.canonical).toBe("https://dagens-menu-bistro.example.workers.dev/en/menu/");
    expect(l.sv).toBe("https://dagens-menu-bistro.example.workers.dev/menu/");
    expect(l.en).toBe(l.canonical);
  });
  it("handles both home pages", () => {
    expect(pageLinks(at("/"), "sv")).toMatchObject({ sv: "https://dagens-menu-bistro.example.workers.dev/", en: "https://dagens-menu-bistro.example.workers.dev/en/" });
    expect(pageLinks(at("/en/"), "en")).toMatchObject({ canonical: "https://dagens-menu-bistro.example.workers.dev/en/", sv: "https://dagens-menu-bistro.example.workers.dev/" });
  });
  it("canonicalises the no-trailing-slash form and drops the query string", () => {
    expect(pageLinks(at("/en/menu?x=1"), "en").canonical).toBe("https://dagens-menu-bistro.example.workers.dev/en/menu/");
  });
  it("does not strip a path that merely starts with en", () => {
    expect(pageLinks(at("/entrance/"), "sv").en).toBe("https://dagens-menu-bistro.example.workers.dev/en/entrance/");
  });
});
