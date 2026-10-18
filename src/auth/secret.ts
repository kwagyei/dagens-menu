/**
 * Whether SESSION_SECRET can sign the admin's sessions, challenges and form tokens: at least
 * 32 characters, and not the placeholder from .dev.vars.example, which is long enough but
 * public (security review L2, 18 Oct). Copying the example unchanged leaves the admin off.
 */
export const PLACEHOLDER_SECRET = "replace-with-at-least-32-random-characters";

export const usableSecret = (secret: string | undefined): secret is string =>
  typeof secret === "string" && secret.length >= 32 && secret.trim() !== PLACEHOLDER_SECRET;
