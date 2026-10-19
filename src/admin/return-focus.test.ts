import { describe, expect, it } from "vitest";
import { type FocusTarget, OWNER_INPUT, returnFocus, runNowAndAfterLoad } from "./return-focus";

/** A control at `top`–`bottom` px from the top of the viewport. */
function target(top: number, bottom = top + 40): FocusTarget & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    focus: (o) => calls.push(`focus preventScroll=${o?.preventScroll}`),
    scrollIntoView: (o) => calls.push(`scroll ${o?.block}`),
    getBoundingClientRect: () => ({ top, bottom }),
  };
}

const SCREEN = 800;

describe("returnFocus (walkthrough 18 Oct: the page landed at the top on iPhone)", () => {
  it("does nothing on a page with no autofocus", () => {
    expect(returnFocus(null, null, SCREEN)).toEqual({ focused: "none", scrolled: false });
  });

  it("leaves it alone where the browser already focused it and it's on screen (desktop)", () => {
    const t = target(300);
    expect(returnFocus(t, t, SCREEN)).toEqual({ focused: "already", scrolled: false });
    expect(t.calls).toEqual([]);
  });

  it("scrolls to it when it has focus but is off screen (iOS focusing without scrolling)", () => {
    const t = target(2400);
    expect(returnFocus(t, t, SCREEN)).toEqual({ focused: "already", scrolled: true });
    expect(t.calls).toEqual(["scroll center"]);
  });

  it("focuses it without a jump, then scrolls, when the browser ignored autofocus", () => {
    const t = target(2400);
    expect(returnFocus(t, { body: true }, SCREEN)).toEqual({ focused: "now", scrolled: true });
    expect(t.calls).toEqual(["focus preventScroll=true", "scroll center"]);
  });

  it("only focuses a control that is already on screen", () => {
    const t = target(100);
    expect(returnFocus(t, { body: true }, SCREEN)).toEqual({ focused: "now", scrolled: false });
    expect(t.calls).toEqual(["focus preventScroll=true"]);
  });

  it("counts a control cut off at either edge as off screen", () => {
    expect(returnFocus(target(-10), null, SCREEN).scrolled).toBe(true);
    expect(returnFocus(target(780, 820), null, SCREEN).scrolled).toBe(true);
  });
});

/** A window whose events and animation frames the test fires by hand. */
function fakeWindow() {
  const listeners = new Map<string, (() => void)[]>();
  const frames: (() => void)[] = [];
  return {
    win: {
      addEventListener: (type: string, fn: () => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
      requestAnimationFrame: (fn: () => void) => frames.push(fn),
    } as never,
    fire: (type: string) => (listeners.get(type) ?? []).forEach((fn) => fn()),
    nextFrame: () => frames.splice(0).forEach((fn) => fn()),
  };
}

describe("runNowAndAfterLoad (review L4: don't pull the page back from where the owner scrolled)", () => {
  it("runs now and again a frame after load", () => {
    const { win, fire, nextFrame } = fakeWindow();
    let runs = 0;
    runNowAndAfterLoad(() => runs++, win, false);
    expect(runs).toBe(1);
    fire("load");
    nextFrame();
    expect(runs).toBe(2);
  });

  it("runs the second time at once on a page that has already loaded", () => {
    const { win, nextFrame } = fakeWindow();
    let runs = 0;
    runNowAndAfterLoad(() => runs++, win, true);
    nextFrame();
    expect(runs).toBe(2);
  });

  it.each(OWNER_INPUT)("skips the second run after the owner's %s", (type) => {
    const { win, fire, nextFrame } = fakeWindow();
    let runs = 0;
    runNowAndAfterLoad(() => runs++, win, false);
    fire(type);
    fire("load");
    nextFrame();
    expect(runs).toBe(1);
  });

  it("is not cancelled by a scroll event, which the first run makes itself", () => {
    const { win, fire, nextFrame } = fakeWindow();
    let runs = 0;
    runNowAndAfterLoad(() => runs++, win, false);
    fire("scroll");
    fire("load");
    nextFrame();
    expect(runs).toBe(2);
  });
});
