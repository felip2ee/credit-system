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

// Sem `isMobile`: no modo celular o viewport de layout cresce junto com o conteúdo e esconde o que sai da tela.
test("360x740 com fonte 200%: barra inferior, título da etapa e nome do pedido continuam legíveis", async ({ browser }) => {
  const { context, page } = await newPage(browser, "client", { viewport: PHONE });
  try {
    await page.goto("/portal/pesquisas");
    await page.addStyleTag({ content: "html{font-size:200%}" });
    for (const link of await page.getByRole("navigation", { name: "Principal" }).getByRole("link").all()) {
      await expect(link).toBeInViewport({ ratio: 0.99 });
    }
    // Nome espremido pelo valor virava uma letra por linha.
    const name = page.locator('main a[href^="/portal/pesquisas/"] span.font-bold').first();
    expect((await name.boundingBox())?.width).toBeGreaterThan(120);
    await page.goto("/portal/pesquisas/nova");
    await page.addStyleTag({ content: "html{font-size:200%}" });
    for (const text of [page.getByRole("heading", { level: 1 }), page.getByText("Passo 1 de", { exact: false }).first()]) {
      expect(await text.evaluate((el) => el.scrollWidth - el.clientWidth), "texto do cabeçalho sem corte").toBeLessThanOrEqual(0);
    }
    // A barra inferior não pode crescer por cima do rodapé preso da etapa.
    const next = await page.getByRole("button", { name: "Continuar" }).boundingBox();
    const bar = await page.getByRole("navigation", { name: "Principal" }).boundingBox();
    expect((next?.y ?? 0) + (next?.height ?? 0), "Continuar acima da barra inferior").toBeLessThanOrEqual(bar?.y ?? 0);
    // O saldo não pode quebrar no meio do número: uma linha de até 2,5rem mede menos de 80 px.
    await page.goto("/portal/credits");
    await page.addStyleTag({ content: "html{font-size:200%}" });
    expect((await page.locator("main p.tabular-nums").first().boundingBox())?.height, "saldo em uma linha").toBeLessThan(80);
  } finally {
    await context.close();
  }
});

// Controle focado cujo centro está debaixo de uma barra fixa ou presa (sticky).
const coveredFocus = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (hit && (el.contains(hit) || hit.contains(el))) return null;
    let bar: Element | null = hit;
    while (bar && !["fixed", "sticky"].includes(getComputedStyle(bar).position)) bar = bar.parentElement;
    return bar && !bar.contains(el) ? (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40) : null;
  });

for (const path of ["/portal/pesquisas/nova", "/portal/perfil"]) {
  test(`320x640: o foco do teclado não fica sob barras fixas em ${path}`, async ({ browser }) => {
    const { context, page } = await newPage(browser, "client", { viewport: { width: 320, height: 640 } });
    try {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const controls = await page.locator("a[href]:visible, button:visible, input:visible, summary:visible").count();
      const covered: string[] = [];
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < controls; i++) {
          await page.keyboard.press(key);
          const found = await coveredFocus(page);
          if (found !== null) covered.push(`${key}: ${found}`);
        }
      }
      expect(covered).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
