import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { ADMIN_STATE, CLIENT_STATE, dbQuery, E2E, openNewOrderAtStep, openOrder, resetRateLimit, runTick, STAFF_STATE, SUPERADMIN_STATE, TICK_POLL_TIMEOUT_MS } from "./fixtures";

// The 10 critical client screens and the first screen of each panel (spec "Telas críticas do cliente").
// Shared by a11y.spec.ts and mobile.spec.ts.
export type Ids = { dossierId: string; scrToken: string };
export type Screen = {
  name: string;
  auth: "none" | "client" | "staff" | "admin" | "superadmin";
  open: (page: Page, ids: Ids) => Promise<void>;
};

const goto = (path: (ids: Ids) => string) => async (page: Page, ids: Ids) => {
  await page.goto(path(ids));
  await page.waitForLoadState("networkidle");
};

export const SCREENS: Screen[] = [
  { name: "vitrine do Bureau", auth: "none", open: goto(() => `/b/${E2E.bureauSlug}`) },
  { name: "cadastro do cliente", auth: "none", open: goto(() => `/b/${E2E.bureauSlug}/cadastro`) },
  { name: "confirmar e-mail", auth: "none", open: goto(() => "/cadastro/confirmar-email") },
  { name: "login", auth: "none", open: goto(() => "/login") },
  {
    name: "verificação MFA",
    auth: "none",
    open: async (page) => {
      await resetRateLimit();
      await page.goto("/login");
      await page.getByLabel("E-mail").fill(E2E.staff.email);
      await page.getByLabel("Senha").fill(E2E.staff.password);
      await page.getByRole("button", { name: "Entrar" }).click();
      await expect(page).toHaveURL(/\/mfa\/verify/);
      await page.waitForLoadState("networkidle");
    },
  },
  { name: "portal: termos", auth: "client", open: goto(() => "/portal/termos") },
  { name: "portal: início", auth: "client", open: goto(() => "/portal") },
  { name: "portal: nova pesquisa, passo 1 (escolha)", auth: "client", open: (page) => openNewOrderAtStep(page, 1) },
  { name: "portal: nova pesquisa, passo 2 (dados)", auth: "client", open: (page) => openNewOrderAtStep(page, 2) },
  { name: "portal: nova pesquisa, passo 3 (sócios)", auth: "client", open: (page) => openNewOrderAtStep(page, 3) },
  { name: "portal: nova pesquisa, passo 4 (revisão)", auth: "client", open: (page) => openNewOrderAtStep(page, 4) },
  { name: "portal: lista de pesquisas", auth: "client", open: goto(() => "/portal/pesquisas") },
  { name: "portal: andamento do pedido", auth: "client", open: goto((ids) => `/portal/pesquisas/${ids.dossierId}`) },
  { name: "portal: créditos (PIX)", auth: "client", open: goto(() => "/portal/credits") },
  { name: "autorização SCR do titular", auth: "none", open: goto((ids) => `/autorizacao-scr/${ids.scrToken}`) },
  { name: "painel do Bureau", auth: "staff", open: goto(() => "/") },
  { name: "painel do superadmin", auth: "superadmin", open: goto(() => "/superadmin") },
];

const STATE = { none: undefined, client: CLIENT_STATE, staff: STAFF_STATE, admin: ADMIN_STATE, superadmin: SUPERADMIN_STATE } as const;

export async function newPage(browser: Browser, auth: Screen["auth"], options: Parameters<Browser["newContext"]>[0] = {}) {
  const context: BrowserContext = await browser.newContext({ ...options, storageState: STATE[auth] });
  return { context, page: await context.newPage() };
}

const pendingScr = () =>
  dbQuery<{ dossier_id: string; public_token: string }>(
    `select o.dossier_id, s.public_token from dossier_orders o
       join consultations c on c.dossier_id = o.dossier_id
       join scr_authorizations s on s.id = c.scr_authorization_id
      where o.client_profile_id = (select id from profiles where email = $1)
        and o.state <> 'cancelled' and s.status = 'pending' and s.auth_code is not null and s.public_token is not null
      order by o.created_at desc limit 1`,
    [E2E.client.email],
  );

// An order with a pending SCR request: reuses one left by an earlier spec, else buys one as the e2e client.
// The data isolation rule is relaxed on purpose: each order costs credits and the e2e wallet is small.
export async function ensureOrder(browser: Browser): Promise<Ids> {
  const found = (await pendingScr())[0];
  if (found) return { dossierId: found.dossier_id, scrToken: found.public_token };
  const { context, page } = await newPage(browser, "client");
  try {
    const dossierId = await openOrder(page);
    await expect
      .poll(async () => {
        await runTick(context.request);
        return (await pendingScr()).length;
      }, { message: "tick issues the SCR requests", timeout: TICK_POLL_TIMEOUT_MS, intervals: [1_000] })
      .toBeGreaterThan(0);
    const row = (await pendingScr())[0];
    return { dossierId, scrToken: row.public_token };
  } finally {
    await context.close();
  }
}
