import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const staff = {
  email: process.env.AUTH_E2E_STAFF_EMAIL ?? "",
  password: process.env.AUTH_E2E_STAFF_PASSWORD ?? "",
};
const client = {
  email: process.env.AUTH_E2E_CLIENT_EMAIL ?? "",
  password: process.env.AUTH_E2E_CLIENT_PASSWORD ?? "",
};
// A valid, unexpired reset token for the forced-password-setup case, minted by
// the seed step (better-auth requestPasswordReset -> capture token from email).
const freshResetToken = process.env.AUTH_E2E_RESET_TOKEN ?? "";

async function signIn(page: Page, user: typeof staff) {
  await page.goto(`${baseURL}/login`);
  await page.getByLabel("E-mail").fill(user.email);
  await page.getByLabel("Senha").fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("does not accept a public signup or an external redirect", async ({
  page,
  request,
}) => {
  const signup = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    data: {
      name: "Public",
      email: "public@example.test",
      password: "twelve-character-password",
    },
  });
  expect(signup.status()).toBe(400);

  await page.goto(`${baseURL}/login?next=https://attacker.example`);
  expect(new URL(page.url()).origin).toBe(new URL(baseURL).origin);
});

test("requires staff MFA before the dashboard and supports logout", async ({
  page,
}) => {
  await signIn(page, staff);
  await expect(page).toHaveURL(/\/mfa\/(setup|verify)/);

  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("completes forced password setup from a reset link", async ({ page }) => {
  await page.goto(`${baseURL}/update-password?token=${freshResetToken}`);
  const newPassword = "brand-new-twelve-character-password";
  await page.getByLabel("Nova senha").fill(newPassword);
  await page.getByLabel("Confirmar senha").fill(newPassword);
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page).toHaveURL(/\/login|\/$|\/portal/);
});

test("allows an optional client TOTP enrollment and an administrator invitation", async ({
  page,
}) => {
  await signIn(page, client);
  await expect(page).toHaveURL(/\/portal|\/$/);

  await page.goto(`${baseURL}/settings/security`);
  await page.getByLabel("Confirme sua senha").fill(client.password);
  await page.getByRole("button", { name: "Adicionar autenticador" }).click();
  await expect(page.getByAltText("QR code TOTP")).toBeVisible();
  await expect(page.getByText(/códigos de recuperação/i)).toBeVisible();
  await page.getByLabel("Código de 6 dígitos").fill("000000");
  await page.getByRole("button", { name: "Confirmar autenticador" }).click();
  await expect(page.getByText(/código inválido/i)).toBeVisible();

  await signIn(page, staff);
  await page.goto(`${baseURL}/settings/users`);
  await page.getByLabel("Nome completo").fill("E2E Invite");
  await page.getByLabel("E-mail").fill(`invite-${Date.now()}@example.test`);
  await page.getByRole("button", { name: "Criar usuário" }).click();
  await expect(page.getByText("Convite enviado")).toBeVisible();
});

test("rejects an expired reset link and disabled users", async ({ page }) => {
  await page.goto(`${baseURL}/update-password?token=expired-token`);
  await page.getByLabel("Nova senha").fill("another-twelve-character-password");
  await page
    .getByLabel("Confirmar senha")
    .fill("another-twelve-character-password");
  await page.getByRole("button", { name: "Salvar nova senha" }).click();
  await expect(page.getByText(/link pode ter expirado/i)).toBeVisible();

  // A deactivated user may authenticate, but findAuthProfile -> user_deactivated
  // blocks the first protected page load and bounces back to /login.
  await signIn(page, {
    email: process.env.AUTH_E2E_DISABLED_EMAIL ?? "",
    password: process.env.AUTH_E2E_DISABLED_PASSWORD ?? "",
  });
  await page.goto(`${baseURL}/`);
  await expect(page).toHaveURL(/\/login/);
});
