// @ts-check
import js from "@eslint/js";
import astro from "eslint-plugin-astro";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", ".astro/", ".wrangler/", "public/", "test-results/", "playwright-report*/", "pages-redirect/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  astro.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // A leading underscore marks a value that is unused on purpose: a rest-sibling dropped from an object, an unused callback argument.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Prices and addresses are tested with no-break and narrow no-break spaces, which have to appear literally in strings and patterns.
      "no-irregular-whitespace": ["error", { skipStrings: true, skipTemplates: true, skipRegExps: true }],
    },
  },
  {
    files: ["src/layouts/Base.astro"],
    rules: {
      // The theme's define:vars are read by var() in src/styles/site.css, which the rule can't see.
      "astro/no-unused-define-vars-in-style": "off",
    },
  },
);
