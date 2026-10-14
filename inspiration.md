# Restaurant template: build spec

## Goal

One Astro codebase that becomes a client's bilingual restaurant site in under 10 hours of setup, shown publicly as two demos: a casual bistro and a West African kitchen. It backs the Menu Site package (12,000 SEK) and is the base for Order Direct later.

Done means:

- Both demos live on Cloudflare Pages, Swedish and English.
- The owner can edit the menu, opening hours and photos in Decap without touching code.
- A booking widget from any provider loads only after cookie consent.
- Lighthouse 95+ on performance, accessibility, best practices and SEO, on mobile.
- A new client site is a copied content folder plus a theme file, nothing else.

## Decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Stack | Astro + Tailwind | Static output; no server to maintain under care plans |
| Menu editing | Decap CMS | Needs a small GitHub OAuth worker, because Netlify's login does not run on Cloudflare |
| Scope | Menu site + booking widget | Ordering is a separate module later |
| Languages | Swedish (default, `/`) + English (`/en/`) | Every content field has sv and en; Astro's built-in i18n routing |
| Demos | Bistro + West African kitchen | Same code, two content folders and two theme files |
| Design | Restyle a free Astro theme | Check the licence is MIT or similar before use |
| Booking | Generic component with provider presets | Works with any embed code; presets for common Swedish systems |
| Hosting | GitHub + Cloudflare Pages | Free tier; preview URL per branch for client review |

## Site map and content model

Six pages per language, plus legal pages; every text the owner edits lives in a Decap collection.

| Page | Contents |
| --- | --- |
| Home | Hero image, tagline, today's opening hours, booking button, 3 highlight dishes |
| Menu | Categories (lunch, starters, mains, desserts, drinks), items with price, dietary tags, allergens |
| Book a table | Booking widget, or phone and email fallback |
| About | Story, chef, photos |
| Gallery | Image grid with lightbox |
| Contact | Address, map (click-to-load), phone, email, opening hours and exceptions |
| Privacy and cookies | Generated from settings; lists the booking provider and map as third parties |

| Decap collection | Fields (sv and en where text) |
| --- | --- |
| Settings | Name, logo, address, phone, email, social links, booking provider + embed code |
| Theme | Colours, fonts, corner radius, hero style |
| Opening hours | Weekly hours; exceptions with date and note (holidays, private events) |
| Menu | Categories → items: name, description, price SEK, tags (vegan, vegetarian, gluten-free, spicy), allergens (EU 14), image, available on/off |
| Pages | About text, home tagline, highlight dishes |
| Gallery | Images with alt text |

Alt text is a required field on every image: it is the cheapest accessibility win and the one owners skip.

## Booking component and cookie consent

One `<BookingWidget>` component takes the provider from Settings and renders it in one of three modes; nothing from the provider loads until the visitor agrees.

| Mode | When | How it renders |
| --- | --- | --- |
| Embed | Provider gives an iframe or script snippet | Placeholder card with a "Load booking" button; snippet injected on consent |
| Link-out | Provider only gives a booking URL | Button opening the provider page in a new tab; no consent needed |
| Fallback | No provider | Phone and email buttons, plus opening hours |

- Presets: a small config file per provider (name, mode, embed pattern). Fill presets for the systems Swedish restaurants use most; confirm each provider's embed method from its own documentation before listing it.
- Consent: a minimal banner with equal Accept and Decline buttons, choice stored for 6 months, and a footer link to change it. The map embed uses the same click-to-load pattern.
- No analytics cookies by default; add cookieless analytics (e.g. Cloudflare Web Analytics) only if the client wants numbers.

## Quality bar

Every client site ships at the same bar; it is what you sell as the difference from a Wix site.

| Area | Requirement | How it is checked |
| --- | --- | --- |
| Performance | Lighthouse 95+ mobile; images in AVIF/WebP via Astro's image component | Lighthouse in CI on every deploy |
| Accessibility | WCAG 2.1 AA: contrast, focus states, alt text, keyboard navigation, `lang` per page | axe check + manual keyboard pass |
| SEO | Titles and descriptions per page and language, `hreflang`, sitemap, schema.org Restaurant and Menu JSON-LD, Open Graph images | Rich-results test |
| Security | Security headers in `_headers` (CSP, HSTS, frame and referrer policies); no secrets in the repo | securityheaders.com grade A |
| Privacy | No third-party requests before consent; privacy page lists every processor | Browser network tab on first load |

## Repo structure and two-demo theming

Code is shared; each restaurant is a content folder plus a theme file, chosen at build time by one environment variable (`SITE=bistro` or `SITE=westafrican`).

```
restaurant-template/
  src/
    components/      Header, Footer, MenuList, BookingWidget, ConsentBanner, Hours, Gallery
    layouts/         Base layout with SEO, hreflang, JSON-LD
    pages/           [lang]/index, menu, book, about, gallery, contact, privacy
    i18n/            UI strings sv/en
    booking/presets/ One file per provider
  sites/
    bistro/          content/ (menu, hours, pages, settings) + theme.json + images/
    westafrican/     same shape
  public/
    admin/           Decap config (points at the active site folder)
    _headers
  workers/
    decap-oauth/     GitHub OAuth worker for Decap
```

A client site is a new repo created from this one as a GitHub template, with its own `sites/<client>/` folder. Fixes to shared components flow back by pulling from the template.

## Build milestones

About 29 hours at \~8 hours a week puts both demos live by 9 November, in time for the portfolio site.

| # | Milestone | Output | Hours | Due | Status |
| --- | --- | --- | --- | --- | --- |
| M1 | Set up | Repo, Astro + Tailwind, chosen theme, Cloudflare Pages deploy, `SITE` switch | 2 | Oct 18, 2026 | Not started |
| M2 | Content model + i18n | Collections as schemas, sv/en routing, UI strings | 5 | Oct 22, 2026 | Not started |
| M3 | Pages and components | All pages, menu list with tags and allergens, hours with exceptions, gallery | 8 | Oct 29, 2026 | Not started |
| M4 | Booking + consent | BookingWidget in three modes, presets, consent banner, click-to-load map | 3 | Nov 1, 2026 | Not started |
| M5 | Decap CMS | Admin config, OAuth worker on Cloudflare, owner login tested | 4 | Nov 4, 2026 | Not started |
| M6 | Demo content | Two menus, texts in sv/en, licensed photos, two themes | 4 | Nov 6, 2026 | Not started |
| M7 | QA and launch | Quality bar passed for both demos; launch checklist written as a reusable file | 3 | Nov 9, 2026 | Not started |

## Open items before M1

- [ ] GitHub account for the studio (personal account is fine until the name is chosen)
- [ ] Cloudflare account
- [ ] Pick the free Astro theme and confirm its licence
- [ ] Names for the two demo restaurants (fictional, not real businesses)
- [ ] Photo source with a commercial licence (e.g. Unsplash, Pexels) or your own photos
- [ ] Where the code lives locally: a `restaurant-template` folder in your Projects folder, synced to GitHub
