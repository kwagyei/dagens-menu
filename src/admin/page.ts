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

/**
 * Where a request without a session goes: the sign-in page. A form posted after the session
 * ended can't be saved, so the sign-in page says so instead of dropping it silently (review L1).
 */
export function signInRedirect(astro: AstroGlobal): Response {
  const home = localePath(getLocale(astro.url), "/admin/");
  return astro.redirect(astro.request.method === "POST" ? `${home}?done=expired` : home, 303);
}

export async function adminPage(astro: AstroGlobal): Promise<AdminPage | Response> {
  const locale = getLocale(astro.url);
  const path = (p: string) => localePath(locale, `/admin${p}`);
  const session = astro.locals.session;
  if (!session) return signInRedirect(astro);
  const secret = adminSecret();
  return {
    session,
    locale,
    path,
    csrf: await formToken(secret, session.tokenHash),
    repo: { db: env.DB, siteId: session.siteId, userId: session.userId, now: new Date() },
    async postedForm() {
      // A body that isn't a form (a broken multipart boundary, text/plain) is treated like an
      // expired form, never a 500 (M6.6 tester F1).
      let form: FormData;
      try {
        form = await astro.request.formData();
      } catch {
        return null;
      }
      return (await checkFormToken(secret, session.tokenHash, form.get("csrf"))) ? form : null;
    },
  };
}
