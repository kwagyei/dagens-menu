/**
 * Response headers for pages rendered by the Worker (ADR-011 §2, §9). Static assets keep
 * public/_headers; Cloudflare doesn't apply that file to Worker responses, so pages get
 * their headers here.
 */

export type RouteClass = "public" | "admin";

export function routeClass(pathname: string): RouteClass {
  return pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/en/admin") ? "admin" : "public";
}

// Pages load nothing from another origin (the consent check enforces it); the inline
// scripts Astro emits need 'unsafe-inline'. Decap's allowances (unsafe-eval, unpkg, the
// GitHub API) stay on the static /admin/ page only, in public/_headers.
const CSP = [
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

export function securityHeaders(route: RouteClass): Record<string, string> {
  return {
    "Content-Security-Policy": CSP,
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

/**
 * The page's entity tag: the content version and the restaurant's date. A save changes the
 * version; midnight in Stockholm changes the date (today's hours and sold-out flags). The
 * build id covers a deploy that changes templates without touching content.
 */
export function etagFor(contentVersion: string, restaurantDate: string, buildId: string): string {
  return `W/"${buildId}-${contentVersion}-${restaurantDate}"`;
}

/** Whether the request's If-None-Match already holds `etag`. */
export function isNotModified(request: Request, etag: string): boolean {
  const header = request.headers.get("If-None-Match");
  if (!header) return false;
  if (header.trim() === "*") return true;
  const strip = (tag: string) => tag.trim().replace(/^W\//, "");
  return header.split(",").some((tag) => strip(tag) === strip(etag));
}
