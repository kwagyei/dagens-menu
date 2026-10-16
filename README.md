# dagens-menu

[![CI](https://github.com/kwagyei/dagens-menu/actions/workflows/ci.yml/badge.svg)](https://github.com/kwagyei/dagens-menu/actions/workflows/ci.yml)

A bilingual (Swedish/English) website template for small restaurants. One Astro codebase
becomes a new restaurant's site by copying a content folder and a theme file. No code
changes. The owner edits the menu, opening hours and photos in a CMS.

**Live demos**, built from the same code with different content:

- **Bistro Norden**, a Scandinavian bistro in Stockholm: https://dagens-menu-bistro.pages.dev
- **Chez Abena**, a West African kitchen in Göteborg: https://dagens-menu-westafrican.pages.dev

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
- Decap CMS at `/admin/`, behind a small GitHub OAuth worker on Cloudflare Workers.

## Running it

Requires Node 22.12+.

```sh
npm install
npm run dev:bistro        # or dev:westafrican
npm test                  # unit + content validation
npm run check             # type check (astro check)
npm run build:bistro      # static output in dist/
```

`SITE` selects the restaurant: content comes from `sites/<SITE>/content/*.json` and
the colours and fonts from `sites/<SITE>/theme.json`.

## Design decisions

- **Static output, no server.** A restaurant site changes a few times a week. Static
  HTML on Cloudflare Pages is free, fast and has nothing to patch.
- **One codebase, many sites, selected at build time.** A new client is a content folder
  plus a theme file. Nothing forks, so a fix ships to every site.
- **Prices are integers in öre.** They are never floats, so `145.5 kr` can't appear. They
  are formatted in one place (`formatPrice`), which rejects anything that isn't a
  non-negative integer. A bad edit then fails the build instead of rendering `NaN kr`.
- **Every text field is `{ sv, en }`.** There is no fallback-to-Swedish at render time
  that would hide a missing translation. The content tests require both languages.
- **The content is validated in CI.** Decap's own validation is shallow. It will save an
  empty translation, an allergen spelled wrong, or a close time of `25:00`.
  `tests/content.test.ts` checks every site's content on each pull request. The allowed
  tags and allergens live in one module, which both the CMS config and the tests import,
  so the two can't drift apart.
- **"Open today" is worked out in the browser.** A static page is built once. If the
  build picked "today", the badge would show the hours for the day of the last deploy.
  The page carries the weekly hours and a small script picks today's in
  Europe/Stockholm time, so a visitor abroad still sees the restaurant's day. Without
  JavaScript, the badge links to the full opening hours.
- **Nothing third-party loads before consent.** It's not left to code review. CI scans
  every built page for external scripts, styles, images and frames
  (`scripts/check-no-third-party.mjs`).
- **The global CSP allows `unsafe-eval`.** Decap needs it to parse its config. Cloudflare
  Pages stacks path-specific headers rather than replacing them, so it can't be scoped
  to `/admin/` only. The site already needs `unsafe-inline` for Astro's inline scripts,
  so this adds little extra exposure.

## Known limitations

- **CMS edits don't deploy by themselves yet.** Decap commits to `main`, but the Pages
  projects are deployed with `wrangler` from a local build and have no git connection.
  A deploy job on `main` is the next step.
- **Images are served as uploaded JPEGs.** Astro's image pipeline (AVIF/WebP, responsive
  sizes) isn't used yet, which costs page weight on mobile.
- **Decap CMS loads from unpkg on `/admin/`.** That page is for the owner only, but it
  depends on a third-party CDN.
- **Lighthouse and the axe accessibility audit haven't been run** against the deployed
  demos. The target is 95+ on all four Lighthouse categories on mobile.
