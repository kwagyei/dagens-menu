import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALLERGENS, BOOKING_MODES, MENU_TAGS } from "./content-vocabulary.mjs";

const site = process.env.SITE;
if (!site) {
  console.error("SITE is not set. Run e.g. `SITE=bistro npm run build` (or npm run build:bistro).");
  process.exit(1);
}

const config = `backend:
  name: github
  repo: kwagyei/dagens-menu
  branch: main
  base_url: https://decap-oauth.kwabenasasuboakye.workers.dev

media_folder: "public/images/${site}"
public_folder: "/images/${site}"

collections:
  - name: settings
    label: Settings
    files:
      - name: settings
        label: Site settings
        file: "sites/${site}/content/settings.json"
        fields:
          - label: Name
            name: name
            widget: object
            fields:
              - { label: Svenska, name: sv, widget: string }
              - { label: English, name: en, widget: string }
          - label: Tagline
            name: tagline
            widget: object
            fields:
              - { label: Svenska, name: sv, widget: string }
              - { label: English, name: en, widget: string }
          - label: Cuisine
            name: cuisine
            widget: object
            fields:
              - { label: Svenska, name: sv, widget: string }
              - { label: English, name: en, widget: string }
          - { label: Address, name: address, widget: string }
          - { label: Phone, name: phone, widget: string }
          - { label: Email, name: email, widget: string }
          - label: Social links
            name: socialLinks
            widget: object
            fields:
              - { label: Instagram, name: instagram, widget: string, required: false }
              - { label: Facebook, name: facebook, widget: string, required: false }
          - label: Booking
            name: booking
            widget: object
            fields:
              - label: Provider
                name: provider
                widget: select
                options: ${JSON.stringify(BOOKING_MODES)}
                default: "none"
              - { label: Embed code, name: embedCode, widget: text, required: false }
              - { label: Booking URL, name: bookingUrl, widget: string, required: false }
          - { label: Map embed URL, name: mapEmbed, widget: string, required: false }

  - name: theme
    label: Theme
    files:
      - name: theme
        label: Theme settings
        file: "sites/${site}/theme.json"
        fields:
          - label: Colours
            name: colors
            widget: object
            fields:
              - { label: Primary, name: primary, widget: color }
              - { label: Secondary, name: secondary, widget: color }
              - { label: Background, name: background, widget: color }
              - { label: Surface, name: surface, widget: color }
              - { label: Text, name: text, widget: color }
              - { label: Text muted, name: textMuted, widget: color }
          - label: Fonts
            name: fonts
            widget: object
            fields:
              - { label: Heading, name: heading, widget: string }
              - { label: Body, name: body, widget: string }
          - { label: Corner radius, name: cornerRadius, widget: string, default: "0.5rem" }
          - label: Hero style
            name: heroStyle
            widget: select
            options: ["image-overlay", "side-by-side", "text-only"]
            default: "image-overlay"

  - name: hours
    label: Opening hours
    files:
      - name: hours
        label: Weekly hours and exceptions
        file: "sites/${site}/content/hours.json"
        fields:
          - label: Weekly
            name: weekly
            widget: object
            fields:
              - &day_hours
                label: Monday
                name: monday
                widget: object
                required: false
                fields:
                  - { label: Open, name: open, widget: string, pattern: ['^\\\d{2}:\\\d{2}$', "Use HH:MM format"] }
                  - { label: Close, name: close, widget: string, pattern: ['^\\\d{2}:\\\d{2}$', "Use HH:MM format"] }
              - { <<: *day_hours, label: Tuesday, name: tuesday }
              - { <<: *day_hours, label: Wednesday, name: wednesday }
              - { <<: *day_hours, label: Thursday, name: thursday }
              - { <<: *day_hours, label: Friday, name: friday }
              - { <<: *day_hours, label: Saturday, name: saturday }
              - { <<: *day_hours, label: Sunday, name: sunday }
          - label: Exceptions
            name: exceptions
            widget: list
            fields:
              - { label: Date, name: date, widget: datetime, format: "YYYY-MM-DD", date_format: "YYYY-MM-DD", time_format: false }
              - label: Note
                name: note
                widget: object
                fields:
                  - { label: Svenska, name: sv, widget: string }
                  - { label: English, name: en, widget: string }
              - label: Hours
                name: hours
                widget: object
                required: false
                fields:
                  - { label: Open, name: open, widget: string, required: false }
                  - { label: Close, name: close, widget: string, required: false }

  - name: menu
    label: Menu
    files:
      - name: menu
        label: Menu categories and items
        file: "sites/${site}/content/menu.json"
        fields:
          - label: Categories
            name: categories
            widget: list
            fields:
              - { label: ID, name: id, widget: string }
              - label: Name
                name: name
                widget: object
                fields:
                  - { label: Svenska, name: sv, widget: string }
                  - { label: English, name: en, widget: string }
              - label: Items
                name: items
                widget: list
                fields:
                  - label: "Id (unique; home-page highlights refer to it, do not change)"
                    name: id
                    widget: string
                    pattern: ["^[a-z0-9]{12}$", "12 lowercase letters or digits"]
                  - label: Name
                    name: name
                    widget: object
                    fields:
                      - { label: Svenska, name: sv, widget: string }
                      - { label: English, name: en, widget: string }
                  - label: Description
                    name: description
                    widget: object
                    fields:
                      - { label: Svenska, name: sv, widget: string }
                      - { label: English, name: en, widget: string }
                  - label: "Price (ore)"
                    name: price
                    widget: number
                    value_type: int
                    hint: "Price in ore (14500 = 145 kr)"
                  - label: Tags
                    name: tags
                    widget: select
                    multiple: true
                    options: ${JSON.stringify(MENU_TAGS)}
                    required: false
                  - label: Allergens
                    name: allergens
                    widget: select
                    multiple: true
                    options: ${JSON.stringify(ALLERGENS)}
                    required: false
                  - { label: Available, name: available, widget: boolean, default: true }
                  - { label: Image, name: image, widget: image, required: false }

  - name: pages
    label: Pages
    files:
      - name: pages
        label: Page content
        file: "sites/${site}/content/pages.json"
        fields:
          - label: Home
            name: home
            widget: object
            fields:
              - label: Tagline
                name: tagline
                widget: object
                fields:
                  - { label: Svenska, name: sv, widget: string }
                  - { label: English, name: en, widget: string }
              - label: Highlights
                name: highlights
                widget: list
                field: { label: "Menu item id", name: id, widget: string, pattern: ["^[a-z0-9]{12}$", "12 lowercase letters or digits"] }
          - label: About
            name: about
            widget: object
            fields:
              - label: Story
                name: story
                widget: object
                fields:
                  - { label: Svenska, name: sv, widget: markdown }
                  - { label: English, name: en, widget: markdown }
              - label: Chef
                name: chef
                widget: object
                fields:
                  - { label: Svenska, name: sv, widget: markdown }
                  - { label: English, name: en, widget: markdown }

  - name: gallery
    label: Gallery
    files:
      - name: gallery
        label: Gallery images
        file: "sites/${site}/content/gallery.json"
        fields:
          - label: Images
            name: images
            widget: list
            fields:
              - { label: Image, name: src, widget: image }
              - label: Alt text
                name: alt
                widget: object
                fields:
                  - { label: Svenska, name: sv, widget: string }
                  - { label: English, name: en, widget: string }
`;

const outPath = resolve(process.cwd(), "public/admin/config.yml");
writeFileSync(outPath, config, "utf-8");
console.log(`admin config.yml generated for site: ${site}`);
