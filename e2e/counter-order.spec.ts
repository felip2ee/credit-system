import { expect, test } from "@playwright/test";

import { TICK_POLL_TIMEOUT_MS, authorizeScr, E2E, orderState, runTick, STAFF_STATE, validCpf } from "./fixtures";

test.use({ storageState: STAFF_STATE });

test("staff opens a counter order, registers the payment and reaches ready", async ({ page, request }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  await page.goto("/dossiers/new");
  await page.getByLabel("Produto").selectOption(E2E.product);
  await page.getByLabel("CPF").fill(validCpf());
  await page.getByLabel("Nome").fill("e2e Titular Balcão");
  await page.getByLabel("E-mail do titular").fill(`e2e-holder-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Abrir pedido" }).click();
  await expect(page).toHaveURL(/\/dossiers\/[0-9a-f-]{36}$/);
  const dossierId = page.url().split("/").pop() as string;
  expect(await orderState(dossierId)).toBe("awaiting_payment");

  await page.goto(`/settings/counter-payments?dossier=${dossierId}`);
  await page.getByLabel("Valor (R$)").fill(E2E.salePrice.replace(".", ","));
  await page.getByRole("button", { name: "Registrar pagamento" }).click();
  await expect(page.getByText("Quitado")).toBeVisible();

  await authorizeScr(page, request, dossierId);
  await runTick(request);
  await expect.poll(() => orderState(dossierId), { message: "order is promoted to ready", timeout: 10_000 }).toBe("ready");

  await page.goto(`/dossiers/${dossierId}`);
  await expect(page.getByText("Na fila").first()).toBeVisible();
});
