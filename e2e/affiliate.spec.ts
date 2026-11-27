import { expect, test, type Page } from "@playwright/test";

import { CLIENT_STATE, dbAs, dbQuery, E2E, E2E_AFFILIATE_PCT, openOrder, resetRateLimit, runTick, SUPERADMIN_STATE, validCpf } from "./fixtures";

// Gross price of the e2e order (1 partner): 20 + 5 = 25. Commission = 40% of it = 10, paid from the platform share
// (25 - 30% Bureau = 17.50), so the cap does not apply.
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
  // Each step change moves focus to the step title (h2).
  const next = async (title: string) => {
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeFocused();
  };
  await page.getByLabel("Nome completo").fill("e2e Indicado");
  await page.getByLabel("CPF").fill(validCpf());
  await next("Contato");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Celular (com DDD)").fill(`11 9${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
  await next("Senha e termos");
  await page.getByLabel("Senha", { exact: true }).fill("e2e-referred-password-123");
  await page.getByLabel("Confirmar senha").fill("e2e-referred-password-123");
  await page.getByLabel(/Li e aceito os/).check();
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(/\/portal/);
}

test.use({ storageState: CLIENT_STATE, permissions: ["clipboard-read", "clipboard-write"] });

test("referred client buys, commission waits the hold, then converts to credits and is paid out by the superadmin", async ({
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

    // Comprar exige créditos; a comissão exige celular confirmado. O teste grava os dois direto.
    const [staff] = await dbQuery<{ id: string }>("select id from profiles where email = $1", [E2E.staff.email]);
    await dbQuery("select * from client_wallet_post_entry($1, 'topup', 100, $2, 'seed', null, $3)", [referred.userId, `seed-${Date.now()}`, staff.id]);
    await dbAs({ userId: referred.userId, role: "client", bureauId: referred.bureauId }, async (query) => {
      await query("set local session_replication_role = replica");
      await query("update profiles set phone_verified_at = now() where id = $1", [referred.userId]);
    });
    const dossierId = await openOrder(referredPage);

    // The worker captures an order when its research ends: the run calls the same SQL function as the buyer.
    await dbAs(referred, async (query) => {
      const [captured] = await query("select ok, reason from capture_order($1)", [dossierId]);
      expect(captured).toMatchObject({ ok: true });
    });
  } finally {
    await referredContext.close();
  }

  // A sees the commission in the hold.
  await page.goto("/portal/afiliacao");
  await expect(page.getByText("Em carência").first()).toBeVisible();
  await expect(page.getByText(/R\$\s*10,00/).first()).toBeVisible();
  expect(await walletOf(affiliate.userId)).toBe(0);

  // The hold ends: the run moves release_at to the past and calls the tick.
  await dbQuery("update affiliate_commissions set release_at = now() - interval '1 day' where affiliate_profile_id = $1", [affiliate.userId]);
  await expect
    .poll(async () => {
      await runTick(page.request);
      return walletOf(affiliate.userId);
    }, { message: "tick releases the commission", timeout: 90_000, intervals: [1_000] })
    .toBe(COMMISSION);

  // A converts part to credits.
  const creditsBefore = await creditsOf(affiliate.userId);
  await page.goto("/portal/afiliacao");
  // Wait for hydration: a fill/click before it is lost (native submit, state reset).
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Valor a converter (R$)").fill(CONVERTED.toFixed(2));
  await page.getByRole("button", { name: "Usar como crédito" }).click();
  await page.getByRole("alertdialog", { name: "Converter em créditos" }).getByRole("button", { name: "Converter", exact: true }).click();
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
  // Enter in the PIX key field must not request the withdrawal: only the click below does.
  await page.getByLabel("Chave PIX", { exact: true }).press("Enter");
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
