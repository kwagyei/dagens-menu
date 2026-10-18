/** Client side: whether the visitor accepted third-party embeds (ConsentBanner sets the cookie). */
export const hasConsent = (): boolean => /(?:^|; )consent=accepted(?:;|$)/.test(document.cookie);

/**
 * Run `load` once the visitor accepts: at once if they already have, or when they do. The
 * button loads the embed, asking for consent first if it isn't given. `load` must be safe to
 * call twice (the banner re-announces an existing choice on every page).
 */
export function onConsent(buttonId: string, load: () => void): void {
  if (hasConsent()) load();
  window.addEventListener("consent-changed", (event) => {
    if ((event as CustomEvent<{ consent: string }>).detail?.consent === "accepted") load();
  });
  document.getElementById(buttonId)?.addEventListener("click", () => {
    if (hasConsent()) load();
    else window.dispatchEvent(new Event("open-consent-banner"));
  });
}
