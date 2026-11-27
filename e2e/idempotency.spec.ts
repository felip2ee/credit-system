import { expect, test, type Page, type Request } from "@playwright/test";

import { CLIENT_NO_BALANCE_STATE, CLIENT_STATE, dbQuery, E2E, openNewOrderAtStep, orderState } from "./fixtures";

const TOTAL = Number(E2E.salePrice) + Number(E2E.salePricePerPartner);

// Rows of the client only, so the count does not depend on what the other specs created.
const OWNER_COLUMN = { dossier_orders: "client_profile_id", order_pix_quotes: "client_profile_id", idempotency_keys: "user_id" } as const;
const countFor = async (table: keyof typeof OWNER_COLUMN, email: string) =>
  Number(
    (
      await dbQuery<{ n: string }>(
        `select count(*) as n from ${table} t join profiles p on p.id = t.${OWNER_COLUMN[table]}
          where p.email = $1 ${table === "idempotency_keys" ? "and t.scope = 'order'" : ""}`,
        [email],
      )
    )[0].n,
  );
const availableBalance = async (email: string) =>
  Number(
    (
      await dbQuery<{ available: string }>(
        `select w.available from client_wallets w join profiles p on p.id = w.client_profile_id where p.email = $1`,
        [email],
      )
    )[0].available,
  );

// Walks the wizard, double clicks the final confirm and returns the server-action calls the page sent.
async function confirmWithDoubleClick(page: Page): Promise<Request[]> {
  const actionCalls: Request[] = [];
  page.on("request", (r) => {
    // Only the order action: the Pix screen sends its own server action (with its own key) after the redirect.
    if (r.method() === "POST" && r.headers()["next-action"] && r.postData()?.includes('"productCode"')) actionCalls.push(r);
  });
  await openNewOrderAtStep(page, 4);
  await page.getByLabel("Li e concordo com a declaração acima.").check();
  const confirm = page.getByRole("button", { name: "Ir para o pagamento" });
  await expect(confirm).toBeEnabled();
  await confirm.dblclick();
  return actionCalls;
}

// Replays the exact server-action request (same body, so same idempotency key) with the session cookie.
async function replay(page: Page, original: Request): Promise<string> {
  const headers = Object.fromEntries(
    Object.entries(await original.allHeaders()).filter(([k]) => !["host", "content-length"].includes(k.toLowerCase())),
  );
  const response = await page.request.post(original.url(), { headers, data: original.postDataBuffer() ?? undefined });
  expect(response.status()).toBeLessThan(500);
  return response.text();
}

test.describe("client with balance", () => {
  test.use({ storageState: CLIENT_STATE });

  test("double click on the final confirm creates one order and reserves the wallet once", async ({ page }) => {
    const { email } = E2E.client;
    const [balanceBefore, ordersBefore, keysBefore] = [
      await availableBalance(email),
      await countFor("dossier_orders", email),
      await countFor("idempotency_keys", email),
    ];

    const actionCalls = await confirmWithDoubleClick(page);
    await expect(page).toHaveURL(/\/portal\/pesquisas\/[0-9a-f-]{36}$/);
    const dossierId = page.url().split("/").pop() as string;
    await expect(page.getByRole("heading", { name: "Autorizações" })).toBeVisible();

    expect(actionCalls.length, "UI sends the order action once").toBe(1);
    expect(await countFor("dossier_orders", email)).toBe(ordersBefore + 1);
    expect(await countFor("idempotency_keys", email)).toBe(keysBefore + 1);
    expect(await availableBalance(email)).toBeCloseTo(balanceBefore - TOTAL, 2);

    const answer = await replay(page, actionCalls[0]);
    expect(answer).toContain(dossierId); // the duplicate answers with the existing order id
    expect(answer).not.toContain("paymentRequired"); // paid from the balance: no Pix step
    expect(await countFor("dossier_orders", email)).toBe(ordersBefore + 1);
    expect(await countFor("idempotency_keys", email)).toBe(keysBefore + 1);
    expect(await availableBalance(email)).toBeCloseTo(balanceBefore - TOTAL, 2);

    // Cancel: gives the reservation back, so the other specs find the wallet as before.
    await page.getByRole("button", { name: "Cancelar pedido" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar pedido" }).click();
    await expect.poll(() => orderState(dossierId), { message: "order is cancelled" }).toBe("cancelled");
    expect(await availableBalance(email)).toBeCloseTo(balanceBefore, 2);
  });
});

test.describe("client without balance", () => {
  test.use({ storageState: CLIENT_NO_BALANCE_STATE });

  test("double click creates one order awaiting payment with one Pix quote, and a replay sends to the Pix again", async ({ page }) => {
    const { email } = E2E.clientNoBalance;
    const [ordersBefore, keysBefore, quotesBefore] = [
      await countFor("dossier_orders", email),
      await countFor("idempotency_keys", email),
      await countFor("order_pix_quotes", email),
    ];

    const actionCalls = await confirmWithDoubleClick(page);
    await expect(page).toHaveURL(/\/portal\/pesquisas\/[0-9a-f-]{36}\/pagar$/);
    const dossierId = new URL(page.url()).pathname.split("/")[3];
    try {
      expect(actionCalls.length, "UI sends the order action once").toBe(1);
      expect(await orderState(dossierId)).toBe("awaiting_payment");
      expect(await countFor("dossier_orders", email)).toBe(ordersBefore + 1);
      expect(await countFor("idempotency_keys", email)).toBe(keysBefore + 1);
      expect(await countFor("order_pix_quotes", email)).toBe(quotesBefore + 1);

      const answer = await replay(page, actionCalls[0]);
      expect(answer).toContain(dossierId); // the duplicate answers with the existing order id
      expect(answer).toContain("paymentRequired"); // and still sends the buyer to the Pix screen
      expect(await countFor("dossier_orders", email)).toBe(ordersBefore + 1);
      expect(await countFor("idempotency_keys", email)).toBe(keysBefore + 1);
      expect(await countFor("order_pix_quotes", email)).toBe(quotesBefore + 1);
    } finally {
      // The UI cannot cancel an order that waits for payment. Free the awaiting-payment cap for the other specs.
      await dbQuery("update dossier_orders set state = 'cancelled' where dossier_id = $1", [dossierId]);
    }
  });
});
