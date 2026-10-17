# dagens-menu

[![CI](https://github.com/kwagyei/dagens-menu/actions/workflows/ci.yml/badge.svg)](https://github.com/kwagyei/dagens-menu/actions/workflows/ci.yml)

A bilingual (Swedish/English) website template for small restaurants. One Astro codebase
becomes a new restaurant's site from a content seed and a theme file. No code changes.
Pages render on Cloudflare Workers from a D1 database, so an owner's edit is live on the
next page load.

**Live demos**, built from the same code with different content:

- **Bistro Norden**, a Scandinavian bistro in Stockholm: https://dagens-menu-bistro.kwabenasasuboakye.workers.dev
- **Chez Abena**, a West African kitchen in Göteborg: https://dagens-menu-westafrican.kwabenasasuboakye.workers.dev

The earlier static versions on Cloudflare Pages (`dagens-menu-bistro.pages.dev`, `-westafrican`)
now answer every path with a 301 to the same path on the Worker, so old links keep working.
Each Pages project holds only a `_redirects` file from `pages-redirect/<site>/`, deployed by
hand with `npx wrangler pages deploy pages-redirect/<site> --project-name dagens-menu-<site> --branch main`.

## The problem

Most small Swedish restaurants run on a builder site that is slow and English-only, or on a
PDF menu nobody updates. They also have a cookie banner that loads Google Maps and the
booking widget before the visitor has agreed to anything. The goal here is a site that is
fast, bilingual, compliant by construction and cheap to run, which owners can keep up to
date themselves.

## What it does

- Seven pages per language: home, menu, book a table, about, gallery, contact, privacy.
  Swedish at `/`, English at `/en/`, with `hreflang` alternates.
- A menu with EU-14 allergens, dietary tags and sold-out items, plus schema.org `Restaurant`
  and `Menu` JSON-LD for search results.
- A booking widget in three modes (embed, link-out, phone/email fallback). There are
  presets for six Swedish booking providers.
- A cookie consent banner with equally weighted Accept and Decline. The map and booking
  embeds load only after consent.
- The privacy page is generated from the site settings, so it only describes services
  the site actually uses.
- An owner admin at `/admin/`, signed into with a passkey (Face ID, fingerprint or device PIN),
  no password. Owners are invited by the operator. They edit the whole menu (add, edit,
  delete, reorder, sold out today), opening hours and special days, and the site's texts
  and contact details, on a phone and without JavaScript. Every change is in a history,
  and "Export my content" downloads the whole site as a file.

## Running it

Requires Node 22.18+ (the build imports TypeScript directly, which Node supports by default from 22.18).

```sh
npm install
npm run db:migrate:local              # a local D1 database (.wrangler/state)
npm run seed -- --site bistro         # load a demo's content into it
npm run dev:bistro                    # or dev:westafrican (seed it first)
npm test                              # unit, content, and database tests in workerd
npm run test:e2e                      # admin end to end, the deploy gate (Playwright)
npm run test:e2e:edge                 # the edge-case sweeps; non-blocking in CI, also nightly
npm run check                         # type check (astro check)
SITE=bistro npm run build             # the bistro's Worker, in dist/
```

`SITE` selects the restaurant at build time: its theme (`sites/<SITE>/theme.json`) and
curated photos. Its content comes from D1 at request time; `sites/<SITE>/content/*.json`
is the seed data the demos are loaded from.

## Design decisions

- **Static output, no server.** A restaurant site changes a few times a week. Static
  HTML on Cloudflare Pages is free, fast and has nothing to patch.
- **One codebase, many sites, selected at build time.** A new client is a content folder
  plus a theme file. Nothing forks, so a fix ships to every site.
- **Two looks, not two colour schemes.** `theme.json` picks `"style": "classic"` (a full-bleed
  food photo, a spaced serif name, a printed menu) or `"modern"` (one huge condensed word over a
  rounded photo, pill shapes, an orange oval button). The same pages render either: the looks
  live in `src/styles/site.css` under `[data-style]`, with markup branches only where the
  structure differs (the home hero and the menu). Colours and fonts still come from the theme,
  so a client recolours a look rather than forking it. Each page has one booking button, and
  the navigation, menu button and footer work without JavaScript.
- **Prices are integers in öre.** They are never floats, so `145.5 kr` can't appear. They
  are formatted in one place (`formatPrice`), which rejects anything that isn't a
  non-negative integer. A bad edit then fails the build instead of rendering `NaN kr`.
- **Every text field is `{ sv, en }`.** There is no fallback-to-Swedish at render time
  that would hide a missing translation. The content tests require both languages.
- **One schema defines valid content.** `src/content/schema.ts` (Zod) holds every rule:
  - both languages present
  - prices in whole öre
  - tags and EU-14 allergens from a shared vocabulary
  - real dates, and 24-hour times that never open and close at the same minute
  - length caps
  - no unknown fields

  Invalid content fails the build with the field and the reason. It also fails CI, and
  `tests/schema-parity.test.ts` proves each rule rejects a bad value. The admin's save path
  validates through the same schema, so a rule exists once.
- **Pages never read content directly.** Middleware loads the site's content through a
  `ContentSource` into `Astro.locals.content`. Today that source is the JSON files. Moving
  to a database means writing a new source, not touching every template.
- **Dishes have stable ids.** Home-page highlights point at a dish's id, not its position,
  so reordering the menu can't change which dish is featured.
- **The database repeats the schema's rules (in progress: the move to D1).** Content is
  moving into Cloudflare D1 so owner edits go live immediately. The tables are `STRICT`,
  and CHECK constraints repeat the schema's core rules, so a bug in the app or a
  hand-written query still can't store a negative price or a one-language name.
  `tests/db/` runs in the Workers runtime against a local D1 and breaks each constraint
  with raw SQL.
- **Every content write is one transaction.** The change and its audit entry are written
  together, or nothing is. Triggers on every content table bump the site's
  `content_version` inside the same transaction, so pages and caches can't miss an edit,
  whichever code path made it. An edit made from a stale
  form is a conflict, not a silent overwrite. Every query is scoped to the Worker's own
  site, so one restaurant's ids don't exist for another.
- **The JSON round-trips losslessly.** `npm run seed` loads a demo's JSON into D1, and the
  export reads it back in the same shape. A test checks that both demos come back exactly
  as they went in.
  `npm run db:migrate:local` then `npm run seed -- --site bistro` sets up a local database.
- **"Open today" is worked out on the server, per request.** Today's hours, holiday
  exceptions and sold-out dishes are computed for every request in Europe/Stockholm time,
  so they're right without JavaScript and roll over at midnight. The page's ETag includes
  the restaurant's date and the content version, so a browser's cached copy is reused until
  either changes.
- **Nothing third-party loads before consent.** It's not left to code review. CI scans
  every built page for external scripts, styles, images and frames
  (`scripts/check-no-third-party.mjs`).
- **Strict headers on every page.** The Worker sets the CSP and security headers itself,
  because `public/_headers` only reaches static files. Pages may load only their own
  origin; the one allowance is `'unsafe-inline'` for the scripts Astro inlines. The page's
  ETag combines the build, the site, the path, the content version and the restaurant's
  date, so unchanged pages come back as 304s.
- **Passkeys, no passwords, no sign-up.** A password hash strong enough to matter doesn't
  fit the Workers free plan's 10 ms of CPU, and magic links need an email domain. Passkeys
  verify with one signature check and can't be phished. The operator issues a single-use
  link (`npm run admin -- invite`, valid 72 hours, stored only as a hash). The token sits in
  the link's `#fragment`, which browsers never send, so it never appears in a request log;
  the page posts it in a request body. Each passkey is bound to its site's address, so a
  Bistro Norden passkey can't sign in to Chez Abena. The device must verify the owner (Face
  ID, fingerprint or PIN), not just be present: the passkey is the only factor, so a
  security key without a PIN isn't enough.
- **Sessions can't outlive their owner's access.** The cookie is `__Host-`, HttpOnly and
  SameSite=Lax, and the database keeps only its hash. A session ends after 30 days, after
  14 days unused, the moment the operator revokes the owner, or the moment the passkey it
  was signed in with is removed (a foreign key, so no code path can forget it). Starting a
  passkey ceremony writes nothing: the challenge travels in a signed five-minute cookie.
- **Security events are in the history.** Invites (and recovery invites), enrolments, added
  and removed passkeys, signing out everywhere and revoked access each write an audit row
  in the same transaction as the event, so every owner sees them next to the content
  changes. Summaries name the person, never a token or a credential id.
- **Admin writes are guarded:** an Origin check on every write (form or fetch) and a form
  token tied to the session. Sign-in, enrolment and invite links are limited to 10 a minute
  per IP; ordinary edits aren't, so an owner can mark a dozen dishes sold out in a minute.
  Without the limiter binding those paths refuse (503) rather than run unlimited. A form
  posted after the session ended lands on sign-in saying the change wasn't saved.
  Each sign-in challenge works once, even for synced passkeys that don't count signatures.
  The admin has its own stricter CSP: no inline scripts at all.
- **Merging deploys, so the gate has to be trusted.** Every merge to `main` applies
  migrations, deploys both Workers and smoke-tests them, but only after type checks, unit,
  database and build tests, and a Playwright gate: the owner's journeys plus the attacks on
  sign-in. The gate runs in about 5 minutes with no retries, because a retried test hides
  flakiness that people then learn to merge over. The tester's edge-case sweeps run on every
  PR and nightly (straddling Stockholm midnight) but never block a deploy; a nightly failure
  opens an issue. A merge that changes only Markdown doesn't deploy, since it can't change
  the site. The deploy ships the exact builds CI crawled rather than rebuilding them, and
  every action is pinned to a commit SHA (Dependabot keeps the pins current). If a deploy
  stops halfway, [the deploy runbook](docs/deploy-runbook.md) says how to tell and how to
  roll back.
- **If the database is unreachable, the site still answers.** Each Worker keeps the last
  good content in memory and serves it, marked stale, when D1 fails or takes longer than
  1.5 s. With nothing held, visitors get a page with the restaurant's phone number,
  email and address (bundled at build time) and a 503, never an outdated menu.

## Known limitations

- **Owners can't upload photos yet.** Images are curated per site at build time; uploads
  (converted to WebP) are the next milestone.
- **An export file restores a demo, not a client, on the live database.** `npm run seed --
  --from <file>` restores locally, and `--remote --reset` is allowed only for the two demo
  sites. A client site on the live database is restored from D1 Time Travel instead.
- **Backups restore both demos at once, and photos only from Time Travel.** D1 Time Travel
  (7 days) is the restore path and rolls back the whole shared database. A weekly content-only
  export goes to a private repo, without photo bytes, history or owner accounts; restoring from
  it is a manual job. See [backups and restoring them](docs/backup-restore.md).
- **History has no undo.** It shows the last 50 changes and who made them; going back means
  restoring an export or Time Travel.
- **Recovering a lost passkey needs the operator.** Owners can add a second device
  themselves, but if every passkey is lost, the operator sends a new invite.
- **The edge-case suite can be red while `main` deploys.** That's the price of a fast gate:
  an edge case found nightly becomes an issue, not a blocked release.
- **Some demo photos are look-alikes.** No free photo shows real kroppkakor, rabarberpaj or
  Toast Skagen with confirmed shrimp, so close substitutes stand in; `docs/photo-credits.md`
  marks them. Thieboudienne, jordnötssoppa and pannbiff med lök have no photo at all.
- **Images are served as uploaded JPEGs.** Astro's image pipeline (AVIF/WebP, responsive
  sizes) isn't used yet, which costs page weight on mobile.
- **Lighthouse performance is 75–88 on mobile, below the 95 target.** Measured 2026-10-16:
  3 runs each on `/` and `/menu/` of the bistro demo. The cause is the photos:
  Largest Contentful Paint is about 3.7–4.2 s, while the server responds in about 50 ms.
  Accessibility scores 93–96 and best practices 100. axe runs in CI against the admin of
  both demos; the public pages haven't had an axe pass yet.
