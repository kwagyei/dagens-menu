# dagens-menu

Bilingual restaurant template: Astro 7 + Tailwind 4, static output, Cloudflare Pages.

Project notes: ~/Vault/Projects/dagens-menu/

## Stack

- Astro 7 (static site generator)
- Tailwind CSS 4 (via @tailwindcss/vite)
- TypeScript (strict)
- Decap CMS (planned)
- Cloudflare Pages (hosting)

## Commands

```sh
npm run dev              # dev server (default: bistro)
npm run dev:bistro       # dev server for bistro demo
npm run dev:westafrican  # dev server for West African demo
npm run build            # production build
npm run build:bistro     # build bistro
npm run build:westafrican # build westafrican
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

- Prices in integer minor units (ore). Use `formatPrice()` from `src/content/load.ts`.
- Every content field has `{ sv, en }`. Use `localized(field, locale)`.
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
