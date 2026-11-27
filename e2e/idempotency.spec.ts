import { expect, test, type Request } from "@playwright/test";

import { CLIENT_STATE, dbQuery, E2E, openNewOrderAtStep } from "./fixtures";

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
const orderCount = async () => Number((await dbQuery<{ n: string }>("select count(*) as n from dossier_orders"))[0].n);
const keyCount = async () =>
  Number((await dbQuery<{ n: string }>("select count(*) as n from idempotency_keys where scope = 'order'"))[0].n);

test("double click on the final confirm creates one order and reserves the wallet once", async ({ page }) => {
  const [balanceBefore, ordersBefore, keysBefore] = [await availableBalance(), await orderCount(), await keyCount()];
  const actionCalls: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) actionCalls.push(r);
  });

  await openNewOrderAtStep(page, 4);
  await page.getByLabel("Li e concordo com a declaração acima.").check();
  const confirm = page.getByRole("button", { name: "Confirmar pedido" });
  await expect(confirm).toBeEnabled();
  await confirm.dblclick();
  await expect(page).toHaveURL(/\/portal\/pesquisas\/[0-9a-f-]{36}$/);
  const dossierId = page.url().split("/").pop() as string;

  expect(await orderCount()).toBe(ordersBefore + 1);
  expect(await keyCount()).toBe(keysBefore + 1);
  expect(await availableBalance()).toBeCloseTo(balanceBefore - TOTAL, 2);
  expect(actionCalls.length, "UI sends the order action at most once").toBeLessThanOrEqual(1);
  await expect(page.getByRole("heading", { name: "Autorizações" })).toBeVisible();

  // Replay the exact server-action request (same body, so same idempotency key): the server must not create a second order.
  expect(actionCalls.length).toBe(1);
  const original = actionCalls[0];
  const headers = Object.fromEntries(
    Object.entries(await original.allHeaders()).filter(([k]) => !["host", "content-length"].includes(k.toLowerCase())),
  );
  const replay = await page.request.post(original.url(), { headers, data: original.postDataBuffer() ?? undefined });
  expect(replay.status()).toBeLessThan(500);
  expect(await replay.text()).toContain(dossierId); // duplicate answers with the existing order id

  expect(await orderCount()).toBe(ordersBefore + 1);
  expect(await keyCount()).toBe(keysBefore + 1);
  expect(await availableBalance()).toBeCloseTo(balanceBefore - TOTAL, 2);
});
