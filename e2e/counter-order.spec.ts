import { expect, test } from "@playwright/test";

import { TICK_POLL_TIMEOUT_MS, authorizeScr, E2E, orderState, runTick, STAFF_STATE, validCnpj, validCpf } from "./fixtures";

test.use({ storageState: STAFF_STATE });

const PARTNER_COUNT = 2;
// Dossiê Empresarial: base price + per-partner price × distinct partners.
const TOTAL = (Number(E2E.salePrice) + Number(E2E.salePricePerPartner) * PARTNER_COUNT).toFixed(2);

test("staff opens a counter Dossiê Empresarial with 2 partners, registers the payment and reaches ready", async ({ page, request }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  const stamp = Date.now();
  await page.goto("/dossiers/new");
  // Select do Radix: abre pelo rótulo e escolhe a opção pelo nome do produto.
  await page.getByLabel("Produto").click();
  await page.getByRole("option", { name: /Dossiê Empresarial/ }).click();
  await page.getByLabel("CNPJ").fill(validCnpj());
  await page.getByLabel("Razão social").fill("e2e Empresa Balcão");
  await page.getByLabel("E-mail do titular").fill(`e2e-holder-${stamp}@example.test`);
  for (let i = 0; i < PARTNER_COUNT; i++) {
    await page.getByRole("button", { name: "Adicionar sócio" }).click();
    await page.locator(`#partner-doc-${i}`).fill(validCpf());
    await page.locator(`#partner-name-${i}`).fill(`e2e Sócio ${i + 1}`);
    await page.locator(`#partner-email-${i}`).fill(`e2e-partner-${stamp}-${i}@example.test`);
  }
  await expect(page.getByText("Total:")).toContainText(TOTAL.replace(".", ","));
  await page.getByRole("button", { name: "Abrir pedido" }).click();
  await expect(page).toHaveURL(/\/dossiers\/[0-9a-f-]{36}$/);
  const dossierId = page.url().split("/").pop() as string;
  expect(await orderState(dossierId)).toBe("awaiting_payment");

  await page.goto(`/settings/counter-payments?dossier=${dossierId}`);
  await page.getByLabel("Valor (R$)").fill(TOTAL.replace(".", ","));
  await page.getByRole("button", { name: "Registrar pagamento" }).click();
  await expect(page.getByText("Quitado")).toBeVisible();

  await authorizeScr(page, request, dossierId);
  await runTick(request);
  await expect.poll(() => orderState(dossierId), { message: "order is promoted to ready", timeout: 10_000 }).toBe("ready");

  await page.goto(`/dossiers/${dossierId}`);
  await expect(page.getByText("Na fila").first()).toBeVisible();
});
