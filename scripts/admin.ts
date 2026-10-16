/**
 * Operator CLI for owner accounts (ADR-011 §6, plan M4.1). There is no self-signup: owners
 * get a single-use link from here.
 *
 *   npm run admin -- invite --site bistro --email owner@example.se [--url https://…] [--remote]
 *   npm run admin -- revoke --site bistro --email owner@example.se [--remote]
 *   npm run admin -- list   --site bistro [--remote]
 *
 * Local by default (d1.local.jsonc); --remote acts on the real database and needs the
 * site's wrangler config (--config wrangler.<site>.jsonc). The invite link is printed once
 * and never stored: send it to the owner yourself, by SMS or email.
 */
import { parseArgs } from "node:util";
import { INVITE_TTL_MS, issueInvite, revokeStatements } from "../src/auth/invites";
import { checkTarget, type D1Target, execute, fail as failWith, query, targetName } from "./d1-cli";

const fail: (message: string) => never = (message) => failWith("admin", message);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: "string" },
    email: { type: "string" },
    url: { type: "string" },
    remote: { type: "boolean", default: false },
    database: { type: "string", default: "dagens-menu" },
    config: { type: "string" },
  },
});

const command = positionals[0];
if (!["invite", "revoke", "list"].includes(command ?? "")) fail("usage: admin <invite|revoke|list> --site <id> [--email <address>] [--remote]");
const site = values.site;
if (!site || !/^[a-z0-9-]+$/.test(site)) fail("--site <id> is required, e.g. --site bistro");
const config = values.config ?? (values.remote ? `wrangler.${site}.jsonc` : "d1.local.jsonc");
const target: D1Target = { database: values.database!, config, remote: values.remote! };
checkTarget("admin", target);

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const [{ n: known }] = query<{ n: number }>("admin", target, `SELECT count(*) AS n FROM sites WHERE id = ${quote(site)}`);
if (known === 0) fail(`site "${site}" doesn't exist in the ${targetName(target)} database; seed it first`);

if (command === "invite") {
  if (!values.email) fail("--email is required for invite");
  let issued;
  try {
    issued = await issueInvite(site, values.email, new Date());
  } catch (error) {
    fail((error as Error).message);
  }
  execute("admin", target, issued.statements);
  const base = (values.url ?? (values.remote ? "" : "http://localhost:4321")).replace(/\/$/, "");
  const path = `/admin/invite/${issued.token}`;
  console.log(`admin: invited ${values.email.trim().toLowerCase()} as owner of "${site}" (${targetName(target)}).`);
  console.log(`admin: single-use link, valid ${INVITE_TTL_MS / 3_600_000} hours, shown only now:\n\n  ${base}${path}\n`);
  if (!base) console.log("admin: (pass --url https://<the site's address> to print the full link)");
}

if (command === "revoke") {
  if (!values.email) fail("--email is required for revoke");
  const email = values.email.trim().toLowerCase();
  const [{ n }] = query<{ n: number }>(
    "admin",
    target,
    `SELECT count(*) AS n FROM memberships WHERE site_id = ${quote(site)} AND user_id = (SELECT id FROM users WHERE email = ${quote(email)})`,
  );
  if (n === 0) fail(`${email} has no access to "${site}"`);
  execute("admin", target, revokeStatements(site, email));
  console.log(`admin: revoked ${email} on "${site}": membership, passkeys, sessions and invites removed.`);
}

if (command === "list") {
  const rows = query<{ email: string; role: string; passkeys: number; sessions: number; open_invites: number }>(
    "admin",
    target,
    `SELECT u.email, m.role,
       (SELECT count(*) FROM passkeys p WHERE p.user_id = u.id AND p.site_id = m.site_id) AS passkeys,
       (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.site_id = m.site_id AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) AS sessions,
       (SELECT count(*) FROM invites i WHERE i.user_id = u.id AND i.site_id = m.site_id AND i.used_at IS NULL AND i.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) AS open_invites
     FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.site_id = ${quote(site)} ORDER BY u.email`,
  );
  if (rows.length === 0) console.log(`admin: nobody has access to "${site}" (${targetName(target)}).`);
  else console.table(rows);
}
