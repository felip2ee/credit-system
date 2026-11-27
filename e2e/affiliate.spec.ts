import { expect, test, type Page } from "@playwright/test";

import { CLIENT_STATE, dbAs, dbQuery, E2E, E2E_AFFILIATE_PCT, resetRateLimit, SUPERADMIN_STATE, validCpf } from "./fixtures";

// Commission is created on cash-in (apply_asaas_payment), not on order capture: 40% of a R$ 25 top-up = R$ 10.
const COMMISSION = ((20 + 5) * E2E_AFFILIATE_PCT) / 100;
const CONVERTED = 4;
const WITHDRAWN = COMMISSION - CONVERTED;

type Identity = { userId: string; role: "client"; bureauId: string };

async function profileOf(email: string): Promise<Identity> {
  const rows = await dbQuery<{ id: string; bureau_id: string }>("select id, bureau_id from profiles where email = $1", [email]);
  return { userId: rows[0].id, role: "client", bureauId: rows[0].bureau_id };
}

const walletOf = async (profileId: string) =>
  Number((await dbQuery<{ available: string }>("select available from affiliate_wallets where profile_id = $1", [profileId]))[0].available);

const creditsOf = async (profileId: string) =>
  Number((await dbQuery<{ available: string }>("select available from client_wallets where client_profile_id = $1", [profileId]))[0].available);

async function registerThroughLink(page: Page, link: string, email: string) {
  const url = new URL(link);
  await resetRateLimit();
  await page.goto(`${url.pathname}${url.search}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Nome completo").fill("e2e Indicado");
  await page.getByLabel("CPF").fill(validCpf());
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Celular (com DDD)").fill(`11 9${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
  await page.getByLabel("Senha", { exact: true }).fill("e2e-referred-password-123");
  await page.getByLabel("Confirmar senha").fill("e2e-referred-password-123");
  await page.getByLabel(/Li e aceito os/).check();
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(/\/portal/);
}

test.use({ storageState: CLIENT_STATE, permissions: ["clipboard-read", "clipboard-write"] });

test("referred client's top-up charge pays the commission at once, then A converts to credits and is paid out by the superadmin", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const affiliate = await profileOf(E2E.client.email);
  const referredEmail = `e2e-referred-${Date.now()}@example.test`;

  // A copies the link.
  await page.goto("/portal/afiliacao");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Copiar link de indicação" }).click();
  await expect(page.getByRole("button", { name: "Copiar link de indicação" })).toHaveText(/Copiado/);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain(`/b/${E2E.bureauSlug}/cadastro?ref=`);

  // B registers through the link and buys online.
  const referredContext = await browser.newContext();
  try {
    const referredPage = await referredContext.newPage();
    await registerThroughLink(referredPage, link, referredEmail);
    const referred = await profileOf(referredEmail);
    const referrals = await dbQuery(
      "select 1 from affiliate_referrals where affiliate_profile_id = $1 and referred_profile_id = $2",
      [affiliate.userId, referred.userId],
    );
    expect(referrals).toHaveLength(1);

    // B tops up through a charge. The checkout writes the split plan when it creates the charge; the run seeds the
    // same rows (charge + affiliate line paid by Pix) and sends the webhook the fake driver would send.
    const paymentId = `pay_e2e_${Date.now()}`;
    const [charge] = await dbQuery<{ id: string }>(
      `insert into pix_charges (bureau_id, asaas_payment_id, amount, status, pix_payload, expires_at, requested_by, client_profile_id)
       values ($1, $2, 25, 'pending', 'pix-e2e', now() + interval '30 minutes', $3, $3) returning id`,
      [referred.bureauId, paymentId, referred.userId],
    );
    await dbQuery(
      `insert into charge_splits (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, pct, amount_cents)
       values ($1, $2, 'affiliate', $3, 'pix', $4, $5)`,
      [charge.id, referred.bureauId, affiliate.userId, E2E_AFFILIATE_PCT, COMMISSION * 100],
    );
    const webhook = await referredPage.request.post("/api/webhooks/asaas", {
      headers: { "asaas-access-token": process.env.ASAAS_WEBHOOK_TOKEN ?? "" },
      data: { id: `evt_${paymentId}`, event: "PAYMENT_RECEIVED", payment: { id: paymentId, value: 25 } },
    });
    expect(webhook.status()).toBe(200);
  } finally {
    await referredContext.close();
  }

  // Cash-in commission: A sees it at once (hold is 0 days by default) and it sits in the available balance.
  await page.goto("/portal/afiliacao");
  await expect(page.getByText(/R\$\s*10,00/).first()).toBeVisible();
  expect(await walletOf(affiliate.userId)).toBe(COMMISSION);

  // A converts part to credits.
  const creditsBefore = await creditsOf(affiliate.userId);
  await page.goto("/portal/afiliacao");
  // Wait for hydration: a fill/click before it is lost (native submit, state reset).
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Valor a converter (R$)").fill(CONVERTED.toFixed(2));
  await page.getByRole("button", { name: "Usar como crédito" }).click();
  await expect(page.getByText("Valor convertido em créditos.")).toBeVisible();
  expect(await creditsOf(affiliate.userId)).toBeCloseTo(creditsBefore + CONVERTED, 2);

  // A asks for a withdrawal of the rest.
  await page.goto("/portal/afiliacao/saque");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Valor (R$)").fill(WITHDRAWN.toFixed(2));
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("heading", { name: "Para onde vai o dinheiro?" })).toBeFocused();
  await page.getByLabel("Tipo da chave PIX").click();
  await page.getByRole("option", { name: "E-mail" }).click();
  await page.getByLabel("Chave PIX", { exact: true }).fill(E2E.client.email);
  await page.getByLabel("A chave PIX está no meu nome").check();
  // The confirm button stays disabled until the double-click guard has passed.
  const confirm = page.getByRole("button", { name: "Solicitar saque" });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(page.getByText("Saque solicitado.")).toBeVisible();
  expect(await walletOf(affiliate.userId)).toBe(0);

  // The superadmin sees the queue and marks the withdrawal as paid with the receipt.
  const adminContext = await browser.newContext({ storageState: SUPERADMIN_STATE });
  try {
    const admin = await adminContext.newPage();
    await admin.goto("/superadmin/saques");
    await admin.getByRole("link", { name: "Abrir saque de e2e Cliente" }).first().click();
    await expect(admin.getByLabel(/Comprovante do pagamento/)).toBeVisible();
    await expect(admin.getByRole("button", { name: "Marcar como pago" })).toBeVisible();
  } finally {
    await adminContext.close();
  }

  // The upload path needs ClamAV, which CI does not run (fail-closed): the integration tests cover it.
  // The run pays through the same SQL function as the action, as the superadmin, with a fake receipt.
  const [open] = await dbQuery<{ id: string }>("select id from affiliate_withdrawals where profile_id = $1 and status = 'open' order by created_at desc limit 1", [affiliate.userId]);
  const [superadmin] = await dbQuery<{ id: string }>("select id from profiles where email = $1", [E2E.superadmin.email]);
  await dbAs({ userId: superadmin.id, role: "superadmin", bureauId: null }, async (query) => {
    const [paid] = await query("select ok, reason from mark_affiliate_withdrawal_paid($1, $2, 'application/pdf', $3)", [
      open.id,
      `e2e/receipt-${open.id}.pdf`,
      "a".repeat(64),
    ]);
    expect(paid).toMatchObject({ ok: true });
  });

  await page.goto("/portal/afiliacao/saque");
  await expect(page.getByText("Pago", { exact: true }).first()).toBeVisible();
});
