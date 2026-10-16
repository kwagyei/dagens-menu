import { describe, expect, it } from "vitest";
import { ROUTES, thirdPartyRequests, titleOf } from "../scripts/check-no-third-party.mjs";

describe("thirdPartyRequests", () => {
  it("passes a page that loads only its own files", () => {
    const html = `<link rel="stylesheet" href="/_astro/a.css"><script src="/_astro/b.js"></script><img src="/images/bistro/x.jpg" srcset="/a.jpg 1x, /b.jpg 2x"><a href="https://instagram.com/x">IG</a>`;
    expect(thirdPartyRequests(html)).toEqual([]);
  });

  it.each([
    ["an external image", `<img src="https://tracker.example/p.gif">`],
    ["a protocol-relative script", `<script src="//cdn.example/x.js"></script>`],
    ["a Google Fonts stylesheet", `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">`],
    ["an external srcset candidate", `<img src="/a.jpg" srcset="/a.jpg 1x, https://cdn.example/b.jpg 2x">`],
    ["a map iframe", `<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>`],
    ["a CSS @import", `<style>@import "https://fonts.example/x.css";</style>`],
    ["a background url() in a style attribute", `<div style="background:url('https://cdn.example/bg.jpg')"></div>`],
  ])("catches %s", (_name, html) => {
    expect(thirdPartyRequests(html)).toHaveLength(1);
  });

  it("ignores embeds parked in a <template> until consent", () => {
    expect(thirdPartyRequests(`<template><iframe src="https://www.google.com/maps/embed"></iframe></template>`)).toEqual([]);
  });
});

describe("routes and titles", () => {
  it("covers the seven pages in both languages", () => {
    expect(ROUTES).toHaveLength(14);
    expect(ROUTES).toContain("/en/");
    expect(ROUTES).toContain("/en/privacy/");
  });

  it("reads the page title", () => {
    expect(titleOf("<head><title> Meny | Bistro Norden </title></head>")).toBe("Meny | Bistro Norden");
  });
});
