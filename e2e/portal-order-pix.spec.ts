import { expect, test } from "@playwright/test";

import { CLIENT_NO_BALANCE_STATE, dbQuery, openOrder, orderState } from "./fixtures";

test.use({ storageState: CLIENT_NO_BALANCE_STATE });

// Fake Asaas driver: the PIX is created without a network call and the test plays the webhook.
test("client without balance pays the order by PIX and the order moves on by itself", async ({ page, request }) => {
  const dossierId = await openOrder(page, { expectPayment: true });

  await expect(page).toHaveURL(new RegExp(`/portal/pesquisas/${dossierId}/pagar$`));
  await expect(page.getByAltText("QR Code do PIX")).toBeVisible();
  await expect(page.getByLabel("PIX copia e cola")).not.toHaveValue("");
  expect(await orderState(dossierId)).toBe("awaiting_payment");

  const [charge] = await dbQuery<{ asaas_payment_id: string; total_charged: string | null; amount: string }>(
    "select asaas_payment_id, total_charged, amount from pix_charges where order_id = $1 and status = 'pending'",
    [dossierId],
  );
  const paid = await request.post("/api/webhooks/asaas", {
    headers: { "asaas-access-token": process.env.ASAAS_WEBHOOK_TOKEN ?? "" },
    data: {
      id: `evt_e2e_${dossierId}`,
      event: "PAYMENT_RECEIVED",
      payment: { object: "payment", id: charge.asaas_payment_id, value: Number(charge.total_charged ?? charge.amount) },
    },
  });
  expect(paid.ok()).toBe(true);

  await expect(page).toHaveURL(new RegExp(`/portal/pesquisas/${dossierId}$`), { timeout: 30_000 });
  await expect(page.getByText("Aguardando autorização").first()).toBeVisible();
});
