import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { OwnerPayerView, PayerField } from "@/lib/payers/queries";

import { PAYER_FIELDS, type CheckoutErrors, type PayerKind } from "./checkout-model";
import { PayerStep } from "./PayerStep";

const owner: OwnerPayerView = {
  name: "Maria Silva",
  emailMasked: "m***@x.com",
  phoneMasked: "+55 (11) *****-5678",
  documentMasked: "***.456.***-**",
  postalCodeMasked: "*****-100",
  hasAddressNumber: true,
  source: "payer_profile",
};

function render(over: Partial<Parameters<typeof PayerStep>[0]> = {}, kind: PayerKind = "owner", errors: CheckoutErrors = {}) {
  return renderToStaticMarkup(
    createElement(PayerStep, {
      owner,
      missing: [],
      kind,
      onKindChange: vi.fn(),
      values: Object.fromEntries(PAYER_FIELDS.map((f) => [f, ""])) as never,
      onValueChange: vi.fn(),
      editing: new Set<PayerField>(),
      onToggleEdit: vi.fn(),
      declaration: false,
      onDeclarationChange: vi.fn(),
      errors,
      disabled: false,
      ...over,
    }),
  );
}

// Radix também emite <input> ocultos (rádio, caixa): conta só os campos de texto do pagador.
const textFields = (html: string) =>
  Array.from(html.matchAll(/<input[^>]*\bid="payer-(\w+)"/g), (m) => m[1]).filter((id) => id !== "declaration");

describe("PayerStep", () => {
  it("pergunta o dono ou outros, com fieldset e legend", () => {
    const html = render();
    expect(html).toContain("<legend");
    expect(html).toContain("Os dados de pagamento são os do dono da conta ou outros?");
    expect(html).toContain("Do dono da conta");
    expect(html).toContain("De outra pessoa ou empresa");
  });

  it("dono completo: só máscaras e Alterar, nenhum campo", () => {
    const html = render();
    expect(html).toContain("***.456.***-**");
    expect(html).toContain("Alterar");
    expect(textFields(html)).toEqual([]);
    expect(html).not.toContain("Declaro");
  });

  it("dono sem CEP e número: só esses dois campos viram input", () => {
    const html = render({ missing: ["postalCode", "addressNumber"], owner: { ...owner, postalCodeMasked: null, hasAddressNumber: false } });
    expect(textFields(html).sort()).toEqual(["addressNumber", "postalCode"]);
    expect(html).toContain('id="payer-postalCode"');
    expect(html).toContain('id="payer-addressNumber"');
    expect(html).toMatch(/autocomplete="postal-code"/i);
  });

  it("Alterar abre o campo vazio e oferece voltar", () => {
    const html = render({ editing: new Set<PayerField>(["document"]) });
    expect(html).toContain('id="payer-document"');
    expect(html).not.toContain("***.456.***-**");
    expect(html).toContain("Manter");
  });

  it("outros: seis campos, declaração, sem máscara e sem autocomplete do navegador", () => {
    const html = render({}, "other");
    expect(textFields(html).sort()).toEqual([...PAYER_FIELDS].sort());
    expect(html).toContain("Declaro que tenho autorização");
    expect(html).not.toContain("***.456.***-**");
    expect(html).not.toMatch(/autocomplete="(name|email|tel|postal-code)"/i);
  });

  it("erro do campo liga ao input por aria-describedby; declaração mostra alerta", () => {
    const html = render({}, "other", { document: "CPF ou CNPJ inválido.", declaration: "Confirme." });
    expect(html).toContain('aria-describedby="payer-document-error"');
    expect(html).toContain('id="payer-document-error"');
    expect(html).toContain('id="payer-declaration-error"');
  });
});
