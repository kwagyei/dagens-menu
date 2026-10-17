/**
 * Response headers for pages rendered by the Worker (ADR-011 §2, §9). Static assets get the
 * same policy from public/_headers; Cloudflare doesn't apply that file to Worker responses,
 * so pages get their headers here.
 */

export type RouteClass = "public" | "admin";

/**
 * The path as the router sees it: percent-decoded, so /%61dmin/ can't reach the admin while
 * being classed as a public page, and with runs of slashes collapsed, because the router
 * serves /admin//api/… as /admin/api/… (tester F1, 17 Oct). A path that doesn't decode is
 * left undecoded.
 */
export function decodedPath(pathname: string): string {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    // keep it as sent
  }
  return path.replace(/\/{2,}/g, "/");
}

export function routeClass(pathname: string): RouteClass {
  const path = decodedPath(pathname);
  return /^\/(en\/)?admin(\/|$)/.test(path) ? "admin" : "public";
}

// Pages load nothing from another origin (the consent check enforces it); the inline
// scripts Astro emits need 'unsafe-inline'.
const PUBLIC_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "frame-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The admin runs only its own bundled script and inline styles (the theme's colours): no
// inline scripts, no frames, nothing from elsewhere (ADR-011 §9).
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(route: RouteClass): Record<string, string> {
  return {
    "Content-Security-Policy": route === "admin" ? ADMIN_CSP : PUBLIC_CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    // No "preload": a client's own domain would commit every subdomain to HTTPS for good.
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    // Pages always revalidate (ETag below); the admin is never stored.
    "Cache-Control": route === "admin" ? "no-store" : "no-cache",
  };
}

/** A short, stable hash (FNV-1a, 32-bit) for the parts of an ETag that needn't be readable. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * The page's entity tag (ADR-011 §2): build, site, path, content version and the
 * restaurant's date. A save changes the version; midnight in Stockholm changes the date
 * (today's hours and sold-out flags); a deploy changes the build. The site and path make
 * every page's tag its own, so one page's tag can never confirm another.
 */
export function etagFor(contentVersion: string, restaurantDate: string, buildId: string, site: string, pathname: string): string {
  return `W/"${buildId}-${contentVersion}-${restaurantDate}-${shortHash(`${site}:${pathname}`)}"`;
}

/**
 * Whether the request's If-None-Match already holds `etag` (weak comparison). "*" is not
 * honoured: it means "any current representation", which isn't known before rendering, and a
 * page that doesn't exist must stay a 404.
 */
export function isNotModified(request: Request, etag: string): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => {
    const value = strip(tag);
    return value.startsWith('"') && value === strip(etag);
  });
}
