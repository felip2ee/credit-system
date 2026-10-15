import { describe, expect, it } from "vitest";

import { parseTopupInput } from "./topup-input";

describe("parseTopupInput", () => {
  it("converte vírgula decimal em ponto", () => {
    expect(parseTopupInput("10,00")).toEqual({ ok: true, amount: "10.00" });
  });

  it("aceita milhar pt-BR", () => {
    expect(parseTopupInput("1.234,50")).toEqual({ ok: true, amount: "1234.50" });
  });

  it("aceita os limites R$ 10,00 e R$ 5.000,00", () => {
    expect(parseTopupInput("10").ok).toBe(true);
    expect(parseTopupInput("5.000,00").ok).toBe(true);
  });

  it("rejeita abaixo do mínimo, acima do máximo, vazio e texto", () => {
    for (const v of ["9,99", "5.000,01", "", "abc", "10,999"]) {
      expect(parseTopupInput(v).ok).toBe(false);
    }
  });
});
