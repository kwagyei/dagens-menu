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
 * Where the browser already did both (desktop Chrome, Firefox), it does nothing.
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

if (typeof document !== "undefined") {
  const run = () => returnFocus(document.querySelector<HTMLElement>("[autofocus]"), document.activeElement, window.innerHeight);
  run();
  // Again once everything has loaded and laid out: the browser may have moved the page since.
  const later = () => requestAnimationFrame(() => run());
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });
}
