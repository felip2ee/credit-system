import { describe, expect, it } from "vitest";

import { acquireKey, checkoutFingerprint, settleKey } from "./checkout-key";

const base = { amount: "100,00", method: "PIX", installments: 1, kind: "owner" };
let n = 0;
const gen = () => `key-${++n}`;

describe("chave de idempotência do checkout", () => {
  it("gera uma chave no primeiro envio", () => {
    const { key } = acquireKey(null, checkoutFingerprint(base), gen);
    expect(key).toMatch(/^key-/);
  });

  it("reusa a chave no retry após falha desconhecida", () => {
    const fp = checkoutFingerprint(base);
    const first = acquireKey(null, fp, gen);
    const holder = settleKey(first.holder, "unknown");
    expect(acquireKey(holder, fp, gen).key).toBe(first.key);
  });

  it("descarta a chave após erro definitivo do servidor", () => {
    const fp = checkoutFingerprint(base);
    const first = acquireKey(null, fp, gen);
    const holder = settleKey(first.holder, "rejected");
    expect(holder).toBeNull();
    expect(acquireKey(holder, fp, gen).key).not.toBe(first.key);
  });

  it("descarta a chave após sucesso", () => {
    const first = acquireKey(null, checkoutFingerprint(base), gen);
    expect(settleKey(first.holder, "succeeded")).toBeNull();
  });

  it.each([
    ["valor", { amount: "200,00" }],
    ["forma de pagamento", { method: "CREDIT_CARD" }],
    ["parcelas", { installments: 3 }],
    ["tipo de pagador", { kind: "other" }],
  ])("gera chave nova quando muda %s", (_label, change) => {
    const first = acquireKey(null, checkoutFingerprint(base), gen);
    const holder = settleKey(first.holder, "unknown");
    const second = acquireKey(holder, checkoutFingerprint({ ...base, ...change }), gen);
    expect(second.key).not.toBe(first.key);
  });
});
