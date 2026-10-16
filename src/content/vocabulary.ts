// Controlled vocabularies: the values an owner can pick, and the only values the content
// schema accepts.

export const MENU_TAGS = ["vegan", "vegetarian", "gluten-free", "spicy"] as const;
export type MenuTag = (typeof MENU_TAGS)[number];

// The 14 allergens that EU Regulation 1169/2011 requires restaurants to declare.
export const ALLERGENS = [
  "gluten",
  "crustaceans",
  "eggs",
  "fish",
  "peanuts",
  "soybeans",
  "milk",
  "nuts",
  "celery",
  "mustard",
  "sesame",
  "sulphites",
  "lupin",
  "molluscs",
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const BOOKING_MODES = ["none", "embed", "link"] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

// The networks the admin offers a link field for. The footer names them; other lowercase
// network names in the content are kept and shown as written.
export const SOCIAL_NETWORKS = ["instagram", "facebook", "tiktok", "twitter"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];
