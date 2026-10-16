/**
 * Tester, M5.4: attacks on the opening-hours admin and what the public pages show after it,
 * against the built bistro Worker. Each test uses its own far-off dates and puts the week
 * back, so the order doesn't matter. "Today" tests remove what they add.
 */
import { expect, type Page, test } from "@playwright/test";
import { signedInOwner } from "./helpers";

const BASE = "http://localhost:8790";
const stockholmToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) => plusDays(stockholmToday(), n);
const group = (page: Page, name: string) => page.getByRole("group", { name });
const csrfOf = (page: Page) => page.locator("input[name=csrf]").first().inputValue();
const weeklyForm = (over: Record<string, string> = {}) => {
  const f: Record<string, string> = { action: "weekly" };
  for (const d of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]) {
    f[`${d}_open`] = "11:00";
    f[`${d}_close`] = "22:00";
  }
  return { ...f, ...over };
};
const exceptionForm = (date: string, over: Record<string, string> = {}) => ({
  action: "add-exception",
  date,
  closed: "on",
  exception_open: "",
  exception_close: "",
  note_sv: "Anledning",
  note_en: "Reason",
  ...over,
});
const jsonLd = async (page: Page, path = "/") => {
  await page.goto(path);
  return JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent()) ?? "{}");
};
const withAuth = async (page: Page) => {
  await signedInOwner(page);
  await page.goto("/admin/hours/");
  const csrf = await csrfOf(page);
  const post = (path: string, form: Record<string, string>, withCsrf = true) =>
    page.request.post(path, { form: withCsrf ? { csrf, ...form } : form, maxRedirects: 0, headers: { Origin: BASE } });
  return { csrf, post };
};
const exceptionsText = async (page: Page) => page.locator("#exceptions ul").innerText();
async function restoreWeek(page: Page) {
  const csrf = await csrfOf(page.url().includes("/admin/hours") ? page : (await page.goto("/admin/hours/"), page));
  await page.request.post("/admin/hours/", {
    form: { csrf, ...weeklyForm(), sunday_closed: "on", sunday_open: "", sunday_close: "" },
    maxRedirects: 0,
    headers: { Origin: BASE },
  });
}

test("closing after midnight is saved and shows as written on every public surface", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/hours/");
  const fri = group(page, "Fredag");
  await fri.getByLabel("Stängt").uncheck().catch(() => {});
  await fri.getByLabel("Öppnar").fill("18:00");
  await fri.getByLabel("Stänger").fill("01:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
  await expect(group(page, "Fredag").getByLabel("Stänger")).toHaveValue("01:00");

  await page.goto("/contact/");
  await expect(page.locator("main table tr", { hasText: "Fredag" })).toContainText("18:00–01:00");
  await expect(page.locator("footer")).toContainText("18:00–01:00");
  expect((await jsonLd(page)).openingHours).toContain("Fr 18:00-01:00");
  // The home badge shows the whole day's span on a Friday; on other days it is untouched.
  await page.goto("/admin/hours/");
  await group(page, "Fredag").getByLabel("Öppnar").fill("11:00");
  await group(page, "Fredag").getByLabel("Stänger").fill("22:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
});

test("open == close and closed-with-times: nothing is saved for the first, closed wins for the second", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/hours/");
  const mon = group(page, "Måndag");
  await mon.getByLabel("Stängt").uncheck().catch(() => {});
  await mon.getByLabel("Öppnar").fill("10:00");
  await mon.getByLabel("Stänger").fill("10:00");
  await group(page, "Tisdag").getByLabel("Öppnar").fill("09:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  expect(page.url()).toContain("/admin/hours/");
  await expect(page.locator("#monday-error")).toContainText("samma tid");
  await expect(mon.getByLabel("Öppnar")).toHaveValue("10:00");
  await expect(mon.getByLabel("Stänger")).toHaveValue("10:00");
  await expect(group(page, "Tisdag").getByLabel("Öppnar")).toHaveValue("09:00");
  await page.goto("/contact/");
  await expect(page.locator("main table tr", { hasText: "Måndag" })).not.toContainText("10:00–10:00");

  // Closed ticked with times filled: saved as closed, the times are dropped.
  await page.goto("/admin/hours/");
  await group(page, "Lördag").getByLabel("Stängt").check();
  await group(page, "Lördag").getByLabel("Öppnar").fill("10:00");
  await group(page, "Lördag").getByLabel("Stänger").fill("12:00");
  const before = await page.locator("main table").count();
  expect(before).toBe(0);
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
  await expect(group(page, "Lördag").getByLabel("Stängt")).toBeChecked();
  await expect(group(page, "Lördag").getByLabel("Öppnar")).toHaveValue("");
  await page.goto("/contact/");
  await expect(page.locator("main table tr", { hasText: "Lördag" })).toContainText("Stängt");
  expect((await jsonLd(page)).openingHours.some((h: string) => h.startsWith("Sa"))).toBe(false);
  await page.goto("/admin/hours/");
  await group(page, "Lördag").getByLabel("Stängt").uncheck();
  await group(page, "Lördag").getByLabel("Öppnar").fill("12:00");
  await group(page, "Lördag").getByLabel("Stänger").fill("23:00");
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.getByRole("status")).toHaveText("Sparat.");
});

test("a 422 on the week keeps every typed value, tick and error", async ({ page }) => {
  await signedInOwner(page);
  await page.goto("/admin/hours/");
  const set = async (day: string, open: string, close: string, closed: boolean) => {
    const g = group(page, day);
    if (closed) await g.getByLabel("Stängt").check();
    else await g.getByLabel("Stängt").uncheck();
    await g.getByLabel("Öppnar").fill(open);
    await g.getByLabel("Stänger").fill(close);
  };
  await set("Måndag", "09:15", "", false); // missing close
  await set("Tisdag", "10:00", "10:00", false); // same
  await set("Onsdag", "08:00", "09:00", true); // closed with times
  await set("Torsdag", "17:30", "02:45", false); // fine, after midnight
  await page.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(page.locator("#monday-error")).toBeVisible();
  await expect(page.locator("#tuesday-error")).toBeVisible();
  await expect(group(page, "Måndag").getByLabel("Öppnar")).toHaveValue("09:15");
  await expect(group(page, "Måndag").getByLabel("Stänger")).toHaveValue("");
  await expect(group(page, "Onsdag").getByLabel("Stängt")).toBeChecked();
  await expect(group(page, "Onsdag").getByLabel("Öppnar")).toHaveValue("08:00");
  await expect(group(page, "Torsdag").getByLabel("Öppnar")).toHaveValue("17:30");
  await expect(group(page, "Torsdag").getByLabel("Stänger")).toHaveValue("02:45");
  // The error group is marked invalid for assistive tech, the good one is not.
  await expect(group(page, "Måndag").getByLabel("Öppnar")).toHaveAttribute("aria-invalid", "true");
  await expect(group(page, "Torsdag").getByLabel("Öppnar")).not.toHaveAttribute("aria-invalid", "true");
  // Nothing was written: the public table still has the seeded Thursday.
  await page.goto("/contact/");
  await expect(page.locator("main table tr", { hasText: "Torsdag" })).not.toContainText("17:30");
});

test("raw posts: bad times, 24:00, seconds and junk are 422 and change nothing", async ({ page }) => {
  const { post } = await withAuth(page);
  const html = async () => (await page.request.get("/contact/")).text();
  const before = await html();
  for (const bad of ["24:00", "7:00", "07:00:00", "abc", "99:99", "07:60", "٠٧:00", "<b>", "a".repeat(5000)]) {
    const res = await post("/admin/hours/", weeklyForm({ wednesday_open: bad }));
    expect(res.status(), `time ${bad.slice(0, 10)}`).toBe(422);
  }
  // Unknown and missing action: no write, no 500.
  for (const action of ["", "nope", "WEEKLY", "weekly ", "remove_exception"]) {
    const res = await post("/admin/hours/", { ...weeklyForm({ monday_open: "01:00" }), action });
    expect([303, 400, 422], `action ${action}`).toContain(res.status());
  }
  const noAction = await post("/admin/hours/", Object.fromEntries(Object.entries(weeklyForm()).filter(([k]) => k !== "action")));
  expect([303, 400, 422]).toContain(noAction.status());
  expect(await html()).toBe(before);
});

test("an unknown action shows the owner some message rather than a silent empty page", async ({ page }) => {
  const { post } = await withAuth(page);
  const res = await post("/admin/hours/", { action: "nope" });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toBe("/admin/hours/?done=expired");
  await page.goto(res.headers().location);
  await expect(page.getByRole("status")).toHaveText("Formuläret hade gått ut. Försök igen.");
});

test("CSRF: all three actions are refused without a valid token and change nothing", async ({ page }) => {
  const { csrf, post } = await withAuth(page);
  const date = daysAhead(200);
  expect((await post("/admin/hours/", exceptionForm(date, { note_sv: "Behåll", note_en: "Keep" }))).status()).toBe(303);
  const bodies: Array<Record<string, string>> = [
    weeklyForm({ monday_open: "03:00" }),
    exceptionForm(daysAhead(201)),
    { action: "remove-exception", date },
  ];
  const page0 = await (await page.request.get("/admin/hours/")).text();
  for (const body of bodies) {
    for (const bad of [undefined, "", "garbage", csrf.slice(0, -1) + (csrf.endsWith("a") ? "b" : "a")]) {
      const res = await page.request.post("/admin/hours/", { form: bad === undefined ? body : { ...body, csrf: bad }, maxRedirects: 0, headers: { Origin: BASE } });
      expect([303, 403], `${body.action} csrf=${bad}`).toContain(res.status());
      if (res.status() === 303) expect(res.headers().location).toContain("done=expired");
    }
  }
  expect(await (await page.request.get("/admin/hours/")).text()).toBe(page0.replace(/name="csrf" value="[^"]+"/g, (m) => m));
  await page.goto("/admin/hours/");
  await expect(page.locator("#exceptions li", { hasText: "Behåll" })).toHaveCount(1);
  await expect(page.locator("#exceptions li", { hasText: daysAhead(201) })).toHaveCount(0);
  // A token from before sign-out and a request with no session never write.
  const anon = await page.context().browser()!.newContext({ baseURL: BASE });
  const res = await anon.request.post("/admin/hours/", { form: { csrf, ...weeklyForm({ monday_open: "03:00" }) }, maxRedirects: 0, headers: { Origin: BASE } });
  expect([303, 401, 403]).toContain(res.status());
  if (res.status() === 303) expect(res.headers().location).toMatch(/\/admin\/$/);
  await anon.close();
  await page.request.post("/admin/hours/", { form: { csrf, action: "remove-exception", date }, maxRedirects: 0, headers: { Origin: BASE } });
});

test("double submit of the same exception gives one row and one friendly duplicate message", async ({ page }) => {
  const { post } = await withAuth(page);
  const date = daysAhead(300);
  const results = await Promise.all([post("/admin/hours/", exceptionForm(date)), post("/admin/hours/", exceptionForm(date)), post("/admin/hours/", exceptionForm(date))]);
  const statuses = results.map((r) => r.status()).sort();
  expect(statuses).toEqual([303, 422, 422]);
  for (const r of results.filter((x) => x.status() === 422)) expect(await r.text()).toContain("redan en avvikande dag");
  await page.goto("/admin/hours/");
  await expect(page.locator("#exceptions li")).toHaveCount(1);
  // Remove twice at once: both answer with a redirect, one says deleted, one not-found.
  const csrf = await csrfOf(page);
  const rm = () => page.request.post("/admin/hours/", { form: { csrf, action: "remove-exception", date }, maxRedirects: 0, headers: { Origin: BASE } });
  const gone = await Promise.all([rm(), rm()]);
  expect(gone.map((r) => r.status())).toEqual([303, 303]);
  expect(gone.map((r) => r.headers().location).join()).toMatch(/done=deleted/);
});

test("exception dates: today ok, yesterday refused, +2 years exactly, one day more refused, garbage refused", async ({ page }) => {
  const { post } = await withAuth(page);
  const today = stockholmToday();
  const limit = (() => {
    const [y, m, d] = today.split("-").map(Number);
    const last = new Date(Date.UTC(y + 2, m, 0)).getUTCDate();
    return `${y + 2}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  })();
  const cases: Array<[string, number]> = [
    [plusDays(today, -1), 422],
    [plusDays(limit, 1), 422],
    ["2027-02-29", 422],
    ["not-a-date", 422],
    ["", 422],
    ["2026-13-45", 422],
    ["99999-01-01", 422],
    [today, 303],
    [limit, 303],
  ];
  for (const [date, status] of cases) expect((await post("/admin/hours/", exceptionForm(date))).status(), date).toBe(status);
  await page.goto("/admin/hours/");
  await expect(page.locator("#exceptions li")).toHaveCount(2);
  // Both now show on the public contact list; clean up.
  await page.goto("/contact/");
  await expect(page.locator("main li", { has: page.locator(`time[datetime="${today}"]`) })).toContainText("Anledning");
  await expect(page.locator("main li", { has: page.locator(`time[datetime="${limit}"]`) })).toBeVisible();
  const csrf = await csrfOf((await page.goto("/admin/hours/"), page));
  for (const date of [today, limit]) await post("/admin/hours/", { action: "remove-exception", date });
  void csrf;
});

test("a closed exception for today wins on the home badge, in sv and en, and goes away when removed", async ({ page }) => {
  const { post } = await withAuth(page);
  const today = stockholmToday();
  expect((await post("/admin/hours/", exceptionForm(today, { note_sv: "Privat fest", note_en: "Private party" }))).status()).toBe(303);
  await page.goto("/");
  await expect(page.locator(".hours-badge")).toContainText("Idag: Stängt");
  await page.goto("/en/");
  await expect(page.locator(".hours-badge")).toContainText("Today: Closed");
  await page.goto("/en/contact/");
  await expect(page.locator("main li", { has: page.locator(`time[datetime="${today}"]`) })).toContainText("Private party");
  await post("/admin/hours/", { action: "remove-exception", date: today });
  await page.goto("/");
  await expect(page.locator(".hours-badge")).not.toContainText("Stängt");
});

test("special hours past midnight for today show on the home badge", async ({ page }) => {
  const { post } = await withAuth(page);
  const today = stockholmToday();
  await post("/admin/hours/", exceptionForm(today, { closed: "", exception_open: "18:00", exception_close: "02:00" }));
  await page.goto("/");
  await expect(page.locator(".hours-badge")).toContainText("18:00–02:00");
  await post("/admin/hours/", { action: "remove-exception", date: today });
});

test("exceptions are in the JSON-LD (special opening hours) so search engines don't show a closed day as open", async ({ page }) => {
  const { post } = await withAuth(page);
  const date = daysAhead(60);
  await post("/admin/hours/", exceptionForm(date));
  const ld = await jsonLd(page);
  const serialised = JSON.stringify(ld);
  await post("/admin/hours/", { action: "remove-exception", date });
  expect(serialised, "JSON-LD never mentions the exception").toContain(date);
});

test("exceptions are visible in the footer's opening hours as the admin text promises", async ({ page }) => {
  const { post } = await withAuth(page);
  const date = daysAhead(61);
  await post("/admin/hours/", exceptionForm(date, { note_sv: "Midsommar", note_en: "Midsummer" }));
  await page.goto("/");
  const footer = await page.locator("footer.section-dark").innerText();
  await post("/admin/hours/", { action: "remove-exception", date });
  expect(footer, "footer ignores exceptions").toContain("Midsommar");
});

test("notes: exactly 300 accepted, 301 refused with both values kept, whitespace-only refused", async ({ page }) => {
  const { post } = await withAuth(page);
  const ok = await post("/admin/hours/", exceptionForm(daysAhead(70), { note_sv: "å".repeat(300), note_en: "e".repeat(300) }));
  expect(ok.status()).toBe(303);
  const long = await post("/admin/hours/", exceptionForm(daysAhead(71), { note_sv: "å".repeat(301), note_en: "kept-en" }));
  expect(long.status()).toBe(422);
  const html = await long.text();
  expect(html).toContain("kept-en");
  expect(html).toMatch(/300/);
  for (const n of [" ", "​", "‮"]) {
    expect((await post("/admin/hours/", exceptionForm(daysAhead(72), { note_sv: n }))).status()).toBe(422);
  }
  await page.goto("/admin/hours/");
  await expect(page.locator("#exceptions li", { hasText: "ååå" })).toHaveCount(1);
  await expect(page.locator("#exceptions li", { hasText: daysAhead(72) })).toHaveCount(0);
  await expect(page.locator("#exceptions li", { hasText: daysAhead(71) })).toHaveCount(0);
  // A 300-character note does not blow the page layout out at 375px.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/admin/hours/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "admin overflows with a 300-char note").toBeLessThanOrEqual(0);
  await page.goto("/contact/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "contact overflows with a 300-char note").toBeLessThanOrEqual(0);
  await post("/admin/hours/", { action: "remove-exception", date: daysAhead(70) });
});

test("markup in a note is escaped in the admin and on the public pages", async ({ page }) => {
  const { post } = await withAuth(page);
  const date = daysAhead(80);
  await post("/admin/hours/", exceptionForm(date, { note_sv: `<img src=x onerror="window.pwned=1">`, note_en: `"><script>window.pwned=1</script>` }));
  for (const [path, shown] of [["/admin/hours/", "<img src=x"], ["/contact/", "<img src=x"], ["/en/contact/", "<script>window.pwned=1</script>"]]) {
    await page.goto(path);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
    await expect(page.locator("main")).toContainText(shown);
  }
  await post("/admin/hours/", { action: "remove-exception", date });
});

test("remove with garbage, empty and absent dates is a clean not-found, never a 500", async ({ page }) => {
  const { post } = await withAuth(page);
  for (const date of ["", "garbage", "2026-12-24' OR 1=1 --", "%", "2099-12-31", "x".repeat(5000)]) {
    const res = await post("/admin/hours/", { action: "remove-exception", date });
    expect(res.status(), date.slice(0, 20)).toBe(303);
    expect(res.headers().location).toContain("done=not-found");
  }
  const noDate = await post("/admin/hours/", { action: "remove-exception" });
  expect(noDate.status()).toBe(303);
  await page.goto("/admin/hours/?done=not-found");
  await expect(page.getByRole("status")).toBeVisible();
});

test("the English admin stays under /en/admin/ through every redirect and shows English text", async ({ page }) => {
  const { post } = await withAuth(page);
  void post;
  await page.goto("/en/admin/hours/");
  await expect(page.getByRole("heading", { name: "Opening hours", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Opening hours" }).first()).toBeVisible();
  const date = daysAhead(90);
  await page.getByLabel("Date").fill(date);
  await page.getByLabel("Reason in Swedish").fill("Semester");
  await page.getByLabel("Reason in English").fill("Holiday");
  await page.getByRole("button", { name: "Add a day" }).click();
  expect(page.url()).toMatch(/\/en\/admin\/hours\/\?done=added#exceptions$/);
  await expect(page.getByRole("status")).toHaveText("Added.");
  await group(page, "Sunday").getByLabel("Opens").fill("12:00");
  await page.getByRole("button", { name: "Save opening hours" }).click();
  expect(page.url()).toMatch(/\/en\/admin\/hours\/\?done=saved/);
  await page.locator("#exceptions li", { hasText: "Holiday" }).getByRole("button", { name: /Remove/ }).click();
  expect(page.url()).toMatch(/\/en\/admin\/hours\/\?done=deleted/);
  await expect(page.getByRole("status")).toHaveText("Deleted.");
  // Expired form, in English.
  const res = await page.request.post("/en/admin/hours/", { form: { csrf: "bad", action: "weekly" }, maxRedirects: 0, headers: { Origin: BASE } });
  expect(res.headers().location).toMatch(/^\/en\/admin\/hours\/\?done=expired/);
  // Error messages come in English, and the date text uses English.
  await page.goto("/en/admin/hours/");
  await page.getByLabel("Date").fill(daysAhead(-2));
  await page.getByLabel("Reason in Swedish").fill("x");
  await page.getByLabel("Reason in English").fill("x");
  await page.getByRole("button", { name: "Add a day" }).click();
  await expect(page.locator("#date-error")).toHaveText("That date has already passed.");
});

test("westafrican's hours are untouched by a bistro save (public pages of the other demo don't exist here)", async ({ page }) => {
  // Guard on the form itself: a posted siteId or site field must be ignored.
  const { post } = await withAuth(page);
  const res = await post("/admin/hours/", { ...weeklyForm({ monday_open: "04:00" }), site: "westafrican", site_id: "westafrican", siteId: "westafrican" });
  expect(res.status()).toBe(303);
  await page.goto("/admin/hours/");
  await expect(group(page, "Måndag").getByLabel("Öppnar")).toHaveValue("04:00");
  await restoreWeek(page);
});

test("375px: no horizontal overflow on the hours page and every control is at least 44px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const { post } = await withAuth(page);
  const date = daysAhead(95);
  await post("/admin/hours/", exceptionForm(date, { note_sv: "Lång anledning ".repeat(15), note_en: "Long reason ".repeat(15) }));
  await page.goto("/admin/hours/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("main button, main input:not([type=hidden]):not([type=checkbox]), main select, main a")]
      .filter((e) => e.offsetParent)
      .map((e) => ({ tag: e.tagName, name: (e as HTMLInputElement).name || e.textContent?.trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height), w: Math.round(e.getBoundingClientRect().width) }))
      .filter((e) => e.h < 44 || e.w < 44),
  );
  expect(small, "targets under 44px").toEqual([]);
  // Checkbox labels are the targets for the ticks.
  const ticks = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement>("main input[type=checkbox]")].map((c) => Math.round((c.closest("label") ?? c).getBoundingClientRect().height)),
  );
  expect(Math.min(...ticks)).toBeGreaterThanOrEqual(44);
  // Time inputs sit side by side without overlapping.
  const overlap = await page.evaluate(() => {
    const [a, b] = [...document.querySelectorAll("fieldset")[0].querySelectorAll("input[type=time]")].map((e) => e.getBoundingClientRect());
    return a.right > b.left;
  });
  expect(overlap).toBe(false);
  // The remove button's accessible name carries the date.
  await expect(page.getByRole("button", { name: /Ta bort: .*/ }).first()).toBeVisible();
  await post("/admin/hours/", { action: "remove-exception", date });
  const focus = await page.evaluate(() => getComputedStyle(document.querySelector<HTMLElement>(".admin-button")!).minHeight);
  expect(parseFloat(focus)).toBeGreaterThanOrEqual(44);
});

test("no JavaScript: save week, add exception, reject a bad one, remove", async ({ page, browser }) => {
  await signedInOwner(page);
  const noJs = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
  await noJs.addCookies(await page.context().cookies());
  const p = await noJs.newPage();
  await p.goto("/admin/hours/");
  await group(p, "Söndag").getByLabel("Stängt").uncheck();
  await group(p, "Söndag").getByLabel("Öppnar").fill("13:00");
  await group(p, "Söndag").getByLabel("Stänger").fill("15:30");
  await p.getByRole("button", { name: "Spara öppettiderna" }).click();
  await expect(p.getByRole("status")).toHaveText("Sparat.");
  const date = daysAhead(120);
  await p.getByLabel("Datum").fill(date);
  await p.getByLabel("Anledning på svenska").fill("Utan JS");
  await p.getByLabel("Anledning på engelska").fill("No JS");
  await p.getByRole("button", { name: "Lägg till dag" }).click();
  await expect(p.getByRole("status")).toHaveText("Tillagt.");
  await p.getByLabel("Datum").fill(date);
  await p.getByLabel("Anledning på svenska").fill("Dubblett");
  await p.getByLabel("Anledning på engelska").fill("Dup");
  await p.getByRole("button", { name: "Lägg till dag" }).click();
  await expect(p.locator("#date-error")).toContainText("redan en avvikande dag");
  await expect(p.getByLabel("Anledning på svenska")).toHaveValue("Dubblett");
  await p.locator("#exceptions li", { hasText: "Utan JS" }).getByRole("button", { name: /Ta bort/ }).click();
  await expect(p.getByRole("status")).toHaveText("Borttaget.");
  await noJs.close();
  await restoreWeek(page);
});

test("a signed-out visitor is bounced from the hours page and from posts to it", async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: BASE });
  const get = await ctx.request.get("/admin/hours/", { maxRedirects: 0 });
  expect([302, 303]).toContain(get.status());
  const en = await ctx.request.get("/en/admin/hours/", { maxRedirects: 0 });
  expect(en.headers().location ?? "").toMatch(/^\/en\/admin\//);
  const post = await ctx.request.post("/admin/hours/", { form: { action: "weekly" }, maxRedirects: 0, headers: { Origin: BASE } });
  expect([302, 303, 401, 403]).toContain(post.status());
  const other = await ctx.request.get("/fr/admin/hours/", { maxRedirects: 0 });
  expect(other.status()).toBe(404);
  await ctx.close();
});

test("the hours page is not cacheable and does not leak the CSRF token into public pages", async ({ page }) => {
  await signedInOwner(page);
  const res = await page.request.get("/admin/hours/");
  expect(res.headers()["cache-control"] ?? "").toMatch(/no-store|private/);
  const csrf = await (async () => (await page.goto("/admin/hours/"), csrfOf(page)))();
  expect(await (await page.request.get("/contact/")).text()).not.toContain(csrf);
});
