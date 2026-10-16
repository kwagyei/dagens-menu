/**
 * What every signed-in admin page needs: the session (or a redirect to sign in), the form
 * token for its forms, a check of posted forms, and a repository context for this site.
 */
import type { AstroGlobal } from "astro";
import { env } from "cloudflare:workers";
import { checkFormToken, formToken } from "../auth/guard";
import type { Session } from "../auth/sessions";
import type { RepoContext } from "../db/repository";
import { getLocale, localePath } from "../i18n";
import { adminSecret } from "./context";

export interface AdminPage {
  session: Session;
  locale: "sv" | "en";
  /** A path inside the admin, in the page's language. */
  path: (p: string) => string;
  csrf: string;
  repo: RepoContext;
  /** The posted form if its token is valid; null if it isn't (show "the form expired"). */
  postedForm: () => Promise<FormData | null>;
}

export async function adminPage(astro: AstroGlobal): Promise<AdminPage | Response> {
  const locale = getLocale(astro.url);
  const path = (p: string) => localePath(locale, `/admin${p}`);
  const session = astro.locals.session;
  if (!session) return astro.redirect(path("/"), 303);
  const secret = adminSecret();
  return {
    session,
    locale,
    path,
    csrf: await formToken(secret, session.tokenHash),
    repo: { db: env.DB, siteId: session.siteId, userId: session.userId, now: new Date() },
    async postedForm() {
      const form = await astro.request.formData();
      return (await checkFormToken(secret, session.tokenHash, form.get("csrf"))) ? form : null;
    },
  };
}
