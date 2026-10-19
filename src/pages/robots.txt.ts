import type { APIRoute } from "astro";
import { buildRobots } from "../server/sitemap";

export const GET: APIRoute = ({ url }) => new Response(buildRobots(url.origin), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
