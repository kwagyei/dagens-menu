# dagens-menu

Bilingual restaurant template: Astro 7 + Tailwind 4, rendered on request on Cloudflare Workers,
content in D1, owner admin with passkeys (ADR-011).

Project notes: ~/Vault/Projects/dagens-menu/

## Stack

- Astro 7, `output: "server"` with the Cloudflare adapter
- Tailwind CSS 4 (via @tailwindcss/vite)
- TypeScript (strict), Zod for the content schema
- Vitest for tests, `astro check` for types
- Content in Cloudflare D1; owner admin at /admin with passkeys (ADR-011 in the project notes)
- Cloudflare Workers, one per site (`wrangler.<site>.jsonc`); the old Pages demos stay up until
  the M7 cutover
- Playwright for the admin end to end

## Commands

```sh
npm run dev              # dev server (default: bistro)
npm run dev:bistro       # dev server for bistro demo
npm run dev:westafrican  # dev server for West African demo
npm run build            # production build; needs SITE=bistro or SITE=westafrican
npm run build:bistro     # build bistro
npm run build:westafrican # build westafrican
npm test                 # vitest: unit, content schema, parity, worker tests
npm run check            # astro check, fails on warnings
npm run check:consent    # after a build: no third-party requests on load
npm run test:db          # database tests in workerd with a local D1 (migrations/)
npm run db:migrate:local # apply migrations/ to the local D1 (d1.local.jsonc); again after a database_id change
npm run seed -- --site bistro [--reset]   # load a demo's JSON into the local D1
npm run admin -- invite --site bistro --email x@y.se  # owner invite link (also: revoke, list; --remote)
npm run test:e2e         # Playwright deploy gate: admin journeys + sign-in attacks (~5 min)
npm run test:e2e:edge    # Playwright edge-case sweeps (tester-m5-*); non-blocking, also nightly
```

When starting the dev server, use background mode:

```sh
astro dev --background
```

Manage with `astro dev stop`, `astro dev status`, `astro dev logs`.

## Multi-site switching

`SITE` env var selects which content folder to build (`bistro` or `westafrican`).
Content lives in `sites/<SITE>/content/`, theme in `sites/<SITE>/theme.json`.

## Code conventions

- Read content from `Astro.locals.content` (settings, hours, menu, pages, gallery, theme).
  `src/middleware.ts` loads it through a `ContentSource` (`src/content/source.ts`); never
  read content files directly from pages or components.
- Content rules live once, in `src/content/schema.ts` (Zod). Add a rule there, plus a bad-value
  case in `tests/schema-parity.test.ts`. Tags and allergens come from `src/content/vocabulary.ts`.
- Menu items have stable 12-character ids; refer to dishes by id, never by position.
- Prices in integer minor units (öre). Display with `formatPrice()` from `src/content/load.ts`;
  parse owner input with `parseKronor()` from `src/content/price.ts`.
- Every content field has `{ sv, en }`. Use `localized(field, locale)`.
- Content writes go through `src/db/repository.ts` only. Triggers bump `content_version` on
  every content change; never write it by hand. Migrations in `migrations/` are append-only
  once applied remotely: add a new file, never edit a shipped one.
- Admin auth lives in `src/auth/`; admin pages in `src/pages/[...prefix]/admin/` serve both
  /admin and /en/admin. Local admin needs `.dev.vars` (see `.dev.vars.example`).
- `src/content/` holds no markup and is excluded from Tailwind's class scan (`global.css`).
- i18n: Swedish default at `/`, English at `/en/`. UI strings in `src/i18n/`.
- Alt text required on every image.
- No third-party requests before cookie consent.
- Security headers and the CSP are set by the Worker (`securityHeaders()`); `public/_headers`
  only reaches static files.
- E2E specs: dates from `stockholmToday()`/`daysAhead()`, client addresses from `freshIp()`
  (`tests/e2e/helpers.ts`); assert on what the test created; no retries.
  `tests/e2e-hygiene.test.ts` enforces it.
- Merging to `main` deploys (CI: migrations, both Workers, smoke test). Branch and PR, never
  commit to `main`.

## Documentation

- [Astro docs](https://docs.astro.build)
- [Routing](https://docs.astro.build/en/guides/routing/)
- [Components](https://docs.astro.build/en/basics/astro-components/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Styling / Tailwind](https://docs.astro.build/en/guides/styling/)
- [i18n](https://docs.astro.build/en/guides/internationalization/)
