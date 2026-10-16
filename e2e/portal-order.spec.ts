import { expect, test } from "@playwright/test";

import { TICK_POLL_TIMEOUT_MS, authorizeScr, CLIENT_STATE, orderState, runTick } from "./fixtures";

test.use({ storageState: CLIENT_STATE });

test("client buys a self-research order until it is ready", async ({ page, request }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  await page.goto("/portal/pesquisas/nova");
  await page.getByRole("radio", { name: /Consulta PF/ }).check();
  await page.getByRole("radio", { name: /Para mim/ }).check();
  await page.getByRole("button", { name: "Confirmar pedido" }).click();
  await expect(page).toHaveURL(/\/portal\/pesquisas\/[0-9a-f-]{36}$/);
  const dossierId = page.url().split("/").pop() as string;

  await page.goto("/portal/pesquisas");
  await expect(page.getByText("Aguardando autorização do titular").first()).toBeVisible();

  await authorizeScr(page, request, dossierId);
  await runTick(request);
  await expect.poll(() => orderState(dossierId), { message: "order is promoted to ready", timeout: 10_000 }).toBe("ready");

  await page.goto("/portal/pesquisas");
  await expect(page.getByText("Na fila").first()).toBeVisible();
});
