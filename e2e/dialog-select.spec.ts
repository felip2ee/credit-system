import { expect, test } from "@playwright/test";

import { CLIENT_STATE } from "./fixtures";

test.use({ storageState: CLIENT_STATE });

const VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 900 } },
  { name: "390px", size: { width: 390, height: 844 } },
];

// O <dialog> modal fica na top layer: só um navegador real mostra se a lista do Select abre acima dele. Nada é pago.
for (const { name, size } of VIEWPORTS) {
  test(`client picks card installments inside the top-up dialog (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/portal/credits");
    // Wait for hydration: a click before it is lost.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Recarregar", exact: true }).click();

    const dialog = page.getByRole("dialog");
    const next = dialog.getByRole("button", { name: "Continuar" });
    await dialog.getByLabel(/^Valor \(R\$/).fill("200,00");
    await next.click();
    await dialog.getByRole("radio", { name: /Cartão de crédito/ }).check();
    await next.click();
    // Only the payer fields the account does not have yet show as inputs.
    const postalCode = dialog.getByLabel("CEP", { exact: true });
    await expect(postalCode).toBeVisible();
    await postalCode.fill("01310-100");
    await dialog.getByLabel("Número do endereço", { exact: true }).fill("120");
    await next.click();
    // The card fields are empty: the step still shows the installments.
    const installments = dialog.getByRole("combobox", { name: "Parcelas" });
    await expect(installments).toHaveText(/^1x/);

    // Mouse.
    await installments.click();
    await page.getByRole("option", { name: /^6x/ }).click({ timeout: 5_000 });
    await expect(installments).toHaveText(/^6x/);

    // Keyboard.
    await installments.press("Enter");
    await expect(page.getByRole("option", { name: /^6x/ })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("option", { name: /^7x/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(installments).toHaveText(/^7x/);

    // Escape closes the list only, not the dialog.
    await installments.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox")).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(installments).toBeFocused();
  });
}
