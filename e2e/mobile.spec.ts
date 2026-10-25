import { expect, test, type Page } from "@playwright/test";

import { ensureOrder, newPage, SCREENS, type Ids } from "./critical-screens";
import { TICK_POLL_TIMEOUT_MS } from "./fixtures";

test.use({ storageState: { cookies: [], origins: [] } });

const PHONE = { width: 360, height: 740 };
const MIN_TARGET = 44;

let ids: Ids;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  ids = await ensureOrder(browser);
});

const overflow = (page: Page) =>
  page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));

// Visible controls smaller than 44 x 44. Exception: a link inside running text (its parent holds other text).
function smallTargets(page: Page) {
  return page.evaluate((min) => {
    const selector = "button, a[href], input:not([type=hidden]), [role=button]";
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        // sr-only / skip-link elements are 1 px or clipped: not a touch target.
        if (rect.width <= 1 || rect.height <= 1 || style.visibility === "hidden" || style.display === "none") return false;
        // Radix keeps an aria-hidden "bubble" input next to a checkbox: not a target.
        if (el.getAttribute("aria-hidden") === "true") return false;
        // A ::after that enlarges the hit area (Checkbox) counts as the target size.
        const after = getComputedStyle(el, "::after");
        if (after.position === "absolute") {
          const grow = (a: string, b: string) => -(parseFloat(a) || 0) - (parseFloat(b) || 0);
          if (rect.width + grow(after.left, after.right) >= min && rect.height + grow(after.top, after.bottom) >= min) return false;
        }
        const inText = el.tagName === "A" && style.display === "inline" && (el.parentElement?.textContent ?? "").trim() !== (el.textContent ?? "").trim();
        if (inText) return false;
        return rect.width < min || rect.height < min;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || "").trim().slice(0, 40)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      });
  }, MIN_TARGET);
}

for (const screen of SCREENS) {
  test(`360x740: ${screen.name}`, async ({ browser }) => {
    const { context, page } = await newPage(browser, screen.auth, { viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await screen.open(page, ids);
      const { scrollWidth, innerWidth } = await overflow(page);
      expect(scrollWidth, "no horizontal scroll").toBeLessThanOrEqual(innerWidth);
      expect(await smallTargets(page), `touch targets under ${MIN_TARGET}x${MIN_TARGET}`).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test(`360x740 with 200% font: ${screen.name}`, async ({ browser }) => {
    const { context, page } = await newPage(browser, screen.auth, { viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    try {
      await screen.open(page, ids);
      await page.addStyleTag({ content: "html{font-size:200%}" });
      const { scrollWidth, innerWidth } = await overflow(page);
      expect(scrollWidth, "no horizontal scroll at 200% font").toBeLessThanOrEqual(innerWidth);
    } finally {
      await context.close();
    }
  });
}

test("360x740: Bureau panel shows Menu and the drawer opens", async ({ browser }) => {
  const { context, page } = await newPage(browser, "staff", { viewport: PHONE, isMobile: true, hasTouch: true });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "Menu" }).click();
    const drawer = page.getByRole("dialog", { name: /Menu/ });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("navigation", { name: "Principal" })).toBeVisible();
    await drawer.getByRole("button", { name: "Fechar menu" }).click();
    await expect(drawer).toBeHidden();
  } finally {
    await context.close();
  }
});
