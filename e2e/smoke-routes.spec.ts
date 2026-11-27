import { expect, test } from "@playwright/test";

import { ADMIN_STATE, CLIENT_STATE, STAFF_STATE, SUPERADMIN_STATE } from "./fixtures";

// Toda página estática de cada área, por papel: abre sem tela de erro, com um só <main> e um só <h1>.
// Página sem permissão para o papel redireciona; a verificação vale para o destino.
const BUREAU = [
  "/",
  "/afiliados",
  "/consultations/new",
  "/dossiers",
  "/dossiers/new",
  "/holders",
  "/holders/new",
  "/scr",
  "/settings",
  "/settings/audit",
  "/settings/catalog",
  "/settings/counter-payments",
  "/settings/cupons",
  "/settings/payouts",
  "/settings/security",
  "/settings/users",
  "/settings/wallet",
  "/admin",
  "/admin/cobrancas",
  "/admin/consulta",
  "/admin/links",
];

const SUPERADMIN = [
  "/",
  "/superadmin",
  "/superadmin/bureaus/new",
  "/superadmin/nfse",
  "/superadmin/notifications",
  "/superadmin/payouts",
  "/superadmin/products",
  "/superadmin/products/new",
  "/superadmin/saques",
  "/superadmin/settings",
  "/superadmin/settings/afiliados",
  "/superadmin/settings/comissao",
  "/superadmin/settings/prompts",
  "/superadmin/settings/repasses",
  "/superadmin/settings/scr",
];

const PORTAL = [
  "/portal",
  "/portal/afiliacao",
  "/portal/afiliacao/saque",
  "/portal/credits",
  "/portal/notificacoes",
  "/portal/perfil",
  "/portal/pesquisas",
  "/portal/pesquisas/nova",
  "/portal/termos",
];

const AREAS = [
  { role: "bureau_admin", state: ADMIN_STATE, paths: BUREAU },
  { role: "operator", state: STAFF_STATE, paths: BUREAU },
  { role: "superadmin", state: SUPERADMIN_STATE, paths: SUPERADMIN },
  { role: "client", state: CLIENT_STATE, paths: PORTAL },
];

for (const { role, state, paths } of AREAS) {
  test.describe(role, () => {
    test.use({ storageState: state });
    for (const path of paths) {
      test(`${role} abre ${path}`, async ({ page }) => {
        await page.goto(path);
        // A tela de erro só aparece depois da hidratação.
        await page.waitForLoadState("networkidle");
        await expect(page.getByText("Carregando...")).toHaveCount(0);
        await expect(page.getByText("Algo deu errado")).toHaveCount(0);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.locator("h1")).toHaveCount(1);
      });
    }
  });
}
