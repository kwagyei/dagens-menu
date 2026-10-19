/**
 * After a quick action (moving a dish, sold out, a gallery move) the page reloads with
 * `autofocus` on the control just used (M5.7), so the owner carries on where they were, with
 * no JavaScript needed. On iPhone Safari the page still landed at the top (walkthrough,
 * 18 Oct). The first fix only acted when the control lacked focus, and that wasn't enough on
 * a real iPhone (#64): iOS can give the control focus without scrolling to it, and can move
 * the page after the script has run. So this checks again once the page has loaded:
 *
 * - focus the control if the browser didn't;
 * - scroll it to the middle of the screen if it isn't fully on screen, whoever focused it.
 *
 * Where the browser already did both (desktop Chrome, Firefox), it does nothing. And once the
 * owner has touched, scrolled or typed, the second check leaves the page where they put it
 * (review L4, 18 Oct): on a slow connection they may be on their way elsewhere before `load`.
 */

/** The parts of the page this needs; a plain object in tests. */
export interface FocusTarget {
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView(options?: { block?: "start" | "center" | "end" | "nearest" }): void;
  getBoundingClientRect(): { top: number; bottom: number };
}

export type ReturnFocusResult = { focused: "none" | "already" | "now"; scrolled: boolean };

export function returnFocus(target: FocusTarget | null, active: unknown, viewportHeight: number): ReturnFocusResult {
  if (!target) return { focused: "none", scrolled: false };
  const focused = active === target ? "already" : "now";
  if (focused === "now") target.focus({ preventScroll: true });
  const { top, bottom } = target.getBoundingClientRect();
  const onScreen = top >= 0 && bottom <= viewportHeight;
  if (!onScreen) target.scrollIntoView({ block: "center" });
  return { focused, scrolled: !onScreen };
}

/**
 * What says the owner has taken over. Not `scroll`: the first check and the browser's own
 * autofocus scroll the page too, and those must not cancel the second check.
 */
export const OWNER_INPUT = ["touchstart", "wheel", "keydown", "pointerdown"] as const;

type Win = Pick<Window, "addEventListener" | "requestAnimationFrame">;

/** Run now, and again a frame after `load` unless the owner has touched the page by then. */
export function runNowAndAfterLoad(run: () => void, win: Win, loaded: boolean): void {
  run();
  let touched = false;
  for (const type of OWNER_INPUT) win.addEventListener(type, () => (touched = true), { once: true, passive: true, capture: true });
  const later = () => win.requestAnimationFrame(() => (touched ? undefined : run()));
  if (loaded) later();
  else win.addEventListener("load", later, { once: true });
}

if (typeof document !== "undefined") {
  runNowAndAfterLoad(
    () => returnFocus(document.querySelector<HTMLElement>("[autofocus]"), document.activeElement, window.innerHeight),
    window,
    document.readyState === "complete",
  );
}
