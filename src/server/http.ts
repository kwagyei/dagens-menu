/**
 * Response headers for pages rendered by the Worker (ADR-011 §2, §9). Static assets get the
 * same policy from public/_headers; Cloudflare doesn't apply that file to Worker responses,
 * so pages get their headers here.
 */

import type { ThirdPartyOrigins } from "../booking/embed";

/** "admin-upload" is the photo upload page: the admin, plus WebAssembly for its encoder (ADR-013). */
export type RouteClass = "public" | "admin" | "admin-upload";

export const isAdminRoute = (route: RouteClass) => route !== "public";

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
  if (/^\/(en\/)?admin\/photos\/new\/?$/.test(path)) return "admin-upload";
  return /^\/(en\/)?admin(\/|$)/.test(path) ? "admin" : "public";
}

// Pages load nothing from another origin on load (the consent check enforces it), and no
// inline script: Astro emits every component script as a file (astro.config.mjs), so
// script-src is 'self' alone. JSON-LD is data, which script-src doesn't govern. After consent, a page may frame the site's chosen
// booking provider and map (src/booking/embed.ts), so only those origins are added, and only
// to frame-src: no third party ever runs script on the site's (and the admin's) origin.
function publicCsp({ booking, map }: ThirdPartyOrigins = { booking: [], map: [] }): string {
  const plus = (base: string, origins: string[]) => [base, ...origins].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    plus("frame-src 'self'", [...booking, ...map]),
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

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

// The upload page alone may compile WebAssembly (the libwebp encoder) and preview a blob: URL.
// 'wasm-unsafe-eval' allows WebAssembly only, not JavaScript eval (ADR-013, CSP).
const ADMIN_UPLOAD_CSP = ADMIN_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'").replace("img-src 'self' data:", "img-src 'self' data: blob:");

/** `thirdParty` widens a public page's CSP to the site's own booking provider and map. */
export function securityHeaders(route: RouteClass, thirdParty?: ThirdPartyOrigins): Record<string, string> {
  return {
    "Content-Security-Policy": route === "admin-upload" ? ADMIN_UPLOAD_CSP : route === "admin" ? ADMIN_CSP : publicCsp(thirdParty),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    // No "preload": a client's own domain would commit every subdomain to HTTPS for good.
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    // Pages always revalidate (ETag below); the admin is never stored.
    "Cache-Control": isAdminRoute(route) ? "no-store" : "no-cache",
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
