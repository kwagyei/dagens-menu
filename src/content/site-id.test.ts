import { describe, expect, it } from "vitest";
import { checkSiteId, SiteIdError } from "./site-id";

describe("checkSiteId", () => {
  it("returns the id when the Worker serves the site it was built for", () => {
    expect(checkSiteId("bistro", "bistro")).toBe("bistro");
  });

  it("refuses a missing SITE_ID rather than guessing", () => {
    expect(() => checkSiteId(undefined, "bistro")).toThrow(SiteIdError);
    expect(() => checkSiteId("", "bistro")).toThrow(/SITE_ID is not set/);
  });

  it("refuses another site's id, naming both", () => {
    expect(() => checkSiteId("westafrican", "bistro")).toThrow(/"westafrican".*"bistro"/);
  });
});
