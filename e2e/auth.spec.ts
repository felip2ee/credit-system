import { expect, test, type Page } from "@playwright/test";

import { E2E, resetRateLimit } from "./fixtures";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const { staff, disabled } = E2E;

async function signIn(page: Page, user: { email: string; password: string }) {
  await resetRateLimit();
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
  await signIn(page, disabled);
  await page.goto(`${baseURL}/`);
  await expect(page).toHaveURL(/\/login/);
});
