import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { E2E, resetRateLimit, STAFF_SECRET_FILE } from "./fixtures";
import { totp } from "./totp";

// Clean context: this spec signs in from scratch instead of reusing the saved session.
test.use({ storageState: { cookies: [], origins: [] } });

test("staff signs in with MFA, rejects a wrong code and signs out", async ({ page }) => {
  await resetRateLimit();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(E2E.staff.email);
  await page.getByLabel("Senha").fill(E2E.staff.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/verify/);

  await page.getByLabel("Código de 6 dígitos").fill("000000");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByText("Código inválido. Tente novamente.")).toBeVisible();

  await page.getByLabel("Código de 6 dígitos").fill(totp(readFileSync(STAFF_SECRET_FILE, "utf8")));
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page).not.toHaveURL(/\/(login|mfa)/);

  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
