// Loads the site's content once per request into Astro.locals.content, through the
// ContentSource for this build's SITE (see src/content/source.ts).
import { defineMiddleware } from "astro:middleware";
import { JsonContentSource } from "./content/source";

const source = new JsonContentSource(process.env.SITE || "bistro");

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.content = await source.load();
  return next();
});
