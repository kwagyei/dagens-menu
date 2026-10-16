import { describe, expect, it } from "vitest";
import { needsConsent } from "./consent";

const none = { booking: { provider: "none" as const }, mapEmbed: "" };

describe("needsConsent", () => {
  it("is false when nothing third-party loads, including a plain booking link", () => {
    expect(needsConsent(none)).toBe(false);
    expect(needsConsent({ booking: { provider: "link", bookingUrl: "https://book.example.se" }, mapEmbed: "" })).toBe(false);
  });

  it("is true for an embedded booking widget or a map embed", () => {
    expect(needsConsent({ booking: { provider: "embed", embedCode: "<iframe></iframe>" }, mapEmbed: "" })).toBe(true);
    expect(needsConsent({ ...none, mapEmbed: "https://maps.example.se/embed" })).toBe(true);
  });

  it("ignores embed mode with no code", () => {
    expect(needsConsent({ booking: { provider: "embed", embedCode: "  " }, mapEmbed: "" })).toBe(false);
  });
});
