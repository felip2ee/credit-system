import { expect, test, type Page } from "@playwright/test";

import { newPage } from "./critical-screens";

const PHONE = { width: 360, height: 740 };

// Computed padding-top of the first element that carries a `dense:p-4` class.
const firstDensePadding = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[class*="dense:p-4"]');
    return el ? getComputedStyle(el).paddingTop : null;
  });

const baseFont = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".area-portal")!).fontSize);

test("portal: a base é 16 px e o layout tem .portal-dense", async ({ browser }) => {
  const { context, page } = await newPage(browser, "client", { viewport: PHONE });
  try {
    await page.goto("/portal");
    await expect(page.locator(".area-portal.portal-dense")).toHaveCount(1);
    expect(await baseFont(page)).toBe("16px");
  } finally {
    await context.close();
  }
});

test("portal: o padding do primeiro CardContent é 16 px", async ({ browser }) => {
  const { context, page } = await newPage(browser, "client", { viewport: PHONE });
  try {
    await page.goto("/portal");
    expect(await firstDensePadding(page)).toBe("16px");
  } finally {
    await context.close();
  }
});

test("login e landing mantêm 18 px", async ({ browser }) => {
  const { context, page } = await newPage(browser, "none", { viewport: PHONE });
  try {
    await page.goto("/login");
    await expect(page.locator(".portal-dense")).toHaveCount(0);
    expect(await baseFont(page)).toBe("18px");
  } finally {
    await context.close();
  }
});

test("admin não recebe a densidade", async ({ browser }) => {
  const { context, page } = await newPage(browser, "staff", { viewport: PHONE });
  try {
    await page.goto("/");
    expect(await page.evaluate(() => document.querySelector(".portal-dense"))).toBeNull();
    expect(await firstDensePadding(page)).toBe("24px");
  } finally {
    await context.close();
  }
});
