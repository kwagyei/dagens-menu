/**
 * After a quick action (moving a dish, sold out, a gallery move) the page reloads with
 * `autofocus` on the control just used (M5.7), so the owner carries on where they were, with
 * no JavaScript needed. iPhone Safari ignores `autofocus`, so there the page landed at the top
 * after every move (walkthrough, 18 Oct). This finishes the job when the browser didn't:
 * focus the control and bring it into view. Where the browser already did, it does nothing.
 */

/** The parts of the page this needs; a plain object in tests. */
export interface FocusTarget {
  focus(options?: { preventScroll?: boolean }): void;
  scrollIntoView(options?: { block?: "start" | "center" | "end" | "nearest" }): void;
}

export function returnFocus(target: FocusTarget | null, active: unknown): "none" | "already" | "returned" {
  if (!target) return "none";
  if (active === target) return "already";
  target.focus({ preventScroll: true });
  // Scroll even if focusing did nothing (iOS may refuse focus without a tap): the position
  // is what the owner noticed.
  target.scrollIntoView({ block: "center" });
  return "returned";
}

if (typeof document !== "undefined") {
  returnFocus(document.querySelector<HTMLElement>("[autofocus]"), document.activeElement);
}
