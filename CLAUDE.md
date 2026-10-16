# dagens-menu

Bilingual restaurant template: Astro 7 + Tailwind 4, static output, Cloudflare Pages.

Project notes: ~/Vault/Projects/dagens-menu/

## Stack

- Astro 7 (static site generator)
- Tailwind CSS 4 (via @tailwindcss/vite)
- TypeScript (strict), Zod for the content schema
- Vitest for tests, `astro check` for types
- Decap CMS (live; being replaced by a D1-backed admin, see ADR-011 in the project notes)
- Cloudflare Pages (hosting; moving to Workers + D1 under ADR-011)

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
npm run seed -- --site bistro [--reset] [--remote]   # load a demo's JSON into D1
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
- `src/content/` holds no markup and is excluded from Tailwind's class scan (`global.css`).
- i18n: Swedish default at `/`, English at `/en/`. UI strings in `src/i18n/`.
- Alt text required on every image.
- No third-party requests before cookie consent.
- Security headers in `public/_headers`.

## Documentation

- [Astro docs](https://docs.astro.build)
- [Routing](https://docs.astro.build/en/guides/routing/)
- [Components](https://docs.astro.build/en/basics/astro-components/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Styling / Tailwind](https://docs.astro.build/en/guides/styling/)
- [i18n](https://docs.astro.build/en/guides/internationalization/)
