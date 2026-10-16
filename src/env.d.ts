declare namespace App {
  interface Locals {
    /**
     * The site's validated content, set by src/middleware.ts. Read-only: at build time one
     * parsed object serves every page, so a template that changed it would change them all.
     */
    content: import("./content/readonly").DeepReadonly<import("./content/schema").SiteContent>;
  }
}
