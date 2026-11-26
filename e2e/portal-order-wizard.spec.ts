import { expect, test, type Page } from "@playwright/test";

import { addPerson, CLIENT_STATE, E2E, startCompanyOrder, validCpf } from "./fixtures";

test.use({ storageState: CLIENT_STATE });

// Mirrors MAX_PARTNERS in src/lib/validators/order.ts.
const MAX_PEOPLE = 20;
const person = (tag: string, cpf = validCpf()) => ({ name: `e2e Pessoa ${tag}`, cpf, email: `e2e-${tag}-${Date.now()}@example.test` });
const next = (page: Page) => page.getByRole("button", { name: "Continuar" }).click();
const brl = (value: number) => new RegExp(`R\\$\\s*${value.toFixed(2).replace(".", ",")}`);

test("Voltar mantém os dados", async ({ page }) => {
  await startCompanyOrder(page);
  await addPerson(page, 1, { name: "e2e Pessoa Volta", cpf: "529.982.247-25", email: "e2e-volta@example.test" });
  await next(page);
  await expect(page.getByRole("heading", { name: "Revise o pedido" })).toBeVisible();

  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page.getByLabel("Nome da pessoa 1", { exact: true })).toHaveValue("e2e Pessoa Volta");
  await expect(page.getByLabel("E-mail da pessoa 1")).toHaveValue("e2e-volta@example.test");

  await page.getByRole("button", { name: "Voltar" }).click();
  await expect(page.getByLabel("Razão social")).toHaveValue("e2e Empresa Portal");
  await expect(page.getByLabel("CNPJ da empresa")).not.toHaveValue("");
});

test("trocar a escolha limpa os dados", async ({ page }) => {
  await startCompanyOrder(page);
  await page.getByRole("button", { name: "Voltar" }).click();
  await page.getByRole("button", { name: "Voltar" }).click();

  await page.getByRole("radio", { name: /Só para você/ }).check();
  await next(page);
  await expect(page.getByRole("heading", { name: "Revise o pedido" })).toBeVisible();
  await expect(page.getByText("e2e Empresa Portal")).toHaveCount(0);

  await page.getByRole("button", { name: "Voltar" }).click();
  await page.getByRole("radio", { name: /Para uma empresa/ }).check();
  await next(page);
  await expect(page.getByLabel("CNPJ da empresa")).toHaveValue("");
  await expect(page.getByLabel("Razão social")).toHaveValue("");
});

test("Enter não pula etapa", async ({ page }) => {
  await page.goto("/portal/pesquisas/nova");
  await page.getByRole("radio", { name: /Para uma empresa/ }).check();
  await next(page);
  await page.getByLabel("CNPJ da empresa").press("Enter");
  await expect(page.getByRole("heading", { name: "Revise o pedido" })).toHaveCount(0);
  await expect(page.getByText("CNPJ inválido.")).toBeVisible();
});

test("o foco vai ao título da etapa", async ({ page }) => {
  await page.goto("/portal/pesquisas/nova");
  await page.getByRole("radio", { name: /Para uma empresa/ }).check();
  await next(page);
  await expect(page.getByRole("heading", { name: "Dados da empresa" })).toBeFocused();
});

test('e-mail repetido bloqueia "Continuar" na etapa de pessoas', async ({ page }) => {
  await startCompanyOrder(page);
  const same = `e2e-igual-${Date.now()}@example.test`;
  await addPerson(page, 1, { ...person("a"), email: same });
  await addPerson(page, 2, { ...person("b"), email: same });
  await next(page);
  await expect(page.getByText("Cada pessoa precisa de um e-mail próprio.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pessoas da empresa" })).toBeVisible();
});

test("a revisão mostra a lista e o total", async ({ page }) => {
  await startCompanyOrder(page);
  const cpf = validCpf();
  await addPerson(page, 1, person("socio", cpf));
  await addPerson(page, 2, person("conjuge", cpf)); // mesmo CPF: o servidor cobra uma vez
  await next(page);

  await expect(page.getByRole("heading", { name: "Revise o pedido" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pessoas (1)" })).toBeVisible();
  await expect(page.getByRole("definition")).toContainText(brl(Number(E2E.salePrice) + Number(E2E.salePricePerPartner)));
});

test('"só para você" tem duas etapas e não pede declaração', async ({ page }) => {
  await page.goto("/portal/pesquisas/nova");
  await page.getByRole("radio", { name: /Só para você/ }).check();
  await expect(page.getByText("Etapa 1 de 2")).toBeVisible();
  await next(page);
  await expect(page.getByRole("heading", { name: "Revise o pedido" })).toBeVisible();
  await expect(page.getByText("Etapa 2 de 2")).toBeVisible();
  await expect(page.getByLabel("Li e concordo com a declaração acima.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ir para o pagamento" })).toBeEnabled();
});

// O envio de "Adicionar eu" fica na integração (o Titular semeado tem CPF inválido).
test('"Adicionar eu" preenche o e-mail da conta e some depois de usado', async ({ page }) => {
  await startCompanyOrder(page);
  await page.getByRole("button", { name: "Adicionar eu" }).click();
  await expect(page.getByLabel("E-mail da pessoa 1")).toHaveValue(E2E.client.email);
  await expect(page.getByLabel("CPF da pessoa 1")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Adicionar eu" })).toHaveCount(0);
});

test("limite de pessoas desabilita Adicionar pessoa", async ({ page }) => {
  await startCompanyOrder(page);
  for (let n = 1; n <= MAX_PEOPLE; n++) await page.getByRole("button", { name: "Adicionar pessoa" }).click();
  await expect(page.getByLabel(`Nome da pessoa ${MAX_PEOPLE}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Adicionar pessoa" })).toBeDisabled();
});

test("comprador, sócio e cônjuge entram na lista e a revisão mostra os três", async ({ page }) => {
  await startCompanyOrder(page);
  await page.getByRole("button", { name: "Adicionar eu" }).click();
  await page.getByLabel("Nome da pessoa 1", { exact: true }).fill("e2e Comprador");
  await page.getByLabel("CPF da pessoa 1").fill(validCpf());
  await addPerson(page, 2, person("socio"));
  await addPerson(page, 3, person("conjuge"));
  await next(page);
  await expect(page.getByRole("heading", { name: "Pessoas (3)" })).toBeVisible();
  await expect(page.getByRole("definition")).toContainText(brl(Number(E2E.salePrice) + 3 * Number(E2E.salePricePerPartner)));
});
