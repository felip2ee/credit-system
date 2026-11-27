import { expect, test, type Page } from "@playwright/test";

import { newPage } from "./critical-screens";
import { TICK_POLL_TIMEOUT_MS } from "./fixtures";
import { loadRouteIds, ROUTES, type RouteIds } from "./reflow-routes";

// WCAG 1.4.10 (reflow): at 360 CSS px and at 200% text size the page does not scroll sideways.
// No `isMobile`: in mobile mode the layout viewport grows with the content and hides the overflow.
test.use({ storageState: { cookies: [], origins: [] } });

const PHONE = { width: 360, height: 740 };

let ids: RouteIds;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  ids = await loadRouteIds(browser);
});

// Elements whose box ends past the layout viewport: the cause, named in the failure message.
const sideways = (page: Page) =>
  page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const culprits = Array.from(document.body.querySelectorAll<HTMLElement>("*"))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.right > width + 0.5 && !el.closest("[data-sr-clipped], .sr-only");
      })
      .filter((el) => el.children.length === 0 || el.tagName === "BUTTON" || el.tagName === "A")
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").trim().slice(0, 30)}" right=${Math.round(el.getBoundingClientRect().right)}`);
    return { scrollWidth: document.documentElement.scrollWidth, clientWidth: width, culprits };
  });

for (const zoom of [100, 200]) {
  for (const route of ROUTES) {
    test(`360px, texto a ${zoom}%: sem rolagem horizontal em ${route.name}`, async ({ browser }) => {
      const { context, page } = await newPage(browser, route.auth, { viewport: PHONE });
      try {
        await page.goto(route.path(ids));
        await page.waitForLoadState("networkidle");
        if (zoom !== 100) await page.addStyleTag({ content: `html{font-size:${zoom}%}` });
        const { scrollWidth, clientWidth, culprits } = await sideways(page);
        expect(scrollWidth - clientWidth, `scrollWidth ${scrollWidth} > ${clientWidth}: ${culprits.join(" | ")}`).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }
}

// Diálogo aberto a 200%: nenhum controle sai da tela (o "Voltar" de um diálogo com ações à direita saía pela esquerda).
const DIALOGS = [
  { name: "recarregar carteira", auth: "admin", path: () => "/settings/wallet", open: "Recarregar" },
  { name: "cancelar pedido (portal)", auth: "client", path: (i: RouteIds) => `/portal/pesquisas/${i.dossierId}`, open: "Cancelar pedido" },
  { name: "cancelar pedido (Bureau)", auth: "staff", path: (i: RouteIds) => `/dossiers/${i.dossierId}`, open: "Cancelar pedido" },
] as const;

for (const dialog of DIALOGS) {
  test(`360px, texto a 200%: diálogo ${dialog.name} sem controle fora da tela`, async ({ browser }) => {
    const { context, page } = await newPage(browser, dialog.auth, { viewport: PHONE });
    try {
      await page.goto(dialog.path(ids));
      await page.waitForLoadState("networkidle");
      await page.addStyleTag({ content: "html{font-size:200%}" });
      await page.getByRole("button", { name: dialog.open, exact: true }).first().click();
      const open = page.locator("dialog[open]");
      await expect(open).toBeVisible();
      const outside = await open.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return Array.from(el.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea"))
          .map((c) => ({ c, r: c.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5))
          .map(({ c, r }) => `${c.tagName.toLowerCase()} "${(c.textContent ?? "").trim().slice(0, 25)}" ${Math.round(r.left)}..${Math.round(r.right)} (diálogo ${Math.round(box.left)}..${Math.round(box.right)})`);
      });
      expect(outside, "controles fora do diálogo").toEqual([]);
    } finally {
      await context.close();
    }
  });
}
