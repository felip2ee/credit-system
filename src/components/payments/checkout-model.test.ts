import { describe, expect, it } from "vitest";

import type { PayerField } from "@/lib/payers/queries";

import { buildCheckoutInput, EMPTY_CARD, formatExpiry, PAYER_FIELDS, toE164, type BuildInput } from "./checkout-model";

const KEY = "11111111-1111-4111-8111-111111111111";
const values = Object.fromEntries(PAYER_FIELDS.map((f) => [f, ""])) as BuildInput["values"];
const nextYear = String((new Date().getFullYear() + 2) % 100).padStart(2, "0");
const validCard = { number: "4111 1111 1111 1111", holderName: "MARIA SILVA", expiry: `12/${nextYear}`, cvv: "123" };

const base: BuildInput = {
  amount: "100,00",
  method: "PIX",
  kind: "owner",
  installments: 1,
  missing: [],
  editing: new Set(),
  values,
  card: EMPTY_CARD,
  declaration: false,
  idempotencyKey: KEY,
};

describe("toE164 / formatExpiry", () => {
  it("converte celular brasileiro", () => {
    expect(toE164("(11) 91234-5678")).toBe("+5511912345678");
    expect(toE164("+55 11 91234-5678")).toBe("+5511912345678");
    expect(toE164("")).toBe("");
  });
  it("formata validade", () => {
    expect(formatExpiry("1230")).toBe("12/30");
    expect(formatExpiry("12")).toBe("12");
  });
});

describe("buildCheckoutInput", () => {
  it("dono completo com Pix não manda dados do pagador", () => {
    const r = buildCheckoutInput(base);
    expect(r).toMatchObject({ ok: true, input: { amount: "100.00", method: "PIX", payerKind: "owner" } });
    expect(r.ok && r.input.payer).toBeUndefined();
    expect(r.ok && r.input.declaration).toBeUndefined();
  });

  it("dono manda só o que falta e o que alterou; ignora e-mail", () => {
    const r = buildCheckoutInput({
      ...base,
      method: "CREDIT_CARD",
      missing: ["postalCode", "addressNumber"],
      editing: new Set<PayerField>(["phone", "email"]),
      values: { ...values, postalCode: "01310-100", addressNumber: "120", phone: "(11) 91234-5678", email: "x@y.com" },
      card: validCard,
      installments: 3,
    });
    expect(r.ok && r.input.payer).toEqual({ postalCode: "01310100", addressNumber: "120", phone: "+5511912345678" });
    expect(r.ok && r.input.installments).toBe(3);
    expect(r.ok && r.input.card).toMatchObject({ number: "4111111111111111", expiryMonth: "12" });
  });

  it("mostra erro por campo que falta", () => {
    const r = buildCheckoutInput({ ...base, missing: ["postalCode", "addressNumber"] });
    expect(r).toEqual({ ok: false, errors: { postalCode: "Informe o CEP.", addressNumber: "Informe o número." } });
  });

  it("outros exige os seis campos e a declaração", () => {
    const r = buildCheckoutInput({ ...base, kind: "other" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual([...PAYER_FIELDS, "declaration"].sort());
  });

  it("outros completo manda os seis campos e declaration", () => {
    const r = buildCheckoutInput({
      ...base,
      kind: "other",
      declaration: true,
      values: { name: "João Souza", document: "529.982.247-25", email: "j@x.com", phone: "11912345678", postalCode: "01310100", addressNumber: "S/N" },
    });
    expect(r.ok && Object.keys(r.input.payer ?? {}).sort()).toEqual([...PAYER_FIELDS].sort());
    expect(r.ok && r.input.declaration).toBe(true);
  });

  it("valida documento, cartão e validade sem repetir o valor digitado", () => {
    const r = buildCheckoutInput({
      ...base,
      method: "CREDIT_CARD",
      kind: "other",
      declaration: true,
      values: { name: "João", document: "111.111.111-11", email: "j@x.com", phone: "11912345678", postalCode: "01310100", addressNumber: "1" },
      card: { number: "4111 1111 1111 1112", holderName: "J", expiry: "13/30", cvv: "12" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.document).toBe("CPF ou CNPJ inválido.");
    expect(r.errors.expiry).toBeDefined();
    expect(r.errors.cvv).toBeDefined();
    expect(JSON.stringify(r.errors)).not.toMatch(/4111|111\.111/);
  });

  it("número de cartão com Luhn inválido e cartão vencido", () => {
    const bad = buildCheckoutInput({ ...base, method: "CREDIT_CARD", card: { ...validCard, number: "4111111111111112" } });
    expect(bad.ok === false && bad.errors.number).toBe("Número do cartão inválido.");
    const old = buildCheckoutInput({ ...base, method: "CREDIT_CARD", card: { ...validCard, expiry: "01/20" } });
    expect(old.ok === false && old.errors.expiry).toBe("Cartão vencido.");
  });

  it("Pix não leva cartão nem parcelas", () => {
    const r = buildCheckoutInput({ ...base, card: validCard, installments: 5 });
    expect(r.ok && r.input.card).toBeUndefined();
    expect(r.ok && r.input.installments).toBeUndefined();
  });

  it("valor inválido", () => {
    expect(buildCheckoutInput({ ...base, amount: "2" }).ok).toBe(false);
  });
});
