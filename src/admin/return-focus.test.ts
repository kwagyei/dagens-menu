import { describe, expect, it } from "vitest";
import { type FocusTarget, returnFocus } from "./return-focus";

function target(): FocusTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    focus: (o) => calls.push(`focus preventScroll=${o?.preventScroll}`),
    scrollIntoView: (o) => calls.push(`scroll ${o?.block}`),
  };
}

describe("returnFocus (walkthrough 18 Oct: iPhone Safari ignores autofocus)", () => {
  it("does nothing on a page with no autofocus", () => {
    expect(returnFocus(null, null)).toBe("none");
  });

  it("leaves it alone where the browser already focused it", () => {
    const t = target();
    expect(returnFocus(t, t)).toBe("already");
    expect(t.calls).toEqual([]);
  });

  it("focuses it without a jump, then brings it to the middle of the screen", () => {
    const t = target();
    expect(returnFocus(t, { body: true })).toBe("returned");
    expect(t.calls).toEqual(["focus preventScroll=true", "scroll center"]);
  });
});
