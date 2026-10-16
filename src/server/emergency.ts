/**
 * The page shown when the content database is unreachable and this isolate holds no copy
 * (ADR-011 §3): the restaurant's name and how to reach it, from details bundled at build
 * time. Deliberately no menu and no prices: better none than a wrong one.
 */
import type { SiteSettings } from "../content/schema";

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function emergencyPage(settings: SiteSettings, locale: "sv" | "en"): string {
  const name = escape(settings.name[locale]);
  const tel = escape(settings.phone.replace(/[^\d+]/g, ""));
  const text =
    locale === "sv"
      ? { lead: "Vår webbplats har tillfälliga problem.", reach: "Du når oss här:", phone: "Ring", mail: "Mejla", retry: "Försök igen om en stund." }
      : { lead: "Our website is having a temporary problem.", reach: "You can reach us here:", phone: "Call", mail: "Email", retry: "Please try again in a moment." };
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${name}</title>
<style>body{font:1.125rem/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fff}h1{font-size:1.75rem}a{color:inherit}</style>
</head>
<body>
<main>
<h1>${name}</h1>
<p>${text.lead}</p>
<p>${text.reach}</p>
<ul>
<li>${text.phone}: <a href="tel:${tel}">${escape(settings.phone)}</a></li>
<li>${text.mail}: <a href="mailto:${escape(settings.email)}">${escape(settings.email)}</a></li>
<li>${escape(settings.address)}</li>
</ul>
<p>${text.retry}</p>
</main>
</body>
</html>`;
}
