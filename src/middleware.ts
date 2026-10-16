// Loads the site's content once per request into Astro.locals.content, through the active
// ContentSource (src/content/active-source.ts).
import { defineMiddleware } from "astro:middleware";
import { activeContentSource } from "./content/active-source";

export const onRequest = defineMiddleware(async (context, next) => {
  const source = await activeContentSource();
  const { content } = await source.load({ now: new Date() });
  context.locals.content = content;
  return next();
});
