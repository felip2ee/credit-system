import { expect, test } from "@playwright/test";

import { TICK_POLL_TIMEOUT_MS, authorizeScr, CLIENT_STATE, dbQuery, E2E, openOrder, orderState, runTick } from "./fixtures";

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

test("client buys a Dossiê Empresarial with 1 partner, sees each member and cancels with refund", async ({ page }) => {
  const before = await availableBalance();
  const dossierId = await openOrder(page);
  expect(await availableBalance()).toBeCloseTo(before - TOTAL, 2);

  await expect(page.getByRole("heading", { name: "Autorizações" })).toBeVisible();
  await expect(page.getByText("Empresa · ")).toBeVisible();
  await expect(page.getByText("Sócio · ")).toBeVisible();
  await expect(page.getByText("Aguardando autorização", { exact: true })).toHaveCount(3); // 2 membros + o selo do pedido

  await page.getByRole("button", { name: "Cancelar pedido" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar pedido" }).click();
  await expect.poll(() => orderState(dossierId), { message: "order is cancelled" }).toBe("cancelled");
  expect(await availableBalance()).toBeCloseTo(before, 2);
});

test("client buys a Dossiê Empresarial with 1 partner until it is ready", async ({ page, request }) => {
  test.setTimeout(TICK_POLL_TIMEOUT_MS * 2);
  const dossierId = await openOrder(page);

  await page.goto("/portal/pesquisas");
  await expect(page.getByText("Aguardando autorização").first()).toBeVisible();

  await authorizeScr(page, request, dossierId);
  await runTick(request);
  await expect.poll(() => orderState(dossierId), { message: "order is promoted to ready", timeout: 10_000 }).toBe("ready");

  await page.goto("/portal/pesquisas");
  await expect(page.getByText("Na fila").first()).toBeVisible();
});
