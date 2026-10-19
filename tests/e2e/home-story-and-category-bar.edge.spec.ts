/**
 * Tester sweep of the 18 Oct owner-review changes: the home page's story opening and the menu's
 * category bar (fade, marking, sticky). Runs against either demo (E2E_SITE).
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const axe = async (page: Page, what: string) => {
  const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`),
    what,
  ).toEqual([]);
};

test("the home page has one h1 and h2s in order, with the story section among them, in both languages", async ({ page }) => {
  for (const path of ["/", "/en/"]) {
    await page.goto(path);
    const levels = await page.evaluate(() => [...document.querySelectorAll("main h1, main h2, main h3")].map((h) => `${h.tagName}:${h.textContent?.trim()}`));
    expect(
      levels.filter((l) => l.startsWith("H1")),
      path,
    ).toHaveLength(1);
    expect(
      levels.some((l) => /^H2:(Vår historia|Our story)/.test(l)),
      `${path} ${levels.join(" | ")}`,
    ).toBe(true);
    const jumps = await page.evaluate(() => {
      const hs = [...document.querySelectorAll("h1,h2,h3,h4")].map((h) => Number(h.tagName[1]));
      return hs.filter((n, i) => i > 0 && n - hs[i - 1] > 1);
    });
    expect(jumps, `${path} skips a heading level`).toEqual([]);
  }
});

test("the home story is shown as text, once, with the link to About, at phone and desktop width", async ({ page }) => {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator("section.home-story")).toHaveCount(1);
    const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    expect(scroll).toBeLessThanOrEqual(client);
    await axe(page, `home at ${width}`);
  }
});

test("axe finds nothing on the menu at phone and desktop width, both languages", async ({ page }) => {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/menu/", "/en/menu/"]) {
      await page.goto(path);
      await axe(page, `${path} at ${width}`);
      // and with a category marked
      await page.locator(".menu-cat").last().scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 100);
      await expect(page.locator("nav.catbar a[aria-current]")).toHaveCount(1);
      await axe(page, `${path} at ${width}, a category marked`);
    }
  }
});

test("a bar that fits has no fade, on a very wide screen", async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1000 });
  await page.goto("/menu/");
  await expect(page.locator(".catbar-wrap")).toHaveAttribute("data-more", "none");
  expect(await page.locator(".catbar-wrap").evaluate((el) => [getComputedStyle(el, "::before").opacity, getComputedStyle(el, "::after").opacity])).toEqual(["0", "0"]);
});

test("a single category leaves the bar with no fade, and a very long name makes it scroll without widening the page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/menu/");
  await page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLElement>("nav.catbar a")];
    links.slice(1).forEach((l) => l.remove());
    window.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".catbar-wrap")).toHaveAttribute("data-more", "none");
  await page.evaluate(() => {
    document.querySelector("nav.catbar a")!.textContent = "Mycket långa förrätter och smårätter att dela med hela bordet och familjen ".repeat(2);
    window.dispatchEvent(new Event("resize"));
  });
  await expect(page.locator(".catbar-wrap")).toHaveAttribute("data-more", "right");
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client);
});

test("tapping a category settles on that category's mark with no flicker between two", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/menu/");
  await page.evaluate(() => {
    (window as unknown as { marks: string[] }).marks = [];
    new MutationObserver(() => {
      const a = document.querySelector("nav.catbar a[aria-current]");
      (window as unknown as { marks: string[] }).marks.push(a?.getAttribute("href") ?? "none");
    }).observe(document.querySelector("nav.catbar")!, { attributes: true, subtree: true, attributeFilter: ["aria-current"] });
  });
  const hrefs = await page.locator("nav.catbar a").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  for (const href of [hrefs[2], hrefs[hrefs.length - 1], hrefs[1]]) {
    await page.evaluate(() => ((window as unknown as { marks: string[] }).marks = []));
    await page.locator(`nav.catbar a[href="${href}"]`).click();
    await page.waitForTimeout(1500);
    const marks = await page.evaluate(() => (window as unknown as { marks: string[] }).marks);
    const settled = await page.locator("nav.catbar a[aria-current]").getAttribute("href");
    // Report: what it settled on, and the sequence (a clean jump has at most a few changes).
    const changes = marks.filter((m, i) => i === 0 || m !== marks[i - 1]);
    expect(changes.length, `${href}: ${changes.join(" > ")}`).toBeLessThanOrEqual(4);
    expect(settled, `after tapping ${href}, sequence ${changes.join(" > ")}`).toBe(href);
    // The heading clears the sticky bar.
    const [headTop, barBottom] = await page.evaluate(
      (h) => [document.querySelector(h!)!.getBoundingClientRect().top, document.querySelector(".catbar-wrap")!.getBoundingClientRect().bottom],
      href,
    );
    expect(headTop, `${href} hidden under the bar`).toBeGreaterThanOrEqual(barBottom - 1);
  }
});

test("under reduced motion the bar still marks and centres the category, with no smooth scroll", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 320, height: 640 } });
  const page = await context.newPage();
  await page.goto("/menu/");
  await page.locator(".menu-cat").last().scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 150);
  await expect(page.locator("nav.catbar a[aria-current]")).toHaveCount(1);
  await expect(page.locator(".catbar-wrap")).toHaveAttribute("data-more", /left|both/);
  expect(await page.locator(".catbar-wrap").evaluate((el) => getComputedStyle(el, "::after").transitionDuration)).toMatch(/^(0s|1e-05s)$/);
  await context.close();
});

test("tabbing through the bar shows a visible focus ring and never leaves the focused link under a fade", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/menu/");
  const count = await page.locator("nav.catbar a").count();
  await page.locator("nav.catbar a").first().focus();
  for (let i = 0; i < count; i++) {
    const r = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement;
      const bar = a.closest("nav")!.getBoundingClientRect();
      const box = a.getBoundingClientRect();
      const fade = 48;
      const wrap = a.closest(".catbar-wrap") as HTMLElement;
      const more = wrap.dataset.more;
      const underLeft = (more === "left" || more === "both") && box.left < bar.left + fade;
      const underRight = (more === "right" || more === "both") && box.right > bar.right - fade;
      const cs = getComputedStyle(a);
      return {
        href: a.getAttribute("href"),
        underLeft,
        underRight,
        outline: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        ring: cs.boxShadow,
        within: box.left >= bar.left - 1 && box.right <= bar.right + 1,
      };
    });
    expect(r.outline !== "none" || r.ring !== "none", `no focus indicator on ${r.href}`).toBe(true);
    expect(r.within, `${r.href} is outside the bar`).toBe(true);
    expect(r.underLeft || r.underRight, `${r.href} sits under a fade (${JSON.stringify(r)})`).toBe(false);
    await page.keyboard.press("Tab");
  }
});

test("the bar sticks while scrolling, with a solid background and nothing showing through", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/menu/");
    await page.locator(".menu-cat").nth(2).scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const w = document.querySelector(".catbar-wrap")!;
      const bg = getComputedStyle(w).backgroundColor;
      const box = w.getBoundingClientRect();
      const topEl = document.elementFromPoint(box.left + box.width / 2, box.top + box.height - 2);
      return { top: box.top, bg, inside: !!topEl && !!w.contains(topEl) };
    });
    expect(r.top, `at ${width}`).toBeCloseTo(0, 0);
    expect(r.bg).not.toMatch(/rgba\(.*, 0\)/);
    expect(r.inside, "page content is above the bar").toBe(true);
  }
});

test("the marked category keeps WCAG AA contrast", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/menu/");
  await page.locator(".menu-cat").nth(1).scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 100);
  const a = page.locator("nav.catbar a[aria-current]");
  await expect(a).toHaveCount(1);
  const ratio = await a.evaluate((el) => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const cs = getComputedStyle(el);
    let bgc = parse(cs.backgroundColor);
    if (bgc.length === 4 && bgc[3] === 0) bgc = parse(getComputedStyle(document.querySelector(".catbar-wrap")!).backgroundColor);
    const [l1, l2] = [lum(parse(cs.color)), lum(bgc)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test("the sticky wrapper adds no layout shift to the menu or the home page", async ({ page }) => {
  for (const path of ["/menu/", "/"]) {
    await page.addInitScript(() => {
      (window as unknown as { cls: number }).cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) (window as unknown as { cls: number }).cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto(path, { waitUntil: "networkidle" });
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { cls: number }).cls), path).toBeLessThan(0.02);
  }
});

test("clicking a link that is partly under a fade still follows it (the bar doesn't move under the pointer)", async ({ page }) => {
  // CI, 18 Oct: re-centring on focus moved the bar between press and release, so the browser
  // fired no click. Re-centring is for keyboard focus only.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/menu/");
  const bar = page.locator("nav.catbar");
  // Scroll the bar so the second link straddles the left edge: its right half under the fade.
  const href = await bar.evaluate((el) => {
    const link = el.querySelectorAll("a")[1] as HTMLElement;
    el.scrollLeft += link.getBoundingClientRect().left + link.getBoundingClientRect().width / 2 - el.getBoundingClientRect().left - 16;
    el.dispatchEvent(new Event("scroll"));
    return link.getAttribute("href")!;
  });
  await expect(page.locator(".catbar-wrap")).toHaveAttribute("data-more", /left|both/);
  const box = (await bar.locator(`a[href="${href}"]`).boundingBox())!;
  const frame = (await bar.boundingBox())!;
  // Press inside the bar, on the link, under the left fade.
  const x = frame.x + 24;
  expect(box.x < x && x < box.x + box.width, "the link doesn't straddle the left fade").toBe(true);
  await page.mouse.click(x, box.y + box.height / 2);
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});
