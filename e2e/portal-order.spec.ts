import { expect, test } from "@playwright/test";

import { TICK_POLL_TIMEOUT_MS, authorizeScr, CLIENT_STATE, dbQuery, E2E, orderState, runTick, validCnpj, validCpf } from "./fixtures";

test.use({ storageState: CLIENT_STATE });

const TOTAL = Number(E2E.salePrice) + Number(E2E.salePricePerPartner);

const availableBalance = async () =>
  Number(
    (
      await dbQuery<{ available: string }>(
        `select w.available from client_wallets w join profiles p on p.id = w.client_profile_id where p.email = $1`,
        [E2E.client.email],
      )
    )[0].available,
  );

async function openOrder(page: import("@playwright/test").Page): Promise<string> {
  const stamp = Date.now();
  await page.goto("/portal/pesquisas/nova");
  await page.getByRole("radio", { name: /Dossiê Empresarial/ }).check();
  await page.getByLabel("CNPJ da empresa").fill(validCnpj());
  await page.getByLabel("Razão social").fill("e2e Empresa Portal");
  await page.getByLabel("E-mail do responsável").fill(`e2e-resp-${stamp}@example.test`);
  await page.getByRole("button", { name: "Adicionar sócio" }).click();
  await page.getByLabel("Nome do sócio 1").fill("e2e Sócio Portal");
  await page.getByLabel("CPF do sócio 1").fill(validCpf());
  await page.getByLabel("E-mail do sócio 1").fill(`e2e-partner-${stamp}@example.test`);
  // The declaration is mandatory: the confirm button stays disabled until the buyer accepts it.
  const confirm = page.getByRole("button", { name: "Confirmar pedido" });
  await expect(confirm).toBeDisabled();
  await page.getByLabel("Li e concordo com a declaração acima.").check();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page).toHaveURL(/\/portal\/pesquisas\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop() as string;
}

test("client buys a Dossiê Empresarial with 1 partner, sees each member and cancels with refund", async ({ page }) => {
  const before = await availableBalance();
  const dossierId = await openOrder(page);
  expect(await availableBalance()).toBeCloseTo(before - TOTAL, 2);

  await expect(page.getByRole("heading", { name: "Autorizações" })).toBeVisible();
  await expect(page.getByText("Empresa · ")).toBeVisible();
  await expect(page.getByText("Sócio · ")).toBeVisible();
  await expect(page.getByText("Pendente")).toHaveCount(2);

  await page.getByRole("button", { name: "Cancelar pedido" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar pedido" }).click();
  await expect.poll(() => orderState(dossierId), { message: "order is cancelled" }).toBe("cancelled");
  expect(await availableBalance()).toBeCloseTo(before, 2);
});

test("client buys a Dossiê Empresarial with 1 partner until it is ready", async ({ page, request }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  const dossierId = await openOrder(page);

  await page.goto("/portal/pesquisas");
  await expect(page.getByText("Aguardando autorização do titular").first()).toBeVisible();

  await authorizeScr(page, request, dossierId);
  await runTick(request);
  await expect.poll(() => orderState(dossierId), { message: "order is promoted to ready", timeout: 10_000 }).toBe("ready");

  await page.goto("/portal/pesquisas");
  await expect(page.getByText("Na fila").first()).toBeVisible();
});
