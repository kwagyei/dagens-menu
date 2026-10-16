declare namespace App {
  interface Locals {
    /** The site's validated content, set by src/middleware.ts. */
    content: import("./content/schema").SiteContent;
  }
}
