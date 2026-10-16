/**
 * "Export my content" (plan M5.6): the signed-in owner's site as one JSON file, which the
 * seed CLI restores with --from. A GET is safe here: it changes nothing, and another site
 * can't read the response (no CORS), so it needs no form token.
 */
import type { APIContext } from "astro";
import { env } from "cloudflare:workers";
import { endpoint } from "../../admin/context";
import { exportSite } from "../../db/export";
import { exportFile, exportFileName } from "../../db/export-file";

export const GET = endpoint(async (context: APIContext) => {
  const session = context.locals.session;
  if (!session) return context.redirect("/admin/", 303);
  const exported = await exportSite(env.DB, session.siteId);
  if (!exported) return new Response("This site has no content to export.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const now = new Date();
  return new Response(JSON.stringify(exportFile(session.siteId, exported, now), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(session.siteId, now)}"`,
      "Cache-Control": "no-store",
    },
  });
});
