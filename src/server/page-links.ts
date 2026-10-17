/**
 * The canonical and hreflang URLs of a public page. Search engines and Lighthouse require them
 * absolute, so they are built from the request's own origin: it is the public host the Worker
 * answers on (workers.dev now, a custom domain later) and needs no per-site setting.
 */
export function pageLinks(url: URL, locale: "sv" | "en") {
  const trailing = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  // /menu and /menu/ both render; the trailing-slash form is canonical.
  const svPath = locale === "sv" ? trailing : trailing.replace(/^\/en(?=\/)/, "") || "/";
  const enPath = locale === "en" ? trailing : `/en${trailing}`;
  const abs = (path: string) => new URL(path, url.origin).href;
  return { canonical: abs(trailing), sv: abs(svPath), en: abs(enPath) };
}
