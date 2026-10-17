import type { APIRoute } from "astro";
import { buildSitemap } from "../server/sitemap";

export const GET: APIRoute = ({ url }) =>
  new Response(buildSitemap(url.origin), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
