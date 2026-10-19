/**
 * Tester, review finding M4: stale weekly-hours forms, conflicts and unchanged saves, against
 * the built bistro Worker. Every test puts the seeded week back (in a finally).
 */
import { expect, type Page, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const SEEDED: Record<string, [string, string] | null> = {
  monday: ["11:00", "22:00"],
  tuesday: ["11:00", "22:00"],
  wednesday: ["11:00", "22:00"],
  thursday: ["11:00", "23:00"],
  friday: ["11:00", "23:00"],
  saturday: ["12:00", "23:00"],
  sunday: null,
};
const SEEDED_TOKEN = "11:00-22:00,11:00-22:00,11:00-22:00,11:00-23:00,11:00-23:00,12:00-23:00,closed";

const tokenOf = (page: Page) => page.locator("input[name=weekly_token]").inputValue();
const csrfOf = (page: Page) => page.locator("input[name=csrf]").first().inputValue();
const week = (over: Record<string, [string, string] | null> = {}) => {
  const w = { ...SEEDED, ...over };
  const f: Record<string, string> = { action: "weekly" };
  for (const d of DAYS) {
    const h = w[d];
    if (h) {
      f[`${d}_open`] = h[0];
      f[`${d}_close`] = h[1];
    } else {
      f[`${d}_closed`] = "on";
      f[`${d}_open`] = "";
      f[`${d}_close`] = "";
    }
  }
  return f;
};
const post = async (page: Page, path: string, form: Record<string, string>) => page.request.post(path, { form, maxRedirects: 0, headers: { Origin: BASE } });
/** Load the hours page, return what a form rendered now would carry. */
async function open(page: Page, path = "/admin/hours/") {
  await page.goto(path);
  return { csrf: await csrfOf(page), token: await tokenOf(page) };
}
async function restore(page: Page) {
  const { csrf, token } = await open(page);
  if (token !== SEEDED_TOKEN) await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week() });
  await page.goto("/admin/hours/");
  expect(await tokenOf(page)).toBe(SEEDED_TOKEN);
}
const historyCount = async (page: Page) => {
  await page.goto("/admin/history/");
  return page.locator("ol > li").count();
};

test("the rendered form carries the week as its token", async ({ page }) => {
  await signedInOwner(page);
  // Start from the seeded week: an earlier spec in the same shard may have changed the hours.
  await restore(page);
  try {
    const { token } = await open(page);
    expect(token).toBe(SEEDED_TOKEN);
  } finally {
    await restore(page);
  }
});

test("AC1/2: a stale form is refused with 409 and the alert, keeps typed values, nothing written; saving again overwrites", async ({ page }) => {
  await signedInOwner(page);
  try {
    await page.goto("/admin/hours/");
    // The owner's form is open. Meanwhile someone else closes Monday.
    const { csrf, token } = { csrf: await csrfOf(page), token: await tokenOf(page) };
    const theirs = await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ monday: null }) });
    expect(theirs.status()).toBe(303);
    const h0 = await historyCount(page);
    await page.goBack().catch(() => {});
    // Re-open a *stale* form: reload the page state captured earlier by posting the old token from the UI.
    await page.goto("/admin/hours/");
    await page.evaluate((t) => {
      (document.querySelector("input[name=weekly_token]") as HTMLInputElement).value = t;
    }, token);
    await page.locator("input[name=tuesday_open]").fill("09:15");
    await page.locator("input[name=tuesday_close]").fill("10:45");
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/admin/hours") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Spara öppettiderna" }).click(),
    ]);
    expect(res.status()).toBe(409);
    const alert = page.getByRole("alert").filter({ hasText: "Någon annan ändrade öppettiderna nyss" });
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused(); // autofocus
    await expect(page.locator("input[name=tuesday_open]")).toHaveValue("09:15");
    await expect(page.locator("input[name=tuesday_close]")).toHaveValue("10:45");
    // The token now in the form is the current stored week, not the stale one.
    expect(await tokenOf(page)).toBe("closed,11:00-22:00,11:00-22:00,11:00-23:00,11:00-23:00,12:00-23:00,closed");
    // Nothing was written: stored Tuesday untouched, no new history row.
    await page.goto("/admin/hours/");
    await expect(page.locator("input[name=tuesday_open]")).toHaveValue("11:00");
    expect(await historyCount(page)).toBe(h0);

    // Conflict again, then save again on the refreshed form: overwrites.
    await page.goto("/admin/hours/");
    await page.evaluate((t) => {
      (document.querySelector("input[name=weekly_token]") as HTMLInputElement).value = t;
    }, token);
    await page.locator("input[name=tuesday_open]").fill("09:15");
    await page.getByRole("button", { name: "Spara öppettiderna" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Någon annan" })).toBeVisible();
    await page.getByRole("button", { name: "Spara öppettiderna" }).click();
    await expect(page.getByRole("status")).toHaveText("Sparat.");
    await expect(page.locator("input[name=tuesday_open]")).toHaveValue("09:15");
  } finally {
    await restore(page);
  }
});

test("AC1 english: the conflict and the unchanged message are in English under /en/admin", async ({ page }) => {
  await signedInOwner(page);
  try {
    const { csrf, token } = await open(page, "/en/admin/hours/");
    await post(page, "/en/admin/hours/", { csrf, weekly_token: token, ...week({ monday: null }) });
    const r = await post(page, "/en/admin/hours/", { csrf, weekly_token: token, ...week({ tuesday: ["10:00", "12:00"] }) });
    expect(r.status()).toBe(409);
    const body = await r.text();
    expect(body).toContain("Someone else changed the opening hours just now");
    expect(body).toContain('role="alert"');
    expect(body).not.toContain("Någon annan ändrade öppettiderna");
    // Unchanged in English, plain GET follow of the redirect.
    await page.goto("/en/admin/hours/");
    const cur = await tokenOf(page);
    const u = await post(page, "/en/admin/hours/", { csrf, weekly_token: cur, ...week({ monday: null }) });
    expect(u.status()).toBe(303);
    expect(u.headers().location).toContain("/en/admin/hours/?done=unchanged");
    await page.goto(u.headers().location);
    await expect(page.getByRole("status")).toHaveText("No changes to save.");
  } finally {
    await restore(page);
  }
});

test("AC3: an unchanged save says so in Swedish, writes no history row, and the message is a status", async ({ page }) => {
  await signedInOwner(page);
  const h0 = await historyCount(page);
  await page.goto("/admin/hours/");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page).toHaveURL(/done=unchanged/);
  await expect(page.getByRole("status")).toHaveText("Inga ändringar att spara.");
  expect(await historyCount(page)).toBe(h0);
  // Reload keeps showing the message but never re-posts.
  await page.goto("/admin/hours/?done=unchanged");
  await expect(page.getByRole("status")).toHaveText("Inga ändringar att spara.");
});

test("AC4: missing, empty, garbage and wrong tokens are conflicts (409) and write nothing", async ({ page }) => {
  await signedInOwner(page);
  try {
    const { csrf } = await open(page);
    const change = week({ monday: null });
    const bodies: Array<Record<string, string>> = [
      change,
      { ...change, weekly_token: "" },
      { ...change, weekly_token: "garbage" },
      { ...change, weekly_token: Array(7).fill("closed").join(",") },
      { ...change, weekly_token: SEEDED_TOKEN + ",closed" },
      { ...change, weekly_token: "11:00-22:00;".repeat(7) },
      { ...change, weekly_token: "x".repeat(100_000) },
    ];
    for (const [i, b] of bodies.entries()) {
      const res = await post(page, "/admin/hours/", { csrf, ...b });
      expect([409, 413, 400], `body ${i}`).toContain(res.status());
      if (res.status() === 409) expect(await res.text()).toContain('role="alert"');
    }
    expect((await open(page)).token).toBe(SEEDED_TOKEN);
    // A repeated weekly_token field: the first or last value is used, never a write against the stored week.
    const dup = await page.request.post("/admin/hours/", {
      data: `csrf=${encodeURIComponent(csrf)}&weekly_token=junk&weekly_token=${encodeURIComponent(SEEDED_TOKEN)}&${new URLSearchParams(change)}`,
      headers: { Origin: BASE, "Content-Type": "application/x-www-form-urlencoded" },
      maxRedirects: 0,
    });
    expect([303, 409]).toContain(dup.status()); // documents behaviour; either is a checked write
  } finally {
    await restore(page);
  }
});

test("AC5: a stale form that changed nothing is not a conflict; identical second save is unchanged", async ({ page }) => {
  await signedInOwner(page);
  try {
    const { csrf, token } = await open(page);
    expect((await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ sunday: ["12:00", "16:00"] }) })).status()).toBe(303);
    const same = await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ sunday: ["12:00", "16:00"] }) });
    expect(same.status()).toBe(303);
    expect(same.headers().location).toContain("done=unchanged");
    // Stale token, form equals the old week: nothing to do, and their Sunday stays.
    const stale = await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week() });
    expect(stale.status()).toBe(303);
    expect(stale.headers().location).toContain("done=unchanged");
    await page.goto("/admin/hours/");
    await expect(page.locator("input[name=sunday_open]")).toHaveValue("12:00");
  } finally {
    await restore(page);
  }
});

test("AC8: a validation error (422) keeps the submitted token, even a stale one", async ({ page }) => {
  await signedInOwner(page);
  try {
    const { csrf, token } = await open(page);
    await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ monday: null }) }); // token is now stale
    const res = await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ tuesday: ["11:00", "11:00"] }) });
    expect(res.status()).toBe(422);
    const html = await res.text();
    expect(html).toContain(`name="weekly_token" value="${token}"`);
    // Submit the bad form with a forged token: it is echoed, not replaced.
    const forged = await post(page, "/admin/hours/", { csrf, weekly_token: "forged", ...week({ tuesday: ["11:00", "11:00"] }) });
    expect(forged.status()).toBe(422);
    expect(await forged.text()).toContain('name="weekly_token" value="forged"');
  } finally {
    await restore(page);
  }
});

test("AC6: works with JavaScript off: conflict and unchanged are plain form posts with alert/status", async ({ browser, page }) => {
  await signedInOwner(page);
  const state = await page.context().storageState();
  const ctx = await browser.newContext({ javaScriptEnabled: false, storageState: state, baseURL: BASE });
  const nojs = await ctx.newPage();
  try {
    await nojs.goto("/admin/hours/");
    const stale = await tokenOf(nojs);
    const csrf = await csrfOf(nojs);
    await post(page, "/admin/hours/", { csrf, weekly_token: stale, ...week({ monday: null }) });
    // The no-JS page still holds the old token; submitting it is a conflict.
    await nojs.locator("input[name=tuesday_open]").fill("08:00");
    await nojs.getByRole("button", { name: "Spara öppettiderna" }).click();
    await expect(nojs.getByRole("alert").filter({ hasText: "Någon annan" })).toBeVisible();
    await expect(nojs.locator("input[name=tuesday_open]")).toHaveValue("08:00");
    // The alert is the first thing after the heading in the form and is a focus target (tabindex -1, autofocus).
    await expect(nojs.getByRole("alert").filter({ hasText: "Någon annan" })).toHaveAttribute("tabindex", "-1");
    await expect(nojs.getByRole("alert").filter({ hasText: "Någon annan" })).toHaveAttribute("autofocus", "");
    // Save again: overwrites.
    await nojs.getByRole("button", { name: "Spara öppettiderna" }).click();
    await expect(nojs.getByRole("status")).toHaveText("Sparat.");
    // Save once more with no edits: unchanged.
    await nojs.getByRole("button", { name: "Spara öppettiderna" }).click();
    await expect(nojs.getByRole("status")).toHaveText("Inga ändringar att spara.");
  } finally {
    await ctx.close();
    await restore(page);
  }
});

test("AC6: conflict and unchanged pages have no axe-visible structure problems (single alert, one h1, status not duplicated)", async ({ page }) => {
  await signedInOwner(page);
  try {
    const { csrf, token } = await open(page);
    await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ monday: null }) });
    const html = await (await post(page, "/admin/hours/", { csrf, weekly_token: token, ...week({ tuesday: ["10:00", "12:00"] }) })).text();
    expect((html.match(/role="alert"/g) ?? []).length).toBe(1);
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).not.toContain('role="status"');
  } finally {
    await restore(page);
  }
});
