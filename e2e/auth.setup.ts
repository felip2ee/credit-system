import { writeFileSync } from "node:fs";

import { expect, test as setup } from "@playwright/test";

import { CLIENT_STATE, E2E, resetRateLimit, STAFF_SECRET_FILE, STAFF_STATE } from "./fixtures";
import { totp } from "./totp";

setup("staff: enroll MFA and save the session", async ({ page }) => {
  await resetRateLimit();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(E2E.staff.email);
  await page.getByLabel("Senha").fill(E2E.staff.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/mfa\/setup/);

  // The secret is only inside the QR code image, so read it from the enrollment response.
  const enrolled = page.waitForResponse((r) => r.url().includes("/api/auth/two-factor/enable") && r.ok());
  await page.getByLabel("Confirme sua senha").fill(E2E.staff.password);
  await page.getByRole("button", { name: "Adicionar autenticador" }).click();
  const { totpURI } = (await (await enrolled).json()) as { totpURI: string };
  const secret = new URL(totpURI).searchParams.get("secret");
  if (!secret) throw new Error("enrollment response has no TOTP secret");
  writeFileSync(STAFF_SECRET_FILE, secret);

  await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
  await page.getByRole("button", { name: "Confirmar autenticador" }).click();
  await expect(page).not.toHaveURL(/\/(login|mfa)/);
  await page.context().storageState({ path: STAFF_STATE });
});

setup("client: save the session", async ({ page }) => {
  await resetRateLimit();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(E2E.client.email);
  await page.getByLabel("Senha").fill(E2E.client.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/portal/);
  await page.context().storageState({ path: CLIENT_STATE });
});
