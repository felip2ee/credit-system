import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { expect, test as setup } from "@playwright/test";

import { CLIENT_STATE, E2E, resetRateLimit, STAFF_SECRET_FILE, STAFF_STATE } from "./fixtures";
import { totp } from "./totp";

setup("staff: enroll MFA (or verify on retry) and save the session", async ({ page }) => {
  await resetRateLimit();
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(E2E.staff.email);
  await page.getByLabel("Senha").fill(E2E.staff.password);
  await page.getByRole("button", { name: "Entrar" }).click();

  // A retry after a failed first attempt lands on /mfa/verify with the secret saved: verify instead of enrolling.
  // A fresh run (global-setup recreates the user) lands on /mfa/setup, even when an old secret file exists.
  await page.waitForURL(/\/mfa\/(setup|verify)/);
  if (page.url().includes("/mfa/verify") && existsSync(STAFF_SECRET_FILE)) {
    await page.getByLabel("Código de 6 dígitos").fill(totp(readFileSync(STAFF_SECRET_FILE, "utf8").trim()));
    await page.getByRole("button", { name: "Verificar" }).click();
  } else {
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
  }
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
